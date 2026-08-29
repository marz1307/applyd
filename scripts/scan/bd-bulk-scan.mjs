#!/usr/bin/env node
/**
 * bd-bulk-scan.mjs — Bright Data Dataset Scraper bulk scrape
 *
 * Sole high-volume scraper as of 2026-05-28 (apify-bulk-scan retired).
 * Uses the generic Bright Data dataset scraper (gd_m6gjtfmeh43we6cqc)
 * to pull job listings from the non-auth portals directly, plus a
 * two-stage SERP→enrich path for LinkedIn (gd_lpfll7v5hcqtkxl6l) and
 * WTTJ. Portals:
 *
 *   - Stepstone DE          (BD — best yield, 25 jobs per page)
 *   - Xing                  (Firecrawl — DACH-native, JS SPA)
 *   - CareerBee             (Firecrawl — DE expat-friendly, JS SPA)
 *   - Arbeitnow             (BD — full board, also has own API)
 *
 * Dropped 2026-06-05:
 *   - Indeed                (aggressive bot-blocking, low signal)
 *   - Make-it-in-Germany    (perfdrive.com CAPTCHA shield, unscrapable)
 *
 * Auth: BRIGHTDATA_DATASET_TOKEN env var (UUID-style).
 *
 * Output contract emitted as `--- ROUTINE_CONTRACT ---` block.
 *
 * Usage:
 *   node bd-bulk-scan.mjs                          # full run
 *   node bd-bulk-scan.mjs --dry-run                # show URL plan, no API call
 *   node bd-bulk-scan.mjs --portal stepstone       # one portal only
 *   node bd-bulk-scan.mjs --pages 5                # cap pages per query (default 2 since 2026-05-29 cost cut)
 *   node bd-bulk-scan.mjs --max-batch 30           # URLs per BD API call (default 25)
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync, execFileSync, spawn } from "node:child_process";
import yaml from "js-yaml";
import { loadTaxonomy, deriveQueries, deriveTitleFilter, matchNegative, translateRole } from "./role-taxonomy.mjs";
import { windowHours, withRecency, partitionByFreshness, writeWatermark, readWatermark } from "./scan-freshness.mjs";
import { fetchWithRetry } from "../net-retry.mjs";
import { createStage1Row, resolveCountry, inferPosition } from "../notion/notion-stage1.mjs";
// canonicalUrl + the seen-ledger moved here 2026-08-12 so chrome-scan-visible
// shares one dedup key. Do NOT reimplement canonicalUrl locally — a divergent
// copy fails silently (0 duplicates reported while re-adding everything).
import { canonicalUrl, loadSeen, saveSeen, SEEN_PATH } from "../seen-ledger.mjs";

// ─── Firecrawl (self-hosted, no API key) ─────────────────────────────────
// Firecrawl is expected to run locally at http://localhost:3002 (Docker compose).
// NO API key required — pass empty Authorization. Override via env if the
// daemon is moved. Used for Xing because BD's generic scraper returns the
// unhydrated React shell (0 job URLs). Firecrawl waits for JS render.
const FIRECRAWL_URL = process.env.FIRECRAWL_API_URL || "http://localhost:3002";
const FIRECRAWL_WAIT_MS = 5000;

async function firecrawlPing() {
  try {
    const r = await fetch(FIRECRAWL_URL + "/", { method: "GET" });
    return r.ok || r.status === 404;  // 404 acceptable — root may not be served, but daemon is up
  } catch { return false; }
}

// Self-heal (added 2026-07-03): scheduled runs found firecrawl down on EVERY
// run for weeks — Xing + CareerBee were silently skipped. Containers now carry
// restart=unless-stopped, but if the scan fires before Docker has brought them
// up, try `docker start` and re-ping before giving up.
//
// 2026-08-09 — the ENGINE case, which the original note called "harmless" and
// then skipped. It is the common case, not the edge case. Every CareerOps task
// runs S4U ("whether user is logged on or not"), but Docker Desktop starts
// from the HKCU Run key, i.e. only at interactive sign-in. So a scan firing
// while the operator is signed out finds no Docker daemon at all, and `docker start`
// cannot help because there is nothing for it to talk to. Observed 2026-08-09:
// host booted 23:27, Docker Desktop started 00:20:17 at sign-in.
//
// So escalate: containers → engine → give up loudly. Note that on Windows the
// engine lives in a WSL2 VM that needs a user session, so the escalation can
// still fail when nobody is signed in. That is why the give-up path now emits
// a machine-greppable marker for the watchdog (see system-eval.mjs) instead of
// disappearing into a log nobody reads.
const FIRECRAWL_CONTAINERS = "firecrawl-api-1 firecrawl-playwright-service-1 firecrawl-redis-1 firecrawl-rabbitmq-1 firecrawl-nuq-postgres-1";
const DOCKER_DESKTOP_EXE = process.env.DOCKER_DESKTOP_EXE
  || "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";

function dockerEngineUp() {
  try { execSync("docker info", { stdio: "pipe", timeout: 20_000 }); return true; }
  catch { return false; }
}

// Launch Docker Desktop and wait for the engine to answer. Returns false fast
// when there is no session to launch into, rather than blocking the whole scan.
async function startDockerEngine(maxWaitMs = 180_000) {
  if (dockerEngineUp()) return true;
  console.error("  firecrawl: docker engine is DOWN — attempting to start Docker Desktop");
  if (!existsSync(DOCKER_DESKTOP_EXE)) {
    console.error(`  firecrawl: Docker Desktop not found at ${DOCKER_DESKTOP_EXE}`);
    return false;
  }
  try {
    // Detached; Docker Desktop brings the engine up itself when its AutoStart
    // preference is enabled (settings-store.json → AutoStart: true).
    spawn(DOCKER_DESKTOP_EXE, [], { detached: true, stdio: "ignore" }).unref();
  } catch (e) {
    console.error(`  firecrawl: could not launch Docker Desktop (${String(e.message).slice(0, 120)})`);
    return false;
  }
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000));
    if (dockerEngineUp()) {
      console.error("  firecrawl: docker engine came up");
      return true;
    }
  }
  console.error(`  firecrawl: docker engine did not come up within ${Math.round(maxWaitMs / 1000)}s`);
  return false;
}

async function firecrawlPingWithRecovery() {
  if (await firecrawlPing()) return true;
  console.error(`  firecrawl: ping failed — attempting recovery (${FIRECRAWL_URL})`);

  // Step 1: engine. Without it, step 2 cannot possibly work.
  if (!dockerEngineUp() && !(await startDockerEngine())) {
    console.error("  firecrawl: FIRECRAWL_ENGINE_DOWN — no docker engine (likely signed out; Docker Desktop is sign-in-scoped)");
    return false;
  }

  // Step 2: containers. restart=unless-stopped usually handles this once the
  // engine is up, but an explicit start removes the race.
  try {
    execSync(`docker start ${FIRECRAWL_CONTAINERS}`, { stdio: "pipe", timeout: 60_000 });
  } catch (e) {
    console.error(`  firecrawl: docker start failed (${String(e.message).slice(0, 120)})`);
    return false;
  }
  // Give the API a moment to bind, then re-ping a few times.
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    if (await firecrawlPing()) { console.error("  firecrawl: recovered via docker start"); return true; }
  }
  return false;
}

// Returns same shape as bdFetch: [{input:{url}, markdown, page_html, error?}].
// Uses the firecrawl CLI for parity with the one-off script that proved
// reliable. Sequential because Xing rate-limits; ~5s wait_for per URL.
function firecrawlFetch(urls) {
  const out = [];
  if (!existsSync("data/.tmp/fc-cache")) mkdirSync("data/.tmp/fc-cache", { recursive: true });
  for (const url of urls) {
    const safe = url.replace(/[^a-z0-9]/gi, "_").slice(-80);
    const outPath = `data/.tmp/fc-cache/${safe}.md`;
    try {
      execFileSync("firecrawl", ["scrape", url, "--wait-for", String(FIRECRAWL_WAIT_MS), "--only-main-content", "-o", outPath], {
        stdio: ["ignore", "ignore", "pipe"], timeout: 90_000,
        env: { ...process.env, FIRECRAWL_API_URL: FIRECRAWL_URL },
      });
      out.push({ input: { url }, markdown: readFileSync(outPath, "utf8"), page_html: "" });
    } catch (e) {
      out.push({ input: { url }, markdown: "", page_html: "", error: String(e.stderr || e.message).slice(0, 200) });
    }
  }
  return out;
}

// Parse a Xing job DETAIL page's HTML for the REAL company + title. Xing exposes
// stable data-testid anchors on every employer's posting (verified 2026-07-13):
//   job-details-title             → the <h1> holds the true role title
//   job-details-company-info-name → text is the true company (incl. the staffing
//                                    agency behind a syndicated multi-city posting)
// Employer-agnostic; hoisted so --self-test can exercise it. Returns {title,company}
// with nulls when an anchor is absent.
function parseXingDetail(html) {
  const h = html || "";
  // Strip HTML with a loop-until-stable pass so nested/split tag attacks
  // (e.g. "<sc<script>ript>") fully unwind before entity decoding, and decode
  // "&amp;" LAST so an "&amp;#x27;" payload cannot double-decode to "'".
  const clean = (s) => {
    if (!s) return "";
    let t = s, prev;
    do { prev = t; t = t.replace(/<[^>]+>/g, " "); } while (t !== prev);
    return t.replace(/&#x27;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  };
  const title = clean((h.match(/data-testid="job-details-title"[\s\S]{0,400}?<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
  const company = clean((h.match(/data-testid="job-details-company-info-name"[^>]*>([\s\S]*?)<\/(?:p|span|a|div)>/i) || [])[1]);
  return { title: title || null, company: company || null };
}

// Fetch + parse a single Xing detail page via self-hosted Firecrawl (raw HTML).
// Returns { company, title } or null on any failure — the caller then keeps the
// slug-derived values, so enrichment never drops a job.
function enrichXingDetail(url) {
  const safe = url.replace(/[^a-z0-9]/gi, "_").slice(-80);
  const outPath = `data/.tmp/fc-cache/xd_${safe}.html`;
  try {
    execFileSync("firecrawl", ["scrape", url, "--html", "--wait-for", String(FIRECRAWL_WAIT_MS), "-o", outPath], {
      stdio: ["ignore", "ignore", "pipe"], timeout: 90_000,
      env: { ...process.env, FIRECRAWL_API_URL: FIRECRAWL_URL },
    });
    const parsed = parseXingDetail(readFileSync(outPath, "utf8"));
    return (parsed.company || parsed.title) ? parsed : null;
  } catch { return null; }
}

// ─── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i+1] : null; };
const has = (n) => args.includes(n);
const DRY_RUN = has("--dry-run");
const ONLY_PORTAL = arg("--portal");
// --probe: extraction HEALTH check. Runs the full scrape+parse pipeline but
// writes nothing to Notion and does NOT preload the seen-cache, so cross-run
// dedup can't mask a portal that is actually extracting. Implies --no-write.
const NO_WRITE = has("--no-write") || has("--probe");
const NO_SEEN  = has("--probe");
// Default 2 since 2026-05-29 — pages 1-2 capture ~80% of fresh listings;
// pages 3-5 were mostly re-scrapes of jobs already in seen-cache (e.g.,
// 2026-05-28 run: 578 URLs at PAGES=5 yielded 2 net-new jobs after dedup).
// Pass --pages 5 to restore the old depth when validating filter changes.
const PAGES = parseInt(arg("--pages") || "2", 10);
const MAX_BATCH = parseInt(arg("--max-batch") || "25", 10);
const JSON_OUT = has("--json");

// Freshness (2026-08-02): scan only what was posted since the last successful
// run. Google-SERP portals get the window as a query operator (no fetch cost
// for stale results); the rest are filtered on the posted-date they return.
// Postings with no readable date are KEPT — see scan-freshness.mjs.
//   --no-freshness   full historical scan (backfills, portal debugging)
//   --window-hours N override the watermark-derived window
const NO_FRESHNESS = has("--no-freshness");
const RUN_STARTED_ISO = new Date().toISOString();
const WINDOW_HOURS = NO_FRESHNESS
  ? null
  : (arg("--window-hours") ? Math.max(1, parseInt(arg("--window-hours"), 10)) : windowHours(RUN_STARTED_ISO));

// --self-test: regression guard for the three extraction bugs fixed 2026-07-06
// (canonicalUrl query-string job-id, Civil-Service umbrella collapse, SERP-markdown
// shape). Runs before any env/network dependency so CI can call it token-free.
// NOTE: selfTest() is invoked AFTER the PORTALS object is defined (see below the
// PORTALS block), so its assertions can call the real portal extractors. The env
// checks are made to skip under --self-test so this stays token-free for CI.
function selfTest() {
  const A = [];
  const ok = (cond, label) => A.push({ label, pass: !!cond });

  // Bug 1 — canonicalUrl must keep distinct query-string job ids (jcode/jk), which
  // was stripping the whole query and collapsing every vacancy to one base path.
  const csA = "https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=1";
  const csB = "https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=2";
  ok(canonicalUrl(csA) !== canonicalUrl(csB), "canonicalUrl keeps distinct jcode");
  ok(canonicalUrl("https://de.indeed.com/viewjob?jk=aaa111") !== canonicalUrl("https://de.indeed.com/viewjob?jk=bbb222"), "canonicalUrl keeps distinct jk");
  ok(canonicalUrl("https://x/jobs.cgi?jcode=9&ved=abc") === canonicalUrl("https://x/jobs.cgi?jcode=9&utm=z"), "canonicalUrl ignores non-id params");

  // City scoping (2026-08-14) — `city:` must reach eFC and NOT silently narrow
  // Stepstone/Xing, which is what made the first cut of this feature cost +10
  // URLs a run for no measured gain.
  const qCity = { role: "Data Analyst", country: "Germany", city: "Frankfurt" };
  ok(cityFor(qCity, "efc") === "Frankfurt", "cityFor: efc honours city by default");
  ok(cityFor(qCity, "xing") === null, "cityFor: xing ignores city by default");
  ok(cityFor(qCity, "stepstone") === null, "cityFor: stepstone ignores city by default");
  ok(cityFor({ ...qCity, city_portals: ["efc", "xing"] }, "xing") === "Frankfurt", "cityFor: city_portals widens scope");
  ok(cityFor({ role: "X", country: "Germany" }, "efc") === null, "cityFor: no city → null");

  // German query variants (2026-08-18). These assertions are written against the
  // LIVE config, so they also fail loudly if someone disables the feature or
  // drops the German names out of role-taxonomy.yml without meaning to.
  const qDE = { role: "Data Analyst", country: "Germany" };
  const qUK = { role: "Data Analyst", country: "United Kingdom" };
  if (DE_VARIANTS_ON) {
    ok(rolesFor(qDE, "xing").includes("Datenanalyst"), "rolesFor: xing/Germany gains the German term");
    ok(rolesFor(qDE, "stepstone").includes("Datenanalyst"), "rolesFor: stepstone/Germany gains the German term");
    // eFC was measured on 2026-08-18 and dropped: its vector search returns a
    // thin off-target page for German terms (dateningenieur/in-berlin gave 9
    // cards vs 45-48 for English) and produced zero net-new rows. This asserts
    // the REMOVAL so a future config edit that re-adds it fails loudly here
    // rather than quietly restoring a measured-dead query set.
    ok(rolesFor(qDE, "efc").length === 1, "rolesFor: efc stays English-only (measured dead 2026-08-18)");
    // The whole point of scoping: non-DACH markets and non-DACH boards must be
    // untouched, or this silently doubles the bill on portals it cannot help.
    ok(rolesFor(qUK, "xing").length === 1, "rolesFor: UK market stays English-only");
    ok(rolesFor(qDE, "linkedin").length === 1, "rolesFor: linkedin stays English-only");
    // AE has no German posting title; inventing one would spend fetches on a
    // string no employer writes.
    ok(rolesFor({ role: "Analytics Engineer", country: "Germany" }, "xing").length === 1,
       "rolesFor: Analytics Engineer has no German variant");
    // English role always leads, so an English-only portal behaves identically.
    ok(rolesFor(qDE, "xing")[0] === "Data Analyst", "rolesFor: English role stays first");
  } else {
    ok(rolesFor(qDE, "xing").length === 1, "rolesFor: disabled → English-only");
  }
  // An out-of-scope portal must emit exactly what it emits for the plain
  // country query, so plan()'s dedupe can collapse it to zero added cost.
  ok(
    JSON.stringify(PORTALS.xing.urls("Data Analyst", "Germany", 2, null))
      === JSON.stringify(PORTALS.xing.urls("Data Analyst", "Germany", 2)),
    "xing city-null path is byte-identical to the country-only path"
  );

  // Employer-site SERP portal (2026-08-15). The failure this guards against is
  // silent misattribution: every row it emits names a real tracked employer, so
  // a loose URL pattern would file someone else's job — or a blog post — under
  // that company rather than merely dropping it.
  const empGermany = PORTALS.employers.urls("Data Engineer", "Germany", 1);
  ok(empGermany.length === 2, "employers: 7 German boards chunk into 2 grouped SERP queries");
  ok(empGermany.every(u => u.startsWith("https://www.google.com/search")),
     "employers: emits Google URLs so plan() routes them to the SERP zone");
  // Read q via searchParams, not decodeURIComponent: URLSearchParams encodes a
  // space as "+", which decodeURIComponent leaves as a literal plus.
  ok(empGermany.every(u => (new URL(u).searchParams.get("q") || "").includes(" OR site:")),
     "employers: domains are OR-ed into one query, not one query per company");
  ok(PORTALS.employers.urls("Data Engineer", "Ireland", 2).length === 0,
     "employers: a country with no tracked board costs zero fetches");
  // Attribution is by URL, never by SERP title.
  const empJobs = PORTALS.employers.extract(
    '[Data Engineer (All genders)](https://jobs.zalando.com/en/jobs/2724318-Data-Engineer-(All-genders))\n' +
    '[Claims Data Scientist in London at Munich Re](https://careers.munichre.com/en/job/london/claims-data-scientist/3342/41711207168)\n' +
    '[Lead Data Engineer @ Klarna](https://jobs.deel.com/klarna/job-details/846a362f-2e03-4054-91cb-bf8ee87d3f34/overview)\n' +
    '[How we work at data.works - Meet Sven](https://www.otto.de/jobs/en/blogs/techblog/how-we-work-at-data-works-meet-sven/)\n' +
    '[Data Engineer at Some Other Firm](https://www.stepstone.de/stellenangebote--Data-Engineer--123456-inline.html)',
    "", "", "Data Engineer", "Germany");
  ok(empJobs.length === 3, "employers: extracts the 3 real job pages, drops the blog post and the foreign domain");
  ok(empJobs.every(j => j.company && j.title), "employers: every row carries a company and a title");
  const zal = empJobs.find(j => j.company === "Zalando");
  ok(zal && zal.title === "Data Engineer (All genders)", "employers: Zalando title survives intact");
  // Zalando URLs carry literal parens; a `[^)\s]+` link pattern drops the final
  // ")" and yields a 404 that looks like a healthy row. Assert the whole URL.
  ok(zal && zal.url === "https://jobs.zalando.com/en/jobs/2724318-Data-Engineer-(All-genders)",
     "employers: parenthesised Zalando URL is captured whole, not truncated");
  const mre = empJobs.find(j => j.company === "Munich Re");
  ok(mre && mre.title === "Claims Data Scientist" && /London/.test(mre.location),
     "employers: 'Role in City at Unit' splits into title + location");
  const kla = empJobs.find(j => j.company === "Klarna");
  ok(kla && kla.title === "Lead Data Engineer", "employers: '@ Klarna' suffix stripped from title");
  ok(!empJobs.some(j => /blogs\/techblog/.test(j.url)), "employers: Otto blog path cannot masquerade as a posting");
  // Employer rows default location to the query country, so (company,city) would
  // fold a whole board into one row. They must survive collapseBranchDupes.
  const empCollapse = collapseBranchDupes([
    { url: "z1", company: "Zalando", location: "Germany", source_portal: "Employer site (Zalando)" },
    { url: "z2", company: "Zalando", location: "Germany", source_portal: "Employer site (Zalando)" },
  ]);
  ok(empCollapse.length === 2, "employers: two same-company same-country rows are kept, not branch-collapsed");
  // A second call must behave identically — the SITES regexes carry /g, and a
  // leaked lastIndex would make extraction silently skip rows on later batches.
  ok(PORTALS.employers.extract('[Data Engineer (All genders)](https://jobs.zalando.com/en/jobs/2724318-Data-Engineer-(All-genders))',
       "", "", "Data Engineer", "Germany").length === 1,
     "employers: repeat extract is not broken by regex lastIndex carry-over");

  // Bug 2 — collapseBranchDupes must NOT fold distinct Civil Service vacancies
  // (all share company "UK Civil Service" + location "UK") …
  const cs = collapseBranchDupes([
    { url: "u1", company: "UK Civil Service", location: "UK", source_portal: "Civil Service Jobs" },
    { url: "u2", company: "UK Civil Service", location: "UK", source_portal: "Civil Service Jobs" },
  ]);
  ok(cs.length === 2, "collapseBranchDupes spares Civil Service umbrella");
  const bn = collapseBranchDupes([
    { url: "b1", company: "BMW", location: "UK", source_portal: "Bright Network" },
    { url: "b2", company: "BMW", location: "UK", source_portal: "Bright Network" },
  ]);
  ok(bn.length === 2, "collapseBranchDupes spares Bright Network (city-less UK rows)");
  // … but must still fold a real company's same-city branch dupes.
  const dup = collapseBranchDupes([
    { url: "a", company: "Acme GmbH", location: "Berlin" },
    { url: "b", company: "Acme GmbH", location: "Berlin" },
  ]);
  ok(dup.length === 1, "collapseBranchDupes still folds real same-company/city dupes");

  // Bug 3 (shape) — organicToMarkdown emits [title](link) that the extractors parse.
  const md = organicToMarkdown([{ title: "Data Scientist", link: "https://x/jobs.cgi?jcode=5" }]);
  ok(/\[Data Scientist\]\(https:\/\/x\/jobs\.cgi\?jcode=5\)/.test(md), "organicToMarkdown emits [title](link)");

  // Bug 4 (2026-07-13) — the xing extractor built the title with `.slice(0, -1)`,
  // dropping the LAST word (the numeric id is already split off by the regex), so
  // `berlin-analytics-engineer` → "Berlin Analytics" and passesFilter's positive
  // phrase "analytics engineer" never matched → silent xing under-yield.
  const xj = PORTALS.xing.extract("prefix https://www.xing.com/jobs/berlin-analytics-engineer-155942246 suffix");
  ok(xj.length === 1 && /analytics engineer/i.test(xj[0].title), "xing extract keeps full title (regression: slice(0,-1))");

  // Bug 5 (2026-07-13) — sponsoredjobs links render as ABSOLUTE urls in Firecrawl
  // markdown; the old `/\(\/jobs\/…\)/` (relative-link-in-parens) pattern matched 0.
  const sj = PORTALS.sponsoredjobs.extract("[Data Engineer](https://sponsoredjobs.co.uk/jobs/data-engineer-at-monzo)");
  ok(sj.length === 1 && /data engineer/i.test(sj[0].title) && /monzo/i.test(sj[0].company), "sponsoredjobs extract matches absolute URL (regression: relative-paren pattern)");

  // Bug 6 (2026-07-13) — Xing rows are enriched from the detail page: parseXingDetail
  // must read the real title (<h1> inside job-details-title) and the real company
  // (job-details-company-info-name) so staffing-agency syndication folds by
  // (company, title) instead of surfacing the same role across dozens of city slugs.
  const xd = parseXingDetail('<div data-testid="job-details-title" class="c"><h1 data-xds="Hero">Machine Learning Engineer (m/w/d)</h1></div><p data-testid="job-details-company-info-name">HIBA GmbH</p>');
  ok(xd.title === "Machine Learning Engineer (m/w/d)" && xd.company === "HIBA GmbH", "parseXingDetail reads real title + company from detail HTML");

  // Country resolution — the posting's Location beats the search-query country.
  ok(resolveCountry({ _country: "Germany", url: "https://linkedin.com/x", location: "Dublin, Ireland" }) === "Ireland", "resolveCountry: Dublin under a Germany query → Ireland");
  ok(resolveCountry({ _country: "UK", url: "https://linkedin.com/x", location: "Berlin, Berlin, Germany" }) === "Germany", "resolveCountry: Berlin under a UK query → Germany");
  ok(resolveCountry({ _country: "Germany", url: "https://linkedin.com/x", location: "London, United_Kingdom" }) === "UK", "resolveCountry: London normalises to UK");
  ok(resolveCountry({ _country: "Germany", url: "https://linkedin.com/x", location: "Warsaw, Poland" }) === "EU (other)", "resolveCountry: Poland → EU (other)");
  ok(resolveCountry({ _country: "UK", url: "https://linkedin.com/x", location: "" }) === "UK", "resolveCountry: empty location keeps query country");
  ok(resolveCountry({ _country: "UK", url: "https://www.xing.com/jobs/berlin-data-1", location: "" }) === "Germany", "resolveCountry: Xing DACH-board URL override intact");

  const failed = A.filter((a) => !a.pass);
  for (const a of A) console.log(`  ${a.pass ? "✓" : "✗"} ${a.label}`);
  if (failed.length) { console.error(`SELF_TEST_FAIL: ${failed.length}/${A.length} failed`); process.exit(1); }
  console.log(`SELF_TEST_PASS: ${A.length}/${A.length}`);
  process.exit(0);
}

// ─── Env + config ────────────────────────────────────────────────────────
const TOKEN = process.env.BRIGHTDATA_DATASET_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN && !has("--self-test")) {
  console.error("ROUTINE_ABORT: BRIGHTDATA_DATASET_TOKEN env var not set.");
  console.error('Run: setx BRIGHTDATA_DATASET_TOKEN "<uuid-token-from-brightdata>"');
  process.exit(5);
}
if (!NOTION_TOKEN && !has("--self-test")) {
  console.error("ROUTINE_ABORT: NOTION_TOKEN env var not set.");
  process.exit(5);
}

const DATASET_GENERIC  = "gd_m6gjtfmeh43we6cqc";  // generic web scraper (markdown + html + ld_json)
const DATASET_LINKEDIN = "gd_lpfll7v5hcqtkxl6l";  // LinkedIn job-posting structured scraper
const bdEndpoint = (ds) => `https://api.brightdata.com/datasets/v3/scrape?dataset_id=${ds}&notify=false&include_errors=true`;
const BD_ENDPOINT = bdEndpoint(DATASET_GENERIC);   // back-compat (existing callsite uses generic)

function loadConfig() {
  const p = "config/profile.yml";
  if (!existsSync(p)) return {};
  try { return yaml.load(readFileSync(p, "utf8")) || {}; } catch { return {}; }
}
const CFG = loadConfig();
// Bulk-scrape query catalog. Renamed from `apify:` → `bulk_scrape:` (2026-07-01);
// old key accepted as fallback.
const BULK = CFG.bulk_scrape || CFG.apify || {};
// DATABASE_ID resolves from config; process.env fallback lets scheduled runs
// point at their own DB without touching config/profile.yml. No hardcoded
// fallback — running without a configured DB is an operator error, not a
// silent write into someone else's tracker.
const DATABASE_ID = (CFG.notion && CFG.notion.applications_database_id)
  || process.env.NOTION_APPLICATIONS_DATABASE_ID
  || process.env.NOTION_DATABASE_ID;
if (!DATABASE_ID && !process.argv.includes('--self-test') && !process.argv.includes('--probe-xportal')) {
  console.error('bd-bulk-scan: notion.applications_database_id not configured. Set it in config/profile.yml or NOTION_APPLICATIONS_DATABASE_ID env.');
  process.exit(2);
}

// Bright Data SERP zone (Web Unlocker) for Google-SERP discovery. The generic
// dataset scraper pointed at google.com/search gets served Google's consent/chrome
// shell intermittently (0 results); the dedicated SERP zone returns parsed results
// reliably. Same zone the referral-scout uses. Needs BRIGHTDATA_API_KEY.
const BD_API_KEY = process.env.BRIGHTDATA_API_KEY;
const SERP_ZONE = (CFG.referral_scout && CFG.referral_scout.brightdata_serp_zone) || "cli_unlocker";
const SERP_CONCURRENCY = 8;

// Queries: { role, country }. Default source = the hand-maintained
// bulk_scrape.queries catalog (unchanged cost). Opt-in generated view: set
// bulk_scrape.generate_queries: true in config/profile.yml to build queries from
// role-taxonomy core archetypes × bulk_scrape.query_countries (falls back to the
// distinct countries in bulk_scrape.queries).
// NOTE: the generated matrix is a cartesian (5 core archetypes × N countries) and
// will be LARGER than the curated 16-query list — enable only if the added Bright
// Data volume is acceptable.
let QUERIES;
if (BULK && BULK.generate_queries) {
  const _tax = loadTaxonomy(".");
  const _countries = (BULK.query_countries && BULK.query_countries.length)
    ? BULK.query_countries
    : [...new Set(((BULK.queries) || []).map(q => q.country))];
  QUERIES = _tax ? deriveQueries(_tax, _countries) : (BULK.queries || []);
  console.error(`bd-bulk-scan: queries GENERATED from role-taxonomy — ${QUERIES.length} (${_countries.length} countries × core archetypes)`);
} else {
  QUERIES = (BULK && BULK.queries) || [
    { role: "Analytics Engineer", country: "Germany" },
    { role: "Data Scientist", country: "Germany" },
    { role: "Data Engineer", country: "Germany" },
  ];
}

// Which portals honour a query's optional `city:` field (2026-08-14).
// Scoped to eFC ONLY by default, deliberately: eFC is the one portal measured
// to be strongly city-sensitive (data-engineer Berlin 27/43 on-target vs
// Frankfurt 6/43). Stepstone and Xing are also city-aware in the sense that
// they expand TOP_CITIES, but pinning them to a single city NARROWS their
// coverage (Xing drops from its top-3 cities to one) and costs extra fetches
// for no measured gain. An entry can widen this for itself with
// `city_portals: [efc, xing]`.
const CITY_DEFAULT_PORTALS = (BULK && BULK.city_default_portals) || ["efc"];

// Resolve the city a given portal should use for a given query. Returns null
// when the portal is out of scope, which makes portal.urls() fall back to its
// normal TOP_CITIES expansion — producing URLs identical to the country-level
// entry, which the per-portal dedupe in plan() then collapses to zero cost.
function cityFor(q, portalKey) {
  if (!q.city) return null;
  const scope = (q.city_portals && q.city_portals.length) ? q.city_portals : CITY_DEFAULT_PORTALS;
  return scope.includes(portalKey) ? q.city : null;
}

// ─── German-language query variants (2026-08-18) ─────────────────────────
// The query catalog is English-only, so German-TITLED ads on the DACH-native
// boards ("Datenanalyst") matched no query string and were never discovered.
// Terms come from role-taxonomy.yml's `lang` field — never hardcoded here — so
// the query side and deriveTitleFilter's matching side cannot drift apart.
const DE_VARIANTS = (BULK && BULK.german_query_variants) || {};
const DE_VARIANTS_ON = DE_VARIANTS.enabled === true;
const DE_VARIANT_PORTALS = DE_VARIANTS.portals || ["xing", "stepstone", "efc"];
const DE_VARIANT_COUNTRIES = DE_VARIANTS.countries || ["Germany", "Austria", "Switzerland"];
const _deTax = DE_VARIANTS_ON ? loadTaxonomy(".") : null;

/**
 * Role strings to query for one {query, portal} pair: always the English role,
 * plus its German equivalents when the portal AND country are both in scope.
 * Returns [role] unchanged when the feature is off, the board is not DACH-native,
 * or the archetype has no German title (AE — DACH writes "Analytics Engineer").
 */
