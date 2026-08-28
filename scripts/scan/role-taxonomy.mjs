// role-taxonomy.mjs — read-only consumer of config/role-taxonomy.yml.
//
// System-layer helper: it READS the user-layer taxonomy; it hardcodes NO role
// names (DATA_CONTRACT.md + ROLE_TAXONOMY_ENRICHMENT_PROMPT §8). Scanner and any
// scoring script import this instead of hand-maintaining title lists.
//
// Exposes:
//   loadTaxonomy(root)                     -> parsed taxonomy | null (absent = fall back)
//   deriveTitleFilter(tax, {includeWatch}) -> { positive:[], negative:[], negativeSubstring:[] }
//   matchNegative(title, spec)             -> matched exclusion term | null
//   classifyTitle(tax, title)              -> { name, archetype, tier, penalty } | null
//   deriveQueries(tax, countries)          -> [{ role, country }] from core archetype names
//
// Tier policy:
//   core     -> positive, no penalty
//   adjacent -> positive, scoring penalty (must clear a higher bar)
//   watch    -> positive ONLY when includeWatch; heavy penalty (hand-review)
//   exclude  -> negative (from `exclusions`)
'use strict';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

export const TIER_PENALTY = { core: 0, adjacent: 15, watch: 40 };

// Canonical archetype -> display name used for generated scan queries.
// These are archetype KEYS (enums), not harvested role names.
const ARCHETYPE_QUERY_NAME = {
  AE: 'Analytics Engineer',
  DS: 'Data Scientist',
  DE: 'Data Engineer',
  DA: 'Data Analyst',
  BI: 'BI Engineer',
};

export function loadTaxonomy(root = '.') {
  const p = path.join(root, 'config', 'role-taxonomy.yml');
  if (!existsSync(p)) return null;
  const tax = yaml.load(readFileSync(p, 'utf8'));
  if (!tax || !Array.isArray(tax.roles) || !Array.isArray(tax.exclusions)) return null;
  return tax;
}

// Names that make a title a positive match, given the include-watch flag.
export function deriveTitleFilter(tax, { includeWatch = false } = {}) {
  const tiers = includeWatch ? ['core', 'adjacent', 'watch'] : ['core', 'adjacent'];
  const positive = [];
  for (const r of tax.roles) {
    if (!tiers.includes(r.tier)) continue;
    positive.push(r.name, ...(r.aliases || []));
  }
  const negative = tax.exclusions.map(e => e.name);
  // Terms flagged `match: substring` in the taxonomy — German compounds and
  // inflections that a trailing word boundary cannot catch. Returned as a
  // SEPARATE list so `negative` keeps its old shape for existing callers.
  const negativeSubstring = tax.exclusions
    .filter(e => e.match === 'substring')
    .map(e => e.name);
  // de-dupe (aliases can repeat a bare name) while preserving order
  const uniq = arr => [...new Set(arr)];
  return {
    positive: uniq(positive),
    negative: uniq(negative),
    negativeSubstring: uniq(negativeSubstring),
  };
}

/**
 * The ONE way to test a title against the derived negative list.
 *
 * Two matching modes, because one rule cannot serve both languages:
 *   - `match: substring` terms (German) compare with plain `includes`, so
 *     "Werkstudent" catches "Werkstudentin" and "Ausbildung" catches
 *     "Ausbildungsplatz".
 *   - everything else compares on word boundaries, so "Intern" does not drop
 *     "International Data Analyst" and "Lead" does not drop "Leading".
 *
 * Before this existed the two scanners disagreed: bd-bulk-scan word-bounded
 * every term (missing every German compound) and scan.mjs substring-matched
 * every term (dropping "International …" as an Intern hit). Same taxonomy,
 * opposite bugs — which is why the comparison lives here now, not per caller.
 *
 * @param {string} title            title to test
 * @param {object} spec             { negative, negativeSubstring } from deriveTitleFilter
 * @returns {string|null}           the term that matched, or null if the title is clean
 */
