#!/usr/bin/env node
/**
 * build-dashboard.mjs — Snapshot Notion state into a JSON file for the dashboard
 *
 * Pulls full pipeline state via the Notion REST API (NOTION_TOKEN-authed,
 * uses notion-query.mjs's same database_id and pagination logic), summarises:
 *   - per-stage counts (Discovered / Triaged / Drafted / Applied / ...)
 *   - top 10 drafted rows (Stage 3, ranked by Match score)
 *   - top 10 triaged rows pending draft
 *   - last 7 days of new discoveries (per portal, per day)
 *   - recruiter-sim verdict distribution
 *   - stale-portal report (companies failing scans repeatedly)
 *   - wrapper-trace summary (today's routine outcomes)
 *
 * Writes:
 *   - data/dashboard.json     (machine-readable snapshot)
 *   - dashboard.html          (self-contained single-file dashboard with
 *                              the JSON embedded as a <script> tag,
 *                              opens locally OR pastes into Cowork)
 *
 * Usage:
 *   node build-dashboard.mjs
 *   node build-dashboard.mjs --open       # also opens dashboard.html
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { funnelHeadline, scoreCalibration } from "../metrics/metrics-core.mjs";

const args = process.argv.slice(2);
const OPEN_AFTER = args.includes("--open");

const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set."); process.exit(5); }

function loadConfig() {
  const path = "config/profile.yml";
  if (!existsSync(path)) return {};
  try { return yaml.load(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}
const CFG = loadConfig();
const DATABASE_ID = (CFG.notion && CFG.notion.applications_database_id) || process.env.NOTION_DATABASE_ID;
if (!DATABASE_ID) { console.error('No Notion database ID. Set notion.applications_database_id in config/profile.yml or NOTION_DATABASE_ID env var.'); process.exit(1); }

async function queryAll(filter = null) {
  const all = [];
  let cursor = null;
  do {
    const body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Notion API ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    for (const page of j.results) all.push(page);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return all;
}

function extractEssentials(page) {
  const p = page.properties || {};
  const get = (n, t) => {
    const x = p[n];
    if (!x || x.type !== t) return null;
    if (t === "select") return x.select?.name ?? null;
    if (t === "number") return x.number;
    if (t === "url") return x.url;
    if (t === "rich_text") return x.rich_text?.map(t => t.plain_text).join("") ?? "";
    if (t === "multi_select") return x.multi_select?.map(o => o.name) ?? [];
    if (t === "date") return x.date?.start ?? null;
    if (t === "files") return x.files?.length ?? 0;
    if (t === "title") return x.title?.map(t => t.plain_text).join("") ?? "";
    return null;
  };
  const titleProp = Object.values(p).find(x => x && x.type === "title");
  const title = titleProp ? titleProp.title.map(t => t.plain_text).join("") : "";
  return {
    id: page.id,
    page_url: page.url,
    application_id: p["Application ID"]?.unique_id ? `${p["Application ID"].unique_id.prefix}-${p["Application ID"].unique_id.number}` : null,
    title,
    stage: get("Stage", "select"),
    match_score: get("Match score", "number"),
    country: get("Country", "select"),
    location: get("Location", "rich_text"),
    job_url: get("Job URL", "url"),
    position: get("Position", "multi_select"),
    source_portal: get("Source portal", "select"),
    language: get("Language", "select"),
    company_tier: get("Company tier", "select"),
    agent_run_id: get("Agent run ID", "rich_text"),
    fit_notes_preview: (get("Fit notes", "rich_text") || "").slice(0, 200),
    discovered_date: get("Discovered date", "date"),
    apply_date: get("Apply date", "date"),
    response_date: get("Response date", "date"),
    recruiter_sim_verdict: get("Recruiter-sim verdict", "select"),
    resume_files: get("Resume", "files"),
    cover_letter_files: get("Cover Letter", "files"),
    cv_variant: get("CV variant", "select"),
    cl_variant: get("CL variant", "select"),
  };
}

function summarise(rows) {
  const byStage = {};
  const byPortal = {};
  const byCountry = {};
  const byDay = {};
  const recruiterSim = { INVITE: 0, MAYBE: 0, REJECT: 0, none: 0 };

  for (const r of rows) {
    byStage[r.stage || "(none)"] = (byStage[r.stage || "(none)"] || 0) + 1;
    if (r.source_portal) byPortal[r.source_portal] = (byPortal[r.source_portal] || 0) + 1;
    if (r.country) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
    if (r.discovered_date) {
      const d = r.discovered_date.slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
    if (r.recruiter_sim_verdict) recruiterSim[r.recruiter_sim_verdict] = (recruiterSim[r.recruiter_sim_verdict] || 0) + 1;
    else recruiterSim.none++;
  }

  // Top drafted (Stage 3, sorted by match_score desc)
  const drafted = rows
    .filter(r => r.stage === "3. Drafted")
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, 10);

  // Top triaged pending draft
  const triaged = rows
    .filter(r => r.stage === "2. Triaged")
    .sort((a, b) => (b.match_score ?? 0) - (a.match_score ?? 0))
    .slice(0, 10);

  // Last 7 days of intake (sorted desc)
  const today = new Date();
  const last7 = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    last7[k] = byDay[k] || 0;
  }

  return {
    total_rows: rows.length,
    by_stage: byStage,
    by_portal: byPortal,
    by_country: byCountry,
    by_day_last_7: last7,
    recruiter_sim_distribution: recruiterSim,
    top_drafted: drafted,
    top_triaged_pending: triaged,
    // Outcome metrics from the shared semantic layer (metrics-core.mjs) — the
    // same numbers funnel-metrics.mjs reports, so dashboard and CLI agree.
    funnel: funnelHeadline(rows),
    calibration: scoreCalibration(rows),
  };
}

function readWrapperTrace() {
  const p = "data/wrapper-trace.log";
  if (!existsSync(p)) return { available: false, exits: [] };
  const today = new Date().toISOString().slice(0, 10);
  const todayShort = new Date().toLocaleDateString("en-GB").split("/").reverse().join("-");
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const exitsToday = lines
    .filter(l => l.startsWith(todayShort) && l.includes("EXIT routine="))
    .map(l => {
      const m = l.match(/^(\S+ \S+)\tEXIT routine=(\S+) exit=(\S+) timeout=(\S+) contract_valid=(\S+)/);
      if (!m) return null;
      return { time: m[1], routine: m[2], exit_code: m[3], timed_out: m[4], contract_valid: m[5] };
    })
    .filter(Boolean);
  return { available: true, exits_today: exitsToday };
}

function readScanFailures() {
  const p = "data/scan-failures.json";
  if (!existsSync(p)) return { available: false, stale: [] };
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    const stale = Object.entries(data)
      .filter(([_, v]) => (v.consecutive || 0) >= 3)
      .map(([name, v]) => ({ name, consecutive: v.consecutive, last_error: v.last_error, last_seen_ok: v.last_seen_ok }))
      .sort((a, b) => b.consecutive - a.consecutive);
    return { available: true, stale };
  } catch { return { available: false, stale: [] }; }
}

function readPaceSummary() {
  // Run pace-alarm --json and parse the contract block; cheap (no LLM, no network).
  const r = spawnSync("node", ["scripts/metrics/pace-alarm.mjs", "--json"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    // The script emits JSON then the contract block; grab the JSON object.
    const lines = r.stdout.split("\n");
    const startIdx = lines.findIndex(l => l.trim() === "{");
    if (startIdx < 0) return null;
    let depth = 0, endIdx = -1;
    for (let i = startIdx; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { endIdx = i; break; } }
      }
      if (endIdx >= 0) break;
    }
    if (endIdx < 0) return null;
    return JSON.parse(lines.slice(startIdx, endIdx + 1).join("\n"));
  } catch { return null; }
}

async function main() {
  console.log("Fetching all Notion rows…");
  const pages = await queryAll();
  console.log(`  ${pages.length} rows`);

  const rows = pages.map(extractEssentials);
  const summary = summarise(rows);
  const trace = readWrapperTrace();
  const failures = readScanFailures();
  const pace = readPaceSummary();

  const snapshot = {
    generated_at: new Date().toISOString(),
    database_id: DATABASE_ID,
    summary,
    wrapper_trace: trace,
    stale_portals: failures,
    pace_summary: pace,
  };

  writeFileSync("data/dashboard.json", JSON.stringify(snapshot, null, 2));
  console.log(`  → data/dashboard.json (${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB)`);

  // Also write data.json at repo root — for GitHub Pages to serve as a
  // cache-bustable endpoint. The HTML fetches this with ?t=<timestamp>
  // on every load so even if the HTML/CDN is cached, the data is fresh.
  writeFileSync("data.json", JSON.stringify(snapshot));
  console.log(`  → data.json (root, for GH Pages cache-bust)`);

  // Build self-contained HTML
  const html = buildHtml(snapshot);
  writeFileSync("dashboard.html", html);
  console.log(`  → dashboard.html (${(html.length / 1024).toFixed(1)} KB)`);

  if (OPEN_AFTER) {
    const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    spawnSync(opener, ["dashboard.html"], { stdio: "ignore", shell: true });
  }

  console.log("\n--- ROUTINE_CONTRACT ---");
  console.log(`ROUTINE: build-dashboard`);
  console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
  console.log(`ROWS_PULLED: ${rows.length}`);
  console.log(`BY_STAGE: ${JSON.stringify(summary.by_stage)}`);
  console.log(`RESPONSE_RATE_PCT: ${summary.funnel.response_rate_pct ?? "n/a"}`);
  console.log(`SCREEN_RATE_PCT: ${summary.funnel.screen_rate_pct ?? "n/a"}`);
  console.log(`CALIBRATION_VERDICT: ${summary.calibration.verdict}`);
  console.log(`TOP_DRAFTED_COUNT: ${summary.top_drafted.length}`);
  console.log(`PACE_STATUS: ${pace?.status ?? "n/a"}`);
  console.log(`STALE_PORTALS: ${failures.stale?.length ?? 0}`);
  console.log(`OUTPUT_HTML: dashboard.html`);
  console.log(`OUTPUT_JSON: data/dashboard.json`);
  console.log(`ERRORS: 0`);
  console.log("--- END_ROUTINE_CONTRACT ---");
}

function buildHtml(s) {
  const data = JSON.stringify(s).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="21600" />
<title>the user applyd Dashboard</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --border:#262b35; --fg:#e6e8ec; --muted:#8a94a6;
    --accent:#d4471f; --good:#34d399; --warn:#fbbf24; --bad:#ef4444; --blue:#60a5fa;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .wrap{max-width:1280px;margin:0 auto;padding:24px}
  h1{font-size:22px;font-weight:600;margin:0 0 4px}
  h1 .sub{font-weight:400;color:var(--muted);font-size:14px;margin-left:8px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin:20px 0 8px}
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:14px}
  .kpi{font-size:28px;font-weight:600;line-height:1}
  .kpi .label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:600;margin-top:4px}
  .bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--border);margin:6px 0 10px}
  .bar span{display:block}
  .stage-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
  .s1{background:#1e2530;color:#9aa3b2}
  .s2{background:#3f3a1c;color:#fcd34d}
  .s3{background:#2b3a1a;color:#a3e635}
  .s4{background:#1a3a36;color:#34d399}
  .sNot{background:#2a1f23;color:#a3766e}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
  th{color:var(--muted);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  td a{color:var(--blue);text-decoration:none}
  td a:hover{text-decoration:underline}
  .score{font-weight:600}
  .score-92,.score-91,.score-90,.score-89,.score-88,.score-87,.score-86,.score-85{color:var(--good)}
  .score-84,.score-83,.score-82,.score-81,.score-80,.score-79,.score-78,.score-77,.score-76,.score-75{color:var(--warn)}
  .score-low{color:var(--muted)}
  .pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:10px;background:var(--border);color:var(--muted);margin-right:4px}
  .pill.invite{background:#1a3a36;color:var(--good)}
  .pill.reject{background:#2a1a1a;color:var(--bad)}
  .pill.maybe{background:#3a341a;color:var(--warn)}
  .meta{color:var(--muted);font-size:12px;margin-top:4px}
  .footer{margin-top:24px;color:var(--muted);font-size:11px;text-align:center}
  .footer code{background:var(--panel);padding:2px 6px;border-radius:4px;color:var(--fg)}
  .sparkline{display:flex;gap:2px;align-items:flex-end;height:32px;margin-top:6px}
  .sparkline div{flex:1;background:var(--accent);border-radius:2px;min-height:2px;transition:opacity .2s}
  .sparkline div:hover{opacity:0.7}
  .empty{color:var(--muted);font-style:italic;font-size:13px}
</style>
</head>
<body>
<div class="wrap">

<h1>the user applyd Dashboard<span class="sub" id="ts"></span></h1>

<div class="row" id="kpis"></div>

<h2>Pipeline by stage</h2>
<div class="card" id="stages"></div>

<h2>Source-portal mix</h2>
<div class="card" id="portals"></div>

<div class="row">
  <div class="card">
    <h2 style="margin-top:0">Top 10 Stage 3 — Drafted, ready to send</h2>
    <table><thead><tr><th>App</th><th>Score</th><th>Company</th><th>Position</th><th>Country</th><th>Verdict</th><th>Files</th></tr></thead><tbody id="tbl-drafted"></tbody></table>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Top 10 Stage 2 — Triaged, awaiting draft</h2>
    <table><thead><tr><th>App</th><th>Score</th><th>Company</th><th>Position</th><th>Country</th><th>Verdict</th></tr></thead><tbody id="tbl-triaged"></tbody></table>
  </div>
</div>

<div class="row">
  <div class="card">
    <h2 style="margin-top:0">Last 7 days intake</h2>
    <div class="sparkline" id="sparkline"></div>
    <div class="meta" id="sparkline-labels"></div>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Pace</h2>
    <div id="pace"></div>
  </div>
  <div class="card">
    <h2 style="margin-top:0">Today's routine runs</h2>
    <div id="trace"></div>
  </div>
</div>

<h2>Stale portals (≥3 consecutive scan failures)</h2>
<div class="card" id="stale"></div>

<div class="footer">
  Generated <span id="gen"></span> · regenerate with <code>node build-dashboard.mjs</code>
</div>
</div>

<script type="application/json" id="snapshot">${data}</script>
<script>
(function(){
  const embedded = JSON.parse(document.getElementById("snapshot").textContent);

  // Try to fetch fresh data.json with cache-busting query string.
  // The CDN treats each ?t= value as a distinct URL → cache miss → fresh.
  // Falls back to the embedded snapshot if the fetch fails (offline,
  // local-only use, JS disabled, etc.).
  const cacheBust = '?t=' + Date.now();
  fetch('./data.json' + cacheBust, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject('non-200'))
    .then(fresh => render(fresh, /*live=*/true))
    .catch(() => render(embedded, /*live=*/false));

  function render(s, live) {
  const summary = s.summary;
  const $ = id => document.getElementById(id);

  const ts = new Date(s.generated_at).toLocaleString();
  $("ts").textContent = " · " + (live ? "live " : "snapshot ") + ts;
  $("gen").textContent = ts + (live ? " (live)" : " (embedded fallback)");

  // KPIs
  const stage1 = summary.by_stage["1. Discovered"] || 0;
  const stage2 = summary.by_stage["2. Triaged"] || 0;
  const stage3 = summary.by_stage["3. Drafted"] || 0;
  const stage4 = summary.by_stage["4. Applied"] || 0;
  const notPursuing = summary.by_stage["Not pursuing"] || 0;
  // Outcome KPIs (metrics-core semantic layer); tolerate pre-funnel snapshots.
  const fn = summary.funnel || {};
  const cal = summary.calibration || {};
  $("kpis").innerHTML = [
    {label:"Total rows", value: summary.total_rows},
    {label:"Discovered", value: stage1},
    {label:"Triaged",    value: stage2},
    {label:"Drafted",    value: stage3},
    {label:"Applied",    value: fn.applications_submitted ?? stage4},
    {label:"Response rate", value: fn.response_rate_pct != null ? fn.response_rate_pct + "%" : "—",
     title: (fn.responses ?? "?") + " responses / " + (fn.applications_submitted ?? "?") + " applications"},
    {label:"Screen rate", value: fn.screen_rate_pct != null ? fn.screen_rate_pct + "%" : "—",
     title: (fn.reached_first_stage_or_beyond ?? "?") + " past first stage"},
    {label:"Score calibration", value: cal.verdict ? cal.verdict.replace("insufficient-data","low n") : "—",
     small: true, title: cal.note || ""},
    {label:"Not pursuing", value: notPursuing},
  ].map(k => '<div class="card"' + (k.title ? ' title="' + String(k.title).replace(/"/g, "&quot;") + '"' : '') +
    '><div class="kpi"' + (k.small ? ' style="font-size:18px;line-height:1.6"' : '') + '>' + k.value +
    '<span class="label">' + k.label + '</span></div></div>').join("");

  // Stages bar
  const total = summary.total_rows || 1;
  const stages = [
    ["1. Discovered","s1"],["2. Triaged","s2"],["3. Drafted","s3"],
    ["4. Applied","s4"],["5. Assessment/OA","s4"],["6. Phone screen","s4"],
    ["7. Tech interview","s4"],["8. Onsite/Final","s4"],["9. Offer","s4"],
    ["Signed","s4"],["Rejected","sNot"],["Withdrew","sNot"],["Not pursuing","sNot"],
  ];
  const colors = {s1:"#3a4150",s2:"#fbbf24",s3:"#a3e635",s4:"#34d399",sNot:"#a3766e"};
  $("stages").innerHTML =
    '<div class="bar">' +
      stages.map(([name,cls]) => {
        const v = summary.by_stage[name] || 0;
        if (v === 0) return "";
        return '<span style="background:' + colors[cls] + ';width:' + (v / total * 100) + '%" title="' + name + ': ' + v + '"></span>';
      }).join("") +
    '</div>' +
    stages.filter(([n]) => (summary.by_stage[n]||0) > 0).map(([n,cls]) =>
      '<span class="stage-pill ' + cls + '">' + n + ' · ' + (summary.by_stage[n]||0) + '</span>'
    ).join(" ");

  // Portals bar
  const portalEntries = Object.entries(summary.by_portal).sort((a,b)=>b[1]-a[1]);
  const portalMax = Math.max(1, ...portalEntries.map(e=>e[1]));
  $("portals").innerHTML = portalEntries.map(([p,n]) =>
    '<div style="display:flex;align-items:center;gap:8px;margin:4px 0">' +
      '<div style="width:160px">' + p + '</div>' +
      '<div style="flex:1;height:10px;background:var(--border);border-radius:5px;overflow:hidden">' +
        '<div style="height:100%;width:' + (n/portalMax*100) + '%;background:var(--accent)"></div>' +
      '</div>' +
      '<div style="width:50px;text-align:right">' + n + '</div>' +
    '</div>'
  ).join("");

  // Drafted table
  function scoreClass(s){ if(s==null) return "score-low"; if(s>=85) return "score-92"; if(s>=75) return "score-80"; return "score-low"; }
  function pillVerdict(v){ if(!v) return ""; return '<span class="pill ' + v.toLowerCase() + '">' + v + '</span>'; }
  function fileChip(r){
    const items = [];
    if (r.resume_files > 0) items.push("CV");
    if (r.cover_letter_files > 0) items.push("CL");
    return items.length ? items.map(x => '<span class="pill">' + x + '</span>').join("") : '<span class="empty">none</span>';
  }
  function row(r, withFiles){
    return '<tr>' +
      '<td><a href="' + r.page_url + '" target="_blank">' + (r.application_id || "—") + '</a></td>' +
      '<td class="score ' + scoreClass(r.match_score) + '">' + (r.match_score ?? "—") + '</td>' +
      '<td>' + (r.title || "—") + '</td>' +
      '<td>' + (r.position||[]).join(", ") + '</td>' +
      '<td>' + (r.country || "—") + '</td>' +
      '<td>' + pillVerdict(r.recruiter_sim_verdict) + '</td>' +
      (withFiles ? '<td>' + fileChip(r) + '</td>' : '') +
    '</tr>';
  }
  $("tbl-drafted").innerHTML = summary.top_drafted.length
    ? summary.top_drafted.map(r => row(r, true)).join("")
    : '<tr><td colspan="7" class="empty">No Stage-3 rows yet. Run auto-draft.</td></tr>';
  $("tbl-triaged").innerHTML = summary.top_triaged_pending.length
    ? summary.top_triaged_pending.map(r => row(r, false)).join("")
    : '<tr><td colspan="6" class="empty">No Stage-2 backlog.</td></tr>';

  // Sparkline (oldest left → newest right)
  const days = Object.entries(summary.by_day_last_7).sort((a,b)=>a[0].localeCompare(b[0]));
  const sparkMax = Math.max(1, ...days.map(d=>d[1]));
  $("sparkline").innerHTML = days.map(([d,v]) =>
    '<div title="' + d + ': ' + v + '" style="height:' + Math.max(2, v/sparkMax*100) + '%"></div>'
  ).join("");
  $("sparkline-labels").innerHTML = days.map(([d,v]) =>
    '<span style="display:inline-block;width:14.28%;text-align:center">' + d.slice(5) + ' · <b>' + v + '</b></span>'
  ).join("");

  // Pace
  if (s.pace_summary) {
    const p = s.pace_summary;
    const wa = p.window_adherence || {};
    $("pace").innerHTML =
      '<div><b>Status:</b> <span class="pill ' + (p.status === "alarm" ? "reject" : p.status === "warning" ? "maybe" : "invite") + '">' + p.status.toUpperCase() + '</span></div>' +
      '<div class="meta">Today: ' + p.applied_today + ' · 7-day avg: ' + p.rolling_7_day_avg_per_day + '/day · target: ' + p.target_per_day + '/day</div>' +
      '<div class="meta">Last 7d: ' + (p.applied_last_7_days||[]).join(", ") + '</div>' +
      (wa.adherence_pct !== null && wa.adherence_pct !== undefined ?
        '<div class="meta">Window adherence: ' + wa.adherence_pct + '% on preferred/acceptable days</div>' :
        '<div class="meta">Window adherence: ' + (wa.note || "n/a") + '</div>'
      );
  } else {
    $("pace").innerHTML = '<div class="empty">pace-alarm.mjs didn\\'t emit JSON.</div>';
  }

  // Trace
  const exits = (s.wrapper_trace.exits_today || []);
  $("trace").innerHTML = exits.length
    ? '<table><thead><tr><th>Time</th><th>Routine</th><th>Exit</th><th>Contract</th></tr></thead><tbody>' +
      exits.map(e => '<tr><td>' + e.time.slice(11) + '</td><td>' + e.routine + '</td><td>' + e.exit_code + '</td><td>' + (e.contract_valid === "True" ? "✓" : "✗") + '</td></tr>').join("") +
      '</tbody></table>'
    : '<div class="empty">No wrapper-trace entries today.</div>';

  // Stale
  const stale = s.stale_portals.stale || [];
  $("stale").innerHTML = stale.length
    ? stale.map(c => '<div>⚠ <b>' + c.name + '</b> — ' + c.consecutive + ' consec failures · last: <code>' + (c.last_error||"").slice(0,80) + '</code></div>').join("")
    : '<div class="empty">No stale portals (good).</div>';

  } // end render()
})();
</script>
</body>
</html>`;
}

main().catch(err => {
  console.error("ROUTINE_ABORT:", err.message);
  process.exit(1);
});
