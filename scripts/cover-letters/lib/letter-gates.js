// letter-gates.js — ONE definition of "is this letter written for the person
// who will actually read it".
//
// Origin. A hand review of one weak generated letter surfaced four counts,
// all of which turned out to be measurable across the corpus:
//
//   1. Too technical: the first reader is a hiring manager, not the tech lead.
//   2. Deficit-led: leading with what you are NOT a match for, before showing
//      what transfers.
//   3. No impact: no forward-looking "what I would DO in the role".
//   4. No motivation: no reason for THIS role at THIS employer, and nothing
//      about what you are looking for.
//
// Measured over 753 letters before choosing any threshold:
//
//   distinct technical terms per letter   p50=8   p75=10  p90=13  max=19
//   letters containing impact language    30%
//   letters containing motivation/why     34%
//   letters with a deficit-led paragraph  ~0%   (that one was a generator
//                                                regression, not a corpus-wide
//                                                habit)
//
// So three of the four are real, widespread, and quantified: the median letter
// names eight tools and never says why this company or what would happen there.
//
// WHY THESE ARE GENERATION-TIME GATES, NOT writing-eval DEFECTS.
// 78% of the CURRENT Stage-3 letters fail impact and motivation. Wiring that
// into writing-eval would take the report from 1 defect to ~51 overnight, all
// on letters already drafted that will never be rewritten (standing rule:
// SOURCE ONLY, NO BACKFILL). An alert nobody can act on is how a report stops
// being read - the exact failure mode that let lunchtime-scan and the Firecrawl
// blindness sit unnoticed for weeks. So these gate NEW letters at generation,
// and writing-eval only reports them for letters dated on or after CUTOFF.
'use strict';

// Cutoff for retro-reporting. Letters written before this date predate the
// gates and are deliberately left alone. Bump it only if the rules change again.
const GATES_ACTIVE_FROM = '2026-08-09';

// ── 1. Technical density ──────────────────────────────────────────────
// Tool names, metric names and jargon a non-technical reader cannot price.
// SQL and Python are deliberately included: they are fine once, and a symptom
// when they arrive with eleven friends. The gate counts DISTINCT terms, not
// occurrences, so naming one stack repeatedly is not punished.
const TECH_TERM_RE = /\b(dbt|pytest|Dagster|Airflow|Prefect|PostgreSQL|Postgres|MySQL|MongoDB|FastAPI|Flask|Django|SHAP|XGBoost|LightGBM|scikit-learn|sklearn|PyTorch|TensorFlow|Keras|C-index|AUC|ROC|RMSE|MAE|p-value|Kimball|star schema|ELT|ETL|Kubernetes|Docker|Terraform|Snowflake|BigQuery|Redshift|Databricks|Spark|Kafka|Looker|Tableau|Power BI|Metabase|Superset|MCP|Model Context Protocol|LLM|RAG|API|SQL|Python|Scala|Java|Git|GitHub Actions|orchestrat\w+|pipelines?|warehouse|schemas?|regression|classification|survival analysis|gradient[- ]boost\w*|feature engineering|hyperparameter)\b/gi;

// Threshold set BELOW the corpus median (8) on purpose. The median letter is
// the problem, so calibrating to it would bless the thing being fixed. The
// A well-rewritten letter typically scores 2-3 distinct terms, so there is real
// headroom for a letter that still names the couple of tools it genuinely needs.
const MAX_DISTINCT_TECH = 6;

function technicalTerms(text) {
  return [...new Set((String(text).match(TECH_TERM_RE) || []).map(s => s.toLowerCase()))];
}

// ── 2. Forward-looking impact ─────────────────────────────────────────
const IMPACT_RE = /\b(I would (?:want|aim|focus|bring|start|spend|help|look to)|in (?:a|the|my) first (?:year|90 days|three months|six months)|what I would bring|I can contribute|contribute concretely|my first priority|would let me)\b/i;
const IMPACT_DE_RE = /\b(m[oö]chte ich|w[uü]rde ich|in den ersten (?:Monaten|Wochen|100 Tagen)|einbringen|beitragen|beisteuern)\b/i;