function rolesFor(q, portalKey) {
  if (!DE_VARIANTS_ON || !_deTax) return [q.role];
  if (!DE_VARIANT_PORTALS.includes(portalKey)) return [q.role];
  if (!DE_VARIANT_COUNTRIES.includes(q.country)) return [q.role];
  return [q.role, ...translateRole(_deTax, q.role, "de")];
}

// Country → top cities for portals that need city-level filtering
const TOP_CITIES = (BULK && BULK.country_top_cities) || {
  Germany: ["Berlin","Munich","Hamburg","Frankfurt"],
  "United Kingdom": ["London","Manchester","Edinburgh"],
  Netherlands: ["Amsterdam"],
  Austria: ["Vienna"],
  Switzerland: ["Zurich"],
  France: ["Paris"],
  Ireland: ["Dublin"],
};

// Portal → ISO geo
const COUNTRY_TO_GEO = {
  "Germany": "DE", "Austria": "AT", "Switzerland": "CH",
  "Netherlands": "NL", "United Kingdom": "GB", "Ireland": "IE",
  "France": "FR",
};

// Portal slug for Stepstone
function slugify(role) { return role.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""); }

// ─── URL builders per portal ─────────────────────────────────────────────
// Indeed detail pages are Cloudflare-walled and the SERP carries no clean title,
// so indeed rows are metadata-grade (role-tagged, Undisclosed company). Bound the
// per-run volume so this low-signal source can't flood auto-eval.
const INDEED_CAP = 25;
let _indeedKept = 0;

