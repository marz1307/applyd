// cover-letters/lib/draft-v2.js — Stage 3, market-routed drafter.
//
// Routes on route.letter_form: anglo_full | din5008_de | din5008_en.
// Body logic (5-paragraph spine, angle-based evidence, opener/closer, gap)
// is preserved from v1 draft.js; envelope changes per form.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ── Profile config loader ─────────────────────────────────────────────────
// Reads candidate details from config/profile.yml for use in templates.
function loadProfileConfig() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
    const get = (key) => { const m = raw.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`)); return m ? m[1].trim() : null; };
    return {
      portfolioUrl: get('portfolio_url') || '',
      eligibilitySummary: get('summary') || '',
      needsUkSponsorship: /needs_uk_sponsorship:\s*true/i.test(raw),
    };
  } catch {
    return { portfolioUrl: '', eligibilitySummary: '', needsUkSponsorship: false };
  }
}
const PROFILE = loadProfileConfig();

// ── Dynamic availability — two-track, single source: config/profile.yml ──
// TWO TRACKS, because the work authorisation may differ by market:
//   • Primary market — if the candidate has right to work (no sponsorship needed),
//                      ALWAYS "available immediately", regardless of availability_from.
//   • Other markets  — may need visa processing + relocation lead time,
//                      so they follow availability_from ("YYYY-MM"; immediate once past).
// The CL must NOT hardcode the month AND must NOT apply relocation lead time
// to markets where the candidate already has right to work.
function computeAvail() {
  const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const MONTHS_DE = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  let y = null, mo = null;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
    const m = raw.match(/availability_from:\s*"?(\d{4})-(\d{2})"?/);
    if (m) { y = parseInt(m[1], 10); mo = parseInt(m[2], 10); }
  } catch { /* fall through to immediate */ }
  const now = new Date();
  const immediate = !y || y < now.getFullYear() || (y === now.getFullYear() && mo <= now.getMonth() + 1);
  return {
    // Primary market track — immediate if candidate has right to work there.
    ukEn: 'Available immediately', ukDe: 'Ab sofort verfügbar',
    // Secondary market track — availability_from driven (visa/relocation lead time).
    euEn: immediate ? 'Available immediately' : `Available from ${MONTHS_EN[mo - 1]} ${y}`,
    euDe: immediate ? 'Ab sofort verfügbar' : `Verfügbar ab ${MONTHS_DE[mo - 1]} ${y}`,
  };
}
const AVAIL = computeAvail();

// Resolve the availability phrase for a given market + language.
// Primary market → immediate track; other markets → visa/relocation track.
function availFor(market, lang) {
  const isUK = String(market || '').toUpperCase() === 'UK';
  if (lang === 'de') return isUK ? AVAIL.ukDe : AVAIL.euDe;
  return isUK ? AVAIL.ukEn : AVAIL.euEn;
}

// Work-ELIGIBILITY phrase per market (pairs with availFor's availability phrase).
// Reads work_eligibility from config/profile.yml. States eligibility to work,
// NOT location or remote.
function eligibilityFor(market, lang) {
  // If the profile has a summary, use it as-is for the primary market.
  // For other markets, generate a generic phrase.
  const summary = PROFILE.eligibilitySummary;
  const m = String(market || '').toUpperCase();
  if (m === 'UK') {
    if (PROFILE.needsUkSponsorship) {
      return lang === 'de'
        ? 'Sponsoring für UK Skilled Worker Visa erforderlich'
        : 'UK Skilled Worker visa sponsorship required';
    }
    return lang === 'de'
      ? 'mit Arbeitsrecht im Vereinigten Königreich'
      : (summary || 'with right to work in the UK');
  }
  const cn = m === 'DE' ? (lang === 'de' ? ' für Deutschland' : ' for Germany')
    : m === 'AT' ? (lang === 'de' ? ' für Österreich' : ' for Austria') : '';
  return lang === 'de' ? `Arbeitsberechtigt${cn}` : `Eligible to work${cn}`;
}

// Strip DACH gender markers from a role title so only the clean title is written
// in the letter (2026-07-01). Removes "(m/w/d)", "(m/f/d)", "(w/m/d)",
// "(m/w/x)", "(d/m/w)", "(all genders)", "(gn)", "(divers)" and similar. Leaves
// non-gender parentheticals (e.g. "(Berlin)", "(Sales)") intact.
function stripGenderMarker(s) {
  if (!s) return s;
  return s
    // Decode common HTML entities that leak in from scraped titles (& < > ' ").
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/\s*[\(\[]\s*(?:(?:[mwfdxiagn]|divers|gn)(?:\s*[\/|·]\s*(?:[mwfdxiagn]|divers|gn))+|all\s+genders?|gender[-\s]?neutral|geschlechtsneutral|gn|divers)\s*[\)\]]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Angle evidence catalogue (EN) ────────────────────────────────
// Populate these from cv.md and article-digest.md during onboarding.
// Each entry should describe a specific production achievement.
const ANGLE_LEAD_EN = {
  modelling: 'In my most recent role I built the warehouse from the schema up: dimensional models across staging, intermediate, and marts layers, with canonical entity resolution that closed record-matching gaps across the business.',
  infrastructure: 'I cut daily pipeline compute significantly by re-architecting high-volume models as incremental on an append-only raw layer with deterministic hash IDs, delivering measurable cost savings with zero added infrastructure overhead.',
  data_quality: 'I locked correctness end to end: comprehensive dbt and pytest tests gated through CI, catching data-quality bugs during the first production build. Silent metric drift now surfaces in CI, not in the boardroom.',
  internal_product: 'I treated the data layer as a product, not a report. I shipped the API service layer and internal UI alongside the warehouse, giving stakeholders a single workflow and producing the first labelled outcomes dataset for downstream modelling.',
  attribution: 'I lifted attribution accuracy to auditor-defensible by designing a deterministic classification chain mapping every record to a single entity. This replaced a best-guess join and closed outstanding findings in the metrics review.',
  sole_owner: 'I was sole architect and author of the data layer for a multi-tier platform: the only data engineer on the build, primary author across multiple backend domains, and shipping engineer on the customer-facing frontend.',
};

const ANGLE_BRIDGE_EN = {
  modelling: 'That dbt-and-Kimball muscle is the seat I am looking for next.',
  infrastructure: 'That cost-and-correctness frame is what I want to bring next.',
  data_quality: 'That CI-gated discipline is what I want to apply at scale next.',
  internal_product: 'That data-as-product instinct is the seat I am looking for next.',
  attribution: 'That deterministic-business-logic discipline is the seat I am looking for next.',
  sole_owner: 'That end-to-end ownership is the working mode I want to bring next.',
};

// ── Angle evidence catalogue (DE) ────────────────────────────────
// Populate these from cv.md and article-digest.md during onboarding.
const ANGLE_LEAD_DE = {
  modelling: 'In meiner letzten Position habe ich das Warehouse von Grund auf aufgebaut: dimensionale Modelle ueber Staging-, Intermediate- und Marts-Ebenen auf einem deduplizierten Account-Spine, mit einer einheitlichen kanonischen ID, die Matching-Luecken im gesamten Unternehmen geschlossen hat.',
  infrastructure: 'Ich habe die taegliche Pipeline-Rechenzeit deutlich reduziert, indem ich hochvolumige Modelle als inkrementell auf einer Append-Only-Raw-Schicht mit deterministischen Hash-IDs umarchitektiert habe. Messbare Kosteneinsparungen bei null zusaetzlichen Infrastrukturkosten.',
  data_quality: 'Ich habe Korrektheit durchgaengig abgesichert: umfassende dbt- und pytest-Tests ueber die CI, wodurch Datenqualitaetsfehler im ersten Produktionsbuild aufgedeckt und behoben wurden. Stille Metrik-Drift wird jetzt in CI gefangen, nicht im Vorstandsmeeting.',
  internal_product: 'Ich habe die Datenebene als Produkt behandelt, nicht als Bericht. Ich habe den API-Service-Layer und das interne UI ausgeliefert und den Stakeholdern einen einheitlichen Workflow gegeben sowie den ersten gelabelten Ergebnisdatensatz fuer nachgelagertes Modelling erzeugt.',
  attribution: 'Ich habe die Attributionsgenauigkeit auf auditorensicher gehoben, indem ich eine deterministische Klassifizierungskette entworfen habe, die jeden Datensatz eindeutig einer Entitaet zuordnet. Das ersetzte eine Best-Guess-Logik und schloss offene Findings im Metrikreview.',
  sole_owner: 'Ich war alleiniger Architekt und Autor der Datenebene einer mehrstufigen Plattform: einziger Data Engineer im Build, primaerer Autor ueber mehrere Backend-Domaenen, mit hohem alleinigem Commit-Anteil.',
};

const ANGLE_BRIDGE_DE = {
  modelling: 'Genau diese dbt- und Kimball-Erfahrung möchte ich als Nächstes einbringen.',
  infrastructure: 'Genau diese Verbindung aus Kosteneffizienz und Korrektheit möchte ich als Nächstes einbringen.',
  data_quality: 'Genau diese CI-gesicherte Disziplin möchte ich im nächsten Schritt im größeren Maßstab anwenden.',
  internal_product: 'Genau diese Data-as-Product-Haltung ist die Position, die ich als Nächstes suche.',
  attribution: 'Genau diese deterministische Business-Logik möchte ich als Nächstes einbringen.',
  sole_owner: 'Genau dieses End-to-End-Ownership-Profil möchte ich als Nächstes einbringen.',
};

// ── Closers (EN + DE) ────────────────────────────────────────────
// Built per call because the third closer states availability, which is
// market-dependent (primary market immediate vs visa/relocation track).
function pickCloser(appId, lang, market) {
  // NOTE (2026-07-03): the old third closer restated availability, which ¶4
  // already carries. Replaced with a work-sample closer.
  const portfolio = PROFILE.portfolioUrl;
  const portfolioEN = portfolio ? ` My portfolio is at ${portfolio} and the CV is attached.` : ' The CV is attached.';
  const portfolioEN2 = portfolio ? ` The CV is attached and the portfolio sits at ${portfolio}.` : ' The CV is attached.';
  const portfolioEN3 = portfolio ? ` CV attached; portfolio at ${portfolio}.` : ' CV attached.';
  const portfolioDE = portfolio ? ` Mein Portfolio finden Sie unter ${portfolio}, der Lebenslauf liegt bei.` : ' Der Lebenslauf liegt bei.';
  const portfolioDE2 = portfolio ? ` Der Lebenslauf liegt bei, das Portfolio finden Sie unter ${portfolio}.` : ' Der Lebenslauf liegt bei.';
  const portfolioDE3 = portfolio ? ` Lebenslauf liegt bei, Portfolio unter ${portfolio}.` : ' Lebenslauf liegt bei.';
  const CLOSERS_EN = [
    `Happy to talk through any of this.${portfolioEN}`,
    `I would like to discuss how I would ship the first 90 days here.${portfolioEN2}`,
    `If a working session is more useful than an interview, I am glad to walk through my most relevant build step by step.${portfolioEN3}`,
  ];
  const CLOSERS_DE = [
    `Ueber die Details spreche ich gern in einem Gespraech.${portfolioDE}`,
    `Ich wuerde gern besprechen, wie ich die ersten 90 Tage hier gestalten wuerde.${portfolioDE2}`,
    `Wenn eine Arbeitsprobe aussagekraeftiger ist als ein klassisches Gespraech, gehe ich meinen relevantesten Build gern Schritt fuer Schritt durch.${portfolioDE3}`,
  ];
  const arr = lang === 'de' ? CLOSERS_DE : CLOSERS_EN;
  return arr[closerIndex(appId)];
}

// Deterministic closer selection — both languages have 3 closers, so the index
// is language-independent. Exposed so buildAuditFooter can record it without
// reaching into pickCloser's now-local arrays.
function closerIndex(appId) {
  const h = crypto.createHash('md5').update(String(appId || 'x')).digest();
  return h[0] % 3;
}

// ── Positioning lines — set in config/profile.yml (positioning_en / positioning_de) ──
function loadPositioning() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
    const getVal = (key) => { const m = raw.match(new RegExp(`${key}:\\s*"([^"]+)"`)); return m ? m[1] : null; };
    return {
      en: getVal('positioning_en') || 'I build reliable data systems and turn them into decision-ready products.',
      de: getVal('positioning_de') || 'Ich baue zuverlaessige Datensysteme und mache sie entscheidungsreif.',
    };
  } catch {
    return {
      en: 'I build reliable data systems and turn them into decision-ready products.',
      de: 'Ich baue zuverlaessige Datensysteme und mache sie entscheidungsreif.',
    };
  }
}
const _POS = loadPositioning();
const POSITIONING_EN = _POS.en;
const POSITIONING_DE = _POS.de;

