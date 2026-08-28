#!/usr/bin/env node
/**
 * backfill-apply-dates.mjs — fill the Apply date on sent rows that lost it.
 *
 * WHAT THIS WRITES IS AN ESTIMATE, AND IT SAYS SO
 * -----------------------------------------------
 * The true Apply date is the day the Notion Stage select was flipped to
 * "4. Applied" by hand. That flip is not recorded anywhere recoverable (see the
 * header of artefact-date.mjs for the reasoning), so this script substitutes
 * the date of the last draft artefact on disk. The draft precedes the send,
 * usually by a day or two.
 *
 * Every row it touches is tagged `Agent run ID = apply-backfill-{date}` and
 * recorded in data/backfills/{date}-apply-dates/. If a later question turns on
 * whether an Apply date was observed or inferred, that tag is the answer.
 *
 * WHY IT WILL NOT TRUNCATE Fit notes
 * ----------------------------------
 * The house convention for provenance is `(line + existing).slice(0, 1900)`.
 * That is unsafe here. Fit notes carries tokens other layers select on —
 * `[blocks ` (metrics dimension calibration), `no-warm-path` (cold referral
 * queue), `[collision-ruled` (recheck-collisions) — and prepending unconditional
 * text can push a token off the end. Losing one is silent: the row just stops
 * appearing in a downstream selection.
 *
 * So the note is prepended ONLY when it fits. When it does not, the write still
 * happens — the Apply date and the run-ID tag are the load-bearing parts — and
 * the skip is recorded in the audit file. Provenance never costs someone
 * else's data.
 *
 * Usage:
 *   node batch/backfill-apply-dates.mjs              # dry run, prints the plan
 *   node batch/backfill-apply-dates.mjs --apply      # writes
 *   node batch/backfill-apply-dates.mjs --self-test
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readArtefactFilenames, resolveForRows } from './artefact-date.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTION_QUERY = path.join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

const FIT_NOTES_MAX = 1900;

// Stages that mean "this was submitted". Terminals are included because a row
// can be rejected without ever having been given its Apply date — that is
// precisely the population this exists for.
const SENT_STAGES = /^(4\. Applied|5\.|6\.|7\.|8\.|9\.|Signed|Rejected)/;

/**
 * The whole decision, isolated from Notion and the filesystem so the self-test
 * can drive it. `estimates` is appId -> 'YYYY-MM-DD'.
 */
export function selectBackfillable(rows, estimates) {
  const out = [];
  for (const r of rows || []) {
    // An existing Apply date is a record. Never overwrite one, even if the
    // artefact disagrees — the recorded value is the observation.
    if (r.apply_date) continue;
    if (!SENT_STAGES.test(String(r.stage || ''))) continue;
    const est = estimates.get?.(r.application_id) ?? estimates[r.application_id];
    if (!est) continue;
    out.push({
      app: r.application_id, id: r.id, stage: r.stage, company: r.title,
      estimate: est, response_date: r.response_date || null,
      discovered_date: r.discovered_date || null, fit_notes: r.fit_notes || '',
    });
  }
  return out.sort((a, b) => String(a.estimate).localeCompare(String(b.estimate)));
}

/**
 * Returns the Fit notes value to write, or null to leave the property alone.
 * Null is the signal that the note did not fit — never a truncated string.
 */
export function composeFitNotes(existing, line, max = FIT_NOTES_MAX) {
  const combined = `${line}\n${existing || ''}`.trim();
  return combined.length <= max ? combined : null;
}

export const provenanceLine = (estimate, today) =>
  `[apply-backfill ${today}] Apply date ${estimate} ESTIMATED from the last draft artefact on disk, not observed. The real send date (the Stage->"4. Applied" flip) was never recorded.`;

