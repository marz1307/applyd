/**
 * artefact-date.mjs — recover an application's send date from what is on disk.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Apply date is written by hand: a human flips the Notion Stage select to
 * "4. Applied" after submitting, and the date IS that transition. Nothing
 * enforces writing it, so a row can end up at Stage 4 (or later, or Rejected)
 * with no Apply date recorded.
 *
 * That date is NOT recoverable from any authoritative source. Notion's REST
 * API exposes no per-property history; dashboards are aggregate-only.
 *
 * What IS on disk is the draft: every application leaves a cover letter and a
 * form-answers file whose filename carries a date. The draft precedes the send,
 * so it is an ESTIMATE, never an observation. Anything written from it must say
 * so — see backfill-apply-dates.mjs, which stamps provenance into Fit notes.
 *
 * WHY "LATEST", NOT "EARLIEST"
 * ----------------------------
 * A row can carry several artefact dates because re-render sweeps redraft it.
 * Those sweeps are Stage-3-only by rule, i.e. they run BEFORE the send, so the
 * last draft is the one that was sent and the latest date is the better
 * estimate. It is also the safer one: the Apply date feeds the rejection-
 * recency window, where dating a row too EARLY ages it out and silently stops
 * it blocking a duplicate application.
 *
 * THE RESPONSE-DATE CAP
 * ---------------------
 * The Stage-3-only rule can be broken by a mis-scoped sweep (a re-render that
 * happens AFTER the employer replied). A reply cannot precede the application,
 * which gives a hard upper bound for free: discard any artefact date after the
 * response date.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Cover letters and form answers only. CVs are excluded deliberately: they are
// re-rendered far more often (market tails, archetype variants, QA patches),
// so their dates track sweeps rather than submissions.
export const ARTEFACT_DIRS = Object.freeze(['output/cover-letters', 'output/form-answers']);

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Filenames are `{num}-{slug}-{date}.md` or `APP-{num}-{slug}-{date}.md`.
 * The trailing hyphen in the pattern is load-bearing: without it APP-101 would
 * claim every file belonging to APP-1010..1019.
 */
export function fileMatchesApp(filename, appNum) {
  const n = String(appNum).replace(/^APP-/i, '').replace(/^0+/, '');
  if (!n) return false;
  return new RegExp(`^(APP-)?0*${n}-`).test(String(filename || ''));
}

