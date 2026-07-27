#!/usr/bin/env node
/**
 * cv/writing-eval.mjs — pre-Notion writing QA for CVs and cover letters.
 *
 * Scans every Stage-3 row and flags MECHANICAL defects that have shipped to
 * Notion before — the classes the eval loop exists to prevent:
 *
 *   LANG_MISMATCH   CV language ≠ routing rule (DACH role with an English CV)
 *   CV_MISSING      no CV HTML on disk
 *   CV_HALFGEN      CV HTML suspiciously small / missing core sections
 *   CV_UNSTYLED     CV HTML tags stripped to plain text (renders unstyled)
 *   CL_MISSING      no cover-letter markdown on disk
 *   CL_ASTERISK     stray markdown '**' in the CL body (renders as literal *)
 *   CL_EM_DASH      em dash (—) in the CL body (reads as AI-written; banned)
 *   CL_EN_DASH      spaced en dash ( – ) in CL prose (Gedankenstrich; §9.7 banned)
 *   CL_BANNED_VOCAB AI-tell vocabulary from cv-quality-rules §4 (delve, leverage…)
 *   DE_DU_FORM      informal du-form in a German letter (§9.1 — must be Sie)
 *   DE_NUM_FORMAT   English number formatting in a German letter (§9.5: % / 65,000)
 *   DE_GRUSS_COMMA  comma after "Mit freundlichen Grüßen" in a German letter (§9.9)
 *   AVAIL_STALE     availability still says a pre-July-2026 date
 *   COUNTRY_SUSPECT Country field contradicts DACH signals (city/GmbH/Xing)
 *
 * Output: human summary to stderr, JSON report to stdout (--json), exit 1 if
 * any defect is found (so a loop can gate on it). Read-only — fixes nothing.
 *
 * Usage:
 *   node cv/writing-eval.mjs            # human report
 *   node cv/writing-eval.mjs --json     # JSON report to stdout
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CV_DIR = join(ROOT, 'output', 'cv-drafts');
const CL_DIR = join(ROOT, 'output', 'cover-letters');
const JSON_MODE = process.argv.includes('--json');

// Mirror cv-bulk-reupload.mjs pickLang(): DACH + not-English → German.
function expectGerman(country, language) {
  const c = (country || '').trim();
  const l = (language || '').trim();
  if (/^de|german/i.test(l)) return true;
  if (/^(Germany|Austria|Switzerland)$/i.test(c) && !/^en|english/i.test(l)) return true;
  return false;
}

// Cross-check the Country field against strong DACH signals. A mis-tagged
// country (e.g. APP-2557 was "UK" for a Nürnberg/Xing/GmbH role) silently
// suppresses LANG_MISMATCH, so flag rows whose signals contradict the field.
// Requires >=2 independent German signals to avoid false positives (a German
// firm hiring in London shows only the entity-suffix signal, not a city).
// DACH cities incl. ö/ü/ä transliterations (Xing URLs use koeln/muenchen/zuerich).
const DACH_CITIES = /\b(berlin|m[uü]nchen|muenchen|munich|hamburg|k[oö]ln|koeln|cologne|frankfurt|stuttgart|d[uü]sseldorf|duesseldorf|n[uü]rnberg|nuernberg|nuremberg|leipzig|dresden|hannover|bremen|essen|dortmund|mannheim|karlsruhe|m[uü]nster|muenster|bonn|wiesbaden|heidelberg|darmstadt|augsburg|aachen|kiel|z[uü]rich|zuerich|zurich|basel|bern|genf|geneva|gen[eè]ve|lausanne|lugano|winterthur|zug|wien|vienna|graz|linz|salzburg|innsbruck)\b/i;
const DACH_ENTITY = /\b(gmbh|mbh|\bag\b|\bse\b|\bkg\b|gmbh ?& ?co)\b/i;
// Boards that are DACH-EXCLUSIVE: any non-DACH country on these is wrong by itself.
const DACH_BOARD = /(xing\.|stepstone\.de)/i;
const DACH_DOMAIN = /(xing\.|stepstone\.de|kununu|\.de\/|\bde\.indeed)/i;
const IS_DACH = (c) => /^(Germany|Austria|Switzerland)$/i.test((c || '').trim());
// Returns a reason string if the Country field contradicts DACH signals, else ''.
function dachCountryContradiction(row) {
  const url = (row.job_url || '').toLowerCase();
  const company = (row.title || '').toLowerCase();
  const loc = (row.location || '').toLowerCase();
  if (IS_DACH(row.country)) return '';
  // A DACH-exclusive board alone is conclusive.
  if (DACH_BOARD.test(url)) return `${row.country || '(empty)'} but DACH-exclusive board: ${row.job_url}`;
  // Otherwise require >=2 independent signals to avoid false positives.
  let n = 0;
  if (DACH_CITIES.test(url) || DACH_CITIES.test(loc)) n++;
  if (DACH_ENTITY.test(company)) n++;
  if (DACH_DOMAIN.test(url)) n++;
  return n >= 2 ? `${row.country || '(empty)'} but DACH signals in ${row.job_url || row.title}` : '';
}

// Draft outputs exist under two naming conventions: legacy `{num}-{slug}`
// and the 2026-07 auto-draft run's `APP-{num}-{slug}`. Match both.
function numPrefixed(name, num) {
  return name.startsWith(num + '-') || name.startsWith('APP-' + num + '-');
}

function findCvHtml(num) {
  if (!existsSync(CV_DIR)) return null;
  const dir = readdirSync(CV_DIR).find(d => numPrefixed(d, num) && statSync(join(CV_DIR, d)).isDirectory());
  if (!dir) return null;
  const html = readdirSync(join(CV_DIR, dir)).find(f => f.endsWith('.html'));
  return html ? join(CV_DIR, dir, html) : null;
}

function findClMd(num) {
  if (!existsSync(CL_DIR)) return null;
  const files = readdirSync(CL_DIR).filter(f => f.endsWith('.md') && numPrefixed(f, num)).sort();
  return files.length ? join(CL_DIR, files[files.length - 1]) : null;
}

function main() {
  const q = spawnSync('node', ['scripts/notion/notion-query.mjs', '--stage', '3. Drafted', '--json'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env });
  let rows;
  try { rows = JSON.parse(q.stdout); }
  catch { console.error('writing-eval: failed to query Notion'); process.exit(5); }

  const defects = [];
  const add = (id, cls, detail) => defects.push({ id, class: cls, detail });

  for (const r of rows) {
    const num = String(r.application_id || '').replace(/APP-?/i, '');

    // Country sanity: a DACH-exclusive board or >=2 DACH signals vs a non-DACH
    // Country field ⇒ likely mis-tagged (a mis-tag silently hides LANG_MISMATCH).
    const countryIssue = dachCountryContradiction(r);
    if (countryIssue) add(r.application_id, 'COUNTRY_SUSPECT', countryIssue);

    const cv = findCvHtml(num);
    if (!cv) { add(r.application_id, 'CV_MISSING', 'no CV HTML on disk'); }
    else {
      const sz = statSync(cv).size;
      const base = cv.split(/[\\/]/).pop();
      const cvIsDe = /_de\.html$/.test(base);
      if (sz < 6000) add(r.application_id, 'CV_HALFGEN', `CV HTML only ${Math.round(sz/1024)}KB (${base})`);
      else {
        const html = readFileSync(cv, 'utf8');
        // Markup integrity: a CV whose HTML tags were stripped to plain text still
        // contains the section WORDS, so the section check below passes — but it
        // renders as an unstyled text dump. Require real structure. (APP-2630: the
        // auto-draft wrote the CV as tag-less text.)
        if (!/<!doctype/i.test(html) || !/<h2[\s>]/i.test(html) || !/<p[\s>]/i.test(html)) {
          add(r.application_id, 'CV_UNSTYLED', `CV HTML lost its markup (renders as plain text): ${base}`);
        }
        // core sections that every complete CV carries
        for (const sec of ['Experience|Berufserfahrung', 'Education|Ausbildung', 'Skills|Kenntnisse']) {
          const re = new RegExp(sec, 'i');
          if (!re.test(html)) add(r.application_id, 'CV_HALFGEN', `missing section ~/${sec}/ in ${base}`);
        }
      }
      if (expectGerman(r.country, r.language) && !cvIsDe) {
        add(r.application_id, 'LANG_MISMATCH', `country=${r.country} expects German, CV is ${base}`);
      }
    }

    const cl = findClMd(num);
    if (!cl) { add(r.application_id, 'CL_MISSING', 'no cover-letter markdown on disk'); }
    else {
      const body = readFileSync(cl, 'utf8').split('<!--')[0];
      // Mirror the md-to-pdf bold pass exactly: strip every '**…**' span (the
      // same /\*\*[^\n]+?\*\*/ the renderer uses). If a '**' survives on any
      // line, that line renders with literal asterisks — a real defect. Paired
      // bold and gender-star subjects ("**…Analyst*in…**") strip cleanly and are
      // not flagged.
      for (const line of body.split(/\n/)) {
        if (line.replace(/\*\*[^\n]+?\*\*/g, '').includes('**')) {
          add(r.application_id, 'CL_ASTERISK', `'**' renders literally: "${line.trim().slice(0, 60)}"`);
          break;
        }
      }
      // Em dashes (—, U+2014) read as AI-generated writing and are banned in the
      // house style. German letters use the en-dash Gedankenstrich (–, U+2013),
      // which is correct and NOT flagged — only the em dash is a defect.
      for (const line of body.split(/\n/)) {
        if (line.includes('—')) {
          add(r.application_id, 'CL_EM_DASH', `em dash (—): "${line.trim().slice(0, 60)}"`);
          break;
        }
      }
      // Stale availability: a pre-July-2026 month stated AS the availability
      // date — i.e. within a few words after "available/verfügbar" ("available
      // from May 2026", "verfügbar ab Mai 2026"). A factual degree-completion
      // date later in the same sentence ("available immediately, my MSc
      // completed in May 2026") is NOT a defect and must not be flagged.
      const AVAIL_STALE_RE = /(?:availab\w*|verfügbar\w*)\W+(?:\w+\W+){0,2}(?:March|April|May|Mai|März)\s+2026\b/i;
      for (const line of body.split(/\n/)) {
        if (AVAIL_STALE_RE.test(line)) {
          add(r.application_id, 'AVAIL_STALE', `availability: "${line.trim().slice(0, 70)}"`);
          break;
        }
      }
      // Spaced en dash ( – ) used as a Gedankenstrich/prose aside is banned in
      // body prose (cv-quality-rules §9.7). UNSPACED date ranges (2018–2019) are
      // exempt, so match only ' – '.
      for (const line of body.split(/\n/)) {
        if (/ – /.test(line)) { add(r.application_id, 'CL_EN_DASH', `en dash (–): "${line.trim().slice(0, 60)}"`); break; }
      }
      // Banned AI-tell vocabulary (cv-quality-rules §4). High-confidence only —
      // "leverage" is excluded here because its legitimate NOUN sense ("has
      // leverage on") can't be told from the banned verb form mechanically; it
      // stays in the §4 instruction + caveats-audit as a soft signal instead.
      const BANNED_VOCAB = /\b(delve|synerg(y|ies|ise|ize)|pivotal|garner(s|ed|ing)?|showcase[ds]?|boasts|seamless(ly)?)\b/i;
      for (const line of body.split(/\n/)) {
        const m = line.match(BANNED_VOCAB);
        if (m) { add(r.application_id, 'CL_BANNED_VOCAB', `"${m[0]}": "${line.trim().slice(0, 50)}"`); break; }
      }
      // Insider abbreviations in recruiter-facing prose (standing
      // caveat: violated by cases like "JD names tech stack:"). "JD", "CL",
      // "ATS", "JD's" read as internal shorthand — spell them out ("the
      // posting", "the role description"). CV/PDF/SQL etc. are fine.
      const BANNED_ABBREV = /\b(JD|JDs|CLs?|ATS)\b/;
      for (const line of body.split(/\n/)) {
        const m = line.match(BANNED_ABBREV);
        if (m) { add(r.application_id, 'CL_ABBREV', `insider abbreviation "${m[0]}": "${line.trim().slice(0, 55)}"`); break; }
      }
      // Grounding: first-person experience claims must only name tools in the
      // CV evidence base (cv.md production tier + article-digest projects).
      // A shipped Anschreiben claimed daily Microsoft Fabric use the attached
      // CV could not support — a side-by-side read kills credibility. Tools
      // below are the working-knowledge tier + common JD tools with NO
      // production evidence; claiming hands-on work with them is a defect.
      const UNGROUNDED_TOOLS = /\b(Microsoft Fabric|Fabric|Medallion|Synapse|Data Factory|Databricks|Snowflake|BigQuery|Airflow|Looker|MLflow|Kafka|Terraform|SageMaker|Vertex AI|Azure DevOps)\b/i;
      const FIRSTPERSON_CLAIM = /\b(I (?:work|build|develop) (?:with|in|on)|I use|I have (?:production evidence|shipped)|stack I have shipped on|my (?:daily|production) (?:work|stack)|ich arbeite (?:mit|in)|arbeite ich (?:mit|täglich)|ist mir vertraut|sind mir vertraut|nutze ich|ich nutze|meine Praxis)\b/i;
      // Sentence-level, not line-level: an honest transfer sentence ("Snowflake
      // sits on my skills list from study...") often shares a paragraph with a
      // legitimate production claim, and must not be flagged.
      const HONEST_TRANSFER = /\b(skills list|transfers?|transferable|maps onto|adjacent|study|coursework|Kursarbeit|Zertifizierung|kenne ich aus|personal[- ]project|Grundkenntnis|übertr[aä]g|vertiefe|carr(?:y|ies) across|not (?:yet )?in my (?:production )?stack|honest about the gap|ist nicht Teil|benenne ich offen)\b/i;
      outer: for (const line of body.split(/\n/)) {
        for (const sentence of line.split(/(?<=[.!?])\s+/)) {
          if (FIRSTPERSON_CLAIM.test(sentence) && UNGROUNDED_TOOLS.test(sentence) && !HONEST_TRANSFER.test(sentence)) {
            const tool = sentence.match(UNGROUNDED_TOOLS)[0];
            add(r.application_id, 'CL_UNGROUNDED', `first-person claim of unevidenced tool "${tool}": "${sentence.trim().slice(0, 70)}"`);
            break outer;
          }
        }
      }
      // German fluency (cv-quality-rules §9) — only for letters actually WRITTEN
      // in German. Detect by the German salutation/sign-off, NOT the Country field
      // (a DACH-country role can be written in English / DIN-EN, where £60,000 and
      // 95% are correct and must not be flagged).
      const clIsGerman = /Sehr geehrte|Mit freundlichen Grüßen|Bewerbung als/.test(body);
      if (clIsGerman) {
        // §9.1 Sie-form only — flag stray informal du-forms.
        for (const line of body.split(/\n/)) {
          if (/\b(du|dein\w*|dich|dir|euer|euch)\b/i.test(line)) {
            add(r.application_id, 'DE_DU_FORM', `informal du-form (§9.1): "${line.trim().slice(0, 50)}"`); break;
          }
        }
        // §9.5 German number formatting — English thousands separator (65,000 must
        // be 65.000). German decimals (0,9449) are not matched by \d{1,3},\d{3}.
        for (const line of body.split(/\n/)) {
          if (/\b\d{1,3},\d{3}\b/.test(line)) {
            add(r.application_id, 'DE_NUM_FORMAT', `English thousands sep (§9.5): "${line.trim().slice(0, 50)}"`); break;
          }
        }
        // §9.9 closing — German takes NO comma after "Mit freundlichen Grüßen".
        if (/Mit freundlichen Grüßen,/.test(body)) {
          add(r.application_id, 'DE_GRUSS_COMMA', 'comma after "Mit freundlichen Grüßen" (§9.9 — German takes none)');
        }
      }
    }
  }

  const byClass = {};
  for (const d of defects) byClass[d.class] = (byClass[d.class] || 0) + 1;

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ total_rows: rows.length, defect_count: defects.length, by_class: byClass, defects }, null, 2));
  }
  console.error(`\n=== writing-eval: ${rows.length} Stage-3 rows ===`);
  if (!defects.length) console.error('CLEAN — no mechanical defects.');
  else {
    for (const [cls, n] of Object.entries(byClass)) console.error(`  ${cls.padEnd(14)} : ${n}`);
    console.error('\nDefects:');
    for (const d of defects) console.error(`  ${d.id} | ${d.class} | ${d.detail}`);
  }
  process.exit(defects.length ? 1 : 0);
}

main();
