#!/usr/bin/env node
/**
 * cv/reprocess-all-qa.mjs
 *
 * Re-run cv-qa on all Stage-3 rows with the updated DACH-aware standards.
 *
 * For rows WITH a CL markdown on disk:
 *   - Runs cv-qa.mjs (fit_notes + match summary as JD proxy)
 *   - Re-uploads patched/regenerated CLs to Notion
 *
 * For rows WITHOUT a CL markdown on disk:
 *   - Re-runs cover-letters/generate.js to regenerate from the job URL
 *   - Runs cv-qa → uploads to Notion
 *
 * Usage:
 *   node cv/reprocess-all-qa.mjs
 *   node cv/reprocess-all-qa.mjs --dry-run          # plan only, no writes
 *   node cv/reprocess-all-qa.mjs --limit 5          # first N rows only
 *   node cv/reprocess-all-qa.mjs --skip-generate    # skip rows missing CL .md
 *   node cv/reprocess-all-qa.mjs --max-regen 0      # QA only, no regen
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// ── Arg parsing ──────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);
const flag = (n) => ARGV.includes(n);
const arg = (n) => { const i = ARGV.indexOf(n); return i >= 0 ? ARGV[i + 1] : null; };

const DRY_RUN       = flag('--dry-run');
const SKIP_GENERATE = flag('--skip-generate');
const SKIP_DONE     = flag('--skip-done');   // skip rows that already have a valid QA verdict today
const MAX_ROWS      = arg('--limit') ? parseInt(arg('--limit'), 10) : Infinity;
const MAX_REGEN     = arg('--max-regen') ?? '2';
const TODAY         = new Date().toISOString().slice(0, 10);

const TMP_DIR = join(ROOT, 'data', '.routine-tmp', 'reprocess');
if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

const NOTION_TOKEN = process.env.NOTION_TOKEN
  || (() => { try { return require('child_process').execSync('echo %NOTION_TOKEN%', { encoding: 'utf8' }).trim(); } catch { return ''; } })();

// ── Utilities ────────────────────────────────────────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function log(...args) { console.log(...args); }

function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 300000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, NOTION_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    ...opts,
  });
}

// ── Path finders ─────────────────────────────────────────────────────────────

function findCvHtml(appId) {
  const num = (appId || '').replace(/APP-?/i, '');
  const draftsDir = join(ROOT, 'output', 'cv-drafts');
  if (!existsSync(draftsDir)) return null;

  const dirs = readdirSync(draftsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && (d.name.startsWith(num + '-') || d.name === num))
    .map(d => d.name);

  for (const dir of dirs) {
    const dirPath = join(draftsDir, dir);
    const files = readdirSync(dirPath).filter(f => f.endsWith('.html'));
    if (files.length === 0) continue;
    // Prefer English; prefer AE/DS/DE/DA variants over master
    const preferred = files.find(f => f.includes('_en')) || files[0];
    return join(dirPath, preferred);
  }
  return null;
}

function findClMarkdown(appId) {
  const num = (appId || '').replace(/APP-?/i, '');
  const clDir = join(ROOT, 'output', 'cover-letters');
  if (!existsSync(clDir)) return null;

  const files = readdirSync(clDir)
    .filter(f => f.endsWith('.md') && f.startsWith(num + '-'));

  if (files.length === 0) return null;
  // Most recent first (sort desc by name — date is embedded)
  files.sort((a, b) => b.localeCompare(a));
  return join(clDir, files[0]);
}

// ── JD proxy builder ─────────────────────────────────────────────────────────

function buildJdProxy(row) {
  const parts = [];

  // Company + role header so cv-qa can do role classification
  parts.push(
    `## Role Information\nCompany: ${row.title || ''}\n` +
    `Role: ${(row.position || []).join(', ')}\n` +
    `Country: ${row.country || ''}\n` +
    `Language: ${row.language || 'EN'}`
  );

  if (row.fit_notes && row.fit_notes.trim()) {
    parts.push('## Match Analysis (from auto-eval)\n' + row.fit_notes.trim());
  }

  // Pull match summary from brief/matches cache
  const num = (row.application_id || '').replace(/APP-?/i, '');
  const matchesDir = join(ROOT, 'scripts', 'cover-letters', 'matches');
  if (existsSync(matchesDir)) {
    const matchFile = readdirSync(matchesDir).find(f => f.startsWith(num + '-'));
    if (matchFile) {
      try {
        const m = JSON.parse(readFileSync(join(matchesDir, matchFile), 'utf8'));
        if (m.match_summary) parts.push('## Role Match Summary\n' + m.match_summary);
        if (m.company_facts_to_reference?.length) {
          parts.push('## Company Facts\n' + m.company_facts_to_reference.slice(0, 5).join('\n'));
        }
      } catch {}
    }
  }

  // Pull brief facts from cover-letters/briefs/ cache
  const briefsDir = join(ROOT, 'scripts', 'cover-letters', 'briefs');
  if (existsSync(briefsDir)) {
    const briefFile = readdirSync(briefsDir).find(f => f.startsWith(num + '-'));
    if (briefFile) {
      try {
        const b = JSON.parse(readFileSync(join(briefsDir, briefFile), 'utf8'));
        if (b.facts?.length) {
          parts.push('## Key JD Facts\n' + b.facts.slice(0, 8).map(f => `- ${f}`).join('\n'));
        }
        if (b.job_title) parts.push(`## JD Title\n${b.job_title}`);
      } catch {}
    }
  }

  return parts.join('\n\n');
}

// ── Role helpers ─────────────────────────────────────────────────────────────

function getRoleTitle(row) {
  // Try brief's job_title first
  const num = (row.application_id || '').replace(/APP-?/i, '');
  const briefsDir = join(ROOT, 'scripts', 'cover-letters', 'briefs');
  if (existsSync(briefsDir)) {
    const briefFile = readdirSync(briefsDir).find(f => f.startsWith(num + '-'));
    if (briefFile) {
      try {
        const b = JSON.parse(readFileSync(join(briefsDir, briefFile), 'utf8'));
        if (b.job_title) return b.job_title;
      } catch {}
    }
  }
  return (row.position || [])[0] || 'Data Professional';
}

function isDACH(row) {
  const country = (row.country || '').toLowerCase();
  const language = (row.language || '').toLowerCase();
  return (
    ['de', 'at', 'ch', 'germany', 'austria', 'switzerland', 'deutschland'].some(c => country.includes(c)) ||
    language.includes('german') || language === 'de'
  );
}

// eFinancialCareers "Undisclosed" rows hide the employer behind the portal, and
// generate.js can no longer scrape the live JD reliably (returns ~1 fact → weak,
// CRITICAL_FAIL cover letters). These are flagged for human-in-the-loop manual CL
// drafting instead of auto-generation. The real employer is often recoverable from
// the row's fit_notes (auto-eval employer-fix). CV regeneration is unaffected.
function isEfcUndisclosed(row) {
  const portal = (row.source_portal || '').toLowerCase();
  const title  = (row.title || '').toLowerCase();
  return portal.includes('efinancialcareers') && title.includes('undisclosed');
}

// ── Core: regenerate CL via generate.js ──────────────────────────────────────

function regenerateCl(row) {
  if (!row.job_url) { log('  [generate] no job_url — cannot regenerate'); return null; }

  // generate.js uses the --app-id verbatim as the output filename prefix, while
  // findClMarkdown / buildJdProxy look up files by the BARE number. Strip the
  // "APP-" prefix so the produced "{num}-{slug}-{date}.md" is found downstream.
  const appIdBare = String(row.application_id || 'one-off').replace(/^APP-?/i, '');

  log(`  [generate] re-running generate.js for ${row.application_id}...`);

  const positions = (row.position || []).join(' ').toLowerCase();
  let roleHint = 'ae';
  if (positions.includes('data scientist') || positions.includes('ml ') || positions.includes('machine learning')) roleHint = 'ds';
  else if (positions.includes('data engineer')) roleHint = 'de';
  else if (positions.includes('data analyst') || positions.includes('bi analyst')) roleHint = 'da';
  else if (positions.includes('analytics engineer')) roleHint = 'ae';

  const result = run('node', [
    'scripts/cover-letters/generate.js',
    '--job-url', row.job_url,
    '--app-id', appIdBare,
    '--company', row.title || '',
    '--country', row.country || '',
    '--today', TODAY,
    '--no-upload',   // skip Notion upload — reprocess-all-qa uploads after cv-qa pass
    '--keep-md',     // keep .md so cv-qa can evaluate it before we render+upload
  ], { timeout: 120000 });

  if (result.status !== 0) {
    log(`  [generate] FAILED (exit ${result.status}): ${(result.stderr || '').slice(0, 200)}`);
    return null;
  }

  const clPath = findClMarkdown(row.application_id);
  if (!clPath) { log('  [generate] generated but CL markdown not found on disk'); return null; }
  log(`  [generate] OK → ${clPath}`);
  return clPath;
}

// ── Core: run cv-qa ───────────────────────────────────────────────────────────

// STATUS_STACK_BUFFER_OVERRUN (0xC0000409) — Windows security guard intermittently
// kills Node.js subprocesses during startup before any output is written.
// This is a false positive; retrying after a short pause usually succeeds.
const WIN_CRASH_CODE = 3221226505;
const CRASH_MAX_RETRIES = 2;
const CRASH_RETRY_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runCvQa(cvPath, clPath, jdProxy, company, roleTitle) {
  const cvqaArgs = [
    'scripts/cv/cv-qa.mjs',
    '--cv', cvPath,
    '--cl', clPath,
    '--jd', jdProxy,
    '--company', company || '',
    '--role-title', roleTitle || '',
    '--max-regen', MAX_REGEN,
    '--json',
  ];
  if (DRY_RUN) cvqaArgs.push('--dry-run');

  let result;
  let attempt = 0;

  while (true) {
    attempt++;
    result = run('node', cvqaArgs, { timeout: 360000, killSignal: 'SIGKILL' });

    // Detect Windows subprocess crash: crash code + empty stdout = startup kill, not a verdict.
    const isCrash = result.status === WIN_CRASH_CODE && !(result.stdout || '').trim();
    if (!isCrash || attempt > CRASH_MAX_RETRIES) break;

    log(`  [cv-qa] Windows crash detected (attempt ${attempt}/${CRASH_MAX_RETRIES}) — retrying in ${CRASH_RETRY_MS / 1000}s...`);
    await sleep(CRASH_RETRY_MS);
  }

  let parsed = null;
  try { parsed = JSON.parse(result.stdout || '{}'); } catch {}

  const normalExit = result.status != null && result.status <= 127 ? result.status : null;

  return { exitCode: normalExit, rawExitCode: result.status, parsed, stderr: result.stderr, error: result.error };
}

// ── Core: render CL to PDF ───────────────────────────────────────────────────

function renderClPdf(clMdPath) {
  const pdfPath = clMdPath.replace(/\.de\.md$/, '.de.pdf').replace(/\.md$/, '.pdf');
  if (DRY_RUN) { log(`  [dry-run] would render ${clMdPath} → ${pdfPath}`); return pdfPath; }

  const result = run('node', [
    'scripts/cover-letters/lib/md-to-pdf.mjs',
    '--in', clMdPath,
    '--out', pdfPath,
  ], { timeout: 60000 });

  if (result.status !== 0) {
    log(`  [render] FAILED: ${(result.stderr || '').slice(0, 200)}`);
    return null;
  }
  return pdfPath;
}

// ── Core: upload to Notion ───────────────────────────────────────────────────

// Upload with retry — Notion rate-limits when many uploads fire in quick
// succession (a whole batch failed transiently on 2026-06-18). Retry with
// linear backoff so a momentary 429/5xx doesn't leave the row's CL stale.
async function notionUpload(filePath, pageId, property) {
  if (DRY_RUN) { log(`  [dry-run] would upload ${filePath} → ${property}`); return true; }

  const UPLOAD_RETRIES = 3;
  for (let attempt = 1; attempt <= UPLOAD_RETRIES; attempt++) {
    const result = run('node', [
      'scripts/notion/notion-upload-file.mjs',
      '--file', filePath,
      '--page', pageId,
      '--property', property,
      '--json',
    ], { timeout: 60000 });

    if (result.status === 0) return true;
    if (attempt < UPLOAD_RETRIES) {
      log(`  [upload] attempt ${attempt}/${UPLOAD_RETRIES} failed — retrying in ${attempt * 2}s (Notion rate-limit?)...`);
      await sleep(attempt * 2000);
    }
  }
  return false;
}

// ── Process one row ───────────────────────────────────────────────────────────

async function processRow(row) {
  const company = row.title || '';
  const appId   = row.application_id || '?';
  const pageId  = row.id;
  const dach    = isDACH(row);

  log(`\n→ ${appId} | ${company} | ${row.country || '?'} | ${dach ? 'DACH' : 'EN'} | ${(row.position || []).join('/')}`);

  // 1. Find CV HTML
  const cvPath = findCvHtml(appId);
  if (!cvPath) { log('  [skip] CV HTML not found on disk'); return { status: 'SKIP_NO_CV', id: appId }; }
  log(`  CV: ${cvPath.replace(ROOT, '').replace(/\\/g, '/')}`);

  // 2. eFC-undisclosed rows can't be auto-drafted (live JD unscrapable, employer
  // hidden) — the system never touches their CL. Flag for human-in-the-loop manual
  // drafting regardless of any weak auto-gen CL already on disk. CV stays as-is.
  if (isEfcUndisclosed(row)) {
    log('  [flag-manual] eFC-undisclosed — CL needs manual draft, skipping all CL auto-handling');
    return { status: 'FLAG_MANUAL_EFC', id: appId, company };
  }

  // 3. Find or regenerate CL markdown
  let clPath = findClMarkdown(appId);
  let clGenerated = false;

  if (!clPath) {
    if (SKIP_GENERATE) {
      log('  [skip] CL markdown not on disk and --skip-generate set');
      return { status: 'SKIP_NO_CL', id: appId };
    }
    clPath = regenerateCl(row);
    if (!clPath) return { status: 'SKIP_CL_REGEN_FAILED', id: appId };
    clGenerated = true;
  } else {
    log(`  CL: ${clPath.replace(ROOT, '').replace(/\\/g, '/')}`);
  }

  // 2b. Skip if already QA'd today with a real verdict
  if (SKIP_DONE) {
    const qaFile = join(TMP_DIR, `${appId}-${TODAY}.json`);
    if (existsSync(qaFile)) {
      try {
        const prior = JSON.parse(readFileSync(qaFile, 'utf8'));
        const priorVerdict = prior?.overall_verdict;
        if (priorVerdict && priorVerdict !== '?') {
          log(`  [skip-done] already QA'd today (verdict=${priorVerdict})`);
          return { status: 'SKIP_DONE', id: appId, verdict: priorVerdict, skipped: true };
        }
      } catch {}
    }
  }

  // 3. Build JD proxy + role info
  const jdProxy   = buildJdProxy(row);
  const roleTitle = getRoleTitle(row);
  log(`  [cv-qa] role="${roleTitle}" | JD proxy ${jdProxy.length} chars`);

  // 4. Run cv-qa
  log(`  [cv-qa] running (max-regen=${MAX_REGEN})...`);
  const qa = await runCvQa(cvPath, clPath, jdProxy, company, roleTitle);

  if (qa.error) {
    log(`  [cv-qa] PROCESS ERROR: ${qa.error.message}`);
    return { status: 'QA_ERROR', id: appId };
  }

  const verdict = qa.parsed?.overall_verdict || '?';
  const clVerdict = qa.parsed?.cover_letter_verdict || '?';
  const market = qa.parsed?.letter_context?.market || (dach ? 'dach' : 'global');
  log(`  [cv-qa] exit=${qa.rawExitCode} | verdict=${verdict} | CL=${clVerdict} | market=${market}`);

  // Save QA JSON for audit
  const qaFile = join(TMP_DIR, `${appId}-${TODAY}.json`);
  try { writeFileSync(qaFile, JSON.stringify({ ...qa.parsed, _appId: appId, _rawExit: qa.rawExitCode }, null, 2)); } catch {}

  // 5. Upload if CL was modified or freshly generated
  // Use JSON verdict (not exit code) — Windows can mangle exit codes via security interceptors.
  // PASS = no changes; PATCH_AND_PASS / REGENERATE = CL was modified or regen'd → upload.
  const clChanged = verdict !== 'PASS' && verdict !== '?';
  const needsUpload = clGenerated || clChanged;

  if (needsUpload) {
    log(`  [render] rendering CL PDF...`);
    const pdfPath = renderClPdf(clPath);
    if (!pdfPath) return { status: 'RENDER_FAILED', id: appId, verdict };

    log(`  [upload] uploading CL to Notion "Cover Letter"...`);
    const ok = await notionUpload(pdfPath, pageId, 'Cover Letter');
    log(`  [upload] ${ok ? 'OK' : 'FAILED'}`);
    if (!ok) return { status: 'UPLOAD_FAILED', id: appId, verdict };
  } else {
    log(`  [skip-upload] verdict=${verdict} — no upload needed`);
  }

  const statusByVerdict = { PASS: 'QA_PASS', PATCH_AND_PASS: 'QA_PATCHED', REGENERATE: 'QA_REGEN_NEEDED' };
  return {
    status: statusByVerdict[verdict] || `QA_VERDICT_${verdict}`,
    id: appId,
    dach,
    cl_generated: clGenerated,
    uploaded: needsUpload,
    verdict,
    cl_verdict: clVerdict,
    market,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`\n=== reprocess-all-qa START (${TODAY}) ===`);
  log(`DRY_RUN=${DRY_RUN} | MAX_ROWS=${MAX_ROWS} | MAX_REGEN=${MAX_REGEN} | SKIP_GENERATE=${SKIP_GENERATE}`);

  if (!NOTION_TOKEN) { console.error('NOTION_TOKEN not set'); process.exit(5); }

  log('\nQuerying Stage-3 rows from Notion...');
  const qResult = run('node', ['scripts/notion/notion-query.mjs', '--stage', '3. Drafted', '--json'], { timeout: 30000 });
  if (qResult.status !== 0) { console.error('Notion query failed'); process.exit(1); }

  let rows;
  try { rows = JSON.parse(qResult.stdout); }
  catch (e) { console.error('Failed to parse Notion rows:', e.message); process.exit(1); }

  log(`Found ${rows.length} Stage-3 rows`);
  const toProcess = MAX_ROWS < Infinity ? rows.slice(0, MAX_ROWS) : rows;
  log(`Processing ${toProcess.length} rows`);

  const counts = { QA_PASS: 0, QA_PATCHED: 0, QA_REGEN_NEEDED: 0, SKIP: 0, FLAG_MANUAL: 0, ERROR: 0, CL_GENERATED: 0, UPLOADED: 0 };
  const failed = [];
  const flaggedManual = [];

  for (const row of toProcess) {
    try {
      const r = await processRow(row);
      if (r.status === 'QA_PASS') counts.QA_PASS++;
      else if (r.status === 'QA_PATCHED') counts.QA_PATCHED++;
      else if (r.status === 'QA_REGEN_NEEDED') counts.QA_REGEN_NEEDED++;
      else if (r.status === 'FLAG_MANUAL_EFC') { counts.FLAG_MANUAL++; flaggedManual.push(`${r.id}: ${r.company || ''}`); }
      else if (r.status.startsWith('SKIP')) counts.SKIP++;
      else { counts.ERROR++; failed.push(`${r.id}: ${r.status}`); }
      if (r.cl_generated) counts.CL_GENERATED++;
      if (r.uploaded) counts.UPLOADED++;
    } catch (e) {
      counts.ERROR++;
      const appId = row.application_id || '?';
      failed.push(`${appId}: EXCEPTION ${e.message}`);
      log(`  [error] ${e.message}`);
    }
  }

  log('\n=== SUMMARY ===');
  log(`Total processed : ${toProcess.length}`);
  log(`QA_PASS         : ${counts.QA_PASS}`);
  log(`QA_PATCHED      : ${counts.QA_PATCHED}`);
  log(`QA_REGEN_NEEDED : ${counts.QA_REGEN_NEEDED}`);
  log(`CL_GENERATED    : ${counts.CL_GENERATED} (from job URL re-scrape)`);
  log(`UPLOADED        : ${counts.UPLOADED} (CLs updated in Notion)`);
  log(`SKIP            : ${counts.SKIP}`);
  log(`FLAG_MANUAL     : ${counts.FLAG_MANUAL} (eFC-undisclosed — draft CL by hand)`);
  log(`ERROR           : ${counts.ERROR}`);
  if (flaggedManual.length) {
    log('\nManual-CL rows (eFC-undisclosed):');
    flaggedManual.forEach(f => log('  ' + f));
    try {
      const manualFile = join(TMP_DIR, `flagged-manual-efc-${TODAY}.txt`);
      writeFileSync(manualFile, flaggedManual.join('\n') + '\n');
      log(`\n[flag-manual] list written → ${manualFile}`);
    } catch {}
  }
  if (failed.length) { log('\nFailed rows:'); failed.forEach(f => log('  ' + f)); }
  log('=== END ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