const PORTALS = {
  stepstone: {
    name: "Stepstone",
    urls(role, country, pages, city) {
      const geo = COUNTRY_TO_GEO[country];
      if (!geo || geo === "GB" || geo === "FR" || geo === "NL" || geo === "IE") return [];
      const slug = slugify(role);
      // Page 1 = city-faceted variant (richer card output); page 2+ = generic search.
      // An explicit q.city overrides the default top-1 city.
      const cities = city ? [city] : (TOP_CITIES[country] || []).slice(0, 1);
      const base = cities.length
        ? `https://www.stepstone.de/jobs/${slug}/in-${cities[0].toLowerCase()}`
        : `https://www.stepstone.de/jobs/${slug}?action=search`;
      return Array.from({length: pages}, (_, i) =>
        i === 0 ? base : `${base}${base.includes("?") ? "&" : "?"}page=${i+1}`);
    },
    extract(md, baseUrl, html) {
      // Stepstone hides job-card anchors from markdown rendering;
      // fall back to page_html which preserves the /stellenangebote--*--ID-inline.html pattern
      const source = (md && md.includes("/stellenangebote--")) ? md : (html || "");
      const out = [];
      const slugs = new Set();
      // Find all stellenangebote slugs (anywhere — href, markdown link, etc.)
      const re = /\/stellenangebote--([^"'\s)<>]+?)--(\d+)-inline\.html/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        const slugBody = m[1];
        const id = m[2];
        const u = `https://www.stepstone.de/stellenangebote--${slugBody}--${id}-inline.html`;
        if (slugs.has(u)) continue;
        slugs.add(u);
        // Parse "Title-words-City-Company" — best-effort: last segment ≈ company, 2nd-to-last ≈ city
        const parts = slugBody.split("-");
        const title = parts.slice(0, Math.max(1, parts.length - 2)).join(" ").replace(/_/g, " ");
        const location = parts.length > 2 ? parts[parts.length - 2] : "";
        const company = parts.length > 1 ? parts[parts.length - 1].replace(/_/g, " ") : "";
        out.push({
          url: u,
          title: decodeURIComponent(title),
          company: decodeURIComponent(company),
          location,
          source_portal: "Stepstone",
        });
      }
      return out;
    },
  },

  // Indeed dropped 2026-06-05 — user directive.
  // Aggressive bot-blocking + low signal-to-noise vs DACH-native portals.

  xing: {
    name: "Xing",
    urls(role, country, pages, city) {
      // Xing is DACH-native — only emit for DE/AT/CH; expand to cities for better coverage.
      // An explicit q.city pins to that one city instead of the TOP_CITIES top-3.
      const cities = city ? [city] : (TOP_CITIES[country] || []);
      if (cities.length === 0) return [];
      const urls = [];
      for (const c of cities.slice(0, 3)) {
        const k = encodeURIComponent(role);
        const l = encodeURIComponent(c);
        for (let p = 0; p < pages; p++) {
          urls.push(`https://www.xing.com/jobs/search?keywords=${k}&location=${l}${p > 0 ? `&page=${p+1}` : ""}`);
        }
      }
      return urls;
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      // Xing job slugs: /jobs/<slug>-<id>. FIXED 2026-06-04: previous regex required
      // markdown-link `(URL)` syntax which BD's markdown no longer produces, causing
      // silent xing:0 yield since ~early June. New regex matches the URL in any
      // context (plain text, parenthesised, angle brackets).
      const re = /https?:\/\/www\.xing\.com\/jobs\/([a-z0-9-]+)-(\d+)/g;
      let m;
      while ((m = re.exec(md)) !== null) {
        const id = m[2];
        if (seen.has(id)) continue;
        seen.add(id);
        const slug = m[1];
        const url = m[0];
        // FIXED 2026-07-13: was `.slice(0, -1)`, which dropped the LAST word of the
        // title — but the numeric ID is already stripped by the regex's `-(\d+)`
        // capture, so the slug is pure words. Dropping the last word turned
        // `berlin-analytics-engineer` into "Berlin Analytics" (no "Engineer"), so it
        // failed passesFilter's required positive-phrase match ("analytics engineer").
        // Keeping all words ~doubled the Xing filter pass-rate (111 → 235 on a real batch).
        const title = slug.split("-").join(" ").replace(/(^| )(\w)/g, (_, s, c) => s + c.toUpperCase());
        out.push({ url, title, company: "Undisclosed (Xing)", source_portal: "Xing" });
      }
      return out;
    },
  },

  careerbee: {
    name: "CareerBee",
    urls(role, country, pages) {
      if (country !== "Germany") return [];
      const s = encodeURIComponent(role);
      return Array.from({length: pages}, (_, i) =>
        i === 0 ? `https://www.careerbee.io/jobs/?s=${s}` : `https://www.careerbee.io/jobs/page/${i+1}/?s=${s}`);
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      // FIXED 2026-06-04: dropped `(URL)` markdown-link requirement, match URL anywhere.
      const re = /https?:\/\/www\.careerbee\.io\/jobs\/([a-z0-9-]+)\/?/g;
      let m;
      while ((m = re.exec(md)) !== null) {
        const slug = m[1];
        if (slug === "page" || slug.startsWith("page-") || seen.has(slug)) continue;
        seen.add(slug);
        const title = slug.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
        out.push({ url: m[0], title, company: "(via CareerBee)", source_portal: "CareerBee" });
      }
      return out;
    },
  },

  efc: {
    name: "eFinancialCareers",
    urls(role, country, pages, city) {
      const tld = country === "United Kingdom" ? "co.uk" : "de";
      const slug = slugify(role);
      // eFC listing URL: /jobs/{slug}[/in-{city}][?page=N]
      // eFC is the most city-sensitive portal we scrape: measured 2026-08-14,
      // data-engineer/in-berlin returned 27 on-target of 43 cards while the same
      // role in Frankfurt returned 6 of 43. So an explicit q.city pins to that
      // city AND drops the country-wide base URL, which is the noisiest of the set.
      const cities = city ? [city] : (TOP_CITIES[country] || []).slice(0, 2); // top 2 cities per country
      const out = city ? [] : [`https://www.efinancialcareers.${tld}/jobs/${slug}`];
      for (const c of cities) {
        out.push(`https://www.efinancialcareers.${tld}/jobs/${slug}/in-${c.toLowerCase()}`);
      }
      return out.slice(0, pages); // honour --pages cap (each URL is one listing page already serves ~40 jobs)
    },
    extract(md, baseUrl, html) {
      const out = [];
      const slugs = new Set();
      // eFC listing-page job cards are Angular components:
      //   <efc-job-card ...>
      //     <img alt="{Company}" title="{Company}">     <-- real company name
      //     <a href="{full job URL}" title="{Job title}">  <-- clean title + URL
      //   </efc-job-card>
      // The card structure repeats per job. Split the HTML by <efc-job-card and
      // parse each block individually so we keep company aligned with its URL.
      const h = html || "";
      const cards = h.split(/<efc-job-card\b/i).slice(1);  // first chunk is pre-card noise

      for (const card of cards) {
        // Find the job link + title attribute
        const linkMatch = card.match(/<a[^>]*href="(https?:\/\/www\.efinancialcareers\.(?:de|co\.uk|com)\/jobs-[^"]+?\.id\d+)"[^>]*?\btitle="([^"]+)"/i);
        if (!linkMatch) continue;
        const fullUrl = linkMatch[1].replace(/[?#].*$/, "");
        const titleClean = linkMatch[2].trim();
        if (slugs.has(fullUrl)) continue;
        slugs.add(fullUrl);

        // Find the company name — img alt/title attribute on the card's logo,
        // OR efc-card-details company link, OR fall back to "Undisclosed"
        let company = "Undisclosed (eFinancialCareers)";
        const imgMatch = card.match(/<img[^>]*\balt="([^"]+)"[^>]*\btitle="\1"/i)
                      || card.match(/<img[^>]*\btitle="([^"]+)"[^>]*\balt="\1"/i)
                      || card.match(/<img[^>]*\balt="([^"]+)"/i);
        if (imgMatch && imgMatch[1] && !/^logo|^icon|^company logo/i.test(imgMatch[1])) {
          company = imgMatch[1].trim();
        }
        // Secondary: company name often appears in a separate efc-card-details company link
        const compNameMatch = card.match(/class="company-name[^"]*"[^>]*>([^<]+)</i);
        if (compNameMatch && compNameMatch[1].trim()) {
          company = compNameMatch[1].trim();
        }

        // Parse location from URL slug as a fallback (the card body has it too but
        // it's redundant with the URL — keep it simple)
        const slugBody = decodeURIComponent(fullUrl.match(/jobs-([^.]+)\.id/)?.[1] || "")
          .replace(/%5F/gi, "_");
        const parts = slugBody.split("-");
        const country = parts[0] || "";
        const city = (parts[1] || "").replace(/_/g, " ");

        out.push({
          url: fullUrl,
          title: titleClean,
          company,
          location: `${city}${country ? ", " + country : ""}`,
          source_portal: "eFinancialCareers",
        });
      }
      return out;
    },
  },

  linkedin: {
    name: "LinkedIn",
    // Two-stage: discovery URLs are Google SERPs querying site:linkedin.com/jobs/view.
    // The extractor pulls LinkedIn /jobs/view/* URLs out of the SERP markdown.
    // Then bd-bulk-scan's runner enriches those URLs via DATASET_LINKEDIN.
    twoStage: true,
    urls(role, country, pages) {
      // Build N SERP queries (one per page, with &start=N*10 for Google pagination)
      const out = [];
      for (let p = 0; p < pages; p++) {
        const q = `site:linkedin.com/jobs/view "${role}" ${country}`;
        const params = new URLSearchParams({ q, start: String(p * 10) });
        out.push(`https://www.google.com/search?${params.toString()}`);
      }
      return out;
    },
    extract(md) {
      // Stage A output: just URLs, no titles/companies yet (filled in by Stage B)
      const out = [];
      const seen = new Set();
      const re = /https?:\/\/[a-z]+\.linkedin\.com\/jobs\/view\/[a-z0-9-]+(?:-\d+)?/g;
      const matches = (md || "").match(re) || [];
      for (const u of matches) {
        // Normalise: strip query string, trailing slash
        const cleaned = u.replace(/[?#].*$/, "").replace(/\/$/, "");
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push({ url: cleaned, source_portal: "LinkedIn", _needs_enrichment: true });
      }
      return out;
    },
  },

  wttj: {
    name: "WelcomeToTheJungle",
    // Two-stage like LinkedIn:
    //   Stage A — Google SERP via BD generic discovers /en/companies/.../jobs/...
    //             URLs that match our role + country (DataDome doesn't gate Google)
    //   Stage B — BD generic on each WTTJ job URL (verified works — returns 5KB
    //             markdown + page_title "Role - Company - Permanent contract in City")
    //
    // (Sitemap approach abandoned 2026-05-28 — DataDome blocks the .xml.gz
    // endpoints persistently, even via BD's snapshot polling. SERP works.)
    twoStage: true,
    urls(role, country, pages) {
      const out = [];
      for (let p = 0; p < pages; p++) {
        const q = `site:welcometothejungle.com/en/companies "${role}" ${country}`;
        const params = new URLSearchParams({ q, start: String(p * 10) });
        out.push(`https://www.google.com/search?${params.toString()}`);
      }
      return out;
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      const re = /https?:\/\/www\.welcometothejungle\.com\/en\/companies\/[a-z0-9-]+\/jobs\/[a-z0-9_-]+/g;
      const matches = (md || "").match(re) || [];
      for (const u of matches) {
        const cleaned = u.replace(/[?#].*$/, "").replace(/\/$/, "");
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        out.push({ url: cleaned, source_portal: "WelcomeToTheJungle", _needs_enrichment: true });
      }
      return out;
    },
  },

  indeed: {
    name: "Indeed",
    // Single-stage SERP-title (was two-stage until 2026-07-06). Enriching viewjob
    // pages via BD generic was ~0 net yield — they are Cloudflare-walled — and the
    // ~159-URL enrichment queue blew the 30-min budget (probe: 164 raw → 5 net in
    // 330s). We now take the title straight from the Google SERP result text, the
    // same proven path as csjobs; auto-eval falls back to metadata scoring for the
    // walled detail page. Country routes to the national domain for location tags.
    twoStage: false,
    urls(role, country, pages) {
      const DOMAIN = {
        "Germany": "de.indeed.com", "Austria": "at.indeed.com",
        "Switzerland": "ch.indeed.com", "United Kingdom": "uk.indeed.com",
        "Netherlands": "nl.indeed.com", "Ireland": "ie.indeed.com",
      }[country];
      if (!DOMAIN) return [];
      const out = [];
      for (let p = 0; p < pages; p++) {
        const q = `site:${DOMAIN}/viewjob "${role}"`;
        const params = new URLSearchParams({ q, start: String(p * 10) });
        out.push(`https://www.google.com/search?${params.toString()}`);
      }
      return out;
    },
    extract(md, _inputUrl, _html, role, country) {
      // SERP result title = the viewjob page title, usually "Role - Location - Company
      // - Indeed.com". Parse [title](viewjob?jk=…) for a real, distinct Stage-1 row.
      // Detail pages are Cloudflare-walled, so auto-eval falls back to metadata scoring.
      // Falls back to the query role when the title can't be split. Bounded by INDEED_CAP.
      const out = [];
      const seen = new Set();
      const linkRe = /\[([^\]]{2,180})\]\(([^)]*indeed\.com\/viewjob[^)]*)\)/gi;
      let m;
      while ((m = linkRe.exec(md || ""))) {
        if (_indeedKept >= INDEED_CAP) break;
        const jk = (m[2].match(/[?&]jk=([a-f0-9]+)/i) || [])[1];
        if (!jk) continue;
        const host = (m[2].match(/https?:\/\/([^/]+)/i) || [])[1] || "de.indeed.com";
        const cleaned = `https://${host}/viewjob?jk=${jk}`;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        const pt = m[1].replace(/\s*[-|–]\s*Indeed(\.com)?\s*$/i, "").replace(/\s*\|\s*Indeed.*$/i, "").trim();
        const parts = pt.split(/\s+[-–|]\s+/);
        const title = (parts[0] || role || "").trim();
        let company = "Undisclosed (Indeed)", location = country || "";
        if (parts.length >= 3) { company = parts[2].trim() || company; location = parts[1].trim() || location; }
        else if (parts.length === 2) { location = parts[1].trim() || location; }
        if (!title) continue;
        out.push({
          url: cleaned, title, company, location, source_portal: "Indeed",
          jd_summary: "[indeed: title from Google SERP; detail page Cloudflare-walled — verify liveness + company manually]",
        });
        _indeedKept++;
      }
      return out;
    },
  },

  csjobs: {
    name: "Civil Service Jobs",
    // Single-stage from SERP (reworked 2026-07-03): the site human-checks
    // EVERY page — even per-vacancy jobs.cgi URLs come back as "Quick Check
    // Needed" through BD generic, so enrichment is impossible headless. But
    // Google's result TITLES carry the vacancy title ("Data Engineer - Civil
    // Service Jobs - GOV.UK"), which is enough for a Stage-1 row; auto-eval's
    // fetch will also bot-wall and fall back to metadata scoring (same proven
    // path as eFC). UK-only. Nationality: Commonwealth citizens with right to
    // work are eligible for NON-RESERVED posts — never auto-skip on "UK
    // nationals" pattern-matching; SC/DV clearance is the real gate (eval-time
    // rule in modes/_profile.md).
    urls(role, country, pages) {
      if (country !== "United Kingdom") return [];
      // Emit the full Civil-Service data-role vocabulary ONCE per run, gated on the
      // anchor archetype so the generic role loop doesn't re-emit it. The old code
      // queried only the 5 generic archetypes exact-phrase × 2 pages (~1 hit); the
      // CS uses its own titles — Statistician, Operational Researcher, Performance
      // Analyst, Data Architect — which those queries never matched. Broaden the
      // vocabulary and go deeper (3 pages). Single-stage + cheap, so depth is safe.
      if (!/^analytics engineer$/i.test(role)) return [];
      const terms = [
        "Data Scientist", "Data Engineer", "Data Analyst", "Analytics Engineer",
        "Machine Learning Engineer", "Statistician", "Operational Researcher",
        "Performance Analyst", "Data Architect", "Data Science", "Data Engineering",
      ];
      // Breadth over depth: niche CS queries rarely fill even page 1, so a deep
      // sweep just burns fetches on empty pages. One page (top ~10) per term ×
      // the broadened vocabulary is the right shape for a low-volume board.
      const out = [];
      for (const t of terms) {
        const params = new URLSearchParams({ q: `site:civilservicejobs.service.gov.uk/csr "${t}"`, start: "0" });
        out.push(`https://www.google.com/search?${params.toString()}`);
      }
      return out;
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      // Markdown links in the SERP: [Title - Civil Service Jobs - GOV.UK](https://...jobs.cgi?jcode=NNN)
      const linkRe = /\[([^\]]{3,140})\]\((https?:\/\/www\.civilservicejobs\.service\.gov\.uk\/csr\/jobs\.cgi\?[^)]*)\)/g;
      let m;
      while ((m = linkRe.exec(md || ""))) {
        const jcode = (m[2].match(/[?&]jcode=(\d+)/) || [])[1];
        if (!jcode) continue; // skip SID/session URLs
        const cleaned = `https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=${jcode}`;
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        const title = m[1].replace(/\s*[-–|]\s*Civil Service Jobs.*$/i, "").replace(/\s*\([A-Z0-9]+\)\s*$/, "").trim();
        if (!title) continue;
        out.push({
          url: cleaned,
          title,
          company: "UK Civil Service",
          location: "UK",
          source_portal: "Civil Service Jobs",
          jd_summary: "[csjobs: detail page human-checked — verify liveness manually; CS vacancies close in ~2-3 weeks and Google's index lags, so treat older-indexed posts as possibly closed]",
        });
      }
      // Fallback: bare URLs without link text (rare) — still capture, placeholder title
      const bareRe = /https?:\/\/www\.civilservicejobs\.service\.gov\.uk\/csr\/jobs\.cgi\?[^"\s)\]]*/g;
      for (const u of (md || "").match(bareRe) || []) {
        const jcode = (u.match(/[?&]jcode=(\d+)/) || [])[1];
        if (!jcode) continue;
        const cleaned = `https://www.civilservicejobs.service.gov.uk/csr/jobs.cgi?jcode=${jcode}`;
        if (!seen.has(cleaned)) {
          seen.add(cleaned);
          out.push({ url: cleaned, title: "(csjobs listing)", company: "UK Civil Service", location: "UK", source_portal: "Civil Service Jobs" });
        }
      }
      return out;
    },
  },

  sponsoredjobs: {
    name: "SponsoredJobs",
    // Single-stage (added 2026-07-03): sponsoredjobs.co.uk lists ONLY roles at
    // Home-Office-licensed sponsors that clear going-rate thresholds — exactly
    // the employers that matter for the post-Graduate-visa (Skilled Worker)
    // horizon. BD generic fetches the sector listing pages directly; title +
    // company parse from the /jobs/{title}-at-{company} slug. UK-only.
    urls(role, country, pages) {
      if (country !== "United Kingdom") return [];
      // Sector pages, not per-role search (site search is unreliable headless).
      // The title filter downstream keeps only target roles, so one sector
      // sweep per run covers every query — emit for the first role only to
      // avoid duplicate fetches (plan() calls urls() once per role).
      if (!/^analytics engineer$/i.test(role)) return [];
      // Pagination is client-side (?page=N returns page 1), so fetch the
      // sector page once per run; sorted newest-first, daily runs skim new
      // arrivals. Low volume by design, but every hit is sponsor-verified.
      return ["https://sponsoredjobs.co.uk/jobs/sector/it"];
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      const cap = (s) => s.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
      // FIXED 2026-07-13: was `/\(\/jobs\/…\)/` (relative link in parens), but the
      // Firecrawl render emits ABSOLUTE URLs — `](https://sponsoredjobs.co.uk/jobs/X-at-Y)`
      // — so the paren-prefixed relative pattern matched 0. Match the absolute URL
      // anywhere (same fix class as the 2026-06-04 xing/careerbee "(URL) requirement"
      // removal). Also required routing sponsoredjobs through Firecrawl (BD generic
      // returned a JS shell with no links).
      const re = /https?:\/\/sponsoredjobs\.co\.uk\/jobs\/([a-z0-9-]+)-at-([a-z0-9-]+)/g;
      let m;
      while ((m = re.exec(md || ""))) {
        const url = `https://sponsoredjobs.co.uk/jobs/${m[1]}-at-${m[2]}`;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push({
          url,
          title: cap(m[1]),
          company: cap(m[2]),
          location: "UK",
          source_portal: "SponsoredJobs",
          sponsorship: "likely", // whole board is sponsor-licence-verified
        });
      }
      return out;
    },
  },

  brightnetwork: {
    name: "Bright Network",
    // Single-stage SERP-title (added 2026-07-06). UK graduate / early-career board.
    // Its /search page is JS-rendered (a direct fetch returns an empty ~200-byte
    // shell), but /graduate-jobs/{company}/{slug} pages ARE Google-indexed, so we
    // discover via a SERP `site:` query. Title format is "{Role} - {Company}"; the
    // company is also in the URL slug. Graduate-rich — aligns with the graduate-
    // primary positioning: Graduate/Junior/Trainee pass the uniform title filter,
    // while Placement/Apprenticeship/Internship/Werkstudent are prohibited (role-
    // taxonomy exclusions), so those are dropped here too. UK-only, single-stage.
    urls(role, country, pages) {
      if (country !== "United Kingdom") return [];
      const out = [];
      for (let p = 0; p < pages; p++) {
        const params = new URLSearchParams({ q: `site:brightnetwork.co.uk/graduate-jobs "${role}"`, start: String(p * 10) });
        out.push(`https://www.google.com/search?${params.toString()}`);
      }
      return out;
    },
    extract(md) {
      const out = [];
      const seen = new Set();
      const linkRe = /\[([^\]]{3,160})\]\((https?:\/\/www\.brightnetwork\.co\.uk\/graduate-jobs\/[^/)\s]+\/[^)\s]+)\)/gi;
      let m;
      while ((m = linkRe.exec(md || ""))) {
        const url = m[2].replace(/[?#].*$/, "").replace(/\/$/, "");
        if (seen.has(url)) continue;
        seen.add(url);
        let title = m[1].trim(), company = "";
        const parts = title.split(/\s+[-–|]\s+/);
        if (parts.length >= 2) { company = parts[parts.length - 1].trim(); title = parts.slice(0, -1).join(" - ").trim(); }
        if (!company) {
          const cm = url.match(/\/graduate-jobs\/([^/]+)\//i);
          if (cm) company = decodeURIComponent(cm[1]).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        }
        if (!title) continue;
        out.push({
          url, title, company: company || "(via Bright Network)", location: "UK",
          source_portal: "Bright Network",
          jd_summary: "[brightnetwork: UK graduate/early-career board; title from SERP — verify detail manually]",
        });
      }
      return out;
    },
  },

  employers: {
    name: "Tracked employer sites",
    // Single-stage SERP-title (added 2026-08-15). Covers tracked_companies in
    // portals.yml that scan.mjs cannot reach: their careers sites run on
    // SuccessFactors / Avature / iCIMS / Eightfold / Deel or are SPA-only, none
    // of which expose a public JSON board. Those entries resolved to no provider
    // and were scanned by NOTHING — scan.mjs reported them only as a count, and
    // the `scan_method: chrome_scan` they carried pointed at lunchtime-scan,
    // retired 2026-08-02. Their job DETAIL pages are Google-indexed even when
    // their search UI is not, so SERP discovery reaches what the API path can't.
    //
    // Verified per-domain against the live SERP zone on 2026-08-15; every entry
    // below returned real job-detail URLs. Two candidates were dropped and must
    // NOT be re-added without new evidence:
    //   Deutsche Bank  careers.db.com routes jobs through a #/professional/job
    //                  hash, so no per-job URL exists to index. A site: query
    //                  returns only programme/landing pages.
    //   TravelPerk     rebranded to perk.com; neither travelperk.com nor
    //                  perk.com has indexed job pages (blog + support only).
    //
    // Cost: employers are OR-ed into ONE query per group, so a group costs the
    // same as any other SERP portal rather than one query per company. Groups
    // are capped at GROUP_SIZE because a wide OR lets one domain crowd out the
    // rest — measured 2026-08-15: a 7-domain OR returned 5 of 7 domains, while
    // the same query split in two returned all of them, and a Revolut+Klarna
    // pair went 10/10 to Revolut. Four is the compromise between spread and
    // fetch count.
    SITES: [
      // country: which query countries this board is worth searching under.
      { company: "Zalando",          site: "jobs.zalando.com",                 countries: ["Germany"],
        re: /https?:\/\/jobs\.zalando\.com\/[a-z]{2}\/jobs\/[^\s)]+/gi,                        strip: /\s*[-|]\s*Zalando.*$/i },
      { company: "SAP",              site: "jobs.sap.com/job",                 countries: ["Germany", "Austria"],
        re: /https?:\/\/jobs\.sap\.com\/job\/[^\s)]+/gi,                                       strip: /\s*Job Details.*$/i },
      { company: "Deutsche Telekom", site: "careers.telekom.com/en/jobs",      countries: ["Germany"],
        re: /https?:\/\/careers\.telekom\.com\/[a-z]{2}\/jobs\/[^\s)]+/gi,                     strip: /\s*\|\s*Global Career Website.*$/i },
      { company: "adesso SE",        site: "jobs.adesso-group.com/job",        countries: ["Germany", "Austria"],
        re: /https?:\/\/jobs\.adesso-group\.com\/job[^\s)]+/gi,                                strip: /\s*(Stellendetails|Job Details).*$/i },
      { company: "Munich Re",        site: "careers.munichre.com/en/job",      countries: ["Germany", "United Kingdom"],
        re: /https?:\/\/careers\.munichre\.com\/[a-z]{2}\/job\/[^\s)]+/gi,                     strip: null },
      { company: "Otto Group",       site: "otto.de/jobs/de/stellenangebote",  countries: ["Germany"],
        re: /https?:\/\/www\.otto\.de\/jobs\/de\/stellenangebote\/[^\s)]+/gi,                  strip: null },
      { company: "Siemens",          site: "jobs.siemens.com",                 countries: ["Germany", "Austria"],
        re: /https?:\/\/jobs\.siemens\.com\/[a-z]{2}_[A-Z]{2}\/externaljobs\/JobDetail\/\d+/gi, strip: /\s*-\s*Job Detail.*$/i },
      { company: "Booking.com",      site: "jobs.booking.com/booking/jobs",    countries: ["Netherlands"],
        re: /https?:\/\/jobs\.booking\.com\/booking\/jobs\/\d+[^\s)]*/gi,                      strip: /\s*\|\s*Booking\.com.*$/i },
      { company: "Klarna",           site: "jobs.deel.com/klarna",             countries: ["Germany", "United Kingdom"],
        re: /https?:\/\/jobs\.deel\.com\/klarna\/job-details\/[a-f0-9-]+[^\s)]*/gi,            strip: /\s*@\s*Klarna.*$/i },
      { company: "Revolut",          site: "revolut.com/careers/position",     countries: ["United Kingdom"],
        re: /https?:\/\/www\.revolut\.com\/careers\/position\/[^\s)]+/gi,                      strip: /\s*\|\s*Revolut.*$/i },
    ],
    GROUP_SIZE: 4,
    urls(role, country, pages) {
      const mine = this.SITES.filter(s => s.countries.includes(country));
      if (!mine.length) return [];   // e.g. Ireland — no tracked employer board
      const out = [];
      for (let i = 0; i < mine.length; i += this.GROUP_SIZE) {
        const group = mine.slice(i, i + this.GROUP_SIZE);
        const clause = "(" + group.map(s => `site:${s.site}`).join(" OR ") + ")";
        for (let p = 0; p < pages; p++) {
          const params = new URLSearchParams({ q: `${clause} "${role}"`, start: String(p * 10) });
          out.push(`https://www.google.com/search?${params.toString()}`);
        }
      }
      return out;
    },
    extract(md, _inputUrl, _html, role, country) {
      const out = [];
      const seen = new Set();
      // Parse [title](link) pairs from organicToMarkdown(), which emits exactly
      // one result per line. Match LINE-WISE with a greedy URL group so the last
      // ")" on the line closes the link: Zalando's URLs contain literal parens
      // (…/2724318-Data-Engineer-(All-genders)), and the usual `[^)\s]+` pattern
      // silently truncates them one char short — a 404 that still looks like a
      // valid row all the way into Notion.
      for (const line of String(md || "").split(/\r?\n/)) {
        const m = line.match(/^\s*\[(.{3,200})\]\((https?:\/\/.+)\)\s*$/);
        if (!m) continue;
        const rawTitle = m[1].trim();
        const url = m[2].replace(/[#].*$/, "").replace(/\/$/, "");
        // Attribute by URL, never by SERP title: a careers site freely renders
        // its own brand into the title, but only the URL proves whose board it
        // is. Each `re` is anchored to a job-DETAIL path so category and blog
        // pages (Otto surfaces plenty of both) can't be mistaken for postings.
        const site = this.SITES.find(s => { s.re.lastIndex = 0; return s.re.test(url); });
        if (!site) continue;
        const cu = url.replace(/[?].*$/, "");
        if (seen.has(cu)) continue;
        seen.add(cu);
        let title = site.strip ? rawTitle.replace(site.strip, "").trim() : rawTitle;
        // Several of these boards render "Role in {City}[, Country][ at {Unit}]"
        // (Munich Re, Booking.com). Pull the city out rather than leaving it in
        // the title, where it would fight the role-taxonomy title filter.
        let location = country;
        const inAt = title.match(/^(.*?)\s+in\s+([^,]+?)(?:,\s*([^,]+?))?(?:\s+at\s+(.+))?$/i);
        if (inAt && inAt[1] && inAt[2] && inAt[2].length < 40) {
          title = inAt[1].trim();
          location = [inAt[2].trim(), (inAt[3] || "").trim()].filter(Boolean).join(", ");
        }
        title = title.replace(/\s*[-–|]\s*$/, "").trim();
        if (!title) continue;
        out.push({
          url,
          title,
          company: site.company,
          location,
          source_portal: `Employer site (${site.company})`,
          jd_summary: `[employers: ${site.company} careers site; title from SERP — no public JSON board, detail unverified]`,
        });
      }
      return out;
    },
  },

  // Make-it-in-Germany dropped 2026-06-05 — hard-blocked by perfdrive.com CAPTCHA.
  // Both BD and Firecrawl return the captcha shield page, not job listings.
  // No scrape path works without solving CAPTCHAs. CareerBee + Xing + Stepstone
  // already cover the DE market. NOTE it is also a tracked_companies entry with
  // no provider — do not "fix" it there either; the block is the same CAPTCHA.
};