// ── 3. Motivation: why this role, why this employer, what he wants ────
// A company NAME alone is not motivation - every letter has that in the
// envelope. This looks for an actual reason, plus at least one company-specific
// noun in the body, so "I am excited by your mission" cannot pass on its own.
// `in particular:` sits OUTSIDE the \b group on purpose. A trailing \b after a
// colon can only match when a word character follows it immediately, so
// "Why Acquired in particular: the posting..." never matched and the whole
// alternative was dead — every letter whose why-signal was the "Why X in
// particular:" heading failed CL_NO_MOTIVATION despite carrying exactly the
// content the gate asks for (found 2026-08-10).
const WHY_RE = /\b(why (?:you|your|the role|this role|this team)|what I am looking for|I am looking for|drew me|attracted me|I would rather work|reads that way)\b|in particular:/i;
const WHY_DE_RE = /\b(warum|reizt mich|suche ich|interessiert mich|gerade bei Ihnen)\b/i;

// ── 4. Deficit-led writing ────────────────────────────────────────────
// Honesty stays mandatory: gaps are still disclosed, and nothing here relaxes
// the grounding rules. What this catches is PILING them up - a paragraph that
// is a wall of "I have not / I do not / below the", with no adjacent evidence
// of adaptability. That is the pattern the operator review pushed back on.
// The rule is about ORDER, not volume. Counting deficits alone does not
// separate a good paragraph from a bad one: an early draft opened
// "Two gaps I would rather state than gloss" and listed four, yet contained
// only two regex-visible deficits and the word "improving", so a
// count-plus-presence rule passed it. v3 discloses exactly the same facts and
// reads fine, because the adaptability evidence comes FIRST and the facts land
// as a closing clause.
//
// So: a paragraph fails when it reaches the deficits before it has given the
// reader anything that transfers. An explicit gap ANNOUNCEMENT ("two gaps",
// "where I do not match") is treated as a deficit marker in its own right,
// since that is the phrasing that makes the non-match the headline.
const DEFICIT_RE = /\b(I have not|I do not|I have never|not (?:yet )?(?:in|part of) my|below the|no (?:production )?experience|rather than PyTorch|habe ich nicht|keine Erfahrung|nicht Teil)\b/gi;
const GAP_ANNOUNCE_RE = /\b(\w+ gaps? I (?:would|will)|two gaps|three gaps|where I do not match|to be upfront|I should be upfront|I will not pretend|meine L[uü]cken)\b/i;
// Adaptability markers must be FIRST-PERSON or phrasal. A bare /\blearn\w*/
// looks safe and is not: \b matches after a hyphen, so "scikit-learn" counted
// as evidence of adaptability, and a sentence disclosing "my modelling has been
// in scikit-learn rather than PyTorch" supplied its own alibi. The gate then
// passed the exact paragraph it was written to catch. "machine learning" would
// have done the same. Same family as [[cl-invented-gap-substring-bug]]: never
// let a bare tech-adjacent stem stand in for a claim.
const ADAPT_RE = /\b(I (?:would |can |could )?learn\w*|learned|learning (?:each|as|on|quickly|fast|curve)|taught myself|picked up|adapt\w*|transferr?(?:ed|able|s)?\b|close (?:that|the) gap|pattern I would bring|each layer as I|moving towards|improving|eingearbeitet|angeeignet|übertr[aä]g)/i;
const MIN_DEFICITS_TO_JUDGE = 2;

// Is this paragraph deficit-LED? Not "does it contain deficits" - a letter
// should still disclose them. The question is whether the reader meets the
// non-match before they have been given anything that transfers.
//
// Two ways to fail:
//   a) an explicit gap ANNOUNCEMENT ("Two gaps I would rather state...") with
//      no adaptability before it. This alone is enough: announcing the gaps is
//      making them the headline, whatever follows.
//   b) MIN_DEFICITS_TO_JUDGE or more deficit markers, the first of which lands
//      before any adaptability marker.
//
// Why order and not count: an early draft opened a paragraph with "Two
// gaps I would rather state than gloss", listed four, and still contained only
// two regex-visible deficits plus the word "improving" - so the original
// count-and-presence rule passed it. v3 discloses the SAME facts, reads fine,
// and passes, because "learning each layer as I reached it" arrives first and
// the caveats land as a closing clause. Volume was never the difference.
function analyseDeficitOrder(paragraph, i) {
  const p = String(paragraph);
  DEFICIT_RE.lastIndex = 0;
  const hits = [...p.matchAll(DEFICIT_RE)];
  const ann = p.match(GAP_ANNOUNCE_RE);
  const adapt = p.match(ADAPT_RE);
  const adaptIdx = adapt ? adapt.index : -1;

  const firstDefIdx = Math.min(
    ann ? ann.index : Infinity,
    hits.length ? hits[0].index : Infinity,
  );
  if (!Number.isFinite(firstDefIdx)) {
    return { i, led: false, count: 0, announced: false };
  }
  const count = hits.length + (ann ? 1 : 0);
  const adaptFirst = adaptIdx !== -1 && adaptIdx < firstDefIdx;
  const led = !adaptFirst && (!!ann || count >= MIN_DEFICITS_TO_JUDGE);
  return { i, led, count, announced: !!ann, announceText: ann ? ann[0] : null, firstDefIdx, adaptIdx };
}

