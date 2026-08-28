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
import { extractJdRoleTitleVerbose } from '../scripts/cv/jd-role-title.mjs';

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

// The English-locale host also tells us the posting's real MARKET, which the
// Notion Country field can get wrong (Country "Germany" on a uk.linkedin.com
// posting can render a UK-format CV whose profile still says "Relocating to
// Germany" — the worst line to hand a UK recruiter). useDachFormat already
// honours the URL override; the market tail must honour it too, or the two
// disagree.
function englishLocaleCountry(jobUrl) {
  let host;
  try { host = new URL(String(jobUrl || '')).hostname.toLowerCase(); }
  catch { return null; }
  if (host === 'ie.linkedin.com' || host.endsWith('.ie')) return 'Ireland';
  if (host === 'uk.linkedin.com' || host === 'uk.indeed.com' || host.endsWith('.co.uk') || host.endsWith('.gov.uk')) return 'UK';
  return null;
}

// Country used ONLY for the CV's market-aware visa/availability tail.
// Kept separate from realCountry() so the existing lang / dach-format /
// country_field_fix behaviour is unchanged.
function cvMarketCountry(row, realCountryValue) {
  return englishLocaleCountry(row.job_url) || realCountryValue;
}

// Conservative German-language detector for a JD snapshot. HIGH precision:
// only true when German markers clearly dominate, so an English JD wrapped in
// German portal chrome (Xing / eFinancialCareers boilerplate) is NOT misread
// as German. Bias is deliberate: for a DACH role the safe default is an
// English CV in DACH format, so German must be positively proven.
const DE_MARKERS = /\b(und|oder|der|die|das|den|dem|des|für|fuer|mit|sind|wird|werden|nicht|sehr|sowie|über|ueber|durch|bzw|deine?|aufgaben|kenntnisse|erfahrung|unternehmen|mitarbeiter(?:in|innen)?|gehaltsvorstellung|eintrittstermin|sehr geehrte|wir bieten)\b/gi;
const EN_MARKERS = /\b(the|and|of|to|in|for|with|on|at|by|from|or|as|is|are|will|would|should|have|has|your|our|we|you|role|team|experience|skills|responsibilities|about)\b/gi;
function looksGermanText(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  const de = (t.match(DE_MARKERS) || []).length;
  const en = (t.match(EN_MARKERS) || []).length;
  // Clear German majority AND a real German count, so sparse German chrome
  // around an English JD does not flip the verdict.
  return de >= 4 && de > en * 1.5;
}

// CV content language ('en' | 'de'). The caller renders DACH *presentation*
// (photo + Personal Details) whenever the country is DACH and this returns
// 'en' (see useDachFormat).
//   1. English-locale job_url host, or an English-speaking country -> 'en'.
//      OVERRIDES a mis-tagged German Country/Language field.
//   2. DACH country -> 'de' ONLY on a positive German signal (Language = DE,
//      or a clearly German JD snapshot). Otherwise 'en' — which the caller
//      renders in DACH format, so an English JD at a DACH employer gets the
//      strong English CV in German-market presentation instead of a German
//      Lebenslauf.
//   3. Other non-DACH country -> explicit German Language -> 'de', else 'en'.
function pickLang(country, language, jobUrl, jdText) {
  const c = (country || '').trim();
  const l = (language || '').trim();
  const germanLangField = /^de|german|deutsch/i.test(l);
  const englishLangField = /^en|english/i.test(l);
  if (isEnglishLocaleUrl(jobUrl) || ENGLISH_COUNTRY.test(c)) return 'en';
  if (DACH.test(c)) {
    if (germanLangField || (!englishLangField && looksGermanText(jdText))) return 'de';
    return 'en';
  }
  if (germanLangField) return 'de';
  return 'en';
}

// DACH presentation (photo + Personal Details) applies when the country is a
// DACH market AND we render English content AND the posting is NOT a known
// English-locale (UK / IE) URL. That last guard matters when the Country
// field is mis-tagged as a DACH country on a UK posting: the URL wins, so a
// UK CV never gets a photo.
function useDachFormat(country, lang, jobUrl) {
  return DACH.test((country || '').trim()) && lang === 'en' && !isEnglishLocaleUrl(jobUrl);
}

// Graduate-tier vocabulary, EN + DE. Colon/asterisk/slash gender forms
// (Absolvent:innen, Absolvent*innen, Absolvent/-innen) all reduce to the
// "absolvent" stem, so the stem is enough.
const GRAD_SIGNALS_AUTO = /\b(graduate|grad\b|entry[- ]level|junior|trainee|werkstudent|praktikant|apprentice|new grad|recent grad|class of|programme 202|program 202|2027|early career|absolvent\w*|berufseinsteiger\w*|berufseinstieg|einsteiger\w*|hochschulabsolvent\w*)\b/i;

