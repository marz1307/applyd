# Mode: chrome-scan — Visible Browser Portal Scan (auth-walled + custom careers)

Companion to `modes/scan.md`. Uses a **browser-automation MCP** (Claude: Claude in Chrome; other agents: their equivalent visible-browser tool) to open visible tabs in the operator's own browser for portals that need authentication, render heavy JavaScript, or live on custom careers pages outside the standard ATS APIs.

> **READ `modes/scan.md` FIRST** for the overall scan contract (dedup, hard pre-insert filters, Notion write at Stage 1). This file only changes the LEVEL 1 path — instead of headless Playwright, it uses a visible browser controlled by an MCP.

> **READ `modes/notion-tracker.md`** for the DB schema, dedup rule, and stage transitions. Same contract.

## When this mode runs (vs `scan.md`)

| Portal type | Path | Why |
|-------------|------|-----|
| Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workable | `scan.mjs` (zero-token API) | Free, fast, no auth needed |
| LinkedIn / Xing | **chrome-scan** | Auth-walled; results dramatically better when logged in |
| Stepstone / Indeed / eFinancialCareers / Handshake / Welcome to the Jungle | **chrome-scan** | No public job API; SPA-heavy; better with real browser session |
| Custom company careers pages (e.g. a tier-1's own `careers.{company}.com`) | **chrome-scan** | No standard ATS; need real browser to render |
| Pure WebSearch query (no `site:` filter narrowing to a specific portal) | `scan.mjs` Level 3 | WebSearch is fine for broad discovery |

## Prerequisites

1. The agent runtime that owns the browser MCP is open and interactive.
2. The browser-automation extension is connected (Claude: `mcp__Claude_in_Chrome__list_connected_browsers` returns at least one browser).
3. The operator is logged in to LinkedIn and Xing in that browser profile. (Stepstone, Indeed etc. don't require login but benefit from it.)

If any prerequisite fails, abort with a clear error and tell the operator what to fix. Do NOT silently fall back to `scan.mjs` (the operator explicitly chose chrome-scan for visibility).

## Tab behaviour rule (LOCKED)

For every portal scanned:

1. Open a new tab (Claude: `tabs_create_mcp`).
2. Navigate (Claude: `navigate`).
3. Read page text (Claude: `get_page_text`).
4. Parse for the target role families per `portals.yml.title_filter`.
5. Apply `location_filter` per `_profile.md → Your Location Policy`.
6. Dedup against Notion (`notion-search` on Job URL).
7. **If 0 hits OR all hits were duplicates → close the tab immediately** (Claude: `tabs_close_mcp`).
8. **If ≥1 NEW hit found → leave the tab open** so the operator can manually inspect the portal and confirm the scraper called it right. Add a sticky comment in the chat naming which tabs are kept open and why.

End state: only tabs with new hits remain in the operator's browser. Clean visibility, no noise.

## Execution sequence

### Step 0 — Prerequisite checks

```
1. List connected browsers via the MCP's discovery tool.
2. If empty → error: "Connect the browser-automation extension before running chrome-scan."
3. If multiple browsers → select the one whose profile is logged in to the target portals.
```

### Step 1 — Load configuration

Read `portals.yml`:
- All `tracked_companies` entries with `scan_method: chrome_scan`
- All `search_queries` entries with `scan_method: chrome_scan`

Build the scan queue. Order: Tier-1 companies first, then other tracked companies, then search queries.

### Step 2 — Snapshot existing dedup state

Single Notion call upfront: `notion-search` against the Applications DB filtered to last 30 days. Build an in-memory `seen_urls` set. This avoids one `notion-search` per page (rate-limit + token saving).

### Step 3 — For each portal in the queue

```
tab = tabs_create(url=portal.url)
navigate(url=portal.url)
text = get_page_text()

# Optional: handle dynamic content
if portal is LinkedIn or Xing:
    # Wait for the job-card list to render, scroll if pagination is infinite
    # Use find() to locate the job-card selector if needed

hits = extract_hits(text, portal)  # title + url + location per portal-specific parser
hits = apply_title_filter(hits, portals_yml.title_filter)
hits = apply_location_filter(hits, portals_yml.location_filter)
new_hits = [h for h in hits if h.url not in seen_urls]

if not new_hits:
    tabs_close(tab)
    log("OK {portal.name}: 0 new hits, closed")
else:
    # Leave tab open
    for hit in new_hits:
        seen_urls.add(hit.url)
        write_to_notion(hit)
        append_to_pipeline_md(hit)
    log("KEEP {portal.name}: {len(new_hits)} new hits, tab kept open at index {tab.index}")
```

### Step 4 — Per-portal extraction recipes

**LinkedIn jobs:**
- URL pattern: `https://www.linkedin.com/jobs/search/?keywords={query}&geoId={geo}`
- Wait for the `.jobs-search__results-list` to appear in DOM
- Extract `.job-card-container__link` for title + URL, `.job-card-container__metadata-item` for location
- Apply title_filter + location_filter

**Xing jobs:**
- URL pattern: `https://www.xing.com/jobs/search?keywords={query}&location={loc}`
- Wait for `.job-tile` selectors
- Extract title + URL + location from each tile

**Stepstone:**
- URL pattern: `https://www.stepstone.de/jobs/{role-slug}/in-{city}`
- Extract from `[data-testid="job-item"]` blocks
- Apply both DE and EN title filter (Stepstone returns both)

**Indeed.de:**
- URL pattern: `https://de.indeed.com/jobs?q={query}&l=Deutschland`
- Extract `.jobsearch-SerpJobCard` (or current equivalent — Indeed re-skins frequently)

**eFinancialCareers.de:**
- URL pattern: `https://www.efinancialcareers.de/sgb/search?keywords={query}`
- Extract `.job-item` blocks

**Handshake (joinhandshake.com):**
- URL pattern requires login + filter setup. Navigate to a saved-search URL if the operator has one; otherwise `https://app.joinhandshake.com/explore/jobs`.

**Welcome to the Jungle:**
- URL pattern: `https://www.welcometothejungle.com/en/jobs?query={query}&location[]={country}`
- Extract `[data-testid="search-results-list-item"]`

**Custom company careers pages (any tier-1 / tier-2 employer with a bespoke careers site outside the standard ATSes):**
- Navigate, read page text, look for target role-family headings or list items.
- Per-company extraction logic — surface unknown layouts to the operator for manual review; do NOT silently miss hits.

### Step 5 — Notion write (same as scan.md)

For each new hit, write a Stage 1 row to Notion per `modes/notion-tracker.md`:
- `Job URL`, `Company`, `Position`, `Source portal`, `Country`, `Location`
- `Stage = 1. Discovered`, `Discovered date = today`
- `Agent run ID = chrome-scan-{YYYY-MM-DD-HHMM}`
- `Company tier = Tier 1` if the row matches the tier-1 list in `portals.yml`

Apply the hard pre-insert filters per `notion-tracker.md`: Country in the target-markets list, role family in active list, language detectable, URL not already in Notion.

### Step 6 — Append to data/pipeline.md

For each new hit, append:
```
- [ ] {url} | {company} | {role}
```

So that `/applyd pipeline` picks it up on the next run for full A–G evaluation.

### Step 7 — Output summary

```
chrome-scan @ {timestamp}

Portals scanned: N
  - Auth-walled (LinkedIn / Xing): M
  - Regional job boards: K
  - Custom careers (tier-1/tier-2 employer sites outside standard ATSes): L

Tabs opened: N
Tabs closed (no hits): X
Tabs kept open for review: Y

New Notion rows at Stage 1: I
Skipped (already in Notion): S
Skipped (failed pre-insert filter): F, with reasons

Top 5 hits (by Tier 1 first):
  + {company} | {role} | {portal} | {url}
  ...

Tabs left open:
  + tab {idx}: {url}
  + tab {idx}: {url}

Run /applyd pipeline to evaluate the new postings.
```

## Error handling

| Failure | Action |
|---------|--------|
| Extension not connected | Try the Bright Data fallback (see below). If that also fails, surface a clear error. Do NOT silently fall back to `scan.mjs`. |
| Specific portal unreachable (timeout, 4xx, 5xx) | Log, close that tab, escalate that portal to the Bright Data fallback, continue to next portal. |
| LinkedIn / Xing rate-limit / auth wall | Surface the rate-limit, then escalate to Bright Data for that portal (BD rotates residential IPs and bypasses bot detection). |
| Permission deny (extension UI bug — sticky deny on a domain) | Escalate that domain to Bright Data immediately. Do NOT keep retrying the extension. |
| Notion write fails | Skip the `pipeline.md` append (consistency rule). Surface the row payload so the operator can retry. |
| Tab orphaned (browser hung) | After 60s timeout per tab, close it and log. |

## Fallback path: Bright Data (BD)

When the visible-browser path fails for the reasons above, fall back to **Bright Data** for that specific portal. BD provides residential-IP scraping with bot-detection bypass and works headlessly, so it is the right tool when:
- The browser extension is not connected.
- Permission deny is stuck on a domain (extension UI bug).
- LinkedIn / Xing have rate-limited the session.
- A custom careers page returns a CAPTCHA wall to the standard fetch.

### Prerequisites

1. Bright Data credentials are provisioned in the environment (`BRIGHTDATA_API_KEY` and, for dataset APIs, `BRIGHTDATA_DATASET_TOKEN`).
2. The `bdata` CLI is installed if you plan to use the CLI path (`bdata login` returns a token, `bdata zones` lists at least one zone).
3. The account has budget (`bdata balance` returns > $0). BD charges per page.

### Invocation paths (in priority order)

1. **Bright Data MCP tools** (`mcp__*BrightData__scrape_as_markdown`, `mcp__*BrightData__web_data_*`) — only if the runtime has loaded the BD MCP server. Prefer this path because it returns clean markdown directly to the model.
2. **`bdata scrape <url> --format markdown`** via the shell — the CLI fallback. Works regardless of whether the MCP server is loaded. Proven fallback for auth-walled portals under smoke tests.
3. **`bdata serp "<query>"`** for SERP-style discovery against Google / Bing where a real browser session isn't required and we only need URLs to feed into `pipeline.md`.

### Execution sequence (per failed portal)

```
# Try browser extension first (Step 3 above)
result = browser_extension_scan(portal)

if result.failed:
    log("FAIL Browser path failed for {portal.name}: {result.reason}")
    log("--> Escalating to Bright Data fallback")

    # Path A - BD MCP (if available)
    if has_tool("mcp__*BrightData__scrape_as_markdown"):
        markdown = call_bd_mcp(portal.url)
    else:
        # Path B - BD CLI via shell
        markdown = shell.run(f'bdata scrape "{portal.url}" --format markdown')

    hits = extract_hits(markdown, portal)
    hits = apply_title_filter(hits, portals_yml.title_filter)
    hits = apply_location_filter(hits, portals_yml.location_filter)
    new_hits = [h for h in hits if h.url not in seen_urls]

    for hit in new_hits:
        seen_urls.add(hit.url)
        write_to_notion(hit, source_note="bright-data fallback")
        append_to_pipeline_md(hit)

    log("KEEP {portal.name} (BD fallback): {len(new_hits)} new hits")
```

### What BD provides per platform

| Portal | BD product to use | Why |
|--------|-------------------|-----|
| Xing job pages | `bdata scrape` (Web Unlocker default) | Bypasses bot detection; works without auth |
| LinkedIn job pages (single JD URL) | `bdata pipelines linkedin-jobs` if available, else `bdata scrape` | Auth-walled lists won't work; single JD URLs do |
| Stepstone / Indeed.de | `bdata scrape` | SPA-heavy; BD renders JS |
| LinkedIn / Xing search-result lists | `bdata serp` with the right `site:` query | Search results are easier than logged-in lists |
| Custom careers pages | `bdata scrape` | Same fetch path as anything else |

### Cost discipline

- BD charges per page. The 07:00 API scan stays free (Greenhouse/Ashby/Lever APIs); BD is only invoked when the browser path fails.
- Cap: max 50 BD pages per scan run. If the queue grows past this, surface to the operator before continuing.
- Log every BD call to `data/scan-history.tsv` with `method=bright-data` so spend can be audited.

### When NOT to fall back to BD

- The browser extension is connected and working but returned **zero hits** legitimately (the portal genuinely has no new postings). Closing the tab and moving on is correct behaviour; do NOT re-fetch the same URL via BD.
- The portal is one of the standard ATS APIs (Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workable) — those have free zero-token APIs via `scan.mjs`. Never use BD for these.
- For Notion / Slack / Gmail / Calendar requests — those are dedicated MCPs, not a scraping target.

## What this mode does NOT do

- Does NOT evaluate JDs (that's `oferta.md`).
- Does NOT generate PDFs (that's `pdf.md`).
- Does NOT submit applications (that's `apply.md` + human approval).
- Does NOT scan Greenhouse / Ashby / Lever / BambooHR / Teamtailor / Workable — those stay on `scan.mjs` zero-token API path.

## Schedule

- Manual: `/applyd chrome-scan`
- Scheduled (interactive-agent side only, not the headless routine wrapper): weekdays around a slot when the operator is likely at the machine with the browser extension connected. The `bd-bulk-scan` routine (see `routines/bd-bulk-scan.md`) covers this territory unattended and should NOT be scheduled alongside a chrome-scan run against the same portals — that just doubles the credit spend for the same rows.
