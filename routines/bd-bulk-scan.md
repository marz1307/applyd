# Routine: BD-Bulk-Scan (Bright Data Dataset Scraper)

**PURE-SCRIPT ROUTINE (2026-05-28).** This routine is invoked directly via `node scripts/scan/bd-bulk-scan.mjs` by `run-routine.ps1` — there is no agent-CLI LLM call in the path. The script is fully deterministic and prints its own ROUTINE_CONTRACT block to stdout. This file is reference documentation only; the wrapper does NOT read it.

## Owner

Windows Task Scheduler → `routines/run-routine.ps1` → `node scripts/scan/bd-bulk-scan.mjs`. **Sole high-volume scraper** as of 2026-05-28 (Apify retired — see below). Covers:

- **Non-auth-walled portals (direct scrape):** Stepstone, Indeed, Xing, CareerBee, Make-it-in-Germany, eFinancialCareers.
- **Auth-walled portals (two-stage SERP discovery → BD dataset enrichment):** LinkedIn, Welcome to the Jungle.

Feeds Notion DB at Stage 1.

## Why this exists (and why Apify is retired)

Verified 2026-05-28 vs Apify head-to-head on Stepstone Analytics Engineer search:

| Method | Jobs / call | Speed | Cost-est |
|---|---|---|---|
| Apify `blackfalcondata/stepstone-jobs-feed` | ~30 | 5-10 min | ~$0.15 |
| **BD Dataset Scraper (5 pages batched)** | **125** | **7 seconds** | **~$0.005** |

~4× more jobs, ~50× faster, ~30× cheaper. The LinkedIn + WTTJ gap (where the generic scraper alone fails) is now closed via two-stage SERP-discovery + dataset-enrichment, so Apify no longer has a unique role. `apify-bulk-scan` was retired 2026-05-28 (Task Scheduler jobs removed, routine .md deleted).

## Goal

For each `(role, country)` in `apify.queries`, build paginated URLs across the 5 BD-friendly portals, batch them through the BD Dataset Scraper API (`gd_m6gjtfmeh43we6cqc`), parse the returned markdown to extract job links, filter, dedup, write surviving rows to Notion at Stage 1.

## Config

Reads from `config/profile.yml`:
- `apify.queries` (reused — same role × country catalog)
- `apify.country_top_cities` (used for Xing fan-out)
- `notion.applications_database_id`

Reads from env:
- `BRIGHTDATA_DATASET_TOKEN` — UUID-style token (separate from `BRIGHTDATA_API_KEY` used for Web Unlocker / SERP)
- `NOTION_TOKEN`

## Pre-flight (fail fast)

1. `cwd` must be repo root.
2. `BRIGHTDATA_DATASET_TOKEN` and `NOTION_TOKEN` must be set. If not, `ROUTINE_ABORT`.
3. `node scripts/scan/bd-bulk-scan.mjs --dry-run` must complete and print the URL plan.

## Steps

The wrapper runs this directly:

```
cmd /c node scripts/scan/bd-bulk-scan.mjs >> data\routine-logs\bd-bulk-scan-<ts>.log 2>&1
```

The script:
   - Builds the URL plan: 5 portals × 16 queries × 5 pages = up to ~400 URLs
   - Batches into groups of 25 URLs per API call (configurable via `--max-batch`)
   - POSTs to `https://api.brightdata.com/datasets/v3/scrape?dataset_id=gd_m6gjtfmeh43we6cqc&notify=false&include_errors=true` with `{"input":[{"url":...}]}` array
   - Per result, runs portal-specific extractor on the returned markdown:
     * Stepstone: `/stellenangebote--{title-city-company}--{id}-inline.html` slug pattern
     * Indeed: `jk={hex-id}` query parameter
     * Xing: `/jobs/{slug}-{id}` pattern
     * CareerBee: `/jobs/{slug}` pattern
     * Make-it-in-Germany: `/jobs/{...}` pattern
   - Applies same title-negative band as `scan.mjs` (Senior/Lead/Junior/etc.)
   - Dedups via `data/bd-seen-urls.json` (persistent cross-run cache) + intra-batch
   - Writes survivors to Notion via REST `/v1/pages` POST

**Output contract** is emitted to stdout by the .mjs itself. The wrapper greps the raw log for the `--- ROUTINE_CONTRACT ---` / `--- END_ROUTINE_CONTRACT ---` delimiters. No LLM in the path means no paraphrasing risk.

**No git commit** — Notion is the system of record.

## URL builders per portal

```
Stepstone:    https://www.stepstone.de/jobs/{slug(role)}?action=search[&page=N]
              (DACH only; geo-aware)

Indeed:       https://{tld}.indeed.com/jobs?q={role}&l={country}&start={N*15}
              (DE/UK)

Xing:         https://www.xing.com/jobs/search?keywords={role}&location={city}[&page=N]
              (Fans out to top 3 cities per country)

CareerBee:    https://www.careerbee.io/jobs/[page/N/]?s={role}
              (Germany only)

MIIG:         https://www.make-it-in-germany.com/en/working-in-germany/job-listings?L=0&tx_solr[q]={role}
              (Single result page; no pagination support)
```

## Output contract

```
--- ROUTINE_CONTRACT ---
ROUTINE: bd-bulk-scan
TIMESTAMP_UTC: {iso}
URLS_FETCHED: {n}
PORTALS_HIT: 5
JOBS_FOUND: {n}                     # after title-band filter + dedup
JOBS_PER_PORTAL: stepstone:N,indeed:M,xing:M,careerbee:M,make-it-in-germany:M
NOTION_ROWS_WRITTEN: {n}
NOTION_WRITE_FAILURES: {n}
SEEN_CACHE_SIZE: {n}                # persistent dedup cache
ELAPSED_SEC: {f}
ERRORS: {n}
ERROR_DETAILS: |
  {one per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- **Single batch HTTP failure** → logged to ERROR_DETAILS, skip that batch, continue.
- **Notion write 5xx/429** → silently retried by `fetchWithRetry` style backoff (built into the script).
- **All URLs failed** → exit 1 (wrapper marks as RUNTIME_ERROR).
- **Some succeeded** → exit 0 with non-zero ERRORS, wrapper records as WITH_ERRORS but doesn't toast (per `Test-NeedsManualAttention`).

## Cost / budget guard

BD scraper bills per URL fetched. Default plan = 80-400 URLs/run. Approximate cost per run = $0.40-$2.00 at standard dataset pricing. No hard quota; monitor via Bright Data dashboard.

If a future run exceeds 1000 URLs in plan, abort with `ROUTINE_ABORT: bd-bulk-scan plan exceeds 1000 URLs — refine queries first`.

## Schedule

| Day | Time | Routine |
|---|---|---|
| Mon, Fri | 13:00 UK | bd-bulk-scan |
| Tue, Wed, Thu | 05:55 UK | bd-bulk-scan_Tue/Wed/Thu |

## What this routine does NOT do

- Does not run auto-eval or auto-draft.
- Does not commit to git.
- Does not scrape individual job description pages — that's `auto-eval`'s job-by-job HTTP fetch on the Job URL.