// ── ¶1: Opener (per language) ─────────────────────────────────
function buildOpener({ company, factsPicked, jobTitle, language }) {
  const POS = language === 'de' ? POSITIONING_DE : POSITIONING_EN;
  if (factsPicked.length === 0) {
    if (language === 'de') {
      return `Die Stellenbeschreibung benennt ${jobTitle || 'die Position'} und den Schwerpunkt des Teams, was genau dem entspricht, was ich als Nächstes suche. ${POS}`;
    }
    return `The role description names ${jobTitle || 'this seat'} and the team's focus, which is what I look for in my next move. ${POS}`;
  }
  const f = factsPicked[0];
  let hook;
  if (language === 'de') {
    switch (f.category) {
      case 'product': hook = `${company}: ${f.fact} Genau diese Stelle wäre die richtige Position für mich.`; break;
      case 'engineering_blog': hook = `${f.fact} Genau diese Arbeit möchte ich als Nächstes machen.`; break;
      case 'tech_stack': {
        // The tech_stack fact is stored as an English scaffold
        // ("The role names X, Y in its stack.") in research.js. Embedding it
        // verbatim opened German letters with an English sentence (shipped
        // defect, 2026-07-08). Re-express the stack list in German here.
        const mStack = /names?\s+(.+?)\s+in its stack/i.exec(f.fact);
        const terms = mStack ? mStack[1] : null;
        hook = terms
          ? `Die Ausschreibung benennt ${terms} im Stack. Das ist der Stack, auf dem ich produktiv geliefert habe.`
          : `Das ist genau der Stack, auf dem ich produktiv geliefert habe.`;
        break;
      }
      case 'news': hook = `${f.fact} Genau dieser Kontext hat mich auf Sie aufmerksam gemacht.`; break;
      default: hook = `${f.fact}`;
    }
  } else {
    switch (f.category) {
      case 'product': hook = `${company}: ${f.fact} That is the seat I am applying for.`; break;
      case 'engineering_blog': hook = `${f.fact} That is the work I want to do next.`; break;
      // Grounded phrasing: the fact lists the FULL posting stack, which usually
      // includes tools outside the production evidence base — "shipped on" was
      // an overclaim (Siemens letter claimed shipped-on Kafka/Airflow). ¶3
      // carries the honest strong/transferable split; the hook stays modest.
      case 'tech_stack': hook = `${f.fact} That stack maps closely onto the way I already work.`; break;
      case 'news': hook = `${f.fact} That context is what made me apply specifically here.`; break;
      default: hook = `${f.fact}`;
    }
  }
  return `${hook} ${POS}`;
}

