#!/usr/bin/env node
/**
 * funnel-metrics.mjs — Real outcome metrics for applyd
 *
 * Replaces "Match score" as the headline KPI. Match score measures how well
 * a JD fits the candidate's profile — it has NO employer signal and does not predict
 * outcomes (observed 2026-06: rejected applications averaged a HIGHER match
 * score than the pipeline as a whole). The only metrics that debug a job
 * search are response rate and screen rate, sliced by the levers you control:
 * source portal, country, referral, and sponsorship.
 *
 * Pulls every Applications row from Notion via REST (same auth + config as
 * notion-query.mjs) and computes:
 *   - the funnel (counts by stage)
 *   - response rate   = got any company response / applications submitted
 *   - screen rate     = reached Stage 5+ (got past the first stage) / applications
 *   - rejection rate  = explicit rejections / applications
 *   - the same, sliced by source portal, country, referral, sponsorship
 *   - a match-score reality check (avg score: progressed vs rejected vs pending)
 *   - score calibration (response/screen rate per Match-score band, per edge)
 *   - dimension calibration (which A-G block predicts a response)
 *
 * Auth: NOTION_TOKEN env var (internal integration token, `ntn_`/`secret_`).
 * Reads the database ID from config/profile.yml -> notion.applications_database_id
 * (or the NOTION_DATABASE_ID env var).
 *
 * Usage:
 *   node funnel-metrics.mjs --summary        human-readable report (default)
 *   node funnel-metrics.mjs --json           structured JSON to stdout
 *   node funnel-metrics.mjs --min-cohort 3   hide slices with < 3 applications
 */

import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import {
  funnelHeadline, sliceBy as sliceByCore, scoreCalibration,
  stageEdgeCalibration, dimensionCalibration, parseBlockScores,
} from "./metrics-core.mjs";

const args = process.argv.slice(2);
function arg(name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const JSON_ONLY = args.includes("--json");
const MIN_COHORT = parseInt(arg("--min-cohort", "1"), 10) || 1;

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) {
  console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set.");
  console.error("Get an internal integration token from https://www.notion.com/my-integrations,");
  console.error('add it to the Applications DB, then `setx NOTION_TOKEN "ntn_..."`.');
  process.exit(5);
}

function loadConfig() {
  const path = "config/profile.yml";
  if (!existsSync(path)) return {};
  try { return yaml.load(readFileSync(path, "utf8")) || {}; }
  catch { return {}; }
}
const CFG = loadConfig();
const DATABASE_ID =
  process.env.NOTION_DATABASE_ID ||
  (CFG.notion && CFG.notion.applications_database_id);
if (!DATABASE_ID) {
  console.error("ROUTINE_ABORT: No Notion database ID configured — set NOTION_DATABASE_ID env var or notion.applications_database_id in config/profile.yml");
  process.exit(5);
}
const ENDPOINT = `https://api.notion.com/v1/databases/${DATABASE_ID}/query`;

// Stage taxonomy, outcome classifiers, and rate math all come from
// metrics-core.mjs (the shared semantic layer) — do not redefine them here.

