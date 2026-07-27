#!/usr/bin/env node
// Unit tests for metrics-core.mjs — the shared metric definitions.
//
// Two jobs:
//   1. Pin the semantics: what counts as applied / responded / ghosted, the
//      honest local-outcome buckets (bare "applied" is pending_response, NOT
//      positive), calibration verdicts, adherence date math.
//   2. Pin metrics-core to templates/states.yml so the JS alias table and the
//      YAML source of truth cannot drift apart silently.
//
// Run: node scripts/metrics/metrics-core.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import {
  APPLIED_STAGES, PROGRESSED_STAGES, CANONICAL_STATUSES, STATUS_ALIASES,
  isApplied, hasProgressed, isRejected, hasResponded, isGhosted,
  classifyNotionOutcome, normalizeStatus, classifyLocalOutcome,
  rate, avg, funnelHeadline, sliceBy, scoreCalibration, windowAdherence,
} from "./metrics-core.mjs";

let pass = 0, fail = 0;
function check(name, actual, expected) {
  try { assert.deepEqual(actual, expected); console.log(`  ok   ${name}`); pass++; }
  catch { console.error(`  FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); fail++; }
}

// ── Notion classifiers ──────────────────────────────────────────────────────
check("stage 4 is applied", isApplied({ stage: "4. Applied" }), true);
check("Rejected counts as applied (it was an application)", isApplied({ stage: "Rejected" }), true);
check("apply_date alone counts as applied", isApplied({ stage: "3. Drafted", apply_date: "2026-07-01" }), true);
check("stage 3 without apply_date is not applied", isApplied({ stage: "3. Drafted" }), false);
check("stage 5 has progressed", hasProgressed({ stage: "5. Assessment/OA" }), true);
check("stage 4 has not progressed", hasProgressed({ stage: "4. Applied" }), false);
check("response_date means responded", hasResponded({ stage: "4. Applied", response_date: "2026-07-02" }), true);
check("silent stage 4 is ghosted", isGhosted({ stage: "4. Applied" }), true);
check("rejected is not ghosted", isGhosted({ stage: "Rejected" }), false);

check("outcome: pre_apply", classifyNotionOutcome({ stage: "2. Triaged" }), "pre_apply");
check("outcome: progressed", classifyNotionOutcome({ stage: "6. Phone screen" }), "progressed");
check("outcome: rejected", classifyNotionOutcome({ stage: "Rejected" }), "rejected");
check("outcome: responded (reply, no progression)", classifyNotionOutcome({ stage: "4. Applied", response_date: "2026-07-02" }), "responded");
check("outcome: ghosted", classifyNotionOutcome({ stage: "4. Applied" }), "ghosted");

// ── Local status normalization ──────────────────────────────────────────────
check("bold + date stripped", normalizeStatus("**Applied** 2026-05-01 sent"), "applied");
check("Spanish alias", normalizeStatus("Rechazada"), "rejected");
check("skip alias with space", normalizeStatus("no aplicar"), "skip");
check("geo blocker -> skip", normalizeStatus("Geo Blocker"), "skip");
check("unknown passes through lowercased", normalizeStatus("Weird"), "weird");
check("null-safe", normalizeStatus(null), "");

// The fix: a bare submission is not a win.
check("applied -> pending_response (NOT positive)", classifyLocalOutcome("Applied"), "pending_response");
check("responded -> positive", classifyLocalOutcome("Responded"), "positive");
check("interview -> positive", classifyLocalOutcome("entrevista"), "positive");
check("rejected -> negative", classifyLocalOutcome("Rejected"), "negative");
check("discarded -> negative", classifyLocalOutcome("cerrada"), "negative");
check("skip -> self_filtered", classifyLocalOutcome("SKIP"), "self_filtered");
check("evaluated -> pending", classifyLocalOutcome("Evaluated"), "pending");

// ── Math ────────────────────────────────────────────────────────────────────
check("rate rounds to 1dp", rate(1, 3), 33.3);
check("rate null on zero denominator", rate(5, 0), null);
check("avg filters non-numbers", avg([80, null, 90, "x"]), 85);
check("avg null on empty", avg([]), null);

// ── Funnel + slices ─────────────────────────────────────────────────────────
const ROWS = [
  { stage: "2. Triaged", portal: "linkedin", match_score: 88 },              // pre-apply, excluded
  { stage: "4. Applied", portal: "linkedin", match_score: 92 },              // ghosted
  { stage: "4. Applied", portal: "stepstone", match_score: 77, response_date: "2026-07-01" }, // responded
  { stage: "6. Phone screen", portal: "linkedin", match_score: 78 },         // progressed
  { stage: "Rejected", portal: "stepstone", match_score: 90 },               // rejected
];
const H = funnelHeadline(ROWS);
check("funnel: 4 applications", H.applications_submitted, 4);
check("funnel: 3 responses", H.responses, 3);
check("funnel: response rate 75%", H.response_rate_pct, 75);
check("funnel: 1 screen (25%)", [H.reached_first_stage_or_beyond, H.screen_rate_pct], [1, 25]);
check("funnel: 1 ghosted", H.silent_no_response, 1);

const SL = sliceBy(ROWS, "portal", { minCohort: 2 });
check("sliceBy: both portals kept at minCohort 2", SL.map((s) => s.group).sort(), ["linkedin", "stepstone"]);
check("sliceBy: linkedin 2 apps, 1 responded", (() => { const l = SL.find((s) => s.group === "linkedin"); return [l.applications, l.responded]; })(), [2, 1]);
check("sliceBy: minCohort drops small groups", sliceBy(ROWS, "portal", { minCohort: 3 }).length, 0);

// ── Calibration ─────────────────────────────────────────────────────────────
function mk(score, outcome) {
  if (outcome === "ghost") return { stage: "4. Applied", match_score: score };
  if (outcome === "resp") return { stage: "4. Applied", match_score: score, response_date: "2026-07-01" };
  if (outcome === "prog") return { stage: "6. Phone screen", match_score: score };
  return { stage: "Rejected", match_score: score };
}
// Predictive: 75-79 band responds 20%, 90+ band responds 80%.
const PRED = [
  ...Array.from({ length: 4 }, () => mk(77, "ghost")), mk(78, "resp"),
  ...Array.from({ length: 4 }, () => mk(92, "prog")), mk(91, "ghost"),
];
const calP = scoreCalibration(PRED, { minBandSize: 5 });
check("calibration: predictive verdict", calP.verdict, "predictive");
check("calibration: 75-79 band rate 20%", calP.bands.find((b) => b.band === "75-79").response_rate_pct, 20);
check("calibration: 90+ band rate 80%", calP.bands.find((b) => b.band === "90+").response_rate_pct, 80);

// Flat: both bands respond 40%.
const FLAT = [
  ...Array.from({ length: 3 }, () => mk(77, "ghost")), ...Array.from({ length: 2 }, () => mk(78, "resp")),
  ...Array.from({ length: 3 }, () => mk(92, "ghost")), ...Array.from({ length: 2 }, () => mk(91, "resp")),
];
check("calibration: flat verdict", scoreCalibration(FLAT, { minBandSize: 5 }).verdict, "flat");

// Inverted: low band responds 80%, high band 20%.
const INV = [
  ...Array.from({ length: 4 }, () => mk(77, "resp")), mk(78, "ghost"),
  ...Array.from({ length: 4 }, () => mk(92, "ghost")), mk(91, "resp"),
];
check("calibration: inverted verdict", scoreCalibration(INV, { minBandSize: 5 }).verdict, "inverted");

check("calibration: insufficient data below band size", scoreCalibration(ROWS, { minBandSize: 5 }).verdict, "insufficient-data");
check("calibration: unscored rows counted", scoreCalibration([{ stage: "4. Applied" }]).unscored_applications, 1);
check("calibration: avg by outcome", scoreCalibration(ROWS).avg_score_by_outcome, { progressed: 78, rejected: 90, silent: 92 });

// ── Window adherence ────────────────────────────────────────────────────────
// Fixed clock: Monday 2026-07-27 noon UTC. Cutoff = 2026-07-20 noon.
const NOW = new Date("2026-07-27T12:00:00Z");
const WA = windowAdherence([
  { date: "2026-07-21", status: "Applied" },     // Tue — preferred
  { date: "2026-07-22", status: "applied" },     // Wed — preferred
  { date: "2026-07-25", status: "Applied" },     // Sat — avoid
  { date: "2026-07-27", status: "Responded" },   // Mon — acceptable
  { date: "2026-07-20", status: "Applied" },     // midnight Mon < noon cutoff — excluded
  { date: "2026-07-23", status: "Evaluated" },   // not an applied status — excluded
  { date: "not-a-date", status: "Applied" },     // invalid — excluded
], { now: NOW });
check("adherence: 4 rows in window", WA.total_applied_7d, 4);
check("adherence: 2 preferred / 1 acceptable / 1 avoid",
  [WA.preferred_day_count, WA.acceptable_day_count, WA.avoid_day_count], [2, 1, 1]);
check("adherence: 75% on preferred+acceptable", WA.adherence_pct, 75);
check("adherence: statusless rows counted (Notion path)",
  windowAdherence([{ date: "2026-07-21" }], { now: NOW }).total_applied_7d, 1);
check("adherence: empty window shape", windowAdherence([], { now: NOW }).adherence_pct, null);

// ── states.yml drift guard ──────────────────────────────────────────────────
// metrics-core.test.mjs lives at scripts/metrics/, states.yml at templates/.
const STATES = yaml.load(readFileSync(new URL("../../templates/states.yml", import.meta.url), "utf8"));
for (const st of STATES.states) {
  check(`states.yml id "${st.id}" is canonical`, CANONICAL_STATUSES.includes(st.id), true);
  check(`states.yml label "${st.label}" normalizes to ${st.id}`, normalizeStatus(st.label), st.id);
  for (const al of st.aliases || []) {
    check(`states.yml alias "${al}" -> ${st.id}`, normalizeStatus(al), st.id);
  }
}
// And the reverse: every JS alias must target a canonical status.
for (const [al, target] of Object.entries(STATUS_ALIASES)) {
  check(`JS alias "${al}" targets canonical status`, CANONICAL_STATUSES.includes(target), true);
}

// Applied-stage lists are strict subsets of the stage taxonomy in order.
check("PROGRESSED subset APPLIED (Signed allowed)", PROGRESSED_STAGES.every((s) => APPLIED_STAGES.includes(s) || s === "Signed"), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
