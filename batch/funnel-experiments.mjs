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
//   node batch/funnel-experiments.mjs --enrol warm     APP-1000,APP-1001 [--apply]
//   node batch/funnel-experiments.mjs --enrol feedback APP-1002,APP-1003 [--apply]
//   node batch/funnel-experiments.mjs --exclude warm   APP-1000 --why "reason" [--apply]
//   node batch/funnel-experiments.mjs --unexclude warm APP-1000 --why "reason" [--apply]
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

// -- Exclusion ---------------------------------------------------------------
// Some enrolled rows can never produce a result: the posting died, or no human
// could be found to do the outreach to. Leaving them in inflates the
// denominator with rows the intervention was never actually performed on.
//
// They are marked EXCLUDED IN PLACE rather than untagged. Quietly deleting a
// subject after seeing which way it went is precisely how an experiment lies,
// so the enrolment date, the exclusion date and the reason all stay on the
// row where anyone re-reading it can see what was dropped and why.
// kind is a controlled cohort slug (e.g. "mkt-a") — but escape it anyway so a
// malformed --exclude argument (or a future caller passing a regex-metachar
// through cohortOf) can't turn either regex into a ReDoS pattern.
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exclRe = (kind) => new RegExp(`\\[exp-${escRe(kind)} (\\d{4}-\\d{2}-\\d{2}) EXCLUDED (\\d{4}-\\d{2}-\\d{2}): ([^\\]]*)\\]`);
const headRe = (kind) => new RegExp(`\\[exp-${escRe(kind)} (\\d{4}-\\d{2}-\\d{2})\\]`);

export function exclusionOf(row, kind) {
  const m = exclRe(kind).exec(String(row.fit_notes || ''));
  return m ? { enrolled: m[1], excluded: m[2], reason: m[3] } : null;
}

/** Cohorts this row still counts towards. An excluded row is tagged but not counted. */
export function liveCohortOf(row) {
  return cohortOf(row).filter((k) => !exclusionOf(row, k));
}

export function markExcluded(notes, kind, dateISO, reason) {
  const s = String(notes ?? '');
  if (!TAGS[kind]) return { ok: false, why: `unknown cohort "${kind}"`, text: s };
  if (!s.includes(TAGS[kind])) return { ok: false, why: `not enrolled in ${kind}`, text: s };
  if (exclusionOf({ fit_notes: s }, kind)) return { ok: false, why: `already excluded from ${kind}`, text: s };
  if (!reason || !String(reason).trim()) return { ok: false, why: 'an exclusion needs a reason — a silent drop is how an experiment lies', text: s };
  if (/[[\]]/.test(reason)) return { ok: false, why: 'the reason cannot contain square brackets — it would break the sentinel', text: s };
  if (!headRe(kind).test(s)) return { ok: false, why: 'the sentinel is not in the known shape — refusing to guess at the edit', text: s };
  const out = s.replace(headRe(kind), `[exp-${kind} $1 EXCLUDED ${dateISO}: ${String(reason).trim()}]`);
  // Fit notes carries sentinels other passes depend on. Never trade one for another.
  const lost = ['[blocks', '[auto-draft', '[referral-scout', '[collision-ruled', 'no-warm-path', '[chase', '[interview-prep']
    .filter((t) => s.includes(t) && !out.includes(t));
  if (lost.length) return { ok: false, why: `the edit would drop other sentinels: ${lost.join(', ')}`, text: s };
  return { ok: true, text: out };
}

/**
 * Reverse an exclusion whose stated reason turned out to be false.
 *
 * This is NOT a way to re-admit a subject because you liked its outcome
 * better in. It exists because an exclusion carries a factual claim, and a
 * claim can be wrong: a row excluded for "no contact findable at this
 * employer" can be re-admitted if a proper re-search then finds one. Leaving
 * the row out on a disproven premise would be its own kind of lie.
 */