// ── ¶3: Mapping (per language) ───────────────────────────────
function buildMapping(matchSummary, language) {
  const strong = matchSummary.strong_matches || [];
  const transferable = matchSummary.transferable_matches || [];
  const gaps = matchSummary.gaps || [];
  const strongTerms = strong.slice(0, 4).map(m => m.jd_term);
  // Evidence sources from cv.md — referenced generically so any candidate's
  // production experience is cited without hardcoding employer names.
  if (language === 'de') {
    let lead = '';
    if (strongTerms.length) lead = `Auf dem Stack, den die Rolle benennt — ${strongTerms.join(', ')} — habe ich Produktionserfahrung aus meinen bisherigen Positionen und Projekten.`;
    let trans = '';
    if (transferable.length) trans = ` ${transferable[0].jd_term} steht auf meiner Skills-Liste aus Studium und Eigenprojekten; die Modellierungsdisziplin uebertraegt sich direkt aus meiner Produktionsarbeit.`;
    let disclosure = '';
    if (gaps.length) {
      const g = gaps[0];
      disclosure = ` Eine Luecke benenne ich offen: ${g.jd_term} ist nicht Teil meiner Produktionsstack-Erfahrung. Die Modellierungs- und Engineering-Muster uebertragen sich, und ich erwarte, innerhalb des ersten Sprints produktiv zu sein.`;
    }
    if (!lead) return `Die Rollenanforderungen passen eng zu meiner bisherigen Arbeit: produktionsreife Datenebene durchgaengig, CI-gesichert, mit internen Produkt-Oberflaechen neben dem Warehouse.${trans}${disclosure}`;
    return `${lead}${trans}${disclosure}`;
  }
  // EN
  let lead = '';
  if (strongTerms.length) lead = `On the stack the role names — ${strongTerms.join(', ')} — I have production evidence across my previous roles and projects.`;
  let trans = '';
  if (transferable.length) trans = ` ${transferable[0].jd_term} sits on my skills list from study and personal-project work; the modelling discipline transfers directly from my production work.`;
  let disclosure = '';
  if (gaps.length) {
    const g = gaps[0];
    disclosure = ` I am honest about the gap: ${g.jd_term} is not in my production stack. The modelling and engineering patterns transfer, and I would expect to be productive within the first sprint.`;
  }
  if (!lead) return `The role requirements map closely to my previous work: production data layer end to end, CI-gated, with internal product surfaces alongside the warehouse.${trans}${disclosure}`;
  return `${lead}${trans}${disclosure}`;
}