// Pull the salutation-to-signoff body out of a DIN 5008 letter.
function letterBody(markdown) {
  const src = String(markdown).split('<!--')[0];
  const m = src.match(/(?:Dear|Sehr geehrte)[^\n]*\n([\s\S]*?)(?:Best regards|Mit freundlichen|Freundliche Gr)/);
  return m ? m[1].trim() : '';
}

/**
 * Run all four gates. Pure, no network, no LLM.
 * @param {string} markdown  full letter markdown (audit comment is stripped)
 * @param {object} [opts]
 * @param {string} [opts.company]  employer name, for the motivation check
 * @returns {{pass: boolean, failures: Array<{code, detail}>, metrics: object}}
 */
function runLetterGates(markdown, opts = {}) {
  const body = letterBody(markdown);
  const failures = [];
  if (!body || body.split(/\s+/).length < 60) {
    return { pass: false, failures: [{ code: 'CL_GATE_NO_BODY', detail: 'no salutation-to-signoff body found' }], metrics: {} };
  }
  const de = /Sehr geehrte/.test(String(markdown));
  const paras = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);

  // 1. too technical
  const tech = technicalTerms(body);
  if (tech.length > MAX_DISTINCT_TECH) {
    failures.push({
      code: 'CL_TOO_TECHNICAL',
      detail: `${tech.length} distinct technical terms (max ${MAX_DISTINCT_TECH}); the first reader is a hiring manager, not the tech lead. Named: ${tech.slice(0, 12).join(', ')}`,
    });
  }

  // 2. impact
  if (!(de ? IMPACT_DE_RE : IMPACT_RE).test(body)) {
    failures.push({ code: 'CL_NO_IMPACT', detail: 'no forward-looking contribution: say what you would actually do in the role' });
  }

  // 3. motivation. Requires BOTH a why-signal and a company-specific noun, so a
  //    generic enthusiasm line cannot satisfy it on its own.
  // Company-name match, fold-and-compare rather than regex word boundaries.
  // \w is ASCII-only and dots are not word chars, so the old
  // `first.replace(/[^\w]/g,'')` turned "Ströer" into "Strer" and "JD.COM" into
  // "JDCOM" — neither of which appears in a letter that names the employer
  // perfectly well, and both produced a false CL_NO_MOTIVATION (2026-08-09).
  // Normalising both sides to bare lowercase letters/digits handles umlauts,
  // dots, hyphens and ampersands without any boundary logic at all.
  const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const company = String(opts.company || '').trim();
  const companyToken = company ? fold(company.split(/\s+/)[0]) : '';
  const namesCompany = companyToken.length >= 2
    ? fold(body).includes(companyToken)
    : true;   // unknown or too-short company: do not fail a check we cannot make
  if (!(de ? WHY_DE_RE : WHY_RE).test(body) || !namesCompany) {
    failures.push({
      code: 'CL_NO_MOTIVATION',
      detail: !namesCompany
        ? `never names ${company} in the body: why this employer, and what are you looking for?`
        : 'no why-this-role / why-this-employer / what-I-am-looking-for content',
    });
  }

  // 4. deficit-led. Judged on ORDER within the paragraph, not on volume.
  const worst = paras.map((p, i) => analyseDeficitOrder(p, i))
    .filter(d => d.led)
    .sort((a, b) => b.count - a.count)[0];
  if (worst) {
    failures.push({
      code: 'CL_DEFICIT_LED',
      detail: worst.announced
        ? `paragraph ${worst.i + 1} announces the gaps up front ("${worst.announceText}") before giving the reader anything that transfers. Disclose them, but lead with what carries across.`
        : `paragraph ${worst.i + 1} reaches ${worst.count} non-match statements before any adaptability. Put what transfers first, then the caveat.`,
    });
  }

  return {
    pass: failures.length === 0,
    failures,
    metrics: { words: body.split(/\s+/).length, distinctTech: tech.length, lang: de ? 'de' : 'en' },
  };
}

module.exports = {
  runLetterGates, letterBody, technicalTerms,
  GATES_ACTIVE_FROM, MAX_DISTINCT_TECH, MIN_DEFICITS_TO_JUDGE, analyseDeficitOrder,
};
