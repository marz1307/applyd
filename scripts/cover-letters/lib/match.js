// cover-letters/lib/match.js — Stage 2: Honest match analysis
//
// Inputs:  company_brief (from research.js) + cv_master.json + jd_text
// Outputs: match_brief with strong_matches / transferable_matches / gaps /
//          chosen angle / company-facts-to-reference / salary range.
'use strict';

// Weights are deliberately uneven. Distinctive signals (dbt+Kimball,
// "internal application", "first data hire") get weight >=2. Generic
// signals that appear in nearly every JD ("ci", "tests") get weight 1.
// This prevents data_quality from winning by default just because every
// modern JD mentions tests + CI.
// NOTE: The keywords below are generic data/ML concepts, not personal data.
// Adjust weights to match the candidate's strongest production evidence.
const ANGLE_KEYWORDS = {
  modelling: [
    ['kimball', 3], ['dimensional model', 3], ['star schema', 3], ['data mart', 3],
    ['dbt', 2], ['staging layer', 2], ['warehouse', 1], ['mart', 1],
  ],
  infrastructure: [
    ['incremental model', 3], ['cost optimization', 3], ['oracle cloud', 1],
    ['pipeline performance', 2], ['dagster', 2], ['airflow', 2],
    ['orchestration', 1], ['compute', 1],
  ],
  data_quality: [
    ['data contract', 3], ['observability', 2], ['sla', 2],
    ['pytest', 2], ['great expectations', 3],
    ['data quality', 1], ['testing', 1], ['monitoring', 1],
    // 'ci' and 'tests' deliberately omitted — too common, drag score
  ],
  internal_product: [
    ['internal application', 3], ['internal tool', 3], ['internal product', 3],
    ['fastapi', 2], ['data product', 2], ['data-as-a-product', 3], ['product engineer', 2],
    ['angular', 2], ['react', 1], ['ui', 1], ['frontend', 1],
  ],
  attribution: [
    ['attribution', 3], ['identity resolution', 3], ['lead scoring', 3],
    ['classification', 2], ['segmentation', 2], ['business logic', 2], ['rule engine', 2],
  ],
  sole_owner: [
    ['first data hire', 3], ['first analytics hire', 3], ['zero to one', 3], ['0 to 1', 3],
    ['greenfield', 2], ['founder', 2], ['small team', 1],
  ],
};

function pickAngle(jdText, brief, opts = {}) {
  const jd = (jdText || '').toLowerCase();
  const factText = brief ? (brief.facts || []).map(f => f.fact).join(' ').toLowerCase() : '';
  const t = jd + ' ' + factText;
  const scores = {};
  for (const [angle, weighted] of Object.entries(ANGLE_KEYWORDS)) {
    let s = 0;
    for (const [term, weight] of weighted) if (t.includes(term)) s += weight;
    scores[angle] = s;
  }
  // Tie-break prefers specificity. Modelling is the safe fallback last.
  const order = ['internal_product', 'attribution', 'infrastructure', 'data_quality', 'modelling', 'sole_owner'];
  // Cross-batch variety: a counts map of already-used angles can be passed via
  // opts.usedAngles. If the top angle has been used heavily already and a
  // second-place angle is within 1 point of it, prefer the rarer angle.
  const used = opts.usedAngles || {};
  let best = order[0], bestScore = scores[order[0]];
  for (const a of order) if (scores[a] > bestScore) { best = a; bestScore = scores[a]; }
  if (bestScore === 0) best = 'modelling';
  // Variety tiebreaker: if a runner-up is within 1 of the leader AND the
  // leader has been used noticeably more (≥2 more), pick the runner-up.
  const runnersUp = order.filter(a => a !== best && scores[a] >= bestScore - 1);
  for (const ru of runnersUp) {
    if ((used[best] || 0) - (used[ru] || 0) >= 2) { best = ru; bestScore = scores[ru]; break; }
  }
  return { angle: best, score: bestScore, all_scores: scores };
}

// Honest match scoring against the production / skills-list-only / research-only split
function scoreMatch(jdText, cvMaster) {
  const t = (jdText || '').toLowerCase();
  const strong = [], transferable = [], gaps = [];
  const seen = new Set();
  for (const skill of cvMaster.skills.production) {
    const key = skill.toLowerCase();
    if (t.includes(key) && !seen.has(key)) {
      strong.push({ jd_term: skill, cv_evidence: 'production experience (see cv.md)' });
      seen.add(key);
    }
  }
  for (const skill of cvMaster.skills.skills_list_only) {
    const key = skill.toLowerCase();
    if (t.includes(key) && !seen.has(key)) {
      transferable.push({ jd_term: skill, cv_evidence: 'on skills list (study / personal project)' });
      seen.add(key);
    }
  }
  // Common "gap" detection: high-frequency JD terms that aren't in any CV bucket
  const possibleGaps = [
    { term: 'Kubernetes', context: 'Kubernetes in production' },
    { term: 'Kafka', context: 'Kafka streaming in production' },
    { term: 'Scala', context: 'Scala production codebase' },
    { term: 'Go ', context: 'Go in production' },
    { term: 'Rust', context: 'Rust in production' },
    { term: 'SageMaker', context: 'AWS SageMaker production deployment' },
    { term: 'Vertex AI', context: 'GCP Vertex AI production deployment' },
    { term: 'Kubeflow', context: 'Kubeflow' },
  ];
  for (const g of possibleGaps) {
    if (t.includes(g.term.toLowerCase()) && !seen.has(g.term.toLowerCase())) {
      gaps.push({ jd_term: g.term, cv_evidence: 'not in CV', disclose_in_letter: true });
    }
  }
  return { strong_matches: strong, transferable_matches: transferable, gaps };
}

