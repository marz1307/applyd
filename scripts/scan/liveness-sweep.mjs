#!/usr/bin/env node
/**
 * liveness-sweep.mjs — retire dead postings from the open pipeline.
 *
 * Scans every Notion row in the target stages, classifies each job URL through
 * the shared `liveness-core` semantics, and (with --apply) moves hard-signal
 * dead rows to `Withdrew` with an audit note.
 *
 * ENGINE CHOICE MATTERS. Default is Firecrawl, not Playwright, and that is a
 * conclusion earned in a real sweep, not a preference:
 *
 *   headless Playwright   181 rows / ~60 min → 21 dead, and it MISSED 4 eFC
 *                         postings returning HTTP 410 because eFinancialCareers
 *                         bot-walls headless fetchers before the status is seen.
 *                         147 rows (81%) came back `no_apply_control`.
 *   Firecrawl             160 rows / ~20 min → found those 4, and rendered 154
 *                         of the "unreadable" rows as full 15-40k-char adverts,
 *                         proving they were alive all along.
 *
 * Firecrawl is faster AND more accurate here. Playwright's one advantage is
 * that it sees a live DOM and so can detect a visible apply control; Firecrawl
 * returns text, so a healthy page lands on `no_apply_control`. That costs
 * nothing, because `no_apply_control` is not withdrawable either way.
 *
 * SAFETY
 *   - Dry-run unless --apply.
 *   - Only `WITHDRAWABLE_CODES` move a row. See liveness-core for why
 *     insufficient_content and no_apply_control are excluded.
 *   - Stage 4+ is refused outright: those applications were already submitted
 *     and a dead advert says nothing about a live application.
 *
 * WHEN NO FETCHER CAN SEE THE PORTAL. eFinancialCareers serves a 194-byte
 * "Scheduled Maintenance" shell to Firecrawl, to curl with a browser UA, and to
 * a clean browser profile — but renders normally in a logged-in browser. That
 * is a session gate, not an outage, and no headless engine can get past it.
 * `--from-verdicts` exists for that case: adjudicate the rows by hand in a
 * real browser, then feed the verdicts back through this script so the stage
 * scope, the withdrawable gate and the audit note stay in ONE place instead of
 * being re-implemented in a throwaway script every time a portal walls us.
 *
 * Verdict file: [{ "application_id": "APP-1", "code": "http_gone", "http": 410,
 *                  "reason": "browser-verified 410" }]
 *
 * Usage:
 *   node scripts/scan/liveness-sweep.mjs                        # dry run, stages 2+3, firecrawl
 *   node scripts/scan/liveness-sweep.mjs --apply
 *   node scripts/scan/liveness-sweep.mjs --engine playwright    # when Firecrawl is down
 *   node scripts/scan/liveness-sweep.mjs --stages "3. Drafted" --limit 20
 *   node scripts/scan/liveness-sweep.mjs --from-verdicts data/.efc-verdicts.json --apply
 *   node scripts/scan/liveness-sweep.mjs --json
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyLiveness, WITHDRAWABLE_CODES, isWithdrawable } from "./liveness-core.mjs";
import { fetchWithRetry } from "../net-retry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// scripts/scan/ -> scripts/notion/notion-query.mjs
const NOTION_QUERY = path.resolve(HERE, "..", "notion", "notion-query.mjs");

const args = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};

const APPLY = args.includes("--apply");
const JSON_OUT = args.includes("--json");
const ENGINE = argOf("--engine", "firecrawl");
const LIMIT = argOf("--limit") ? parseInt(argOf("--limit"), 10) : null;
const STAGES = argOf("--stages", "2. Triaged,3. Drafted").split(",").map((s) => s.trim());
const CONCURRENCY = parseInt(argOf("--concurrency", "3"), 10);
const FROM_VERDICTS = argOf("--from-verdicts");

const FIRECRAWL = process.env.FIRECRAWL_API_URL || "http://localhost:3002";
const NOTION = "https://api.notion.com/v1";
const SENTINEL = "[liveness]";
const MAX_RICH_TEXT = 1900; // Notion caps a rich_text chunk at 2000

// A submitted application is not invalidated by its advert coming down, and
// re-stating an outcome the recruiter already owns would corrupt the funnel.
const FORBIDDEN = /^(4\.|5\.|6\.|7\.|8\.|9\.|Signed|Rejected|Withdrew)/;
const blocked = STAGES.filter((s) => FORBIDDEN.test(s));
if (blocked.length) {
  console.error(`ERROR: refusing to sweep ${blocked.join(", ")} — Stage 4+ and terminals are out of scope.`);
  process.exit(2);
}

function log(...a) { if (!JSON_OUT) console.log(...a); }

function notionRows() {
  const out = execFileSync("node", [NOTION_QUERY, "--json"], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/* ---------------------------------------------------------------- engines */

