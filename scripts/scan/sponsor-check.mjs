#!/usr/bin/env node
/**
 * sponsor-check.mjs — UK licensed-sponsor lookup for career-ops.
 *
 * Source of truth: the gov.uk "Register of licensed sponsors: workers"
 * (Worker and Temporary Worker), downloaded and stored under
 * data/uk-sponsor-register/. This script answers: "Is <employer> on the
 * register, and does it hold a Skilled Worker licence?" — the data that
 * turns oferta.md's `uk-sponsor-licensed` / `uk-2yr-ceiling` tags from a
 * guess into a fact (see modes/oferta.md → Step 6, UK two-year horizon).
 *
 * WHY FUZZY MATCHING: register names are legal entities — ALL CAPS,
 * trailing spaces, "LIMITED" vs "Ltd", "T/A <trading name>" aliases, and
 * commas inside quoted names. Job boards show trading names. A naive exact
 * match produces constant false negatives, so we normalise and tier the
 * match by confidence and NEVER return a bare yes/no.
 *
 * Usage:
 *   node sponsor-check.mjs --company "Monzo Bank"          # human-readable
 *   node sponsor-check.mjs --company "Monzo Bank" --json   # machine contract
 *   node sponsor-check.mjs --rebuild                        # regenerate index
 *                                                           # after re-download
 *
 * Re-download cadence: gov.uk republishes the register most working days.
 * Drop the new CSV into data/uk-sponsor-register/ and run --rebuild.
 *
 * Output contract (--json):
 *   {
 *     query, normalizedQuery,
 *     match: "high" | "medium" | "low" | "none",
 *     skilledWorker: true|false,        // holds a Skilled Worker licence
 *     recommendedTag: "uk-sponsor-licensed" | "uk-2yr-ceiling" | "uk-sponsor-route-mismatch",
 *     best: { name, town, county, rating, routes[] } | null,
 *     candidates: [ ...up to 5 {name, routes[], confidence} ]
 *   }
 *
 * Zero LLM cost. Pure Node, no dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REG_DIR = path.join(__dirname, '..', '..', 'data', 'uk-sponsor-register');
const INDEX_PATH = path.join(REG_DIR, 'index.json');

// ---------------------------------------------------------------------------
// CSV parsing (RFC-4180-ish: quote-aware, handles commas inside quotes)
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // swallow; \n handles the row break
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
const LEGAL_SUFFIXES = new Set([
  'LTD', 'LIMITED', 'LLP', 'LLC', 'PLC', 'LP', 'CIC', 'CIO',
  'INC', 'CORP', 'CO', 'COMPANY', 'GROUP', 'HOLDINGS', 'UK',
]);

// Full normalised key: uppercase, strip punctuation, collapse spaces.
function normFull(name) {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Core key: like normFull but with trailing legal-form tokens removed.
// "MONZO BANK LIMITED" -> "MONZO BANK". Reduces LIMITED/Ltd false negatives.
function normCore(name) {
  const tokens = normFull(name).split(' ').filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

// Split a register name into its legal name + any "T/A <trading name>" alias.
function splitTradingNames(name) {
  const parts = name.split(/\s+T\s*\/?\s*A\s+|\s+TRADING AS\s+/i);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function jaccard(a, b) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ---------------------------------------------------------------------------
// Index build
// ---------------------------------------------------------------------------
function findLatestCsv() {
  if (!fs.existsSync(REG_DIR)) return null;
  const csvs = fs.readdirSync(REG_DIR)
    .filter((f) => f.toLowerCase().endsWith('.csv'))
    .sort();
  return csvs.length ? path.join(REG_DIR, csvs[csvs.length - 1]) : null;
}

function rebuild() {
  const csvPath = findLatestCsv();
  if (!csvPath) {
    console.error(`No CSV found in ${REG_DIR}. Download the gov.uk register and place it there.`);
    process.exit(1);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCsv(text);
  const header = rows.shift(); // Organisation Name,Town/City,County,Type & Rating,Route

  // Merge multiple route rows per organisation into one record.
  const byCore = new Map(); // coreKey -> record
  const records = [];
  for (const r of rows) {
    if (!r || r.length < 5) continue;
    const name = (r[0] || '').trim();
    if (!name) continue;
    const town = (r[1] || '').trim();
    const county = (r[2] || '').trim();
    const rating = (r[3] || '').trim();
    const route = (r[4] || '').trim();
    const coreKey = normCore(name);
    if (!coreKey) continue;
    let rec = byCore.get(coreKey);
    if (!rec) {
      rec = { name, town, county, rating, routes: [], norm: normFull(name), core: coreKey, aliases: [] };
      // index trading-as aliases as additional core keys
      const tnames = splitTradingNames(name);
      if (tnames.length > 1) rec.aliases = tnames.map(normCore).filter((a) => a && a !== coreKey);
      byCore.set(coreKey, rec);
      records.push(rec);
    }
    if (route && !rec.routes.includes(route)) rec.routes.push(route);
  }

  // alias map -> index into records
  const aliasMap = {};
  records.forEach((rec, i) => {
    aliasMap[rec.core] = i;
    for (const a of rec.aliases) if (!(a in aliasMap)) aliasMap[a] = i;
  });

  const meta = {
    source: path.basename(csvPath),
    builtAt: new Date().toISOString(),
    totalRows: rows.length,
    uniqueOrgs: records.length,
  };
  fs.writeFileSync(INDEX_PATH, JSON.stringify({ meta, records, aliasMap }));
  console.log(`Built index: ${records.length} unique organisations from ${rows.length} rows (${meta.source}).`);
  console.log(`Written to ${path.relative(__dirname, INDEX_PATH)}`);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    console.error('Index not built yet. Run: node sponsor-check.mjs --rebuild');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

function hasSkilledWorker(rec) {
  return rec.routes.some((r) => /skilled worker/i.test(r));
}

function lookup(company, idx) {
  const qFull = normFull(company);
  const qCore = normCore(company);
  const { records, aliasMap } = idx;

  // Tier 1: exact core / alias match -> high
  if (qCore in aliasMap) {
    const rec = records[aliasMap[qCore]];
    return { confidence: 'high', best: rec, candidates: [rec] };
  }

  // Tier 2/3: scan for containment + fuzzy. (127k records — linear scan is
  // a few hundred ms, fine for an evaluation-time call.)
  const scored = [];
  for (const rec of records) {
    let conf = 0;
    if (rec.core === qCore) conf = 1.0;
    else {
      // token-boundary containment, not substring noise.
      const a = rec.core.split(' '), b = qCore.split(' ');
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      const allIn = shorter.every((t) => longer.includes(t));
      // Guard against a single short shared token (e.g. query "Acme Cafe ZZZ"
      // spuriously matching "ZZZ Ltd"). Multi-word containment needs >=2 shared
      // tokens; a single-token match only counts when the QUERY itself is that
      // one word (an intentional brand search like "Monzo").
      const qSingle = b.length === 1;
      if (allIn && (shorter.length >= 2 || qSingle)) {
        conf = shorter.length >= 2 ? 0.8 : 0.7;
      }
    }
    if (conf === 0 && rec.core !== qCore) {
      const j = jaccard(rec.core, qCore);
      if (j >= 0.5) conf = 0.4 + j * 0.3;
    }
    if (conf > 0) scored.push({ rec, conf });
  }
  scored.sort((a, b) => b.conf - a.conf);

  if (!scored.length) return { confidence: 'none', best: null, candidates: [] };
  const topConf = scored[0].conf;
  const confidence = topConf >= 0.95 ? 'high' : topConf >= 0.7 ? 'medium' : 'low';
  return {
    confidence,
    best: confidence === 'low' ? null : scored[0].rec,
    candidates: scored.slice(0, 5).map((s) => s.rec),
    scored: scored.slice(0, 5),
  };
}

function recommendTag(result) {
  if (result.confidence === 'none' || result.confidence === 'low') return 'uk-2yr-ceiling';
  const rec = result.best;
  if (rec && hasSkilledWorker(rec)) return 'uk-sponsor-licensed';
  if (rec) return 'uk-sponsor-route-mismatch';
  return 'uk-2yr-ceiling';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const wantJson = process.argv.includes('--json');

if (process.argv.includes('--rebuild')) {
  rebuild();
  process.exit(0);
}

const company = arg('--company');
// Distinguish a genuinely absent flag (misuse → Usage) from an explicitly empty
// value. A batch caller (oferta.md Step 6) passes --company "{Company}", which is
// empty for an undisclosed/blank row. That must degrade to a graceful "none"
// result, NOT a non-JSON Usage dump + exit 1 that breaks the JSON consumer.
if (company === null) {
  console.error('Usage: node sponsor-check.mjs --company "Employer Name" [--json]');
  console.error('       node sponsor-check.mjs --rebuild');
  process.exit(1);
}
if (!company.trim()) {
  const none = {
    query: company, normalizedQuery: '', match: 'none', skilledWorker: false,
    recommendedTag: 'uk-2yr-ceiling', best: null, candidates: [], registerSource: null,
  };
  if (wantJson) console.log(JSON.stringify(none, null, 2));
  else console.log('\n  (no company provided)\n  -> NOT FOUND on register\n     Recommended Fit-notes tag: uk-2yr-ceiling\n');
  process.exit(0);
}

const idx = loadIndex();
const result = lookup(company, idx);
const tag = recommendTag(result);
const sw = result.best ? hasSkilledWorker(result.best) : false;

if (wantJson) {
  console.log(JSON.stringify({
    query: company,
    normalizedQuery: normCore(company),
    match: result.confidence,
    skilledWorker: sw,
    recommendedTag: tag,
    best: result.best ? {
      name: result.best.name.trim(),
      town: result.best.town,
      county: result.best.county,
      rating: result.best.rating,
      routes: result.best.routes,
    } : null,
    candidates: (result.candidates || []).map((c) => ({
      name: c.name.trim(), routes: c.routes,
    })),
    registerSource: idx.meta.source,
  }, null, 2));
} else {
  const label = { high: 'ON REGISTER (high confidence)', medium: 'LIKELY ON REGISTER (medium confidence)', low: 'POSSIBLE MATCH (low confidence — verify)', none: 'NOT FOUND on register' }[result.confidence];
  console.log(`\n  ${company}`);
  console.log(`  -> ${label}`);
  if (result.best) {
    console.log(`     Matched: ${result.best.name.trim()}${result.best.town ? ' — ' + result.best.town : ''}`);
    console.log(`     Rating:  ${result.best.rating}`);
    console.log(`     Routes:  ${result.best.routes.join('; ')}`);
    console.log(`     Skilled Worker licence: ${sw ? 'YES' : 'NO'}`);
  } else if (result.candidates && result.candidates.length) {
    console.log(`     Closest names on register:`);
    for (const c of result.candidates) console.log(`       - ${c.name.trim()} [${c.routes.join('; ')}]`);
  }
  console.log(`     Recommended Fit-notes tag: ${tag}`);
  console.log(`     (register: ${idx.meta.source})\n`);
}
