#!/usr/bin/env node
// scripts/cover-letters/generate.js — orchestrator for the 3-stage redesign.
//
// Usage:
//   node scripts/cover-letters/generate.js --job-url <URL> [--company-url <URL>] \
//        [--role-hint ae|ds|de|da|me] [--app-id <id>] [--company <name>] \
//        [--country <name>] [--city <name>] [--today YYYY-MM-DD] \
//        [--jd-file <path>]         # caller-supplied JD text (avoids re-fetch)
//        [--no-qa]                  # skip cv-qa LLM gate
//        [--no-gates | --strict-gates]   # readability gates: silent report / block
//
//   # Bulk mode (re-generate all historical letters from Notion):
//   node scripts/cover-letters/generate.js --regen-historical --date YYYY-MM-DD
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { research } = require('./lib/research');
const { match } = require('./lib/match');
const { compose: composeV2 } = require('./lib/draft-v2');
const { route } = require('./lib/router');
const { composeForm } = require('./lib/form-drafter');
const { isPortalHost } = require('./lib/portal-hosts');
const { runLetterGates } = require('./lib/letter-gates');

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const KEEP_MD = has('--keep-md'); // skip .md deletion so caller can run cv-qa before uploading
const NO_QA = has('--no-qa');     // skip the deterministic cv-qa LLM gate (e.g. bulk regen / offline)
// Readability gates default to REPORT, not block: a flagged letter still ships
// because a row with a mediocre letter beats a row with none, and nothing
// auto-submits — every draft stops at Stage 3 for human review.
// --strict-gates makes them blocking for the cases where you would rather have
// no letter than a bad one.
const STRICT_GATES = has('--strict-gates');
const NO_GATES = has('--no-gates');

const ROOT = path.resolve(__dirname, '..', '..');
const CV_MASTER = path.join(ROOT, 'scripts', 'cv', 'cv_master.json');
const BRIEFS_DIR = path.join(__dirname, 'briefs');
const MATCHES_DIR = path.join(__dirname, 'matches');
const OUT_DIR = path.join(ROOT, 'output', 'cover-letters');
const FORM_OUT_DIR = path.join(ROOT, 'output', 'form-answers');

for (const d of [BRIEFS_DIR, MATCHES_DIR, OUT_DIR, FORM_OUT_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function loadCvMaster() {
  if (!fs.existsSync(CV_MASTER)) {
    console.error('cv_master.json not found. Run: node scripts/cv/generate-pdf-tailored.mjs --export-json to generate it.');
    process.exit(5);
  }
  return JSON.parse(fs.readFileSync(CV_MASTER, 'utf8'));
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function renderAndUpload(mdPath, pageId, notionProperty) {
  if (!pageId) return { rendered: false, uploaded: false, reason: 'no_page_id' };
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');
  const tmpHtml = mdPath.replace(/\.md$/, '.tmp.html');
  try {
    execFileSync(process.execPath, ['scripts/cover-letters/lib/md-to-pdf.mjs', '--in', mdPath, '--out', pdfPath], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000,
    });
  } catch (e) {
    console.error(`    ✗ render failed: ${String(e.message || e).slice(0, 100)}`);
    return { rendered: false, uploaded: false, reason: 'render_failed' };
  }
  try {
    execFileSync(process.execPath, ['scripts/notion/notion-upload-file.mjs', '--file', pdfPath, '--page', pageId, '--property', notionProperty], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 10 * 1024 * 1024,
    });
    if (!KEEP_MD) { try { fs.unlinkSync(mdPath); } catch {} }
    try { fs.unlinkSync(tmpHtml); } catch {}
    return { rendered: true, uploaded: true, pdfPath };
  } catch (e) {
    console.error(`    ✗ upload failed: ${String(e.message || e).slice(0, 100)}`);
    return { rendered: true, uploaded: false, pdfPath, reason: 'upload_failed' };
  }
}

function renderOnly(mdPath) {
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');
  const tmpHtml = mdPath.replace(/\.md$/, '.tmp.html');
  try {
    execFileSync(process.execPath, ['scripts/cover-letters/lib/md-to-pdf.mjs', '--in', mdPath, '--out', pdfPath], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000,
    });
    if (!KEEP_MD) { try { fs.unlinkSync(mdPath); } catch {} }
    try { fs.unlinkSync(tmpHtml); } catch {}
    return { rendered: true, pdfPath };
  } catch (e) {
    return { rendered: false, reason: 'render_failed' };
  }
}

