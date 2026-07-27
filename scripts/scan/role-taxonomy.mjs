// role-taxonomy.mjs — read-only consumer of config/role-taxonomy.yml.
//
// System-layer helper: it READS the user-layer taxonomy; it hardcodes NO role
// names (DATA_CONTRACT.md + ROLE_TAXONOMY_ENRICHMENT_PROMPT §8). Scanner and any
// scoring script import this instead of hand-maintaining title lists.
//
// Exposes:
//   loadTaxonomy(root)                     -> parsed taxonomy | null (absent = fall back)
//   deriveTitleFilter(tax, {includeWatch}) -> { positive:[], negative:[] }
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
  // de-dupe (aliases can repeat a bare name) while preserving order
  const uniq = arr => [...new Set(arr)];
  return { positive: uniq(positive), negative: uniq(negative) };
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