// Run the self-test now that PORTALS exists, so its assertions can exercise the
// real portal extractors (not replicas). Token-free: the env checks above are
// skipped under --self-test. Exits 0 (pass) or 1 (fail).
if (has("--self-test")) { selfTest(); process.exit(0); }

// ─── Plan: build URL list ────────────────────────────────────────────────
function plan() {
  const urlsByPortal = new Map();
  const activePortals = ONLY_PORTAL ? [ONLY_PORTAL] : Object.keys(PORTALS);
  for (const portalKey of activePortals) {
    const portal = PORTALS[portalKey];
    if (!portal) continue;
    const list = [];
    const seenUrl = new Set();
    for (const q of QUERIES) {
      // q.city is OPTIONAL (added 2026-08-14) and scoped by cityFor() to the
      // portals in `city_portals` / CITY_DEFAULT_PORTALS — eFC only by default.
      // Out-of-scope portals get null and expand TOP_CITIES as they always did.
      // rolesFor() adds the German-language variants on the DACH-native boards
      // (2026-08-18); it returns [q.role] alone everywhere else, so every other
      // portal plans byte-identically to before.
      for (const role of rolesFor(q, portalKey)) {
      for (const u of portal.urls(role, q.country, PAGES, cityFor(q, portalKey))) {
        // Google-SERP discovery URLs carry the freshness window as tbs=qdr:hN,
        // so stale postings are never fetched. withRecency is a no-op on the
        // portals that build their own URLs — those are post-filtered instead.
        const url = WINDOW_HOURS ? withRecency(u, WINDOW_HOURS) : u;
        // Dedupe within the portal. A city-qualified query collapses onto the
        // identical URL on portals that ignore `city`, so without this every
        // city variant added to bulk_scrape.queries would double-fetch (and
        // double-bill) on the Google-SERP portals. Strictly a saving: it can
        // only ever drop an exact-duplicate fetch.
        if (seenUrl.has(url)) continue;
        seenUrl.add(url);
        // Record the role ACTUALLY queried, not q.role — otherwise a German
        // variant's rows are tagged with the English string and the per-role
        // yield stats silently credit the wrong query.
        list.push({ url, role, country: q.country, city: q.city || null, portal: portalKey });
      }
      }
    }
    urlsByPortal.set(portalKey, list);
  }
  return urlsByPortal;
}

