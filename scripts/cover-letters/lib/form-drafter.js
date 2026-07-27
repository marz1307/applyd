// cover-letters/lib/form-drafter.js — Stage 3-FA: Form-answers drafter.
//
// Same Research + Match inputs as the letter drafter. Output is a Markdown
// file with YAML frontmatter (backend metadata) + recruiter-facing body
// (only ### questions and their answers). Hard separation rule: nothing
// backend-y ever leaks into the body.
//
// Angle evidence rotates across JD-specific technical questions — same angle
// is never used twice in the same file.
'use strict';
// draft.js was retired 2026-07-01; posted-band helpers live in draft-v2 now.
const { detectPostedBand, clampToBand } = require('./draft-v2');

// ── Question detection ──────────────────────────────────────────
// Logistics questions are always included. JD-specific are inferred
// from the JD body + match_brief.strong_matches; "Why this company"
// and "Why this role" are universal motivation questions.
const ALWAYS_LOGISTICS = [
  { id: 'salary', label: 'Salary expectations', category: 'logistics' },
  { id: 'notice_period', label: 'Notice period / earliest start date', category: 'logistics' },
  { id: 'visa', label: 'Visa / right to work', category: 'logistics' },
  { id: 'sponsorship', label: 'Sponsorship required?', category: 'logistics' },
  { id: 'years_experience', label: 'Years of relevant experience', category: 'logistics' },
  { id: 'highest_education', label: 'Highest education', category: 'logistics' },
  { id: 'references', label: 'References available?', category: 'logistics' },
];

const UNIVERSAL_MOTIVATION = [
  { id: 'why_company', label: 'Why this company?', category: 'motivation' },
  { id: 'why_role', label: 'Why this role?', category: 'motivation' },
];

// Derive up to 3 JD-specific technical questions by scanning the JD for
// patterns like "experience with X", "X required", "deep knowledge of Y",
// and the match_brief's strong matches.
function deriveJdQuestions(jdText, matchBrief) {
  const t = (jdText || '');
  const seen = new Set();
  const out = [];
  // Strong_matches are the most reliable JD-specific anchors — start there.
  // They've already been filtered to terms actually in the JD AND in cv_master.
  if (matchBrief.match_summary) {
    for (const m of (matchBrief.match_summary.strong_matches || []).slice(0, 3)) {
      const k = m.jd_term.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: `jd_specific_${out.length + 1}`,
        label: `Experience with ${m.jd_term}`,
        category: 'technical',
        jd_anchor: m.jd_term,
      });
      if (out.length >= 3) return out;
    }
  }
  // Backup: scan JD for "experience with <ProperNoun/TechTerm>" — but reject
  // anchors that start with an article or read as a generic role-name phrase.
  const REJECT_ANCHOR = /^(a|an|the|this|that|some|any|our|your)\b/i;
  const expPatterns = [
    /experience (?:with|in|using)\s+([A-Za-z][A-Za-z0-9 ,\/&+\-\.]{2,60})/gi,
    /proficient (?:with|in)\s+([A-Za-z][A-Za-z0-9 ,\/&+\-\.]{2,60})/gi,
    /hands[- ]on (?:with|in)\s+([A-Za-z][A-Za-z0-9 ,\/&+\-\.]{2,60})/gi,
  ];
  for (const re of expPatterns) {
    for (const m of t.matchAll(re)) {
      let anchor = m[1].split(/[.;,]/)[0].trim();
      // Strip trailing phrases like "for X", "in production", "and Y"
      anchor = anchor.replace(/\s+(for|in production|and\s+\w+|under\s+\w+)\s.*$/i, '').trim();
      if (anchor.length < 3 || anchor.length > 60) continue;
      if (REJECT_ANCHOR.test(anchor)) continue;
      // Must contain a capitalised word (proper noun / tech term) OR be a known tech
      const hasTech = /\b(SQL|Python|Java|R|Go|Rust|Scala|TypeScript|JavaScript|FastAPI|dbt|Airflow|Dagster|Kafka|Spark|Snowflake|BigQuery|Databricks|PostgreSQL|MySQL|MongoDB|Redis|Docker|Kubernetes|Terraform|AWS|GCP|Azure|MLflow|XGBoost|SHAP|Tableau|Looker|Power BI)\b/i.test(anchor);
      const hasProperNoun = /\b[A-Z][a-zA-Z]{2,}/.test(anchor);
      if (!hasTech && !hasProperNoun) continue;
      const k = anchor.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: `jd_specific_${out.length + 1}`,
        label: `Experience with ${anchor}`,
        category: 'technical',
        jd_anchor: anchor,
      });
      if (out.length >= 3) return out;
    }
  }
  // Last-resort fallback when no anchors can be pulled from JD or match brief.
  // Inject 3 role-appropriate technical questions so the form still has
  // jd_specific slots. Picked from cv_master.production skills by variant
  // so each variant gets its strongest production-evidence anchors.
  if (out.length === 0) {
    const variant = (matchBrief.cv_variant || 'ae').toLowerCase();
    const ROLE_FALLBACK_ANCHORS = {
      ae: ['dbt', 'Snowflake or BigQuery (production warehouse)', 'data modelling and CI'],
      de: ['Airflow or Dagster (orchestration)', 'data ingestion and CDC patterns', 'data quality and CI'],
      ds: ['scikit-learn and XGBoost', 'SHAP and model explainability', 'experimentation and causal inference'],
      da: ['SQL and Power BI / Tableau', 'stakeholder reporting and dashboards', 'data modelling for analytics'],
      me: ['model serving via FastAPI', 'SHAP and explainability', 'MLflow and model lifecycle'],
      master: ['SQL and production data layers', 'dbt and dimensional modelling', 'CI-gated correctness'],
    };
    const anchors = ROLE_FALLBACK_ANCHORS[variant] || ROLE_FALLBACK_ANCHORS.ae;
    for (const anchor of anchors) {
      out.push({
        id: `jd_specific_${out.length + 1}`,
        label: `Experience with ${anchor}`,
        category: 'technical',
        jd_anchor: anchor,
        is_fallback: true,
      });
    }
  }
  return out;
}