// ── Posted-band guard (added 2026-07-03) ──────────────────────
// The salary_range anchors are generic per-market numbers. Quoting them
// against a role whose posting names a LOWER band is an instant reject
// (a real case: an anchor of £60-75k went out against a posted £33-40k
// band). Rules: parse the band from the JD when present; clamp our range
// inside it; if even our minimum exceeds the posted maximum, say nothing
// about salary and leave it for negotiation.
function detectPostedBand(text) {
  if (!text) return null;
  const t = String(text);
  const num = (s) => { let n = parseFloat(s.replace(/[.,](?=\d{3}\b)/g, '')); if (n < 1000) n *= 1000; return n; };
  const toCur = (sym) => /£|GBP/i.test(sym) ? 'GBP' : /€|EUR/i.test(sym) ? 'EUR' : 'USD';
  // Prefix currency: "£33,000 - £40,000", "$60k to $75k"
  let m = t.match(/([£€$])\s?(\d{2,3}(?:[.,]\d{3})?)\s?k?\s?(?:-|–|—|to|bis)\s?(?:[£€$]\s?)?(\d{2,3}(?:[.,]\d{3})?)\s?k?\b/i);
  if (m) {
    const min = num(m[2]), max = num(m[3]);
    if (min > 10000 && max >= min) return { min, max, currency: toCur(m[1]) };
  }
  // Postfix currency (German convention): "62.000 € bis 75.000 €", "55.000-70.000 EUR"
  m = t.match(/(\d{2,3}(?:[.,]\d{3})?)\s?k?\s?(?:€|EUR|GBP|CHF)?\s?(?:-|–|—|to|bis)\s?(\d{2,3}(?:[.,]\d{3})?)\s?k?\s?(€|EUR|£|GBP)/i);
  if (m) {
    const min = num(m[1]), max = num(m[2]);
    if (min > 10000 && max >= min) return { min, max, currency: toCur(m[3]) };
  }
  return null;
}