// ─── Batched fetch ───────────────────────────────────────────────────────
async function bdFetch(urls, datasetId = DATASET_GENERIC) {
  const body = JSON.stringify({ input: urls.map(u => ({ url: u })) });
  const r = await fetch(bdEndpoint(datasetId), {
    method: "POST",
    headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body,
  });
  if (!r.ok) throw new Error(`BD HTTP ${r.status}: ${(await r.text()).slice(0,200)}`);
  const text = await r.text();
  // JSONL — split on newlines, tolerate malformed lines (long JD strings may contain raw \n)
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip */ }
  }
  return out;
}

// ─── Bright Data SERP zone (Google discovery) ────────────────────────────
// Returns Google organic results [{title, link}] for a google.com/search URL via
// the Web Unlocker SERP zone — reliable where the generic scraper gets blocked.
// 2026-08-11: retry + diagnosable errors.
//
// The 08-11 run logged 119 identical `SERP non-JSON (zone/parse)` failures and
// lost the entire SERP tier (LinkedIn, WTTJ, Indeed, Civil Service Jobs); only
// the Firecrawl portals produced anything. Investigating it took a full session
// because the old error threw away everything needed to explain itself: no HTTP
// status, no response body, and the same string for a bad zone, a rate limit, a
// captcha page and a network blip.
//
// The cause was neither config nor suspension. Verified after the fact: the same
// call returns HTTP 200 with valid JSON and 10 organic results, and 8 concurrent
// calls all succeed. What actually happened is that bd-bulk-scan fired at 08:06
// in a Task Scheduler catch-up burst on machine wake (it is scheduled 11:30),
// alongside morning-scan, on a host whose network had just come back. One
// transient window, and every query failed with no second attempt.
//
// So: retry transient faults (fetchWithRetry covers 429/5xx and network resets
// with jittered backoff), and when it still fails, SAY WHY.
async function bdSerp(googleUrl) {
  const u = googleUrl + (googleUrl.includes("?") ? "&" : "?") + "brd_json=1&num=20&hl=en";
  // An EMPTY 200 is Bright Data's silent-failure shape, and fetchWithRetry
  // cannot catch it: 200 is not a retryable status and nothing throws, so the
  // retry layer waves it through. Same defect the 08-10 fix caught in
  // batch/_autodraft_fetch_jds.mjs (a suspended/blipping unblocker answers 200
  // with a zero-byte body and reports the reason only in x-brd-err-* headers).
  // Seen live on 2026-08-11: `SERP non-JSON [unrecognised (0B)] http=200`.
  // So the emptiness check has to drive its own retry, outside fetchWithRetry.
  let r, body = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(res => setTimeout(res, 1500 * attempt + Math.floor(Math.random() * 400)));
    r = await fetchWithRetry("https://api.brightdata.com/request", {
      method: "POST",
      headers: { Authorization: "Bearer " + BD_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ zone: SERP_ZONE, url: u, format: "raw" }),
    }, { label: "bd-serp", retries: 3 });
    body = await r.text();
    if (body.trim().length > 0) break;
    const hdr = r.headers.get("x-brd-err-code") || r.headers.get("proxy-status") || "";
    console.error(`  bd-serp: empty 200 body (attempt ${attempt + 1}/3)${hdr ? " hdr=" + hdr : ""}`);
  }
  if (!r.ok) throw new Error(`SERP HTTP ${r.status}: ${body.slice(0, 120).replace(/\s+/g, " ")}`);
  let j;
  try {
    j = JSON.parse(body);
  } catch {
    // Name the shape when it is recognisable, so the log is actionable rather
    // than merely alarming. A 200 carrying HTML is the usual tell.
    const head = body.slice(0, 200).replace(/\s+/g, " ");
    const shape = /<!doctype html|<html/i.test(head) ? "HTML error page"
      : /rate.?limit|too many requests/i.test(head) ? "rate limited"
      : /captcha|unusual traffic/i.test(head) ? "captcha/bot wall"
      : /unauthor|invalid.*token|forbidden/i.test(head) ? "auth rejected (check BRIGHTDATA_API_KEY / zone)"
      : `unrecognised (${body.length}B)`;
    throw new Error(`SERP non-JSON [${shape}] zone=${SERP_ZONE} http=${r.status}: ${head.slice(0, 100)}`);
  }
  return Array.isArray(j.organic) ? j.organic : [];
}

