#!/usr/bin/env node
// scripts/cover-letters/generate.js — orchestrator for the 3-stage redesign.
//
// Usage:
//   node scripts/cover-letters/generate.js --job-url <URL> [--company-url <URL>] \
//        [--role-hint ae|ds|de|da|me] [--app-id <id>] [--company <name>] \
//        [--country <name>] [--city <name>] [--today YYYY-MM-DD]
//
//   # Bulk mode (re-generate all historical letters from Notion):
//   node scripts/cover-letters/generate.js --regen-historical --date YYYY-MM-DD
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { research } = require('./lib/research');
const { match } = require('./lib/match');
const { compose: composeV2 } = require('./lib/draft-v2');
const { route } = require('./lib/router');
const { composeForm } = require('./lib/form-drafter');

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const KEEP_MD = has('--keep-md'); // skip .md deletion so caller can run cv-qa before uploading

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

// Render a markdown file to PDF, upload to a Notion property, and
// delete the .md (and any stray .tmp.html scratch) on success so the
// output dir only ever holds PDFs. If render or upload fails, the .md
// is retained for retry.
// Best-effort: any failure logs but does not throw.
function renderAndUpload(mdPath, pageId, notionProperty) {
  if (!pageId) return { rendered: false, uploaded: false, reason: 'no_page_id' };
  const pdfPath = mdPath.replace(/\.md$/, '.pdf');
  const tmpHtml = mdPath.replace(/\.md$/, '.tmp.html');
  // Render
  try {
    execFileSync(process.execPath, ['scripts/cover-letters/lib/md-to-pdf.mjs', '--in', mdPath, '--out', pdfPath], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000,
    });
  } catch (e) {
    console.error(`    ✗ render failed: ${String(e.message || e).slice(0, 100)}`);
    return { rendered: false, uploaded: false, reason: 'render_failed' };
  }
  // Upload (replace mode — single-file array)
  try {
    execFileSync(process.execPath, ['scripts/notion/notion-upload-file.mjs', '--file', pdfPath, '--page', pageId, '--property', notionProperty], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 10 * 1024 * 1024,
    });
    // Success: clean up .md and .tmp.html (unless --keep-md was passed for post-upload cv-qa)
    if (!KEEP_MD) { try { fs.unlinkSync(mdPath); } catch {} }
    try { fs.unlinkSync(tmpHtml); } catch {}
    return { rendered: true, uploaded: true, pdfPath };
  } catch (e) {
    console.error(`    ✗ upload failed: ${String(e.message || e).slice(0, 100)}`);
    return { rendered: true, uploaded: false, pdfPath, reason: 'upload_failed' };
  }
}

// Render to PDF without uploading (used when no Notion target). Same
// cleanup discipline — .md goes once the PDF is on disk.
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

// Resolve a Notion pageId from an appId (e.g. "APP-54" → page UUID).
// Returns null if not found / Notion unreachable.
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

async function generateOne({ jobUrl, companyUrl, roleHint, appId, company, country, city, today, usedAngles, pageId, uploadToNotion = true, seniority }) {
  const cvMaster = loadCvMaster();
  console.error(`[research] ${appId} ${company || ''} ${jobUrl}`);
  const brief = await research({ jobUrl, companyUrl, roleHint, appId, companyHint: company });
  brief.fetched_at = (today || new Date().toISOString().slice(0, 10)) + 'T00:00:00Z';
  if (brief.error) {
    console.error(`  ✗ ${brief.error}`);
    return null;
  }
  // Persist brief
  const briefPath = path.join(BRIEFS_DIR, `${appId}-${slugify(company || brief.company || 'co')}.json`);
  fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));

  // Match stage needs JD text — re-pull from cache for the markdown body
  let jdText = '';
  try {
    const { firecrawl } = require('./lib/research');
    const jd = firecrawl(jobUrl);
    jdText = jd?.markdown || '';
  } catch {}

  console.error(`  [match] ${brief.facts.length} facts, employer-angle scoring...`);
  const matchBrief = match({ brief, cvMaster, jdText, roleHint, country, appId, usedAngles, seniority });
  matchBrief.country = country; matchBrief.city = city;
  const matchPath = path.join(MATCHES_DIR, `${appId}-${slugify(company || brief.company || 'co')}.json`);
  fs.writeFileSync(matchPath, JSON.stringify(matchBrief, null, 2));

  // Stage 0: Route
  // --force-lang de|en overrides the auto-detected posting language. Use it when a
  // DACH employer (GmbH/AG) posts in English on LinkedIn but the letter should be
  // German anyway (RULE 1) — the router otherwise picks RULE 2 (English prose).
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
    briefPath: briefPath.replace(/^.*career-ops[\/\\]/, ''),
    matchPath: matchPath.replace(/^.*career-ops[\/\\]/, ''),
  });
  const formName = `${appId}-${slugify(company || brief.company || 'co')}-${today || new Date().toISOString().slice(0, 10)}-form.md`;
  const formPath = path.join(FORM_OUT_DIR, formName);
  fs.writeFileSync(formPath, formMd);
  console.error(`  ✓ ${formPath}`);

  // Auto-render + upload to Notion. Letter → "Cover Letter" property,
  // Form → "Form answers" property. Both replace-uploads.
  // On success the .md and any .tmp.html scratch are deleted so the
  // output folder ends up with PDFs ONLY (user rule: no markdowns).
  let letterUpload = { rendered: false, uploaded: false, reason: 'disabled' };
  let formUpload = { rendered: false, uploaded: false, reason: 'disabled' };
  if (uploadToNotion) {
    if (!pageId) pageId = await lookupPageId(appId);
    if (pageId) {
      console.error(`  [upload] rendering letter PDF + uploading to Notion 'Cover Letter'...`);
      letterUpload = renderAndUpload(letterPath, pageId, 'Cover Letter');
      if (letterUpload.uploaded) console.error(`  ✓ Cover Letter uploaded to ${pageId.slice(0, 8)}…`);
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

  return { briefPath, matchPath, letterPath, formPath, brief, matchBrief, letterUpload, formUpload };
}

async function regenHistorical(date) {
  if (!date) date = new Date().toISOString().slice(0, 10);
  // Find historical letters by date, query Notion for each appId's Job URL.
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
    // Filename: <appId>-<company>-<date>.md  (appId may be 2-4 digits or "APP-NN")
    const m = f.match(/^(APP-?)?(\d+)-([a-z0-9-]+)-\d{4}-\d{2}-\d{2}\.md$/i);
    if (!m) { console.error(`  ? skip unrecognised: ${f}`); continue; }
    const appNum = parseInt(m[2], 10);
    const companySlug = m[3];
    // Query Notion (with retry on transient network errors)
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
        pageId: row.id,  // skip the lookup — caller already has it
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
    console.error('Usage: node scripts/cover-letters/generate.js --job-url <URL> [--role-hint ae|ds|de|da|me] [--app-id <id>] [--company <name>]');
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