// ── Angle rotation across questions ───────────────────────────
// Each JD-specific question picks the angle whose keywords best match
// the question's jd_anchor. If already used in this file, pick the
// next-best. Tracks `used` across the file.
const ANGLE_KEYWORDS_PER_TOPIC = {
  modelling: ['dbt', 'kimball', 'dimensional', 'warehouse', 'model', 'mart'],
  data_quality: ['test', 'quality', 'ci', 'pytest', 'observability', 'contract', 'sla'],
  internal_product: ['fastapi', 'internal', 'application', 'ui', 'angular', 'react', 'frontend', 'product'],
  attribution: ['attribution', 'classification', 'identity', 'segmentation', 'rule'],
  infrastructure: ['airflow', 'dagster', 'orchestrat', 'incremental', 'compute', 'cost', 'pipeline'],
  sole_owner: ['greenfield', 'first', 'zero to one', 'founder', 'sole'],
};

function pickAngleForQuestion(anchor, used) {
  const t = (anchor || '').toLowerCase();
  const scores = {};
  for (const [angle, kws] of Object.entries(ANGLE_KEYWORDS_PER_TOPIC)) {
    scores[angle] = kws.reduce((acc, k) => acc + (t.includes(k) ? 1 : 0), 0);
  }
  const ordered = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([a]) => a);
  // Skip already-used angles
  for (const a of ordered) if (!used.has(a)) return a;
  // All 6 used; recycle the highest-scoring
  return ordered[0];
}

