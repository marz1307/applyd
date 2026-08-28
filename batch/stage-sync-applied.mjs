#!/usr/bin/env node
// Move `3. Drafted` rows that already carry an Apply date to `4. Applied`.
//
// WHY THIS EXISTS.
// Applications are submitted by hand, outside the pipeline, and the human
// sets the Apply date when they do. Nothing advances the Stage, so the row
// keeps saying "Drafted" for an application that is already sitting in
// someone's inbox.
//
// It is not cosmetic. An Apply date is the ONLY reliable evidence that an
// application was sent, and three separate things read the Stage instead:
//
//   1. The funnel undercounts. `4. Applied` is the denominator for response
//      rate, so every stale row deflates it.
//   2. `batch/recheck-collisions.mjs` treats Stage 4+ as "in flight" and
//      Stage 3 as "still decidable". A sent-but-stale row is invisible as a
//      collision PARTNER, so a genuine second application to that employer
//      can pass. This is why the sync runs BEFORE the collision re-check.
//   3. Copy sweeps that scope by Stage will rewrite documents for
//      applications already sent.
//
// THE RULE: Stage is not the signal for "was it sent". The Apply date is.
//
// SAFETY. Only ever moves 3. Drafted -> 4. Applied, and only when an Apply
// date is present. Never touches Stage 4+, never a terminal, never a document.
//
// Usage:
//   node batch/stage-sync-applied.mjs              # report only (default)
//   node batch/stage-sync-applied.mjs --apply
//   node batch/stage-sync-applied.mjs --json
//   node batch/stage-sync-applied.mjs --self-test
import process from 'node:process';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTION_QUERY = join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');

const FROM = '3. Drafted';
const TO = '4. Applied';

// The whole decision, isolated from Notion so the self-test can drive it.
export function selectStale(rows) {
  return rows
    .filter((r) => String(r.stage || '') === FROM && r.apply_date)
    .sort((a, b) => String(a.apply_date).localeCompare(String(b.apply_date)));
}

// The INVERSE gap: a row sitting at Stage 4+ with no Apply date.
//
// Same relationship, broken the other way, and it is the more damaging half.
// A stale Stage-3 row is at least visible as an anomaly; a Stage-4 row with
// no date looks complete and silently drops out of every timing analysis.
//
// Historical undated rows are repaired by batch/backfill-apply-dates.mjs, which
// estimates from the draft artefact on disk. Future ones are caught by the
// date rescue below, which stamps the flip date instead of reconstructing it.
const SENT_STAGES = /^(4[.]|5[.]|6[.]|7[.]|8[.]|9[.]|Signed|Rejected)/;
export function selectUndatedSent(rows) {
  return rows.filter((r) => SENT_STAGES.test(String(r.stage || '')) && !r.apply_date);
}

// ---------------------------------------------------------------- date rescue
//
// The Apply date IS the day the Stage select was flipped to "4. Applied" by
// hand. Nothing captures it, and it is not reconstructable afterwards: Notion
// exposes no per-property history.
//
// This guard runs daily, so it can stand where the flip happens: a row seen
// at Stage 4 with no Apply date is one that was flipped since the last run,
// and today is that date to within a day. Bounded lateness beats permanent
// loss.
//
// WHY THIS SELECTOR IS NARROWER THAN selectUndatedSent, AND MUST STAY SO.
// selectUndatedSent deliberately includes terminals — as a REPORT that is
// right. As an ACTION it would be destructive: a terminal Rejected row can
// have been undated for weeks or months, so stamping "today" would write a
// date that is months wrong into a field that feeds both the 90-day
// rejection-recency window and the funnel. Only a row still sitting at
// "4. Applied" can have flipped recently. Do not merge these two selectors.
export function selectUndatedApplied(rows) {
  return rows.filter((r) => String(r.stage || '') === TO && !r.apply_date);
}

/**
 * Decide what to stamp. Pure, so the self-test drives every branch.
 *
 * `ledger` is appId -> { first_seen, preexisting }. A row marked `preexisting`
 * was already undated when the ledger was seeded, so its flip predates this
 * mechanism and today says nothing about it — those are left for
 * backfill-apply-dates.mjs, which estimates from the draft artefact and labels
 * the result as an estimate.
 */
export function planStamps(undatedApplied, ledger, today) {
  const stamp = [], seed = [], held = [];
  for (const r of undatedApplied) {
    const seen = ledger[r.application_id];
    if (!seen) { seed.push(r); continue; }          // first sighting this run
    if (seen.preexisting) { held.push(r); continue; }
    stamp.push({ ...r, stamp_date: seen.first_seen });
  }
  return { stamp, seed, held };
}

