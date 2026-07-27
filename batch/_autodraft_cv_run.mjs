#!/usr/bin/env node
// One-shot CV-build driver for the nightly auto-draft routine.
// Reads the Stage-2 draft queue, computes per-row (variant, lang, role-title,
// keywords) deterministically (no JD fetch needed for the CV half), builds the
// tailored HTML + PDF into output/cv-drafts/{APPID}-{slug}/, stages the photo,
// and writes data/.routine-tmp/cv-manifest.json for the upload/notion stage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extractJdRoleTitleVerbose } from '../cv/jd-role-title.mjs';

const ROOT = process.cwd();
// Queue / cap / manifest are env-overridable so this same driver can BACKFILL an
// arbitrary set of rows (e.g. the Stage-3 send-ready backlog) without a parallel
// script: DRAFT_QUEUE=<rows.json> DRAFT_CAP=200 DRAFT_MANIFEST=<out.json> node ...
const QUEUE = process.env.DRAFT_QUEUE || path.join(ROOT, 'data', '.routine-tmp', 'draft-queue.json');
const OUT_ROOT = path.join(ROOT, 'output', 'cv-drafts');
const PHOTO = path.join(ROOT, 'assets', 'candidate-photo.jpg');
const MANIFEST = process.env.DRAFT_MANIFEST || path.join(ROOT, 'data', '.routine-tmp', 'cv-manifest.json');
const CAP = Number(process.env.DRAFT_CAP) || 25; // triage.max_drafts_per_run