// Load the Notion database ID from config/profile.yml or NOTION_DATABASE_ID env var.
function loadNotionDbId() {
  if (process.env.NOTION_DATABASE_ID) return process.env.NOTION_DATABASE_ID;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8');
    const m = raw.match(/applications_db_id:\s*"?([a-f0-9-]+)"?/);
    if (m) return m[1];
  } catch {}
  return null;
}

async function lookupPageId(appId) {
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) return null;
  const m = String(appId).match(/(\d+)/);
  if (!m) return null;
  const NH = { Authorization: 'Bearer ' + NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const DB = loadNotionDbId();
  if (!DB) { console.error('  [lookup] No Notion database ID configured (set NOTION_DATABASE_ID or notion.applications_db_id in profile.yml)'); return null; }
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
      method: 'POST', headers: NH,
      body: JSON.stringify({ filter: { property: 'Application ID', unique_id: { equals: parseInt(m[1], 10) } } }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.results[0]?.id || null;
  } catch { return null; }
}

// Locate the CV HTML a CV driver wrote for this app under
// output/cv-drafts/{APPID}-{slug}/cv_{variant}_{lang}.html. Newest cv_*.html
// wins across every dir matching the app id, so a stale legacy dir cannot
// win over the current APP-prefixed one.
function findCvHtml(appId) {
  const base = path.join(ROOT, 'output', 'cv-drafts');
  if (!fs.existsSync(base)) return null;
  const num = String(appId || '').match(/(\d+)/)?.[1];
  const dirs = fs.readdirSync(base).filter(d =>
    d === appId || d.startsWith(appId + '-') || (num && (d.startsWith(`APP-${num}-`) || d.startsWith(`${num}-`))));
  let newest = null;
  for (const d of dirs) {
    const dir = path.join(base, d);
    try {
      for (const f of fs.readdirSync(dir).filter(f => /^cv_.*\.html$/.test(f))) {
        const p = path.join(dir, f);
        const mtime = fs.statSync(p).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { p, mtime };
      }
    } catch { /* ignore */ }
  }
  return newest ? newest.p : null;
}
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

// Deterministic LLM QA gate. Runs cv-qa over the CV + this cover letter
// before upload. cv-qa patches the CL markdown (and CV HTML) in place; the
// caller re-renders/re-uploads the CV if its HTML changed. Skips gracefully
// on --no-qa or a missing CV/JD; never blocks the row.
function runCvQaGate({ appId, company, letterPath, jdText, roleTitle, country, lang }) {
  if (NO_QA) return { ran: false };
  const cvHtml = findCvHtml(appId);
  if (!cvHtml) { console.error(`  [cv-qa] skipped — no CV HTML under output/cv-drafts for ${appId}`); return { ran: false }; }
  if (!String(jdText || '').trim()) { console.error(`  [cv-qa] skipped — no JD text for ${appId}`); return { ran: false }; }
  const before = md5(cvHtml);
  console.error(`  [cv-qa] evaluating CV + cover letter (LLM)...`);
  const qaArgs = ['scripts/cv/cv-qa.mjs', '--cv', cvHtml, '--cl', letterPath, '--jd', jdText,
    '--company', company || '', '--role-title', roleTitle || ''];
  if (country) qaArgs.push('--country', country);
  if (lang)    qaArgs.push('--lang', lang);
  const q = spawnSync(process.execPath, qaArgs,
    { cwd: ROOT, encoding: 'utf8', timeout: 6 * 60 * 1000, stdio: ['ignore', 'inherit', 'inherit'] });
  const tag = { 0: 'PASS', 2: 'AUTO_PATCHED', 3: 'REGENERATE_NEEDED' }[q.status] || `ERROR(exit ${q.status})`;
  console.error(`  [cv-qa] ${tag}`);
  const cvChanged = fs.existsSync(cvHtml) && md5(cvHtml) !== before;
  return { ran: true, status: q.status, cvHtml, cvChanged };
}

