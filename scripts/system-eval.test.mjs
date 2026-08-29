#!/usr/bin/env node
/**
 * Pins log selection for system-eval.mjs (logic lives in routine-logs-core.mjs,
 * because importing system-eval.mjs runs the whole collector).
 *
 * WHY THIS FILE EXISTS. The watchdog picks "the routine's latest log" and
 * reads its health from it. If that selection is by plain `.sort()` on the
 * filename, it goes wrong in two silent ways:
 *   1. Sidecars outsort the real log ("auto-draft-manual-*.log.err" >
 *      "auto-draft-2026-*.log" because "m" > "2"), so the watchdog reads a
 *      stale stderr file for weeks.
 *   2. Two date formats coexist ("2026-08-27_2130" vs "20260802-1237") and
 *      "-" < "0", so every compact-format name sorts after every hyphenated
 *      one regardless of date.
 * A routine that always alerts cannot signal anything: a genuine failure
 * would add no new line to a log already carrying that one every 12 hours.
 * Same lesson as picking cover-letter files by the date IN the filename
 * rather than by sort order. A filename is not a chronology.
 */
import { pickLatestLog, nullDevice, redactSecrets } from './routine-logs-core.mjs';

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`  FAIL ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};

// mtime lookup: later in the array = newer. Keeps the fixtures readable.
const clock = (order) => (f) => {
  const i = order.indexOf(f);
  return i === -1 ? 0 : 1_000_000 + i;
};

// ---- cause 1: a sidecar outsorting the real log -----------------------------
{
  const files = ['auto-draft-2026-08-27_2325.log', 'auto-draft-manual-2026-06-20_0917.log.err'];
  const order = ['auto-draft-manual-2026-06-20_0917.log.err', 'auto-draft-2026-08-27_2325.log'];
  check('the real log wins over a .err sidecar',
    pickLatestLog(files, clock(order), 'auto-draft-'), 'auto-draft-2026-08-27_2325.log');
  check('lexicographic order would have picked the sidecar (guard is meaningful)',
    [...files].sort().pop(), 'auto-draft-manual-2026-06-20_0917.log.err');
}

// A heartbeat file is a sidecar too, and it is NEWER than the run it belongs
// to, so mtime alone would not save us — it has to be excluded by name.
{
  const files = ['auto-draft-2026-08-27_2325.log', 'auto-draft-2026-08-27_2325.heartbeat.log'];
  const order = ['auto-draft-2026-08-27_2325.log', 'auto-draft-2026-08-27_2325.heartbeat.log'];
  check('a NEWER heartbeat sidecar is still excluded',
    pickLatestLog(files, clock(order), 'auto-draft-'), 'auto-draft-2026-08-27_2325.log');
}

// ---- cause 2: two date formats, and "-" sorts before "0" --------------------
{
  const files = ['drain-auto-draft-2026-08-27_2130.log', 'drain-auto-draft-20260802-1237-round3b.log'];
  const order = ['drain-auto-draft-20260802-1237-round3b.log', 'drain-auto-draft-2026-08-27_2130.log'];
  check('mtime beats a compact-format name that sorts later',
    pickLatestLog(files, clock(order), 'drain-auto-draft-'), 'drain-auto-draft-2026-08-27_2130.log');
  check('lexicographic order would have picked the earlier round',
    [...files].sort().pop(), 'drain-auto-draft-20260802-1237-round3b.log');
}

// ---- prefix discipline ------------------------------------------------------
// `drain-auto-draft-*` must NOT be collected as `auto-draft-*`: the drain log
// is the wrapper's, and reading it as the routine's own would mix two contracts.
{
  const files = ['auto-draft-2026-08-27_2325.log', 'drain-auto-draft-2026-08-27_2130.log'];
  const order = ['auto-draft-2026-08-27_2325.log', 'drain-auto-draft-2026-08-27_2130.log'];
  check('a drain log is not the routine log even when newer',
    pickLatestLog(files, clock(order), 'auto-draft-'), 'auto-draft-2026-08-27_2325.log');
  check('and the drain prefix selects only drain logs',
    pickLatestLog(files, clock(order), 'drain-auto-draft-'), 'drain-auto-draft-2026-08-27_2130.log');
}

// A prefix must not match a longer routine name that starts with it.
{
  const files = ['referral-scout-2026-08-27_2145.log', 'bd-referral-scout-2026-08-24_1330.log'];
  const order = ['referral-scout-2026-08-27_2145.log', 'bd-referral-scout-2026-08-24_1330.log'];
  check('bd-referral-scout does not leak into referral-scout',
    pickLatestLog(files, clock(order), 'referral-scout-'), 'referral-scout-2026-08-27_2145.log');
}

// ---- degenerate input -------------------------------------------------------
check('no matching files yields null', pickLatestLog(['other-2026-01-01.log'], clock([]), 'auto-draft-'), null);
check('an empty list yields null', pickLatestLog([], clock([]), 'auto-draft-'), null);
check('only sidecars yields null',
  pickLatestLog(['auto-draft-x.log.err', 'auto-draft-y.heartbeat.log'], clock([]), 'auto-draft-'), null);
check('a single log is returned', pickLatestLog(['auto-draft-a.log'], clock([]), 'auto-draft-'), 'auto-draft-a.log');

// --- nullDevice + redactSecrets (added 2026-08-29) --------------------------
{
  const eq = (label, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
    else { fail++; console.log(`  FAIL ${label}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
  };

  eq('windows gets NUL', nullDevice('win32'), 'NUL');
  eq('linux gets /dev/null', nullDevice('linux'), '/dev/null');
  eq('darwin gets /dev/null', nullDevice('darwin'), '/dev/null');

  eq('a bearer token is redacted',
    redactSecrets('curl -H "Authorization: Bearer ntn_abc123XYZ" https://api.notion.com'),
    'curl -H "Authorization: Bearer [REDACTED]" https://api.notion.com');
  eq('a bare notion token is redacted', redactSecrets('token=ntn_abc123'), 'token=ntn_[REDACTED]');
  eq('a bright data token is redacted', redactSecrets('brd_9f8e7d'), 'brd_[REDACTED]');
  eq('the surrounding message survives', redactSecrets('Command failed: curl -sS'), 'Command failed: curl -sS');
  eq('empty input is safe', redactSecrets(null), '');
  // The real failure string this was written for.
  eq('the actual watchdog error is scrubbed',
    redactSecrets('Command failed: curl -H "Authorization: Bearer ntn_examplevRdEm" x').includes('ntn_examplevRdEm'),
    false);
}

if (fail) { console.error(`\nsystem-eval log selection: ${fail} failure(s)`); process.exit(1); }
console.log(`system-eval log selection: ${pass} passed, 0 failed`);
