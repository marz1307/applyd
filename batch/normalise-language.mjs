#!/usr/bin/env node
// Normalise the Notion `Language` select, and fill it in where the letter on
// disk already answers the question.
//
// WHY THIS EXISTS.
// `Language` accretes several spellings for the same two languages
// (English/German/EN/DE) written by different portals over time. Any analysis
// that groups by language silently splits each group in half and the largest
// bucket tends to become "unset".
//
// FILLING THE BLANKS. Only where a cover letter exists on disk, and only from
// the letter itself: a German letter opens "Sehr geehrte", an English one
// "Dear". That is ground truth for what was actually sent, which the Notion
// field is only ever a claim about. Rows with no letter (mostly Stage 1) are
// left unset on purpose — inventing a value there would be a guess dressed as
// data.
//
// SAFETY. Only ever writes the Language select. Never touches Stage, dates
// or documents. Dry-run unless --apply.
//
// Usage:
//   node batch/normalise-language.mjs             # report only
//   node batch/normalise-language.mjs --apply
//   node batch/normalise-language.mjs --self-test
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOTION_QUERY = path.join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
// Correcting a value that is already canonical is a stronger action than
// folding a short code, so it is opt-in. When set, the LETTER wins: it is the
// artefact that was actually sent, and the field is only a claim about it.
const TRUST_LETTER = args.includes('--trust-letter');

const CANON = { en: 'English', english: 'English', de: 'German', german: 'German', deutsch: 'German' };

export function canonicalLanguage(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return CANON[v] || null;
}

// What language is this letter actually written in? The salutation is the
// most reliable single marker. Falls back to null rather than guessing.
export function languageOfLetter(text) {
  const t = String(text || '');
  if (/^\s*Sehr geehrte/m.test(t)) return 'German';
  if (/^\s*Dear\b/m.test(t)) return 'English';
  // Some German letters open with a first-name salutation; the sign-off is
  // the backstop and is effectively invariant in both languages.
  if (/Mit freundlichen Gr(ü|ue)(ß|ss)en/i.test(t)) return 'German';
  if (/^\s*Best regards\b/m.test(t)) return 'English';
  return null;
}

// The per-row decision, pure so the precedence rule can be pinned.
// Returns null (leave alone) or {to, kind}.
//   kind 'fill'      - field empty, letter answers it
//   kind 'normalise' - short code folded to the canonical spelling
//   kind 'correct'   - field contradicts the letter; only when trustLetter
export function decide(current, letterLang, trustLetter) {
  const canon = canonicalLanguage(current);
  if (!current) return letterLang ? { to: letterLang, kind: 'fill' } : null;
  if (!canon) return null;                       // unrecognised value; not ours to reinterpret
  // Disagreement OUTRANKS normalisation. A row can be both: "EN" on a row
  // whose letter is German canonicalises to English, which is still the wrong
  // answer. The letter is the artefact that was sent, so it wins outright.
  if (letterLang && letterLang !== canon) {
    return trustLetter ? { to: letterLang, kind: 'correct' } : null;
  }
  return canon !== current ? { to: canon, kind: 'normalise' } : null;
}

// Newest letter for a row, chosen by the DATE IN THE FILENAME. A plain sort
// is wrong: `APP-{num}-...` and `{num}-...` collate differently, so
// lexicographic order can return the superseded draft.
export function newestLetter(files, num) {
  const mine = files
    .filter((f) => new RegExp(`^(APP-)?0*${num}[^0-9]`).test(f) && f.endsWith('.md'))
    .map((f) => ({ f, d: (f.match(/(\d{4}-\d{2}-\d{2})/) || [, ''])[1] }))
    .sort((a, b) => (a.d === b.d ? a.f.localeCompare(b.f) : a.d.localeCompare(b.d)));
  return mine.length ? mine[mine.length - 1].f : null;
}

