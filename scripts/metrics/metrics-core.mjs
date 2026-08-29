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

// ── Stage-edge calibration (completes scoreCalibration, 2026-08-02) ─────────
// scoreCalibration judges ONE edge: applied→responded, over the whole cohort.
// The 2026-07-27 finding ("predictive at response, useless for
// response→screen") was a one-off hand analysis; this makes every funnel edge
// a standing per-band metric with its own verdict.
//
// KNOWN BIAS, by design of the data: rows carry only their CURRENT stage, so
// a row now "Rejected" has lost the depth it reached first — a
// rejected-after-phone-screen row does not count as having reached the phone
// screen. Edges past "responded→progressed" therefore UNDERCOUNT and are
// reported best_effort:true. Fixing that needs a stage-history property in
// Notion, which does not exist today.
export const FUNNEL_EDGES = [
  // from: rows entering the edge; to: rows converting. Both receive the row.
  { key: "applied_to_responded", from: isApplied, to: hasResponded, best_effort: false },
  { key: "responded_to_progressed", from: hasResponded, to: hasProgressed, best_effort: false },
  {
    key: "progressed_to_interview",
    from: hasProgressed,
    to: (r) => ["6. Phone screen", "7. Tech interview", "8. Onsite/Final", "9. Offer", "Signed"].includes(r.stage),
    best_effort: true,
  },
  {
    key: "interview_to_offer",
    from: (r) => ["6. Phone screen", "7. Tech interview", "8. Onsite/Final", "9. Offer", "Signed"].includes(r.stage),
    to: (r) => ["9. Offer", "Signed"].includes(r.stage),
    best_effort: true,
  },
];

function edgeVerdict(eligible, spreadKey) {
  if (eligible.length < 2) return { verdict: "insufficient-data", spread_pts: null };
  const spread = eligible[eligible.length - 1][spreadKey] - eligible[0][spreadKey];
  const verdict = spread >= 10 ? "predictive" : spread <= -10 ? "inverted" : "flat";
  return { verdict, spread_pts: Math.round(spread * 10) / 10 };
}

/**
 * Conditional conversion per Match-score band, per funnel edge. The applied
 * cohort filter is implicit in each edge's `from` set. minBandSize applies to
 * the edge's own denominator (rows entering that edge in that band), so deep
 * edges naturally fall to insufficient-data until the funnel fills.
 */
export function stageEdgeCalibration(rows, { bands = DEFAULT_SCORE_BANDS, minBandSize = 5 } = {}) {
  const scored = rows.filter((r) => typeof r.match_score === "number" && Number.isFinite(r.match_score));
  const edges = FUNNEL_EDGES.map((edge) => {
    const entering = scored.filter(edge.from);
    const bandStats = bands.map((b) => {
      const rs = entering.filter((r) => r.match_score >= b.min && r.match_score < b.max);
      const conv = rs.filter(edge.to).length;
      return {
        band: b.label,
        entering: rs.length,
        converted: conv,
        conversion_pct: rate(conv, rs.length),
        in_verdict: rs.length >= minBandSize,
      };
    });
    const { verdict, spread_pts } = edgeVerdict(bandStats.filter((b) => b.in_verdict), "conversion_pct");
    return {
      edge: edge.key,
      best_effort: edge.best_effort,
      entering_total: entering.length,
      converted_total: entering.filter(edge.to).length,
      overall_conversion_pct: rate(entering.filter(edge.to).length, entering.length),
      bands: bandStats,
      verdict,
      spread_pts,
    };
  });
  return {
    edges,
    scored_rows: scored.length,
    min_band_size: minBandSize,
    bias_note: "Rows carry only their current stage; rejected rows lose the depth they reached, so best_effort edges undercount. A predictive verdict on them is trustworthy, a flat one is not.",
  };
}

// ── Dimension-level calibration (A–G block scores) ──────────────────────────
// The aggregate Match score was the ONLY structured evaluation output until
// 2026-08-02, so dimension calibration has no historical data — it activates
// as auto-eval starts writing a machine-parseable block-score line into Fit
// notes via notion-eval-write --blocks. Sentinel format, one line:
//   [blocks A=4.2 B=3.8 C=4.0 D=3.5 E=4.1 F=3.9 G=5.0]
// Letters map to oferta.md blocks: A fit, B comp, C company, D growth,
// E logistics, F interview-readiness, G legitimacy.
export const BLOCK_KEYS = ["A", "B", "C", "D", "E", "F", "G"];
// Capture is deliberately loose (anything up to the closing bracket): a
// single malformed pair must not void the parseable ones — pair-level
// validation below does the filtering.
const BLOCKS_RE = /\[blocks\s+([^\]]+)\]/i;

