#!/usr/bin/env node
/**
 * profile-source-outcomes.mjs — joined analyser: profile-source (llm-enriched vs
 * template vs static-cv) vs Notion response outcome. Answers the question
 * "does LLM enrichment beat the template on response rate?"
 *
 * Data sources:
 *   1. data/profile-source-log.jsonl — every render, appended by both renderers
 *      via cv/profile-source-log.mjs. Contains {ts, company, role_title, source, ...}.
 *   2. Notion Applications DB — queried via `node scripts/notion/notion-query.mjs --json`
 *      and filtered locally to APPLIED_STAGES (see metrics-core.mjs canonical taxonomy).
 *
 * Join key: slugified company name. When multiple render rows exist for the
 * same company, the one closest-in-time to the Notion row's apply date wins.
 *
 * Emits:
 *   - data/profile-source-outcomes.json (structured)
 *   - stdout table (grouped by source, showing counts + response rate)
 *
 * Usage:
 *   node scripts/cv/profile-source-outcomes.mjs                # aggregate everything
 *   node scripts/cv/profile-source-outcomes.mjs --json-only    # skip stdout table
 *
 * Prerequisites: NOTION_TOKEN env var (same requirement as notion-query.mjs).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  APPLIED_STAGES,
  classifyNotionOutcome,
  companySlug,
  bucketProfileSource,
} from '../metrics/metrics-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_PATH = resolve(REPO_ROOT, 'data', 'profile-source-log.jsonl');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'profile-source-outcomes.json');
const NOTION_QUERY_MJS = resolve(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');

const slugify = companySlug;
const bucketSource = bucketProfileSource;

function loadRenderLog() {
  if (!existsSync(LOG_PATH)) return [];
  const rows = [];
  for (const line of readFileSync(LOG_PATH, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return rows;
}

function loadNotionRows() {
  const result = spawnSync(
    process.execPath,
    [NOTION_QUERY_MJS, '--json'],
    { encoding: 'utf8', timeout: 120 * 1000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`notion-query failed (exit ${result.status}): ${(result.stderr || '').slice(0, 300)}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`Failed to parse notion-query output: ${err.message}`);
  }
}

// Match a Notion row's company name against render-log entries. Slugified
// company match is the primary key; role_title is a tie-breaker when the
// Notion title includes it. Returns the render row (may be null if no match).
function findRenderForNotion(notion, renderRows) {
  const notionCompany = slugify(extractCompanyFromNotionTitle(notion.title));
  if (!notionCompany) return null;
  const candidates = renderRows.filter(r => slugify(r.company) === notionCompany);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const notionRole = String(notion.position?.[0] || '').toLowerCase();
  const roleMatch = candidates.find(r => String(r.role_title || '').toLowerCase() === notionRole);
  if (roleMatch) return roleMatch;
  return candidates.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0];
}

function extractCompanyFromNotionTitle(title) {
  if (!title) return '';
  return String(title).split(/[-–—:|]/)[0].trim();
}

function aggregate(renderRows, notionRows) {
  const applied = notionRows.filter(n => APPLIED_STAGES.includes(n.stage));
  const buckets = {};
  const unmatched = [];

  for (const notion of applied) {
    const render = findRenderForNotion(notion, renderRows);
    if (!render) { unmatched.push({ company: extractCompanyFromNotionTitle(notion.title), stage: notion.stage }); continue; }
    const bucket = bucketSource(render.source);
    if (!buckets[bucket]) buckets[bucket] = { total: 0, progressed: 0, responded: 0, rejected: 0, ghosted: 0, matches: [] };
    const outcome = classifyNotionOutcome({ stage: notion.stage });
    buckets[bucket].total++;
    if (outcome === 'progressed') buckets[bucket].progressed++;
    else if (outcome === 'responded') buckets[bucket].responded++;
    else if (outcome === 'rejected') buckets[bucket].rejected++;
    else if (outcome === 'ghosted') buckets[bucket].ghosted++;
    buckets[bucket].matches.push({
      company: extractCompanyFromNotionTitle(notion.title),
      stage: notion.stage,
      outcome,
      render_ts: render.ts,
      render_source: render.source,
    });
  }

  for (const [k, b] of Object.entries(buckets)) {
    const responses = b.progressed + b.responded + b.rejected;
    b.response_rate = b.total ? +(responses / b.total).toFixed(3) : 0;
    b.progression_rate = b.total ? +(b.progressed / b.total).toFixed(3) : 0;
  }

  return {
    generated_at: new Date().toISOString(),
    total_render_rows: renderRows.length,
    total_notion_applied: applied.length,
    matched_rows: Object.values(buckets).reduce((s, b) => s + b.total, 0),
    unmatched_count: unmatched.length,
    buckets,
    unmatched_sample: unmatched.slice(0, 20),
  };
}

function printTable(agg) {
  console.log(`\nProfile-source outcomes joined analysis`);
  console.log(`Render-log rows: ${agg.total_render_rows}`);
  console.log(`Notion applied cohort: ${agg.total_notion_applied}`);
  console.log(`Matched: ${agg.matched_rows}, Unmatched: ${agg.unmatched_count}`);
  console.log(`\nBy profile source bucket:`);
  console.log('  bucket               total  progressed  responded  rejected  ghosted  resp_rate  progression_rate');
  for (const [k, b] of Object.entries(agg.buckets).sort((a, b) => b[1].total - a[1].total)) {
    const pad = (n, w) => String(n).padStart(w);
    console.log(`  ${k.padEnd(20)} ${pad(b.total, 5)}  ${pad(b.progressed, 10)}  ${pad(b.responded, 9)}  ${pad(b.rejected, 8)}  ${pad(b.ghosted, 7)}  ${pad((b.response_rate * 100).toFixed(1) + '%', 9)}  ${pad((b.progression_rate * 100).toFixed(1) + '%', 15)}`);
  }
  if (agg.unmatched_sample.length) {
    console.log(`\nSample unmatched Notion rows (need a render-log entry to be analysable):`);
    for (const u of agg.unmatched_sample.slice(0, 10)) console.log(`  ${u.stage.padEnd(20)} ${u.company}`);
  }
  console.log(`\nWrote ${OUT_PATH}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  const jsonOnly = argv.includes('--json-only');
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/cv/profile-source-outcomes.mjs [--json-only]\n\nRequires NOTION_TOKEN env var.');
    return;
  }
  const renderRows = loadRenderLog();
  if (renderRows.length === 0) {
    console.error('[profile-source-outcomes] data/profile-source-log.jsonl is empty. Render at least one CV first.');
    process.exit(2);
  }
  let notionRows;
  try {
    notionRows = loadNotionRows();
  } catch (err) {
    console.error(`[profile-source-outcomes] Notion query failed: ${err.message}`);
    console.error('Set NOTION_TOKEN in your env, then retry.');
    process.exit(1);
  }
  const agg = aggregate(renderRows, notionRows);
  writeFileSync(OUT_PATH, JSON.stringify(agg, null, 2), 'utf8');
  if (!jsonOnly) printTable(agg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
