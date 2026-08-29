#!/usr/bin/env node
/**
 * _rerender_stage3_backlog.mjs — one-shot backfill: re-render + re-upload the
 * Stage 3+ CVs that shipped with a banned or superseded phrase, now that the
 * `cv/market-tail.cjs` assertNoBannedContent guard rejects it.
 *
 * Reads a snapshot file (default: `data/.routine-tmp/rerender-backlog.json`),
 * pinned upstream so a reshuffled Notion state cannot silently retarget. For
 * each row:
 *   1. Find output/cv-drafts/{num}-… (existing dir; skip if missing)
 *   2. Read variant + lang from cv_<v>_<l>.html filename
 *   3. Infer dach_format from country
 *   4. Delete stale HTML + PDF from the dir to force clean regeneration
 *   5. Run scripts/cv/build-cvs.js WITHOUT --jd-file / --tailor-keywords
 *      → LLM enrichment is skipped; the ARCHETYPE_PROFILES template fires;
 *        the template does not contain the banned phrase
 *   6. Render PDF via scripts/cv/html-to-pdf.mjs to the same filename
 *   7. Grep the fresh HTML for --banned-re (belt + braces)
 *   8. Upload to Notion Resume as REPLACE (not append)
 *
 * Snapshot row shape (JSON array of):
 *   { app: 'APP-1234', page: '<notion-page-id>', title: 'Acme', country: 'Germany' }
 *
 * Cost: zero LLM calls (jd_file omitted → enrichment path returns null →
 * template used). Only cost is PDF rendering + Notion upload per row.
 *
 * Usage:
 *   node batch/_rerender_stage3_backlog.mjs --dry-run
 *   node batch/_rerender_stage3_backlog.mjs --snapshot data/.routine-tmp/rerender-backlog.json
 *   node batch/_rerender_stage3_backlog.mjs --limit 3 --banned-re 'some\s+banned\s+phrase'
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LIMIT = args.includes('--limit') ? parseInt(argOf('--limit'), 10) : 0;
const ROOT = path.resolve(__dirname, '..');
const CV_ROOT = path.join(ROOT, 'output', 'cv-drafts');
const PHOTO = path.join(ROOT, 'assets', 'candidate-photo.jpg');
const SNAPSHOT = argOf('--snapshot') || path.join(ROOT, 'data', '.routine-tmp', 'rerender-backlog.json');
const BANNED_SRC = argOf('--banned-re');
// codeql[js/regex-injection]
// Justification: --banned-re is DOCUMENTED (see header) as accepting a raw regex
// pattern from the invoking user, precisely so the backfill can match phrase
// variants the guard now rejects. Escaping it would defeat the flag's purpose.
// The only "attacker" is the CLI invoker themselves — a personal ops script
// with no remote input path. Malformed patterns are caught below so a syntax
// error surfaces as a normal ROUTINE_ABORT rather than an unhandled throw.
let BANNED = null;
if (BANNED_SRC) {
  try { BANNED = new RegExp(BANNED_SRC, 'i'); }
  catch (e) { console.error(`ROUTINE_ABORT: --banned-re is not a valid regex: ${e.message}`); process.exit(6); }
}
const BUILD_CVS = path.join(ROOT, 'scripts', 'cv', 'build-cvs.js');
const HTML_TO_PDF = path.join(ROOT, 'scripts', 'cv', 'html-to-pdf.mjs');
const NOTION_UPLOAD = path.join(ROOT, 'scripts', 'notion', 'notion-upload-file.mjs');

if (!process.env.NOTION_TOKEN && !DRY) {
  console.error('ROUTINE_ABORT: NOTION_TOKEN unset');
  process.exit(5);
}
if (!fs.existsSync(SNAPSHOT)) {
  console.error(`snapshot missing: ${SNAPSHOT}`);
  process.exit(2);
}
const rows = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const targets = LIMIT ? rows.slice(0, LIMIT) : rows;
console.error(`re-render backlog: ${targets.length}/${rows.length} rows${DRY ? ' (DRY-RUN)' : ''}${BANNED ? ` banned=/${BANNED.source}/i` : ''}`);

// Rows can have TWO drafts dirs from a naming-convention drift: both
// `{num}-slug` (current auto-draft style) and `APP-{num}-slug` (older style).
// Cleaning only one per row leaves zombie duplicates with the banned phrase
// intact. Return every match so the caller re-renders both — the extra work
// is a one-shot cost and the alternative (guessing which is 'live') is
// fragile.
function findDirs(num) {
  const n = String(num).replace(/^APP-?/i, '').split('-')[0];
  const out = [];
  if (!fs.existsSync(CV_ROOT)) return out;
  for (const d of fs.readdirSync(CV_ROOT)) {
    if (d.startsWith(`${n}-`) || d.toUpperCase().startsWith(`APP-${n}-`)) {
      const p = path.join(CV_ROOT, d);
      if (fs.statSync(p).isDirectory()) out.push(p);
    }
  }
  return out;
}

const RESULTS = { ok: 0, no_dir: 0, no_html: 0, build_failed: 0, phrase_still_present: 0, pdf_failed: 0, upload_failed: 0 };
const LOG = [];

for (const row of targets) {
  const dirs = findDirs(row.app);
  if (!dirs.length) { RESULTS.no_dir++; LOG.push({ app: row.app, status: 'no_dir' }); continue; }
  // Prefer the un-prefixed style (current auto-draft convention); the
  // APP-prefixed dir is a zombie.
  const dir = dirs.find((d) => !/[/\\]APP-/i.test(d)) || dirs[0];
  const zombies = dirs.filter((d) => d !== dir);
  // Existing HTML: cv_<variant>_<lang>.html
  const htmlFile = fs.readdirSync(dir).find(f => /^cv_[a-z]+_[a-z]+\.html$/i.test(f));
  if (!htmlFile) { RESULTS.no_html++; LOG.push({ app: row.app, dir: path.basename(dir), status: 'no_html' }); continue; }
  const [, variant, lang] = htmlFile.match(/^cv_([a-z]+)_([a-z]+)\.html$/i);
  // DACH format from COUNTRY, not from headshot presence: a stale headshot
  // file from a prior build can linger on a non-DACH row.
  const isDachCountry = /^(germany|deutschland|de|austria|österreich|oesterreich|at|switzerland|schweiz|ch)$/i.test(String(row.country || ''));
  const dachFormat = lang === 'de' || isDachCountry;
  const pdfFile = fs.readdirSync(dir).find(f => /-CV-.*\.pdf$/i.test(f));
  const pdfPath = pdfFile
    ? path.join(dir, pdfFile)
    : path.join(dir, `Candidate-CV-${(row.title || 'employer').replace(/[^A-Za-z0-9]+/g, '-')}.pdf`);
  const htmlPath = path.join(dir, htmlFile);

  const summary = `${row.app.padEnd(9)} ${variant}/${lang}${dachFormat ? '+dach' : ''} ${(row.country || '').padEnd(11)} ${path.basename(dir)}`;

  if (DRY) { console.log('  PLAN  ' + summary); LOG.push({ app: row.app, dir: path.basename(dir), variant, lang, dach: dachFormat, status: 'planned' }); continue; }

  try {
    // 1. Strip stale artefacts so a build failure cannot leave old files behind.
    for (const stale of fs.readdirSync(dir)) {
      if (/^cv_[a-z]+_[a-z]+\.html$/i.test(stale)) fs.unlinkSync(path.join(dir, stale));
    }
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);

    // 2. Build. No --jd-file / --tailor-keywords → template path, no LLM call.
    const cvArgs = [BUILD_CVS, '--variant', variant, '--lang', lang, '--out', dir];
    if (row.country) cvArgs.push('--country', row.country);
    if (dachFormat) cvArgs.push('--dach-format');
    execFileSync('node', cvArgs, { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
    const freshHtml = path.join(dir, htmlFile);
    if (!fs.existsSync(freshHtml) || fs.statSync(freshHtml).size < 8000) throw new Error('html missing/short');

    // 3. Belt-and-braces: banned phrase absent? The market-tail guard should
    //    have already thrown during build, so this is a redundancy check.
    if (BANNED) {
      const freshText = fs.readFileSync(freshHtml, 'utf8');
      if (BANNED.test(freshText)) {
        RESULTS.phrase_still_present++;
        LOG.push({ app: row.app, dir: path.basename(dir), status: 'phrase_still_present' });
        continue;
      }
    }

    // 4. Photo copy for DACH/DE renders.
    if (dachFormat && fs.existsSync(PHOTO)) fs.copyFileSync(PHOTO, path.join(dir, path.basename(PHOTO)));

    // 5. PDF.
    execFileSync('node', [HTML_TO_PDF, '--in', freshHtml, '--out', pdfPath], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 90000 });
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 10000) throw new Error('pdf missing/short');

    // 6. Upload as REPLACE (default) to Notion Resume.
    const up = spawnSync('node', [NOTION_UPLOAD, '--file', pdfPath, '--page', row.page, '--property', 'Resume', '--name', path.basename(pdfPath), '--json'],
      { cwd: ROOT, encoding: 'utf8', timeout: 90000 });
    if (up.status !== 0) throw new Error(`upload exit ${up.status}: ${(up.stderr || up.stdout).slice(0, 120)}`);

    // Zombie duplicate dirs: cheaper to remove than to keep two copies of the
    // same CV forever, and it takes the phrase off disk in one shot.
    for (const z of zombies) fs.rmSync(z, { recursive: true, force: true });
    RESULTS.ok++;
    LOG.push({ app: row.app, dir: path.basename(dir), zombies_removed: zombies.length, variant, lang, dach: dachFormat, status: 'ok', pdf_bytes: fs.statSync(pdfPath).size });
    console.log('  ok   ' + summary + (zombies.length ? ` [-${zombies.length} zombie]` : ''));
  } catch (e) {
    const msg = String(e.message || e).slice(0, 160);
    if (msg.startsWith('upload')) RESULTS.upload_failed++;
    else if (/pdf/i.test(msg)) RESULTS.pdf_failed++;
    else RESULTS.build_failed++;
    LOG.push({ app: row.app, dir: path.basename(dir), variant, lang, dach: dachFormat, status: 'fail', error: msg });
    console.log('  FAIL ' + summary + ' — ' + msg);
  }
}

const logPath = path.join(ROOT, 'data', '.routine-tmp', `rerender-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.writeFileSync(logPath, JSON.stringify({ results: RESULTS, rows: LOG }, null, 2));
console.log(`\nresults: ${JSON.stringify(RESULTS)}`);
console.log(`log:     ${logPath}`);
process.exit(RESULTS.ok === targets.length ? 0 : 1);