async function firecrawlOnce(url, waitFor) {
  const r = await fetchWithRetry(`${FIRECRAWL}/v1/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // onlyMainContent: this repo has been bitten before by portal chrome
    // (related-jobs footers) being read as page content. Main content only
    // stops a neighbouring advert's "no longer accepting" from faking a death.
    body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, waitFor, timeout: 60000 }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`firecrawl HTTP ${r.status}: ${text.slice(0, 160)}`);
  const body = JSON.parse(text);
  return {
    markdown: body?.data?.markdown || "",
    status: body?.data?.metadata?.statusCode ?? 0,
    finalUrl: body?.data?.metadata?.sourceURL || url,
  };
}

async function viaFirecrawl(url) {
  let page = await firecrawlOnce(url, 4000);
  // A 202, or a body too short to classify, usually means Firecrawl returned
  // before the page settled — not that the page is empty. Two WTTJ rows looked
  // dead at 250 chars and came back at ~9k with a longer wait. Retry before
  // letting `insufficient_content` be recorded against the posting.
  if (page.status === 202 || page.markdown.trim().length < 1000) {
    page = await firecrawlOnce(url, 15000);
  }
  const out = classifyLiveness({
    status: page.status, finalUrl: page.finalUrl, bodyText: page.markdown, applyControls: [],
  });
  return { ...out, http: page.status, chars: page.markdown.trim().length };
}

async function withPlaywright(urls, onResult) {
  const { chromium } = await import("playwright");
  const { checkUrlLiveness } = await import(pathToFileURL(path.join(HERE, "liveness-browser.mjs")).href);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    // Sequential by project rule: never drive Playwright in parallel.
    for (const row of urls) {
      let out;
      try { out = await checkUrlLiveness(page, row.job_url); }
      catch (err) { out = { result: "uncertain", code: "sweep_error", reason: err.message.slice(0, 200) }; }
      await onResult(row, { ...out, http: 0, chars: 0 });
    }
  } finally {
    await browser.close();
  }
}

async function withFirecrawl(rows, onResult) {
  const ping = await fetch(`${FIRECRAWL}/`).catch(() => null);
  if (!ping?.ok) {
    throw new Error(
      `Firecrawl unreachable at ${FIRECRAWL}. Start it with:\n` +
      `  docker start firecrawl-api-1 firecrawl-playwright-service-1 firecrawl-redis-1 firecrawl-rabbitmq-1 firecrawl-nuq-postgres-1\n` +
      `Docker Desktop only runs while you are signed in. Or re-run with --engine playwright.`
    );
  }
  const iter = rows[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (const row of iter) {
        let out;
        try { out = await viaFirecrawl(row.job_url); }
        catch (err) { out = { result: "uncertain", code: "sweep_error", reason: err.message.slice(0, 200), http: 0, chars: 0 }; }
        await onResult(row, out);
      }
    })
  );
}

/* ----------------------------------------------------------- notion write */

function notionHeaders() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN not set");
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  };
}

async function setStage(headers, id, stage) {
  const res = await fetchWithRetry(`${NOTION}/pages/${id}`, {
    method: "PATCH", headers,
    body: JSON.stringify({ properties: { Stage: { select: { name: stage } } } }),
  });
  if (!res.ok) throw new Error(`stage ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

/**
 * Audit trail. Prefers a real comment; falls back to Fit notes when the
 * integration lacks the "Insert comments" capability (403 restricted_resource).
 */
async function writeNote(headers, row, verdict, today) {
  const line = `${SENTINEL} no longer live — ${verdict.code}${verdict.http ? ` HTTP ${verdict.http}` : ""} (${today})`;

  const cmt = await fetchWithRetry(`${NOTION}/comments`, {
    method: "POST", headers,
    body: JSON.stringify({
      parent: { page_id: row.id },
      rich_text: [{ text: { content: `no longer live\n\n${line}\n${row.job_url}` } }],
    }),
  }).catch(() => null);
  if (cmt?.ok) return "comment";

  const prior = row.fit_notes || "";
  if (prior.includes(SENTINEL)) return "already-noted";
  // Trim the OLD text, never the new line, so the reason always survives.
  const room = MAX_RICH_TEXT - line.length - 1;
  const merged = prior ? `${prior.slice(0, room)}\n${line}` : line;

  const res = await fetchWithRetry(`${NOTION}/pages/${row.id}`, {
    method: "PATCH", headers,
    body: JSON.stringify({ properties: { "Fit notes": { rich_text: [{ text: { content: merged } }] } } }),
  });
  if (!res.ok) throw new Error(`note ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return "fit-notes";
}

/* ------------------------------------------------------------------- main */

const rows = notionRows();
const target = new Set(STAGES);
let queue = rows.filter((r) => target.has(r.stage) && r.job_url);
const noUrl = rows.filter((r) => target.has(r.stage) && !r.job_url);
if (LIMIT) queue = queue.slice(0, LIMIT);

const MODE_LABEL = FROM_VERDICTS ? `verdicts:${path.basename(FROM_VERDICTS)}` : ENGINE;
log(`engine ${MODE_LABEL}  |  stages ${STAGES.join(" + ")}  |  ${queue.length} rows${noUrl.length ? ` (+${noUrl.length} with no URL, skipped)` : ""}`);
log(APPLY ? "MODE: APPLY\n" : "MODE: DRY RUN — pass --apply to write\n");

const results = [];
let seen = 0;
const onResult = async (row, verdict) => {
  seen++;
  results.push({
    application_id: row.application_id, id: row.id, title: row.title,
    position: (row.position || []).join("/"), stage: row.stage, job_url: row.job_url,
    fit_notes: row.fit_notes, ...verdict,
  });
  log(`${String(seen).padStart(4)}/${queue.length} ${String(verdict.http || "").padStart(3)} ${verdict.code.padEnd(22)} ${row.application_id} ${row.title}`);
};

/**
 * Replay hand-adjudicated verdicts instead of fetching.
 *
 * Every guard still applies: a verdict for a row outside the stage scope, or
 * for an unknown application_id, is refused rather than trusted. The point is
 * to reuse the write path, not to bypass it.
 */
async function fromVerdicts(rowsInScope, onResult) {
  const verdicts = JSON.parse(readFileSync(FROM_VERDICTS, "utf8"));
  const byId = new Map(rowsInScope.map((r) => [r.application_id, r]));
  const rejected = [];
  for (const v of verdicts) {
    const row = byId.get(v.application_id);
    if (!row) { rejected.push(`${v.application_id}: not in ${STAGES.join("+")}`); continue; }
    await onResult(row, {
      result: isWithdrawable(v.code) ? "expired" : "uncertain",
      code: v.code,
      reason: v.reason || "supplied verdict",
      http: v.http || 0,
      chars: v.chars || 0,
    });
  }
  if (rejected.length) {
    log(`\n  REFUSED ${rejected.length} verdict(s) for rows outside scope:`);
    rejected.forEach((r) => log(`    ${r}`));
  }
}

if (FROM_VERDICTS) await fromVerdicts(queue, onResult);
else if (ENGINE === "playwright") await withPlaywright(queue, onResult);
else await withFirecrawl(queue, onResult);

const dead = results.filter((r) => isWithdrawable(r.code));
const held = results.filter((r) => !isWithdrawable(r.code));

log("\n--- WITHDRAWABLE ---");
dead.forEach((r) => log(`  ${r.stage.padEnd(11)} ${r.application_id.padEnd(9)} ${r.code.padEnd(14)} ${r.title} — ${r.position}`));
if (!dead.length) log("  (none)");

const heldBy = {};
held.forEach((r) => (heldBy[r.code] = (heldBy[r.code] || 0) + 1));
log("\n--- HELD BACK (not withdrawable) ---");
Object.entries(heldBy).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => log(`  ${String(v).padStart(4)}  ${k}`));

let staged = 0, notedOk = 0, stageFail = 0, noteFail = 0;
if (APPLY && dead.length) {
  const headers = notionHeaders();
  const today = new Date().toISOString().slice(0, 10);
  log("");
  for (const r of dead) {
    try { await setStage(headers, r.id, "Withdrew"); staged++; }
    catch (err) { stageFail++; log(`  STAGE FAILED ${r.application_id}: ${err.message}`); continue; }
    await new Promise((s) => setTimeout(s, 350));
    // Note failure is reported separately and never masks a successful stage
    // write — conflating them once reported WITHDRAWN: 0 for 21 moved rows.
    try { await writeNote(headers, r, r, today); notedOk++; }
    catch (err) { noteFail++; log(`  NOTE FAILED ${r.application_id}: ${err.message}`); }
    await new Promise((s) => setTimeout(s, 350));
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    engine: MODE_LABEL, stages: STAGES, scanned: results.length,
    withdrawable: dead.map(({ fit_notes, ...r }) => r), held_back: heldBy,
    // The held-back rows themselves, not just a tally. A count cannot be acted
    // on: `insufficient_content` means "no fetcher could read this", which is
    // the exact set that needs hand-adjudication in a real browser and then
    // feeding back through --from-verdicts. Reporting only the number left that
    // set unidentifiable, so "go deep" had nowhere to start.
    held_rows: held.map(({ fit_notes, ...r }) => r),
    applied: APPLY, staged, noted: notedOk, stage_failed: stageFail, note_failed: noteFail,
  }, null, 2));
} else {
  console.log("\n--- LIVENESS_SWEEP_CONTRACT ---");
  console.log(`ENGINE: ${MODE_LABEL}`);
  console.log(`SCANNED: ${results.length}`);
  console.log(`WITHDRAWABLE: ${dead.length}`);
  console.log(`HELD_BACK: ${held.length}`);
  console.log(`STAGE_WRITTEN: ${staged}`);
  console.log(`NOTE_WRITTEN: ${notedOk}`);
  console.log(`STAGE_FAILED: ${stageFail}`);
  console.log(`NOTE_FAILED: ${noteFail}`);
  console.log(`MODE: ${APPLY ? "apply" : "dry-run"}`);
  console.log(`WITHDRAWABLE_CODES: ${WITHDRAWABLE_CODES.join(",")}`);
  console.log("--- END ---");
}

process.exit(stageFail > 0 ? 1 : 0);