/** All distinct dates found in the filenames belonging to one application. */
export function datesForApp(filenames, appNum) {
  const out = new Set();
  for (const f of filenames || []) {
    if (!fileMatchesApp(f, appNum)) continue;
    const m = String(f).match(DATE_RE);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/**
 * Choose the single best send-date estimate. Pure, so the self-test can drive
 * every branch without touching the filesystem.
 *
 * Returns null when nothing survives the constraints — a null here means "no
 * estimate", and callers must leave the row alone rather than invent one.
 */
export function pickApplyDate(dates, { responseDate = null, discoveredDate = null, today = null } = {}) {
  let usable = (dates || []).filter(Boolean).slice().sort();
  if (!usable.length) return null;

  // A reply cannot precede the application it answers.
  if (responseDate) usable = usable.filter((d) => d <= responseDate);
  // Nor can a draft precede the day the posting was discovered. This catches a
  // filename collision (a stray file numbered like this row) rather than a real
  // re-render, so it is a correctness guard, not a preference.
  if (discoveredDate) usable = usable.filter((d) => d >= discoveredDate);
  if (today) usable = usable.filter((d) => d <= today);

  return usable.length ? usable[usable.length - 1] : null;
}

/** Reads the artefact directories once. The only impure function here. */
export function readArtefactFilenames(repoRoot) {
  const names = [];
  for (const dir of ARTEFACT_DIRS) {
    try {
      names.push(...fs.readdirSync(path.join(repoRoot, dir)));
    } catch {
      /* a missing output dir is normal on a fresh clone */
    }
  }
  return names;
}

/**
 * Convenience for callers that hold Notion rows: returns appId -> estimate.
 * `rows` is the shape notion-query.mjs --json emits.
 */
export function resolveForRows(rows, filenames, today = null) {
  const out = new Map();
  for (const r of rows || []) {
    const id = r.application_id;
    if (!id) continue;
    const est = pickApplyDate(datesForApp(filenames, id), {
      responseDate: r.response_date, discoveredDate: r.discovered_date, today,
    });
    if (est) out.set(id, est);
  }
  return out;
}

/* ---------------------------------------------------------------- self-test */
// Gated on being the ENTRY POINT, not just on argv. A bare argv check makes
// this block fire inside any importer invoked with --self-test: running a
// downstream --self-test can then trigger THIS block's process.exit and report
// success without the caller's own assertions ever executing.
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (IS_MAIN && process.argv.includes('--self-test')) {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  };

  // --- filename matching
  check('bare numeric prefix matches', fileMatchesApp('101-acme-2026-06-18.md', 'APP-101'), true);
  check('APP- prefix matches', fileMatchesApp('APP-2602-acme-2026-07-01.md', 'APP-2602'), true);
  check('zero padding matches', fileMatchesApp('0054-acme-2026-06-18.md', 'APP-54'), true);
  // The bug this guards: a prefix match without the trailing hyphen makes
  // APP-101 swallow every artefact of APP-1010 through APP-1019.
  check('longer id is NOT matched', fileMatchesApp('1010-other-2026-06-18.md', 'APP-101'), false);
  check('different id is not matched', fileMatchesApp('202-other-2026-06-18.md', 'APP-101'), false);

  check('dates are deduped and sorted',
    datesForApp(['101-a-2026-07-01.md', '101-b-2026-06-18.md', '101-c-2026-07-01.md'], 'APP-101'),
    ['2026-06-18', '2026-07-01']);
  check('no artefacts yields no dates', datesForApp(['999-x-2026-06-18.md'], 'APP-101'), []);

  // --- picking
  check('single date is returned', pickApplyDate(['2026-06-14']), '2026-06-14');
  check('latest wins with no constraints', pickApplyDate(['2026-06-18', '2026-07-01']), '2026-07-01');
  check('empty input yields null', pickApplyDate([]), null);

  // A re-render that landed after the employer replied.
  check('a post-response re-render is discarded',
    pickApplyDate(['2026-08-05', '2026-08-13'], { responseDate: '2026-08-07' }), '2026-08-05');
  check('an artefact ON the response date is allowed',
    pickApplyDate(['2026-08-07'], { responseDate: '2026-08-07' }), '2026-08-07');
  check('every artefact post-dating the response yields null',
    pickApplyDate(['2026-08-20'], { responseDate: '2026-08-07' }), null);

  check('an artefact predating discovery is discarded',
    pickApplyDate(['2026-05-01', '2026-06-20'], { discoveredDate: '2026-06-11' }), '2026-06-20');
  check('a future artefact is discarded',
    pickApplyDate(['2026-06-20', '2027-01-01'], { today: '2026-08-28' }), '2026-06-20');
  check('constraints compose',
    pickApplyDate(['2026-06-01', '2026-06-20', '2026-08-30'],
      { discoveredDate: '2026-06-11', responseDate: '2026-07-15', today: '2026-08-28' }), '2026-06-20');

  // --- row resolution
  const rows = [
    { application_id: 'APP-101', discovered_date: '2026-05-25', response_date: null },
    { application_id: 'APP-4894', discovered_date: '2026-08-04', response_date: '2026-08-07' },
    { application_id: 'APP-999', discovered_date: '2026-08-01', response_date: null },
  ];
  const files = ['101-a-2026-06-18.md', '101-a-2026-07-01.md', '4894-b-2026-08-05.md', '4894-b-2026-08-13.md'];
  const m = resolveForRows(rows, files, '2026-08-28');
  check('resolveForRows picks latest', m.get('APP-101'), '2026-07-01');
  check('resolveForRows applies the response cap', m.get('APP-4894'), '2026-08-05');
  check('a row with no artefacts is absent', m.has('APP-999'), false);

  console.log(`\nartefact-date self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
