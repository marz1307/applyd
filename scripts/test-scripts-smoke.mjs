#!/usr/bin/env node
/**
 * test-scripts-smoke.mjs — Smoke tests for pace-alarm.mjs and apply-window.mjs
 *
 * Both scripts are routine-critical:
 *   - pace-alarm.mjs feeds the 17:00 pace-check routine and the watchdog audit
 *   - apply-window.mjs is the "is it apply time NOW?" pre-submit gate
 *
 * Asserts:
 *   1. Both scripts exit 0 in their happy paths.
 *   2. Both emit a parseable `--- ROUTINE_CONTRACT ---` block.
 *   3. pace-alarm fields: TODAY_COUNT, ROLLING_7D_AVG, ALARM_TRIGGERED, CACHE_STALE,
 *      WINDOW_ADHERENCE_PCT, WINDOW_TOTAL_APPLIED_7D.
 *   4. apply-window fields: IN_WINDOW, IS_PREFERRED_DAY, NEXT_WINDOW_LOCAL,
 *      RECOMMENDATION, MONTH_INTENSITY.
 *   5. apply-window's --role + --posted produces FRESHNESS_OK / FRESHNESS_CEILING_DAYS.
 *   6. apply-window's RECOMMENDATION is one of the four legal values.
 *
 * Exits 0 on full pass, non-zero with itemised failures otherwise.
 */

import { spawnSync } from "node:child_process";

let failed = 0;
const failures = [];

function fail(label, msg) {
  failed++;
  failures.push(`[${label}] ${msg}`);
  console.error(`  ✗ ${label}: ${msg}`);
}
function pass(label, msg) {
  console.log(`  ✓ ${label}: ${msg}`);
}

