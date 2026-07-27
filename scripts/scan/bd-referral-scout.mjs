#!/usr/bin/env node
/**
 * bd-referral-scout.mjs — Layer 3: Bright Data cold public-profile discovery.
 *
 * Discovers PUBLIC linkedin.com/in profile URLs for target companies via the
 * Bright Data SERP zone, classifies them (affiliation / hiring-manager /
 * recruiter), and writes LEADS to the Referral & Outreach DB with
 * `Outreach status = Not contacted`. It NEVER messages, NEVER logs into
 * LinkedIn, NEVER touches the connection graph. Human-in-the-loop outreach is
 * drafted by contacto.md and sent by the candidate.
 *
 * Auth: NOTION_TOKEN + BRIGHTDATA_API_KEY (env). Config: profile.yml → referral_scout.
 * Output: `--- ROUTINE_CONTRACT ---` block (pure script; no claude -p).
 *
 * Flags:
 *   --dry                  discover + classify only; write NOTHING to Notion
 *   --limit N              cap companies this run (overrides config cap downward)
 *   --test-company "Name"  bypass Notion selection; scout one named company (for live SERP test)
 */
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (n) => args.includes(n);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = has('--dry');
const LIMIT = arg('--limit') ? Number(arg('--limit')) : null;
const TEST_COMPANY = arg('--test-company');

const NOTION = process.env.NOTION_TOKEN;
const BD_KEY = process.env.BRIGHTDATA_API_KEY;
const NV = '2022-06-28';

const cfg = (() => { try { return yaml.load(readFileSync('config/profile.yml', 'utf8')) || {}; } catch { return {}; } })();
const RS = cfg.referral_scout || {};
const APPS_DS = cfg.notion?.applications_data_source_id;
const APPS_DB = cfg.notion?.applications_database_id;
const REF_DS = cfg.notion?.referral_data_source_id;
const REF_DB = cfg.notion?.referral_database_id;
if (!APPS_DB || !REF_DB) {
  console.error("ROUTINE_ABORT: notion.applications_database_id and notion.referral_database_id must be set in config/profile.yml");
  process.exit(5);
}

const REF_COUNTRIES = new Set(['Germany', 'Austria', 'Switzerland', 'UK', 'Netherlands', 'EU (other)', 'Remote', 'Other']);
const errors = [];

function contract(o) {
  console.log('\n--- ROUTINE_CONTRACT ---');
  console.log('ROUTINE: bd-referral-scout');
  console.log(`TIMESTAMP_UTC: ${o.ts}`);
  console.log(`COMPANIES_SCOUTED: ${o.companies}`);
  console.log(`SERP_QUERIES: ${o.serp}`);
  console.log(`PROFILES_DISCOVERED: ${o.discovered}`);
  console.log(`PROFILES_ENRICHED: ${o.enriched}`);
  console.log(`LEADS_WRITTEN: ${o.leads}`);
  console.log(`EST_COST_USD: ${o.cost.toFixed(4)}`);
  console.log(`CAP_HIT: ${o.capHit}`);
  console.log(`ERRORS: ${errors.length}`);
  if (errors.length) { console.log('ERROR_DETAILS: |'); for (const e of errors.slice(0, 10)) console.log(`  ${e}`); }
  console.log('--- END_ROUTINE_CONTRACT ---');
}
const nowIso = () => { try { return new Date().toISOString(); } catch { return '(date-unavailable)'; } };

// ── No-op gates ──────────────────────────────────────────────────────────────
if (!RS.enabled || RS.source !== 'brightdata') {
  console.error(`bd-referral-scout: disabled (enabled=${RS.enabled} source=${RS.source}) — no-op.`);
  contract({ ts: nowIso(), companies: 0, serp: 0, discovered: 0, enriched: 0, leads: 0, cost: 0, capHit: false });
  process.exit(0);
}
if (!NOTION) { console.error('ROUTINE_ABORT: NOTION_TOKEN not set'); process.exit(5); }
if (!BD_KEY) { console.error('ROUTINE_ABORT: BRIGHTDATA_API_KEY not set — set with setx BRIGHTDATA_API_KEY "<key>"'); process.exit(5); }

