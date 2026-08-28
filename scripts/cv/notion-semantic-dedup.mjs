#!/usr/bin/env node
/**
 * notion-semantic-dedup.mjs — cross-stage semantic dedup for the Notion
 * Applications DB.
 *
 * Catches TWO failure modes URL-string dedup misses.
 *
 *   (1) Same COMPANY + ROLE at same LOCATION, different URLs, appearing on
 *       different days (Xing today, LinkedIn tomorrow, careers-page next week).
 *   (2) Literally the SAME advert reached by two URLs and filed under two
 *       different role labels. One eFC advert id24578904 filed once as
 *       "Analytics Engineer" and once as "Data Engineer" splits under key (1)
 *       because the roles differ, and splits under URL-string dedup because
 *       the slugs differ. Locale pairs are the same class: /en_US/…/518024 and
 *       /de_DE/…/518024 are one job.
 *
 * Either way — and this is the whole point — it catches a fresh Stage 1/2/3
 * row that duplicates a row already in Applied / Rejected further down the
 * pipeline. Re-applying to a job already applied to (or already rejected
 * from) wastes time and reads badly to recruiters.
 *
 * Algorithm:
 *   1. Fetch rows across ALL stages via notion-query.mjs (one query per stage).
 *   2. Compute BOTH companyRoleFingerprint and advertIdFingerprint per row,
 *      via metrics-core — neither key subsumes the other.
 *   3. Union-find over both keys so a row reachable by both lands in exactly
 *      ONE cluster; keep clusters of >=2.
 *   4. Classify each cluster:
 *        - "committed-vs-pending" : cluster contains BOTH a committed row
 *          (Stage 4+ / Rejected / Signed) AND an earlier-stage row (Stage
 *          1-3). The earlier-stage rows are the duplicates — archive them.
 *        - "pre-apply-only"       : all rows are Stage 1-3. Keep the
 *          highest-Match-score row; archive the others.
 *        - "committed-only"       : all rows are Stage 4+ (historical
 *          duplicates from before this script existed). Report only —
 *          don't touch.
 *
 * Usage:
 *   node scripts/cv/notion-semantic-dedup.mjs             # report clusters
 *   node scripts/cv/notion-semantic-dedup.mjs --json      # JSON to stdout
 *   node scripts/cv/notion-semantic-dedup.mjs --auto-archive   # apply the archive plan
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  companyRoleFingerprint,
  advertIdFingerprint,
} from '../metrics/metrics-core.mjs';
import { fetchWithRetry } from '../net-retry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const NOTION_QUERY_MJS = join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const argv = process.argv.slice(2);
const JSON_MODE   = argv.includes('--json');
const AUTO_ARCHIVE = argv.includes('--auto-archive');
const HELP        = argv.includes('--help') || argv.includes('-h');

if (HELP) {
  console.log(`Usage:
  node scripts/cv/notion-semantic-dedup.mjs             # report clusters (safe, read-only)
  node scripts/cv/notion-semantic-dedup.mjs --json      # JSON output
  node scripts/cv/notion-semantic-dedup.mjs --auto-archive  # apply the archive plan (writes to Notion)

Requires NOTION_TOKEN in env.`);
  process.exit(0);
}

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN && !argv.includes('--self-test')) { console.error('NOTION_TOKEN missing'); process.exit(1); }

// Stages to sweep. Skip 'Not pursuing' because that's where the archiver
// SENDS duplicates — including it would immediately generate re-alerts on
// already-archived rows on the next pass. Also skip 'Withdrew': Withdrew
// means "meant to apply but missed the deadline", not "committed and done".
// If the same posting reappears in Stage 1-3 (a repost), that's a second
// chance to apply — the fresh row should NOT be treated as a duplicate of
// the abandoned Withdrew row.
const SWEEP_STAGES = [
  '1. Discovered', '2. Triaged', '3. Drafted',
  '4. Applied', '5. Assessment/OA', '6. Phone screen',
  '7. Tech interview', '8. Onsite/Final', '9. Offer', 'Signed',
  'Rejected',
];
// Committed = beyond the human apply decision. A cluster containing any of
// these means the candidate already committed to that opportunity; any
// earlier-stage row in the same cluster is a duplicate that shouldn't be
// re-worked. Withdrew deliberately excluded (see SWEEP_STAGES comment).
const COMMITTED_STAGES = new Set(['4. Applied', '5. Assessment/OA',
  '6. Phone screen', '7. Tech interview', '8. Onsite/Final', '9. Offer',
  'Signed', 'Rejected']);
const PRE_APPLY_STAGES = new Set(['1. Discovered', '2. Triaged', '3. Drafted']);

function queryStage(stage) {
  const res = spawnSync(process.execPath, [NOTION_QUERY_MJS, '--stage', stage, '--json'],
    { encoding: 'utf8', timeout: 120 * 1000, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`notion-query failed for stage '${stage}' (exit ${res.status})`);
  try { return JSON.parse(res.stdout); }
  catch (e) { throw new Error(`notion-query JSON parse failed for stage '${stage}': ${e.message.slice(0, 100)}`); }
}

function extractCompanyFromTitle(title) {
  return String(title || '').split(/[-–—:|]/)[0].trim();
}

// Extract the CV's inferred role_title. notion-query returns:
//   - `position` (multi_select) — set at auto-eval time from the JD title match
//   - the title field itself often carries "Company - Role" — falls back on
//     splitting the title if position isn't populated
function extractRoleFromRow(row) {
  if (Array.isArray(row.position) && row.position.length) return row.position[0];
  const parts = String(row.title || '').split(/[-–—:|]/).map(s => s.trim());
  if (parts.length >= 2) return parts.slice(1).join(' - ');
  return '';
}

function loadAllRows() {
  const all = [];
  for (const stage of SWEEP_STAGES) {
    const rows = queryStage(stage);
    for (const r of rows) all.push({ ...r, _stage: stage });
  }
  return all;
}

/**
 * Cluster on TWO independent keys and merge the results.
 *
 *   companyRoleFingerprint  same company + role + city, different URLs.
 *   advertIdFingerprint     literally the same advert, reached by two URLs.
 *
 * Neither subsumes the other. The semantic key misses one advert filed under
 * two role labels. The advert-id key misses a genuine repost on a different
 * portal, which carries a different id.
 *
 * The merge is union-find rather than two passes, so a row reachable by both
 * keys lands in exactly ONE cluster. Two passes would let the same row be
 * planned for archive twice, and the second write would clobber the first
 * note's keeper reference.
 */
