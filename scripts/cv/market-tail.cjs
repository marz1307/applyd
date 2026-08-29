'use strict';

// =========================================================================
// market-tail.cjs — market-aware visa + availability lines for CV renderers.
// ONE MARKET PER CV: a recruiter should only ever see their own market's
// right-to-work story, never the dual-market hedge.
//
// Shared by CJS and ESM callers (via default-import interop). The strings
// live in config/profile.yml -> market_lines (user layer); this module only
// selects and guards.
//
// Markets:
//   uk      UK / GB
//   dach    Germany (see note below)
//   eu      other EU Blue Card states + the generic "EU (other)" bucket
//   other   Ireland & Denmark (EU Blue Card does NOT apply there) and any
//           non-EU/non-UK country → NO visa line (never volunteer
//           "would need sponsorship" on paper), generic availability
//   general no country signal (published general CV only) → dual line
// =========================================================================

const fs = require('fs');
const path = require('path');
const { stripHtml } = require('../text-safety.cjs');

// scripts/cv/market-tail.cjs -> config/profile.yml at the repo root.
const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'profile.yml');

const UK_RE = /^(uk|gb|united kingdom|great britain|england|scotland|wales|northern ireland)$/i;
// 'dach' market = GERMANY only: its lines name Germany explicitly. Austria
// is an EU Blue Card state → 'eu' (generic, accurate). Switzerland is NOT
// in the EU — the Blue Card does not apply there → 'other' (no visa line).
// The CONTENT market is a separate axis from DACH *presentation* (photo +
// Personal Details), which is driven by useDachFormat/--dach-format and
// covers AT + CH.
const GERMANY_RE = /^(germany|deutschland|de)$/i;
// Blue Card non-participants: a CV for these must not claim Blue Card
// eligibility (IE/DK opted out; CH is outside the EU).
const NO_BLUECARD_RE = /^(ireland|ie|eire|denmark|dk|switzerland|schweiz|ch)$/i;
const EU_RE = /^(eu\b.*|european union.*|austria|österreich|oesterreich|at|netherlands|nl|spain|es|france|fr|belgium|be|portugal|pt|italy|it|poland|pl|sweden|se|finland|fi|czechia|czech republic|cz|luxembourg|lu|estonia|ee|latvia|lv|lithuania|lt|croatia|hr|slovenia|si|slovakia|sk|hungary|hu|romania|ro|bulgaria|bg|greece|gr|malta|mt|cyprus|cy)$/i;

function resolveMarket(country, { dachFormat = false, lang = 'en', requireCountry = false } = {}) {
  const c = String(country || '').trim();
  // An APPLICATION render must know its market. 'general' emits the dual-
  // market hedge, which is correct for the published general CV and wrong
  // for every targeted one: it volunteers relocation intent to a UK
  // employer, and it may claim Blue Card eligibility that does not exist
  // in Ireland or Denmark. Callers rendering for a specific application
  // pass requireCountry so a missing --country fails loudly.
  if (!c && requireCountry) {
    throw new Error(
      'market-tail: no country supplied for an application render. The general '
      + 'market emits a dual-market visa line that is wrong on a targeted CV. '
      + 'Pass --country (the Notion row Country), or omit requireCountry only '
      + 'for the published general CV.',
    );
  }
  if (!c) {
    // No country signal: a German-language CV or a DACH-presentation CV is
    // by definition addressed to the DACH market; anything else stays general.
    return (lang === 'de' || dachFormat) ? 'dach' : 'general';
  }
  if (UK_RE.test(c)) return 'uk';
  if (GERMANY_RE.test(c)) return 'dach';
  if (NO_BLUECARD_RE.test(c)) return 'other';
  if (EU_RE.test(c)) return 'eu';
  return 'other';
}