// Feed SERP results to the existing markdown extractors unchanged: each organic
// result becomes a `[title](link)` line — exactly the shape the csjobs / linkedin /
// wttj / indeed extractors already parse out of markdown.
function organicToMarkdown(organic) {
  return (organic || [])
    .map((o) => `[${String(o.title || "").replace(/[\[\]]/g, " ").trim()}](${o.link || o.url || ""})`)
    .join("\n\n");
}

// ─── Clean-gate filters — keep Notion lean ───────────────────────────────
// Reject upstream so dirty rows never reach Notion. Categories:
//   1. Placeholder titles (extractor couldn't read the real title)
//   2. Seniority outside the configured target band (Senior/Lead/Junior/etc)
//   3. Wrong-tech / wrong-domain (Java dev, blockchain, iOS, embedded …)
//   4. No positive role match (REQUIRED — not "let auto-eval decide")
//   5. Wrong geography (India/SG/AU/US-only/etc) when location is known
//   6. Same-branch (company × city) collapse inside the run

// Title filter lists. Single source of truth = config/role-taxonomy.yml (same as
// scan.mjs). When present: TITLE_POS = taxonomy core+adjacent; TITLE_NEG =
// taxonomy exclusions UNIONed with the extra abbreviation guards below ("Sr.",
// "CTO", spaced variants) that the taxonomy doesn't carry. Falls back to the
// hardcoded arrays when the taxonomy file is absent.
const _NEG_EXTRA = [
  "Senior", "Sr.", "Sr ", "Lead ", "Staff ", "Principal", "Manager", "Head of",
  "Head Of", "VP", "Vice President", "Director", "CTO", "CDO", "Chief",
  // Enrolled-student / pre-graduate roles — PROHIBITED (2026-07-07 per operator).
  // Graduate / Junior / Trainee are IN scope (graduate-primary) so they are NOT
  // listed here — they used to be, which wrongly overrode the role-taxonomy widening.
  "Intern", "Internship", "Placement", "Apprentice", "Apprenticeship",
  "Werkstudent", "Working Student", "Praktikum", "Praktikant",
  // German pre-graduate terms (2026-08-18 per operator). Mirrors the
  // `match: substring` block in config/role-taxonomy.yml — kept in sync so the
  // fallback is not weaker than the taxonomy it stands in for.
  "Ausbildung", "Auszubildende", "Azubi", "Duales Studium", "Dualer Student",
  "Studentische Hilfskraft", "Umschulung", "Weiterbildung",
];
// Fallback counterpart to taxonomy `match: substring`. German compounds and
// inflections only — never short English terms, which need word boundaries.
const _NEG_EXTRA_SUBSTRING = [
  "Werkstudent", "Praktikum", "Praktikant", "Ausbildung", "Auszubildende",
  "Azubi", "Duales Studium", "Dualer Student", "Studentische Hilfskraft",
  "Umschulung", "Weiterbildung",
];
const _POS_FALLBACK = [
  "Analytics Engineer", "Data Scientist", "Data Engineer", "Data Analyst",
  "BI Engineer", "BI Analyst", "ML Engineer", "Machine Learning Engineer",
  "Machine Learning", "MLOps", "Business Intelligence", "Analytics Consultant",
  "Reporting Engineer", "Decision Scientist", "Applied Scientist",
  "Datenanalyst", "Dateningenieur", "Datenwissenschaftler",
];
const _titleTax = loadTaxonomy(".");
const _titleFilter = _titleTax ? deriveTitleFilter(_titleTax) : null;
const TITLE_NEG = _titleFilter ? [...new Set([..._titleFilter.negative, ..._NEG_EXTRA])] : _NEG_EXTRA;
const TITLE_NEG_SUBSTRING = [...new Set([
  ...(_titleFilter?.negativeSubstring || []), ..._NEG_EXTRA_SUBSTRING,
])];
const TITLE_NEG_SPEC = { negative: TITLE_NEG, negativeSubstring: TITLE_NEG_SUBSTRING };
const TITLE_POS = _titleFilter ? _titleFilter.positive : _POS_FALLBACK;
if (_titleFilter) {
  console.error(`bd-bulk-scan: title filter from role-taxonomy.yml — ${TITLE_POS.length} positive / ${TITLE_NEG.length} negative`);
}
const WRONG_TECH = [
  "solidity", "blockchain", "web3", "crypto",
  "salesforce admin", "salesforce developer",
  "ios developer", "android developer", "mobile developer",
  ".net developer", "c# developer", "java developer", "java engineer",
  "ruby on rails", "php developer", "wordpress developer",
  "embedded", "firmware", "fpga", "asic", "cobol", "mainframe",
  "sap basis", "oracle ebs", "oracle apps",
];
const PLACEHOLDER_TITLES = [
  "(unknown)", "(efc listing)", "(indeed listing)", "(wttj listing)",
  "(miig listing)", "(careerbee listing)", "(stepstone listing)",
  "(linkedin listing)", "(xing listing)", "(csjobs listing)",
];
// Block non-target geos when location is provided. Empty/unknown → pass.
const BLOCK_LOCATIONS = [
  "india", "bengaluru", "bangalore", "hyderabad", "mumbai", "pune", "chennai",
  "singapore", "hong kong", "tokyo", "japan", "korea",
  "australia", "sydney", "melbourne", "perth",
  "brazil", "são paulo", "sao paulo", "argentina", "mexico city",
  "dubai", "uae", "saudi", "tel aviv", "israel",
  "san francisco", "new york", "boston", "chicago", "los angeles",
  "seattle", "atlanta", "austin", "denver", "miami",
  "us only", "us-only", "usa only", "americas only",
  "canada only", "toronto", "vancouver", "montreal",
];

function passesFilter(job) {
  const t = (job.title || "").toLowerCase().trim();

  // (1) Drop placeholder titles — extractor failed to read real title,
  // these only create Undisclosed/junk rows. Better no row than dirty row.
  if (!t || PLACEHOLDER_TITLES.some(p => t.includes(p))) return false;

  // (2) Seniority band — strict reject. Graduate/Junior/Trainee ARE in scope
  // (role-taxonomy widening); Intern/Internship/Placement/Apprentice(ship)/
  // Werkstudent/Praktikum/Ausbildung are prohibited and live in TITLE_NEG. No
  // per-portal exemption — the band is uniform across every portal, including
  // Bright Network.
  //
  // Matching is delegated to matchNegative() so this scanner and morning-scan
  // agree. It word-bounds English terms and substring-matches the German ones:
  // this loop used to word-bound EVERYTHING, which let "Werkstudentin" and
  // "Ausbildungsplatz" through — a trailing \b cannot end mid-compound.
  if (matchNegative(t, TITLE_NEG_SPEC)) return false;

  // (3) Wrong-tech / wrong-domain
  for (const w of WRONG_TECH) {
    if (t.includes(w)) return false;
  }

  // (4) REQUIRE at least one positive role match. No "pass-through unknown".
  if (!TITLE_POS.some(p => t.includes(p.toLowerCase()))) return false;

  return true;
}

function passesLocation(job) {
  const loc = (job.location || "").toLowerCase().trim();
  if (!loc) return true;  // unknown location — defer to auto-eval

  for (const b of BLOCK_LOCATIONS) {
    if (loc.includes(b)) return false;
  }
  return true;
}

// Normalise company name for branch grouping (drop legal suffixes, lowercase)
function normCompany(c) {
  if (!c) return "";
  return c.toLowerCase()
    .replace(/\b(gmbh|ag|se|kg|kgaa|inc|incorporated|llc|ltd|limited|plc|bv|nv|sa|sàrl|sarl|spa|srl|sl|sas|gbr|oy|ab|as|holding|group)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Collapse same-(company, city) inside the run. Keeps the FIRST occurrence
// (which is usually the highest-yielding/freshest discovery URL).
function collapseBranchDupes(jobs) {
  const groups = new Map();
  for (const j of jobs) {
    const co = normCompany(j.company);
    const city = (j.location || "").toLowerCase().split(",")[0].trim();
    // No reliable company name, OR a portal whose rows lack city granularity so the
    // (company,city) key would wrongly fold distinct vacancies: "UK Civil Service"
    // (one umbrella name across hundreds of departments) and Bright Network (every
    // row is location "UK", so a company's multiple grad roles would collapse to one).
    // Keep each posting by URL instead.
    // Employer-site rows (2026-08-15) fall in the same bucket: they fall back to
    // the QUERY COUNTRY when the SERP title carries no city, so every Zalando
    // role reads location "Germany" and (company,city) would fold a whole board
    // down to one row per employer per run. On a direct employer board two Data
    // Engineer posts in Berlin are two real vacancies, not a syndicated branch
    // dupe, so key them by URL like the other exempt portals.
    if (!co || co.startsWith("undisclosed") || j.source_portal === "Civil Service Jobs" || j.source_portal === "Bright Network"
        || String(j.source_portal || "").startsWith("Employer site")) {
      groups.set(j.url, j);
      continue;
    }
    const k = `${co}|${city}`;
    if (!groups.has(k)) groups.set(k, j);
    // Else: drop (in-batch sibling collapsed)
  }
  return [...groups.values()];
}

// ─── URL canonicalisation + persistent dedup cache ──────────────────────
// Both moved to ./seen-ledger.mjs on 2026-08-12 (imported at the top of this
// file) so chrome-scan-visible dedups against the same ledger with the same
// key. Behaviour is unchanged; `node seen-ledger.mjs --self-test` pins the
// canonicalisation rules (query-string job ids for Civil Service/Indeed,
// Stepstone -inline.html, .html suffixes, encoding + case + trailing slash).

// ─── Main ────────────────────────────────────────────────────────────────
const start = Date.now();
const urlPlan = plan();
const totalUrls = [...urlPlan.values()].reduce((s, l) => s + l.length, 0);
console.error(`bd-bulk-scan: plan = ${totalUrls} URLs across ${urlPlan.size} portals, pages=${PAGES}`);

if (DRY_RUN) {
  for (const [p, list] of urlPlan) {
    console.log(`\n# ${p} (${list.length} URLs)`);
    list.slice(0, 3).forEach(x => console.log(`  ${x.url}`));
    if (list.length > 3) console.log(`  ...and ${list.length - 3} more`);
  }
  console.log("\n--- ROUTINE_CONTRACT ---");
  console.log("ROUTINE: bd-bulk-scan");
  console.log("MODE: dry-run");
  console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
  console.log(`URLS_PLANNED: ${totalUrls}`);
  console.log(`PAGES_PER_QUERY: ${PAGES}`);
  console.log("ERRORS: 0");
  console.log("--- END_ROUTINE_CONTRACT ---");
  process.exit(0);
}

const seen = NO_SEEN ? new Set() : loadSeen();
console.error(`bd-bulk-scan: local seen-cache loaded with ${seen.size} canonical URLs${NO_SEEN ? " (--probe: dedup disabled)" : ""}`);

// Pre-seed seen-cache with every Job URL already in Notion (last 90 days).
// This is the authoritative dedup gate — survives if data/bd-seen-urls.json
// is ever deleted or out of sync.
//
// ALSO builds a company+position(+city) map for the CROSS-PORTAL gate: the same
// vacancy posted on two portals has two unrelated URLs (e.g. Bitpanda AE on
// Xing AND eFinancialCareers, found 2026-07-19), so URL dedup can never catch
// it. A new job whose company + inferred position (+ compatible city) already
// exists in the window is skipped at insert.
function normCityKey(loc) {
  let s = String(loc || "").toLowerCase().split(/[,\/]/)[0].trim();
  for (const [a, b] of [["wien", "vienna"], ["münchen", "munich"], ["muenchen", "munich"], ["köln", "cologne"], ["koeln", "cologne"], ["frankfurt am main", "frankfurt"]]) {
    if (s.includes(a)) return b;
  }
  return s.replace(/[^a-z]/g, "");
}
const seenCompanyPos = new Map();  // "normCompany::Position" -> Set(normCity, may include "")
async function preloadNotionUrls() {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10);
  const filter = { property: "Discovered date", date: { on_or_after: ninetyDaysAgo } };
  let cursor = null, count = 0;
  do {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;
    let r;
    try {
      r = await fetchWithRetry(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${NOTION_TOKEN}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }, { label: "bd-bulk-scan notion-preload" });
    } catch (e) {
      // A network-layer failure is a THROW, not a non-ok response, so the
      // `if (!r.ok)` degrade path below never saw it. That is exactly how an
      // ECONNRESET against api.notion.com killed whole runs (264 URLs, 10
      // portals) on 2026-08-07 and in 19 other logs since June. The preload is
      // an optimisation over the local seen-cache, so failing it must degrade,
      // never abort.
      console.error(`bd-bulk-scan: Notion preload unreachable after retries (${e.code || e.message}) — relying on local cache only`);
      return 0;
    }
    if (!r.ok) {
      console.error(`bd-bulk-scan: Notion preload failed (${r.status}) — relying on local cache only`);
      return 0;
    }
    const data = await r.json();
    for (const row of data.results) {
      const P = row.properties || {};
      const u = P["Job URL"]?.url;
      if (u) { seen.add(canonicalUrl(u)); count++; }
      const comp = normCompany((P["Company"]?.title || []).map(o => o.plain_text).join(""));
      if (!comp || /undisclosed|confidential/.test(comp)) continue;
      const city = normCityKey((P["Location"]?.rich_text || []).map(o => o.plain_text).join(""));
      for (const pos of (P["Position"]?.multi_select || []).map(o => o.name)) {
        const k = comp + "::" + pos;
        if (!seenCompanyPos.has(k)) seenCompanyPos.set(k, new Set());
        seenCompanyPos.get(k).add(city);
      }
    }
    cursor = data.next_cursor;
  } while (cursor);
  return count;
}
// A new job is a cross-portal duplicate when its company+position key exists AND
// the city matches — or either side's city is unknown (freeform portal data).
// Different KNOWN cities stay separate rows (branch policy handles those).
function isCrossPortalDupe(j) {
  const comp = normCompany(j.company);
  if (!comp || /undisclosed|confidential/.test(comp)) return false;
  const city = normCityKey(j.location);
  for (const pos of inferPosition(j.title || j._role)) {
    const cities = seenCompanyPos.get(comp + "::" + pos);
    if (!cities) continue;
    if (cities.has(city) || city === "" || cities.has("")) return true;
  }
  return false;
}
const notionPreloaded = NO_SEEN ? 0 : await preloadNotionUrls();
console.error(`bd-bulk-scan: Notion-side preload added ${notionPreloaded} canonical URLs + ${seenCompanyPos.size} company-position keys → seen-cache now ${seen.size}`);

