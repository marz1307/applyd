#!/usr/bin/env node
// Re-check Stage-3 rows against the collision filter, using LIVE Notion state.
//
// WHY THIS EXISTS.
// `_autodraft_crossstage_filter.mjs` runs exactly once per row, at the Stage
// 2 -> 3 selection step, against whatever the row's `Company` field said at
// that moment. Nothing ever looks at the row again. That is fine while the
// Company field is stable, and it is not stable: the scanners write an honest
// placeholder ("Undisclosed (Indeed)") whenever the portal hides the
// employer, and `auto-eval` resolves it afterwards from the JD's JSON-LD. If
// the resolution lands late — or gets written into the Fit-notes prose while
// the `Company` property itself is left alone — the row is filtered under a
// name that is not an employer, passes, and is drafted.
//
// So the gate cannot only be at the boundary. Stage 3 is the last point at
// which a row is still fixable — nothing has been sent — and it is the right
// place to re-ask the question now that the employer has a name.
//
// WHAT THIS ADDS OVER THE STAGE-2 FILTER.
//   1. It re-runs on rows that already passed, catching late employer
//      resolution.
//   2. It reads live Notion state, not a temp snapshot that could be hours
//      stale by the time drafting starts.
//   3. It counts a RECENT REJECTION as a collision. The Stage-2 filter
//      deliberately does not (`ACTIVE` excludes terminals) because a closed
//      loop from six months ago should not block a fresh application. That
//      is right in general and wrong at 48 hours: re-applying to an employer
//      days after they declined you reads as not having noticed.
//
// Rejections age out via --terminal-window-days (default 90), measured from
// the response date, else the apply date, else the discovery date. In-flight
// rows never age out. `Withdrew` is NOT counted — a withdrawal here means
// the posting died or the row was dropped BEFORE anything was sent.
//
// SAFETY. Stage 4+ rows are records of what was sent and are never touched,
// read only as collision partners. --apply only ever moves a Stage-3 row to
// `Not pursuing` and appends an audit line; it never deletes, never
// archives, and never submits anything.
//
// Usage:
//   node batch/recheck-collisions.mjs                 # report only (default)
//   node batch/recheck-collisions.mjs --json
//   node batch/recheck-collisions.mjs --apply         # act on hard collisions
//   node batch/recheck-collisions.mjs --self-test
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readArtefactFilenames, resolveForRows } from './artefact-date.mjs';
import {
  normCompany, normCity, sameCompany, isPlaceholderCompany, readableCity, isAgency,
} from './_autodraft_crossstage_filter.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTION_QUERY = join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');
const argv = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const TERMINAL_WINDOW_DAYS = parseInt(argv('--terminal-window-days', '90'), 10);

const IN_FLIGHT = /^(4\. Applied|5\.|6\.|7\.|8\.|9\.|Signed)/i;
// ONLY Rejected. `Withdrew` looks like a terminal outcome and is not one:
// every Withdrew row carries no `Apply date` and no `Response date`, because
// a withdrawal here means the posting died or the row was dropped BEFORE
// anything was sent. The employer never saw an application, so there is
// nothing for a second one to collide with — if anything a repost is a
// wanted second chance.
const TERMINAL = /^Rejected$/i;
const DRAFTED = /^3\. Drafted$/i;

