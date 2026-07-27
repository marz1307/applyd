// cover-letters/lib/router.js — Stage 0: Route.
//
// Deterministic, ordered rules from cover-letter-generator-spec-v2.md §2.2.
// First matching rule wins. No fuzzy matching. Same discipline as the CV
// variant selector. Inputs come from research.js (posting_lang,
// company_country, cover_letter_required) or override args.
'use strict';

// Country normalisation
const DACH = new Set(['DE', 'AT', 'CH']);
const ANGLO_UK = new Set(['UK', 'GB', 'GBR', 'United Kingdom', 'Ireland', 'IE', 'IRL']);
const EU_INTL = new Set(['NL', 'BE', 'LU', 'FR', 'ES', 'PT', 'IT', 'SE', 'DK', 'NO', 'FI', 'PL']);

function normCountry(c) {
  if (!c) return null;
  const s = String(c).trim();
  if (DACH.has(s)) return s;
  if (/germany/i.test(s)) return 'DE';
  if (/austria/i.test(s) || /^österreich/i.test(s)) return 'AT';
  if (/switzerland|schweiz/i.test(s)) return 'CH';
  if (/united kingdom|^uk$|^gb$|england|scotland|wales|northern ireland/i.test(s)) return 'UK';
  if (/^ireland$|^ie$/i.test(s)) return 'IE';
  if (/netherlands|^nl$/i.test(s)) return 'NL';
  if (/france|^fr$/i.test(s)) return 'FR';
  if (/spain|^es$/i.test(s)) return 'ES';
  if (/portugal|^pt$/i.test(s)) return 'PT';
  if (/italy|^it$/i.test(s)) return 'IT';
  if (/sweden|^se$/i.test(s)) return 'SE';
  if (/poland|^pl$/i.test(s)) return 'PL';
  if (/belgium|^be$/i.test(s)) return 'BE';
  return s.slice(0, 3).toUpperCase();
}