// ---- config parsing (regex-based, no YAML dep — same pattern as the -----
// ---- renderers' other profile.yml reads) --------------------------------
let _linesCache = null;
function readMarketLines() {
  if (_linesCache) return _linesCache;
  const out = { visa: {}, availability: {} };
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const block = raw.match(/^market_lines:\s*\n([\s\S]*?)(?=^\S|\s*$(?![\s\S]))/m);
    if (block) {
      let current = null;
      for (const line of block[1].split('\n')) {
        const sub = line.match(/^  (visa|availability):\s*$/);
        if (sub) { current = sub[1]; continue; }
        const kv = line.match(/^ {4}([a-z_]+):\s*"(.*)"\s*$/);
        if (kv && current) out[current][kv[1]] = kv[2];
      }
    }
  } catch { /* missing config → empty lines, callers fall back gracefully */ }
  _linesCache = out;
  return out;
}

function pick(kind, market, lang) {
  const lines = readMarketLines()[kind] || {};
  const l = lang === 'de' ? 'de' : 'en';
  return lines[`${market}_${l}`] ?? lines[`${market}_en`] ?? '';
}

// Visa line appended to the CV profile paragraph. Empty string for 'other'
// (deliberate: no key in config) — callers must skip appending when empty.
function visaLine(market, lang) {
  return pick('visa', market, lang);
}

// Availability sentence for the CV's bottom line. Renderers prepend their
// own "Availability:" / "Verfügbarkeit:" label.
function availabilityLine(market, lang) {
  return pick('availability', market, lang);
}

// ---- sentence-level stripper --------------------------------------------
// Removes any pre-existing visa/right-to-work/availability-hedge sentence
// from a profile paragraph so the market-resolved line can be appended
// without duplication.
const VISA_SENTENCE_RE = /UK Graduate visa|Blue.?Card|right to work|Eligible to work|Arbeitsberechtigt|Engpassberufe|ZAB|no sponsorship|kein Sponsoring|umzugsbereit|Sponsoring-Lizenz|German at B[12]|Deutsch auf B[12]|Relocating to Germany|Ready to relocate|Umzug nach Deutschland/i;

function stripVisaSentences(text) {
  const t = String(text || '');
  // Split at REAL sentence boundaries — period/!/? followed by whitespace
  // and a capital letter. This keeps decimals intact (0.94, 0.95 etc.) —
  // splitting on just "period-space" treats them as sentence ends and
  // silently drops everything between them.
  const parts = t.split(/(?<=[.!?])\s+(?=[A-Z])/);
  return parts.filter((s) => !VISA_SENTENCE_RE.test(s)).join(' ').trim();
}

// ---- cross-market drift guard -------------------------------------------
// A DACH/EU CV must never mention the UK visa story; a UK CV must never
// mention the Blue Card. Throws so batch drivers record the row as failed
// instead of shipping a hedged CV.
const UK_STORY_RE = /UK Graduate [Vv]isa|no sponsorship (needed|required)|kein Sponsoring/;
const EU_STORY_RE = /Blue.?Card/i;
function assertNoCrossMarketLeak(html, market, label = 'CV') {
  const h = String(html || '');
  if ((market === 'dach' || market === 'eu') && UK_STORY_RE.test(h)) {
    throw new Error(`${label}: UK visa story leaked into a ${market.toUpperCase()}-market CV — market-tail guard`);
  }
  if (market === 'uk' && EU_STORY_RE.test(h)) {
    throw new Error(`${label}: Blue Card story leaked into a UK-market CV — market-tail guard`);
  }
  if (market === 'other' && (UK_STORY_RE.test(h) || EU_STORY_RE.test(h))) {
    throw new Error(`${label}: visa story leaked into an 'other'-market CV (should carry none) — market-tail guard`);
  }
}

