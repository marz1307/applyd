/**
 * nda-safe-list.mjs — loads config/nda-safe-list.yml and formats it into
 * the prose block cv-qa's Check B expects.
 *
 * New NDA employers are added by editing YAML rather than editing prose in
 * modes/candidate-profile.md. The YAML lets you list SAFE items, BLOCKED
 * categories, and audit questions per employer.
 *
 * Falls back to null when the YAML is missing/malformed — caller (cv-qa)
 * then leaves the prose Section 5 as-is (which still ships in the prompt).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const YML_PATH = resolve(REPO_ROOT, 'config', 'nda-safe-list.yml');

let _cache = null;
let _cached = false;  // distinguish "cached null" from "not yet loaded"
export function loadNdaConfig() {
  if (_cached) return _cache;
  _cached = true;
  if (!existsSync(YML_PATH)) return null;
  try {
    _cache = yaml.load(readFileSync(YML_PATH, 'utf8'));
    return _cache;
  } catch (err) {
    console.error(`[nda-safe-list] Failed to parse ${YML_PATH}: ${err.message}. Falling back to prose Section 5.`);
    _cache = null;
    return null;
  }
}

/**
 * Format the YAML into the prose block cv-qa's Check B references.
 * Returns null when no employers are configured, so callers can leave the
 * prose intact.
 */
export function formatNdaBlock() {
  const cfg = loadNdaConfig();
  if (!cfg || !Array.isArray(cfg.employers) || cfg.employers.length === 0) return null;

  const sections = cfg.employers.map(emp => {
    const safeList = (emp.safe || []).map(s => `- "${s}"`).join('\n');
    const blockedList = (emp.blocked || []).map((b, i) => {
      const desc = typeof b === 'string' ? b : (b.description || '');
      const det  = typeof b === 'string' ? '' : (b.detail || '');
      return `${i + 1}. **${desc}** ${det ? '- ' + det : ''}`.trim();
    }).join('\n');
    const audit = (emp.audit_prompts || []).map((q, i) => `${i + 1}. ${q}`).join('\n');

    return `### ${emp.name} NDA Rules (data-driven from config/nda-safe-list.yml)

${emp.description ? emp.description + '.' : ''}${emp.portfolio_note ? ' ' + emp.portfolio_note : ''}

#### SAFE to include in any generated content:

${safeList}

#### BLOCKED - never include these in any generated artefact:

${blockedList}

#### How to audit a CV or cover letter for ${emp.name} NDA violations:

${audit}

If YES to any of the above: flag as NDA_VIOLATION and rewrite using the SAFE list.`;
  });

  return sections.join('\n\n---\n\n');
}

// Convenience: which employer name(s) does the current config cover? Used by
// cv-qa to broaden its Check B rubric beyond one-employer wording.
export function ndaEmployerNames() {
  const cfg = loadNdaConfig();
  if (!cfg || !Array.isArray(cfg.employers)) return [];
  return cfg.employers.map(e => e.name);
}
