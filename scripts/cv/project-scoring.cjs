// cv/project-scoring.cjs — shared JD-driven project scoring.
//
// One canonical scorer used by both renderers:
//   - cv/build-cvs.js (CJS, the auto-draft path — requires this directly)
//   - generate-pdf-tailored.mjs (ESM, the on-demand tailored path — uses
//     Node ESM/CJS interop: `import P from './cv/project-scoring.cjs'`).
//
// Deterministic, JD-driven, rules-only. Same JD in → same picks out.
// Extension of the earlier flat-keyword scorer to handle the four blind
// spots real JDs surface: synonym coverage, requirement-vs-nice-to-have
// emphasis, strong-vs-weak keyword weighting, and impact as a tie-breaker.
//
// Scoring formula:
//   score = archetype[arch] * 10                 // role-family baseline (0–30)
//         + Σ strong_hits * 3 * section_weight   // JD relatability, weighted by section
//         + Σ weak_hits   * 1 * section_weight
//         + impact                                // 1–5 tie-breaker
//         - Σ anti_hits * 100                     // hard drop
//         + (pinned ? 1000 : 0)                   // dissertation always #1
//
// Selection:
//   - Drop projects with archetype_base === 0 AND zero keyword hits
//     (never surface a project that has no role fit AND no JD signal).
//   - Take top max_projects (default 4).
//   - Falls back to variant.projectsOrder when jdText is empty or absent.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── Section weights ────────────────────────────────────────────────────────
// A keyword hit inside "Requirements" / "Responsibilities" / "You'll"
// weighs full; inside "Nice to have" / "Bonus" / "Preferred" weighs half;
// inside "Benefits" / "Perks" / "We offer" weighs quarter. Unrecognised
// sections weigh full (safe default so shorter JDs aren't penalised).
const SECTION_WEIGHTS = { core: 1.0, nice: 0.5, perks: 0.25 };