function clampToBand(salary, band) {
  if (!salary) return null;
  if (!band || band.currency !== salary.currency) return salary;
  if (salary.min > band.max) return null; // asking above the whole band: omit
  return {
    ...salary,
    min: Math.min(salary.min, band.max),
    max: Math.min(salary.max, band.max),
    clamped_to_band: salary.max > band.max,
  };
}

// ── ¶4: Availability + salary (per language + market) ────────
function buildAvailability({ salary, country, city, language, salaryInLetter, route, market, postedBand }) {
  const mkt = market || country || (route && route.market);
  const avail = availFor(mkt, language);
  const boundedSalary = clampToBand(salary, postedBand);
  // State availability to start + work eligibility, market-dependent.
  // No location / remote / EMEA framing.
  if (language === 'de') {
    // DACH convention: a Gehaltsvorstellung in the Anschreiben is expected,
    // so keep it whenever the route asks for it — but band-clamped.
    let line = `${avail}, ${eligibilityFor(mkt, 'de')}.`;
    if (salaryInLetter && boundedSalary) {
      const cur = boundedSalary.currency === 'GBP' ? '£' : boundedSalary.currency === 'EUR' ? '€' : boundedSalary.currency === 'CHF' ? 'CHF ' : '$';
      const fmt = (n) => n.toLocaleString('de-DE');
      const basisNote = boundedSalary.basis === '14' ? ' (auf Basis von 14 Gehältern)' : '';
      line += ` Meine Gehaltsvorstellung liegt bei ${cur}${fmt(boundedSalary.min)} bis ${cur}${fmt(boundedSalary.max)} brutto pro Jahr${basisNote}.`;
    }
    return line;
  }
  // EN/UK convention: volunteering a number unprompted is unusual and can
  // only hurt. Only state a range when the posting explicitly requires one
  // (route.salary_required), and even then band-clamped.
  let line = `${avail}, ${eligibilityFor(mkt, 'en')}.`;
  if (route && route.salary_required && boundedSalary) {
    const cur = boundedSalary.currency === 'GBP' ? '£' : boundedSalary.currency === 'EUR' ? '€' : boundedSalary.currency === 'CHF' ? 'CHF ' : '$';
    const fmt = (n) => n.toLocaleString('en-GB');
    const basisNote = boundedSalary.basis === '14' ? ' (on a 14-month basis)' : '';
    line += ` Targeting a range of ${cur}${fmt(boundedSalary.min)} to ${cur}${fmt(boundedSalary.max)} gross per year${basisNote}.`;
  }
  return line;
}

