/**
 * profile-source-log.mjs — append-only log of which profile source shipped
 * with each rendered CV. Enables A/B analysis of response-rate by profile
 * variant (llm-enriched vs template-fallback vs static-cv vs explicit-text).
 *
 * Store: data/profile-source-log.jsonl (one line per render).
 * Row shape: { ts, company, role_title, archetype, seniority, lang, country,
 *              source, word_count, jd_present, output_pdf_basename }
 *
 * Downstream: cv/qa-outcomes.mjs (or a follow-up analyser) can join by
 * company + role_title + ts-day against the funnel/response data in Notion
 * to prove whether llm-enriched profiles land better than templates.
 *
 * Deliberately narrow surface — one export, silent on IO errors so a render
 * never blocks because logging failed.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const LOG_PATH = resolve(REPO_ROOT, 'data', 'profile-source-log.jsonl');

export function logProfileSource(row) {
  try {
    const dir = dirname(LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...row,
    }) + '\n';
    writeFileSync(LOG_PATH, line, { flag: 'a', encoding: 'utf8' });
  } catch (err) {
    console.error(`[profile-source-log] append failed (non-fatal): ${err.message}`);
  }
}