const CORE_HEADS = /^(?:\s*[#*]*\s*)?(?:responsibilities|your role|the role|what you'?ll (?:do|be doing)|what we're looking for|we're looking for|you have|essential|essentials|requirements?|must[- ]?haves?|key (?:responsibilities|duties|skills)|about (?:the|this) role|your (?:tasks|profile|day)|aufgaben|ihre aufgaben|deine aufgaben|anforderungen|ihr profil|dein profil|voraussetzungen|qualifikationen)\b/im;
const NICE_HEADS = /^(?:\s*[#*]*\s*)?(?:nice[- ]?to[- ]?have|bonus|preferred|desirable|would be (?:great|a plus|a bonus)|it'?s? a (?:plus|bonus)|helpful|advantage|wünschenswert|von vorteil|pluspunkt)\b/im;
const PERKS_HEADS = /^(?:\s*[#*]*\s*)?(?:benefits?|perks?|we offer|what we offer|you'?ll get|package|wir bieten|unser angebot|leistungen)\b/im;

// Split JD into weighted chunks by header. Any JD line matching a section
// pattern starts a new chunk with the matching weight. Everything before the
// first header goes into the default (`core`) bucket at full weight.
function splitJdBySection(jdText) {
  const raw = String(jdText || '');
  if (!raw.trim()) return [];
  const lines = raw.split(/\n/);
  const chunks = [{ text: '', weight: SECTION_WEIGHTS.core }];
  for (const line of lines) {
    let hitWeight = null;
    if (CORE_HEADS.test(line)) hitWeight = SECTION_WEIGHTS.core;
    else if (NICE_HEADS.test(line)) hitWeight = SECTION_WEIGHTS.nice;
    else if (PERKS_HEADS.test(line)) hitWeight = SECTION_WEIGHTS.perks;
    if (hitWeight !== null) chunks.push({ text: '', weight: hitWeight });
    chunks[chunks.length - 1].text += line + '\n';
  }
  return chunks.filter(c => c.text.trim().length > 0);
}

// ── Synonym expansion ─────────────────────────────────────────────────────
// A project keyword like "kimball" expands to every synonym in its group,
// so a JD mentioning "star schema" hits kimball-tagged projects. Groups are
// declared on the pool file as top-level `synonyms`; this helper flattens
// them into a lookup { canonical_term -> [all_variants] }.
function buildSynonymLookup(pool) {
  const groups = (pool && pool.synonyms) || {};
  const lookup = {};
  for (const [key, variants] of Object.entries(groups)) {
    const all = [key, ...variants].map(s => s.toLowerCase().trim()).filter(Boolean);
    for (const v of all) lookup[v] = all;
  }
  return lookup;
}

// Expand a keyword to itself + any synonym variants.
function expandTerm(term, lookup) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return [];
  return lookup[t] || [t];
}

// Word-boundary hit inside a lowercased text chunk. Used for both strong
// and weak keyword matching. Multi-word phrases match as literal substrings
// (word boundary is enforced only for single-token terms).
function termHits(text, term) {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return 0;
  // Multi-word phrase (contains whitespace): substring count.
  if (/\s/.test(t)) {
    let n = 0, i = 0;
    while ((i = text.indexOf(t, i)) !== -1) { n++; i += t.length; }
    return n;
  }
  // Single word: word-boundary regex, escape regex metacharacters.
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[^A-Za-z0-9])' + esc + '(?:$|[^A-Za-z0-9])', 'g');
  return (text.match(re) || []).length;
}

// Sum weighted hits of `terms` across all JD chunks.
function weightedHits(chunks, terms) {
  let total = 0;
  for (const c of chunks) {
    const lc = c.text.toLowerCase();
    for (const t of terms) total += termHits(lc, t) * c.weight;
  }
  return total;
}

// ── Score one project against one JD ──────────────────────────────────────
function scoreProject(project, arch, jdChunks, synLookup) {
  const archBase = ((project.archetypes && project.archetypes[arch]) || 0);
  const impact = Number(project.impact || 0);

  // Expand each keyword through the synonym map before matching.
  const strongTerms = (project.keywords_strong || []).flatMap(k => expandTerm(k, synLookup));
  const weakTerms = (project.keywords_weak || project.keywords || []).flatMap(k => expandTerm(k, synLookup));
  const antiTerms = (project.anti_keywords || []).flatMap(k => expandTerm(k, synLookup));

  const strongHits = weightedHits(jdChunks, strongTerms);
  const weakHits = weightedHits(jdChunks, weakTerms);
  const antiHits = jdChunks.length ? weightedHits(jdChunks, antiTerms) : 0;

  let score = archBase * 10 + strongHits * 3 + weakHits * 1 + impact - antiHits * 100;
  if (project.pinned) score += 1000;

  const totalKeywordHits = strongHits + weakHits;
  const eligible = archBase > 0 || totalKeywordHits > 0;

  return { score, archBase, impact, strongHits, weakHits, antiHits, eligible };
}

// ── Top-level selection ───────────────────────────────────────────────────
// Returns the top N project ids ranked by score, filtered by eligibility.
// When jdText is empty, returns null so the caller can use its variant
// fallback (VARIANTS.projectsOrder in build-cvs.js).
function selectProjectIds({ pool, archetype, jdText, maxN }) {
  if (!pool || !Array.isArray(pool.projects) || !pool.projects.length) return null;
  const jd = String(jdText || '').trim();
  if (!jd) return null;

  const arch = String(archetype || 'AE').toUpperCase();
  const chunks = splitJdBySection(jd);
  const synLookup = buildSynonymLookup(pool);
  const cap = maxN || pool.max_projects || 4;

  const scored = pool.projects
    .map(p => ({ p, ...scoreProject(p, arch, chunks, synLookup) }))
    .filter(x => x.eligible)
    .sort((a, b) => b.score - a.score || (b.impact || 0) - (a.impact || 0));

  return scored.slice(0, cap).map(x => x.p.id);
}

// Same as above but returns the full scored objects, for logging /
// preview / debugging. Order matches selectProjectIds exactly.
function scoreAllProjects({ pool, archetype, jdText }) {
  if (!pool || !Array.isArray(pool.projects) || !pool.projects.length) return [];
  const arch = String(archetype || 'AE').toUpperCase();
  const chunks = splitJdBySection(jdText);
  const synLookup = buildSynonymLookup(pool);
  return pool.projects
    .map(p => ({ id: p.id, ...scoreProject(p, arch, chunks, synLookup) }))
    .sort((a, b) => b.score - a.score);
}

// Convenience loader — reads pool from disk relative to this file.
function loadPool(poolPath) {
  const p = poolPath || path.resolve(__dirname, 'project-pool.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

module.exports = {
  selectProjectIds,
  scoreAllProjects,
  loadPool,
  splitJdBySection,       // exported for tests
  buildSynonymLookup,     // exported for tests
  termHits,               // exported for tests
};