if (args.includes('--self-test')) {
  let pass = 0, fail = 0;
  const check = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.log(`  FAIL ${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  check('EN canonicalises', canonicalLanguage('EN'), 'English');
  check('DE canonicalises', canonicalLanguage('DE'), 'German');
  check('already-canonical is unchanged', canonicalLanguage('German'), 'German');
  check('lowercase handled', canonicalLanguage('english'), 'English');
  check('unset stays null', canonicalLanguage(null), null);
  check('unknown stays null', canonicalLanguage('Français'), null);
  check('German salutation', languageOfLetter('Manchester\n\nSehr geehrte Damen und Herren,\n\nText'), 'German');
  check('English salutation', languageOfLetter('London\n\nDear Hiring Team,\n\nText'), 'English');
  check('German sign-off backstop', languageOfLetter('Hallo Team,\n\nText\n\nMit freundlichen Gruessen'), 'German');
  check('no marker -> null, never a guess', languageOfLetter('some notes with no salutation'), null);
  // The picker must return the newest by DATE, not alphabetically.
  check('newest letter by date not prefix',
    newestLetter(['APP-4112-acme-2026-07-25.md', '4112-acme-2026-08-03.md'], '4112'),
    '4112-acme-2026-08-03.md');
  check('no letter -> null', newestLetter(['9999-x-2026-01-01.md'], '4112'), null);

  // Precedence: the letter outranks the canonical spelling of a wrong field.
  check('short code AND contradicting letter -> letter wins',
    decide('EN', 'German', true), { to: 'German', kind: 'correct' });
  check('same case without --trust-letter -> leave alone',
    decide('EN', 'German', false), null);
  check('short code with an agreeing letter -> normalise',
    decide('EN', 'English', false), { to: 'English', kind: 'normalise' });
  check('canonical field agreeing with letter -> no write',
    decide('German', 'German', true), null);
  check('empty field with a letter -> fill',
    decide(null, 'German', false), { to: 'German', kind: 'fill' });
  check('empty field, no letter -> leave unset, never guess',
    decide(null, null, true), null);
  check('unrecognised value is never reinterpreted',
    decide('Francais', 'English', true), null);
  console.log(`\nnormalise-language self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// Only run the sweep when invoked as a script. The helpers above are imported
// by other checks, and an unguarded main body would re-run the whole live
// Notion query on import.
const IS_ENTRY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!IS_ENTRY) { /* imported for its helpers */ } else { await main(); }

async function main() {
let rows;
try {
  rows = JSON.parse(execFileSync('node', [NOTION_QUERY, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
} catch (e) {
  console.error(`LANG_ABORT: could not read live Notion state: ${String(e.message).slice(0, 200)}`);
  process.exit(1);
}

const CL_DIR = path.join(REPO_ROOT, 'output', 'cover-letters');
const letterFiles = fs.existsSync(CL_DIR) ? fs.readdirSync(CL_DIR) : [];

const plan = [];
const disagreements = [];
for (const r of rows) {
  const current = r.language ?? null;
  const canon = canonicalLanguage(current);
  const num = (r.application_id || '').replace(/^APP-/, '');
  const f = num && newestLetter(letterFiles, num);
  let fromLetter = null;
  if (f) { try { fromLetter = languageOfLetter(fs.readFileSync(path.join(CL_DIR, f), 'utf8')); } catch {} }

  if (!current) {
    // No letter: leave unset rather than guess.
    if (fromLetter) plan.push({ r, to: fromLetter, why: `from letter ${f}` });
    continue;
  }
  if (!canon) continue;                        // unrecognised value; not ours to reinterpret
  // Disagreement takes precedence over normalisation: a row can be BOTH a
  // short code AND contradict its letter ("EN" on a row whose letter is
  // German), and the letter is the right final answer, not the canonicalised
  // claim.
  if (fromLetter && fromLetter !== canon) {
    disagreements.push({ r, from: canon, to: fromLetter, f });
    if (TRUST_LETTER) plan.push({ r, to: fromLetter, why: `letter disagrees: field said ${canon}, ${f} is ${fromLetter}` });
    continue;
  }
  if (canon !== current) plan.push({ r, to: canon, why: `normalise "${current}"` });
}

const norm = plan.filter((p) => p.why.startsWith('normalise'));
const filled = plan.filter((p) => p.why.startsWith('from letter'));
console.log(`rows: ${rows.length}`);
console.log(`  short codes to normalise : ${norm.length}`);
console.log(`  blanks fillable from the letter on disk : ${filled.length}`);
const stillBlank = rows.filter((r) => !r.language).length - filled.length;
console.log(`  left unset (no letter on disk, not guessed) : ${stillBlank}`);
console.log(`  field contradicts the sent letter : ${disagreements.length}${TRUST_LETTER ? ' (correcting: letter wins)' : ' (reported only; pass --trust-letter to correct)'}`);
for (const d of disagreements.slice(0, 8)) {
  console.log(`      ${d.r.application_id}  field=${d.from}  letter=${d.to}  stage=${d.r.stage}`);
}
if (disagreements.length > 8) console.log(`      ... and ${disagreements.length - 8} more`);

if (!APPLY) {
  for (const p of plan.slice(0, 10)) console.log(`  ${p.r.application_id} -> ${p.to}   (${p.why})`);
  if (plan.length > 10) console.log(`  ... and ${plan.length - 10} more`);
  console.log(`\nDRY RUN. --apply would write ${plan.length} row(s).`);
  console.log(`LANG_NORMALISE: ${plan.length} planned, 0 written, 0 failed (dry run)`);
  process.exit(0);
}

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('LANG_ABORT: NOTION_TOKEN not set'); process.exit(5); }
const headers = { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

let ok = 0, failed = 0;
for (const p of plan) {
  const res = await fetch(`https://api.notion.com/v1/pages/${p.r.id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ properties: { Language: { select: { name: p.to } } } }),
  });
  if (res.ok) ok++;
  else { failed++; console.log(`  FAIL ${p.r.application_id} ${res.status} ${(await res.text()).slice(0, 140)}`); }
}
console.log(`LANG_NORMALISE: ${plan.length} planned, ${ok} written, ${failed} failed`);
}