// ---- Profile-section guards ---------------------------------------------
// The Profile paragraph is POSITIONING — role, capability, stack, domain,
// and the visa/availability tail. These guards enforce that:
//   assertNoProfileMetrics — no percentages, AUC/F1/etc., "N+ tests" phrases,
//     decimal scores (0.94), day-cycle metrics. Numbers belong in Experience
//     and Projects. Tenure ("3 years") is allowed.
//   assertNoProfileHistory — no 4-digit years and no employer / university
//     names (Experience owns those, Education owns institutions). The
//     visa/availability tail is stripped before scanning so target-market
//     signals don't false-positive.
//   assertNoAspirationalLanguage — a language level stated with a hedge
//     ("working towards B2", "in Vorbereitung auf B2", "and improving")
//     reads as "not there yet". State the level as a present-tense fact.
//
// Employer/institution/city bans are user-specific; extend the regexes below
// or wire this from config if you want them for your CV.
const PROFILE_METRIC_RES = [
  { re: /\b(AUC|ROC[-\s]?AUC|C[-\s]?index|F1|precision(?:\s+and\s+recall)?|recall|accuracy)\b/i, kind: 'named-metric' },
  { re: /\d+(?:\.\d+)?\s*%/, kind: 'percentage' },
  { re: /\b\d+\+\s*(?:dbt|test|pytest|model|pipeline|record|bug|API|schedule|hour|day|week|month|year)/i, kind: 'count-plus' },
  { re: /~\s*\d+(?:\.\d+)?/, kind: 'approx-number' },
  { re: /\b0\.\d+\b/, kind: 'decimal-score' },
  { re: /\b\d+\s+(?:[A-Za-z][A-Za-z-]*\s+){0,2}(?:dbt|pytest|tests?|models?|bugs?|schedules?|extractors?|pipelines?|APIs?)\b/i, kind: 'named-count' },
  { re: /\b\d+[-\s]day\s+(?:report|reporting|cycle|latency)/i, kind: 'day-cycle' },
];

const PROFILE_HISTORY_RES = [
  { re: /\b(19|20)\d{2}\b/, kind: 'year' },
  // Generic "University of X" / "Universität X" patterns. Add your own
  // employer / institution / city names here if you want them enforced.
  { re: /\b(?:University|Universität|Uni)\s+of\s+\w+/i, kind: 'institution' },
];

// Availability sentence forms that can appear inside the Profile <p> tail
// depending on how the paragraph was assembled. Stripped before the
// history/metric scans so target-market signals do not false-positive.
const AVAIL_STRIP_RE = /\b(?:available\s+(?:immediately|from\s+offer)|verfügbar(?:\s+ab)?|ab\s+sofort\s+verfügbar|relocation\s+to\s+Germany\s+planned)/i;