function buildClusters(rows) {
  const nodes = [];
  for (const r of rows) {
    const company = extractCompanyFromTitle(r.title);
    const role = extractRoleFromRow(r);
    const location = r.location || '';
    const semantic = companyRoleFingerprint({ company, role_title: role, location });
    const advert = advertIdFingerprint(r.job_url);
    const hasSemantic = semantic && semantic !== '||';
    if (!hasSemantic && !advert) continue;
    nodes.push({
      keys: [hasSemantic ? `sem:${semantic}` : null, advert ? `adv:${advert}` : null].filter(Boolean),
      app_id: r.application_id,
      page_id: r.id,
      title: r.title,
      company,
      role,
      location,
      stage: r._stage,
      match_score: r.match_score,
      job_url: r.job_url,
      fit_notes: r.fit_notes || '',
    });
  }

  const parent = nodes.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };

  // Advert ids per component. Two DIFFERENT ids on the same portal are hard
  // evidence of two different jobs, and that outranks any heuristic.
  const ids = nodes.map((n) => {
    const a = n.keys.find((k) => k.startsWith('adv:'));
    return a ? new Set([a]) : new Set();
  });

  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return true;
    parent[rb] = ra;
    ids[rb].forEach((v) => ids[ra].add(v));
    return true;
  };

  // Pass 1 — hard identity. Same advert id is the same job, full stop.
  const seenAdvert = new Map();
  nodes.forEach((n, i) => {
    for (const k of n.keys.filter((x) => x.startsWith('adv:'))) {
      if (seenAdvert.has(k)) union(seenAdvert.get(k), i);
      else seenAdvert.set(k, i);
    }
  });

  // Pass 2 — the company/role heuristic, but VETOED where pass 1 already
  // proved the two sides are different adverts.
  //
  // Without the veto: an anonymous "Undisclosed (portal)" advert with generic
  // role and city is the fingerprint of every anonymous advert on that portal,
  // so distinct jobs merge and one gets archived. Conflicting advert ids in
  // one candidate cluster prove the two sides are different jobs.
  let vetoed = 0;
  const seenSemantic = new Map();
  nodes.forEach((n, i) => {
    for (const k of n.keys.filter((x) => x.startsWith('sem:'))) {
      if (!seenSemantic.has(k)) { seenSemantic.set(k, i); continue; }
      const ra = find(seenSemantic.get(k)), rb = find(i);
      if (ra === rb) continue;
      const merged = new Set([...ids[ra], ...ids[rb]]);
      if (merged.size > 1) { vetoed++; continue; }   // conflicting advert ids
      union(ra, rb);
    }
  });
  if (vetoed) console.error(`  ${vetoed} company/role merge(s) vetoed by conflicting advert ids`);

  const grouped = new Map();
  nodes.forEach((n, i) => {
    const root = find(i);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(n);
  });

  const clusters = [];
  for (const members of grouped.values()) {
    if (members.length < 2) continue;
    const counts = new Map();
    members.forEach((m) => m.keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1)));
    const shared = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    const advertKeys = shared.filter((k) => k.startsWith('adv:'));
    clusters.push({
      fp: shared.join(' + ') || '(merged)',
      matched_by: advertKeys.length ? (shared.length > advertKeys.length ? 'advert-id + company/role' : 'advert-id')
                                    : 'company/role/location',
      members: members.map((m) => ({ ...m, fp: shared.join(' + ') })),
    });
  }
  return clusters;
}