// ── Per-question answer composers ─────────────────────────────
// Visa/eligibility answers — reads work_eligibility from config/profile.yml.
// Generates market-appropriate answers based on the candidate's actual status.
function loadWorkEligibility() {
  try {
    const raw = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
    const get = (key) => { const m = raw.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`)); return m ? m[1].trim() : null; };
    return {
      summary: get('summary') || '',
      needsUkSponsorship: /needs_uk_sponsorship:\s*true/i.test(raw),
      euRoute: get('eu_route') || 'EU Blue Card',
      nationality: get('nationality') || '',
      residence: get('residence') || '',
    };
  } catch {
    return { summary: '', needsUkSponsorship: false, euRoute: 'EU Blue Card', nationality: '', residence: '' };
  }
}
const _ELIG = loadWorkEligibility();

function visaAnswer(country) {
  const c = (country || '').toLowerCase();
  const residence = _ELIG.residence || 'Current residence';
  if (/united kingdom|^uk$|england|scotland|wales|northern ireland/i.test(c)) {
    if (_ELIG.needsUkSponsorship) return 'UK Skilled Worker visa sponsorship required.';
    return _ELIG.summary || `${residence} resident with right to work in the UK. No sponsorship required.`;
  }
  if (/^ireland$|^ie$/i.test(c)) {
    return `${residence} resident. Happy to confirm work authorisation for Ireland per the applicable route.`;
  }
  if (/germany|austria|switzerland|netherlands|france|spain|portugal|italy|sweden|denmark|norway|belgium|luxembourg|finland|poland|czech|hungary/i.test(c)) {
    const countryName = c.charAt(0).toUpperCase() + c.slice(1);
    return `For a ${countryName} role I would apply via the ${_ELIG.euRoute} route. No sponsorship cost to the employer beyond the standard right-to-work attestation.`;
  }
  return `Happy to confirm work authorisation per the contracting country; ${_ELIG.euRoute} route available if relocation becomes part of the role.`;
}

function whyCompany({ brief, factsPicked }) {
  if (!factsPicked.length) {
    // Honest fallback — don't fabricate. Anchor on JD itself.
    return `The role description names ${brief.job_title || 'the seat'} and the team's focus, which is what I look for in my next move. The way the role is framed tells me the team values the same priorities I bring to data work.`;
  }
  const f1 = factsPicked[0];
  // Sentence 1: the specific fact (cleaned of trailing period for joining)
  const s1 = f1.fact.replace(/\.$/, '').trim() + '.';
  // Sentence 2: connect to CV evidence (production work — read from cv.md)
  const s2 = `That overlaps directly with my production experience: building data layers end to end, with internal product surfaces alongside the warehouse and CI-gated correctness throughout.`;
  // Sentence 3 (optional): second concrete fact, as its own sentence
  let s3 = '';
  if (factsPicked.length > 1) {
    const f2 = factsPicked[1].fact.trim().replace(/\.$/, '') + '.';
    s3 = ` ${f2} The fit is specific rather than generic.`;
  }
  return `${s1} ${s2}${s3}`.trim();
}

function whyRole({ brief, matchBrief }) {
  const variantLabel = { ae: 'Analytics Engineer', ds: 'Data Scientist', de: 'Data Engineer', da: 'Data Analyst', me: 'Machine Learning Engineer' }[matchBrief.cv_variant] || 'data role';
  const jdSignal = brief.job_title || `${variantLabel} role`;
  // Sentence 1: role-specific signal from JD
  // Sentence 2: explicit connection to a CV evidence point (read from cv.md)
  // Sentence 3: forward-looking
  const angle = matchBrief.employer_angle || 'modelling';
  const evidenceMap = {
    modelling: 'In my most recent role I built dimensional models across staging, intermediate, and marts layers on a deduplicated entity spine; that is the muscle the role is asking for.',
    infrastructure: 'I cut daily pipeline compute significantly through incremental modelling on an append-only raw layer; the cost-and-correctness frame here is what I want to bring next.',
    data_quality: 'I gated correctness with comprehensive dbt and pytest tests through CI; the data-quality emphasis here matches that discipline.',
    internal_product: 'I shipped the API service layer and internal UI alongside the warehouse, with adoption tracked; that is exactly the seat described here.',
    attribution: 'I designed a deterministic classification chain that closed outstanding findings in the metrics review; the role asks for similar deterministic business-logic work.',
    sole_owner: 'I was sole architect of the data layer across multiple backend domains with high solo commit share; the ownership scope here maps cleanly.',
  };
  const s1 = `What pulled me to ${jdSignal} is the combination the role spells out: production data work paired with the specific stack and scope the team owns.`;
  const s2 = evidenceMap[angle] || evidenceMap.modelling;
  const s3 = `In the first 90 days I would expect to ship a first end-to-end model into the existing repo, add tests for the gaps I find, and produce a write-up of where I would steer the data layer over the next year.`;
  return `${s1} ${s2} ${s3}`;
}

// Technical/JD-specific answer composer
// Angle evidence for form answers — populated from cv.md and article-digest.md.
// Each entry should describe the candidate's strongest production evidence for
// the given angle. Replace the generic text below with actual experience.
const ANGLE_BODY_FOR_FORM = {
  modelling: 'My production reference is building dimensional models across staging, intermediate, and marts layers on a deduplicated entity spine; canonical entity resolution closed record-matching gaps the team had previously considered untouchable.',
  infrastructure: 'My production reference is significant daily pipeline compute reduction via incremental modelling on an append-only raw layer with deterministic hash IDs, delivering measurable cost savings with zero added infrastructure overhead.',
  data_quality: 'My production reference is comprehensive dbt and pytest tests gated through CI; the first production build surfaced and fixed data-quality bugs that would otherwise have shipped silently. Silent metric drift now surfaces in CI, not in the boardroom.',
  internal_product: 'My production reference is shipping the API service layer and internal UI alongside the warehouse, giving stakeholders a single workflow and producing the first labelled outcomes dataset for downstream modelling.',
  attribution: 'My production reference is a deterministic classification chain mapping every record to a single entity, replacing a best-guess join and closing outstanding findings in the metrics review.',
  sole_owner: 'My production reference is serving as sole architect and author of the data layer for a multi-tier platform: the only data engineer on the build, primary author across multiple backend domains.',
};

function technicalAnswer({ question, angle, matchBrief }) {
  const angleBody = ANGLE_BODY_FOR_FORM[angle] || ANGLE_BODY_FOR_FORM.modelling;
  const anchor = question.jd_anchor || question.label;
  // Lead: connect anchor to evidence. Body: angle. Close: forward-looking note.
  const lead = `On ${anchor}, my hands-on experience comes through production work in my previous roles and academic research, plus side-project depth where relevant.`;
  // Honest gap if flagged for this question
  let gap = '';
  const gaps = matchBrief.match_summary?.gaps || [];
  for (const g of gaps) {
    if (anchor.toLowerCase().includes(g.jd_term.toLowerCase())) {
      gap = ` I am honest about the gap: I have not worked hands-on with ${g.jd_term} in production. My modelling and engineering substrate carries across, and I would expect to be productive within the first sprint.`;
      break;
    }
  }
  return `${lead} ${angleBody}${gap}`;
}

function logisticsAnswer(qId, ctx) {
  const { matchBrief, country, city, postedBand } = ctx;
  const fmt = (n) => n.toLocaleString('en-GB');
  switch (qId) {
    case 'salary': {
      // Never quote above a band the posting itself names (auto-reject risk).
      const bounded = clampToBand(matchBrief.salary_range, postedBand);
      if (!bounded) return 'Flexible; happy to align with your published band for the role.';
      const cur = bounded.currency === 'GBP' ? '£' : bounded.currency === 'EUR' ? '€' : '$';
      return `${cur}${fmt(bounded.min)} to ${cur}${fmt(bounded.max)} (happy to align with your band).`;
    }
    case 'notice_period': {
      // Read availability from config/profile.yml
      let avail = 'Available immediately.';
      try {
        const raw = require('node:fs').readFileSync(
          require('node:path').join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
        const m = raw.match(/notice_period:\s*"?([^"\n]+)"?/);
        if (m) avail = m[1].trim();
      } catch { /* use default */ }
      return avail;
    }
    case 'visa':
      return visaAnswer(country);
    case 'sponsorship': {
      const c = (country || '').toLowerCase();
      if (/united kingdom|^uk$/i.test(c)) {
        return _ELIG.needsUkSponsorship
          ? 'UK Skilled Worker visa sponsorship required.'
          : 'No sponsorship required for UK roles.';
      }
      return `No sponsorship cost to the employer beyond the standard right-to-work attestation; ${_ELIG.euRoute} route available.`;
    }
    case 'years_experience': {
      // Read experience summary from config/profile.yml
      let exp = 'See attached CV for full experience details.';
      try {
        const raw = require('node:fs').readFileSync(
          require('node:path').join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
        const m = raw.match(/years_experience:\s*"?([^"\n]+)"?/);
        if (m) exp = m[1].trim();
      } catch { /* use default */ }
      return exp;
    }
    case 'highest_education': {
      // Read education from config/profile.yml
      let edu = 'See attached CV for education details.';
      try {
        const raw = require('node:fs').readFileSync(
          require('node:path').join(__dirname, '..', '..', '..', 'config', 'profile.yml'), 'utf8');
        const m = raw.match(/highest_education:\s*"?([^"\n]+)"?/);
        if (m) edu = m[1].trim();
      } catch { /* use default */ }
      return edu;
    }
    case 'references':
      return 'Available on request.';
    default:
      return '';
  }
}