// Years-required extraction. Two callers want opposite ends of the range and
// conflating them mis-frames real postings:
//   min -> "is this too senior for a mid-level candidate?"  (5+ demotion)
//   max -> "does the employer want LESS experience than the candidate has?"
//          (graduate-framing switch in detectSeniorityAuto)
// max is null for an open-ended floor ("3+ years", "at least 2", "mindestens
// 2 Jahre"), because those name no ceiling. Only a closed band ("1-2 years")
// or a bare figure ("2 years of experience") sets one.
const YEARS_RANGE_EN = /\b(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:years?|yrs?)\b/gi;
const YEARS_RANGE_DE = /\b(\d{1,2})\s*(?:bis|[-–—])\s*(\d{1,2})\s*Jahren?/gi;
const YEARS_OPEN = /\b(?:at\s+least|min(?:imum)?\.?|starting\s+from|mindestens|min\.?|ab)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?|Jahren?)\b|\b(\d{1,2})\s*\+\s*(?:years?|yrs?|Jahren?)\b/gi;
const YEARS_BARE = /\b(\d{1,2})\s*(?:years?|yrs?)\s+(?:of\s+)?(?:relevant\s+|professional\s+|hands[- ]on\s+|proven\s+|solid\s+)?experience\b|\b(\d{1,2})\s*Jahren?\s+(?:einschlägiger\s+|nachweisbar\w*\s+|Berufs)?[Ee]rfahrung\b/gi;

function requiredYearsRange(text) {
  let t = String(text || '');
  const sane = (n) => { const v = parseInt(n, 10); return (!isNaN(v) && v >= 0 && v <= 20) ? v : null; };
  const mins = [], maxes = [];
  let m;
  // Each pattern MASKS what it consumes. Without masking the bare-figure
  // pattern fires inside the others and invents a ceiling that the employer
  // never stated: "at least 2 years experience" contains the substring "2
  // years experience", so it would score {min:2, max:2} and read as a closed
  // band below 3.
  const mask = (re, onMatch) => {
    re.lastIndex = 0;
    const spans = [];
    while ((m = re.exec(t))) { onMatch(m); spans.push([m.index, m.index + m[0].length]); }
    for (const [s, e] of spans.reverse()) t = t.slice(0, s) + ' '.repeat(e - s) + t.slice(e);
  };
  // 1. closed bands set BOTH ends
  for (const re of [YEARS_RANGE_EN, YEARS_RANGE_DE]) {
    mask(re, (mm) => { const lo = sane(mm[1]), hi = sane(mm[2]); if (lo !== null) mins.push(lo); if (hi !== null) maxes.push(hi); });
  }
  // 2. open floors set ONLY a minimum — deliberately no ceiling
  mask(YEARS_OPEN, (mm) => { const v = sane(mm[1] ?? mm[2]); if (v !== null) mins.push(v); });
  // 3. whatever bare figures survive set both
  mask(YEARS_BARE, (mm) => { const v = sane(mm[1] ?? mm[2]); if (v !== null) { mins.push(v); maxes.push(v); } });
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxes.length ? Math.max(...maxes) : null,
  };
}

// Contexts where a seniority word appears but is NOT the band being hired
// for. Stripped from the JD body before the keyword tests run, because a
// bare /\bjunior\b/ over the whole posting reads the wrong sentence far too
// often (mentor lines, benefits footnotes, team-describing prose,
// progression promises).
const SENIORITY_NOISE = [
  // "junior" as the OBJECT of a mentoring/leading verb.
  /\b(?:mentor|mentoring|mentored|coach|coaching|supervis\w+|guid\w+|support\w*|train|develop|lead|leading|manag\w+)\s+(?:and\s+\w+\s+)?(?:our\s+|the\s+|more\s+)?(?:junior|graduate|entry[- ]level|trainee)\w*\b/gi,
  // "junior colleagues/engineers/analysts" as people already on the team.
  /\b(?:junior|graduate)\s+(?:colleagues|team\s+members|staff|peers)\b/gi,
  // "...-level roles or above" — a floor in a benefits/eligibility footnote.
  /\b(?:junior|graduate|entry)[- ]level\s+roles?\s+(?:or\s+above|and\s+above|upwards?)\b/gi,
  // "senior" describing the TEAM, not the vacancy.
  /\b(?:senior|lead)\s+(?:data\s+|engineering\s+|analytics\s+)?(?:team|colleagues|peers|stakeholders|management|leadership)\b/gi,
  // Inclusive phrasing that lists bands rather than requiring one.
  /\b(?:both\s+)?(?:mid[- ]level|junior|graduate)\s+(?:and|or|to)\s+senior\b/gi,
  /\bsenior\s+(?:and|or)\s+(?:mid[- ]level|junior|graduate)\b/gi,
  // Career-progression promises in the benefits block.
  /\b(?:grow|progress|advance|move)\s+into\s+(?:more\s+)?senior\b/gi,
];
function stripSeniorityNoise(text) {
  let t = String(text || '');
  for (const re of SENIORITY_NOISE) t = t.replace(re, ' ');
  return t;
}