// Salary range — uses cv_master.json anchors keyed by country+role+level.
// Honest about whether it's estimated (anchor) vs researched (web lookup; not done in this build).
function salaryRange(roleHint, country, cvMaster, seniority) {
  const anchors = cvMaster.salary_anchors || {};
  const c = (country || '').toLowerCase();
  const r = roleHint || 'ae';
  // Map roleHint to anchor key
  const roleKey = ['ae', 'ds', 'de', 'da', 'me'].includes(r) ? r : 'ae';
  // Seniority-aware suffix (2026-07-03, exceptional-graduate positioning):
  // graduate/junior applications must never quote mid bands. Falls back to
  // the _mid anchor when no junior anchor exists for the geo/role.
  const sfx = /junior|graduate|entry|trainee/i.test(String(seniority || '')) ? 'junior' : 'mid';
  let base = null;
  if (/germany|austria|switzerland|de$|^de\b/i.test(c)) base = `de_${roleKey}`;
  else if (/united kingdom|uk|england|scotland|wales/i.test(c)) base = `uk_${roleKey}`;
  else if (/netherlands|france|ireland|spain|portugal|italy|sweden|denmark|norway/i.test(c)) base = `eu_${roleKey === 'me' ? 'de' : roleKey}`;
  else base = 'remote_eur';
  const key = anchors[`${base}_${sfx}`] ? `${base}_${sfx}` : `${base}_mid`;
  const a = anchors[key] || anchors[`remote_eur_${sfx}`] || anchors.remote_eur_mid;
  return { min: a.min, max: a.max, currency: a.currency, source: 'cv_master_anchor', anchor_key: key };
}

// Pick which company facts (by id from brief.facts) to reference in the letter.
// Strategy: rank by category importance, deduplicate by topic, cap at 2.
function pickFacts(brief) {
  const order = ['product', 'engineering_blog', 'tech_stack', 'news', 'company_history', 'company_scale'];
  const byCat = {};
  for (const f of brief.facts || []) {
    if (f.confidence !== 'high') continue;
    if (!byCat[f.category]) byCat[f.category] = [];
    byCat[f.category].push(f);
  }
  const picked = [];
  for (const cat of order) {
    if (byCat[cat] && byCat[cat].length) picked.push(byCat[cat][0]);
    if (picked.length >= 2) break;
  }
  return picked;
}

function match({ brief, cvMaster, jdText, roleHint, country, appId, usedAngles, seniority }) {
  const anglePick = pickAngle(jdText, brief, { usedAngles });
  const scoring = scoreMatch(jdText, cvMaster);
  // Seniority fallback: detect graduate/junior from the JD title when the
  // caller didn't pass it (Notion Seniority field is the preferred source).
  const sen = seniority || (/\b(junior|graduate|entry[- ]level|trainee|werkstudent)\b/i.test(String(brief.job_title || jdText || '').slice(0, 400)) ? 'junior' : '');
  const salary = salaryRange(roleHint, country, cvMaster, sen);
  const factsPicked = pickFacts(brief);

  return {
    application_id: appId,
    cv_variant: roleHint || 'ae',
    match_summary: scoring,
    employer_angle: anglePick.angle,
    employer_angle_scores: anglePick.all_scores,
    company_facts_to_reference: factsPicked.map(f => ({ category: f.category, fact: f.fact, source: f.source })),
    facts_available: (brief.facts || []).length,
    salary_range: salary,
    tone: detectTone(brief),
    has_gap_to_disclose: scoring.gaps.length > 0,
  };
}

function detectTone(brief) {
  const facts = JSON.stringify(brief.facts || []).toLowerCase();
  if (/series [a-d]|raised|funding|founder|startup/i.test(facts)) return 'founder-energy startup';
  if (/global|enterprise|fortune|established|since 19/i.test(facts)) return 'enterprise';
  return 'neutral-professional';
}

// pickEmployerAngle is a legacy alias kept for backward compatibility.
module.exports = { match, pickAngle, pickEmployerAngle: pickAngle, scoreMatch, salaryRange, pickFacts };
