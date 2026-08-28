#!/usr/bin/env node
// notion-scan-write.mjs — insert scan.mjs hits into Notion as Stage-1 rows.
//
// THE GAP THIS CLOSES (2026-08-11)
// morning-scan could not write to Notion. Not "wrote badly" — could not write
// at all. Its own contract said so on every run:
//
//   "Notion Stage-1 write path (step 4) is structurally unavailable this run —
//    Notion MCP is not loaded under --strict-mcp-config ... and no REST
//    equivalent (notion-scan-write.mjs) exists yet for scan.mjs-sourced hits"
//
// The routine is a `claude -p` prompt and was told to insert rows via the Notion
// MCP. run-routine.ps1 launches it with --strict-mcp-config so only the
// brightdata server loads (the 2026-07-06 isolation change that cut per-run
// standup from ~500K cache tokens). Notion MCP therefore is not there. Result:
// 42 portals scanned, ~6,280 postings pulled daily, and across eight runs it
// found 0, 3, 1, 0, 0 and 2 hits and wrote ZERO rows every time. The hits from
// 08-05 and 08-10 were found, filtered, logged, and thrown away.
//
// This is the missing REST equivalent, named exactly as that log predicted.
// Pure node, no MCP, so environment isolation cannot take it away — the same
// reason bd-bulk-scan.mjs never had this problem.
//
// USAGE
//   node scan.mjs --emit-json data/.scan-hits.json
//   node notion-scan-write.mjs --in data/.scan-hits.json [--scanner morning-scan] [--dry-run]
//
// Dedups against Notion by Job URL before inserting, so a re-run is safe.
// Emits a machine-stable contract block the routine echoes verbatim.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { createStage1Row } from './notion-stage1.mjs';
import { fetchWithRetry } from '../net-retry.mjs';

// scripts/notion/ -> repo root
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = args.includes('--dry-run');
const IN = arg('--in') || 'data/.scan-hits.json';
const SCANNER = arg('--scanner') || 'morning-scan';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const CFG_PATH = path.join(ROOT, 'config', 'profile.yml');
const CFG = (() => {
  try { return yaml.load(readFileSync(CFG_PATH, 'utf8')) || {}; }
  catch { return {}; }
})();
const DATABASE_ID = process.env.NOTION_DATABASE_ID
  || (CFG.notion && (CFG.notion.applications_database_id || CFG.notion.applications_data_source_id));

function contract(fields) {
  console.log('\n--- SCAN_WRITE_CONTRACT ---');
  console.log(`SCRIPT: notion-scan-write.mjs`);
  console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
  for (const [k, v] of Object.entries(fields)) console.log(`${k}: ${v}`);
  console.log('--- END_SCAN_WRITE_CONTRACT ---');
}

function abort(msg) {
  console.error(`SCAN_WRITE_ABORT: ${msg}`);
  contract({ HITS_IN: 0, ALREADY_IN_NOTION: 0, ROWS_WRITTEN: 0, WRITE_FAILURES: 0, ERRORS: 1 });
  process.exit(2);
}

if (!NOTION_TOKEN) abort('NOTION_TOKEN not set');
if (!DATABASE_ID) abort('notion.applications_database_id missing from config/profile.yml');
if (!existsSync(IN)) abort(`input not found: ${IN} (run scan.mjs --emit-json first)`);

let payload;
try { payload = JSON.parse(readFileSync(IN, 'utf8')); }
catch (e) { abort(`input unparseable: ${e.message}`); }
const hits = Array.isArray(payload.hits) ? payload.hits : [];

// Snapshot existing Job URLs so a re-run cannot duplicate. One paged query,
// same shape bd-bulk-scan uses for its seen-cache.
async function seenUrls() {
  const seen = new Set();
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    let r;
    try {
      r = await fetchWithRetry(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { label: 'scan-write dedup' });
    } catch (e) {
      // Degrade LOUDLY but keep going: inserting a possible duplicate beats
      // dropping a real hit, which is the failure this whole file exists to end.
      console.error(`  dedup snapshot unavailable (${e.code || e.message}) — proceeding without it`);
      return null;
    }
    if (!r.ok) { console.error(`  dedup snapshot HTTP ${r.status} — proceeding without it`); return null; }
    const d = await r.json();
    for (const row of d.results || []) {
      const u = row.properties?.['Job URL']?.url;
      if (u) seen.add(u.split('?')[0]);
    }
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return seen;
}

const seen = await seenUrls();
let written = 0, skipped = 0, failed = 0;
const errors = [];

for (const h of hits) {
  if (!h || !h.url) { skipped++; continue; }
  if (seen && seen.has(String(h.url).split('?')[0])) { skipped++; continue; }
  if (DRY) { console.log(`  [dry] would write: ${h.company} | ${h.title}`); written++; continue; }
  try {
    await createStage1Row(h, { notionToken: NOTION_TOKEN, databaseId: DATABASE_ID, scanner: SCANNER });
    written++;
    console.log(`  + ${h.company} | ${h.title}`);
  } catch (e) {
    failed++;
    errors.push(`${h.company || '?'}: ${String(e.message).slice(0, 120)}`);
  }
}

contract({
  SCANNER: SCANNER,
  HITS_IN: hits.length,
  ALREADY_IN_NOTION: skipped,
  ROWS_WRITTEN: written,
  WRITE_FAILURES: failed,
  DEDUP_SNAPSHOT: seen ? `${seen.size} urls` : 'unavailable',
  ERRORS: errors.length,
  ...(errors.length ? { ERROR_DETAILS: '|\n  ' + errors.slice(0, 10).join('\n  ') } : {}),
});
process.exit(failed > 0 ? 1 : 0);
