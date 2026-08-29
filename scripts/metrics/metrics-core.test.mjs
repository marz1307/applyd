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
  isReferred, referralComparison,
  classifyNotionOutcome, normalizeStatus, classifyLocalOutcome,
  rate, avg, funnelHeadline, sliceBy, scoreCalibration, windowAdherence,
  stageEdgeCalibration, parseBlockScores, dimensionCalibration,
  advertIdFingerprint,
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

// ── Stage-edge calibration ──────────────────────────────────────────────────
// Synthetic cohort: low band (score 76) responds 1/5, high band (score 92)
// responds 5/5 and progresses 3/5 — applied->responded must read predictive.
const EDGE_ROWS = [
  ...Array.from({ length: 4 }, () => ({ stage: "4. Applied", match_score: 76 })),
  { stage: "4. Applied", match_score: 76, response_date: "2026-07-01" },
  ...Array.from({ length: 2 }, () => ({ stage: "4. Applied", match_score: 92, response_date: "2026-07-01" })),
  ...Array.from({ length: 3 }, () => ({ stage: "5. Assessment/OA", match_score: 92 })),
];
const EC = stageEdgeCalibration(EDGE_ROWS, { minBandSize: 5 });
const eResp = EC.edges.find((e) => e.edge === "applied_to_responded");
check("edge: applied->responded predictive on synthetic spread", eResp.verdict, "predictive");
check("edge: 75-79 band converts 20%", eResp.bands.find((b) => b.band === "75-79").conversion_pct, 20);
check("edge: 90+ band converts 100%", eResp.bands.find((b) => b.band === "90+").conversion_pct, 100);
const eProg = EC.edges.find((e) => e.edge === "responded_to_progressed");
check("edge: responded->progressed denominator is responders only", eProg.entering_total, 6);
check("edge: deep edges marked best-effort",
  EC.edges.filter((e) => e.best_effort).map((e) => e.edge),
  ["progressed_to_interview", "interview_to_offer"]);
check("edge: unscored rows excluded", stageEdgeCalibration([{ stage: "4. Applied" }]).scored_rows, 0);

// ── Block-score parsing + dimension calibration ─────────────────────────────
check("blocks: sentinel parses", parseBlockScores("prose [blocks A=4.2 B=3.8 G=5] more"),
  { A: 4.2, B: 3.8, G: 5 });
check("blocks: case-insensitive tag, absent -> null", parseBlockScores("no sentinel here"), null);
check("blocks: garbage pairs dropped", parseBlockScores("[blocks A=4.0 Z=9 B=x]"), { A: 4 });
// A discriminates (high-A rows respond), B does not.
const DIM_ROWS = [
  ...Array.from({ length: 6 }, () => ({ stage: "4. Applied", block_scores: { A: 5, B: 3 }, response_date: "2026-07-01" })),
  ...Array.from({ length: 6 }, () => ({ stage: "4. Applied", block_scores: { A: 2, B: 3 } })),
];
const DC = dimensionCalibration(DIM_ROWS, { minPerSide: 5 });
check("dim: A carries signal", DC.dimensions.find((d) => d.block === "A").verdict, "signal");
check("dim: C has no data", DC.dimensions.find((d) => d.block === "C").verdict, "no-data");
check("dim: rows without blocks counted",
  dimensionCalibration([{ stage: "4. Applied" }]).rows_without_blocks, 1);

// ── Advert-identity fingerprint ─────────────────────────────────────────────
// Every case here is a real URL from the tracker, not a constructed one.

const aid = advertIdFingerprint;

// The duplicate that motivated the whole thing: one eFC advert, two slugs.
check("advert: eFC id extracted",
  aid("https://www.efinancialcareers.de/jobs-Germany-Mitte-Data_Platform_Engineer.id24578904"), "efc:24578904");
check("advert: the same eFC advert under a different slug collapses",
  aid("https://www.efinancialcareers.de/jobs-Germany-Mitte-Data_Engineer.id24578904"), "efc:24578904");
check("advert: eFC .de and .co.uk are one portal",
  aid("https://www.efinancialcareers.co.uk/jobs-UK-London-X.id24647605"),
  aid("https://www.efinancialcareers.de/jobs-UK-London-X.id24647605"));

// Locale variants of one advert must collapse, on the portal rules and on the
// generic host fallback alike.
check("advert: LinkedIn country subdomains collapse",
  aid("https://uk.linkedin.com/jobs/view/data-analyst-at-x-4451241178"), "linkedin:4451241178");