// Detect posting language by counting German-specific tokens against
// English-specific ones. Threshold tuned for ATS/JD pages.
function detectPostingLanguage(text) {
  if (!text) return null;
  const t = text.slice(0, 30000);  // cap for speed
  // Strong DE markers
  const deMarkers = [
    /\b(und|oder|der|die|das|den|dem|des|für|mit|sind|wird|werden|nicht|sehr|sowie|über|durch|gegen|bzw\.?)\b/gi,
    /\b(Anschreiben|Bewerbung|Lebenslauf|Gehaltsvorstellung|Eintrittstermin|Personalabteilung|Sehr geehrte|Wir bieten|Über uns|Deine Aufgaben|Dein Profil)\b/gi,
    /\b(Mitarbeitende|Mitarbeiter|Mitarbeiterin|Unternehmen|Erfahrung|Kenntnisse|Aufgaben)\b/gi,
    /[äöüÄÖÜß]/g,
  ];
  // Strong EN markers
  const enMarkers = [
    /\b(the|and|of|to|in|for|with|on|at|by|from|or|as|is|are|will|would|should|have|has|been|that|this|which|what|why|how)\b/gi,
    /\b(About us|What you|We're|Required|Responsibilities|Qualifications|Experience with|Apply)\b/gi,
  ];
  let de = 0, en = 0;
  for (const re of deMarkers) de += (t.match(re) || []).length;
  for (const re of enMarkers) en += (t.match(re) || []).length;
  // Need a clear margin to classify as DE
  if (de > en * 1.2) return 'de';
  if (en > de * 1.2) return 'en';
  // Tie-break by umlauts (very strong DE signal)
  if ((t.match(/[äöüß]/gi) || []).length > 10) return 'de';
  return 'en';  // default
}

// Detect whether the posting REQUIRES a cover letter (handles negation).
// "do not require a cover letter" / "no cover letter needed" / "optional" → false.
// Reads each match in context and looks for negation within 30 chars before it.
function detectCoverLetterRequired(text) {
  if (!text) return false;
  const termRe = /\b(anschreiben|cover letter|motivation(?:al)?\s+(?:letter|statement)|bewerbungsschreiben|covering letter|brief de motivation|motivatie)\b/gi;
  const NEG_BEFORE = /\b(don'?t|do not|doesn'?t|does not|no|without|aren'?t required|isn'?t required|not required|optional|nicht)\s+(\w+\s+){0,3}$/i;
  let anyRequired = false;
  let m;
  while ((m = termRe.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (NEG_BEFORE.test(before)) continue;  // negated
    // Also reject "if you'd like" / "optional" within 60 chars after the term
    const after = text.slice(m.index, Math.min(text.length, m.index + 80));
    if (/\b(optional|if you (?:would|'?d) like|if interested)\b/i.test(after)) continue;
    anyRequired = true;
  }
  return anyRequired;
}

// Detect whether the posting asks for salary expectations
function detectSalaryRequired(text) {
  if (!text) return false;
  return /\b(gehaltsvorstellung|salary expectation|salary requirement|expected salary|target salary|desired salary|salary range|gehaltswunsch)\b/gi.test(text);
}

// Detect company country from posting / URL / explicit country field
function detectCompanyCountry({ country, jobUrl, postingText }) {
  // Explicit country wins
  const explicit = normCountry(country);
  if (explicit && (DACH.has(explicit) || ANGLO_UK.has(explicit) || EU_INTL.has(explicit) || explicit.length === 2)) return explicit;
  // URL TLD
  if (jobUrl) {
    try {
      const u = new URL(jobUrl);
      const host = u.host.toLowerCase();
      if (host.endsWith('.de')) return 'DE';
      if (host.endsWith('.at')) return 'AT';
      if (host.endsWith('.ch')) return 'CH';
      if (host.endsWith('.co.uk') || host.endsWith('.uk')) return 'UK';
      if (host.endsWith('.ie')) return 'IE';
      if (host.endsWith('.nl')) return 'NL';
      if (host.endsWith('.fr')) return 'FR';
    } catch {}
  }
  // Posting text mentions a country/city
  if (postingText) {
    const t = postingText.slice(0, 5000);
    if (/\b(Deutschland|Germany|Berlin|München|Munich|Frankfurt|Hamburg|Köln|Cologne|Stuttgart|Düsseldorf|Leipzig|Hannover)\b/i.test(t)) return 'DE';
    if (/\b(Österreich|Austria|Wien|Vienna|Graz|Linz|Salzburg|Innsbruck)\b/i.test(t)) return 'AT';
    if (/\b(Schweiz|Switzerland|Zürich|Zurich|Basel|Bern|Geneva|Genf|Lausanne)\b/i.test(t)) return 'CH';
    if (/\b(United Kingdom|UK|London|Manchester|Edinburgh|Glasgow|Bristol|Leeds|Birmingham|Cambridge|Oxford)\b/i.test(t)) return 'UK';
    if (/\b(Ireland|Dublin|Cork|Galway)\b/i.test(t)) return 'IE';
    if (/\b(Netherlands|Amsterdam|Rotterdam|The Hague|Utrecht|Eindhoven)\b/i.test(t)) return 'NL';
  }
  return null;
}

// Salary convention per market
function salaryConvention(market) {
  if (market === 'AT') return '14-month';
  return '12-month';
}

// ── Main router ──────────────────────────────────────────────────
function route({ appId, postingText, postingLang, country, jobUrl, coverLetterRequired, salaryRequired, brief }) {
  // Auto-detect what wasn't supplied
  const detectedLang = postingLang || detectPostingLanguage(postingText || (brief?.jd_text)) || 'en';
  const detectedCountry = detectCompanyCountry({ country, jobUrl, postingText: postingText || brief?.jd_text }) || null;
  const detectedCL = coverLetterRequired !== undefined ? coverLetterRequired : detectCoverLetterRequired(postingText || brief?.jd_text);
  const detectedSalary = salaryRequired !== undefined ? salaryRequired : detectSalaryRequired(postingText || brief?.jd_text);

  // Apply ordered rules
  let market, letter_language, letter_form, german_language_gate, requires_native_proofread, notes;

  // RULE 1: posting_lang == 'de' → German letter, German structure, gate ON
  if (detectedLang === 'de') {
    letter_language = 'de';
    letter_form = 'din5008_de';
    market = (detectedCountry && (detectedCountry === 'AT' || detectedCountry === 'CH')) ? detectedCountry : 'DE';
    german_language_gate = true;
    requires_native_proofread = true;
    notes = 'RULE 1: German-language posting. DIN 5008 German structure + German prose. Native proofread required before send.';
  }
  // RULE 2: DACH country + English posting → English prose, German structure (priority tier)
  else if (detectedCountry && DACH.has(detectedCountry) && detectedLang === 'en') {
    letter_language = 'en';
    letter_form = 'din5008_en';
    market = detectedCountry;
    german_language_gate = false;
    requires_native_proofread = false;
    notes = 'RULE 2 (priority tier): DACH employer + English posting. German business-letter structure with English prose. No German gate.';
  }
  // RULE 3: Anglo / UK / EU-intl / remote — DACH (DIN 5008) structure, English prose.
  // ALL cover letters use the DIN 5008 business-letter format (recipient Anschrift,
  // Ort+Datum, bold Betreff, formal salutation to the hiring team/manager).
  // `anglo_full` is retired — English-market letters now use din5008_en (same
  // formal envelope, English body).
  else if (detectedCountry && (ANGLO_UK.has(detectedCountry) || EU_INTL.has(detectedCountry))) {
    letter_form = 'din5008_en';
    letter_language = 'en';
    market = detectedCountry;
    german_language_gate = false;
    requires_native_proofread = false;
    notes = 'RULE 3: UK/Anglo/EU-international market. DIN 5008 structure, English prose.';
  }
  // RULE 4: fallthrough — same DIN 5008 English format.
  else {
    letter_form = 'din5008_en';
    letter_language = 'en';
    market = detectedCountry || 'UNKNOWN';
    german_language_gate = false;
    requires_native_proofread = false;
    notes = 'RULE 4 (fallthrough): unknown market or English posting outside DACH. DIN 5008, English prose.';
  }

  return {
    application_id: appId || null,
    market,
    letter_language,
    letter_form,
    cover_letter_required: !!detectedCL,
    recommend_skip: false,  // user decision: always write a full letter
    salary_required: !!detectedSalary,
    salary_convention: salaryConvention(market),
    german_language_gate,
    requires_native_proofread,
    notes,
    detected: {
      posting_lang: detectedLang,
      company_country: detectedCountry,
      explicit_inputs: { postingLang, country, coverLetterRequired, salaryRequired },
    },
  };
}

module.exports = { route, detectPostingLanguage, detectCompanyCountry, detectCoverLetterRequired, detectSalaryRequired, normCountry };