// Hiring-manager readability gates. Runs AFTER cv-qa so it judges the letter
// that will actually ship, not the pre-patch draft. See
// cover-letters/lib/letter-gates.js for the checks and thresholds.
//
// The verdict is appended to the letter's audit comment (which the renderer
// strips, so it never reaches the page) and echoed with a greppable
// LETTER_GATES marker for the routine logs. Non-blocking unless --strict-gates.
function runReadabilityGates({ appId, company, letterPath }) {
  if (NO_GATES) return { ran: false };
  let md;
  try { md = fs.readFileSync(letterPath, 'utf8'); }
  catch { console.error(`  [gates] skipped — cannot read ${letterPath}`); return { ran: false }; }

  const res = runLetterGates(md, { company });
  if (res.pass) {
    console.error(`  [gates] PASS (${res.metrics.distinctTech} tech terms, ${res.metrics.words} words)`);
  } else {
    console.error(`  [gates] LETTER_GATES_FAIL ${appId}: ${res.failures.map(f => f.code).join(', ')}`);
    for (const f of res.failures) console.error(`     ${f.code}: ${f.detail}`);
  }

  // Record the verdict inside the letter itself. A letter that shipped
  // flagged should say so on its face; otherwise the only trace is a log
  // nobody reads.
  try {
    const stamp = [
      ` letter_gates: ${res.pass ? 'PASS' : 'FAIL'}`,
      ...(res.pass ? [] : res.failures.map(f => `  - ${f.code}: ${f.detail}`)),
      ` letter_gates_metrics: ${JSON.stringify(res.metrics)}`,
    ].join('\n');
    fs.writeFileSync(letterPath, md.includes('<!--')
      ? md.replace(/-->\s*$/, `${stamp}\n-->\n`)
      : `${md}\n<!--\n${stamp}\n-->\n`);
  } catch (e) {
    console.error(`  [gates] could not stamp audit block: ${String(e.message).slice(0, 80)}`);
  }
  return { ran: true, pass: res.pass, failures: res.failures, metrics: res.metrics };
}

// Caller-supplied JD text (--jd-file). Returns '' when absent, unreadable, or
// too short to be a real posting — every caller treats '' as "no JD supplied".
function readJdFile(p) {
  if (!p) return '';
  try {
    const t = fs.readFileSync(p, 'utf8');
    if (t.trim().length > 200) return t;
    console.error(`  [jd] --jd-file too short (${t.trim().length} chars), ignoring`);
  } catch (e) { console.error(`  [jd] --jd-file unreadable: ${e.message}`); }
  return '';
}

