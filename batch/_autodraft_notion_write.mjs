#!/usr/bin/env node
// Stage-3 page-property writer for the nightly auto-draft run.
//
// Reads the CV manifest (variant / lang / role-title per row) plus a per-row
// note table assembled by the routine (recruiter-sim verdict, honest
// interview-conversion probability, and any gap flags), preserves the prior
// auto-eval Fit notes, appends the [auto-draft ...] sentinel block, and calls
// notion-draft-write.mjs once per row IN THE FOREGROUND (the routine's HANG
// GUARD forbids backgrounding these).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const NOTION_DRAFT_WRITE = path.join(ROOT, 'scripts', 'notion', 'notion-draft-write.mjs');

const RUN_ID = process.env.RUN_ID || `auto-draft-${new Date().toISOString().slice(0, 10)}`;
const LETTER_DATE = process.env.LETTER_DATE || new Date().toISOString().slice(0, 10);
const manifest = JSON.parse(fs.readFileSync('data/.routine-tmp/cv-manifest.json', 'utf8'));
// Prior Fit notes are read from the LIVE queue, not the selection snapshot, so
// a row edited between selection and write is not silently rolled back.
const queue = JSON.parse(fs.readFileSync('data/.routine-tmp/draft-queue.json', 'utf8'));
const byId = new Map((Array.isArray(queue) ? queue : (queue.rows || queue.results || []))
  .map(r => [r.application_id, r]));

// Per-row assessment notes. The routine writes these to
// data/.routine-tmp/assess.json each run (app_id -> {verdict, prob, notes[]}).
// A per-run JSON file keeps the driver stable and the data with the run.
// Missing file or missing row degrades to the neutral default rather than
// failing the write.
const ASSESS_FILE = process.env.ASSESS_FILE || 'data/.routine-tmp/assess.json';
let ASSESS = {};
try { ASSESS = JSON.parse(fs.readFileSync(ASSESS_FILE, 'utf8')); }
catch { console.error(`  [assess] no ${ASSESS_FILE}; every row falls back to the neutral default`); }


const results = [];
for (const e of manifest) {
  if (e.status !== 'ok') { results.push({ app: e.app_id, ok: false, why: 'cv build failed' }); continue; }
  const row = byId.get(e.app_id) || {};
  const a = ASSESS[e.app_id] || { verdict: 'MAYBE', prob: 'n/a', notes: [] };
  const cvVariant = e.lang === 'de' ? 'DE-tailored' : 'EN-tailored';
  const clLang = /din5008_de/.test(readAudit(e.app_id)) ? 'DE' : (e.lang === 'de' ? 'DE' : 'EN');

  const block = [
    `[auto-draft ${RUN_ID.replace('auto-draft-', '')}]`,
    `CV + cover letter + form answers uploaded to this row's Resume / Cover Letter / Form answers file properties.`,
    `CV: variant ${e.variant}/${e.lang}${e.dach_format ? ' in DACH format' : ''}, header "${e.role_title}", market tail ${e.market_country}.`,
    `Recruiter-sim 30-second scan: ${a.verdict}. Honest interview-conversion estimate: ${a.prob}.`,
    ...a.notes,
  ].join('\n');

  const prior = String(row.fit_notes || '').trim();
  const room = 1980 - block.length - 4;
  const notes = prior ? `${prior.slice(0, Math.max(0, room))}\n\n${block}` : block;

  // notion-draft-write.mjs can hit a libuv teardown crash on some Node
  // versions: it PUTs the properties, prints {"status":"ok"}, then aborts
  // with exit 127 ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
  // Trusting the exit code reports NOTION_WRITE_FAILURES for writes that
  // actually landed, so success is read off stdout and the exit code is
  // ignored when stdout carries the ok payload.
  let out = '';
  try {
    out = execFileSync('node', [NOTION_DRAFT_WRITE, '--page', e.page_id,
      '--cvvariant', cvVariant, '--clvariant', clLang, '--runid', RUN_ID, '--notes', notes, '--json'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, encoding: 'utf8' }) || '';
  } catch (err) {
    out = String((err && err.stdout) || '');
    if (!/"status"\s*:\s*"ok"/.test(out)) {
      results.push({ app: e.app_id, ok: false, why: String(err.message || err).slice(0, 140) });
      continue;
    }
  }
  if (/"status"\s*:\s*"ok"/.test(out)) {
    results.push({ app: e.app_id, ok: true, cvVariant, clLang, verdict: a.verdict });
  } else {
    results.push({ app: e.app_id, ok: false, why: `unexpected output: ${out.slice(0, 120)}` });
  }
}

// Letters are named either `{num}-{slug}-{date}.md` (older runs) or
// `APP-{num}-{slug}-{date}.md` (current generate.js). Match both, or the CL
// language falls back to the CV language and a German Anschreiben on an
// English-content row would be labelled EN in Notion.
function readAudit(appId) {
  const n = appId.replace('APP-', '');
  const dir = 'output/cover-letters';
  if (!fs.existsSync(dir)) return '';
  const f = fs.readdirSync(dir).find(x =>
    (x.startsWith(n + '-') || x.startsWith(`APP-${n}-`)) && x.endsWith(`${LETTER_DATE}.md`));
  return f ? fs.readFileSync(`${dir}/${f}`, 'utf8') : '';
}

for (const r of results) console.log(JSON.stringify(r));
console.log(`written ok=${results.filter(r => r.ok).length} fail=${results.filter(r => !r.ok).length}`);