/* ---------------------------------------------------------------- self-test */
const IS_MAIN = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (IS_MAIN && args.includes('--self-test')) {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (ok) pass++; else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  };
  const row = (app, stage, apply_date, extra = {}) =>
    ({ application_id: app, id: 'pg-' + app, stage, apply_date, title: 'Acme', ...extra });
  const est = new Map([['APP-1', '2026-06-14'], ['APP-2', '2026-07-01'], ['APP-3', '2026-05-02']]);

  check('an undated Applied row is selected',
    selectBackfillable([row('APP-1', '4. Applied', null)], est).map((r) => r.app), ['APP-1']);
  check('an undated Rejected row is selected',
    selectBackfillable([row('APP-1', 'Rejected', null)], est).map((r) => r.app), ['APP-1']);
  // The single most destructive thing this script could do.
  check('a row that ALREADY has an apply date is never touched',
    selectBackfillable([row('APP-1', '4. Applied', '2026-08-01')], est).length, 0);
  check('an unsent row is never touched',
    selectBackfillable([row('APP-1', '3. Drafted', null), row('APP-2', '1. Discovered', null)], est).length, 0);
  check('Withdrew and Not pursuing are never touched',
    selectBackfillable([row('APP-1', 'Withdrew', null), row('APP-2', 'Not pursuing', null)], est).length, 0);
  check('a row with no estimate is skipped',
    selectBackfillable([row('APP-9', 'Rejected', null)], est).length, 0);
  check('interview stages are selected',
    selectBackfillable([row('APP-1', '6. Phone screen', null)], est).map((r) => r.app), ['APP-1']);
  check('oldest estimate first',
    selectBackfillable([row('APP-2', 'Rejected', null), row('APP-3', 'Rejected', null)], est).map((r) => r.app),
    ['APP-3', 'APP-2']);
  check('a plain object works as the estimate map',
    selectBackfillable([row('APP-1', 'Rejected', null)], { 'APP-1': '2026-06-14' }).length, 1);

  // --- Fit notes: the note must never cost existing content
  check('a note that fits is prepended',
    composeFitNotes('existing', 'LINE', 100), 'LINE\nexisting');
  check('a note that does not fit yields null, NOT a truncation',
    composeFitNotes('x'.repeat(1900), 'LINE', 1900), null);
  check('a note landing exactly ON the limit is kept',
    composeFitNotes('x'.repeat(1895), 'LINE', 1900).length, 1900);
  check('an empty existing note is fine', composeFitNotes('', 'LINE', 100), 'LINE');
  const tokenNote = '[blocks A=5 B=3] ' + 'y'.repeat(1850) + ' no-warm-path';
  check('a token-bearing note at the limit is left alone',
    composeFitNotes(tokenNote, provenanceLine('2026-06-14', '2026-08-28')), null);
  check('a short token-bearing note still gets the line',
    typeof composeFitNotes('[blocks A=5] no-warm-path', provenanceLine('2026-06-14', '2026-08-28')), 'string');
  check('the prepended note preserves the tokens verbatim',
    /\[blocks A=5\][\s\S]*no-warm-path/.test(composeFitNotes('[blocks A=5] no-warm-path', 'LINE')), true);

  console.log(`\nbackfill-apply-dates self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/* ---------------------------------------------------------------- live run */
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error('BACKFILL_ABORT: NOTION_TOKEN is not set'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);

let rows;
try {
  const out = execFileSync('node', [NOTION_QUERY, '--json'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  rows = JSON.parse(out);
} catch (e) {
  console.error(`BACKFILL_ABORT: could not read live Notion state: ${String(e.message).slice(0, 300)}`);
  process.exit(1);
}

const filenames = readArtefactFilenames(REPO_ROOT);
const estimates = resolveForRows(rows, filenames, today);
const targets = selectBackfillable(rows, estimates);

const undatedSent = rows.filter((r) => !r.apply_date && SENT_STAGES.test(String(r.stage || '')));
console.log(`Sent rows with no Apply date: ${undatedSent.length}`);
console.log(`Recoverable from a draft artefact: ${targets.length}`);
console.log(`No artefact on disk, left undated:  ${undatedSent.length - targets.length}`);
console.log(`Artefact files indexed: ${filenames.length}\n`);

for (const t of targets) {
  const lag = t.response_date
    ? Math.round((Date.parse(t.response_date) - Date.parse(t.estimate)) / 86400000) : null;
  console.log(`  ${t.estimate}  ${String(t.app).padEnd(9)} ${String(t.stage).padEnd(11)} ${String(t.company || '').slice(0, 28).padEnd(29)}${lag === null ? '' : `resp +${lag}d`}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply.`);
  process.exit(0);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json',
};

const audit = [];
let ok = 0, failed = 0, noteSkipped = 0;

for (const t of targets) {
  const note = composeFitNotes(t.fit_notes, provenanceLine(t.estimate, today));
  if (note === null) noteSkipped++;
  const properties = {
    'Apply date': { date: { start: t.estimate } },
    'Agent run ID': { rich_text: [{ text: { content: `apply-backfill-${today}` } }] },
  };
  if (note !== null) properties['Fit notes'] = { rich_text: [{ text: { content: note } }] };

  let res;
  try {
    res = await fetch(`https://api.notion.com/v1/pages/${t.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ properties }),
    });
  } catch (e) {
    failed++; console.log(`  FAIL ${t.app} ${String(e.message).slice(0, 120)}`);
    audit.push({ ...t, written: false, error: String(e.message).slice(0, 200) });
    continue;
  }
  if (res.ok) {
    ok++;
    audit.push({ app: t.app, page_id: t.id, stage: t.stage, company: t.company,
      apply_date_written: t.estimate, source: 'draft-artefact', observed: false,
      response_date: t.response_date, discovered_date: t.discovered_date,
      fit_note_added: note !== null });
  } else {
    failed++;
    const body = (await res.text()).slice(0, 160);
    console.log(`  FAIL ${t.app} ${res.status} ${body}`);
    audit.push({ ...t, written: false, error: `${res.status} ${body}` });
  }
}

const dir = path.join(REPO_ROOT, 'data', 'backfills', `${today}-apply-dates`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'written.json'), JSON.stringify(audit, null, 2));
fs.writeFileSync(path.join(dir, 'README.md'),
  `# Apply-date backfill — ${today}\n\n` +
  `${ok} rows given an Apply date ESTIMATED from the last draft artefact on disk.\n` +
  `These are NOT observed send dates. The real send date is the day the Notion\n` +
  `Stage select was flipped to "4. Applied" by hand; that transition is not\n` +
  `recorded anywhere recoverable.\n\n` +
  `Every row carries \`Agent run ID = apply-backfill-${today}\`. To find them again:\n` +
  `filter the Applications DB on that value, or read written.json here.\n\n` +
  `${noteSkipped} rows did not get the Fit-notes provenance line because adding it\n` +
  `would have pushed the note past Notion's limit and truncated tokens that other\n` +
  `layers select on. The run-ID tag is on those rows regardless.\n`);

console.log(`\nwritten: ${ok}   failed: ${failed}   fit-note skipped (kept intact): ${noteSkipped}`);
console.log(`audit: data/backfills/${today}-apply-dates/`);
console.log(`BACKFILL_APPLY_DATES: written=${ok} failed=${failed} skipped_note=${noteSkipped}`);
