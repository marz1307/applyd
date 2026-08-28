/**
 * routine-logs-core.mjs — choosing which log represents a routine's last run.
 *
 * Extracted from system-eval.mjs so it can be tested. Importing system-eval.mjs
 * RUNS the whole collector (its main body is unguarded top-level code, and in
 * deep mode it makes network calls), so a test cannot import from it.
 *
 * WHY THIS IS ITS OWN THING. The watchdog reads a routine's health from "its
 * latest log", and getting that wrong is silent and self-concealing: it does not
 * look like a missing check, it looks like a finding. From 2026-07-06 to
 * 2026-08-28 auto-draft reported EMPTY_LOG on all 91 watchdog runs because the
 * selection was `.sort()` on the filename and two things beat it:
 *
 *   1. Sidecars sort in. `auto-draft-manual-2026-06-20_0917.log.err` beats
 *      `auto-draft-2026-08-27_2325.log` because "m" > "2". Health was being read
 *      off a stderr file from 20 June.
 *   2. Two date formats coexist — `2026-08-27_2130` and `20260802-1237` — and
 *      "-" (0x2D) sorts before "0" (0x30), so every compact name sorts after
 *      every hyphenated one no matter which is newer.
 *
 * auto-draft's real status that whole time was SESSION_LIMIT on its last run,
 * and nobody could see it. A routine that always alerts cannot signal anything:
 * a genuine failure adds no new line to a log already carrying that one twice a
 * day. Prefer an unmonitored routine to a permanently-alerting one.
 *
 * A filename is not a chronology. Same lesson as picking cover-letter files by
 * the date IN the name rather than by sort order.
 */

/**
 * Newest log for `prefix`, by mtime, ignoring sidecars.
 *
 * `mtimeOf(filename) -> number` is injected so this stays pure and the test
 * needs no filesystem. Returns null when nothing matches — callers must treat
 * that as "no run to assess", never as a fault.
 */
export function pickLatestLog(files, mtimeOf, prefix) {
  const candidates = (files || [])
    .filter((f) => f.startsWith(prefix))
    // `.err` is a stderr sidecar and `.heartbeat.log` is written DURING a run,
    // so it is newer than the run's own log — mtime alone would not exclude it.
    .filter((f) => f.endsWith('.log') && !f.endsWith('.heartbeat.log'));
  if (!candidates.length) return null;
  return candidates.reduce((best, f) => ((mtimeOf(f) || 0) > (mtimeOf(best) || 0) ? f : best));
}