/** Extract {A: 4.2, ...} from a Fit-notes string; null when no sentinel. */
export function parseBlockScores(text) {
  const m = BLOCKS_RE.exec(String(text || ""));
  if (!m) return null;
  const out = {};
  for (const pair of m[1].trim().split(/\s+/)) {
    const [k, v] = pair.split("=");
    const n = parseFloat(v);
    if (BLOCK_KEYS.includes(k.toUpperCase()) && Number.isFinite(n)) out[k.toUpperCase()] = n;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Which evaluation dimension actually predicts a response? For each block,
 * split the applied cohort at the block's median score and compare response
 * rates above vs below. A dimension whose above-median half responds ≥10pts
 * better is carrying signal; one with no gap is dead weight in the rubric.
 * Rows need block_scores (object from parseBlockScores) — rows without it
 * are skipped and counted in rows_without_blocks.
 */
export function dimensionCalibration(rows, { minPerSide = 5 } = {}) {
  const cohort = rows.filter(isApplied);
  const withBlocks = cohort.filter((r) => r.block_scores && Object.keys(r.block_scores).length);
  const dims = BLOCK_KEYS.map((k) => {
    const rs = withBlocks.filter((r) => typeof r.block_scores[k] === "number");
    if (!rs.length) return { block: k, n: 0, verdict: "no-data" };
    const sorted = rs.map((r) => r.block_scores[k]).sort((a, b) => a - b);
    // Lower median: on a two-valued distribution (half 2s, half 5s) the upper
    // median would leave the "above" side empty and read as insufficient-data.
    const median = sorted[Math.floor((sorted.length - 1) / 2)];
    const above = rs.filter((r) => r.block_scores[k] > median);
    const below = rs.filter((r) => r.block_scores[k] <= median);
    const aRate = rate(above.filter(hasResponded).length, above.length);
    const bRate = rate(below.filter(hasResponded).length, below.length);
    const enough = above.length >= minPerSide && below.length >= minPerSide;
    const gap = aRate !== null && bRate !== null ? Math.round((aRate - bRate) * 10) / 10 : null;
    return {
      block: k,
      n: rs.length,
      median,
      response_rate_above_median_pct: aRate,
      response_rate_at_or_below_median_pct: bRate,
      gap_pts: gap,
      verdict: !enough ? "insufficient-data" : gap >= 10 ? "signal" : gap <= -10 ? "inverted" : "flat",
    };
  });
  return {
    dimensions: dims,
    rows_with_blocks: withBlocks.length,
    rows_without_blocks: cohort.length - withBlocks.length,
    min_per_side: minPerSide,
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

// ─────────────────────────────────────────────────────────────────────────────
// CV profile source (added 2026-08-01) — semantic layer for the A/B analysis
// wired via cv/profile-source-log.mjs (per-render) and joined against Notion
// outcomes by cv/profile-source-outcomes.mjs.
//
// Motivation: same rule as the stage taxonomy above — one place answers "what
// does 'llm-enriched' mean vs 'template-fallback'?" so downstream analysers
// bucket consistently. The renderers emit free-form source strings like
// "llm-enriched (75 words)" or "template-fallback (word_count: 130)" which
// carry useful context for logs; bucketing collapses them to the coarse
// analytical categories below.
// ─────────────────────────────────────────────────────────────────────────────

// Canonical coarse buckets — the surface every analyser sees.
export const CV_PROFILE_SOURCE_BUCKETS = [
  "llm",                  // successful LLM enrichment via cv/profile-enrich.mjs
  "template-fallback",    // enrichment attempted, tripped a guardrail, template shipped
  "template",             // no JD text available or CAREEROPS_PROFILE_ENRICH=0; template shipped
  "static",               // static cv.md profile shipped (no keywords/JD/seniority)
  "explicit",             // caller passed --profile-text; author override
  "other",                // unknown / malformed source strings
];

export function bucketProfileSource(raw) {
  const s = String(raw || "").toLowerCase();
  if (s.startsWith("llm-enriched")) return "llm";
  if (s.startsWith("template-fallback")) return "template-fallback";
  if (s.startsWith("template")) return "template";
  if (s.startsWith("static")) return "static";
  if (s.startsWith("explicit")) return "explicit";
  return "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// QA verdicts (added 2026-08-01) — semantic layer for the qa-log.jsonl store
// cv-qa writes on every row, aggregated by cv/qa-outcomes.mjs.
//
// Definition boundary matters: exit code 0 (PASS) is unambiguous, exit code 2
// covers both "auto-patched then passed" and "regenerated then passed", and
// exit code 3 means the row still needs manual attention. Different analysers
// used to conflate PATCH_AND_PASS with REGENERATE — this taxonomy pins the
// distinction so pass_rate calculations agree.
// ─────────────────────────────────────────────────────────────────────────────

export const QA_VERDICTS = ["PASS", "PATCH_AND_PASS", "REGENERATE"];

// classifyQaOutcome({overall_verdict, regen_attempts, profile_regen_attempts, patches_applied})
// Returns one of: "clean" | "auto_patched" | "regenerated" | "manual_needed".
// Regen counts win over patch count when both apply (regen is the bigger fix).
export function classifyQaOutcome(row) {
  const v = String(row?.overall_verdict || "").toUpperCase();
  if (v === "PASS") return "clean";
  const regen = (row?.regen_attempts || 0) + (row?.profile_regen_attempts || 0);
  const patches = row?.patches_applied || 0;
  if (v === "PATCH_AND_PASS" || (regen > 0 && patches > 0)) {
    return regen > 0 ? "regenerated" : "auto_patched";
  }
  if (v === "REGENERATE" || regen === 0 && patches === 0) return "manual_needed";
  return "manual_needed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover-letter enrichment fields (added 2026-08-01) — canonical list of the
// brief.* fields cv/cover-letters/lib/research.js populates and the composer
// consumes. Any new field added downstream (e.g. brief.hiring_manager_name)
// belongs here so QA prompts and dashboards can reference the same list.
// ─────────────────────────────────────────────────────────────────────────────

export const CL_ENRICHMENT_FIELDS = [
  "company", "job_title", "job_url",
  // 2026-08-01 additions — see cover-letters/lib/research.js
  "reference_code", "contact_name", "advert_date", "source_portal", "company_legal_form",
  // Address block (older; still tracked here as the canonical spec)
  "company_address", "company_postal_code", "company_city", "company_country",
];

// ─────────────────────────────────────────────────────────────────────────────
// Canonical company slug (added 2026-08-01) — one slugifier for the
// company-research store, profile-source-outcomes join, and any future
// per-company aggregation. Downstream modules import this instead of
// re-implementing (which they did before this consolidation).
// ─────────────────────────────────────────────────────────────────────────────

export function companySlug(nameOrSlug) {
  return String(nameOrSlug || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic dedup (added 2026-08-02) — the 4th layer of dedup, catching cases
// where the URL differs but the OPPORTUNITY is the same: Xing + LinkedIn +
// company careers page all posting the same "Data Engineer" role at the same
// company, days apart. URL-based dedup (scan-history + Notion existing-url
// check) misses these; cross-portal-dedup catches them only within a single
// scan burst; this layer catches them ACROSS bursts and ACROSS days.
//
// Design: compute a stable fingerprint from (company, role_title, location)
// after normalisation. Two rows with the same fingerprint are the same job.
// Fingerprint is deterministic (no dates, no URLs, no scores) so a row scored
// on day 1 and re-posted on day 5 collapses to the same fingerprint.
//
// What normalisation removes:
//   - Legal form suffix (GmbH / AG / SE / Ltd / plc / Inc / LLC / SA / BV /
//     AB / Oy / A/S / N.V. / S.p.A. / Sp. z o.o. / KGaA / mbH) — same
//     employer whether the title carries the suffix or not
//   - Gender markers ((m/w/d), (m/f/d), (all genders), (gn), (divers)) —
//     "Data Engineer (m/w/d)" and "Data Engineer" are the same role
//   - Emojis, whitespace collapse, punctuation strip, lowercase
//   - Location: split on comma → keep first token → lowercase (so
//     "Berlin, Germany" and "Berlin" collapse)
//
// What normalisation KEEPS:
//   - Seniority level tokens (junior/senior/staff/principal/lead/head/vp) —
//     "Senior Data Engineer" and "Data Engineer" are LEGITIMATELY different
//     roles. Stripping levels would falsely merge them.
//   - Team/product descriptors in parens ("Data Engineer (Marketing)" vs
//     "Data Engineer (Product)") — different teams = different roles.
//
// False-positive risk: two genuinely different Data Engineer roles at the
// same company with no distinguishing suffix will collapse. Accept — human
// review of the reporter is expected before --auto-archive.
// ─────────────────────────────────────────────────────────────────────────────

const LEGAL_FORM_RE = /\s*(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|SE(?:\s*&\s*Co\.?\s*KGaA)?|KGaA|mbH|Ltd\.?|plc|Inc\.?|LLC|Corp\.?|SA|SAS|BV|AB|Oy|A\/S|N\.?V\.?|S\.p\.A\.|Sp\.\s?z\s?o\.\s?o\.|Pty\s?Ltd)\s*\.?\s*$/i;

// Gender-marker parenthetical: (m/w/d), (m/f/d), (m/w/x), (d/m/w), (all
// genders), (gn), (divers), (gender-neutral), (geschlechtsneutral). Also
// square-brackets. Uses a single-char class alternation so "(m|w|d)" and
// "(m·w·d)" both hit.
const GENDER_MARKER_RE = /\s*[\(\[]\s*(?:(?:[mwfdxiagn]|divers|gn)(?:\s*[\/|·]\s*(?:[mwfdxiagn]|divers|gn))+|all\s+genders?|gender[-\s]?neutral|geschlechtsneutral|gn|divers)\s*[\)\]]/gi;

// Emoji ranges — quick strip so "Data Engineer 🚀" and "Data Engineer" collapse.
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}]/gu;

export function normaliseCompany(name) {
  if (!name) return "";
  let s = String(name).replace(EMOJI_RE, "").trim();
  // Decode common HTML entities BEFORE the strip so "Cushman &amp; Wakefield"
  // and "Cushman & Wakefield" normalise to the same slug. Decode "&amp;" LAST
  // so an "&amp;lt;" payload cannot double-decode to "<" (js/double-escaping).
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
       .replace(/&amp;/g, "&");
  s = s.replace(LEGAL_FORM_RE, "").trim();
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return s;
}

export function normaliseRoleTitle(role) {
  if (!role) return "";
  let s = String(role).replace(EMOJI_RE, "").trim();
  s = s.replace(GENDER_MARKER_RE, "").trim();
  // Strip HTML entities that leak from scraped titles (&amp; &#039; &quot;).
  // Decode "&amp;" LAST so an "&amp;lt;" payload cannot double-decode to "<"
  // (js/double-escaping).
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
       .replace(/&amp;/g, "&");
  // Collapse whitespace, lowercase, strip trailing punctuation.
  s = s.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim();
  // Normalise common separators to spaces so "data-engineer" and "data engineer" match.
  s = s.replace(/[-_/]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

export function normaliseLocation(location) {
  if (!location) return "";
  // Take the FIRST comma-separated segment (usually the city). "Berlin, Germany" → "berlin".
  // Also handle "Berlin (Hybrid)" → "berlin" and "Berlin / Remote" → "berlin".
  let s = String(location).split(/[,\/]/)[0]
    .replace(/\([^)]*\)/g, "")  // strip parentheticals (Hybrid), (Remote)
    .replace(EMOJI_RE, "")
    .trim().toLowerCase();
  s = s.replace(/[^a-zäöüß0-9\s-]/g, "").replace(/\s+/g, "-").replace(/^-|-$/g, "");
  return s;
}

/**
 * Semantic fingerprint for a job posting. Two postings with the same fingerprint
 * are treated as the same opportunity, regardless of URL.
 *
 * @param {object} row  {company, role_title, location}
 * @param {object} [opts]  {includeLocation: true}  // set false to dedup across
 *                         cities (rare — usually you want city as a discriminator)
 * @returns {string} "company|role|location" — safe to use as a Map key.
 */
export function companyRoleFingerprint(row, { includeLocation = true } = {}) {
  const c = normaliseCompany(row?.company || row?.title || "");
  const r = normaliseRoleTitle(row?.role_title || row?.position || row?.role || "");
  const l = includeLocation ? normaliseLocation(row?.location || "") : "";
  return `${c}|${r}|${l}`;
}

/* ── advert-identity fingerprint ─────────────────────────────────────────────
 *
 * `companyRoleFingerprint` cannot see one class of duplicate: the SAME advert
 * reached by two URLs, filed under two different role labels. APP-4943 and
 * APP-4339 were both eFC advert id24578904 ("Data Platform Engineer"), recorded
 * as "Analytics Engineer" and "Data Engineer" — role differs, so the semantic
 * fingerprint splits them, and the URL strings differ, so URL-key dedup splits
 * them too. Locale pairs are the same class: `jobs.siemens.com/en_US/.../518024`
 * and `/de_DE/.../518024` are one job.
 *
 * The id is ALWAYS namespaced by portal, never used bare. This corpus already
 * contains the collision that proves it necessary: advert `100234` exists on
 * both comparethemarketcareers.com and an Oracle recruiting host, as unrelated
 * jobs.
 *
 * Returning "" means "no reliable id" and disables id-dedup for that row. That
 * is the safe direction: a missed duplicate costs a wasted draft, a false one
 * archives a live opportunity.
 */
function hostFamily(hostname) {
  return String(hostname || "").toLowerCase()
    .replace(/^www\./, "")
    // Country/locale subdomains on the SAME portal must collapse: a LinkedIn
    // advert is one advert whether it is served from uk. or de.
    .replace(/^(uk|de|nl|ch|at|fr|es|it|ie|pl|be|dk|se|no|fi|pt|cz|in|ca|za|ph|gr|ee|us|au|sg|hk|jp)\./, "");
}

// Ordered: the first rule that matches wins. `gh_jid` is checked before any
// host rule because a Greenhouse-backed careers page (sumup.com,
// traderepublic.com) carries the authoritative board id in the query string
// while its own path id is incidental.
const ADVERT_ID_RULES = [
  { portal: "greenhouse", test: /[?&]gh_jid=(\d{4,})/i, onAnyHost: true },
  { portal: "efc",        host: /^efinancialcareers\./,            test: /\.id(\d{4,})\b/i },
  { portal: "linkedin",   host: /^linkedin\.com$/,                 test: /\/jobs\/view\/(?:.*?-)?(\d{8,})(?:[/?#]|$)/ },
  { portal: "xing",       host: /^xing\.com$/,                     test: /\/jobs\/.*?-(\d{7,})(?:[/?#]|$)/ },
  { portal: "stepstone",  host: /^stepstone\./,                    test: /--(\d{6,})(?:-inline)?\.html/ },
  { portal: "indeed",     host: /^indeed\.com$/,                   test: /[?&]jk=([a-z0-9]{8,})/i },
  { portal: "csjobs",     host: /^civilservicejobs\./,             test: /[?&]jcode=(\d{4,})/i },
  // WTTJ slugs end EITHER "_city_hash" or just "_city". Requiring a digit is
  // what separates them: caught in validation on 2026-08-16, where three
  // unrelated London jobs (Funding Circle, Ekimetrics, Ogury) all ended "_london"
  // and collapsed into one bogus cluster. City names never contain a digit.
  { portal: "wttj",       host: /^welcometothejungle\.com$/,       test: /\/jobs\/[^/?#]*_([a-z0-9]{6,})(?:[/?#]|$)/i,
    accept: (id) => /\d/.test(id) && /[a-z]/.test(id) },
  { portal: "ashby",      host: /^jobs\.ashbyhq\.com$/,            test: /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { portal: "lever",      host: /^jobs\.lever\.co$/,               test: /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i },
  { portal: "greenhouse", host: /greenhouse\.io$/,                 test: /\/jobs\/(\d{4,})/ },
  { portal: "handshake",  host: /^app\.joinhandshake\.com$/,       test: /\/job-search\/(\d{4,})/ },
];

export function advertIdFingerprint(jobUrl) {
  if (!jobUrl) return "";
  let url;
  try { url = new URL(String(jobUrl)); } catch { return ""; }
  const fam = hostFamily(url.hostname);
  const full = url.href;

  for (const rule of ADVERT_ID_RULES) {
    if (!rule.onAnyHost && !rule.host.test(fam)) continue;
    const m = full.match(rule.test);
    if (!m) continue;
    const id = m[1].toLowerCase();
    // A rule that matches but fails its own acceptance check yields NO id at
    // all. Falling through to the generic tail rule here would be worse than
    // useless — it would be the same wrong guess in a different namespace.
    if (rule.accept && !rule.accept(id)) return "";
    return `${rule.portal}:${id}`;
  }

  // Generic tail-id fallback for the long tail of ATS and careers hosts
  // (Siemens JobDetail/518024, Zalando /jobs/2724292-…, Booking /jobs/29399,
  // Personio /job/2619367). Namespaced by host family, so a number that means
  // one job here can never collide with the same number elsewhere. Requires 5+
  // digits: shorter numbers on a path are far more often a category, a page
  // number, or a year than an advert id.
  const tail = url.pathname.match(/\/(\d{5,})(?:-[^/]*)?\/?$/);
  if (tail) return `${fam}:${tail[1]}`;

  // Some ATS put the id MID-path with the slug after it, so the trailing rule
  // above misses them entirely: careers.allianz.com/us/en/job/104496/Finance-
  // Data-Engineer-f-m-d yielded no id at all (found 2026-08-18 while checking a
  // real posting that was already in the tracker three times). A path segment of
  // 5+ digits is an id wherever it sits.
  const mid = url.pathname.match(/\/(\d{5,})\/[^/]+\/?$/);
  if (mid) return `${fam}:${mid[1]}`;

  return "";
}