check("advert: Siemens en_US and de_DE are one job",
  aid("https://jobs.siemens.com/en_US/externaljobs/JobDetail/518024"),
  aid("https://jobs.siemens.com/de_DE/externaljobs/JobDetail/518024"));
check("advert: a query string does not change identity",
  aid("https://jobs.booking.com/booking/jobs/29399?lang=en-us"), "jobs.booking.com:29399");

// A Greenhouse-backed careers page carries the authoritative board id in the
// query string; its own path id is incidental.
check("advert: gh_jid wins over the host path",
  aid("https://traderepublic.com/en-de/about?jobId=7623520003&gh_jid=7623520003"), "greenhouse:7623520003");

// Namespacing is not decorative — this collision is live in the tracker.
check("advert: same number on two hosts does not collide",
  aid("https://jobs.comparethemarketcareers.com/en/job/100234") ===
  aid("https://ebet.fa.em3.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/100234"),
  false);

// Caught in validation, 2026-08-16: three unrelated London jobs (Funding
// Circle, Ekimetrics, Ogury) all ended "_london" and merged into one cluster.
// A WTTJ slug without a hash must yield NO id rather than the city name.
check("advert: WTTJ hash extracted",
  aid("https://www.welcometothejungle.com/en/companies/iwoca/jobs/data-scientist_london_w7ojw2nw"), "wttj:w7ojw2nw");
check("advert: WTTJ slug with no hash yields nothing, not the city",
  aid("https://www.welcometothejungle.com/en/companies/funding-circle/jobs/data-analyst_london"), "");
// Both must yield NO id. An empty key is skipped by the clusterer, so two
// hashless London jobs can never be joined; asserting they "differ" would be
// meaningless, since "" === "" is trivially true.
check("advert: hashless WTTJ jobs produce no key at all, so cannot cluster",
  [aid("https://www.welcometothejungle.com/en/companies/ogury/jobs/data-engineer_london"),
   aid("https://www.welcometothejungle.com/en/companies/ekimetrics/jobs/junior-data-scientist_london")],
  ["", ""]);

// Absence of a key must be safe: no id means no dedup, never a wrong guess.
check("advert: unparseable URL yields nothing", aid("not a url"), "");
check("advert: empty input yields nothing", aid(""), "");
check("advert: slug-only board yields nothing",
  aid("https://www.brightnetwork.co.uk/graduate-jobs/friend-mts/junior-data-scientist-birmingham-2026-ai6p"), "");

// --- referral semantics (added 2026-08-29) ---------------------------------
check("the exact option counts as referred", isReferred({ referral: "Referred!" }), true);
check("whitespace around the option is tolerated", isReferred({ referral: " Referred! " }), true);
// A blank is "no referral", NOT "unknown". Treating it as unknown would shrink
// the cold baseline and flatter the referral rate against it.
check("blank is cold, not unknown", isReferred({ referral: "" }), false);
check("the No option is cold", isReferred({ referral: "No" }), false);
check("a missing property is cold", isReferred({}), false);
check("a null row is cold", isReferred(null), false);
check("near-misses do not count", isReferred({ referral: "Referred" }), false);

{
  const rows = [
    { stage: "9. Offer",   apply_date: "2026-08-01", referral: "Referred!" },
    { stage: "4. Applied", apply_date: "2026-08-02", referral: "Referred!" },
    { stage: "Rejected",   apply_date: "2026-08-03", referral: "No" },
    { stage: "4. Applied", apply_date: "2026-08-04" },
    { stage: "3. Drafted" },                                  // unsent: excluded
  ];
  const c = referralComparison(rows);
  check("referred cohort counted", c.referred.n, 2);
  check("cold cohort counted", c.cold.n, 2);
  check("unsent rows are excluded from both", c.referred.n + c.cold.n, 4);
  check("referred progression counted", c.referred.progressed, 1);
  check("a rejection is a response, not a progression", c.cold.responded, 1);
  check("cold progression counted", c.cold.progressed, 0);
  check("referrals present is flagged", c.any_referrals, true);
}
{
  // The state the system may sit in for a while: no referral confirmed yet.
  const c = referralComparison([{ stage: "4. Applied", apply_date: "2026-08-01" }]);
  check("no referrals means no rate, not 0%", c.referred.response_pct, null);
  check("and it says so explicitly", c.any_referrals, false);
  check("the cold side still reports", c.cold.n, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