// ── Banned-phrase scrub (v1 + v2 kill-list) ────────────────────
const BANNED_EN = [
  /\bpassionate about\b/gi, /\bresults[- ]driven\b/gi, /\bthrive in fast[- ]paced\b/gi,
  /\bI am writing to express my (?:keen |sincere )?interest\b/gi, /\bnot\s+\w+,?\s+but\s+\w+/g,
  /\bI would be an asset to\b/gi, /\bI look forward to discussing my qualifications\b/gi,
  /\bfirstly\b|\bsecondly\b|\blastly\b/gi,
  /—/g,
  /\bI would welcome the chance to discuss\b/gi,
];
const BANNED_DE = [
  /\bich bewerbe mich hiermit\b/gi, /\bmit großem Interesse\b/gi, /\bich freue mich auf\b/gi,
  /\bteamfähig(?:keit)?\b/gi, /\bbelastbar\b/gi,
  /—/g,
];

function scrubBanned(text, language) {
  let t = text;
  const banned = language === 'de' ? BANNED_DE : BANNED_EN;
  for (const re of banned) t = t.replace(re, (m) => m === '—' ? ',' : '');
  return t.replace(/  +/g, ' ').replace(/\s+,/g, ',').replace(/\s+\./g, '.');
}

// (composeAngloFull retired 2026-07-01 — all letters now use the DIN 5008
// renderer below; English-market letters route to din5008_en.)