export function matchNegative(title, spec = {}) {
  const t = String(title || '');
  if (!t) return null;
  const lower = t.toLowerCase();
  const subs = new Set((spec.negativeSubstring || []).map(s => s.toLowerCase()));
  for (const s of subs) {
    if (lower.includes(s)) return s;
  }
  for (const n of spec.negative || []) {
    const term = String(n).trim();
    if (!term || subs.has(term.toLowerCase())) continue; // already tested above
    const re = new RegExp('\\b' + term.replace(/[.+?*[\](){}|\\^$]/g, '\\$&') + '\\b', 'i');
    if (re.test(t)) return term;
  }
  return null;
}

// Classify a scanned title to its archetype + tier. Case-insensitive substring;
// the LONGEST matching name/alias wins so "Analytics Engineer" beats "Analytics".
export function classifyTitle(tax, title) {
  if (!title) return null;
  const lower = String(title).toLowerCase();
  let best = null, bestLen = -1;
  for (const r of tax.roles) {
    for (const cand of [r.name, ...(r.aliases || [])]) {
      const c = cand.toLowerCase();
      if (lower.includes(c) && c.length > bestLen) {
        best = r; bestLen = c.length;
      }
    }
  }
  if (!best) return null;
  return { name: best.name, archetype: best.archetype, tier: best.tier, penalty: TIER_PENALTY[best.tier] ?? 0 };
}

/**
 * Search terms for one language, grouped by archetype.
 *
 * WHY: the scan queries are English-only (ARCHETYPE_QUERY_NAME above), which is
 * right for LinkedIn and the UK boards but leaves the German-native boards
 * (Xing, Stepstone, eFC .de) blind to German-titled ads — a "Datenanalyst"
 * posting matches none of the English query strings. This derives the German
 * search terms from the SAME taxonomy that already tags every role with `lang`,
 * so the query side and the title-filter side can never drift apart.
 *
 * Only `core` tier is returned: adjacent/watch names are deliberately broad and
 * are there to CLASSIFY a title once found, not to spend a fetch discovering it.
 *
 * Aliases are excluded on purpose. They are mostly inflections
 * ("Datenanalystin") and abbreviations ("BI-Entwickler") that the portals'
 * own stemming already covers, so querying them separately buys duplicate URLs
 * at full price. They still count for MATCHING via deriveTitleFilter.
 *
 * @param {object} tax   parsed taxonomy
 * @param {string} lang  language tag to select, e.g. 'de'
 * @returns {Record<string, string[]>}  archetype -> core role names in that language
 */
export function queryTermsByLang(tax, lang) {
  const out = {};
  if (!tax || !Array.isArray(tax.roles)) return out;
  for (const r of tax.roles) {
    if (r.tier !== 'core' || r.lang !== lang) continue;
    (out[r.archetype] ||= []).push(r.name);
  }
  return out;
}

/**
 * Translate one English query role into its same-archetype terms in `lang`.
 * Returns [] when the archetype has no term in that language — which is the
 * common case for AE and DE, where DACH advertises the English title verbatim
 * ("Analytics Engineer" has no German form in real postings). Returning empty
 * is correct there; inventing "Analytik-Ingenieur" would spend fetches on a
 * string no employer writes.
 */
export function translateRole(tax, role, lang) {
  if (!tax || !role) return [];
  const hit = tax.roles.find(r => r.name.toLowerCase() === String(role).toLowerCase());
  const archetype = hit ? hit.archetype
    : Object.entries(ARCHETYPE_QUERY_NAME).find(([, n]) => n.toLowerCase() === String(role).toLowerCase())?.[0];
  if (!archetype) return [];
  return (queryTermsByLang(tax, lang)[archetype] || []).filter(n => n.toLowerCase() !== String(role).toLowerCase());
}

// Generate scan queries = core-tier archetypes × countries (replaces the
// hand-maintained bulk_scrape.queries list). One query per distinct core archetype.
export function deriveQueries(tax, countries) {
  const coreArchetypes = [...new Set(tax.roles.filter(r => r.tier === 'core').map(r => r.archetype))];
  const out = [];
  for (const a of coreArchetypes) {
    const role = ARCHETYPE_QUERY_NAME[a];
    if (!role) continue;
    for (const country of countries) out.push({ role, country });
  }
  return out;
}