async function generateOne({ jobUrl, companyUrl, roleHint, appId, company, country, city, today, usedAngles, pageId, uploadToNotion = true, seniority }) {
  const cvMaster = loadCvMaster();
  console.error(`[research] ${appId} ${company || ''} ${jobUrl}`);
  // Read --jd-file HERE, not further down: research() needs the JD to exist,
  // and its own Firecrawl pull goes through a localhost daemon that is
  // routinely down. Handing the caller's text in means a JD sitting on disk
  // is enough — before this, research() bailed with jd_fetch_failed and the
  // --jd-file read below was never reached.
  const suppliedJd = readJdFile(arg('--jd-file'));
  const brief = await research({
    jobUrl, companyUrl, roleHint, appId, companyHint: company, jdText: suppliedJd,
  });
  brief.fetched_at = (today || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z';
  if (brief.error) {
    console.error(`  ✗ ${brief.error}`);
    return null;
  }
  // Persist brief. An operator hand-sourcing a missing postal address into
  // the brief JSON would otherwise be silently discarded by a re-run:
  // research rebuilds the brief from scratch. Carry forward envelope fields
  // from an existing brief whenever this run failed to source them itself.
  const briefPath = path.join(BRIEFS_DIR, `${appId}-${slugify(company || brief.company || 'co')}.json`);
  // A prior brief flagged `company_address_manual` was verified by hand
  // against the employer's own Impressum or a statutory register, so it
  // OVERRIDES this run's research wholesale — otherwise a portal-derived
  // address (research finding the job board's own registered office) silently
  // wins over the correct one.
  const ENVELOPE_KEYS = ['company_address', 'company_postal_code', 'company_city',
                         'company_country', 'company_legal_form', 'company_address_source'];
  // A prior brief written BEFORE research.js learned to skip job-portal
  // imprints carries that portal's own registered office. research now
  // correctly declines to source it, which leaves the envelope empty — and
  // the carry-forward below would then restore the poisoned value, defeating
  // the guard. Shared portal-host list (cover-letters/lib/portal-hosts.js) —
  // same definition research.js uses for its Impressum/supplemental skips,
  // so the two guards can never drift apart.
  const inheritable = (prior) => !isPortalHost(String(prior.company_address_source || ''));
  if (fs.existsSync(briefPath)) {
    try {
      const prior = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
      if (!inheritable(prior)) {
        brief.fetch_failures = brief.fetch_failures || [];
        brief.fetch_failures.push(`prior-brief envelope discarded: address sourced from ${prior.company_address_source} (job portal, not the employer)`);
      } else if (prior.company_address_manual && prior.company_address) {
        for (const k of ENVELOPE_KEYS) if (prior[k]) brief[k] = prior[k];
        brief.company_address_manual = true;
      } else {
        for (const k of ENVELOPE_KEYS) if (!brief[k] && prior[k]) brief[k] = prior[k];
      }
    } catch { /* unreadable prior brief is not a reason to fail the run */ }
  }
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  // Match stage needs JD text — re-pull from cache for the markdown body
  let jdText = '';
  try {
    const { firecrawl } = require('./lib/research');
    const jd = firecrawl(jobUrl);
    jdText = jd?.markdown || '';
  } catch {}
  // --jd-file: JD text the CALLER already fetched. The firecrawl pull above
  // goes through the self-hosted localhost daemon, which is regularly down
  // and returns nothing; with no JD the matcher falls back to parsing the
  // job_url SLUG for a tech stack, which invents tools. Callers that already
  // have verified JD text (routines that write output/cv-drafts/<dir>/jd.txt,
  // for example) should hand it over. File wins over the daemon: it is
  // verified content, not a cache guess.
  if (suppliedJd) {
    jdText = suppliedJd;
    console.error(`  [jd] using --jd-file (${suppliedJd.length} chars)`);
  }
  // Drop slug-derived stack facts the real JD does not support. research()
  // marks these `source: job_url`; when we have verified JD text, any tool
  // named in such a fact but absent from the posting is a parse artefact,
  // not a fact.
  if (jdText.trim().length > 200 && Array.isArray(brief.facts)) {
    const before = brief.facts.length;
    brief.facts = brief.facts.filter(f => {
      if (f.source !== 'job_url' || f.category !== 'tech_stack') return true;
      const tools = String(f.fact).match(/[A-Za-z][A-Za-z0-9+#.]{1,}/g) || [];
      const named = tools.filter(t => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(jdText));
      // Keep only if every tool it claims actually appears in the posting.
      return named.length === tools.length;
    });
    if (brief.facts.length !== before) {
      console.error(`  [jd] dropped ${before - brief.facts.length} slug-derived stack fact(s) unsupported by the posting`);
      fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
    }
  }

  console.error(`  [match] ${brief.facts.length} facts, employer-angle scoring...`);
  const matchBrief = match({ brief, cvMaster, jdText, roleHint, country, appId, usedAngles, seniority });
  matchBrief.country = country; matchBrief.city = city;
  const matchPath = path.join(MATCHES_DIR, `${appId}-${slugify(company || brief.company || 'co')}.json`);
  fs.writeFileSync(matchPath, JSON.stringify(matchBrief, null, 2));

  // Stage 0: Route
  // --force-lang de|en overrides the auto-detected posting language. Use it
  // when a DACH employer (GmbH/AG) posts in English on LinkedIn but the
  // letter should be German anyway.
  const forceLang = arg('--force-lang');
  const routeBrief = route({
    appId, postingText: jdText, postingLang: forceLang || brief.posting_lang,
    country, jobUrl, brief,
  });
  console.error(`  [route] ${routeBrief.letter_form} (${routeBrief.market}/${routeBrief.letter_language}) gate=${routeBrief.german_language_gate} salary_req=${routeBrief.salary_required}`);
  matchBrief.salary_in_letter = routeBrief.salary_required;

  console.error(`  [draft] angle=${matchBrief.employer_angle}, facts=${matchBrief.company_facts_to_reference.length}, gap=${matchBrief.has_gap_to_disclose}`);
  const letter = composeV2({ brief, matchBrief, cvMaster, jobUrl, today, route: routeBrief });
  const letterName = `${appId}-${slugify(company || brief.company || 'co')}-${today || new Date().toISOString().slice(0, 10)}.md`;
  const letterPath = path.join(OUT_DIR, letterName);
  fs.writeFileSync(letterPath, letter);
  console.error(`  ✓ ${letterPath}`);

  // Stage 3-FA: form answers (YAML frontmatter + recruiter-facing body)
  // Inject jdText into brief so form drafter can derive JD-specific questions
  brief.jd_text = jdText;
  console.error(`  [form] composing form-answers...`);
  const formMd = composeForm({
    brief, matchBrief, cvMaster, jobUrl, today, country, city,
    applyUrl: jobUrl, applyChannel: 'web_form',
    briefPath: path.relative(ROOT, briefPath),
    matchPath: path.relative(ROOT, matchPath),
    seniority,
  });
  const formName = `${appId}-${slugify(company || brief.company || 'co')}-${today || new Date().toISOString().slice(0, 10)}-form.md`;
  const formPath = path.join(FORM_OUT_DIR, formName);
  fs.writeFileSync(formPath, formMd);
  console.error(`  ✓ ${formPath}`);

  // Deterministic LLM QA gate over the CV + cover letter (patches in place).
  // country + lang route the QA-side market classification through the same
  // cv/market-tail.cjs helper the build uses — one source of truth, no drift.
  const qa = runCvQaGate({
    appId, company: company || brief.company, letterPath, jdText,
    roleTitle: brief.job_title,
    country: country || brief.country || '',
    lang: routeBrief.letter_language || '',
  });

  // Readability gates run after cv-qa (which patches the letter in place),
  // so they judge exactly what is about to be rendered and uploaded.
  const gates = runReadabilityGates({
    appId, company: company || brief.company, letterPath,
  });

  let letterUpload = { rendered: false, uploaded: false, reason: 'disabled' };
  let formUpload = { rendered: false, uploaded: false, reason: 'disabled' };
  if (STRICT_GATES && gates.ran && !gates.pass) {
    // Deliberate: the .md is KEPT here regardless of --keep-md, because the
    // whole point of blocking is that someone fixes and re-ships it. Deleting
    // the source of a letter you just refused to send would be perverse.
    console.error(`  [gates] --strict-gates: upload BLOCKED for ${appId}. Letter kept at ${letterPath}`);
    letterUpload = { rendered: false, uploaded: false, reason: 'blocked_by_letter_gates', failures: gates.failures.map(f => f.code) };
  } else if (uploadToNotion) {
    if (!pageId) pageId = await lookupPageId(appId);
    if (pageId) {
      console.error(`  [upload] rendering letter PDF + uploading to Notion 'Cover Letter'...`);
      letterUpload = renderAndUpload(letterPath, pageId, 'Cover Letter');
      if (letterUpload.uploaded) console.error(`  ✓ Cover Letter uploaded to ${pageId.slice(0, 8)}…`);
      // If cv-qa patched the CV HTML, re-render the CV PDF and refresh the
      // Resume so the uploaded CV matches the QA-patched HTML.
      if (qa && qa.cvChanged) {
        try {
          const dir = path.dirname(qa.cvHtml);
          // SANITY GATE: never render/upload a CV that has lost its markup.
          // A cv-qa bug once wrote stripped plain text over the HTML and the
          // uploader faithfully shipped the unstyled result to Notion as the
          // Resume. cv-qa now guards its own write; this is the second line
          // of defence, because the upload is the irreversible step.
          const cvHtmlNow = fs.readFileSync(qa.cvHtml, 'utf8');
          const tagCount = (cvHtmlNow.match(/<[a-zA-Z][^>]*>/g) || []).length;
          if (tagCount < 20) {
            throw new Error(`CV HTML looks stripped (${tagCount} tags) — refusing to render/upload`);
          }
          const pdfName = fs.readdirSync(dir).find(f => /\.pdf$/i.test(f));
          const cvPdf = path.join(dir, pdfName || 'cv.pdf');
          execFileSync(process.execPath, ['scripts/cv/html-to-pdf.mjs', '--in', qa.cvHtml, '--out', cvPdf], {
            cwd: ROOT, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
          });
          execFileSync(process.execPath, ['scripts/notion/notion-upload-file.mjs', '--file', cvPdf, '--page', pageId, '--property', 'Resume'], {
            cwd: ROOT, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 10 * 1024 * 1024,
          });
          console.error(`  [cv-qa] CV HTML was patched → re-rendered CV PDF + refreshed Resume`);
        } catch (e) {
          console.error(`  [cv-qa] CV re-render/upload failed: ${String(e.message || e).slice(0, 100)}`);
        }
      }
      console.error(`  [upload] rendering form PDF + uploading to Notion 'Form answers'...`);
      formUpload = renderAndUpload(formPath, pageId, 'Form answers');
      if (formUpload.uploaded) console.error(`  ✓ Form answers uploaded to ${pageId.slice(0, 8)}…`);
    } else {
      console.error(`  [upload] skipped — no Notion pageId resolvable for ${appId}; rendering local PDFs only`);
      letterUpload = renderOnly(letterPath);
      formUpload = renderOnly(formPath);
    }
  } else {
    // --no-upload mode: still render PDFs locally and drop the .md
    letterUpload = renderOnly(letterPath);
    formUpload = renderOnly(formPath);
  }

  return { briefPath, matchPath, letterPath, formPath, brief, matchBrief, letterUpload, formUpload, gates };
}

async function regenHistorical(date) {
  if (!date) date = new Date().toISOString().slice(0, 10);
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) { console.error('NOTION_TOKEN unset'); process.exit(5); }
  const NH = { Authorization: 'Bearer ' + NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
  const DB = loadNotionDbId();
  if (!DB) { console.error('No Notion database ID configured (set NOTION_DATABASE_ID or notion.applications_db_id in profile.yml)'); process.exit(5); }
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith(`-${date}.md`));
  console.error(`Found ${files.length} historical letters for ${date}`);
  const results = [];
  const usedAngles = { internal_product: 0, attribution: 0, infrastructure: 0, data_quality: 0, modelling: 0, sole_owner: 0 };
  for (const f of files) {
    const m = f.match(/^(APP-?)?(\d+)-([a-z0-9-]+)-\d{4}-\d{2}-\d{2}\.md$/i);
    if (!m) { console.error(`  ? skip unrecognised: ${f}`); continue; }
    const appNum = parseInt(m[2], 10);
    let d = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const r = await fetch(`https://api.notion.com/v1/databases/${DB}/query`, {
          method: 'POST', headers: NH,
          body: JSON.stringify({ filter: { property: 'Application ID', unique_id: { equals: appNum } } }),
        });
        if (!r.ok) { console.error(`  ✗ Notion query ${r.status} for APP-${appNum}`); break; }
        d = await r.json();
        break;
      } catch (e) {
        if (attempt === 4) { console.error(`  ✗ Notion query failed for APP-${appNum} after 4 tries: ${e.code || e.message}`); }
        else { await new Promise(r => setTimeout(r, 1000 * attempt)); }
      }
    }
    if (!d) continue;
    if (!d.results.length) { console.error(`  ? APP-${appNum} not found in Notion`); continue; }
    const row = d.results[0];
    const jobUrl = row.properties['Job URL']?.url;
    const company = row.properties.Company?.title?.[0]?.plain_text;
    const country = row.properties.Country?.select?.name;
    const city = row.properties.Location?.rich_text?.[0]?.plain_text;
    const positions = (row.properties.Position?.multi_select || []).map(p => p.name.toLowerCase());
    let roleHint = 'ae';
    if (positions.some(p => /ml engineer|machine learning engineer/i.test(p))) roleHint = 'me';
    else if (positions.some(p => /data scientist|research|quant/i.test(p))) roleHint = 'ds';
    else if (positions.some(p => /data engineer|platform|backend|dataops/i.test(p))) roleHint = 'de';
    else if (positions.some(p => /data analyst|bi analyst|reporting/i.test(p))) roleHint = 'da';
    else if (positions.some(p => /analytics engineer/i.test(p))) roleHint = 'ae';
    if (!jobUrl) { console.error(`  ? APP-${appNum} ${company}: no Job URL`); continue; }
    try {
      const result = await generateOne({
        jobUrl, roleHint, appId: `APP-${appNum}`, company, country, city, today: new Date().toISOString().slice(0, 10), usedAngles,
        pageId: row.id,
      });
      if (result) {
        results.push({ appNum, company, ...result });
        usedAngles[result.matchBrief.employer_angle] = (usedAngles[result.matchBrief.employer_angle] || 0) + 1;
      }
    } catch (e) {
      console.error(`  ✗ APP-${appNum} ${company}: ${e.message}`);
    }
  }
  console.error(`\n=== Regenerated ${results.length}/${files.length} letters ===`);
  return results;
}

// ── Main ───────────────────────────────────────────────────────
(async () => {
  if (has('--regen-historical')) {
    const date = arg('--date') || new Date().toISOString().slice(0, 10);
    await regenHistorical(date);
    return;
  }
  const jobUrl = arg('--job-url');
  if (!jobUrl) {
    console.error('Usage: node scripts/cover-letters/generate.js --job-url <URL> [--role-hint ae|ds|de|da|me] [--app-id <id>] [--company <name>] [--jd-file <path>]');
    console.error('   or: node scripts/cover-letters/generate.js --regen-historical --date YYYY-MM-DD');
    process.exit(2);
  }
  await generateOne({
    jobUrl,
    companyUrl: arg('--company-url'),
    roleHint: arg('--role-hint'),
    appId: arg('--app-id') || 'one-off',
    company: arg('--company'),
    country: arg('--country'),
    city: arg('--city'),
    seniority: arg('--seniority'),
    today: arg('--today') || new Date().toISOString().slice(0, 10),
    uploadToNotion: !has('--no-upload'),
  });
})();
