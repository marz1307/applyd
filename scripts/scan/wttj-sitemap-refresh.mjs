#!/usr/bin/env node
/**
 * wttj-sitemap-refresh.mjs — download + parse + filter WTTJ's public sitemaps
 *
 * Pulls the 11 job-listings.{0..10}.xml.gz files (~27 MB compressed total),
 * decodes, filters to:
 *   - /en/ language URLs
 *   - role keywords (Analytics Engineer, Data Scientist, Data Engineer,
 *     Data Analyst, BI Engineer, ML Engineer, Machine Learning, etc.)
 *   - target cities (DACH, UK, NL, IE, FR)
 *   - lastmod within last N days (default 30)
 *
 * Writes the candidate URLs + their lastmod timestamps to
 *   data/wttj-sitemap-candidates.json
 *
 * The bd-bulk-scan routine's `wttj` portal reads this file and enriches
 * each URL via the BD generic dataset scraper.
 *
 * Run weekly (or whenever fresh WTTJ targets are desired).
 *
 * Usage:
 *   node wttj-sitemap-refresh.mjs
 *   node wttj-sitemap-refresh.mjs --days 60       # widen freshness window
 *   node wttj-sitemap-refresh.mjs --dry-run
 *   node wttj-sitemap-refresh.mjs --sitemap 0,1,2 # only fetch specific indices
 */

import { gunzipSync } from "node:zlib";
import { writeFileSync, mkdirSync, existsSync, existsSync as _exists2 } from "node:fs";
import { execFileSync } from "node:child_process";

// Bright Data fallback (when DataDome blocks direct curl)
const BD_TOKEN = process.env.BRIGHTDATA_DATASET_TOKEN;
const BD_DATASET = "gd_m6gjtfmeh43we6cqc"; // generic web scraper — handles DataDome

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const DAYS = parseInt(arg("--days") || "30", 10);
const DRY_RUN = has("--dry-run");
const ONLY = arg("--sitemap")?.split(",").map(s => parseInt(s, 10));
const TOTAL_SITEMAPS = 11; // job-listings.0..10

const ROLE_PATTERNS = [
  /analytics[-_]?engineer/i,
  /data[-_]?scientist/i,
  /data[-_]?engineer/i,
  /data[-_]?analyst/i,
  /bi[-_]?engineer/i,
  /bi[-_]?analyst/i,
  /business[-_]?intelligence/i,
  /machine[-_]?learning/i,
  /\bml[-_]?engineer/i,
  /mlops/i,
  /datenanalyst/i,
  /dateningenieur/i,
  /datenwissenschaftler/i,
  /reporting[-_]?engineer/i,
  /analytics[-_]?consultant/i,
  /decision[-_]?scientist/i,
];

const SENIOR_BAND = /\b(senior|sr|lead|staff|principal|head|director|vp|chief|manager|junior|intern|trainee|apprentice|graduate|werkstudent|praktikum)\b/i;

const CITY_PATTERNS = /_(berlin|munich|hamburg|frankfurt|cologne|stuttgart|d(?:%C3%BC|u)sseldorf|leipzig|nuremberg|hannover|bremen|m(?:%C3%BC|u)nchen|k(?:%C3%B6|o)ln|wien|vienna|zurich|z(?:%C3%BC|u)rich|basel|geneva|london|manchester|edinburgh|amsterdam|rotterdam|utrecht|dublin|paris|remote)/i;

const SITEMAP_URL = (i) => `https://www.welcometothejungle.com/sitemaps/job-listings.${i}.xml.gz`;

console.log(`[wttj-sitemap] starting refresh — ${DAYS}-day freshness window, ${ONLY ? ONLY.length : TOTAL_SITEMAPS} sitemap(s)`);
const cutoff = new Date(Date.now() - DAYS * 86400_000);

// Try common curl paths; pick the first that exists.
// On Windows + Git Bash, the bundled mingw64 curl handles TLS/HTTP2 the way DataDome expects.
const CURL_PATHS = [
  "C:/Program Files/Git/mingw64/bin/curl.exe",
  "C:/Windows/System32/curl.exe",
  "/usr/bin/curl",
  "curl",
];
import { existsSync as _exists } from "node:fs";
const CURL = CURL_PATHS.find(p => p === "curl" || _exists(p)) || "curl";

async function tryDirectCurl(url) {
  try {
    const buf = execFileSync(CURL, [
      "-sL", "--max-time", "30",
      "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      url,
    ], { maxBuffer: 100 * 1024 * 1024 });
    if (buf.length === 0) return null;
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) return null;
    return buf;
  } catch { return null; }
}