// ---------------------------------------------------------------- self-test
if (args.includes('--self-test')) {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  };
  const row = (app, stage, apply_date) => ({ application_id: app, stage, apply_date, title: 'X' });

  check('a Drafted row with an apply date is selected',
    selectStale([row('APP-1', '3. Drafted', '2026-08-25')]).map((r) => r.application_id), ['APP-1']);
  check('a Drafted row WITHOUT an apply date is left alone',
    selectStale([row('APP-2', '3. Drafted', null)]).length, 0);
  // Stage 4+ and terminals are records; touching them would rewrite history.
  for (const s of ['4. Applied', '5. Assessment/OA', '9. Offer', 'Rejected', 'Withdrew', 'Not pursuing', '1. Discovered', '2. Triaged']) {
    check(`stage "${s}" is never selected`, selectStale([row('APP-3', s, '2026-08-25')]).length, 0);
  }
  check('oldest apply date first',
    selectStale([row('APP-B', '3. Drafted', '2026-08-25'), row('APP-A', '3. Drafted', '2026-08-21')])
      .map((r) => r.application_id), ['APP-A', 'APP-B']);
  // An empty string is not a date.
  check('an empty apply date is not an apply date',
    selectStale([row('APP-4', '3. Drafted', '')]).length, 0);

  check('a Stage-4 row with no apply date is reported',
    selectUndatedSent([row('APP-5', '4. Applied', null)]).map((r) => r.application_id), ['APP-5']);
  check('a Rejected row with no apply date is reported',
    selectUndatedSent([row('APP-6', 'Rejected', null)]).map((r) => r.application_id), ['APP-6']);
  check('a dated sent row is not reported',
    selectUndatedSent([row('APP-7', '4. Applied', '2026-08-25')]).length, 0);
  check('an unsent row is not reported as undated-sent',
    selectUndatedSent([row('APP-8', '3. Drafted', null), row('APP-9', '1. Discovered', null)]).length, 0);

  // --- date rescue. The action selector must be strictly narrower than the report.
  check('an undated Stage-4 row is selected for stamping',
    selectUndatedApplied([row('APP-10', '4. Applied', null)]).map((r) => r.application_id), ['APP-10']);
  // THE guard. selectUndatedSent returns this row; selectUndatedApplied must not.
  // Stamping a terminal with today writes a date that can be months wrong.
  for (const s of ['Rejected', 'Withdrew', 'Not pursuing', '5. Assessment/OA', '9. Offer', 'Signed']) {
    check(`stage "${s}" is never stamped`, selectUndatedApplied([row('APP-11', s, null)]).length, 0);
  }
  check('a terminal IS still reported, only not stamped',
    selectUndatedSent([row('APP-12', 'Rejected', null)]).length, 1);
  check('a dated Stage-4 row is not stamped',
    selectUndatedApplied([row('APP-13', '4. Applied', '2026-08-25')]).length, 0);

  const u = (app) => row(app, '4. Applied', null);
  check('a first sighting is watched, not stamped',
    (() => { const p = planStamps([u('APP-20')], {}, '2026-08-28');
      return [p.stamp.length, p.seed.length, p.held.length]; })(), [0, 1, 0]);
  check('a row watched yesterday is stamped with YESTERDAY, not today',
    planStamps([u('APP-21')], { 'APP-21': { first_seen: '2026-08-27', preexisting: false } }, '2026-08-28')
      .stamp.map((r) => r.stamp_date), ['2026-08-27']);
  // A backlog that predates the ledger must never be stamped, because "first
  // seen today" says nothing about when it was actually flipped.
  check('a preexisting row is held, never stamped',
    (() => { const p = planStamps([u('APP-22')], { 'APP-22': { first_seen: '2026-08-28', preexisting: true } }, '2026-08-28');
      return [p.stamp.length, p.held.length]; })(), [0, 1]);

  console.log(`\nstage-sync-applied self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------- live run
let rows;
try {
  const out = execFileSync('node', [NOTION_QUERY, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  rows = JSON.parse(out);
} catch (e) {
  console.error(`STAGE_SYNC_ABORT: could not read live Notion state: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}

const stale = selectStale(rows);
const undated = selectUndatedSent(rows);

if (JSON_OUT) {
  console.log(JSON.stringify({ from: FROM, to: TO, count: stale.length,
    rows: stale.map((r) => ({ app: r.application_id, apply_date: r.apply_date, company: r.title, score: r.match_score })) }, null, 2));
} else {
  console.log(`Stage "${FROM}" rows carrying an Apply date: ${stale.length}`);
  if (undated.length) console.log(`Sent rows with NO Apply date: ${undated.length} (invisible to timing analysis; unrecoverable, not repaired here)`);
  for (const r of stale) {
    console.log(`  ${r.apply_date}  ${String(r.application_id).padEnd(9)} ${String(r.match_score ?? '').padStart(3)}  ${String(r.title || '').slice(0, 30)}`);
  }
}

// Declared before the dry-run branch: the preview below uses it, and leaving
// it after the TOKEN check would put it in the temporal dead zone for that path.
const today = new Date().toISOString().slice(0, 10);