// A row a human has already ruled on. Without this, a `review` finding is
// permanent: the same two rows surface in every drain forever, and a report
// that always says the same thing stops being read. Written by hand once the
// call is made; the row then behaves as if the collision were resolved,
// because it was.
const RULED = /\[collision-ruled/i;

// Days between two YYYY-MM-DD strings, or null when either side is unknown.
// An unknown date must NOT read as "long ago" — a terminal row with no date
// is treated as in-window, because guessing it is stale is the failure that
// lets a duplicate through, and guessing it is fresh only costs a line in a
// report.
export function ageInDays(dateStr, today) {
  if (!dateStr) return null;
  const a = Date.parse(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

// The whole decision, isolated from Notion so the self-test can drive it.
// `rows` is the shape notion-query.mjs --json emits.
export function findCollisions(rows, today, windowDays = 90) {
  const partners = [];
  for (const r of rows) {
    const stage = String(r.stage || '');
    const company = normCompany(r.title);
    if (!company || isPlaceholderCompany(r.title)) continue;
    const city = readableCity(r.location, r.title);
    if (IN_FLIGHT.test(stage)) {
      partners.push({ app: r.application_id, stage, company, city, kind: 'in-flight', age: null });
    } else if (TERMINAL.test(stage)) {
      // Age proxy chain, best signal first. `discovered_date` is the backstop
      // because most rejections carry no response date at all: without it
      // every rejection reads as "undated", and undated is treated as
      // in-window, so a rejection from months ago would block a fresh
      // application forever.
      //
      // `artefact_date` sits between them because the backstop is BAD: it is
      // the day we found the posting, a median ~22 days before the reply, so
      // it ages a rejection out early and silently stops it blocking. The
      // draft on disk is a much closer proxy. It is attached by the caller,
      // not read here, so this stays pure.
      const age = ageInDays(r.response_date || r.apply_date || r.artefact_date || r.discovered_date, today);
      if (age === null || age <= windowDays) {
        partners.push({ app: r.application_id, stage, company, city, kind: 'recent-terminal', age });
      }
    }
  }

  const findings = [];
  const drafted = rows.filter((r) => DRAFTED.test(String(r.stage || '')));
  for (const row of drafted) {
    if (RULED.test(String(row.fit_notes || ''))) continue;   // already adjudicated
    // An employer still unnamed at Stage 3 is undeduppable AND unaddressable:
    // the letter cannot say who it is written to. Surface it, never auto-act.
    if (isPlaceholderCompany(row.title)) {
      findings.push({
        app: row.application_id, score: row.match_score, company: row.title,
        city: readableCity(row.location, row.title), reason: 'unresolved-employer',
        severity: 'review', collides_with: null, partner_stage: null, partner_age: null,
      });
      continue;
    }
    const c = normCompany(row.title);
    const city = readableCity(row.location, row.title);
    const sameCo = partners.filter((p) => p.app !== row.application_id && sameCompany(p.company, c));
    if (!sameCo.length) continue;
    // Same employer AND same city, or a city unreadable on either side — the
    // unreadable case blocks because a country-level string cannot prove a
    // different office (kept identical to the Stage-2 rule).
    const hard = sameCo.find((p) => !city || !p.city || p.city === city);
    const partner = hard || sameCo[0];
    const agency = isAgency(row.title);
    findings.push({
      app: row.application_id, score: row.match_score, company: row.title, city,
      reason: agency ? 'agency-collision'
        : hard ? (partner.kind === 'in-flight' ? 'in-flight-collision' : 'recent-rejection-collision')
        : 'different-city-warn',
      severity: hard && !agency ? 'block' : 'review',
      collides_with: partner.app, partner_stage: partner.stage,
      partner_age: partner.age, partner_city: partner.city, partner_kind: partner.kind,
    });
  }
  findings.sort((a, b) => (b.score || 0) - (a.score || 0));
  return findings;
}

// ---------------------------------------------------------------- self-test
if (args.includes('--self-test')) {
  const T = '2026-08-23';
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  };
  const row = (app, title, stage, location, extra = {}) => ({
    application_id: app, title, stage, location, match_score: 90, ...extra,
  });

  // A collision with a 3-day-old rejection.
  const fc = [
    row('APP-1001', 'Acme Bank', '3. Drafted', 'London EC4V'),
    row('APP-1002', 'Acme Bank UK', 'Rejected', 'London, England, United Kingdom', { response_date: '2026-08-20' }),
  ];
  const f1 = findCollisions(fc, T);
  check('the Drafted row collides with a fresh rejection', f1.map((f) => [f.app, f.reason, f.severity, f.collides_with]),
    [['APP-1001', 'recent-rejection-collision', 'block', 'APP-1002']]);

  // The postcode is the reason the city had to match; prove it directly.
  check('normCity strips a UK outcode', normCity('London EC4V'), 'london');
  check('normCity keeps a full city name', normCity('Frankfurt am Main'), 'frankfurt');

  // A rejection old enough to be a different requisition must NOT block.
  const old = [
    row('APP-A', 'Zalando', '3. Drafted', 'Berlin, Germany'),
    row('APP-B', 'Zalando SE', 'Rejected', 'Berlin, Germany', { response_date: '2025-11-01' }),
  ];
  check('a stale rejection does not block', findCollisions(old, T).length, 0);

  // ...but an in-flight row blocks regardless of age.
  const live = [
    row('APP-C', 'SAP', '3. Drafted', 'Walldorf'),
    row('APP-D', 'SAP SE', '4. Applied', 'Walldorf', { apply_date: '2025-01-01' }),
  ];
  check('an in-flight row blocks at any age', findCollisions(live, T).map((f) => [f.reason, f.severity]),
    [['in-flight-collision', 'block']]);

  // A placeholder must be surfaced, never matched away.
  const ph = [
    row('APP-E', 'Undisclosed (Indeed)', '3. Drafted', 'London'),
    row('APP-F', 'Undisclosed (Indeed)', '4. Applied', 'London'),
  ];
  const f2 = findCollisions(ph, T);
  check('a placeholder is reviewed, not collided', f2.map((f) => [f.app, f.reason, f.severity]),
    [['APP-E', 'unresolved-employer', 'review']]);
  check('a placeholder is never a collision PARTNER', f2.every((f) => f.collides_with === null), true);

  // A different city is a warn, not a block — separate offices are real.
  const two = [
    row('APP-G', 'Sopra Steria', '3. Drafted', 'Berlin, Germany'),
    row('APP-H', 'Sopra Steria', '4. Applied', 'Munich, Germany'),
  ];
  check('a genuinely different city only warns', findCollisions(two, T).map((f) => [f.reason, f.severity]),
    [['different-city-warn', 'review']]);

  // Stage 4+ rows are partners only; they must never appear as findings.
  check('a Stage-4 row is never itself a finding', findCollisions(live, T).every((f) => f.app === 'APP-C'), true);

  // Withdrew means nothing was ever sent — it must not block a fresh application.
  const wd = [
    row('APP-I', 'Wayve', '3. Drafted', 'London'),
    row('APP-J', 'Wayve', 'Withdrew', 'London'),
  ];
  check('a Withdrew row is not a collision at all', findCollisions(wd, T).length, 0);

  // An undated REJECTION with no dates at all is kept, not assumed stale.
  const undated = [
    row('APP-K', 'Monzo', '3. Drafted', 'London'),
    row('APP-L', 'Monzo', 'Rejected', 'London'),
  ];
  check('an undated rejection still blocks', findCollisions(undated, T).map((f) => f.severity), ['block']);

  // ...but discovered_date ages it when no response date was ever recorded.
  const aged = [
    row('APP-M', 'Monzo', '3. Drafted', 'London'),
    row('APP-N', 'Monzo', 'Rejected', 'London', { discovered_date: '2025-09-01' }),
  ];
  check('discovered_date ages a rejection out of the window', findCollisions(aged, T).length, 0);

  // ...and the draft artefact overrides that backstop. Discovery is a median
  // ~22 days before the reply, so rejections can age out on discovery alone
  // and silently stop blocking. Same row, same discovery date, real draft date.
  const rescued = [
    row('APP-M2', 'Monzo', '3. Drafted', 'London'),
    row('APP-N2', 'Monzo', 'Rejected', 'London',
      { discovered_date: '2026-01-05', artefact_date: '2026-07-01' }),
  ];
  check('artefact_date outranks discovered_date and restores the block',
    findCollisions(rescued, T).map((f) => f.severity), ['block']);
  // Precedence must not invert: a real apply_date still wins over the artefact.
  const both = [
    row('APP-M3', 'Monzo', '3. Drafted', 'London'),
    row('APP-N3', 'Monzo', 'Rejected', 'London',
      { apply_date: '2026-01-05', artefact_date: '2026-07-01' }),
  ];
  check('apply_date still outranks artefact_date', findCollisions(both, T).length, 0);

  // A consultancy places for many clients; two of its vacancies are not two
  // applications to one employer. Downgrade, never block.
  const agency = [
    row('APP-O', 'Harnham', '3. Drafted', 'London'),
    row('APP-P', 'Harnham', '4. Applied', 'London'),
  ];
  check('an agency collision downgrades to review', findCollisions(agency, T).map((f) => [f.reason, f.severity]),
    [['agency-collision', 'review']]);

  // A ruled row must stop resurfacing, or the report becomes wallpaper.
  const ruled = [
    { application_id: 'APP-S', title: 'Acme', stage: '3. Drafted', location: 'London', match_score: 90,
      fit_notes: '[collision-ruled 2026-08-25] distinct vacancy, keep. ' },
    { application_id: 'APP-T', title: 'Acme', stage: '4. Applied', location: 'London', match_score: 90 },
  ];
  check('a ruled row is skipped', findCollisions(ruled, T).length, 0);
  // ...but an UNRULED row in the same situation must still be found.
  const unruled = [
    { application_id: 'APP-U', title: 'Acme', stage: '3. Drafted', location: 'London', match_score: 90, fit_notes: '' },
    { application_id: 'APP-V', title: 'Acme', stage: '4. Applied', location: 'London', match_score: 90 },
  ];
  check('an unruled row in the same case is still found',
    findCollisions(unruled, T).map((f) => f.app), ['APP-U']);

  console.log(`\nrecheck-collisions self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- live run
const today = new Date().toISOString().slice(0, 10);
let rows;
try {
  const out = execFileSync('node', [NOTION_QUERY, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  rows = JSON.parse(out);
} catch (e) {
  console.error(`RECHECK_ABORT: could not read live Notion state: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}

// Attach the draft-artefact date so the age proxy above never has to fall
// back to `discovered_date`. Resolved HERE, not inside the decision, so the
// decision function stays pure and its self-test needs no filesystem.
const artefactDates = resolveForRows(rows, readArtefactFilenames(REPO_ROOT), today);
for (const r of rows) {
  const a = artefactDates.get(r.application_id);
  if (a) r.artefact_date = a;
}

const findings = findCollisions(rows, today, TERMINAL_WINDOW_DAYS);
const blocks = findings.filter((f) => f.severity === 'block');
const reviews = findings.filter((f) => f.severity === 'review');

if (JSON_OUT) {
  console.log(JSON.stringify({ checked: rows.filter((r) => DRAFTED.test(String(r.stage || ''))).length, blocks, reviews }, null, 2));
} else {
  const checked = rows.filter((r) => DRAFTED.test(String(r.stage || ''))).length;
  console.log(`re-checked ${checked} Stage-3 rows against live Notion state`);
  console.log(`  ${blocks.length} hard collision(s), ${reviews.length} for review\n`);
  for (const f of blocks) {
    const age = f.partner_age === null ? 'undated' : `${f.partner_age}d ago`;
    console.log(`  BLOCK  ${f.app} (${f.score}) ${f.company} / ${f.city || '?'}  <=  ${f.collides_with} ${f.partner_stage} (${age})`);
  }
  for (const f of reviews) {
    console.log(f.reason === 'unresolved-employer'
      ? `  REVIEW ${f.app} (${f.score}) employer still unresolved: "${f.company}"`
      : `  REVIEW ${f.app} (${f.score}) [${f.reason}] ${f.company} / ${f.city || '?'}  <=  ${f.collides_with} ${f.partner_stage} in "${f.partner_city || '?'}"`);
  }
}

if (!APPLY) {
  if (!JSON_OUT) console.log(`\nDRY RUN. --apply would move ${blocks.length} row(s) to "Not pursuing".`);
  process.exit(0);
}

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('RECHECK_ABORT: NOTION_TOKEN not set'); process.exit(5); }
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};
const byApp = new Map(rows.map((r) => [r.application_id, r]));

let ok = 0, failed = 0;
for (const f of blocks) {
  const r = byApp.get(f.app);
  if (!r) { failed++; continue; }
  const age = f.partner_age === null ? 'date unknown' : `${f.partner_age} days ago`;
  const line = `[collision-recheck ${today}] Held: ${f.reason} with ${f.collides_with} (${f.partner_stage}, ${age}) at the same employer and city. Re-checked after the employer name was resolved; the Stage-2 filter saw a different name. `;
  const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties: {
      Stage: { select: { name: 'Not pursuing' } },
      'Fit notes': { rich_text: [{ text: { content: (line + (r.fit_notes || '')).slice(0, 1900).trim() } }] },
      'Agent run ID': { rich_text: [{ text: { content: `collision-recheck-${today}` } }] },
    } }),
  });
  if (res.ok) { ok++; console.log(`  HELD ${f.app} -> Not pursuing`); }
  else { failed++; console.log(`  FAIL ${f.app} ${res.status} ${(await res.text()).slice(0, 160)}`); }
}
console.log(`\nAPPLIED: ${ok} held, ${failed} failed. Rows for review were NOT touched.`);