export function markUnexcluded(notes, kind) {
  const s = String(notes ?? '');
  if (!TAGS[kind]) return { ok: false, why: `unknown cohort "${kind}"`, text: s };
  if (!exclusionOf({ fit_notes: s }, kind)) return { ok: false, why: `not excluded from ${kind}`, text: s };
  const out = s.replace(exclRe(kind), `[exp-${kind} $1]`);
  return { ok: true, text: out };
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

  // Exclusion. The trail must survive; the denominator must not.
  const enrolled = '[exp-warm 2026-08-25] Real outreach first. [blocks A4 B5] no-warm-path';
  const ex = markExcluded(enrolled, 'warm', '2026-08-29', 'application withdrawn');
  check('an exclusion is written in place', ex.ok, true);
  check('the enrolment date survives', /\[exp-warm 2026-08-25 EXCLUDED 2026-08-29: application withdrawn\]/.test(ex.text), true);
  check('other sentinels survive the edit', /\[blocks A4 B5\] no-warm-path/.test(ex.text), true);
  check('an excluded row is still tagged', cohortOf({ fit_notes: ex.text }), ['warm']);
  check('an excluded row no longer counts', liveCohortOf({ fit_notes: ex.text }), []);
  check('the reason is readable afterwards', exclusionOf({ fit_notes: ex.text }, 'warm').reason, 'application withdrawn');
  check('the other cohort is untouched', exclusionOf({ fit_notes: ex.text }, 'feedback'), null);
  check('a live row still counts', liveCohortOf({ fit_notes: enrolled }), ['warm']);
  check('cannot exclude what was never enrolled', markExcluded('nothing here', 'warm', '2026-08-29', 'x').ok, false);
  check('cannot exclude without a reason', markExcluded(enrolled, 'warm', '2026-08-29', '  ').ok, false);
  check('a bracket in the reason is refused', markExcluded(enrolled, 'warm', '2026-08-29', 'see [note]').ok, false);
  check('cannot exclude twice', markExcluded(ex.text, 'warm', '2026-08-30', 'again').ok, false);
  check('a malformed sentinel is not guessed at', markExcluded('[exp-warm] no date', 'warm', '2026-08-29', 'x').ok, false);
  check('excluding warm leaves feedback alone', liveCohortOf({
    fit_notes: markExcluded('[exp-warm 2026-08-25] a [exp-feedback 2026-08-25] b', 'warm', '2026-08-29', 'dead').text,
  }), ['feedback']);

  // Un-exclusion: only for a disproven premise, and it must round-trip exactly.
  const back = markUnexcluded(ex.text, 'warm');
  check('an exclusion can be reversed', back.ok, true);
  check('reversal restores the original enrolment exactly', back.text, enrolled);
  check('the row counts again after reversal', liveCohortOf({ fit_notes: back.text }), ['warm']);
  check('cannot un-exclude what was never excluded', markUnexcluded(enrolled, 'warm').ok, false);
  check('cannot un-exclude an unknown cohort', markUnexcluded(ex.text, 'nonsense').ok, false);

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

  const unexKind = argOf('--unexclude');
  if (unexKind) {
    if (!TAGS[unexKind]) { console.error(`EXP_ABORT: --unexclude must be one of ${Object.keys(TAGS).join('|')}`); process.exit(2); }
    const ids = String(args[args.indexOf('--unexclude') + 2] || '').split(',').map((x) => x.trim()).filter(Boolean);
    const why = argOf('--why');
    if (!ids.length) { console.error('EXP_ABORT: pass a comma-separated list of application ids'); process.exit(2); }
    if (!why) { console.error('EXP_ABORT: --why is required. Reversing an exclusion needs the reason the original one was wrong.'); process.exit(2); }
    let ok = 0, skip = 0, failed = 0;
    for (const id of ids) {
      const r = byApp.get(id);
      if (!r) { skip++; console.log(`  SKIP ${id} not found`); continue; }
      const edit = markUnexcluded(r.fit_notes || '', unexKind);
      if (!edit.ok) { skip++; console.log(`  SKIP ${id} ${edit.why}`); continue; }
      console.log(`  ${APPLY ? 'BACK ' : 'PLAN '} ${id.padEnd(9)} ${String(r.stage).padEnd(13)} ${String(r.title || '').slice(0, 28)}`);
      if (!APPLY) continue;
      const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { 'Fit notes': { rich_text: [{ text: { content: edit.text.slice(0, 1900).trim() } }] } } }),
      });
      if (res.ok) ok++; else { failed++; console.log(`    FAIL ${res.status}`); }
    }
    console.log(`EXP_UNEXCLUDE: ${unexKind} ${ok} restored, ${skip} skipped, ${failed} failed${APPLY ? '' : ' (dry run)'}  reason: ${why}`);
    return;
  }

  const excludeKind = argOf('--exclude');
  if (excludeKind) {
    if (!TAGS[excludeKind]) { console.error(`EXP_ABORT: --exclude must be one of ${Object.keys(TAGS).join('|')}`); process.exit(2); }
    const ids = String(args[args.indexOf('--exclude') + 2] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const why = argOf('--why');
    if (!ids.length) { console.error('EXP_ABORT: pass a comma-separated list of application ids'); process.exit(2); }
    if (!why) { console.error('EXP_ABORT: --why is required. An exclusion without a stated reason is indistinguishable from cooking the result.'); process.exit(2); }
    let ok = 0, skip = 0, failed = 0;
    for (const id of ids) {
      const r = byApp.get(id);
      if (!r) { skip++; console.log(`  SKIP ${id} not found`); continue; }
      const edit = markExcluded(r.fit_notes || '', excludeKind, today, why);
      if (!edit.ok) { skip++; console.log(`  SKIP ${id} ${edit.why}`); continue; }
      console.log(`  ${APPLY ? 'EXCL ' : 'PLAN '} ${id.padEnd(9)} ${String(r.stage).padEnd(13)} ${String(r.title || '').slice(0, 28)}`);
      if (!APPLY) continue;
      const res = await fetch(`https://api.notion.com/v1/pages/${r.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${process.env.NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { 'Fit notes': { rich_text: [{ text: { content: edit.text.slice(0, 1900).trim() } }] } } }),
      });
      if (res.ok) ok++; else { failed++; console.log(`    FAIL ${res.status}`); }
    }
    console.log(`EXP_EXCLUDE: ${excludeKind} ${ok} excluded, ${skip} skipped, ${failed} failed${APPLY ? '' : ' (dry run)'}`);
    return;
  }

  // --status (default)
  console.log(`funnel experiments as at ${today}\n`);
  for (const kind of Object.keys(TAGS)) {
    const tagged = rows.filter((r) => cohortOf(r).includes(kind));
    const members = tagged.filter((r) => liveCohortOf(r).includes(kind));
    const dropped = tagged.filter((r) => exclusionOf(r, kind));
    console.log(`${kind.toUpperCase()}  n=${members.length}${dropped.length ? `  (+${dropped.length} excluded, not counted)` : ''}`);
    if (!members.length && !dropped.length) { console.log('  (nobody enrolled yet)\n'); continue; }
    const tally = {};
    for (const r of members) { const c = classify(r); tally[c] = (tally[c] || 0) + 1; }
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    for (const r of members) {
      console.log(`      ${r.application_id.padEnd(9)} ${String(r.stage).padEnd(13)} ${classify(r).padEnd(24)} ${String(r.title || '').slice(0, 26)}`);
    }
    if (dropped.length) {
      console.log('  EXCLUDED (kept on the row, kept out of the result)');
      for (const r of dropped) {
        const e = exclusionOf(r, kind);
        console.log(`      ${r.application_id.padEnd(9)} ${String(r.stage).padEnd(13)} ${e.excluded}  ${e.reason}`);
      }
    }
    console.log('');
  }
  // The comparison that matters. Baseline is every sent row NOT in an experiment.
  // An excluded row never received the intervention, so it is baseline, not cohort.
  const sent = rows.filter((r) => RESPONDED.test(String(r.stage || '')) || r.apply_date);
  const base = sent.filter((r) => !liveCohortOf(r).length);
  const prog = base.filter((r) => PROGRESSED.test(String(r.stage || ''))).length;
  console.log(`BASELINE (sent, not in any experiment)  n=${base.length}  progressed ${prog} (${(100 * prog / Math.max(1, base.length)).toFixed(1)}%)`);
  console.log('  -> the number either experiment has to beat.');
}