async function query(startCursor = null) {
  const body = { page_size: 100 };
  if (startCursor) body.start_cursor = startCursor;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Notion API ${res.status}: ${t.slice(0, 500)}`);
  }
  return res.json();
}

function extractTitle(props) {
  const titleProp = Object.values(props).find(p => p && p.type === "title");
  if (!titleProp || !titleProp.title || titleProp.title.length === 0) return "";
  return titleProp.title.map(t => t.plain_text).join("");
}

// Extract the concatenated plain text of a rich_text property (used to read
// the Fit-notes block-score sentinel).
function rt(props, name) {
  const prop = props?.[name];
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}

function row(page) {
  const p = page.properties || {};
  const sel = n => (p[n] && p[n].type === "select" ? p[n].select?.name ?? null : null);
  const dat = n => (p[n] && p[n].type === "date" ? p[n].date?.start ?? null : null);
  const num = n => (p[n] && p[n].type === "number" ? p[n].number : null);
  return {
    company: extractTitle(p),
    stage: sel("Stage"),
    apply_date: dat("Apply date"),
    response_date: dat("Response date"),
    referral: sel("Referral?"),
    portal: sel("Source portal"),
    country: sel("Country"),
    sponsorship: sel("Visa/sponsorship"),
    match_score: num("Match score"),
    // [blocks A=4.2 B=3.8 ...] sentinel in Fit notes, written by
    // notion-eval-write --blocks (2026-08-02 onward). null when absent.
    block_scores: parseBlockScores(rt(p, "Fit notes")),
  };
}

// sliceBy wraps the shared metrics-core helper with this script's MIN_COHORT filter.
const sliceBy = (rows, key) => sliceByCore(rows, key, { minCohort: MIN_COHORT });

async function main() {
  const all = [];
  let cursor = null;
  do {
    const r = await query(cursor);
    for (const page of r.results) all.push(row(page));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);

  const funnel = {};
  for (const r of all) funnel[r.stage || "(unset)"] = (funnel[r.stage || "(unset)"] || 0) + 1;

  // Headline funnel + score calibration come from metrics-core (shared with
  // dashboard/pace-alarm), so the same numbers surface everywhere.
  const headline = funnelHeadline(all);

  // Score calibration — response/screen rate per Match-score band. THE
  // self-improvement metric: its verdict says whether triage.score_floor and
  // the scoring weights are earning their keep or running on noise.
  const calibration = scoreCalibration(all, { minBandSize: Math.max(MIN_COHORT, 5) });

  // Back-compat block (older consumers read these keys).
  const match_score_check = {
    avg_score_progressed: calibration.avg_score_by_outcome.progressed,
    avg_score_rejected: calibration.avg_score_by_outcome.rejected,
    avg_score_silent: calibration.avg_score_by_outcome.silent,
    verdict: calibration.verdict,
    note: calibration.note,
  };

  // Stage-edge calibration — the same per-band question asked at EVERY funnel
  // edge, each with its own verdict. Completes the one-off finding
  // ("predictive at response, useless for response->screen") as a standing
  // metric. Deep edges are best-effort: rows only carry their current stage.
  const edge_calibration = stageEdgeCalibration(all, { minBandSize: Math.max(MIN_COHORT, 5) });

  // Dimension calibration — which A-G block predicts a response. Empty until
  // auto-eval starts writing [blocks ...] sentinels via notion-eval-write
  // --blocks (2026-08-02 onward); reports its own rows_without_blocks so the
  // gap is visible, not silent.
  const dimension_calibration = dimensionCalibration(all);

  const result = {
    generated_at: new Date().toISOString(),
    total_rows_in_db: all.length,
    funnel,
    headline,
    match_score_check,
    calibration,                        // legacy key (older consumers)
    score_calibration: calibration,     // canonical key alongside stage/dim
    stage_edge_calibration: edge_calibration,
    dimension_calibration,
    by_referral: sliceBy(all, "referral"),
    by_source_portal: sliceBy(all, "portal"),
    by_country: sliceBy(all, "country"),
    by_sponsorship: sliceBy(all, "sponsorship"),
  };

  if (JSON_ONLY) { console.log(JSON.stringify(result, null, 2)); return; }

  const pct = v => (v === null ? "  —" : `${String(v).padStart(4)}%`);
  const line = "─".repeat(72);
  console.log("\nAPPLYD FUNNEL METRICS  (the real KPIs — not Match score)");
  console.log(line);
  console.log(`Applications submitted : ${headline.applications_submitted}`);
  console.log(`Responses              : ${headline.responses}   (response rate ${pct(headline.response_rate_pct)})`);
  console.log(`Past the first stage   : ${headline.reached_first_stage_or_beyond}   (screen rate   ${pct(headline.screen_rate_pct)})`);
  console.log(`Rejections             : ${headline.rejections}   (rejection rate${pct(headline.rejection_rate_pct)})`);
  console.log(`Silent / no response   : ${headline.silent_no_response}`);
  console.log(line);
  console.log("MATCH-SCORE REALITY CHECK (avg Match score by outcome)");
  console.log(`  progressed: ${match_score_check.avg_score_progressed ?? "—"}   rejected: ${match_score_check.avg_score_rejected ?? "—"}   silent: ${match_score_check.avg_score_silent ?? "—"}`);
  console.log(`  -> ${match_score_check.note}`);
  console.log(line);
  console.log(`SCORE CALIBRATION — verdict: ${calibration.verdict.toUpperCase()}`);
  console.log("  " + "band".padEnd(8) + "apps".padStart(5) + "resp%".padStart(8) + "screen%".padStart(9) + "  (bands under n=" + calibration.min_band_size + " excluded from verdict)");
  for (const b of calibration.bands) {
    console.log(
      "  " + b.band.padEnd(8) + String(b.applications).padStart(5) +
      pct(b.response_rate_pct).padStart(8) + pct(b.screen_rate_pct).padStart(9) +
      (b.in_verdict ? "" : "   (small sample)"),
    );
  }
  console.log(`  -> ${calibration.note}`);

  console.log(line);
  console.log("STAGE-EDGE CALIBRATION (conditional conversion per band, per edge)");
  for (const e of edge_calibration.edges) {
    const bandsStr = e.bands
      .map((b) => `${b.band}:${b.conversion_pct === null ? "—" : b.conversion_pct + "%"}${b.in_verdict ? "" : "*"}`)
      .join("  ");
    console.log(
      `  ${e.edge.padEnd(26)} n=${String(e.entering_total).padStart(3)}  overall ${pct(e.overall_conversion_pct)}  ` +
      `verdict: ${e.verdict.toUpperCase()}${e.best_effort ? " (best-effort)" : ""}`,
    );
    console.log(`    ${bandsStr}   (* = under n=${edge_calibration.min_band_size})`);
  }
  console.log(`  -> ${edge_calibration.bias_note}`);

  console.log(line);
  const dimsWithData = dimension_calibration.dimensions.filter((d) => d.n > 0);
  if (!dimsWithData.length) {
    console.log(`DIMENSION CALIBRATION — no rows carry [blocks ...] scores yet (${dimension_calibration.rows_without_blocks} applied rows without). Activates as auto-eval writes them via notion-eval-write --blocks.`);
  } else {
    console.log(`DIMENSION CALIBRATION (${dimension_calibration.rows_with_blocks} rows with block scores, ${dimension_calibration.rows_without_blocks} without)`);
    for (const d of dimsWithData) {
      console.log(
        `  block ${d.block}  n=${String(d.n).padStart(3)}  median ${d.median}  ` +
        `above ${pct(d.response_rate_above_median_pct)} vs <=median ${pct(d.response_rate_at_or_below_median_pct)}  ` +
        `gap ${d.gap_pts ?? "—"}pts  verdict: ${String(d.verdict).toUpperCase()}`,
      );
    }
  }

  const table = (title, rows) => {
    console.log(line);
    console.log(title);
    console.log("  " + "group".padEnd(22) + "apps".padStart(5) + "resp%".padStart(8) + "screen%".padStart(9) + "rej%".padStart(7));
    for (const r of rows) {
      console.log(
        "  " + String(r.group).slice(0, 22).padEnd(22) +
        String(r.applications).padStart(5) +
        pct(r.response_rate_pct).padStart(8) +
        pct(r.screen_rate_pct).padStart(9) +
        pct(r.rejection_rate_pct).padStart(7),
      );
    }
  };
  table("BY REFERRAL", result.by_referral);
  table("BY SOURCE PORTAL", result.by_source_portal);
  table("BY COUNTRY", result.by_country);
  table("BY SPONSORSHIP", result.by_sponsorship);
  console.log(line);
  console.log(`(cohort = rows that reached "Applied" or beyond; min slice size ${MIN_COHORT})\n`);
}

main().catch(err => {
  console.error("ROUTINE_ABORT:", err.message);
  process.exit(1);
});