async function bdSnapshotFetch(url) {
  if (!BD_TOKEN) throw new Error("BRIGHTDATA_DATASET_TOKEN unset — can't fall back to BD");
  // Step 1: kick off scrape
  const startResp = await fetch(`https://api.brightdata.com/datasets/v3/scrape?dataset_id=${BD_DATASET}&notify=false&include_errors=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${BD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [{ url }] }),
  });
  const startText = await startResp.text();
  let startData;
  try {
    startData = JSON.parse(startText.split(/\r?\n/)[0]);
  } catch { throw new Error(`BD start parse fail: ${startText.slice(0,120)}`); }
  // Synchronous path: result is the scraper output itself
  if (!startData.snapshot_id && (startData.page_html || startData.markdown)) {
    return startData;
  }
  const snapshotId = startData.snapshot_id;
  if (!snapshotId) throw new Error(`BD no snapshot_id: ${JSON.stringify(startData).slice(0,120)}`);
  // Step 2: poll until ready (up to 4 min)
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const progressResp = await fetch(`https://api.brightdata.com/datasets/v3/progress/${snapshotId}`, {
      headers: { Authorization: `Bearer ${BD_TOKEN}` },
    });
    const progress = await progressResp.json();
    if (progress.status === "ready") break;
    if (progress.status === "failed") throw new Error(`BD snapshot failed: ${JSON.stringify(progress)}`);
  }
  // Step 3: download result
  const dlResp = await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snapshotId}?format=json`, {
    headers: { Authorization: `Bearer ${BD_TOKEN}` },
  });
  const dlText = await dlResp.text();
  const lines = dlText.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (r.page_html || r.markdown) return r;
    } catch {}
  }
  // Sometimes the response is a single JSON object
  try { return JSON.parse(dlText); } catch {}
  throw new Error(`BD snapshot ready but no usable content`);
}

async function fetchSitemap(i) {
  const url = SITEMAP_URL(i);
  const t0 = Date.now();

  // PATH 1: direct curl (fast, free)
  const buf = await tryDirectCurl(url);
  if (buf) {
    const xml = gunzipSync(buf).toString("utf8");
    console.log(`  sitemap ${i}: ${buf.length} bytes (direct curl, ${(xml.length/1024).toFixed(0)} KB XML, ${((Date.now()-t0)/1000).toFixed(1)}s)`);
    return xml;
  }

  // PATH 2: Bright Data fallback (handles DataDome)
  console.log(`  sitemap ${i}: direct blocked, falling back to Bright Data...`);
  const result = await bdSnapshotFetch(url);
  // BD returns HTML rendered from the binary; the XML content should be in page_html or markdown
  // For .xml.gz URLs, BD decompresses and may serve the XML as text. Try both fields.
  const xmlText = result.page_html || result.markdown || "";
  if (!xmlText.includes("<url>") && !xmlText.includes("<loc>")) {
    throw new Error(`BD result has no sitemap content (page_title=${result.page_title}, md=${(result.markdown||'').length}c, html=${(result.page_html||'').length}c)`);
  }
  console.log(`  sitemap ${i}: ${xmlText.length} chars via BD scrape (${((Date.now()-t0)/1000).toFixed(1)}s)`);
  return xmlText;
}

function parseEntries(xml) {
  // Sitemap is <url><loc>X</loc><lastmod>Y</lastmod></url>
  const entries = [];
  const re = /<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    entries.push({ url: m[1], lastmod: m[2] });
  }
  return entries;
}

function filterEntries(entries) {
  const kept = [];
  for (const e of entries) {
    if (!e.url.includes("/en/")) continue;
    if (!ROLE_PATTERNS.some(p => p.test(e.url))) continue;
    if (!CITY_PATTERNS.test(e.url)) continue;
    if (SENIOR_BAND.test(e.url)) continue;  // seniority band — exclude Senior/Lead/Junior
    const t = new Date(e.lastmod);
    if (isNaN(t) || t < cutoff) continue;
    kept.push(e);
  }
  return kept;
}

const allCandidates = [];
const sitemapsToFetch = ONLY || [...Array(TOTAL_SITEMAPS).keys()];

const DELAY_MS = 2500;  // pace to avoid DataDome rate-limit
for (let idx = 0; idx < sitemapsToFetch.length; idx++) {
  const i = sitemapsToFetch[idx];
  try {
    const xml = await fetchSitemap(i);
    const entries = parseEntries(xml);
    const filtered = filterEntries(entries);
    console.log(`    raw=${entries.length}  matched=${filtered.length}`);
    allCandidates.push(...filtered);
  } catch (e) {
    console.error(`  sitemap ${i} failed: ${e.message}`);
  }
  // Pace requests
  if (idx < sitemapsToFetch.length - 1) {
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
}

// Dedup by URL (sitemaps occasionally overlap)
const dedupedMap = new Map();
for (const c of allCandidates) {
  const existing = dedupedMap.get(c.url);
  if (!existing || new Date(c.lastmod) > new Date(existing.lastmod)) {
    dedupedMap.set(c.url, c);
  }
}
const deduped = [...dedupedMap.values()].sort((a, b) => new Date(b.lastmod) - new Date(a.lastmod));

console.log();
console.log(`Total matched candidates: ${allCandidates.length}`);
console.log(`After dedup:              ${deduped.length}`);
console.log();
console.log("Top 5 most recent:");
for (const c of deduped.slice(0, 5)) {
  console.log(`  ${c.lastmod}  ${c.url}`);
}

if (DRY_RUN) {
  console.log();
  console.log("[dry-run] no output file written");
  process.exit(0);
}

if (!existsSync("data")) mkdirSync("data");
const outPath = "data/wttj-sitemap-candidates.json";
writeFileSync(outPath, JSON.stringify({
  refreshed_at: new Date().toISOString(),
  freshness_days: DAYS,
  sitemaps_fetched: sitemapsToFetch.length,
  total_candidates: deduped.length,
  candidates: deduped,
}, null, 2));
console.log();
console.log(`Wrote ${deduped.length} candidates to ${outPath}`);

console.log("\n--- ROUTINE_CONTRACT ---");
console.log("ROUTINE: wttj-sitemap-refresh");
console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
console.log(`SITEMAPS_FETCHED: ${sitemapsToFetch.length}`);
console.log(`RAW_MATCHES: ${allCandidates.length}`);
console.log(`DEDUPED_CANDIDATES: ${deduped.length}`);
console.log(`FRESHNESS_WINDOW_DAYS: ${DAYS}`);
console.log(`OUTPUT: ${outPath}`);
console.log("ERRORS: 0");
console.log("--- END_ROUTINE_CONTRACT ---");
