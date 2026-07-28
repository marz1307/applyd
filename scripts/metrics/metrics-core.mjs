#!/usr/bin/env node
/**
 * metrics-core.mjs — Shared metric definitions for applyd (the semantic layer).
 *
 * One place answers "what counts as applied / responded / screened / ghosted",
 * so funnel-metrics, pace-alarm, analyze-patterns, verify-pipeline,
 * followup-cadence and build-dashboard all compute the SAME numbers. Before
 * this module existed each script carried its own copy of the stage taxonomy
 * and status-alias table, and two of them disagreed on the definition of a
 * positive outcome (analyze-patterns counted a bare "applied" as positive,
 * inflating conversion rates with mere submissions).
 *
 * Design rules:
 *   - Pure functions, zero imports, no I/O — safe to load from any script or
 *     test without side effects. templates/states.yml stays the human-readable
 *     doc; metrics-core.test.mjs asserts the two never drift.
 *   - Two data shapes are covered, matching the two data sources:
 *       Notion rows   {stage, apply_date, response_date, match_score}
 *       local rows    {status, date}   (data/applications.md tracker lines)
 *
 * The calibration section (scoreCalibration) is the self-improvement hook:
 * response/screen rate per Match-score band tells you whether the score is
 * actually predicting outcomes, and therefore whether triage.score_floor and
 * the archetype weights deserve to move. Observed in early field use:
 * rejected rows averaged a HIGHER Match score than the pipeline — the score
 * was not discriminating. This module makes that check a standing metric
 * instead of a one-off finding.
 */

// ── Notion stage taxonomy ───────────────────────────────────────────────────
// Mirrors the Notion Stage select. Order = pipeline order.
export const NOTION_STAGES = [
  "1. Discovered", "2. Triaged", "3. Drafted", "4. Applied",
  "5. Assessment/OA", "6. Phone screen", "7. Tech interview",
  "8. Onsite/Final", "9. Offer", "Signed",
  "Rejected", "Withdrew", "Not pursuing",
];

// A row counts as a submitted application once it reaches Stage 4 — including
// rows later rejected (they were applications too).
export const APPLIED_STAGES = [
  "4. Applied", "5. Assessment/OA", "6. Phone screen",
  "7. Tech interview", "8. Onsite/Final", "9. Offer", "Signed", "Rejected",
];

// "Got past the first stage" — an assessment or a live human conversation.
export const PROGRESSED_STAGES = [
  "5. Assessment/OA", "6. Phone screen", "7. Tech interview",
  "8. Onsite/Final", "9. Offer", "Signed",
];

export const TERMINAL_STAGES = ["Signed", "Rejected", "Withdrew", "Not pursuing"];

// ── Notion row classifiers ──────────────────────────────────────────────────
// Row shape: {stage, apply_date, response_date, match_score}
export const isApplied = (r) => APPLIED_STAGES.includes(r.stage) || !!r.apply_date;
export const hasProgressed = (r) => PROGRESSED_STAGES.includes(r.stage);
export const isRejected = (r) => r.stage === "Rejected";
// A response = the company did something: progressed us, rejected us, or a
// response date is logged. Silence (still "4. Applied", no response date) = ghosted.
export const hasResponded = (r) => hasProgressed(r) || isRejected(r) || !!r.response_date;
export const isGhosted = (r) => isApplied(r) && !hasResponded(r);

/**
 * Canonical outcome buckets for a Notion row:
 *   pre_apply  — never reached Stage 4 (not part of the applied cohort)
 *   progressed — reached Stage 5+ (assessment or human conversation)
 *   rejected   — explicit rejection
 *   responded  — company replied but no progression yet (response_date only)
 *   ghosted    — applied, silence
 */
export function classifyNotionOutcome(r) {
  if (!isApplied(r)) return "pre_apply";
  if (hasProgressed(r)) return "progressed";
  if (isRejected(r)) return "rejected";
  if (r.response_date) return "responded";
  return "ghosted";
}

// ── Local tracker taxonomy (data/applications.md) ───────────────────────────
// Canonical ids per templates/states.yml. The alias table is the union of the
// copies that used to live in verify-pipeline / normalize-statuses /
// followup-cadence / analyze-patterns — the test suite pins it to states.yml.
export const CANONICAL_STATUSES = [
  "evaluated", "applied", "responded", "interview",
  "offer", "rejected", "discarded", "skip",
];