const slugify = (s) => String(s || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

const KEYWORDS = {
  de: 'Airflow,Kafka,Spark,Dagster,dbt,Snowflake,BigQuery,Python,SQL,CDC,Terraform',
  ae: 'dbt,Kimball,Snowflake,Databricks,BigQuery,ELT,Python,SQL',
  da: 'SQL,Power BI,Tableau,Looker,Excel,DAX,Python,dashboards,stakeholder reporting',
  ds: 'Python,scikit-learn,XGBoost,SHAP,MLflow,Airflow,AWS Sagemaker',
  me: 'Python,scikit-learn,XGBoost,SHAP,MLflow,FastAPI,Docker,model serving,MCP',
  master: 'Python,SQL,dbt,Snowflake,Airflow,Power BI,scikit-learn,Docker',
};

function pickVariant(position) {
  const p = (Array.isArray(position) ? position.join(' ') : String(position || '')).toLowerCase();
  if (/machine learning|ml engineer|\bai engineer|mlops/.test(p)) return 'me';
  if (/analytics engineer/.test(p)) return 'ae';
  if (/data engineer|platform|dataops/.test(p)) return 'de';
  if (/data analyst|\bbi\b|business intelligence|reporting/.test(p)) return 'da';
  if (/data scientist|research|quant/.test(p)) return 'ds';
  return 'master';
}

// The CV job-title header must LEAD with the role EXACTLY as advertised in the
// JD — not the coarse Notion Position family tag. Deriving it from position[0]
// (as this driver used to) collapsed the --role-title override to a no-op,
// because the variant is picked from that same tag; every CV then rendered the
// variant's generic subhead. extractJdRoleTitleVerbose recovers the verbatim
// advertised title from the job_url slug / fit_notes, falling back to the clean
// role family only when it cannot confidently parse one. See cv/jd-role-title.mjs.

// eFinancialCareers aggregator URLs encode the real country as jobs-{Country}-{City}.
const URL_COUNTRY = [
  [/united_kingdom|jobs-uk|\.co\.uk/i, 'UK'],
  [/germany/i, 'Germany'],
  [/austria/i, 'Austria'],
  [/switzerland/i, 'Switzerland'],
  [/netherlands/i, 'Netherlands'],
  [/\bspain\b/i, 'Spain'],
  [/ireland/i, 'Ireland'],
  [/\bfrance\b/i, 'France'],
  [/belgium/i, 'Belgium'],
  [/portugal/i, 'Portugal'],
];
function realCountry(row) {
  const url = row.job_url || '';
  // Only trust URL-derived country for eFC aggregator links; ATS links are reliable already.
  if (/efinancialcareers/i.test(url)) {
    for (const [re, c] of URL_COUNTRY) if (re.test(url)) return c;
  }
  return row.country || '';
}

const DACH = /^(germany|austria|switzerland|de|at|ch)$/i;

// English-speaking country names / ISO codes. A language signal.
const ENGLISH_COUNTRY = /^(uk|gb|united kingdom|great britain|england|scotland|wales|northern ireland|ireland|ie|eire|united states|usa?|canada|australia|new zealand)$/i;

// Job-board hosts that unambiguously denote an English-language posting locale.
// The job_url is ground truth: the Notion Country / Language fields can be
// mis-tagged from the search query rather than the posting (APP-1564 / JCB,
// 2026-07-08 — Country was wrongly "Germany" and Language "DE" on a
// uk.linkedin.com UK posting, so a German Lebenslauf was rendered for an
// English UK role). Keying `en` on these hosts is safe: a genuinely German
// posting never carries a uk. / .co.uk / .ie locale.
function isEnglishLocaleUrl(jobUrl) {
  let host;
  try { host = new URL(String(jobUrl || '')).hostname.toLowerCase(); }
  catch { return false; }
  return (
    host === 'uk.linkedin.com' ||
    host === 'ie.linkedin.com' ||
    host === 'uk.indeed.com' ||
    host.endsWith('.co.uk') ||
    host.endsWith('.gov.uk') ||
    host.endsWith('.ie')
  );
}

// CV language, most authoritative signal first:
//   1. English-locale job_url host, or an English-speaking country -> en.
//      This OVERRIDES a mis-tagged German Country/Language field, so a UK role
//      can never render a German Lebenslauf.
//   2. Explicit Notion Language field (en / de).
//   3. DACH country -> de.
//   4. Default -> en.
function pickLang(country, language, jobUrl) {
  const c = (country || '').trim();
  const l = (language || '').trim();
  if (isEnglishLocaleUrl(jobUrl) || ENGLISH_COUNTRY.test(c)) return 'en';
  if (/^en|english/i.test(l)) return 'en';
  if (/^de|german|deutsch/i.test(l)) return 'de';
  if (DACH.test(c)) return 'de';
  return 'en';
}

export { pickLang, isEnglishLocaleUrl, pickVariant, realCountry };

// Only run the draft loop when invoked directly (node batch/_autodraft_cv_run.mjs).
// Importing the module (e.g. from the test) exposes the pure helpers above
// without reading the queue or rendering any PDF.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isMain) {
const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const rows = (Array.isArray(queue) ? queue : (queue.rows || queue.results || []))
  .sort((a, b) => (b.match_score || 0) - (a.match_score || 0))
  .slice(0, CAP);

const manifest = [];
let ok = 0, fail = 0;
for (const row of rows) {
  const appId = row.application_id;
  const company = row.title;
  const slug = slugify(company);
  const dir = path.join(OUT_ROOT, `${appId}-${slug}`);
  const variant = pickVariant(row.position);
  const rc = realCountry(row);
  const lang = pickLang(rc, row.language, row.job_url);
  // Sync-with-job-post (modes/_profile.md, 2026-07-08): a DACH employer whose JD
  // is in English gets an ENGLISH CV rendered in the DACH presentation (photo +
  // Personal Details). Language follows the JD; DACH format follows the country.
  const dachFormat = DACH.test(rc) && lang === 'en';
  const { title: rt, source: rtSource } = extractJdRoleTitleVerbose(row);
  const kw = KEYWORDS[variant] || KEYWORDS.master;
  const countryFieldFix = (/efinancialcareers/i.test(row.job_url || '') && rc && rc.toLowerCase() !== (row.country || '').toLowerCase()) ? rc : null;
  const entry = {
    app_id: appId, page_id: row.id, company, slug, dir,
    variant, lang, role_title: rt, role_title_source: rtSource, keywords: kw,
    notion_country: row.country, real_country: rc, country_field_fix: countryFieldFix,
    match_score: row.match_score, position: row.position, job_url: row.job_url,
    language: row.language, fit_notes: row.fit_notes || '',
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const cvArgs = ['scripts/cv/generate-pdf-tailored.mjs',
      '--archetype', variant.toUpperCase(), '--lang', lang,
      '--company', slug, '--keywords', kw, '--role-title', rt];
    if (dachFormat || lang === 'de') cvArgs.push('--with-photo');
    execFileSync('node', cvArgs,
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
    const pdfGlob = fs.readdirSync(path.join(ROOT, 'output')).filter(f => f.includes(slug) && f.endsWith('.pdf'));
    const pdfPath = pdfGlob.length ? path.join(ROOT, 'output', pdfGlob[0]) : null;
    if (!pdfPath || !fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 10000) throw new Error('pdf missing/short');
    const destPdf = path.join(dir, `CV-${slug}.pdf`);
    fs.mkdirSync(path.dirname(destPdf), { recursive: true });
    fs.copyFileSync(pdfPath, destPdf);
    entry.html_path = htmlPath;
    entry.pdf_path = pdfPath;
    entry.pdf_bytes = fs.statSync(pdfPath).size;
    entry.status = 'ok';
    ok++;
    console.error(`  ✓ ${appId} ${company} [${variant}/${lang}] header="${rt}" (${rtSource}) ${(entry.pdf_bytes/1024|0)}KB`);
  } catch (e) {
    entry.status = 'fail';
    entry.error = String(e.message || e).slice(0, 200);
    fail++;
    console.error(`  ✗ ${appId} ${company}: ${entry.error}`);
  }
  manifest.push(entry);
}
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.error(`\nCV driver done: ${ok} ok, ${fail} fail, manifest=${MANIFEST}`);
}
