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
    ukEn: 'Available immediately', ukDe: 'Ab sofort verfügbar',
    euEn: immediate ? 'Available immediately' : `Available from ${MONTHS_EN[mo - 1]} ${y}`,
    euDe: immediate ? 'Ab sofort verfügbar' : `Verfügbar ab ${MONTHS_DE[mo - 1]} ${y}`,
  };
}
const AVAIL = computeAvail();

const UK_MARKET_RE = /^(uk|gb|united kingdom|great britain|england|scotland|wales|northern ireland)$/i;

// Resolve the availability phrase for a given market + language.
function availFor(market, lang) {
  const isUK = String(market || '').toUpperCase() === 'UK' || UK_MARKET_RE.test(String(market || ''));
  if (lang === 'de') return isUK ? AVAIL.ukDe : AVAIL.euDe;
  return isUK ? AVAIL.ukEn : AVAIL.euEn;
}

// Work-ELIGIBILITY phrase per market. States eligibility to work, NOT location
// or remote. Reads config/profile.yml for the primary-market summary and the
// UK-sponsorship flag; other markets get a generic phrase.
function eligibilityFor(market, lang) {
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

// Availability + eligibility as ONE finished sentence pair. When a
// cv/market-tail.cjs module is available (v2.4 helper), the non-UK start-date
// wording is read from it — the SAME source the CV renders from, so the CV
// and the letter cannot drift on the availability line. Falls back to the
// simple availFor/eligibilityFor pair when market-tail is absent.
function workStatusSentence(market, lang) {
  const m = String(market || '').trim();
  if (UK_MARKET_RE.test(m) || /^UK$/i.test(m)) {
    const avail = lang === 'de' ? AVAIL.ukDe : AVAIL.ukEn;
    const elig = eligibilityFor('UK', lang);
    return elig ? `${avail}, ${elig}.` : `${avail}.`;
  }
  try {
    const MT = require('../../cv/market-tail.cjs');
    if (MT && typeof MT.availabilityLine === 'function' && typeof MT.resolveMarket === 'function') {
      let avail = MT.availabilityLine(MT.resolveMarket(m, { lang }), lang) || '';
      avail = avail.replace(/\s*\.\s*$/, '');
      if (avail) {
        avail = avail.charAt(0).toUpperCase() + avail.slice(1);
        const elig = eligibilityFor(m, lang);
        return elig ? `${avail}. ${elig}.` : `${avail}.`;
      }
    }
  } catch { /* market-tail optional; fall through */ }
  const avail = lang === 'de' ? AVAIL.euDe : AVAIL.euEn;
  const elig = eligibilityFor(m, lang);
  return elig ? `${avail}, ${elig}.` : `${avail}.`;
}

// Strip DACH gender markers from a role title so only the clean title is
// written in the letter. Removes "(m/w/d)", "(m/f/d)", "(w/m/d)", "(m/w/x)",
// "(d/m/w)", "(all genders)", "(gn)", "(divers)" and similar. Leaves
// non-gender parentheticals (e.g. "(Berlin)", "(Sales)") intact.
function stripGenderMarker(s) {
  if (!s) return s;
  return s
    // Decode common HTML entities that leak in from scraped titles. Decode
    // "&amp;" LAST so an "&amp;lt;" payload cannot double-decode to "<"
    // (js/double-escaping).
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
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
  // Analyst-shaped experience. Populate from the candidate's own analyst work.
  analyst_reporting: 'In prior analyst work I replaced manual spreadsheet reporting with live dashboards. Leadership reporting went from a multi-day lag to current, and the team recovered analyst-hours a week that had been spent rebuilding the same numbers.',
  analyst_crm_quality: 'I owned CRM data across acquisition, conversion, and retention. Rebuilding the underlying data layer as one source of truth cut lead response time, lifted conversion, and removed a large share of duplicates and errors the old layer carried.',
  analyst_portfolio: 'I have done portfolio-analytics work on loan and repayment data: Python and SQL analysis surfaced through BI dashboards that lifted monitoring efficiency and cut manual data entry.',
  analyst_governance: 'I contributed to a data-integrity overhaul that improved core dataset accuracy in months and materially reduced the risk of faulty downstream decisions. I also re-mapped a governance workflow and instrumented stage-level reporting, cutting approval turnaround.',
};

const ANGLE_BRIDGE_EN = {
  // Each bridge must END DIFFERENTLY. Ending three of these on the same
  // phrase puts the same six-word shingles in every letter that picks those
  // angles and is a direct contributor to CL_REPETITIVE.
  modelling: 'That kind of warehouse groundwork is what I want to carry into the next role.',
  infrastructure: 'That cost-and-correctness frame is what I want to bring next.',
  data_quality: 'That CI-gated discipline is what I want to apply at scale next.',
  internal_product: 'I want to keep building data layers that people actually use.',
  attribution: 'Deterministic business logic is the kind of problem I want more of.',
  sole_owner: 'That end-to-end ownership is how I prefer to work.',
  analyst_reporting: 'Getting decision-makers off stale spreadsheets is the part of the job I enjoy most.',
  analyst_crm_quality: 'Analysis is only worth as much as the data underneath it, which is where I start.',
  analyst_portfolio: 'I like analytical work where a wrong number has a consequence attached.',
  analyst_governance: 'Measuring a process is usually the first step to fixing it.',
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
  analyst_reporting: 'In vorherigen Analystentätigkeiten habe ich das manuelle Tabellen-Reporting durch Live-BI-Dashboards ersetzt. Das Management-Reporting ging von mehreren Tagen Verzug auf tagesaktuell, und dem Team blieben mehrere Analystenstunden pro Woche.',
  analyst_crm_quality: 'Ich habe CRM-Daten über Akquise, Conversion und Retention verantwortet. Der Neuaufbau der Datenebene als Single Source of Truth senkte die Reaktionszeit auf Leads, steigerte die Conversion und beseitigte einen erheblichen Teil der Dubletten und Fehler.',
  analyst_portfolio: 'Ich habe Portfolio-Analytik auf Kredit- und Rückzahlungsdaten geleistet: Auswertungen in Python und SQL, aufbereitet in BI-Dashboards, steigerten die Effizienz der Rückzahlungsüberwachung und reduzierten manuelle Dateneingabe.',
  analyst_governance: 'Ich habe an einer Datenqualitätsinitiative mitgewirkt, die die Genauigkeit der Kerndatensätze binnen Monaten verbesserte und das Risiko fehlerhafter nachgelagerter Entscheidungen deutlich senkte. Zudem habe ich einen Governance-Prozess neu abgebildet und die Durchlaufzeit spürbar verkürzt.',
};

const ANGLE_BRIDGE_DE = {
  modelling: 'Genau diese dbt- und Kimball-Erfahrung möchte ich als Nächstes einbringen.',
  infrastructure: 'Diese Verbindung aus Kosteneffizienz und Korrektheit suche ich in der nächsten Rolle.',
  data_quality: 'Genau diese CI-gesicherte Disziplin möchte ich im nächsten Schritt im größeren Maßstab anwenden.',
  internal_product: 'Ich möchte weiterhin Datenschichten bauen, die tatsächlich genutzt werden.',
  attribution: 'Deterministische Business-Logik ist die Art von Aufgabe, von der ich mehr übernehmen möchte.',
  sole_owner: 'Dieses End-to-End-Ownership-Profil bringe ich gern in Ihr Team ein.',
  analyst_reporting: 'Entscheider von veralteten Tabellen wegzubekommen ist der Teil der Arbeit, der mir am meisten liegt.',
  analyst_crm_quality: 'Eine Auswertung taugt nur so viel wie die Daten darunter, und genau dort setze ich an.',
  analyst_portfolio: 'Ich arbeite gern analytisch dort, wo eine falsche Zahl echte Folgen hat.',
  analyst_governance: 'Einen Prozess zu messen ist meist der erste Schritt, ihn zu verbessern.',
};

// ── Closers (EN + DE) ────────────────────────────────────────────
// Built per call because the third closer states availability, which is
// market-dependent.
function pickCloser(appId, lang, market) {
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

// Deterministic closer selection.
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

// ── First-12-months contribution clause ────────────────────────
// Draws its anchor X from matchBrief.strong_matches[0] (the JD term with
// strongest CV evidence). Returns a fallback line when there is no strong
// match — a generic-but-honest commitment beats silence and preserves the
// CL_NO_IMPACT gate.
//
// A bare tool token cannot be the grammatical object of "contribute to":
// "contribute concretely to dbt" reads as contributing to the dbt project
// itself, and "contribute concretely to Python" to the language. Wrap a bare
// token into a noun phrase; an anchor that already carries a head noun
// ("your dbt and semantic-layer work") is used unchanged.
const ANCHOR_HEAD_NOUN = /\b(work|layer|pipeline|platform|stack|models?|modell?ing|design|buildout|services?|warehouse|analysis|analytics|reporting|infrastructure|orchestration)\b/i;
const ANCHOR_HEAD_NOUN_DE = /\b(Arbeit|Schicht|Pipeline|Plattform|Modellierung|Design|Warehouse|Analyse|Reporting|Infrastruktur|Orchestrierung)\b/i;

// Presentation-clean a researched fact before it goes into prose.
//
// research.js stores facts as scaffolds written for a machine, not a reader:
// "JD names tech stack: Databricks, BigQuery, Tableau, Python, Looker, go,
// Java, java, React, react." and "JD mentions Data Platform team." Two
// problems when that text is embedded verbatim:
//   - "JD" is the insider abbreviation letter-gates catches, and it can
//     arrive through the FACT rather than through anything the composer wrote.
//   - stack lists are long, unordered and full of case duplicates, which
//     reads as a scrape and blows the technical-density budget on its own.
// Cleaned here rather than in research.js on purpose: the brief should stay
// a faithful record of the posting. Presentation is the composer's job.
function cleanFactText(text, category) {
  let t = String(text || '').trim();
  if (!t) return t;
  t = t.replace(/^\s*JDs?\b\s*/i, 'The posting ');
  if (category === 'tech_stack') {
    const m = /names?\s+(?:tech\s+stack:\s*)?(.+?)(?:\s+in its stack)?\.?\s*$/i.exec(
      t.replace(/^\s*(?:The posting|The role)\s+/i, ''));
    if (m && m[1]) {
      const seen = new Set();
      const tools = m[1].split(/,\s*|\s+and\s+/).map(x => x.trim()).filter(x => {
        const k = x.toLowerCase();
        if (!x || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (tools.length) {
        const named = tools.slice(0, 2).join(' and ');
        return tools.length > 2 ? `The posting names ${named} among others.` : `The posting names ${named}.`;
      }
    }
  }
  return t;
}

// ── Motivation: why THIS employer, and what the candidate is looking for ──
//
// The 5-paragraph spine answered "what have you done" and never "why us".
// Two halves, both required by letter-gates:
//   - a reason tied to this employer, using a RESEARCHED fact when one exists.
//     Never invents one: with no facts it anchors on the role and the company
//     name instead, which is honest and still specific to the application.
//   - what the candidate is looking for, read from config/profile.yml
//     narrative.looking_for. Three phrasings picked deterministically by
//     appId, because one fixed sentence in every letter is exactly how a
//     letter pool reaches high shingle overlap.
let _profileNarrative = null;
function profileNarrative() {
  if (_profileNarrative) return _profileNarrative;
  _profileNarrative = {};
  try {
    const yaml = require('js-yaml');
    const p = path.resolve(__dirname, '..', '..', '..', 'config', 'profile.yml');
    _profileNarrative = (yaml.load(fs.readFileSync(p, 'utf8')) || {}).narrative || {};
  } catch { /* no profile: the caller falls back to a neutral line */ }
  return _profileNarrative;
}

function buildMotivation({ company, factsPicked, language, appId, jobTitle }) {
  const nar = profileNarrative();
  const list = (language === 'de' ? nar.looking_for_de : nar.looking_for) || [];
  const idx = list.length ? closerIndex(appId) % list.length : 0;
  const want = list[idx] || (language === 'de'
    ? 'ein Team, das Datenqualität ernst nimmt'
    : 'a team that treats data quality as a first-class concern');

  // Prefer a fact the OPENER did not already use.
  const fact = factsPicked && factsPicked.length > 1 ? factsPicked[1] : null;
  const claim = fact && (fact.claim || fact.fact)
    ? cleanFactText(String(fact.claim || fact.fact).replace(/\s+/g, ' ').trim(), fact.category)
    : '';

  if (language === 'de') {
    const why = claim
      ? `Warum ${company}: ${claim.replace(/\.$/, '')}. `
      : `Warum ${company}: die Rolle verbindet ${jobTitle || 'diese Aufgabe'} mit einer Datenbasis, die wirklich tragen muss. `;
    return `${why}Ich suche ${want}.`;
  }
  const why = claim
    ? `Why ${company} in particular: ${claim.replace(/\.$/, '')}. `
    : `Why ${company} in particular: the role puts ${jobTitle || 'this work'} on a data layer that has to hold up in production, not just in a report. `;
  return `${why}What I am looking for is ${want}.`;
}

function buildContributionClause(matchBrief, language) {
  const strong = (matchBrief && matchBrief.match_summary && matchBrief.match_summary.strong_matches) || [];
  if (!strong.length || !strong[0].jd_term) {
    return language === 'de'
      ? 'In den ersten 12 Monaten möchte ich vor allem dafür sorgen, dass die Zahlen, auf die sich das Team stützt, automatisch geprüft sind, bevor jemand sie in einer Entscheidung verwendet.'
      : 'In the first 12 months I would want the numbers the team relies on to be checked automatically before anyone builds a decision on them.';
  }
  const rawAnchor = strong[0].jd_term;
  // German carries the preposition INSIDE the anchor: wrapping a bare token
  // yields "…-Arbeit" (die Arbeit), which takes dative "zur", not "zu".
  const anchor = language === 'de'
    ? (ANCHOR_HEAD_NOUN_DE.test(rawAnchor) ? `zu ${rawAnchor}` : `zur ${rawAnchor}-Arbeit`)
    : (ANCHOR_HEAD_NOUN.test(rawAnchor) ? rawAnchor : `the ${rawAnchor} work`);
  if (language === 'de') {
    return `In den ersten 12 Monaten kann ich konkret ${anchor} beitragen, aufbauend auf der gleichen CI-gesicherten Modellierungsdisziplin, die meine bisherige Datenarbeit trägt.`;
  }
  return `In the first 12 months I can contribute concretely to ${anchor}, building on the same CI-gated modelling discipline that carries my prior data work.`;
}

// ── ¶1: Opener (per language) ─────────────────────────────────
function buildOpener({ company, factsPicked, jobTitle, language, advertDate, sourcePortal }) {
  const POS = language === 'de' ? POSITIONING_DE : POSITIONING_EN;
  // Advert-context prefix: DACH letters open with "Ihre Ausschreibung vom
  // [Datum] auf [Portal]" when either field is present. English letters get
  // a lighter "on [Portal]" mention. Missing fields degrade cleanly.
  let advertPrefix = '';
  if (language === 'de') {
    if (advertDate && sourcePortal) advertPrefix = `Ihre Ausschreibung vom ${formatDateGerman(advertDate)} auf ${sourcePortal} habe ich mit Interesse gelesen. `;
    else if (sourcePortal) advertPrefix = `Ihre Ausschreibung auf ${sourcePortal} habe ich mit Interesse gelesen. `;
    else if (advertDate) advertPrefix = `Ihre Ausschreibung vom ${formatDateGerman(advertDate)} habe ich mit Interesse gelesen. `;
  } else if (sourcePortal) {
    if (!sourcePortal.includes('.')) advertPrefix = `Your ${sourcePortal} posting for ${jobTitle || 'this role'} caught my eye. `;
  }
  if (factsPicked.length === 0) {
    // No researched facts. Say LESS rather than padding. The previous
    // fact-less fallback asserted that the job ad names the job title, which
    // is circular and shipped as identical text in every fact-less letter.
    if (language === 'de') {
      const intro = advertPrefix ? '' : `Ich bewerbe mich auf die Position als ${jobTitle || 'diese Rolle'}. `;
      return `${advertPrefix}${intro}${POS}`;
    }
    // "the <title>" alone is ungrammatical when the title is a bare role
    // name: "apply for the Data Scientist". A head noun is required, and
    // "role" reads naturally after any job title.
    const intro = advertPrefix ? '' : `I am writing to apply for the ${jobTitle || 'advertised'} role. `;
    return `${advertPrefix}${intro}${POS}`;
  }
  // Prefer a fact that is ABOUT the company over one that recites its stack.
  // Opening on a tech_stack fact reads the employer their own requirements
  // back, and was the single largest source of technical density outside ¶3.
  const nonStack = factsPicked.find(x => x && x.category !== 'tech_stack');
  let f = nonStack || factsPicked[0];
  if (f && f.fact) f = { ...f, fact: cleanFactText(f.fact, f.category) };
  let hook;
  if (language === 'de') {
    switch (f.category) {
      case 'product': hook = `${company}: ${f.fact} Genau diese Stelle wäre die richtige Position für mich.`; break;
      case 'engineering_blog': hook = `${f.fact} Genau diese Arbeit möchte ich als Nächstes machen.`; break;
      case 'tech_stack': {
        // The tech_stack fact is stored as an English scaffold ("The role
        // names X, Y in its stack.") in research.js. Embedding it verbatim
        // opened German letters with an English sentence. Re-express the
        // stack list in German here.
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
      // Grounded phrasing: the fact lists the FULL posting stack, which
      // usually includes tools outside the production evidence base.
      case 'tech_stack': hook = `${f.fact} That stack maps closely onto the way I already work.`; break;
      case 'news': hook = `${f.fact} That context is what made me apply specifically here.`; break;
      default: hook = `${f.fact}`;
    }
  }
  return `${advertPrefix}${hook} ${POS}`;
}

// ── ¶3: Mapping (per language) ───────────────────────────────
// Requirement -> experience -> outcome, verbally explicit. Cited evidence is
// pulled from cvMaster.evidence_points keyed by the chosen angle, so every
// number in the sentence is corpus-verified — nothing here is free text the
// model wrote.
const ANGLE_OUTCOME_DE = {
  modelling: 'dimensionale Modelle über Staging, Intermediate und Marts auf einem deduplizierten Spine',
  infrastructure: 'inkrementelle Modelle mit deutlich reduzierter täglicher Pipeline-Rechenlast',
  data_quality: 'automatisierte Tests im CI, die Datenqualitätsfehler bereits im ersten Produktions-Build abfangen',
  attribution: 'eine deterministische Klassifikationskette, die jeden Datensatz eindeutig einer Entität zuordnet',
  internal_product: 'eine Service-Schicht mit interner Oberfläche über mehrere Ergebnistypen',
  sole_owner: 'die Datenebene als alleiniger Architekt mit hohem Solo-Commit-Anteil',
};
function buildMapping(matchSummary, language, opts = {}) {
  const strong = matchSummary.strong_matches || [];
  const transferable = matchSummary.transferable_matches || [];
  const gaps = matchSummary.gaps || [];
  // Capped at 2. Four named terms turn ¶3 into a stack recital and make it
  // the single biggest contributor to CL_TOO_TECHNICAL. Two still proves the
  // posting was read, without asking a hiring manager to parse a tool list.
  const MAX_NAMED_JD_TERMS = 2;
  const strongTerms = strong.slice(0, MAX_NAMED_JD_TERMS).map(m => m.jd_term);
  // ¶2 already tells the story for opts.angle, so the mapping sentence must
  // cite a DIFFERENT evidence point — same numbers twice in one letter reads
  // as padding. Complement rule: modelling is the general warehouse-build
  // claim and pairs with any specialised angle; when ¶2 itself ran on
  // modelling, data_quality is the complement.
  const angle = opts.angle || 'modelling';
  const complement = angle === 'modelling' ? 'data_quality' : 'modelling';
  const evidence = (opts.evidencePoints || []).find(e => e.category === complement);
  if (language === 'de') {
    let lead = '';
    if (strongTerms.length && ANGLE_OUTCOME_DE[complement]) {
      lead = `Sie suchen ${strongTerms.join(', ')}: genau diese Arbeit habe ich bereits geliefert, konkret ${ANGLE_OUTCOME_DE[complement]}.`;
    } else if (strongTerms.length) {
      lead = `Auf dem Stack, den die Rolle benennt (${strongTerms.join(', ')}) habe ich Produktionserfahrung aus meinen bisherigen Positionen und Projekten.`;
    }
    let trans = '';
    if (transferable.length) trans = ` ${transferable[0].jd_term} steht auf meiner Skills-Liste aus Studium und Eigenprojekten; die Modellierungsdisziplin dahinter überträgt sich direkt aus meiner Produktionsarbeit.`;
    let disclosure = '';
    if (gaps.length) {
      const g = gaps[0];
      disclosure = ` Eine Lücke benenne ich offen: ${g.jd_term} ist nicht Teil meiner Produktionsstack-Erfahrung. Die Modellierungs- und Engineering-Muster übertragen sich, und ich erwarte, innerhalb des ersten Sprints produktiv zu sein.`;
    }
    if (!lead) return `Die Rollenanforderungen passen eng zu meiner bisherigen Arbeit: produktionsreife Datenebene durchgängig, CI-gesichert, mit internen Produkt-Oberflächen neben dem Warehouse.${trans}${disclosure}`;
    return `${lead}${trans}${disclosure}`;
  }
  // EN
  // "You are asking for X" only earns its place when X actually distinguishes
  // the posting. When every named term is a commodity skill, the sentence
  // reduces a specialist role to the two things every data ad lists and reads
  // as if the JD was skimmed. In that case lead with the evidence and let the
  // terms ride along as the medium, not the headline. `commodity` is set
  // upstream in match.js.
  const namedAllCommodity = strongTerms.length > 0 && strong.slice(0, MAX_NAMED_JD_TERMS).every(mm => mm.commodity);
  const listTerms = (t) => (t.length <= 1 ? t[0] : `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`);
  let lead = '';
  if (strongTerms.length && evidence && !namedAllCommodity) {
    lead = `You are asking for ${strongTerms.join(', ')}. That is the work I have already shipped: ${evidence.claim}.`;
  } else if (strongTerms.length && evidence) {
    lead = `Work I have already shipped: ${evidence.claim}. ${listTerms(strongTerms)} run through all of it.`;
  } else if (strongTerms.length) {
    lead = `On the stack the role names (${strongTerms.join(', ')}) I have production evidence across my previous roles and projects.`;
  }
  let trans = '';
  if (transferable.length) trans = ` ${transferable[0].jd_term} sits on my skills list from study and personal-project work, and the modelling discipline behind it transfers directly from what I have run in production.`;
  let disclosure = '';
  if (gaps.length) {
    const g = gaps[0];
    disclosure = ` I am honest about the gap: ${g.jd_term} is not in my production stack. The modelling and engineering patterns transfer, and I would expect to be productive within the first sprint.`;
  }
  if (!lead) return `The role requirements map closely to my previous work: production data layer end to end, CI-gated, with internal product surfaces alongside the warehouse.${trans}${disclosure}`;
  return `${lead}${trans}${disclosure}`;
}

// ── Posted-band guard ─────────────────────────────────────
// The salary_range anchors are generic per-market numbers. Quoting them
// against a role whose posting names a LOWER band is an instant reject.
// Rules: parse the band from the JD when present; clamp our range inside
// it; if even our minimum exceeds the posted maximum, say nothing about
// salary and leave it for negotiation.
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
  // Postfix currency (German convention): "62.000 € bis 75.000 €"
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
  const min = Math.min(salary.min, band.max);
  const max = Math.min(salary.max, band.max);
  return {
    ...salary,
    min,
    max,
    clamped_to_band: salary.max > band.max,
    // Both ends clamp to band.max, so an ask whose floor sits at or above
    // the posted ceiling collapses to a single point. A range whose ends
    // are equal reads as a hard demand, or as a formatting bug. Callers
    // must render it as ONE figure.
    degenerate: min === max,
  };
}

// ── ¶4: Availability + salary (per language + market) ────────
function buildAvailability({ salary, country, city, language, salaryInLetter, route, market, postedBand }) {
  const mkt = market || country || (route && route.market);
  const workStatus = workStatusSentence(mkt, language);
  const boundedSalary = clampToBand(salary, postedBand);
  if (language === 'de') {
    // DACH convention: a Gehaltsvorstellung in the Anschreiben is expected,
    // so keep it whenever the route asks for it — but band-clamped.
    let line = workStatus;
    if (salaryInLetter && boundedSalary) {
      const cur = boundedSalary.currency === 'GBP' ? '£' : boundedSalary.currency === 'EUR' ? '€' : boundedSalary.currency === 'CHF' ? 'CHF ' : '$';
      const fmt = (n) => n.toLocaleString('de-DE');
      const basisNote = boundedSalary.basis === '14' ? ' (auf Basis von 14 Gehältern)' : '';
      // A degenerate clamp must not print "65.000 bis 65.000".
      line += boundedSalary.degenerate
        ? ` Meine Gehaltsvorstellung liegt bei ${cur}${fmt(boundedSalary.max)} brutto pro Jahr${basisNote}.`
        : ` Meine Gehaltsvorstellung liegt bei ${cur}${fmt(boundedSalary.min)} bis ${cur}${fmt(boundedSalary.max)} brutto pro Jahr${basisNote}.`;
    }
    return line;
  }
  // EN/UK convention: volunteering a number unprompted is unusual and can
  // only hurt. Only state a range when the posting explicitly requires one.
  let line = workStatus;
  if (route && route.salary_required && boundedSalary) {
    const cur = boundedSalary.currency === 'GBP' ? '£' : boundedSalary.currency === 'EUR' ? '€' : boundedSalary.currency === 'CHF' ? 'CHF ' : '$';
    const fmt = (n) => n.toLocaleString('en-GB');
    const basisNote = boundedSalary.basis === '14' ? ' (on a 14-month basis)' : '';
    line += boundedSalary.degenerate
      ? ` Targeting ${cur}${fmt(boundedSalary.max)} gross per year${basisNote}, in line with your published band.`
      : ` Targeting a range of ${cur}${fmt(boundedSalary.min)} to ${cur}${fmt(boundedSalary.max)} gross per year${basisNote}.`;
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

// ── DIN 5008 renderer (DE or EN prose, German structure) ──────
function composeDin5008({ brief, matchBrief, cvMaster, jobUrl, today, route }) {
  const language = route.letter_language;
  const company = stripGenderMarker(brief.company) || guessCompanyFromUrl(jobUrl) || (language === 'de' ? 'Ihr Team' : 'your team');
  const ROLE_LABEL = { ae: 'Analytics Engineer', ds: 'Data Scientist', de: 'Data Engineer', da: 'Data Analyst', me: 'Machine Learning Engineer', master: 'Data role' };
  const jobTitle = stripGenderMarker(brief.job_title) || ROLE_LABEL[matchBrief.cv_variant] || (language === 'de' ? 'die Position' : 'this role');
  const factsPicked = matchBrief.company_facts_to_reference || [];
  const angle = matchBrief.employer_angle || matchBrief.experience_angle || 'modelling';

  const reference = brief.reference_code ? (language === 'de' ? `, Referenz ${brief.reference_code}` : `, Ref. ${brief.reference_code}`) : '';

  const date = today || new Date().toISOString().slice(0, 10);
  const dateFmt = language === 'de' ? formatDateGerman(date) : formatDateEnglish(date);

  // Body
  const p1 = buildOpener({
    company, factsPicked, jobTitle, language,
    advertDate: brief.advert_date || null,
    sourcePortal: brief.source_portal || null,
  });
  const leadCat = language === 'de' ? ANGLE_LEAD_DE : ANGLE_LEAD_EN;
  const bridgeCat = language === 'de' ? ANGLE_BRIDGE_DE : ANGLE_BRIDGE_EN;
  // A key missing from either catalogue used to interpolate the literal
  // string "undefined" straight into the letter body. Fall back to the safe
  // angle rather than ship that, and say so in the audit block.
  const safeAngle = (leadCat[angle] && bridgeCat[angle]) ? angle : 'modelling';
  const p2 = `${leadCat[safeAngle]} ${bridgeCat[safeAngle]}`;
  const p3 = buildMapping(matchBrief.match_summary, language,
    { angle, evidencePoints: (cvMaster && cvMaster.evidence_points) || [] });
  const availLine = buildAvailability({
    salary: matchBrief.salary_range, country: route.market, city: matchBrief.city,
    language, salaryInLetter: !!matchBrief.salary_in_letter || !!route.salary_required, route, market: route.market,
    postedBand: matchBrief.posted_band || detectPostedBand(brief && brief.jd_text) || detectPostedBand(matchBrief.jd_text),
  });
  // Prepend the "first 12 months contribution" clause. buildContributionClause
  // now returns a fallback line when there is no strong match, so this
  // always renders — no empty-string case.
  const contributionLine = buildContributionClause(matchBrief, language);
  const p4 = contributionLine ? `${contributionLine} ${availLine}` : availLine;
  // Motivation sits AFTER the evidence and BEFORE availability/closing: the
  // reader has been given a reason to care by then, and "why you" lands
  // better as a considered conclusion than as an opening assertion.
  const pWhy = buildMotivation({
    company, factsPicked, language,
    appId: matchBrief.application_id, jobTitle,
  });
  const p5 = pickCloser(matchBrief.application_id, language, route.market);

  // Envelope (DIN 5008 sender + recipient blocks)
  const senderBlock = language === 'de'
    ? `${cvMaster.name}\n${cvMaster.contact.location_de}\n${cvMaster.contact.phone} · ${cvMaster.contact.email}`
    : `${cvMaster.name}\n${cvMaster.contact.location_en}\n${cvMaster.contact.phone} · ${cvMaster.contact.email}`;
  const attn = language === 'de'
    ? (brief.contact_name ? `z. Hd. ${brief.contact_name}` : 'Personalabteilung / Recruiting-Team')
    : (brief.contact_name ? `Attn: ${brief.contact_name}` : 'Hiring Team');
  // DIN 5008 puts the postcode before the town ("10117 Berlin"); UK and
  // Irish addresses invert it ("London, EC3R 5BU"). Using the German order
  // on a London recipient reads as a mail-merge artefact.
  const ukStyleAddress = /^(UK|GB|IE)$/i.test(route.market || '');
  const cityLine = (ukStyleAddress
    ? [brief.company_city, brief.company_postal_code].filter(Boolean).join(', ')
    : [brief.company_postal_code, brief.company_city].filter(Boolean).join(' ')
  ).trim();
  // Envelope company line uses legal form when known. The stripped
  // `company` name may already include the legal form (if research pulled
  // it from JSON-LD hiringOrganization.name); the split guard avoids
  // double-appending a suffix.
  const companyLine = brief.company_legal_form && !new RegExp(`\\b${brief.company_legal_form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b$`).test(company)
    ? `${company} ${brief.company_legal_form}`
    : company;
  const recipientBlock = [
    companyLine,
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

  // §9.9: German takes NO comma after "Mit freundlichen Grüßen".
  const signOff = language === 'de' ? `Mit freundlichen Grüßen\n${cvMaster.name}` : `Best regards,\n${cvMaster.name}`;
  const anlagenLabel = route.market === 'CH' ? 'Beilagen' : 'Anlagen';
  const anlagen = language === 'de' ? `\n\n${anlagenLabel}: Lebenslauf, relevante Zeugnisse` : `\n\nAttachments: CV, certificates`;

  let body = `${senderBlock}\n\n${recipientBlock}\n\n${dateLine}\n\n${betreff}\n\n${salutation}\n\n${p1}\n\n${p2}\n\n${p3}\n\n${pWhy}\n\n${p4}\n\n${p5}\n\n${signOff}${anlagen}`;
  if (route.market === 'CH' && language === 'de') {
    // Swiss orthography: ß → ss
    body = body.replace(/ß/g, 'ss');
  }
  const footer = buildAuditFooter({
    route, matchBrief, factsPicked, angle, safeAngle,
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

function buildAuditFooter({ route, matchBrief, factsPicked, angle, safeAngle = angle, closer_index, form }) {
  const facts = factsPicked.map((f, i) => `  - f${i+1}: ${f.fact}\n    (source: ${f.source})`).join('\n');
  return `\n\n<!--
audit:
  form: ${form}
  market: ${route.market}
  letter_language: ${route.letter_language}
  variant: ${matchBrief.cv_variant}
  experience_angle: ${safeAngle}${safeAngle === angle ? '' : ` (requested ${angle}, missing from catalogue)`}
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
  // ALL cover letters use the DIN 5008 business-letter format. `anglo_full`
  // is retired; any legacy/cached anglo_full route renders as din5008_en
  // (formal envelope, English body). German-language → din5008_de.
  if (route.letter_form === 'anglo_full') route = { ...route, letter_form: 'din5008_en', letter_language: route.letter_language || 'en' };
  return composeDin5008({ brief, matchBrief, cvMaster, jobUrl, today, route });
}

module.exports = { compose, scrubBanned, composeDin5008, formatDateGerman, formatDateEnglish, detectPostedBand, clampToBand, ANGLE_LEAD_EN, ANGLE_LEAD_DE, cleanFactText, buildMotivation, buildContributionClause };