export const STATUS_ALIASES = {
  "evaluada": "evaluated", "condicional": "evaluated", "hold": "evaluated",
  "evaluar": "evaluated", "verificar": "evaluated",
  "aplicado": "applied", "enviada": "applied", "aplicada": "applied",
  "applied": "applied", "sent": "applied",
  "respondido": "responded",
  "entrevista": "interview",
  "oferta": "offer",
  "rechazado": "rejected", "rechazada": "rejected",
  "descartado": "discarded", "descartada": "discarded",
  "cerrada": "discarded", "cancelada": "discarded",
  "no aplicar": "skip", "no_aplicar": "skip", "monitor": "skip", "geo blocker": "skip",
};

export function normalizeStatus(raw) {
  const clean = String(raw ?? "").replace(/\*\*/g, "").trim().toLowerCase()
    .replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "").trim();
  return STATUS_ALIASES[clean] || clean;
}

// Local statuses that mean "an application exists" (used by pace math).
export const LOCAL_APPLIED_STATUSES = ["applied", "responded", "interview", "offer"];

/**
 * Canonical outcome buckets for a local tracker row:
 *   positive         — the company engaged: responded / interview / offer
 *   pending_response — applied, no signal yet (NOT a positive outcome —
 *                      counting submissions as wins was the old
 *                      analyze-patterns bug that inflated conversion rates)
 *   negative         — rejected or discarded
 *   self_filtered    — skip (we chose not to apply)
 *   pending          — evaluated / anything pre-decision
 */
export function classifyLocalOutcome(status) {
  const s = normalizeStatus(status);
  if (["interview", "offer", "responded"].includes(s)) return "positive";
  if (s === "applied") return "pending_response";
  if (["rejected", "discarded"].includes(s)) return "negative";
  if (s === "skip") return "self_filtered";
  return "pending";
}

export const LOCAL_OUTCOMES = ["positive", "pending_response", "negative", "self_filtered", "pending"];

// ── Shared math ─────────────────────────────────────────────────────────────
/** Percentage with one decimal place; null on an empty denominator. */
export function rate(n, d, dp = 1) {
  if (!d) return null;
  const f = 10 ** dp;
  return Math.round((100 * n / d) * f) / f;
}

/** Mean of the numeric entries, one decimal place; null on empty. */
export function avg(xs) {
  const v = (xs || []).filter((x) => typeof x === "number" && Number.isFinite(x));
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
}

// ── Funnel over Notion rows ─────────────────────────────────────────────────
/** Headline funnel numbers over the applied cohort. Keys match funnel-metrics.mjs output. */
export function funnelHeadline(rows) {
  const cohort = rows.filter(isApplied);
  const resp = cohort.filter(hasResponded).length;
  const prog = cohort.filter(hasProgressed).length;
  const rej = cohort.filter(isRejected).length;
  return {
    applications_submitted: cohort.length,
    responses: resp,
    response_rate_pct: rate(resp, cohort.length),
    reached_first_stage_or_beyond: prog,
    screen_rate_pct: rate(prog, cohort.length),
    rejections: rej,
    rejection_rate_pct: rate(rej, cohort.length),
    silent_no_response: cohort.length - resp,
  };
}

/**
 * Response/screen/rejection rates grouped by a row field (or key function).
 * Groups whose applied cohort is smaller than minCohort are dropped.
 */
export function sliceBy(rows, key, { minCohort = 1 } = {}) {
  const keyFn = typeof key === "function" ? key : (r) => r[key];
  const groups = {};
  for (const r of rows) {
    const k = keyFn(r) || "(unset)";
    (groups[k] ||= []).push(r);
  }
  const out = [];
  for (const [k, rs] of Object.entries(groups)) {
    const cohort = rs.filter(isApplied);
    if (cohort.length < minCohort) continue;
    const resp = cohort.filter(hasResponded).length;
    const prog = cohort.filter(hasProgressed).length;
    const rej = cohort.filter(isRejected).length;
    out.push({
      group: k,
      applications: cohort.length,
      responded: resp,
      progressed: prog,
      rejected: rej,
      response_rate_pct: rate(resp, cohort.length),
      screen_rate_pct: rate(prog, cohort.length),
      rejection_rate_pct: rate(rej, cohort.length),
    });
  }
  return out.sort((a, b) => b.applications - a.applications);
}

// ── Match-score calibration (the self-improvement hook) ─────────────────────
export const DEFAULT_SCORE_BANDS = [
  { min: 0, max: 75, label: "<75" },
  { min: 75, max: 80, label: "75-79" },
  { min: 80, max: 85, label: "80-84" },
  { min: 85, max: 90, label: "85-89" },
  { min: 90, max: 101, label: "90+" },
];

/**
 * Does the Match score predict outcomes? Response + screen rate per score
 * band over the applied cohort, plus a verdict:
 *   predictive        — response rate climbs ≥10pts from the lowest to the
 *                       highest band with enough data
 *   inverted          — it FALLS ≥10pts (higher scores do worse)
 *   flat              — no meaningful spread: the score is not discriminating,
 *                       so triage floors / weights are running on noise
 *   insufficient-data — fewer than two bands reached minBandSize
 *
 * Bands below minBandSize are reported but excluded from the verdict.
 */