// ── Body builder ───────────────────────────────────────────────
function buildBody({ brief, matchBrief, factsPicked, jdQuestions, country, city, postedBand }) {
  const sections = [];
  const usedAngles = new Set();

  // Motivation
  sections.push(`### Why this company?\n\n${whyCompany({ brief, factsPicked })}`);
  sections.push(`### Why this role?\n\n${whyRole({ brief, matchBrief })}`);
  usedAngles.add(matchBrief.employer_angle);  // claim the letter's angle so technicals pick others

  // JD-specific technical (rotates angles)
  for (const q of jdQuestions) {
    const angle = pickAngleForQuestion(q.jd_anchor, usedAngles);
    usedAngles.add(angle);
    sections.push(`### ${q.label}\n\n${technicalAnswer({ question: q, angle, matchBrief })}`);
  }

  // Logistics
  for (const q of ALWAYS_LOGISTICS) {
    sections.push(`### ${q.label}\n\n${logisticsAnswer(q.id, { matchBrief, country, city, postedBand })}`);
  }

  return sections.join('\n\n');
}

// ── Banned-phrase scrub ────────────────────────────────────────
const BANNED_BODY = [
  /Application ID\s*:/gi, /Match score\s*:/gi, /Apply URL pattern\s*:/gi,
  /Generated\s*:\s*\d{4}-\d{2}-\d{2}/gi, /Drafted by/gi, /auto-draft pipeline/gi,
  /career-ops/gi, /Reviewed by \w+/gi, /Source JD\s*:/gi, /Application channel\s*:/gi,
  /—/g,  // em dash
  /\bpassionate about\b/gi, /\bresults[- ]driven\b/gi, /\bthrive in fast[- ]paced\b/gi,
  /\bI am writing to express my interest\b/gi, /\bnot\s+\w+,?\s+but\s+\w+/g,
  /What matters is the total package/gi,
  /\bX sits at the foundation\b/gi,
];