const SERP_ZONE = RS.brightdata_serp_zone || 'serp';
const COST_SERP = Number(RS.cost_per_serp_usd ?? 0.0015);
const COST_ENRICH = Number(RS.cost_per_enrich_usd ?? 0.0010);
const MAX_COST = Number(RS.max_cost_usd_per_run ?? 5);
const MAX_COMPANIES = LIMIT ?? Number(RS.max_companies_per_run ?? 15);
const MAX_SERP = Number(RS.max_serp_queries_per_company ?? 3);
const MAX_ENRICH = Number(RS.max_profiles_enriched_per_run ?? 60);
const AFFIL = RS.affiliation_keywords || [];
const TITLES = RS.target_titles || ['Data Engineer', 'Analytics Engineer', 'Data Scientist'];
const MANAGERS = RS.manager_titles || [];
const RECRUITERS = RS.recruiter_titles || [];

const nh = { Authorization: 'Bearer ' + NOTION, 'Notion-Version': NV, 'Content-Type': 'application/json' };
let cost = 0, capHit = false;
const wouldExceed = (add) => cost + add > MAX_COST;

// ── Bright Data SERP (public Google results → linkedin.com/in URLs) ──────────
async function bdSerp(query) {
  if (wouldExceed(COST_SERP)) { capHit = true; return []; }
  const gurl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=en`;
  const r = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: SERP_ZONE, url: gurl, format: 'raw' }),
  });
  cost += COST_SERP;
  if (!r.ok) { errors.push(`serp_${r.status}: ${query.slice(0, 60)}`); return []; }
  const html = await r.text();
  const set = new Set();
  for (const m of html.matchAll(/https?:\/\/[a-z]{2,3}\.linkedin\.com\/in\/[A-Za-z0-9\-_%]+/g)) {
    const clean = m[0].split('?')[0].split('#')[0].replace(/%23.*$/i, '').replace(/\/$/, '');
    if (/\/in\/[A-Za-z0-9\-_%]{2,}$/.test(clean)) set.add(clean);  // require a real slug; drop fragments
  }
  return [...set];
}

function nameFromUrl(url) {
  const slug = (url.split('/in/')[1] || '').split(/[/?#]/)[0];
  const base = decodeURIComponent(slug).replace(/-[0-9a-f]{6,}$/i, '').replace(/-\d+$/, '');
  return base.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || slug || '(unknown)';
}

// Optional public enrichment — best-effort page title. Degrades to slug name.
async function enrich(url) {
  if (wouldExceed(COST_ENRICH)) { capHit = true; return null; }
  try {
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: SERP_ZONE, url, format: 'raw' }),
    });
    cost += COST_ENRICH;
    if (!r.ok) return null;
    const html = await r.text();
    const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || '').replace(/\s*\|\s*LinkedIn.*/i, '').trim();
    if (!title) return null;
    const [name, ...rest] = title.split(/\s[-–]\s/);
    return { name: name?.trim() || null, headline: rest.join(' - ').trim() || null };
  } catch { return null; }
}

// ── Company selection (Stage-3 rows Layer 1 flagged with no warm path) ───────
function selectCompanies() {
  if (TEST_COMPANY) return [{ company: TEST_COMPANY, appPageId: null, country: null }];
  let rows;
  try {
    const out = execSync('node scripts/notion/notion-query.mjs --stage "3. Drafted" --json', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    rows = JSON.parse(out);
  } catch (e) { errors.push('notion_query_failed: ' + e.message.slice(0, 80)); return []; }
  const noWarm = /no warm path|no-warm|sponsor[- ]?unknown|cold[- ]?only|no affiliation/i;
  const seen = new Set();
  const picks = [];
  for (const r of rows) {
    const fn = String(r.fit_notes || '');
    if (!fn.includes('[referral-scout')) continue;       // Layer 1 must have run
    if (!noWarm.test(fn)) continue;                       // only the no-warm-path ones
    const co = (r.company || '').trim();
    if (!co || seen.has(co.toLowerCase())) continue;
    seen.add(co.toLowerCase());
    picks.push({ company: co, appPageId: r.id || r.page_id, country: r.country });
    if (picks.length >= MAX_COMPANIES) break;
  }
  return picks;
}

async function existingLeadUrls() {
  const set = new Set();
  let cursor;
  try {
    do {
      const r = await (await fetch(`https://api.notion.com/v1/databases/${REF_DB}/query`, {
        method: 'POST', headers: nh, body: JSON.stringify({ page_size: 100, start_cursor: cursor }),
      })).json();
      for (const p of r.results || []) { const u = p.properties['LinkedIn URL']?.url; if (u) set.add(u.replace(/\/$/, '')); }
      cursor = r.next_cursor;
    } while (cursor);
  } catch (e) { errors.push('referral_preload_failed: ' + e.message.slice(0, 60)); }
  return set;
}