// `jdText` is the posting the routine actually fetched. It is a SEPARATE
// argument rather than being read off the row because a Notion `jd_snapshot`
// field is empty on every scanned row, and passing that alone leaves the
// "clearly German JD" branch of pickLang as dead code.
function detectSeniorityAuto(row, jdText) {
  // TITLE first. The advertised title is the band the employer is hiring for.
  const title = [row.role, ...(Array.isArray(row.position) ? row.position : [row.position || ''])]
    .filter(Boolean).join(' ');
  if (GRAD_SIGNALS_AUTO.test(title)) return 'graduate';
  if (/\b(senior|staff|principal|lead|head of|director|vp)\b/i.test(title)) return 'senior';
  // BODY second, and only after the noise contexts above are removed.
  // fit_notes is deliberately NOT part of this blob: it is auto-eval's own
  // commentary on positioning, so feeding it back can flip a mid posting to
  // graduate on strategy-note wording alone.
  const body = stripSeniorityNoise(jdText || row.jd_snapshot || '');
  if (GRAD_SIGNALS_AUTO.test(body)) return 'graduate';
  // "senior" keeps its unqualified read: its noise contexts are already
  // removed by stripSeniorityNoise. "staff" / "principal" only denote a BAND
  // when they qualify a role noun ("Staff Engineer", "Principal Data
  // Scientist"); bare, they are ordinary words that would false-positive
  // ("Our staff bring expertise", "principal component analysis").
  if (/\bsenior\b/i.test(body)) return 'senior';
  if (/\b(?:staff|principal)\s+(?:\w+\s+){0,2}(?:engineer|scientist|analyst|developer|architect|consultant|specialist)\b/i.test(body)) return 'senior';
  // JD-driven graduate framing. A "1-2 years" JD with no grad keyword is
  // still graduate territory for a 3-year candidate. What matters is the
  // CEILING: downgrade only when the employer's upper bound is below the
  // candidate's experience. An open-ended floor has no ceiling and is never
  // graduate.
  const { max: yrsCeiling } = requiredYearsRange(body);
  if (yrsCeiling !== null && yrsCeiling < 3) return 'graduate';
  // Professional-primary default: a posting with no seniority signal is mid,
  // never graduate.
  return 'mid';
}

export {
  pickLang, useDachFormat, isEnglishLocaleUrl, englishLocaleCountry,
  cvMarketCountry, looksGermanText, pickVariant, realCountry,
  detectSeniorityAuto, requiredYearsRange,
};

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
  // Language must be decided from the JD text the routine actually fetched.
  // `row.jd_snapshot` is the Notion field and is empty on every scanned row,
  // so passing it alone would leave looksGermanText() permanently reading ''
  // and the "clearly German JD" branch of pickLang would be dead code. The
  // fetched posting lands at <dir>/jd.txt; read that first and fall back to
  // the Notion snapshot when the fetch produced nothing.
  const jdFile = path.join(dir, 'jd.txt');
  const hasJd = fs.existsSync(jdFile) && fs.statSync(jdFile).size > 200;
  const jdText = hasJd ? fs.readFileSync(jdFile, 'utf8') : (row.jd_snapshot || '');
  const lang = pickLang(rc, row.language, row.job_url, jdText);
  // Sync-with-job-post: a DACH employer whose JD is in English gets an
  // ENGLISH CV rendered in the DACH presentation (photo + Personal Details).
  // Language follows the JD; DACH format follows the country. useDachFormat
  // additionally respects an English-locale URL override.
  const dachFormat = useDachFormat(rc, lang, row.job_url);
  const { title: rt, source: rtSource } = extractJdRoleTitleVerbose(row);
  const kw = KEYWORDS[variant] || KEYWORDS.master;
  const seniority = detectSeniorityAuto(row, jdText);
  const countryFieldFix = (/efinancialcareers/i.test(row.job_url || '') && rc && rc.toLowerCase() !== (row.country || '').toLowerCase()) ? rc : null;
  // Market-aware visa/availability tail: without --country a UK row would
  // resolve to 'general' and render the dual-market hedge. cvMarketCountry
  // lets an English-locale job_url (uk.linkedin.com etc.) override a
  // mis-tagged DACH Country field, matching what useDachFormat does for
  // presentation.
  const marketCountry = cvMarketCountry(row, rc);
  const entry = {
    app_id: appId, page_id: row.id, company, slug, dir,
    variant, lang, dach_format: dachFormat,
    role_title: rt, role_title_source: rtSource, keywords: kw,
    seniority, jd_text_available: hasJd,
    notion_country: row.country, real_country: rc, market_country: marketCountry,
    country_field_fix: countryFieldFix,
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
