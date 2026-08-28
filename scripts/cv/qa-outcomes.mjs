#!/usr/bin/env node
/**
 * qa-outcomes.mjs — aggregate cv-qa outcomes from data/qa-log.jsonl.
 *
 * Reads the append-only log cv-qa writes on every row and emits:
 *   - data/qa-outcomes.json  (structured aggregate for programmatic consumers)
 *   - stdout table (human summary)
 *
 * Breakdowns:
 *   overall     — pass / patch / regen-needed / manual, total rows
 *   by_archetype — same breakdowns per classified_as (AE / DS / DE / DA / BI / ME / hybrid)
 *   by_verdict   — count of overall_verdict values
 *   by_check     — pass/fail rate per check name
 *   cost         — total API calls, subscription calls, output tokens, cap-hit rate
 *   profile_regen — attempt counts, rollback counts, rollback reasons
 *
 * Usage:
 *   node scripts/cv/qa-outcomes.mjs                 # aggregate everything
 *   node scripts/cv/qa-outcomes.mjs --since 30d     # only rows within N days
 *   node scripts/cv/qa-outcomes.mjs --json-only     # skip stdout table
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_PATH = resolve(REPO_ROOT, 'data', 'qa-log.jsonl');
const OUT_PATH = resolve(REPO_ROOT, 'data', 'qa-outcomes.json');

function parseSince(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)([dh])$/);
  if (!m) return null;
  const [, n, unit] = m;
  const ms = unit === 'd' ? Number(n) * 86400 * 1000 : Number(n) * 3600 * 1000;
  return Date.now() - ms;
}

function loadRows(sinceMs) {
  if (!existsSync(LOG_PATH)) return [];
  const raw = readFileSync(LOG_PATH, 'utf8');
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (sinceMs && new Date(row.ts).getTime() < sinceMs) continue;
      rows.push(row);
    } catch {
      // skip malformed lines silently — logs from older cv-qa versions may
      // have partial schemas
    }
  }
  return rows;
}

function bucket(rows, keyFn) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r) ?? '(unknown)';
    if (!out[k]) out[k] = [];
    out[k].push(r);
  }
  return out;
}

function verdictSummary(rows) {
  const s = { pass: 0, patch_and_pass: 0, regenerate: 0, other: 0 };
  for (const r of rows) {
    const v = String(r.overall_verdict || '').toLowerCase();
    if (v === 'pass') s.pass++;
    else if (v === 'patch_and_pass') s.patch_and_pass++;
    else if (v === 'regenerate') s.regenerate++;
    else s.other++;
  }
  s.total = rows.length;
  s.pass_rate = rows.length ? +(s.pass / rows.length).toFixed(3) : 0;
  return s;
}

function checkSummary(rows) {
  const checkNames = ['role_title', 'nda_compliance', 'cover_letter', 'above_the_fold', 'profile_framework'];
  const out = {};
  for (const c of checkNames) {
    const counts = { PASS: 0, PARTIAL: 0, FAIL: 0, missing: 0 };
    for (const r of rows) {
      const v = r.checks?.[c];
      if (v === 'PASS') counts.PASS++;
      else if (v === 'PARTIAL') counts.PARTIAL++;
      else if (v === 'FAIL') counts.FAIL++;
      else counts.missing++;
    }
    out[c] = counts;
  }
  return out;
}

function costSummary(rows) {
  let out_tokens = 0, api_calls = 0, sub_calls = 0, cap_hit = 0;
  for (const r of rows) {
    out_tokens += r.qa_cost_output_tokens || 0;
    api_calls  += r.qa_cost_api_calls || 0;
    sub_calls  += r.qa_cost_subscription_calls || 0;
    if (r.qa_cost_cap_hit) cap_hit++;
  }
  return { total_output_tokens: out_tokens, total_api_calls: api_calls, total_subscription_calls: sub_calls, rows_hit_cap: cap_hit };
}

function profileRegenSummary(rows) {
  let attempts = 0, rolled_back = 0, rows_with_attempts = 0;
  for (const r of rows) {
    if ((r.profile_regen_attempts || 0) > 0) rows_with_attempts++;
    attempts += r.profile_regen_attempts || 0;
    rolled_back += r.profile_regen_rolled_back || 0;
  }
  return {
    rows_with_attempts,
    total_attempts: attempts,
    total_rolled_back: rolled_back,
    rollback_rate: attempts ? +(rolled_back / attempts).toFixed(3) : 0,
  };
}

function aggregate(rows) {
  return {
    generated_at: new Date().toISOString(),
    row_count: rows.length,
    date_range: rows.length ? { first: rows[0]?.ts, last: rows[rows.length - 1]?.ts } : null,
    overall: verdictSummary(rows),
    by_archetype: Object.fromEntries(
      Object.entries(bucket(rows, r => r.classified_as)).map(([k, v]) => [k, {
        row_count: v.length,
        ...verdictSummary(v),
        checks: checkSummary(v),
      }]),
    ),
    by_market: Object.fromEntries(
      Object.entries(bucket(rows, r => r.market)).map(([k, v]) => [k, verdictSummary(v)]),
    ),
    checks: checkSummary(rows),
    cost: costSummary(rows),
    profile_regen: profileRegenSummary(rows),
    framing_mismatch_rows: rows.filter(r => r.framing_mismatch).length,
  };
}

function printTable(agg) {
  console.log(`\nQA outcomes (${agg.row_count} rows, ${agg.date_range?.first?.slice(0, 10)} → ${agg.date_range?.last?.slice(0, 10)})`);
  console.log(`\nOverall verdict:`);
  const o = agg.overall;
  console.log(`  PASS            : ${o.pass}    (${(o.pass_rate * 100).toFixed(1)}%)`);
  console.log(`  PATCH_AND_PASS  : ${o.patch_and_pass}`);
  console.log(`  REGENERATE      : ${o.regenerate}`);
  console.log(`  other           : ${o.other}`);
  console.log(`\nBy archetype:`);
  for (const [arch, s] of Object.entries(agg.by_archetype)) {
    console.log(`  ${arch.padEnd(10)}: ${s.row_count} rows, pass_rate=${(s.pass_rate * 100).toFixed(1)}%`);
  }
  console.log(`\nCheck pass counts:`);
  for (const [name, counts] of Object.entries(agg.checks)) {
    const total = counts.PASS + counts.PARTIAL + counts.FAIL;
    const rate = total ? ((counts.PASS / total) * 100).toFixed(1) : '0.0';
    console.log(`  ${name.padEnd(20)}: PASS=${counts.PASS} PARTIAL=${counts.PARTIAL} FAIL=${counts.FAIL} (pass_rate=${rate}%)`);
  }
  console.log(`\nProfile regen:`);
  const pr = agg.profile_regen;
  console.log(`  rows_with_attempts : ${pr.rows_with_attempts}`);
  console.log(`  total_attempts     : ${pr.total_attempts}`);
  console.log(`  rolled_back        : ${pr.total_rolled_back} (${(pr.rollback_rate * 100).toFixed(1)}% of attempts)`);
  console.log(`\nCost:`);
  const c = agg.cost;
  console.log(`  API calls          : ${c.total_api_calls}`);
  console.log(`  subscription calls : ${c.total_subscription_calls}`);
  console.log(`  output tokens      : ${c.total_output_tokens.toLocaleString()}`);
  console.log(`  rows hit cap       : ${c.rows_hit_cap}`);
  console.log(`\nFraming mismatch rows: ${agg.framing_mismatch_rows}`);
  console.log(`\nWrote ${OUT_PATH}\n`);
}

function main() {
  const argv = process.argv.slice(2);
  let since = null, jsonOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since') since = parseSince(argv[++i]);
    else if (argv[i] === '--json-only') jsonOnly = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/cv/qa-outcomes.mjs [--since 30d] [--json-only]');
      return;
    }
  }
  const rows = loadRows(since);
  const agg = aggregate(rows);
  writeFileSync(OUT_PATH, JSON.stringify(agg, null, 2), 'utf8');
  if (!jsonOnly) printTable(agg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