if (!APPLY) {
  // The preview must cover the date rescue too. A dry run reporting only the
  // stage moves reads as "the guard has nothing to do" even when it is about
  // to stamp rows — the same silent-half-a-job shape this guard exists to fix.
  const ledgerPeek = (() => {
    try { return JSON.parse(fs.readFileSync(join(REPO_ROOT, 'data', 'apply-date-sightings.json'), 'utf8')); }
    catch { return {}; }
  })();
  const peek = planStamps(selectUndatedApplied(rows), ledgerPeek, today);
  if (!JSON_OUT) {
    console.log(`\nDRY RUN. --apply would move ${stale.length} row(s) to "${TO}".`);
    console.log(`DRY RUN. --apply would stamp an Apply date on ${peek.stamp.length} row(s) and start watching ${peek.seed.length}.`);
  }
  console.log(`STAGE_SYNC: ${stale.length} stale, 0 moved, 0 failed, ${undated.length} undated-sent (dry run)`);
  console.log(`APPLY_DATE_RESCUE: 0 dated, 0 failed, ${peek.seed.length} newly watched, ${peek.held.length} preexisting (dry run; would stamp ${peek.stamp.length})`);
  process.exit(0);
}

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('STAGE_SYNC_ABORT: NOTION_TOKEN not set'); process.exit(5); }
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

let ok = 0, failed = 0;
for (const r of stale) {
  const line = `[stage-sync ${today}] Apply date ${r.apply_date} present at "${FROM}": the application was sent and the stage was stale. Moved to ${TO}. Documents left exactly as sent. `;
  const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties: {
      Stage: { select: { name: TO } },
      'Fit notes': { rich_text: [{ text: { content: (line + (r.fit_notes || '')).slice(0, 1900).trim() } }] },
    } }),
  });
  if (res.ok) { ok++; if (!JSON_OUT) console.log(`  MOVED ${r.application_id} -> ${TO}`); }
  else { failed++; console.log(`  FAIL ${r.application_id} ${res.status} ${(await res.text()).slice(0, 160)}`); }
}
// ---- date rescue: capture the flip date for rows that lost their Apply date
const LEDGER = join(REPO_ROOT, 'data', 'apply-date-sightings.json');
const ledgerExisted = fs.existsSync(LEDGER);
let ledger = {};
if (ledgerExisted) {
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); }
  catch { console.log('STAGE_SYNC_WARN: sightings ledger unreadable, treating as empty'); }
}

const undatedApplied = selectUndatedApplied(rows);
const { stamp, seed, held } = planStamps(undatedApplied, ledger, today);

let stamped = 0, stampFailed = 0;
for (const r of stamp) {
  const line = `[apply-date-rescue ${today}] Apply date ${r.stamp_date} recorded by the daily stage-sync guard: this row was first seen at "${TO}" with no Apply date on that day, so the hand-flip happened then. `;
  const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ properties: {
      'Apply date': { date: { start: r.stamp_date } },
      'Fit notes': { rich_text: [{ text: { content: (line + (r.fit_notes || '')).slice(0, 1900).trim() } }] },
    } }),
  });
  if (res.ok) { stamped++; if (!JSON_OUT) console.log(`  DATED ${r.application_id} -> ${r.stamp_date}`); }
  else { stampFailed++; console.log(`  FAIL-DATE ${r.application_id} ${res.status} ${(await res.text()).slice(0, 160)}`); }
}

// A row seen for the first time is recorded now and stamped on the NEXT run,
// so the date written is the day it was first seen undated rather than the
// day the guard got round to it. On the very first run there is no ledger,
// so the whole current population predates this mechanism and is marked
// `preexisting` — today says nothing about when those were flipped, and
// stamping them would fabricate.
for (const r of seed) {
  ledger[r.application_id] = { first_seen: today, preexisting: !ledgerExisted };
}
// Rows that have since gained an Apply date drop out; do not let the ledger
// grow without bound.
const stillUndated = new Set(undatedApplied.map((r) => r.application_id));
for (const k of Object.keys(ledger)) if (!stillUndated.has(k)) delete ledger[k];

try {
  const dir = dirname(LEDGER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2));
} catch (e) {
  console.log(`STAGE_SYNC_WARN: could not write sightings ledger: ${String(e.message).slice(0, 120)}`);
}

// Single machine-readable line for the drain wrapper to grep. The exit code
// is NOT a reliable signal here: notion writes can succeed and the process
// still die on a libuv assertion at teardown (the known exit-127 crash).
console.log(`STAGE_SYNC: ${stale.length} stale, ${ok} moved, ${failed} failed, ${undated.length} undated-sent`);
console.log(`APPLY_DATE_RESCUE: ${stamped} dated, ${stampFailed} failed, ${seed.length} newly watched, ${held.length} preexisting (need backfill-apply-dates.mjs)`);