// ── DIN 5008 renderer (DE or EN prose, German structure) ──────
function composeDin5008({ brief, matchBrief, cvMaster, jobUrl, today, route }) {
  const language = route.letter_language;
  const company = stripGenderMarker(brief.company) || guessCompanyFromUrl(jobUrl) || (language === 'de' ? 'Ihr Team' : 'your team');
  const ROLE_LABEL = { ae: 'Analytics Engineer', ds: 'Data Scientist', de: 'Data Engineer', da: 'Data Analyst', me: 'Machine Learning Engineer', master: 'Data role' };
  const jobTitle = stripGenderMarker(brief.job_title) || ROLE_LABEL[matchBrief.cv_variant] || (language === 'de' ? 'die Position' : 'this role');
  const factsPicked = matchBrief.company_facts_to_reference || [];
  const angle = matchBrief.employer_angle || 'modelling';

  const reference = brief.reference_code ? (language === 'de' ? `, Referenz ${brief.reference_code}` : `, Ref. ${brief.reference_code}`) : '';

  // Date — German format
  const date = today || new Date().toISOString().slice(0, 10);
  const dateFmt = language === 'de' ? formatDateGerman(date) : formatDateEnglish(date);

  // Body
  const p1 = buildOpener({ company, factsPicked, jobTitle, language });
  const leadCat = language === 'de' ? ANGLE_LEAD_DE : ANGLE_LEAD_EN;
  const bridgeCat = language === 'de' ? ANGLE_BRIDGE_DE : ANGLE_BRIDGE_EN;
  const p2 = `${leadCat[angle]} ${bridgeCat[angle]}`;
  const p3 = buildMapping(matchBrief.match_summary, language);
  const p4 = buildAvailability({
    salary: matchBrief.salary_range, country: route.market, city: matchBrief.city,
    language, salaryInLetter: !!matchBrief.salary_in_letter || !!route.salary_required, route, market: route.market,
    postedBand: matchBrief.posted_band || detectPostedBand(brief && brief.jd_text) || detectPostedBand(matchBrief.jd_text),
  });
  const p5 = pickCloser(matchBrief.application_id, language, route.market);

  // Envelope (DIN 5008 sender + recipient blocks)
  const senderBlock = language === 'de'
    ? `${cvMaster.name}\n${cvMaster.contact.location_de}\n${cvMaster.contact.phone} · ${cvMaster.contact.email}`
    : `${cvMaster.name}\n${cvMaster.contact.location_en}\n${cvMaster.contact.phone} · ${cvMaster.contact.email}`;
  // DIN 5008 Anschrift (recipient block): company, attention line (named hiring
  // manager if known, else the hiring/recruiting team), then the postal address
  // (street, PLZ + city, country) using whatever the research brief captured.
  // Degrades gracefully — omits any line that is absent.
  const attn = language === 'de'
    ? (brief.contact_name ? `z. Hd. ${brief.contact_name}` : 'Personalabteilung / Recruiting-Team')
    : (brief.contact_name ? `Attn: ${brief.contact_name}` : 'Hiring Team');
  const cityLine = [brief.company_postal_code, brief.company_city].filter(Boolean).join(' ').trim();
  const recipientBlock = [
    company,
    attn,
    brief.company_address || null,
    cityLine || null,
    brief.company_country || null,
  ].filter(Boolean).join('\n');
  // City for date line — must come from cvMaster, no hardcoded fallback.
  const cityDe = (cvMaster.contact.location_de || '').split(',')[0].trim();
  const cityEn = (cvMaster.contact.location_en || '').split(',')[0].trim();
  const dateLine = language === 'de'
    ? (cityDe ? `${cityDe}, ${dateFmt}` : dateFmt)
    : (cityEn ? `${cityEn}, ${dateFmt}` : dateFmt);
  const betreff = language === 'de'
    ? `**Bewerbung als ${jobTitle}${reference}**`
    : `**Application: ${jobTitle}${reference}**`;
  const salutation = language === 'de'
    ? (brief.contact_name ? `Sehr geehrte/r ${brief.contact_name},` : `Sehr geehrte Damen und Herren,`)
    : (brief.contact_name ? `Dear ${brief.contact_name},` : `Dear Hiring Team,`);

  // Sign-off
  // §9.9: German takes NO comma after "Mit freundlichen Grüßen" (the comma was
  // the top shipped defect class — 16 letters — before writing-eval caught it).
  const signOff = language === 'de' ? `Mit freundlichen Grüßen\n${cvMaster.name}` : `Best regards,\n${cvMaster.name}`;
  const anlagenLabel = route.market === 'CH' ? 'Beilagen' : 'Anlagen';
  const anlagen = language === 'de' ? `\n\n${anlagenLabel}: Lebenslauf, relevante Zeugnisse` : `\n\nAttachments: CV, certificates`;

  // CH vs DE orthography
  let body = `${senderBlock}\n\n${recipientBlock}\n\n${dateLine}\n\n${betreff}\n\n${salutation}\n\n${p1}\n\n${p2}\n\n${p3}\n\n${p4}\n\n${p5}\n\n${signOff}${anlagen}`;
  if (route.market === 'CH' && language === 'de') {
    // Swiss orthography: ß → ss
    body = body.replace(/ß/g, 'ss');
  }
  const footer = buildAuditFooter({
    route, matchBrief, factsPicked, angle,
    closer_index: closerIndex(matchBrief.application_id),
    form: route.letter_form,
  });
  return scrubBanned(`${body}${footer}\n`, language);
}

