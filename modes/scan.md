# Mode: scan — Portal Scanner (Offer Discovery)

Scan the configured job portals, filter by title relevance, and add new postings to the pipeline for downstream evaluation.

> **Note (v1.6+):** The default scanner (`scripts/scan/scan.mjs` / `npm run scan`) is **zero-token** and uses structured sources: per-company local parsers and the public Greenhouse, Ashby, and Lever APIs. The browser-automation / web-search levels described below are the **agent flow** (executed by the coding agent), not what `scripts/scan/scan.mjs` itself does. If a company has neither a local parser nor a Greenhouse/Ashby/Lever API, `scripts/scan/scan.mjs` will skip it; for those cases the agent should complete Level 1 (browser) or Level 3 (search) manually.
>
> **Rule (v1.8+):** If a company's local parser succeeds at Level 0, the agent **must not** repeat it in browser automation (Level 1) or in API (Level 2). At Level 3, generic queries stay active but results from companies already covered by a local parser are discarded. See [Rule: successful local parser — don't repeat expensive scraping](#rule-successful-local-parser--dont-repeat-expensive-scraping).

## Recommended execution

Run as a background subagent (if your agent supports it) so it doesn't consume context from the main session. Under Claude Code:

```
Agent(
    subagent_type="general-purpose",
    prompt="[contents of this file + specific data]",
    run_in_background=True
)
```

Under other agents, use whatever equivalent is available (Codex sub-run, a separate terminal, `nohup`, …).

## Configuration

Read `portals.yml`, which contains:

- `search_queries`: list of web-search queries with `site:` filters per portal (broad discovery)
- `tracked_companies`: specific companies with `careers_url` for direct navigation
- `tracked_companies[].parser`: optional local parser for SSR or stable HTML pages
- `title_filter`: positive / negative / seniority keywords for title filtering
- `location_filter`: country / city allow + block lists

**Optional tiered role taxonomy.** The title filter can instead be driven by `config/role-taxonomy.yml` — copy `config/role-taxonomy.example.yml` to enable it. When present, `scripts/scan/scan.mjs` derives the filter from it (core + adjacent tiers → positive, exclusions → negative; `watch` tier added only with `node scripts/scan/scan.mjs --include-watch`) and logs `[title-filter] role-taxonomy.yml → …`. Delete the file to revert to `portals.yml`'s `title_filter`. Default behaviour (no taxonomy file) is unchanged.

## Discovery strategy (4 levels)

### Level 0 — Local parser (CHEAPEST)

**For each company in `tracked_companies` with `parser:` configured:** run the local parser defined in `portals.yml`. This level is ideal when the careers page uses SSR or stable HTML and a local script (JavaScript, Python, or any other runtime) already extracts the jobs without help from the agent.

Recommended contract:

```yaml
- name: Example Company
  careers_url: https://example.com/careers
  scan_method: local_parser
  parser:
    command: node
    script: scripts/parsers/example-company-jobs.js
    format: jobs-json-v1
  enabled: true
```

Most parsers are company-specific and already know the URL, selectors, and pagination. `args` is optional and may be used as the parser author needs — to reuse the script across companies, pass `{careers_url}` or `{company}`, enable a debug flag, save a JSON snapshot, or control any parser-internal behaviour.

The parser must print JSON to stdout.

Array format:

```json
[
  { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
]
```

Object with `jobs`:

```json
{
  "jobs": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

Object with `results`:

```json
{
  "results": [
    { "title": "Senior AI Engineer", "url": "https://example.com/jobs/123", "location": "Remote" }
  ]
}
```

`company` is optional; if missing, `scripts/scan/scan.mjs` uses the `tracked_companies[].name` entry.

The scanner does not need to keep the full JSON after reading stdout. If a parser also writes an artefact for audit or debug, save it to `data/parser-output/{company}/` and keep it out of git (JSON files in `.gitignore`; `.gitkeep` stays in git to preserve the structure).

### Rule: successful local parser — don't repeat expensive scraping

The goal of `scan_method: local_parser` is to **reduce tokens**: stop the LLM from re-scraping the same company with Playwright or redundant APIs.

During the agent's scan run, maintain a `local_parser_ok` set in memory — names of companies (`tracked_companies[].name`) where Level 0 succeeded:

- `parser.command` + `parser.script` exist and the script ran without a fatal error
- stdout was valid JSON (`[]`, `{ jobs: [] }`, or `{ results: [] }`)
- No timeout and no process crash

| Level | If the company is in `local_parser_ok` |
|-------|----------------------------------------|
| **1 — Browser** | **Skip** — no navigation to its `careers_url` (most token-expensive method) |
| **2 — API** | **Skip** — no web fetch of its `api:` (already covered by parser; `scripts/scan/scan.mjs` also skips the API after a successful parser) |
| **3 — Web search** | Run **generic** queries (`site:`, role titles); **discard** any hit whose normalised company name matches a `local_parser_ok` entry |

**Exceptions:**

- Parser **failed** → the company is **not** added to `local_parser_ok`; Levels 1 and 2 apply normally (same fallback rule `scripts/scan/scan.mjs` uses when the parser fails but an ATS API exists).
- Level 3: do not disable cross-portal queries (`site:jobs.ashbyhq.com`, `site:boards.greenhouse.io`, etc.) — they discover **new** companies. Only filter out results from companies already in `tracked_companies` with a successful parser.
- Do not create dedicated `search_queries` for a company with an active local parser (e.g. `site:jobs.ashbyhq.com/cohere "Analytics Engineer"`); use the parser, or if it fails, browser / API.

**Recommended Level 0 start:** run `node scripts/scan/scan.mjs` (or `npm run scan`) at the start of the agent workflow. That covers local parsers and APIs in one zero-token pass and reports which companies were covered by `local-parser` successfully.

### Level 1 — Browser automation direct (PRIMARY)

**For each company in `tracked_companies` not in `local_parser_ok`:** navigate to its `careers_url` with the agent's browser-automation tool (Claude: Playwright MCP `browser_navigate` + `browser_snapshot`; other agents: their equivalent), read all visible job listings, and extract title + URL for each. This is the most reliable method because:

- It sees the page in real time (not cached Google results).
- It works with SPAs (Ashby, Lever, Workday).
- It detects new postings instantly.
- It does not depend on Google indexing.

**Every company MUST have `careers_url` in `portals.yml`.** If missing, find it once, save it, and use it in future scans.

### Level 2 — ATS APIs / feeds (COMPLEMENTARY)

For companies with a public API or structured feed **not in `local_parser_ok`**, use the JSON/XML response as a fast complement to Level 1. Faster than browser automation and reduces visual-scraping errors.

**Current support (variables in `{}`):**

- **Greenhouse:** `https://boards-api.greenhouse.io/v1/boards/{company}/jobs`
- **Ashby:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Lever:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**Per-provider parsing convention:**

- `greenhouse`: `jobs[]` → `title`, `absolute_url`
- `ashby`: GraphQL `ApiJobBoardWithTeams` with `organizationHostedJobsPageName={company}` → `jobBoard.jobPostings[]` (`title`, `id`; construct the public URL if not in the payload)
- `bamboohr`: list `result[]` → `jobOpeningName`, `id`; construct the detail URL `https://{company}.bamboohr.com/careers/{id}/detail`; for the full JD, GET the detail and use `result.jobOpening` (`jobOpeningName`, `description`, `datePosted`, `minimumExperience`, `compensation`, `jobOpeningShareUrl`)
- `lever`: root array `[]` → `text`, `hostedUrl` (fallback: `applyUrl`)
- `teamtailor`: RSS items → `title`, `link`

### Level 3 — Web search (BROAD DISCOVERY)

The `search_queries` with `site:` filters cover portals cross-sectionally (all Ashby companies, all Greenhouse companies, etc.). Useful to discover NEW companies not yet in `tracked_companies`, but the results can be stale. After filtering hits from `local_parser_ok` companies, the remaining results are deduplicated against Levels 0–2.

## How the levels combine

The levels are additive — they run in order, results merge and deduplicate. Companies in `local_parser_ok` **do not** pass through Levels 1 or 2; at Level 3 they only contribute cross-portal discovery (other companies on the same portal).

## Execution sequence

1. **Read configuration**: `portals.yml`
2. **Read dedup sources**: `data/applications.md` + `data/pipeline.md` + Notion Applications DB (via `notion-search`)
3. **Level 0 — local parsers**:
   a. For each `tracked_companies[i]` with `parser.command` + `parser.script`:
   b. Run the script, capture stdout (timeout: 60s)
   c. If stdout is valid JSON and the script exited 0 → add company to `local_parser_ok`, accumulate the jobs
   d. If failure → log and fall through to Levels 1/2
4. **Level 1 — Browser automation** (for each company not in `local_parser_ok`):
   a. Navigate to `careers_url` (Claude: `browser_navigate`)
   b. Snapshot the rendered page (Claude: `browser_snapshot`)
   c. Extract title + URL of every listing visible on the page
   d. Apply pagination if there's a "next page" button or infinite scroll
   e. Apply `title_filter.positive` AND `title_filter.negative` (case-insensitive)
   f. Apply `location_filter` (always_allow → allow → block; see `portals.yml` for the rules)
   g. Accumulate candidates (dedup with Level 1)
5. **Level 2 — ATS APIs** (for companies with `api:` not in `local_parser_ok`):
   a. Fetch the API endpoint (Claude: `WebFetch`; Codex: shell + curl)
   b. Parse per the provider table above
   c. Apply title + location filters
   d. Accumulate the rest (dedup with Levels 0+1+2)
6. **Level 3 — Web search** (broad discovery):
   a. Run each query in `search_queries[]` where `enabled: true`
   b. Extract company + role + URL from each result
   c. Discard hits from companies in `local_parser_ok` (already covered)
   d. Apply title + location filters
   e. Accumulate (dedup with Levels 0+1+2+3)
7. **Deduplicate** against 3 sources:
   a. `data/applications.md` (local cache)
   b. `data/pipeline.md` (URL inbox)
   c. **Notion Applications DB** (system of record — query via `notion-search` by `Job URL`)
8. **Liveness check** (optional, expensive): run `scripts/scan/check-liveness.mjs` against the remaining candidates to discard expired postings
9. **Write Notion + pipeline.md** per the "Notion write — Stage 1 (Discovered)" section below.

## Output summary (at end of scan)

Surface:

```
Scan complete. Levels executed: 0+1+2+3.

  Local parsers run: N (M succeeded, K failed)
  Browser-automation pages: P
  API endpoints: A
  Web-search queries: W

  Total raw hits: H
  After title filter: T
  After location filter: L
  After dedup (local cache + Notion): D
  Expired postings dropped: E

  New rows inserted into Notion at Stage 1: I
  Skipped (already in Notion): S
  Skipped (failed pre-insert filter): F, with one-line reasons

  Top 5 hits by company tier + role (Tier 1 first):
  + Zalando | Analytics Engineer | https://jobs.zalando.com/...
  ...

→ Run /career-ops pipeline to evaluate the new postings.
```

## Managing `careers_url`

Every company in `tracked_companies` should have `careers_url` — the direct URL to its job page. Avoids re-searching every time.

**RULE: Always use the company's branded careers URL; fall back to the ATS endpoint only when no branded page exists.**

`careers_url` should point to the company's own job page whenever available. Many companies run Workday, Greenhouse, or Lever underneath but expose vacancy IDs only via their branded domain. Using the raw ATS URL when a branded page exists can cause false 410 errors because job IDs don't match.

| ✅ Correct (branded) | ❌ Incorrect as first choice (raw ATS) |
|---|---|
| `https://careers.mastercard.com` | `https://mastercard.wd1.myworkdayjobs.com` |
| `https://openai.com/careers` | `https://job-boards.greenhouse.io/openai` |
| `https://stripe.com/jobs` | `https://jobs.lever.co/stripe` |

Fallback: if you only have the raw ATS URL, navigate to the company's website first and locate its branded careers page. Use the ATS URL only if the company has no branded careers page of its own.

**Known patterns per platform:**

- **Ashby:** `https://jobs.ashbyhq.com/{slug}`
- **Greenhouse:** `https://job-boards.greenhouse.io/{slug}` or `https://job-boards.eu.greenhouse.io/{slug}`
- **Lever:** `https://jobs.lever.co/{slug}`
- **BambooHR:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail`
- **Teamtailor:** `https://{company}.teamtailor.com/jobs`
- **Workday:** `https://{company}.{shard}.myworkdayjobs.com/{site}`
- **Custom:** the company's own URL (e.g. `https://openai.com/careers`)

**Per-platform API/feed patterns:**

- **Ashby API:** `https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobBoardWithTeams`
- **BambooHR API:** list `https://{company}.bamboohr.com/careers/list`; detail `https://{company}.bamboohr.com/careers/{id}/detail` (`result.jobOpening`)
- **Lever API:** `https://api.lever.co/v0/postings/{company}?mode=json`
- **Teamtailor RSS:** `https://{company}.teamtailor.com/jobs.rss`
- **Workday API:** `https://{company}.{shard}.myworkdayjobs.com/wday/cxs/{company}/{site}/jobs`

**If `careers_url` doesn't exist** for a company:

1. Try the platform pattern above.
2. If that fails, run a quick web search: `"{company}" careers jobs`.
3. Navigate with your browser-automation tool to confirm it works.
4. **Save the discovered URL to `portals.yml`** for future scans.

**If `careers_url` returns 404 or redirect:**

1. Note it in the output summary.
2. Try `scan_query` as a fallback.
3. Flag the entry for manual update.

## Maintaining `portals.yml`

- **ALWAYS save `careers_url`** when adding a new company.
- Add new queries as new portals or relevant roles emerge.
- Disable queries with `enabled: false` if they generate too much noise.
- Adjust filter keywords as target roles evolve.
- Add companies to `tracked_companies` when worth tracking closely.
- Re-verify `careers_url` periodically — companies switch ATS platforms.

---

## Notion write — Stage 1 (Discovered) on every new hit

**READ `modes/notion-tracker.md` FIRST.** It has the DB IDs, schema, dedup rule, and pre-insert hard filters.

When the scan produces a hit (a job title that passes `title_filter` and a location that passes `location_filter`), do BOTH of the following for each hit:

### Step A — Write to Notion (Stage 1: Discovered)

1. **Dedup first.** Run `notion-search` on the Applications DB filtered by `Job URL = {url}`. If a row already exists, **skip** — do not re-insert, do not append to `data/pipeline.md`. The posting is already known to the tracker.
2. If no row exists, run `notion-create-pages` against the configured Applications data source (`config/profile.yml → notion.applications_data_source_id`) with:
   - `Job URL` (required, dedup key)
   - `Company` (title)
   - `Position` (multi_select — role-family tags)
   - `Source portal` (select — derived from URL host; see portal map in `notion-tracker.md`)
   - `Country`, `Location` (from the JD or the portal metadata if available; if not, leave empty for `oferta` to fill)
   - `Company tier` — set per the company's `tier:` value in `portals.yml`
   - `Stage` = `1. Discovered`
   - `Discovered date` = today
   - `JD snapshot` (first 2000 chars if the JD was captured; otherwise blank — `oferta` fills on triage)
   - `Agent run ID` = current scan batch ID (e.g. `scan-{YYYY-MM-DD-HHMM}`)
3. **Hard pre-insert filters** (skip the row if any fail):
   - Country must match the user's `location_filter` in `portals.yml` (or `_profile.md → Your Location Policy`).
   - Role family must be in active-roles list (see `config/profile.yml.target_roles`).
   - `Job URL` must not already be in Notion (covered by dedup step 1).
   - Language must be detectable (English or whichever language the user has CV variants for).

Match score and Recruiter-sim verdict are NOT written at this stage — they're set by `oferta.md` on Step 2 (Triaged). `scan.md` only knows the posting exists.

### Step B — Add to `data/pipeline.md` (local cache, for the pipeline mode to process)

Append to the `## Pending` section in `data/pipeline.md`:

```
- [ ] {url} | {company} | {role}
```

This is what `modes/pipeline.md` will pick up on the next `/career-ops pipeline` run. The Notion row at Stage 1 is the source of truth; the `pipeline.md` line is the worklist.

### Daily-quota and priority awareness (informational only)

`scan.md` does not enforce the score floor or the daily draft quota — those are `oferta.md` and `pdf.md` concerns. But at the end of a scan run, surface a summary that helps the user see how the funnel is shaped:

- New rows inserted into Notion at Stage 1: N
- Skipped (already in Notion): M
- Skipped (failed pre-insert filter): K, with one-line reasons
- Top 5 hits by company-tier + URL (Tier 1 first)

---

## Auth-walled portals (LinkedIn, etc.)

For portals that need a logged-in browser session (LinkedIn) or live on custom careers pages outside the standard ATS APIs, fall through to **Bright Data SERP / Web Unlocker** via the `BRIGHTDATA_API_KEY` configured in `.env`. Bright Data bypasses bot detection and returns clean markdown — the agent extracts hits from the SERP results.

If Bright Data is not configured, the scanner skips auth-walled portals and only hits the free ATS APIs (Greenhouse / Ashby / Lever / Workable).

**Dedup state:**

- `data/applications.md` and `data/pipeline.md` reads
- Notion Applications DB dedup (via `notion-search` on `Job URL`) when wired
- `data/scan-history.tsv` dedup history

**When to run:**

| Trigger | Why |
|---------|-----|
| Manual `/career-ops scan` | Fast, free, headless. Hits Greenhouse / Ashby / Lever / Workable APIs. |
| Scheduled via `/loop` or `/schedule` | Run on a cadence (e.g. every 3 days). |