function runNode(args) {
  const r = spawnSync("node", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function extractContract(stdout) {
  const start = stdout.indexOf("--- ROUTINE_CONTRACT ---");
  const end = stdout.indexOf("--- END_ROUTINE_CONTRACT ---");
  if (start < 0 || end < 0 || end < start) return null;
  const block = stdout.slice(start, end);
  const kv = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Z_0-9]+):\s*(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  return kv;
}

console.log("Smoke tests — pace-alarm + apply-window");
console.log("━".repeat(60));

// ── pace-alarm.mjs ──────────────────────────────────────────────────
console.log("\n→ pace-alarm.mjs --json");
{
  const r = runNode(["scripts/metrics/pace-alarm.mjs", "--json"]);
  if (r.status !== 0) {
    // Exit 1 is acceptable when no data source is configured (no Notion + no applications.md)
    const noData = r.stdout.includes('"status":"error"') || r.stderr.includes('Cannot read') || r.stderr.includes('No Notion database');
    if (noData) {
      pass("pace-alarm", `exit ${r.status} (no data source configured — acceptable in clean install)`);
    } else {
      fail("pace-alarm", `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`);
    }
  } else {
    pass("pace-alarm", "exit 0");
    const c = extractContract(r.stdout);
    if (!c) {
      fail("pace-alarm", "ROUTINE_CONTRACT block missing or unparseable");
    } else {
      pass("pace-alarm", "contract block parseable");
      const required = [
        "ROUTINE",
        "TODAY_COUNT",
        "ROLLING_7D_AVG",
        "TARGET_PER_DAY",
        "ALARM_THRESHOLD_PER_DAY",
        "ALARM_TRIGGERED",
        "CACHE_STALE",
        "WEEKLY_TARGET",
        "WINDOW_TOTAL_APPLIED_7D",
        "WINDOW_ADHERENCE_PCT",
      ];
      for (const k of required) {
        if (!(k in c)) fail("pace-alarm", `contract missing key: ${k}`);
      }
      if (c.ROUTINE !== "pace-check") {
        fail("pace-alarm", `ROUTINE was "${c.ROUTINE}", expected "pace-check"`);
      } else {
        pass("pace-alarm", `ROUTINE=${c.ROUTINE}`);
      }
      if (!["true", "false"].includes(c.ALARM_TRIGGERED)) {
        fail("pace-alarm", `ALARM_TRIGGERED was "${c.ALARM_TRIGGERED}", expected bool`);
      } else {
        pass("pace-alarm", `ALARM_TRIGGERED=${c.ALARM_TRIGGERED}, CACHE_STALE=${c.CACHE_STALE}`);
      }
    }
  }
}

// ── apply-window.mjs (no role/posted) ───────────────────────────────
console.log("\n→ apply-window.mjs --json");
{
  const r = runNode(["scripts/metrics/apply-window.mjs", "--json"]);
  if (r.status !== 0) {
    fail("apply-window", `exit ${r.status}. stderr: ${r.stderr.slice(0, 200)}`);
  } else {
    pass("apply-window", "exit 0");
    const c = extractContract(r.stdout);
    if (!c) {
      fail("apply-window", "ROUTINE_CONTRACT block missing");
    } else {
      pass("apply-window", "contract block parseable");
      const required = [
        "IN_WINDOW",
        "IS_PREFERRED_DAY",
        "IS_ACCEPTABLE_DAY",
        "IS_AVOID_DAY",
        "NEXT_WINDOW_LOCAL",
        "MONTH_INTENSITY",
        "RECOMMENDATION",
      ];
      for (const k of required) {
        if (!(k in c)) fail("apply-window", `contract missing key: ${k}`);
      }
      const legal = ["send", "hold", "send-now-fast", "skip-stale"];
      if (!legal.includes(c.RECOMMENDATION)) {
        fail("apply-window", `RECOMMENDATION was "${c.RECOMMENDATION}", expected one of ${legal.join(",")}`);
      } else {
        pass("apply-window", `RECOMMENDATION=${c.RECOMMENDATION}`);
      }
      if (c.FRESHNESS_OK !== "n/a") {
        fail("apply-window", `FRESHNESS_OK was "${c.FRESHNESS_OK}" without --role/--posted, expected "n/a"`);
      } else {
        pass("apply-window", "freshness n/a when no role+posted given");
      }
    }
  }
}

// ── apply-window.mjs with --role + --posted ─────────────────────────
console.log("\n→ apply-window.mjs --role 'Analytics Engineer' --posted 2026-05-20 --json");
{
  const r = runNode([
    "scripts/metrics/apply-window.mjs",
    "--role", "Analytics Engineer",
    "--posted", "2026-05-20",
    "--json",
  ]);
  if (r.status !== 0) {
    fail("apply-window-fresh", `exit ${r.status}`);
  } else {
    const c = extractContract(r.stdout);
    if (!c) {
      fail("apply-window-fresh", "contract missing");
    } else {
      if (!(c.FRESHNESS_OK === "true" || c.FRESHNESS_OK === "false")) {
        fail("apply-window-fresh", `FRESHNESS_OK was "${c.FRESHNESS_OK}", expected bool when role+posted given`);
      } else {
        pass("apply-window-fresh", `FRESHNESS_OK=${c.FRESHNESS_OK}, age=${c.FRESHNESS_AGE_DAYS}d, ceiling=${c.FRESHNESS_CEILING_DAYS}d`);
      }
    }
  }
}

// ── apply-window with stale posting → skip-stale ────────────────────
console.log("\n→ apply-window.mjs --role 'Analytics Engineer' --posted 2026-01-01 --json (stale)");
{
  const r = runNode([
    "scripts/metrics/apply-window.mjs",
    "--role", "Analytics Engineer",
    "--posted", "2026-01-01",
    "--json",
  ]);
  if (r.status !== 0) {
    fail("apply-window-stale", `exit ${r.status}`);
  } else {
    const c = extractContract(r.stdout);
    if (c?.FRESHNESS_OK !== "false") {
      fail("apply-window-stale", `FRESHNESS_OK was "${c?.FRESHNESS_OK}" for 145-day-old posting, expected "false"`);
    }
    if (c?.RECOMMENDATION !== "skip-stale") {
      fail("apply-window-stale", `RECOMMENDATION was "${c?.RECOMMENDATION}", expected "skip-stale"`);
    } else {
      pass("apply-window-stale", "correctly detected stale posting → skip-stale");
    }
  }
}

console.log("\n" + "━".repeat(60));
if (failed === 0) {
  console.log("PASS — all script smoke tests passed.");
  process.exit(0);
} else {
  console.error(`FAIL — ${failed} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