function scrub(text) {
  let t = text;
  for (const re of BANNED_BODY) t = t.replace(re, (m) => m === '—' ? ',' : '');
  return t.replace(/  +/g, ' ').replace(/\s+\./g, '.').replace(/\s+,/g, ',');
}

// ── Main compose ───────────────────────────────────────────────
function composeForm({ brief, matchBrief, cvMaster, jobUrl, today, country, city, applyUrl, applyChannel, briefPath, matchPath }) {
  const factsPicked = matchBrief.company_facts_to_reference || [];
  const jdText = brief.jd_text || '';
  const jdQuestions = deriveJdQuestions(jdText, matchBrief);
  const postedBand = matchBrief.posted_band || detectPostedBand(jdText);
  const body = scrub(buildBody({ brief, matchBrief, factsPicked, jdQuestions, country, city, postedBand }));

  // YAML frontmatter — backend metadata only
  const fm = [
    '---',
    `application_id: ${matchBrief.application_id || 'unknown'}`,
    `company: ${brief.company || ''}`,
    `role: ${brief.job_title || ''}`,
    `location: ${city || country || ''}`,
    `match_score: ${matchBrief.match_score || ''}`,
    `generated: ${today || new Date().toISOString().slice(0, 10)}`,
    `apply_url: ${applyUrl || jobUrl || ''}`,
    `apply_channel: ${applyChannel || 'web_form'}`,
    `cv_variant_attached: ${matchBrief.cv_variant || 'ae'}`,
    `brief_path: ${briefPath || ''}`,
    `match_path: ${matchPath || ''}`,
    `employer_angle_letter: ${matchBrief.employer_angle || ''}`,
    `salary_anchor: ${matchBrief.salary_range?.anchor_key || ''}`,
    `has_gap_disclosure: ${!!matchBrief.has_gap_to_disclose}`,
    `jd_questions_detected: ${jdQuestions.length}`,
    '---',
  ].join('\n');

  return `${fm}\n\n${body}\n`;
}

module.exports = { composeForm, deriveJdQuestions, scrub };