// --probe-xportal: exercise the LIVE cross-portal gate against real Notion data
// without scraping or writing. Derives its cases from the freshly-loaded map so
// it stays valid as the 90-day window rolls: takes a real (company,position,city)
// key as the positive, and a guaranteed-absent company as the negative. Confirms
// the exact isCrossPortalDupe() the insert loop uses. Exits 0 (pass) / 1 (fail).
if (has("--probe-xportal")) {
  const results = [];
  const check = (name, got, want) => { results.push({ name, pass: got === want, got, want }); };
  const firstKey = [...seenCompanyPos.keys()][0];
  if (!firstKey) {
    console.error("PROBE_XPORTAL: no company-position keys in window — cannot self-test (is the DB empty / token missing?)");
    process.exit(1);
  }
  const [compRaw, pos] = firstKey.split("::");
  const cities = seenCompanyPos.get(firstKey);
  const knownCity = [...cities].find((c) => c !== "") ?? "";
  // De-normalise a plausible display company + a title that inferPosition maps
  // back to `pos` (the canonical Position IS a valid title substring for all 6).
  const sampleJob = { company: compRaw, title: pos, location: knownCity, url: "https://probe.test/x", source_portal: "ProbeTest" };
  check(`positive: known ${compRaw.trim()}|${pos}|${knownCity || "(no-city)"} → dupe`, isCrossPortalDupe(sampleJob), true);
  // Unknown city on a known company+position: dupe when the candidate city is
  // unknown/empty (freeform portal data) — matches the OR-empty branch.
  check(`positive: known ${pos} w/ blank city → dupe`, isCrossPortalDupe({ ...sampleJob, location: "" }), true);
  // Guaranteed-absent company → not a dupe.
  check("negative: novel company → not dupe", isCrossPortalDupe({ ...sampleJob, company: "Zzq Nonexistent Probe Co GmbH" }), false);
  // Undisclosed company is never keyed → never a dupe.
  check("negative: Undisclosed company → not dupe", isCrossPortalDupe({ ...sampleJob, company: "Undisclosed (Indeed)" }), false);
  let failed = 0;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.pass ? "" : `  (got ${r.got}, want ${r.want})`}`);
    if (!r.pass) failed++;
  }
  console.log(`\nPROBE_XPORTAL: ${results.length - failed}/${results.length} passed against ${seenCompanyPos.size} live keys`);
  process.exit(failed ? 1 : 0);
}

const allJobs = [];
// Seeded from the PLAN, not lazily on first hit. A lazily-keyed object cannot
// express "this portal was fetched and produced nothing": the portal simply
// drops out of JOBS_PER_PORTAL, which reads as though it was never scheduled.
// On 2026-08-27 both direct-site portals (stepstone, efc) returned no usable
// rows for all 64 of their URLs and vanished from the contract line, while the
// run reported ERRORS: 1 and exited 0 — indistinguishable from a healthy run,
// and invisible to the watchdog's "zero across two consecutive runs" rule.
// Seeding means every planned portal reports :0 instead of disappearing.
const portalCounts = {};
for (const portalKey of urlPlan.keys()) portalCounts[portalKey] = 0;
const errors = [];

// Portals routed through self-hosted Firecrawl (BD returns unhydrated React
// shells for these — 0 job URLs in BD markdown/html). Sequential CLI calls
// against localhost:3002 with wait_for so the JS app renders before scrape.
const FIRECRAWL_PORTALS = new Set(["xing", "careerbee", "sponsoredjobs"]);

// Flatten urls + remember portal mapping
const flat = [];
const fcFlat = [];  // routed through Firecrawl
for (const [portalKey, list] of urlPlan) {
  for (const item of list) {
    if (FIRECRAWL_PORTALS.has(portalKey)) fcFlat.push({ ...item, portalKey });
    else flat.push({ ...item, portalKey });
  }
}

// ─── Firecrawl-routed portals (self-hosted, no API key) ──────────────────
// 2026-06-05: BD's generic dataset scraper returns unhydrated React shells
// for Xing, CareerBee, and Make-it-in-Germany — 0 job URLs in markdown/html.
// Firecrawl with wait_for renders the JS app. Sequential, ~5s per URL.
if (fcFlat.length > 0 && !DRY_RUN) {
  const portalBreakdown = [...new Set(fcFlat.map(x => x.portalKey))].map(k => `${k}:${fcFlat.filter(x=>x.portalKey===k).length}`).join(", ");
  console.error(`  firecrawl: ${fcFlat.length} URLs (${portalBreakdown}) via ${FIRECRAWL_URL} (self-hosted, no API key)`);
  const fcUp = await firecrawlPingWithRecovery();
  if (!fcUp) {
    const affected = [...new Set(fcFlat.map(x => x.portalKey))].join(", ");
    errors.push(`firecrawl_down: ${FIRECRAWL_URL} not reachable — Firecrawl portals skipped. Start the daemon with: docker compose up -d (in firecrawl checkout)`);
    console.error(`  firecrawl: DOWN at ${FIRECRAWL_URL} — skipping all ${fcFlat.length} Firecrawl URLs`);
    // Machine-greppable marker for the watchdog. Before 2026-08-09 nothing in
    // system-eval.mjs knew Firecrawl existed, which is how Xing and CareerBee
    // stayed dead for weeks without a single alert. Keep this string and the
    // pattern in system-eval.mjs ROUTINE_LOG_SIGNALS in step.
    console.error(`  FIRECRAWL_DOWN_ALERT: ${fcFlat.length} URLs skipped across [${affected}] — these portals produced ZERO rows this run`);
  } else {
    for (let i = 0; i < fcFlat.length; i += MAX_BATCH) {
      const chunk = fcFlat.slice(i, i + MAX_BATCH);
      const urls = chunk.map(x => x.url);
      const results = firecrawlFetch(urls);
      for (const r of results) {
        const inputUrl = r.input.url;
        const meta = chunk.find(c => c.url === inputUrl);
        if (!meta) continue;
        const portal = PORTALS[meta.portalKey];
        if (!portal) continue;
        if (r.error) { errors.push(`${meta.portalKey} ${inputUrl.slice(-60)}: ${r.error.slice(0,80)}`); continue; }
        const jobs = portal.extract(r.markdown || "", inputUrl, r.page_html || "");
        let added = 0;
        for (const j of jobs) {
          const cu = canonicalUrl(j.url);
          if (seen.has(cu)) continue;
          if (!passesFilter(j)) continue;
          if (!passesLocation(j)) continue;
          seen.add(cu);
          j._role = meta.role; j._country = meta.country;
          allJobs.push(j);
          added++;
        }
        portalCounts[meta.portalKey] = (portalCounts[meta.portalKey] || 0) + added;
      }
    }
  }
}

// Pending two-stage queue: discovered URLs awaiting enrichment
const enrichmentQueue = []; // [{url, role, country, portalKey}]

// Shared ingest: dedup, defer two-stage URLs to Stage B, filter, collect.
function ingestJobs(jobs, meta) {
  let added = 0;
  for (const j of jobs) {
    const cu = canonicalUrl(j.url);
    if (seen.has(cu)) { if (process.env.SERP_DEBUG) console.error(`      drop[seen] ${meta.portalKey}: ${j.title}`); continue; }
    if (j._needs_enrichment) {
      enrichmentQueue.push({ url: j.url, role: meta.role, country: meta.country, portalKey: meta.portalKey });
      added++;
      continue;
    }
    if (!passesFilter(j)) { if (process.env.SERP_DEBUG) console.error(`      drop[filter] ${meta.portalKey}: ${j.title}`); continue; }
    if (!passesLocation(j)) { if (process.env.SERP_DEBUG) console.error(`      drop[loc] ${meta.portalKey}: ${j.title} @ ${j.location}`); continue; }
    seen.add(cu);
    j._role = meta.role; j._country = meta.country;
    allJobs.push(j);
    added++;
  }
  portalCounts[meta.portalKey] = (portalCounts[meta.portalKey] || 0) + added;
}

// Split discovery: Google-SERP portals (linkedin/wttj/indeed/csjobs) go through the
// dedicated SERP zone (reliable Google parsing); direct site URLs (stepstone/efc/
// sponsoredjobs) go through the generic dataset scraper as before.
const isSerp = (u) => u.startsWith("https://www.google.com/search");
const serpFlat = flat.filter((x) => isSerp(x.url));
const directFlat = flat.filter((x) => !isSerp(x.url));

// ── Stage A(i): SERP discovery via the Unlocker zone (concurrency-limited) ──
if (serpFlat.length) {
  if (!BD_API_KEY) {
    errors.push(`serp_no_key: BRIGHTDATA_API_KEY not set — ${serpFlat.length} SERP URLs (linkedin/wttj/indeed/csjobs) skipped`);
    console.error(`  SERP: BRIGHTDATA_API_KEY missing — skipping ${serpFlat.length} SERP URLs`);
  } else {
    console.error(`  SERP: ${serpFlat.length} Google queries via zone '${SERP_ZONE}' (concurrency ${SERP_CONCURRENCY})`);
    for (let i = 0; i < serpFlat.length; i += SERP_CONCURRENCY) {
      const group = serpFlat.slice(i, i + SERP_CONCURRENCY);
      await Promise.all(group.map(async (meta) => {
        let organic;
        try { organic = await bdSerp(meta.url); }
        catch (e) { errors.push(`serp_fail (${meta.portalKey}): ${e.message}`); return; }
        const portal = PORTALS[meta.portalKey];
        if (!portal) return;
        const _jobs = portal.extract(organicToMarkdown(organic), meta.url, "", meta.role, meta.country);
        if (process.env.SERP_DEBUG) console.error(`    serp ${meta.portalKey} [${meta.role}]: ${organic.length} organic → ${_jobs.length} extracted`);
        ingestJobs(_jobs, meta);
      }));
    }
  }
}

// ── Stage A(ii): direct-site discovery via the dataset scraper ──
for (let i = 0; i < directFlat.length; i += MAX_BATCH) {
  const chunk = directFlat.slice(i, i + MAX_BATCH);
  const urls = chunk.map((x) => x.url);
  console.error(`  batch ${Math.floor(i / MAX_BATCH) + 1}: ${urls.length} URLs (direct discovery)...`);
  let results;
  try {
    results = await bdFetch(urls, DATASET_GENERIC);
  } catch (e) {
    errors.push(`batch_fail (${[...new Set(chunk.map((c) => c.portalKey))].join("/")}): ${e.message}`);
    continue;
  }
  // Which of this batch's URLs came back at all. `results` is built from the
  // JSONL rows BD actually returned, so a URL it omits never enters the loop
  // below — and a row whose URL no longer matches its request (redirect) fails
  // chunk.find() and is dropped by `!meta`. Both are silent: no error, no
  // portalCounts key, no trace in the contract. Recording what matched lets us
  // name what didn't.
  const matched = new Set();
  for (const r of results) {
    const inputUrl = (r.input && r.input.url) || r.url;
    const meta = chunk.find((c) => c.url === inputUrl || inputUrl?.startsWith(c.url.split("?")[0]));
    if (!meta) continue;
    matched.add(meta.url);
    const portal = PORTALS[meta.portalKey];
    if (!portal) continue;
    const md = r.markdown || "";
    const html = r.page_html || "";
    if (!md && !html && r.error) {
      errors.push(`${meta.portalKey} ${inputUrl}: ${String(r.error).slice(0, 80)}`);
      continue;
    }
    ingestJobs(portal.extract(md, inputUrl, html, meta.role, meta.country), meta);
  }
  // Aggregate per portal rather than emitting one error per URL: a whole-tier
  // outage is 64 lines of identical noise, and ERROR_DETAILS is truncated.
  const missedByPortal = {};
  for (const c of chunk) if (!matched.has(c.url)) missedByPortal[c.portalKey] = (missedByPortal[c.portalKey] || 0) + 1;
  for (const [p, n] of Object.entries(missedByPortal)) {
    const planned = chunk.filter((c) => c.portalKey === p).length;
    errors.push(`no_result (${p}): ${n}/${planned} URLs returned no attributable row from the dataset scraper`);
  }
}

// Stage B: enrich LinkedIn (and any other two-stage portals) via dataset scraper
if (enrichmentQueue.length > 0) {
  console.error(`  Stage B: enriching ${enrichmentQueue.length} URLs via LinkedIn dataset...`);
  // Group by portal so we use the right dataset id
  const byPortal = {};
  for (const q of enrichmentQueue) (byPortal[q.portalKey] ||= []).push(q);
  for (const [portalKey, queue] of Object.entries(byPortal)) {
    const datasetId = portalKey === "linkedin" ? DATASET_LINKEDIN : DATASET_GENERIC;
    const isLinkedIn = portalKey === "linkedin";
    const isWttj = portalKey === "wttj";
    const isIndeed = portalKey === "indeed";
    // Batch enrichment URLs in groups of MAX_BATCH
    for (let i = 0; i < queue.length; i += MAX_BATCH) {
      const chunk = queue.slice(i, i + MAX_BATCH);
      const urls = chunk.map(x => x.url);
      let results;
      try {
        results = await bdFetch(urls, datasetId);
      } catch (e) {
        errors.push(`enrich_batch_fail (${portalKey}): ${e.message}`);
        continue;
      }
      for (const r of results) {
        const inputUrl = (r.input && r.input.url) || r.url;
        const meta = chunk.find(c => c.url === inputUrl || inputUrl?.startsWith(c.url));
        if (!meta) continue;
        if (r.error) {
          // Dead listing — count as discovered but don't write (job expired between SERP and enrichment)
          continue;
        }
        let job;
        if (isLinkedIn) {
          // LinkedIn dataset returns rich structured fields directly
          job = {
            url: inputUrl,
            title: r.job_title || "(unknown)",
            company: r.company_name || "Undisclosed (LinkedIn)",
            location: r.job_location || "",
            source_portal: "LinkedIn",
            jd_summary: r.job_summary || r.job_description_formatted || "",
            employment_type: r.job_employment_type || "",
            posted_time: r.job_posted_time || "",
            applicant_count: r.job_num_applicants,
            easy_apply: r.is_easy_apply,
          };
        } else if (isWttj) {
          // WTTJ enriched via DATASET_GENERIC → page_title gives
          // "Role – Company – Permanent contract in City"
          const md = r.markdown || "";
          const pt = r.page_title || "";
          // Parse title format: "Role – Company – Permanent contract in City"
          const partsDash = pt.split(/\s*[–—-]\s*/);
          let title = "", company = "Undisclosed (WTTJ)", location = "";
          if (partsDash.length >= 3) {
            title = partsDash[0].trim();
            company = partsDash[1].trim();
            const tail = partsDash.slice(2).join(" - ");
            const locMatch = tail.match(/in\s+(.+?)(?:\s*$|\s*\|)/i);
            location = locMatch ? locMatch[1].trim() : tail.trim();
          } else {
            // Fallback: parse URL slug
            const m = inputUrl.match(/\/companies\/([^/]+)\/jobs\/([^_]+(?:_[^_]+)*)_([^_]+)(?:_[a-z0-9]+)?$/i);
            if (m) {
              company = decodeURIComponent(m[1]).replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase());
              title = decodeURIComponent(m[2]).replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase());
              location = decodeURIComponent(m[3]).replace(/-/g," ").replace(/\b\w/g, c => c.toUpperCase());
            }
          }
          job = {
            url: inputUrl,
            title: title || "(WTTJ listing)",
            company,
            location,
            source_portal: "WelcomeToTheJungle",
            jd_summary: md.slice(0, 1500),
          };
        } else if (isIndeed) {
          const md = r.markdown || "";
          // Cloudflare challenge instead of the job page → treat as dead, don't write
          if (/just a moment|verify you are (?:a )?human|attention required|cf-chl|enable javascript and cookies/i.test(md.slice(0, 800))) {
            continue;
          }
          // page_title is usually "Role - Location - Company | Indeed.com" or
          // "Role - Company - Location - Indeed.com"; strip the suffix, split,
          // and let the DACH/city heuristics downstream sort location.
          const pt = (r.page_title || "").replace(/\s*[-|–]\s*Indeed(\.com)?\s*$/i, "").trim();
          const parts = pt.split(/\s+[-–|]\s+/);
          let title = (parts[0] || "").trim();
          let company = "Undisclosed (Indeed)", location = "";
          if (parts.length >= 3) { company = parts[2].trim(); location = parts[1].trim(); }
          else if (parts.length === 2) { location = parts[1].trim(); }
          // Company fallback from markdown ("hiringOrganization" style header links)
          if (company === "Undisclosed (Indeed)") {
            const cm = md.match(/^#{1,3}\s*(?:About\s+)?([A-Z][\w&.\- ]{2,60})\s*$/m);
            if (cm) company = cm[1].trim();
          }
          job = {
            url: inputUrl,
            title: title || "(indeed listing)",
            company,
            location,
            source_portal: "Indeed",
            jd_summary: md.slice(0, 1500),
          };
        } else {
          // (csjobs is single-stage since 2026-07-03 — its detail pages are
          // human-checked even via BD, so titles come from the SERP instead.)
          continue;
        }
        const cu = canonicalUrl(job.url);
        if (seen.has(cu)) continue;
        if (!passesFilter(job)) continue;
        if (!passesLocation(job)) continue;
        seen.add(cu);
        job._role = meta.role; job._country = meta.country;
        allJobs.push(job);
        portalCounts[portalKey] = (portalCounts[portalKey] || 0) + 1;
      }
    }
  }
}

// Xing and StepStone-DE are DACH-EXCLUSIVE boards: their jobs are always in
// DE/AT/CH regardless of which search query surfaced them. `job._country` comes
// from the SEARCH meta, so a Xing job found under a "UK" query gets mis-tagged
// UK (the source of APP-2557/2196/2198/2204/2207/2242). Override from the URL
// city for those boards. cv/writing-eval.mjs COUNTRY_SUSPECT is the back-stop.
// ─── Country + position + Stage-1 write: SHARED, see notion-stage1.mjs ───
// These six functions (dachCountryFromUrl, normCountry, countryFromLocation,
// resolveCountry, inferPosition, notionCreatePage) lived here and ONLY here,
// which is why morning-scan had no way to write a Stage-1 row and silently
// dropped every hit it found for weeks. Moved verbatim to notion-stage1.mjs on
// 2026-08-11 so both scanners tag Country and Position identically. Editing a
// private copy here would reintroduce exactly the drift that
// [[country-from-location-not-query]] documents - change the shared module.
async function notionCreatePage(job) {
  return createStage1Row(job, {
    notionToken: NOTION_TOKEN,
    databaseId: DATABASE_ID,
    scanner: 'bd-bulk-scan',
  });
}
// ─── Pre-Notion clean gate: in-batch branch dedup ────────────────────────
// ── Xing JD enrichment + syndication fold (2026-07-13) ───────────────────────
// The Xing SEARCH page only exposes a slug-derived title + "Undisclosed (Xing)"
// company — low-signal for eval AND unable to dedup staffing-agency syndication
// (one client role posted across dozens of city-slug URLs as distinct listings).
// Read each Xing detail page's real company + title from Xing's stable data-testid
// header (parseXingDetail), then fold same-(company, title) rows to one. Enrichment
// failures keep the slug values (never drops a job). Steady-state cost is low: only
// NET-NEW Xing rows reach here (already-seen URLs were dropped by the seen-cache).
{
  const xingRows = allJobs.filter((j) => j.source_portal === "Xing");
  if (xingRows.length && !DRY_RUN) {
    console.error(`  xing-enrich: reading ${xingRows.length} Xing detail pages for real company/title...`);
    const normT = (s) => (s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\b(m|w|d|gn|all genders)\b/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    const sig = new Set();
    const kept = [];
    let enriched = 0, folded = 0, refiltered = 0;
    for (const j of allJobs) {
      if (j.source_portal !== "Xing") { kept.push(j); continue; }
      const en = enrichXingDetail(j.url);
      if (en) {
        if (en.company) j.company = en.company;
        if (en.title) j.title = en.title;
        j.jd_summary = "[xing: company+title read from detail page]";
        enriched++;
      }
      // Re-apply the title band on the REAL title (may reveal a Senior/Lead the
      // slug hid, or confirm a clean role).
      if (!passesFilter(j)) { refiltered++; continue; }
      const k = normCompany(j.company) + "::" + normT(j.title);
      if (sig.has(k)) { folded++; continue; }   // fold agency syndication
      sig.add(k);
      kept.push(j);
    }
    console.error(`  xing-enrich: enriched ${enriched}/${xingRows.length}, folded ${folded} syndicated dupes, dropped ${refiltered} on real-title filter`);
    allJobs.length = 0;
    allJobs.push(...kept);
    // Keep JOBS_PER_PORTAL honest: reflect the post-fold Xing count, not the raw
    // pre-enrichment extraction (which counted every syndicated city-slug).
    portalCounts.xing = kept.filter((j) => j.source_portal === "Xing").length;
  }
}

// Freshness post-filter — the backstop for portals fetched by their own URLs
// (stepstone, xing, careerbee, efc, sponsoredjobs), which have no query
// operator we can set without risking a silent zero-yield. Runs over every
// portal so the SERP ones get a second check on their enriched posted dates.
// Jobs with no readable date are kept; the kept-unknown count is printed and
// put in the contract so a portal that stops emitting dates is visible rather
// than quietly turning the filter off.
let freshnessDropped = 0, freshnessUnknown = 0;
if (WINDOW_HOURS) {
  const before = allJobs.length;
  const { fresh, stale, unknown } = partitionByFreshness(allJobs, WINDOW_HOURS, RUN_STARTED_ISO);
  freshnessDropped = stale.length;
  freshnessUnknown = unknown.length;
  const staleByPortal = {};
  for (const j of stale) staleByPortal[j.source_portal || "?"] = (staleByPortal[j.source_portal || "?"] || 0) + 1;
  allJobs.length = 0;
  allJobs.push(...fresh);
  const wm = readWatermark();
  console.error(
    `bd-bulk-scan: freshness window ${WINDOW_HOURS}h (` +
    `${wm ? `since last scan ${wm.last_scan_iso}` : "no watermark — first run, 24h default"}): ` +
    `dropped ${freshnessDropped} stale (${before} → ${allJobs.length}), kept ${freshnessUnknown} undated` +
    (freshnessDropped ? ` | stale by portal: ${Object.entries(staleByPortal).map(([k, v]) => `${k}:${v}`).join(",")}` : ""),
  );
} else {
  console.error("bd-bulk-scan: --no-freshness — scanning full history, watermark NOT advanced");
}

const beforeCollapse = allJobs.length;
const cleanJobs = collapseBranchDupes(allJobs);
const branchCollapsed = beforeCollapse - cleanJobs.length;
console.error(`bd-bulk-scan: in-batch branch dedup collapsed ${branchCollapsed} same-(company,city) duplicates (${beforeCollapse} → ${cleanJobs.length})`);

let written = 0, writeFails = 0, crossPortalSkipped = 0;
if (NO_WRITE) {
  console.error(`bd-bulk-scan: --no-write/--probe — skipping ${cleanJobs.length} Notion inserts + seen-cache save`);
} else {
  for (const j of cleanJobs) {
    if (!NO_SEEN && isCrossPortalDupe(j)) {
      crossPortalSkipped++;
      seen.add(canonicalUrl(j.url));  // remember this portal's URL for the same vacancy
      console.error(`  drop[cross-portal] ${j.source_portal}: ${(j.company || "").slice(0, 30)} | ${(j.title || "").slice(0, 40)}`);
      continue;
    }
    try { await notionCreatePage(j); written++; } catch (e) { writeFails++; errors.push(`notion_write: ${e.message.slice(0,80)}`); }
  }
  if (crossPortalSkipped) console.error(`bd-bulk-scan: cross-portal gate skipped ${crossPortalSkipped} already-tracked vacancies (same company+position in Notion window)`);
  saveSeen(seen);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const portalBreakdown = Object.entries(portalCounts).map(([k,v]) => `${k}:${v}`).join(",");

// Advance the watermark only on a run that actually reached the portals and
// was allowed to write. Advancing after a fetch outage would silently skip
// whatever was posted during it; leaving it put makes the NEXT run widen its
// window to cover the gap instead.
let watermarkAdvanced = false;
if (WINDOW_HOURS && !NO_WRITE && flat.length > 0 && writeFails === 0) {
  writeWatermark(RUN_STARTED_ISO, {
    window_hours_used: WINDOW_HOURS,
    urls_fetched: flat.length,
    jobs_found: cleanJobs.length,
    note: "Set by bd-bulk-scan after a successful run; the next run scans forward from here.",
  });
  watermarkAdvanced = true;
} else if (WINDOW_HOURS && !NO_WRITE) {
  console.error(
    `bd-bulk-scan: watermark NOT advanced (urls_fetched=${flat.length}, write_failures=${writeFails}) — ` +
    "next run will widen its window to cover this gap",
  );
}

console.log("\n--- ROUTINE_CONTRACT ---");
console.log("ROUTINE: bd-bulk-scan");
console.log(`TIMESTAMP_UTC: ${new Date().toISOString()}`);
console.log(`URLS_FETCHED: ${flat.length}`);
console.log(`PORTALS_HIT: ${urlPlan.size}`);
console.log(`JOBS_AFTER_FILTER: ${allJobs.length}`);
console.log(`BRANCH_COLLAPSED: ${branchCollapsed}`);
console.log(`JOBS_FOUND: ${cleanJobs.length}`);
console.log(`JOBS_PER_PORTAL: ${portalBreakdown}`);
console.log(`FRESHNESS_WINDOW_HOURS: ${WINDOW_HOURS ?? "off"}`);
console.log(`FRESHNESS_DROPPED_STALE: ${freshnessDropped}`);
console.log(`FRESHNESS_KEPT_UNDATED: ${freshnessUnknown}`);
console.log(`WATERMARK_ADVANCED: ${watermarkAdvanced}`);
console.log(`NOTION_ROWS_WRITTEN: ${written}`);
console.log(`NOTION_WRITE_FAILURES: ${writeFails}`);
console.log(`SEEN_CACHE_SIZE: ${seen.size}`);
console.log(`ELAPSED_SEC: ${elapsed}`);
console.log(`ERRORS: ${errors.length}`);
if (errors.length) {
  console.log("ERROR_DETAILS: |");
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
}
console.log("--- END_ROUTINE_CONTRACT ---");

// Fail loudly if the SERP portals were dropped for a missing BRIGHTDATA_API_KEY —
// otherwise direct-portal yield masks the loss of the 4 highest-volume portals and
// the run exits "ok" (fail-open). The scheduler preflight also requires the key.
const serpDroppedNoKey = errors.some((e) => e.startsWith("serp_no_key"));
process.exit((serpDroppedNoKey || (errors.length && allJobs.length === 0)) ? 1 : 0);