function extractProfileText(html) {
  const m = String(html || '').match(/<h2[^>]*>\s*(?:Profile|Profil)\s*<\/h2>([\s\S]*?)(?=<h2[\s>])/i);
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function stripProfileTail(text) {
  const parts = String(text || '').split(/(?<=[.!?])\s+(?=[A-Z])/);
  return parts.filter(s => !VISA_SENTENCE_RE.test(s) && !AVAIL_STRIP_RE.test(s)).join(' ').trim();
}

function assertNoProfileMetrics(html, label = 'CV') {
  const text = extractProfileText(html);
  if (!text) return;
  for (const { re, kind } of PROFILE_METRIC_RES) {
    const m = text.match(re);
    if (m) {
      const idx = text.search(re);
      const ctx = text.slice(Math.max(0, idx - 30), Math.min(text.length, idx + 60)).replace(/\s+/g, ' ').trim();
      throw new Error(`${label}: Profile section contains ${kind} "${m[0]}" - Profile is positioning, not proof. Metrics belong in Experience/Projects. Context: "...${ctx}..."`);
    }
  }
}

function assertNoProfileHistory(html, label = 'CV') {
  const raw = extractProfileText(html);
  if (!raw) return;
  const residual = stripProfileTail(raw);
  if (!residual) return;
  for (const { re, kind } of PROFILE_HISTORY_RES) {
    const m = residual.match(re);
    if (m) {
      const idx = residual.search(re);
      const ctx = residual.slice(Math.max(0, idx - 30), Math.min(residual.length, idx + 60)).replace(/\s+/g, ' ').trim();
      throw new Error(`${label}: Profile section contains ${kind} "${m[0]}" - Profile is positioning, not history. Dates, employer names, universities, and non-target-country references belong in Experience / Projects / Education. Context: "...${ctx}..."`);
    }
  }
}

// A language level stated with a hedge reads as "not there yet". The CV's
// Languages / Sprachen section carries the level as a plain fact, so any
// hedge in the body is both a duplicate and a downgrade.
const ASPIRATIONAL_LANG_RES = [
  { re: /\bin Vorbereitung auf\s+[ABC][12]\b/i, kind: 'aspirational German level' },
  { re: /\bin aktiver Vertiefung\b/i, kind: 'aspirational German level' },
  { re: /\b(?:German|Deutsch)[^.;]{0,24}\b(?:and improving|und wird vertieft)\b/i, kind: 'aspirational German level' },
  { re: /\bworking towards?\s+[ABC][12]\b/i, kind: 'aspirational language level' },
  { re: /\bnoch nicht verhandlungssicher\b/i, kind: 'negative German-level framing' },
  { re: /\bnur grundlegende Kenntnisse\b/i, kind: 'under-selling German-level framing' },
  { re: /\blimited working proficiency\b/i, kind: 'deficit language framing (LinkedIn-ese)' },
];

function assertNoAspirationalLanguage(html, label = 'CV') {
  const text = extractVisibleText(html);
  for (const { re, kind } of ASPIRATIONAL_LANG_RES) {
    const m = text.match(re);
    if (!m) continue;
    const idx = text.search(re);
    const ctx = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 60)).replace(/\s+/g, ' ').trim();
    throw new Error(`${label}: ${kind} "${m[0]}" in CV body - state the level as a present-tense fact, never with a hedge. The Languages section already carries it. Context: "...${ctx}..."`);
  }
}

function extractVisibleText(html) {
  // State-machine parser (see scripts/text-safety.cjs). CodeQL rejects
  // regex tag-stripping — even the loop-until-stable variant — under
  // js/bad-tag-filter + js/incomplete-multi-character-sanitization.
  return stripHtml(html);
}

// ---- banned-content guard -----------------------------------------------
// Hard grep-level gates on rendered CV content. Currently enforces only the
// em-dash ban (the primary "signs of AI writing" tell) on visible body
// text. Employer / project bans are user-specific; extend BANNED_TEXT_RES
// if you want them.
const EM_DASH_RE = /—/;

function assertNoBannedContent(html, label = 'CV') {
  const text = extractVisibleText(html);
  if (EM_DASH_RE.test(text)) {
    const idx = text.search(EM_DASH_RE);
    const ctx = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 40)).replace(/\s+/g, ' ').trim();
    throw new Error(`${label}: em dash (U+2014) in CV body - a primary "signs of AI writing" tell. Use hyphens or full stops instead. Context: "...${ctx}..."`);
  }
}

// Same guard for cover-letter markdown / plain text. No HTML stripping —
// CL source is Markdown, all characters are visible.
function assertNoBannedContentText(text, label = 'CL') {
  const t = String(text || '');
  if (EM_DASH_RE.test(t)) {
    const idx = t.search(EM_DASH_RE);
    const ctx = t.slice(Math.max(0, idx - 40), Math.min(t.length, idx + 40)).replace(/\s+/g, ' ').trim();
    throw new Error(`${label}: em dash (U+2014) in cover letter - a primary "signs of AI writing" tell. Use hyphens or full stops instead. Context: "...${ctx}..."`);
  }
}

module.exports = {
  resolveMarket, visaLine, availabilityLine, stripVisaSentences, assertNoAspirationalLanguage,
  assertNoCrossMarketLeak, assertNoBannedContent, assertNoBannedContentText,
  assertNoProfileMetrics, assertNoProfileHistory, extractProfileText,
};
