/**
 * company-research-store.mjs — persistent per-company research context.
 *
 * Motivation: enrichProfile (and later cv-qa) benefit from company research
 * that goes beyond the JD — engineering blog vocabulary, product surface,
 * mission signals, tech stack. Without a store, each row does its own research
 * from scratch via cover-letters/research; two JDs for the same company
 * duplicate that work and do not share vocabulary.
 *
 * Store: data/company-research/{slug}.json, one file per company. Structure:
 *   {
 *     name: string,
 *     slug: string,               // canonical, matches filename
 *     first_researched: ISO8601,
 *     last_updated: ISO8601,
 *     summary: string,            // 1-3 sentences: what the company does
 *     vocabulary: string[],       // words the company itself uses
 *     tech_stack: string[],       // tools from careers page / engineering blog
 *     values: string,             // 1-2 sentences on culture/values signals
 *     sources: string[],          // URLs where facts came from (JD, careers, blog)
 *     notes: string,              // free-form notes added by hand
 *   }
 *
 * Reader (this file): loads {slug}.json when present. Enricher/QA opt-in.
 * Writer: exposed for other tooling to upsert (append-safe merge).
 * CLI: `node scripts/cv/company-research-store.mjs --slug example` prints the record.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { companySlug } from '../metrics/metrics-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const STORE_DIR = resolve(REPO_ROOT, 'data', 'company-research');

// Re-export as `slugify` for backward compatibility with existing callers.
// Canonical implementation lives in metrics-core.mjs (companySlug).
export const slugify = companySlug;

function pathFor(slug) {
  return join(STORE_DIR, `${slug}.json`);
}

/**
 * Load a company record by slug (or company name — will slugify).
 * Returns null when the record does not exist. Never throws on read errors —
 * returns null so callers degrade cleanly (research is enhancement, not required).
 */
export function loadCompany(nameOrSlug) {
  if (!nameOrSlug) return null;
  const slug = nameOrSlug.includes('-') && nameOrSlug === nameOrSlug.toLowerCase()
    ? nameOrSlug
    : slugify(nameOrSlug);
  const p = pathFor(slug);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[company-research-store] Failed to load ${p}: ${err.message}`);
    return null;
  }
}

/**
 * Upsert a company record. Merges non-empty incoming fields into the existing
 * record; arrays (vocabulary, tech_stack, sources) are deduped-appended.
 * Never overwrites `first_researched`. Always bumps `last_updated`.
 */
export function upsertCompany(update, { now } = {}) {
  if (!update || !update.name) throw new Error('upsertCompany requires {name}');
  const slug = update.slug || slugify(update.name);
  const nowIso = now || new Date().toISOString();
  const existing = loadCompany(slug) || {
    name: update.name,
    slug,
    first_researched: nowIso,
    summary: '',
    vocabulary: [],
    tech_stack: [],
    values: '',
    sources: [],
    notes: '',
  };

  const mergeArr = (a, b) => {
    const seen = new Set(a || []);
    for (const x of (b || [])) if (x && !seen.has(x)) { seen.add(x); }
    return Array.from(seen);
  };

  const merged = {
    ...existing,
    name: update.name || existing.name,
    slug,
    summary: update.summary || existing.summary,
    vocabulary: mergeArr(existing.vocabulary, update.vocabulary),
    tech_stack: mergeArr(existing.tech_stack, update.tech_stack),
    values: update.values || existing.values,
    sources: mergeArr(existing.sources, update.sources),
    notes: update.notes || existing.notes,
    last_updated: nowIso,
  };

  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(pathFor(slug), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * List all company slugs in the store. Convenience for tooling.
 */
export function listCompanies() {
  if (!existsSync(STORE_DIR)) return [];
  return readdirSync(STORE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
}

/**
 * Format a company record as a prose block suitable for injection into an
 * LLM system prompt. Returns empty string when nothing is known about the
 * company, so callers can unconditionally concatenate.
 */
export function formatCompanyContext(rec) {
  if (!rec) return '';
  const parts = [];
  parts.push(`## Persistent research: ${rec.name}`);
  if (rec.summary) parts.push(`**What they do:** ${rec.summary}`);
  if (rec.vocabulary && rec.vocabulary.length) parts.push(`**Vocabulary to mirror:** ${rec.vocabulary.join(', ')}`);
  if (rec.tech_stack && rec.tech_stack.length) parts.push(`**Their tech stack:** ${rec.tech_stack.join(', ')}`);
  if (rec.values) parts.push(`**Values / culture signals:** ${rec.values}`);
  if (rec.notes) parts.push(`**Notes:** ${rec.notes}`);
  parts.push(`_(Persistent research from data/company-research/${rec.slug}.json, first researched ${rec.first_researched}, last updated ${rec.last_updated}. Prefer this vocabulary over the JD alone where they conflict — the JD tells you what they want in the role, this tells you how they talk about themselves.)_`);
  return parts.join('\n\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function cli() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slug') args.slug = argv[++i];
    else if (a === '--company') args.company = argv[++i];
    else if (a === '--list') args.list = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (args.help || (!args.slug && !args.company && !args.list)) {
    console.log('Usage:');
    console.log('  node scripts/cv/company-research-store.mjs --list                     # list all slugs');
    console.log('  node scripts/cv/company-research-store.mjs --company "Example"        # show one');
    console.log('  node scripts/cv/company-research-store.mjs --slug example             # show one by slug');
    return;
  }
  if (args.list) {
    const slugs = listCompanies();
    console.log(`${slugs.length} companies in store:`);
    for (const s of slugs) console.log(`  ${s}`);
    return;
  }
  const rec = loadCompany(args.slug || args.company);
  if (!rec) { console.log(`No record for ${args.slug || args.company}`); return; }
  console.log(JSON.stringify(rec, null, 2));
  console.log('\n--- formatted for prompt injection ---\n');
  console.log(formatCompanyContext(rec));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch(err => { console.error('[company-research-store] Fatal:', err.message); process.exit(1); });
}