// ── Date formatters ───────────────────────────────────────────
function formatDateGerman(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];
  return `${d}. ${months[m-1]} ${y}`;
}
function formatDateEnglish(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${d} ${months[m-1]} ${y}`;
}

function guessCompanyFromUrl(jobUrl) {
  try {
    const u = new URL(jobUrl);
    const host = u.host.replace(/^www\./, '').split('.')[0];
    return host[0].toUpperCase() + host.slice(1);
  } catch { return null; }
}

function buildAuditFooter({ route, matchBrief, factsPicked, angle, closer_index, form }) {
  const facts = factsPicked.map((f, i) => `  - f${i+1}: ${f.fact}\n    (source: ${f.source})`).join('\n');
  return `\n\n<!--
audit:
  form: ${form}
  market: ${route.market}
  letter_language: ${route.letter_language}
  variant: ${matchBrief.cv_variant}
  employer_angle: ${angle}
  closer_index: ${closer_index}
  facts_used:
${facts || '    (none: generic role opener)'}
  salary_anchor: ${matchBrief.salary_range?.anchor_key || 'n/a'}
  salary_in_letter: ${!!matchBrief.salary_in_letter || !!route.salary_required}
  salary_basis: ${matchBrief.salary_range?.basis || '12'}
  has_gap_to_disclose: ${matchBrief.has_gap_to_disclose}
  german_language_gate: ${route.german_language_gate}
  requires_native_proofread: ${route.requires_native_proofread}
-->`;
}

// ── Main dispatch ─────────────────────────────────────────────
function compose({ brief, matchBrief, cvMaster, jobUrl, today, route }) {
  if (!route) route = { letter_form: 'din5008_en', letter_language: 'en', market: 'UK', salary_required: false };
  // ALL cover letters use the DIN 5008 business-letter format (2026-07-01).
  // `anglo_full` is retired; any legacy/cached anglo_full route renders as
  // din5008_en (formal envelope, English body). German-language → din5008_de.
  if (route.letter_form === 'anglo_full') route = { ...route, letter_form: 'din5008_en', letter_language: route.letter_language || 'en' };
  return composeDin5008({ brief, matchBrief, cvMaster, jobUrl, today, route });
}

module.exports = { compose, scrubBanned, composeDin5008, formatDateGerman, formatDateEnglish, detectPostedBand, clampToBand, ANGLE_LEAD_EN, ANGLE_LEAD_DE };