function classifyCluster(cluster) {
  const hasCommitted = cluster.members.some(m => COMMITTED_STAGES.has(m.stage));
  const hasPreApply  = cluster.members.some(m => PRE_APPLY_STAGES.has(m.stage));
  if (hasCommitted && hasPreApply) return 'committed-vs-pending';
  if (hasPreApply) return 'pre-apply-only';
  return 'committed-only';  // historical only, don't touch
}

function planArchive(cluster) {
  const cls = classifyCluster(cluster);
  const members = cluster.members;
  if (cls === 'committed-only') return { class: cls, keep: members, archive: [], keeper_reason: 'all already committed; no-op' };
  if (cls === 'committed-vs-pending') {
    const committed = members.filter(m => COMMITTED_STAGES.has(m.stage));
    const preApply  = members.filter(m => PRE_APPLY_STAGES.has(m.stage));
    const order = ['Signed','9. Offer','8. Onsite/Final','7. Tech interview',
                   '6. Phone screen','5. Assessment/OA','4. Applied','Rejected'];
    committed.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
    return {
      class: cls,
      keep: committed,
      archive: preApply,
      keeper_reason: `committed row ${committed[0].app_id} (${committed[0].stage}) wins; pre-apply dupes archived`,
    };
  }
  // pre-apply-only: keep highest Match score. Ties broken by lowest app_id number.
  const sorted = [...members].sort((a, b) => {
    const s = (b.match_score ?? -1) - (a.match_score ?? -1);
    if (s !== 0) return s;
    const na = parseInt(String(a.app_id).replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt(String(b.app_id).replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });
  return {
    class: cls,
    keep: [sorted[0]],
    archive: sorted.slice(1),
    keeper_reason: `highest Match score ${sorted[0].match_score} wins`,
  };
}

async function archiveOne(row, keeper, today, matchedBy = 'company/role/location') {
  const headers = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const note = `[semantic-dup ${today}] duplicate of ${keeper.app_id} (${keeper.stage}). Matched by: ${matchedBy}.`;
  const combined = (note + ' ' + (row.fit_notes || '')).slice(0, 1900).trim();
  const body = {
    properties: {
      'Stage': { select: { name: 'Not pursuing' } },
      'Fit notes': { rich_text: [{ text: { content: combined } }] },
      'Agent run ID': { rich_text: [{ text: { content: `semantic-dedup-${today}` } }] },
    },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
    const res = await fetchWithRetry(`https://api.notion.com/v1/pages/${row.page_id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
    if (res.ok) return { ok: true };
    const txt = await res.text();
    if (res.status === 429 || res.status >= 500) continue;
    return { ok: false, status: res.status, body: txt.slice(0, 200) };
  }
  return { ok: false, status: 'retries_exhausted' };
}

function formatCluster(cluster, plan) {
  const lines = [];
  lines.push(`  [${plan.class}] via ${cluster.matched_by}  ${cluster.fp}`);
  for (const m of cluster.members) {
    const flag = plan.archive.some(a => a.app_id === m.app_id) ? '  → archive' : '  keep    ';
    lines.push(`    ${flag}  ${m.app_id.padEnd(10)}  ${m.stage.padEnd(20)}  score=${m.match_score ?? '?'}   ${m.title.slice(0, 40)}`);
  }
  lines.push(`    → ${plan.keeper_reason}`);
  return lines.join('\n');
}

async function main() {
  console.error(`Sweeping ${SWEEP_STAGES.length} Notion stages…`);
  const rows = loadAllRows();
  console.error(`  loaded ${rows.length} rows across all stages`);
  const clusters = buildClusters(rows);
  console.error(`  clusters (>=2 rows, same fingerprint): ${clusters.length}\n`);

  const CLASS_ORDER = { 'committed-vs-pending': 0, 'pre-apply-only': 1, 'committed-only': 2 };
  const planned = clusters.map(c => ({ cluster: c, plan: planArchive(c) }));
  planned.sort((a, b) => CLASS_ORDER[a.plan.class] - CLASS_ORDER[b.plan.class] || b.cluster.members.length - a.cluster.members.length);

  const summary = { total_clusters: clusters.length, by_class: {}, would_archive_count: 0 };
  for (const { plan } of planned) {
    summary.by_class[plan.class] = (summary.by_class[plan.class] || 0) + 1;
    summary.would_archive_count += plan.archive.length;
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({ summary, clusters: planned }, null, 2));
  } else {
    console.log(`\n=== SEMANTIC DUPLICATE CLUSTERS (${clusters.length}) ===\n`);
    for (const { cluster, plan } of planned) console.log(formatCluster(cluster, plan) + '\n');
    console.log(`\n=== SUMMARY ===`);
    console.log(`  total clusters:  ${summary.total_clusters}`);
    for (const [k, v] of Object.entries(summary.by_class)) console.log(`    ${k.padEnd(22)} ${v}`);
    console.log(`  rows the archive plan would touch: ${summary.would_archive_count}`);
    console.log(AUTO_ARCHIVE ? `\n(--auto-archive is ON — applying now)` : `\n(re-run with --auto-archive to apply)`);
  }

  if (AUTO_ARCHIVE) {
    const today = new Date().toISOString().slice(0, 10);
    let ok = 0, fail = 0;
    for (const { cluster, plan } of planned) {
      if (plan.archive.length === 0) continue;
      const keeper = plan.keep[0];
      for (const row of plan.archive) {
        const r = await archiveOne(row, keeper, today, cluster.matched_by);
        if (r.ok) { ok++; console.error(`  OK   archived ${row.app_id} → dup of ${keeper.app_id}`); }
        else { fail++; console.error(`  FAIL ${row.app_id}  ${r.status}  ${r.body || ''}`); }
      }
    }
    const logDir = join(REPO_ROOT, 'data', 'routine-logs');
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const outPath = join(logDir, `semantic-dedup-${today}.json`);
    writeFileSync(outPath, JSON.stringify({ ts: new Date().toISOString(), summary, applied: { ok, fail }, plan: planned.map(p => ({ fp: p.cluster.fp, class: p.plan.class, keep: p.plan.keep.map(k=>k.app_id), archive: p.plan.archive.map(a=>a.app_id) })) }, null, 2));
    console.error(`\n=== APPLIED: ${ok} archived, ${fail} failed. Report: ${outPath} ===`);
  }
}

/* ─── self-test ────────────────────────────────────────────────────────────
 * buildClusters decides which rows get archived, so its edge cases are worth
 * pinning without a Notion round-trip.
 * Run: node scripts/cv/notion-semantic-dedup.mjs --self-test
 */
function selfTest() {
  let pass = 0, fail = 0;
  const ok = (c, l) => c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  FAIL ${l}`));
  const row = (app_id, title, position, location, job_url, _stage = '1. Discovered') =>
    ({ application_id: app_id, id: `p-${app_id}`, title, position: [position], location, job_url, _stage });

  // One advert under two role labels: the id key must catch it even though the
  // company/role key splits the row.
  const oneAd = buildClusters([
    row('APP-A', 'Acme', 'Analytics Engineer', 'Berlin', 'https://www.efinancialcareers.de/jobs-DE-Berlin-Data_Platform_Engineer.id24578904'),
    row('APP-B', 'Acme', 'Data Engineer',      'Berlin', 'https://www.efinancialcareers.de/jobs-DE-Berlin-Data_Engineer.id24578904'),
  ]);
  ok(oneAd.length === 1 && oneAd[0].members.length === 2, 'one advert under two role labels forms a cluster');
  ok(oneAd[0]?.matched_by?.startsWith('advert-id'), 'the cluster is reported as advert-id matched');

  // Veto: same generic fingerprint, provably different advert ids.
  const anon = buildClusters([
    row('APP-C', 'Undisclosed (portal)', 'Data Analyst', 'London', 'https://www.efinancialcareers.co.uk/jobs-UK-London-Data_Analyst.id24666855'),
    row('APP-D', 'Undisclosed (portal)', 'Data Analyst', 'London', 'https://www.efinancialcareers.co.uk/jobs-UK-London-Data_Analyst.id24666863'),
  ]);
  ok(anon.length === 0, 'different advert ids veto a company/role merge, however identical the labels');

  // Legacy heuristic still applies with no ids anywhere.
  const legacy = buildClusters([
    row('APP-E', 'Beta GmbH', 'Data Engineer', 'Berlin', 'https://careers.beta.example/jobs/data-engineer'),
    row('APP-F', 'Beta GmbH', 'Data Engineer', 'Berlin', 'https://www.arbeitnow.example/beta/data-engineer'),
  ]);
  ok(legacy.length === 1 && legacy[0].matched_by === 'company/role/location',
     'same company/role/location with no advert ids still clusters');

  // One id present, one absent, is NOT a conflict — absence is not evidence.
  const partial = buildClusters([
    row('APP-G', 'Beta GmbH', 'Data Engineer', 'Berlin', 'https://careers.beta.example/jobs/data-engineer'),
    row('APP-H', 'Beta GmbH', 'Data Engineer', 'Berlin', 'https://www.xing.com/jobs/berlin-data-engineer-157211229'),
  ]);
  ok(partial.length === 1, 'a missing advert id does not veto — absence is not evidence of difference');

  // Reachable by BOTH keys: the row must land in exactly one cluster.
  const both = buildClusters([
    row('APP-I', 'Gamma', 'Data Scientist', 'Berlin', 'https://jobs.gamma.example/en/jobs/2724292-Applied-Scientist'),
    row('APP-J', 'Gamma', 'Data Scientist', 'Berlin', 'https://jobs.gamma.example/de/jobs/2724292-Applied-Scientist'),
  ]);
  const appearances = both.flatMap((c) => c.members.map((m) => m.app_id));
  ok(both.length === 1 && new Set(appearances).size === appearances.length,
     'a row matched by both keys appears in exactly one cluster');

  console.log(`\nSELF_TEST_${fail ? 'FAIL' : 'PASS'}: ${pass}/${pass + fail}`);
  return fail;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (argv.includes('--self-test')) process.exit(selfTest() ? 1 : 0);
  main().catch(e => { console.error(`FATAL: ${e.message}`); process.exit(1); });
}
