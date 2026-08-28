#!/usr/bin/env node
// Enrol rows into the two funnel experiments, and measure them later.
//
// WHY THIS EXISTS.
// When the funnel bottleneck is not response rate but progression past the
// first human decision, segmentation by score/portal/DACH-vs-UK cannot
// explain it: with a handful of progressions, every available pattern is a
// difference in rejection rate. The only way forward is to run experiments
// deliberately.
//
// The tagging is the whole point. Without a durable mark on the row, nobody
// can tell in three weeks which applications were in the experiment, and
// the result is unmeasurable — which is how "we should try referrals" tends
// to stay an opinion for months.
//
//   exp-feedback : ask a rejecting employer what tipped it. Only worth doing
//                  where a human can actually reply — roughly half of ATS
//                  rejections come from no-reply@ and are a dead end.
//   exp-warm     : do real outreach BEFORE applying, then apply. Tests the
//                  one lever with no data at all when the pipeline has been
//                  cold end-to-end.
//
// SAFETY. This never sends anything. It tags rows and reports. Sending is
// the human's, both because messages go out under their name and because a
// feedback request lands in a real person's inbox.
//
// Usage:
//   node batch/funnel-experiments.mjs --status
//   node batch/funnel-experiments.mjs --enrol warm     APP-4162,APP-5477 [--apply]
//   node batch/funnel-experiments.mjs --enrol feedback APP-5450,APP-3967 [--apply]
//   node batch/funnel-experiments.mjs --self-test
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTION_QUERY = join(REPO_ROOT, 'scripts', 'notion', 'notion-query.mjs');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

export const TAGS = { warm: '[exp-warm', feedback: '[exp-feedback' };

// Progressed = got past the first human decision. This is the ONLY outcome
// either experiment is trying to move.
const PROGRESSED = /^(5\.|6\.|7\.|8\.|9\.|Signed)/;
const RESPONDED = /^(5\.|6\.|7\.|8\.|9\.|Signed|Rejected)/;

// Outcome of one enrolled row, isolated so the self-test can drive it.
export function classify(row) {
  const stage = String(row.stage || '');
  if (PROGRESSED.test(stage)) return 'progressed';
  if (RESPONDED.test(stage)) return 'responded-then-rejected';
  if (row.apply_date) return 'sent-awaiting';
  return 'enrolled-not-yet-sent';
}

export function cohortOf(row) {
  const n = String(row.fit_notes || '');
  const out = [];
  for (const [name, tag] of Object.entries(TAGS)) if (n.includes(tag)) out.push(name);
  return out;
}

if (args.includes('--self-test')) {
  let pass = 0, fail = 0;
  const check = (n, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) pass++;
    else { fail++; console.log(`  FAIL ${n}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
  };
  check('assessment counts as progressed', classify({ stage: '5. Assessment/OA' }), 'progressed');
  check('offer counts as progressed', classify({ stage: '9. Offer' }), 'progressed');
  // A rejection IS a response. Counting it as "no outcome" would hide the
  // very thing being measured: whether the reply came before or after a
  // human call.
  check('rejected is a response, not a blank', classify({ stage: 'Rejected' }), 'responded-then-rejected');
  check('sent and waiting', classify({ stage: '4. Applied', apply_date: '2026-08-25' }), 'sent-awaiting');
  check('enrolled but unsent', classify({ stage: '3. Drafted' }), 'enrolled-not-yet-sent');
  // Withdrew means nothing was ever sent, so it is not an outcome either way.
  check('withdrew is not a response', classify({ stage: 'Withdrew' }), 'enrolled-not-yet-sent');
  check('cohort read from the sentinel', cohortOf({ fit_notes: 'x [exp-warm 2026-08-25] y' }), ['warm']);
  check('both cohorts readable', cohortOf({ fit_notes: '[exp-warm ] [exp-feedback ]' }), ['warm', 'feedback']);
  check('no sentinel, no cohort', cohortOf({ fit_notes: 'nothing here' }), []);
  console.log(`\nfunnel-experiments self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const IS_ENTRY = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_ENTRY) await main();

async function main() {
  let rows;
  try {
    rows = JSON.parse(execFileSync('node', [NOTION_QUERY, '--json'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    console.error(`EXP_ABORT: could not read live Notion state: ${String(e.message).slice(0, 200)}`);
    process.exit(1);
  }
  const byApp = new Map(rows.map((r) => [r.application_id, r]));
  const today = new Date().toISOString().slice(0, 10);

  const enrolKind = argOf('--enrol');
  if (enrolKind) {
    if (!TAGS[enrolKind]) { console.error(`EXP_ABORT: --enrol must be one of ${Object.keys(TAGS).join('|')}`); process.exit(2); }
    const ids = String(args[args.indexOf('--enrol') + 2] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) { console.error('EXP_ABORT: pass a comma-separated list of application ids'); process.exit(2); }
    const why = enrolKind === 'warm'
      ? 'Real outreach to a human at this employer BEFORE applying, then apply. Control: every other application this month, which is cold.'
      : 'Reply to the rejection asking what tipped the decision. Only enrolled where a human address can receive it.';
    let ok = 0, skip = 0, failed = 0;
    for (const id of ids) {
      const r = byApp.get(id);
      if (!r) { skip++; console.log(`  SKIP ${id} not found`); continue; }
      if (cohortOf(r).includes(enrolKind)) { skip++; console.log(`  SKIP ${id} already enrolled`); continue; }
      const line = `${TAGS[enrolKind]} ${today}] ${why} Nothing has been sent by the agent; the message is the human's to send. `;
      console.log(`  ${APPLY ? 'ENROL' : 'PLAN '} ${id.padEnd(9)} ${String(r.stage).padEnd(13)} ${String(r.title || '').slice(0, 28)}`);
      if (!APPLY) continue;
      const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { 'Fit notes': { rich_text: [{ text: { content: (line + (r.fit_notes || '')).slice(0, 1900).trim() } }] } } }),
      });
      if (res.ok) ok++; else { failed++; console.log(`    FAIL ${res.status}`); }
    }
    console.log(`EXP_ENROL: ${enrolKind} ${ok} enrolled, ${skip} skipped, ${failed} failed${APPLY ? '' : ' (dry run)'}`);
    return;
  }

  // --status (default)
  console.log(`funnel experiments as at ${today}\n`);
  for (const kind of Object.keys(TAGS)) {
    const members = rows.filter((r) => cohortOf(r).includes(kind));
    console.log(`${kind.toUpperCase()}  n=${members.length}`);
    if (!members.length) { console.log('  (nobody enrolled yet)\n'); continue; }
    const tally = {};
    for (const r of members) { const c = classify(r); tally[c] = (tally[c] || 0) + 1; }
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    for (const r of members) {
      console.log(`      ${r.application_id.padEnd(9)} ${String(r.stage).padEnd(13)} ${classify(r).padEnd(24)} ${String(r.title || '').slice(0, 26)}`);
    }
    console.log('');
  }
  // The comparison that matters. Baseline is every sent row NOT in an experiment.
  const sent = rows.filter((r) => RESPONDED.test(String(r.stage || '')) || r.apply_date);
  const base = sent.filter((r) => !cohortOf(r).length);
  const prog = base.filter((r) => PROGRESSED.test(String(r.stage || ''))).length;
  console.log(`BASELINE (sent, not in any experiment)  n=${base.length}  progressed ${prog} (${(100 * prog / Math.max(1, base.length)).toFixed(1)}%)`);
  console.log('  -> the number either experiment has to beat.');
}
