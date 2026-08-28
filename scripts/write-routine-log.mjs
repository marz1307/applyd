#!/usr/bin/env node
/**
 * write-routine-log.mjs — persist a routine's ROUTINE_CONTRACT to data/routine-logs/
 *
 * WHY THIS EXISTS
 * ---------------
 * The wrapper-driven routines get their logs for free: `run-routine.ps1`
 * redirects stdout to `data/routine-logs/{routine}-{DATE}_{HHMM}.log`. The
 * Claude Code scheduled tasks (chrome-scan-visible, careerops-watchdog) have no
 * wrapper, so their contract only ever existed in a session transcript nobody
 * greps.
 *
 * That gap forced careerops-watchdog to infer portal health from Notion row
 * counts — the one source that decays, because auto-eval trashes below-floor
 * rows and archived rows are invisible to the Notion API. Measured 2026-08-13:
 * the 08-11 scan read LinkedIn 24 / Xing 10 / eFC 3 at 20:00 and 0 rows two
 * hours later. That eroding baseline manufactured a false eFC alarm.
 *
 * Asking the model to hand-write the file works until the run is long and the
 * step gets dropped — and a missing log looks exactly like a routine that never
 * fired. So the write lives here, where it either succeeds or fails loudly.
 *
 * VALIDATION IS THE POINT. A log the watchdog cannot parse is worth little more
 * than no log, so this refuses to write a malformed contract rather than
 * persisting something that reads fine to a human and breaks the reader.
 *
 * Usage (contract on stdin):
 *   node write-routine-log.mjs --routine chrome-scan-visible < contract.txt
 *   printf '%s' "$CONTRACT" | node write-routine-log.mjs --routine chrome-scan-visible
 *
 * Flags:
 *   --routine <name>   required; becomes the filename prefix
 *   --at <ISO>         override the timestamp (testing; default = now, local)
 *   --dir <path>       override output dir (default data/routine-logs)
 *   --self-test        run the invariants and exit
 *
 * Exit codes: 0 written · 1 validation failed (nothing written) · 2 bad usage
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const OPEN = "--- ROUTINE_CONTRACT ---";
const CLOSE = "--- END_ROUTINE_CONTRACT ---";

// PORTAL_STATUS: linkedin:ok(141),xing:ok(142),efc_uk:down(0),efc_de:down(0)
const PORTAL_STATES = ["ok", "down", "permission_denied", "signin_timeout", "skipped"];
const PORTAL_ENTRY = /^([a-z0-9_]+):([a-z_]+)\((\d+)\)$/;

/** Routines that MUST carry particular lines. Keyed by routine name. */
const REQUIRED_LINES = {
  "chrome-scan-visible": ["PORTAL_STATUS"],
};

export function validate(routine, text) {
  const errs = [];
  if (!text || !text.trim()) { errs.push("contract is empty"); return errs; }

  if (!text.includes(OPEN)) errs.push(`missing opening fence "${OPEN}"`);
  if (!text.includes(CLOSE)) errs.push(`missing closing fence "${CLOSE}"`);

  const lines = text.split("\n").map((l) => l.trim());
  const field = (name) => lines.find((l) => l.startsWith(name + ":"));

  if (!field("ROUTINE")) errs.push("missing ROUTINE: line");
  if (!field("TIMESTAMP_UTC")) errs.push("missing TIMESTAMP_UTC: line");

  for (const req of REQUIRED_LINES[routine] || []) {
    if (!field(req)) errs.push(`missing ${req}: line (required for ${routine})`);
  }

  // PORTAL_STATUS must parse, or the watchdog silently reads nothing.
  const ps = field("PORTAL_STATUS");
  if (ps) {
    const body = ps.slice("PORTAL_STATUS:".length).split("#")[0].trim();
    if (!body) errs.push("PORTAL_STATUS is present but empty");
    else {
      for (const entry of body.split(",").map((s) => s.trim()).filter(Boolean)) {
        const m = entry.match(PORTAL_ENTRY);
        if (!m) { errs.push(`PORTAL_STATUS entry "${entry}" is not key:state(count)`); continue; }
        if (!PORTAL_STATES.includes(m[2]))
          errs.push(`PORTAL_STATUS entry "${entry}" has unknown state "${m[2]}" (expected ${PORTAL_STATES.join("|")})`);
      }
    }
  }
  return errs;
}

/** Local-time stamp — matches run-routine.ps1's naming, which is local. */
export function logName(routine, at = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${routine}-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
         `_${p(at.getHours())}${p(at.getMinutes())}.log`;
}

if (args.includes("--self-test")) {
  const ok = `${OPEN}\nROUTINE: chrome-scan-visible\nTIMESTAMP_UTC: 2026-08-13T19:23:24Z\n` +
             `PORTAL_STATUS: linkedin:ok(141),xing:ok(142),efc_uk:down(0),efc_de:down(0)\n${CLOSE}`;
  const cases = [
    ["valid contract", "chrome-scan-visible", ok, 0],
    ["missing PORTAL_STATUS", "chrome-scan-visible", ok.replace(/PORTAL_STATUS:.*\n/, ""), 1],
    ["PORTAL_STATUS not required elsewhere", "careerops-watchdog", ok.replace(/PORTAL_STATUS:.*\n/, ""), 0],
    ["bad state", "chrome-scan-visible", ok.replace("down(0)", "broken(0)"), 1],
    ["malformed entry", "chrome-scan-visible", ok.replace("xing:ok(142)", "xing-ok-142"), 1],
    ["missing fence", "chrome-scan-visible", ok.replace(CLOSE, ""), 1],
    ["empty", "chrome-scan-visible", "   ", 1],
  ];
  let failed = 0;
  for (const [label, routine, text, wantErrs] of cases) {
    const got = validate(routine, text).length;
    const pass = wantErrs === 0 ? got === 0 : got > 0;
    if (!pass) { failed++; console.error(`FAIL ${label}: expected ${wantErrs ? "errors" : "clean"}, got ${got}`); }
    else console.log(`ok   ${label}`);
  }
  const n = logName("chrome-scan-visible", new Date(2026, 7, 13, 9, 4));
  if (n !== "chrome-scan-visible-2026-08-13_0904.log") { failed++; console.error(`FAIL logName: got ${n}`); }
  else console.log("ok   logName pads date and time");
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}

const routine = arg("--routine");
if (!routine) { console.error("usage: write-routine-log.mjs --routine <name> [--at ISO] [--dir path] < contract"); process.exit(2); }

const text = readFileSync(0, "utf8");
const errs = validate(routine, text);
if (errs.length) {
  console.error(`write-routine-log: REFUSING TO WRITE — contract failed validation:`);
  for (const e of errs) console.error(`  - ${e}`);
  console.error(`\nNothing was written. Fix the contract and re-run; a log the watchdog\ncannot parse is barely better than no log at all.`);
  process.exit(1);
}

const dir = arg("--dir") || join("data", "routine-logs");
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const at = arg("--at") ? new Date(arg("--at")) : new Date();
const path = join(dir, logName(routine, at));
writeFileSync(path, text.endsWith("\n") ? text : text + "\n", "utf8");
console.error(`write-routine-log: wrote ${path} (${text.split("\n").length} lines)`);
console.log(path);
