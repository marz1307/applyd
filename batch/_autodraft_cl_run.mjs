#!/usr/bin/env node
// Sequential cover-letter driver for the nightly auto-draft run.
//
// Runs cover-letter generate.js once per row IN THE FOREGROUND (the routine's
// HANG GUARD forbids backgrounding anything the turn has to wait on), reading
// company / country / role-hint / seniority straight off the CV manifest so the
// letter and the CV can never disagree about which role was targeted.
//
// TWO DELIBERATE FLAG CHOICES:
//   --jd-file  the routine already fetched the posting into <dir>/jd.txt and
//              stripped the portal's furniture. generate.js's own firecrawl
//              pull is the thing that has previously mistaken portal chrome
//              (XING/eFC boilerplate, headers, ATS shells) for company facts,
//              so we hand it the clean text instead.
//   --no-qa    generate.js's built-in cv-qa gate shells out to `claude -p`.
//              Under a scheduled run that spawn can time out, and a timed-out
//              gate has previously shipped a chat-style meta-refusal AS the
//              letter body. The routine does the §4/§9 pass itself and gates
//              on deterministic caveats-audit + cv/writing-eval.mjs.
//
// Upload is left to the upload-plan step so there is exactly one upload path.
//
// Usage: node batch/_autodraft_cl_run.mjs [--manifest <path>] [--date YYYY-MM-DD]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const GENERATE = path.join(ROOT, 'scripts', 'cover-letters', 'generate.js');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
// Default MUST be the file _autodraft_cv_run.mjs actually writes, which is
// also what _autodraft_upload_plan.mjs and _autodraft_notion_write.mjs read.
// A one-off overridden default (e.g. a manifest from a prior run) will
// silently generate letters for THAT run's rows instead of tonight's.
const MANIFEST = arg('--manifest') || path.join(ROOT, 'data', '.routine-tmp', 'cv-manifest.json');
const DATE = arg('--date') || new Date().toISOString().slice(0, 10);
const OUT = path.join(ROOT, 'data', '.routine-tmp', 'cl-run-log.json');

// CV variant -> generate.js role hint. Same taxonomy, so this is identity for
// every variant the router knows; master has no hint and is left unset.
const HINT = { de: 'de', ae: 'ae', ds: 'ds', da: 'da', me: 'me' };

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const log = [];

for (const e of manifest) {
  if (e.status !== 'ok') { log.push({ app: e.app_id, status: 'skipped-cv-fail' }); continue; }
  const jdFile = path.join(e.dir, 'jd.txt');
  const args = [
    GENERATE,
    '--job-url', e.job_url,
    '--app-id', e.app_id.replace('APP-', ''),
    '--company', e.company,
    '--today', DATE,
    '--keep-md', '--no-qa', '--no-upload',
  ];
  if (HINT[e.variant]) args.push('--role-hint', HINT[e.variant]);
  // Employer country drives the DIN/DACH letter format; the CV's market
  // country is the same value except where an English-locale URL overrode a
  // mis-tagged Country field, and in that case the letter should follow the
  // URL too.
  if (e.market_country) args.push('--country', e.market_country);
  if (e.seniority) args.push('--seniority', e.seniority);
  if (fs.existsSync(jdFile)) args.push('--jd-file', jdFile);

  const started = Date.now();
  try {
    const out = execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    log.push({ app: e.app_id, status: 'ok', ms: Date.now() - started, out: out.slice(-400) });
    console.error(`  ok  ${e.app_id} ${e.company}`);
  } catch (err) {
    const detail = String(err.stderr || err.message || err).slice(-600);
    log.push({ app: e.app_id, status: 'fail', ms: Date.now() - started, error: detail });
    console.error(`  FAIL ${e.app_id} ${e.company}: ${detail.slice(-200)}`);
  }
}

fs.writeFileSync(OUT, JSON.stringify(log, null, 2));
console.error(`\nCL driver done: ${log.filter(l => l.status === 'ok').length} ok, ${log.filter(l => l.status === 'fail').length} fail -> ${OUT}`);