async function writeLead(lead) {
  const country = REF_COUNTRIES.has(lead.country) ? lead.country : 'Other';
  const props = {
    Name: { title: [{ text: { content: (lead.name || '(unknown)').slice(0, 200) } }] },
    Company: { rich_text: [{ text: { content: lead.company.slice(0, 200) } }] },
    Role: { rich_text: [{ text: { content: `[BrightData-SERP · ${lead.klass}${lead.affil ? ' · ' + lead.affil : ''}] ${lead.headline || ''}`.slice(0, 1900) } }] },
    'LinkedIn URL': { url: lead.url },
    Country: { select: { name: country } },
    'Outreach status': { select: { name: 'Not contacted' } },
    Date: { date: { start: '2026-06-30' } },
  };
  if (lead.appPageId) props['Linked application'] = { relation: [{ id: lead.appPageId }] };
  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST', headers: nh, body: JSON.stringify({ parent: { type: 'data_source_id', data_source_id: REF_DS }, properties: props }),
  });
  if (!r.ok) { errors.push(`lead_write_${r.status}: ${lead.url}`); return false; }
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const companies = selectCompanies();
  let serp = 0, discovered = 0, enriched = 0, leads = 0;
  const seenLeads = DRY ? new Set() : await existingLeadUrls();

  for (const c of companies) {
    if (capHit) break;
    const templates = [
      { klass: 'affiliation', q: `site:linkedin.com/in ("${c.company}") (${TITLES.map((t) => `"${t}"`).join(' OR ')}) (${AFFIL.map((a) => `"${a}"`).join(' OR ')})` },
      { klass: 'hiring-manager', q: `site:linkedin.com/in "${c.company}" (${MANAGERS.map((t) => `"${t}"`).join(' OR ')})` },
      { klass: 'recruiter', q: `site:linkedin.com/in "${c.company}" (${RECRUITERS.map((t) => `"${t}"`).join(' OR ')}) (data OR engineering)` },
    ].slice(0, MAX_SERP);

    const found = new Map(); // url -> {klass}
    for (const tpl of templates) {
      if (capHit) break;
      const urls = await bdSerp(tpl.q);
      serp++;
      for (const u of urls) if (!found.has(u)) found.set(u, { klass: tpl.klass });
    }
    discovered += found.size;

    for (const [url, meta] of found) {
      if (seenLeads.has(url)) continue;
      let name = nameFromUrl(url), headline = null;
      if (enriched < MAX_ENRICH && !capHit) {
        const e = await enrich(url);
        if (e) { enriched++; if (e.name) name = e.name; headline = e.headline; }
      }
      const affil = meta.klass === 'affiliation' ? (AFFIL.find((a) => true) || '') : '';
      const lead = { name, headline, url, company: c.company, klass: meta.klass, affil, appPageId: c.appPageId, country: c.country };
      if (DRY) { console.error(`  [${meta.klass}] ${name} — ${url}`); seenLeads.add(url); leads++; continue; }
      if (await writeLead(lead)) { seenLeads.add(url); leads++; }
    }
  }

  console.error(`bd-referral-scout: ${companies.length} companies, ${serp} SERP queries, ${discovered} discovered, ${leads} leads${DRY ? ' (DRY — nothing written)' : ''}. est $${cost.toFixed(4)}.`);
  contract({ ts: nowIso(), companies: companies.length, serp, discovered, enriched, leads, cost, capHit });
  process.exit(0);
})().catch((e) => { errors.push('fatal: ' + e.message); contract({ ts: nowIso(), companies: 0, serp: 0, discovered: 0, enriched: 0, leads: 0, cost, capHit }); process.exit(1); });