export function scoreCalibration(rows, { bands = DEFAULT_SCORE_BANDS, minBandSize = 5 } = {}) {
  const cohort = rows.filter(isApplied);
  const scored = cohort.filter((r) => typeof r.match_score === "number" && Number.isFinite(r.match_score));

  const bandStats = bands.map((b) => {
    const rs = scored.filter((r) => r.match_score >= b.min && r.match_score < b.max);
    const resp = rs.filter(hasResponded).length;
    const prog = rs.filter(hasProgressed).length;
    return {
      band: b.label,
      applications: rs.length,
      responded: resp,
      progressed: prog,
      response_rate_pct: rate(resp, rs.length),
      screen_rate_pct: rate(prog, rs.length),
      in_verdict: rs.length >= minBandSize,
    };
  });

  const eligible = bandStats.filter((b) => b.in_verdict);
  let verdict, note;
  if (eligible.length < 2) {
    verdict = "insufficient-data";
    note = `Need >=2 score bands with >=${minBandSize} applications each to judge calibration (have ${eligible.length}).`;
  } else {
    const spread = eligible[eligible.length - 1].response_rate_pct - eligible[0].response_rate_pct;
    if (spread >= 10) {
      verdict = "predictive";
      note = `Response rate climbs ${spread.toFixed(1)}pts from band ${eligible[0].band} to ${eligible[eligible.length - 1].band}. The score is discriminating — the triage floor is earning its keep.`;
    } else if (spread <= -10) {
      verdict = "inverted";
      note = `Response rate FALLS ${Math.abs(spread).toFixed(1)}pts from band ${eligible[0].band} to ${eligible[eligible.length - 1].band}. Higher scores are doing WORSE — the scoring rubric is rewarding the wrong things. Revisit the profile scoring weights (modes/_profile.md).`;
    } else {
      verdict = "flat";
      note = `Only ${spread.toFixed(1)}pts of spread across bands — the Match score is not separating winners from losers at the response stage. Manage to response/screen rate by portal/country/referral instead, and treat the score floor as a volume valve, not a quality signal.`;
    }
  }

  return {
    bands: bandStats,
    scored_applications: scored.length,
    unscored_applications: cohort.length - scored.length,
    avg_score_by_outcome: {
      progressed: avg(cohort.filter(hasProgressed).map((r) => r.match_score)),
      rejected: avg(cohort.filter(isRejected).map((r) => r.match_score)),
      silent: avg(cohort.filter(isGhosted).map((r) => r.match_score)),
    },
    min_band_size: minBandSize,
    verdict,
    note,
  };
}

// ── Apply-window adherence (pace math) ──────────────────────────────────────
/**
 * Of the applications in the trailing window, what fraction landed on a
 * preferred/acceptable day? Rows: {date: 'YYYY-MM-DD', status?}. Rows with a
 * status outside LOCAL_APPLIED_STATUSES are skipped; rows without a status
 * are counted (Notion callers pre-filter by Apply date).
 * Output keys match the pace-alarm ROUTINE_CONTRACT block.
 */
export function windowAdherence(rows, {
  preferredDays = [2, 3, 4],   // ISO: Tue-Thu
  acceptableDays = [1],        // Mon
  windowDays = 7,
  now = new Date(),
} = {}) {
  const counts = { preferred: 0, acceptable: 0, avoid: 0 };
  let total = 0;
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  for (const r of rows) {
    if (r.status !== undefined && !LOCAL_APPLIED_STATUSES.includes(normalizeStatus(r.status))) continue;
    const d = new Date(r.date + "T00:00:00Z");
    if (isNaN(d.getTime()) || d < cutoff) continue;
    const isoDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    total++;
    if (preferredDays.includes(isoDow)) counts.preferred++;
    else if (acceptableDays.includes(isoDow)) counts.acceptable++;
    else counts.avoid++;
  }
  if (total === 0) {
    return {
      total_applied_7d: 0,
      preferred_day_count: 0,
      acceptable_day_count: 0,
      avoid_day_count: 0,
      adherence_pct: null,
      note: `no applied rows in last ${windowDays} days`,
    };
  }
  return {
    total_applied_7d: total,
    preferred_day_count: counts.preferred,
    acceptable_day_count: counts.acceptable,
    avoid_day_count: counts.avoid,
    adherence_pct: Math.round(((counts.preferred + counts.acceptable) / total) * 1000) / 10,
    preferred_pct: Math.round((counts.preferred / total) * 1000) / 10,
  };
}
