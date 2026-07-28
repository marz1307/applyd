# Routine: Chrome-Scan-Visible (interactive, manual + scheduled trigger)

You are running INSIDE the user's open agent-CLI session. Unlike the
headless routines (morning-scan, lunchtime-scan, etc.), this routine
drives the user's actual Chrome browser via a browser-automation MCP
(e.g. the Chrome MCP server bundled with your agent, or Playwright
MCP). The user must be present at the computer for sign-in steps.

## Owner

Triggered two ways:
1. **Scheduled** via your agent's scheduled-task facility (or a Windows
   Task Scheduler entry that opens the agent) to fire at a chosen
   weekday time (e.g. 09:00 UK). If the app is closed at fire time, it
   runs on next launch (per the scheduled-task system's catch-up
   behaviour). This satisfies the "if system is off during schedule,
   must run when next connected" rule.
2. **On-demand** — the user types `/applyd chrome-scan` (or the
   equivalent mode invocation for their agent) in chat.

## Goal

For each of the six **interactive portals** below:

1. Open a Chrome tab to the portal's job-search URL pre-filled with the
   user's target-role queries (read from `config/profile.yml → target_roles`).
2. Wait up to 90 seconds for the user to sign in if not already signed in.
3. Scrape **40 ad candidates** from the search-results page (over-fetch
   to allow dedup losses + below-75 attrition later).
4. For each candidate, **drill into its detail page** and capture the
   **actual application form URL** (the "Apply" button's href, NOT just
   the listing URL).
5. Aggregate all six portals' results into one JSON.
6. Pipe through `node scripts/scan/cross-portal-dedup.mjs --target 30 --json`
   to cross-dedup.
7. Write the surviving rows to Notion as Stage `1. Discovered` via the
   Notion MCP (`notion-create-pages` — the tool name prefix varies by
   connector; use the Notion MCP server available in your session).

## Interactive portals

Read from `config/profile.yml → apify.queries` for the role/city fan-out.
The six portals:

| # | Portal | Search URL (verified 2026-05-25) | Selectors (verified) | Access |
|---|--------|----------------------------------|----------------------|--------|
| 1 | **LinkedIn** | `https://www.linkedin.com/jobs/search/?keywords={role}&location={city}&f_TPR=r604800` (`f_TPR=r604800` = last 7 days) | card `li[data-occludable-job-id]`, title `.artdeco-entity-lockup__title`, company `.artdeco-entity-lockup__subtitle`, location `.artdeco-entity-lockup__caption`. Canonical job URL: `https://www.linkedin.com/jobs/view/{data-occludable-job-id}`. Cards in current pass: 25. | ✓ open |
| 2 | **Xing** | `https://www.xing.com/jobs/search?keywords={role}&location={city}` | card `article`, title `h2[data-testid="job-teaser-list-title"]`, link `a[href*="/jobs/"][href*="-"]` inside article. URL form `https://www.xing.com/jobs/{slug}-{id}`. Anonymous browse OK (signed-in optional). Cards: 20. | ✓ open |
| 3 | **eFinancialCareers UK** | `https://www.efinancialcareers.co.uk/jobs/{role-slug}/in-{city}` (e.g. `/jobs/data-analyst/in-london`) — verified 2026-05-25 returning 843 jobs for `data-analyst/in-london` | card `efc-card-details` (Angular custom element), title `efc-card-details a.job-title h3`, job URL = href of `a.job-title` (pattern `https://www.efinancialcareers.co.uk/jobs-{Country}-{City}-{slug}.id{numeric_id}`), 15 cards per page (use `pageSize` query param for more). | ✓ once domain approved in extension (first-run prompt) |
| 4 | **eFinancialCareers DE** | `https://www.efinancialcareers.de/jobs/{role-slug}/in-{city}` (e.g. `/jobs/data-engineer/in-frankfurt`) — verified 2026-05-25 returning 20 cards for `data-engineer/in-frankfurt` | identical structure to UK — `efc-card-details` Angular element. URL pattern: `https://www.efinancialcareers.de/jobs-Germany-{City}-{slug}.id{numeric_id}` | ✓ once domain approved (sibling to UK) |
| 5 | **Welcome to the Jungle** | ✅ **MOVED TO bd-bulk-scan (2026-05-28).** Browser-based scraping is architecturally blocked: signed-in `/en/jobs?query=...` silently redirects to `/jobs-matches` which respects only saved profile preferences (not URL params), and signed-out HTTP hits a 202 bot-challenge interstitial (DataDome). Scraping now handled via Bright Data two-stage SERP→enrich (`bd-bulk-scan.mjs` portal `wttj`). | n/a — chrome-scan-visible **skips WTTJ entirely**; routine logs `PORTAL_MOVED_TO_BD` (informational, not an error) |
| 6 | **Handshake** | `https://app.joinhandshake.com/job-search?keywords={role}&locations[]={city}` | **TBC** | ⏸ extension domain permission + typically .edu sign-in required; routine logs PERMISSION_DENIED / SIGN_IN_TIMED_OUT |

**Access-grant flow:** on the first scrape attempt for a portal where navigation returns `permission_required:<domain>`, the LLM should screenshot the page, post a desktop notification via your agent's OS-notification tool (if any) telling the user "Grant domain access to {domain} in your browser MCP extension and re-trigger the routine," then skip that portal for this run (recorded in ERROR_DETAILS as `PERMISSION_DENIED: {domain}`).

## Config

Read from `config/profile.yml`:
- `notion.applications_data_source_id` — for `notion-create-pages` writes.
- `target_roles.primary` and `.secondary` — search keywords.
- `apify.queries` — already has the role+country+city fan-out we want; reuse.
- `target_markets` — country filter for keep/drop.

## Tools required

- A browser-automation MCP that exposes: list-connected-browsers,
  select-browser, tab management (create, context), navigate,
  find-by-selector, evaluate JavaScript in page, screenshot / click /
  type, read-page, read-console-messages. Any equivalent works —
  e.g. a Chrome-driver MCP or Playwright MCP.
- A shell tool for invoking `node scripts/scan/cross-portal-dedup.mjs`
  and `node scripts/notion/notion-upload-file.mjs`.
- A Notion MCP that supports `notion-create-pages` (or fall back to the
  REST helper in `scripts/notion/`).
- File-read tool for `config/profile.yml`.

If a browser MCP isn't connected, abort with
`ROUTINE_ABORT: browser MCP not connected — install and connect your agent's browser-automation extension first`.

## Pre-flight

1. `cwd` must be the repo root.
2. `NOTION_TOKEN` env var present (for the post-scrape file uploads later).
3. Browser MCP reachable: its list-connected-browsers call returns at
   least one browser. Select it.
4. Create one new tab. Use this tab for all six portals sequentially
   (close+reopen between portals to avoid stale state).

## Steps

For each portal in the list above:

### Step A — Open and wait for sign-in

1. Build the portal URL with the first query from `apify.queries`
   (e.g. Analytics Engineer, Germany, Berlin).
2. `navigate` to it. Wait up to 8 seconds for the page to render
   (Notion / LinkedIn don't reach `document_idle` reliably; use
   `javascript_tool` to probe `document.readyState === 'complete'`).
3. Detect signed-in state via portal-specific DOM selectors
   (see "Sign-in detection" below). If signed out:
   - Post a desktop notification via your agent's OS-notification tool
     or screenshot + tell the user in the agent chat:
     `"⏸ Please sign in to {portal}. I'll wait up to 90 seconds."`
   - Poll signed-in state every 5 seconds for up to 90 seconds.
   - If still signed out after 90s, skip this portal — set
     `sign_in_timed_out_portals` and continue with the rest.

### Step A-bis — Read replacement quota from prior auto-eval

Before scraping, check for a `data/.routine-tmp/replacements-needed.json` file produced by the most recent `auto-eval` run. If it exists AND `(now - generated_at) < ttl_hours`:
- Add `needed[portal]` to each portal's scrape target. E.g. if Xing dropped 12 rows to Not pursuing in last night's eval, today's chrome-scan targets `30 + 12 = 42` unique Xing ads (over-fetch to backfill).
- After successful run, delete this file (the request has been satisfied).
- If the file is stale (>ttl_hours old), ignore it and proceed with target=30 per portal.

This is the **drop-and-replace** loop the user specified: rows scoring <75 get demoted AND the system actively pulls replacements on the next scrape, so the queue stays "30 strong candidates per portal" rather than draining over time.

### Portal selectors — verify on first real run

The selectors below are templates. Portals change DOM frequently and
attempted offline verification with public pages was inconclusive
(eFC returned 500, Xing/LinkedIn require auth, etc.). The honest
approach is: try the template, capture ERROR_DETAILS per-portal on
the first real run, then tune. The routine's ERROR_DETAILS field
surfaces exactly which selectors failed; the operator updates this
prompt the next morning with verified DOM paths.

If a portal returns 0 scraped ads, the LLM should:
1. Take a screenshot of the search-results page via Chrome MCP.
2. Run a `find` query for "job listing card" or "result row".
3. Document the working selectors in ERROR_DETAILS as
   `SELECTOR_FIX_NEEDED: {portal}: card={selector} apply={selector}`.

### Step B — Scrape (target) candidates from the results page

Use `javascript_tool` to extract from the DOM. Each portal has a
different listing-card structure, but the pattern is the same:
collect 40 result cards' { company, title, location, listing_url }.
Scroll the results panel to load lazy entries if needed.

DOM extraction template (adapt selectors per portal):

```js
Array.from(document.querySelectorAll('SELECTOR_FOR_RESULT_CARD')).slice(0, 40).map(card => ({
  company:     card.querySelector('SELECTOR_COMPANY')?.innerText?.trim() ?? 'Undisclosed',
  title:       card.querySelector('SELECTOR_TITLE')?.innerText?.trim() ?? '',
  location:    card.querySelector('SELECTOR_LOCATION')?.innerText?.trim() ?? '',
  listing_url: card.querySelector('a[href]')?.href ?? '',
}))
```

### Step C — Drill into each ad for the apply URL

For each of the 40 listings, open in a SECOND tab (so the search-
results page state is preserved), navigate to `listing_url`, wait
for the JD to render, then run JS to find the apply button's `href`:

```js
// Multiple candidate selectors per portal — first match wins.
const candidates = [
  'a[href*="apply"]',
  'button[data-control-name="jobdetails_topcard_inapply"]',
  '[data-test="apply-button"]',
  'a[data-tn-element="apply-button"]',
];
let applyUrl = '';
for (const sel of candidates) {
  const el = document.querySelector(sel);
  if (el?.href) { applyUrl = el.href; break; }
  if (el?.tagName === 'BUTTON') {
    // Inline-apply portals (LinkedIn EasyApply): no external URL; flag for inline path
    applyUrl = `inline-apply:${location.href}`;
    break;
  }
}
applyUrl;
```

If the apply control is an inline form (no external href), record
`apply_url = "inline-apply:<listing_url>"` so the downstream apply
flow knows to use Chrome MCP rather than form-submission via REST.

Close the second tab and move to the next listing.

### Step D — Aggregate and dedup

After all six portals are scraped, write the combined results to
`data/.routine-tmp/chrome-scan-raw.json`:

```json
{
  "LinkedIn": [{ company, title, location, listing_url, apply_url, source_portal: "LinkedIn" }, ...],
  "Xing":     [...],
  ...
}
```

Then dedup:

```
node scripts/scan/cross-portal-dedup.mjs --in data/.routine-tmp/chrome-scan-raw.json --target 30 --json > data/.routine-tmp/chrome-scan-deduped.json
```

If `replacements_needed[portal] > 0` for any portal AND
`total_kept < (6 * 30) * 0.7` (i.e. you lost more than 30% to dedup),
loop back to step B for that specific portal with `--exclude-urls` of
the already-seen URLs and pull the shortfall. Cap retries at 1 per
portal to avoid runaway.

### Step E — Write surviving rows to Notion

For each kept ad: call `notion-create-pages` with the standard
Stage-1 fields per `modes/notion-tracker.md`:
- `Company`, `Position`, `Country`, `Location`, `Source portal`,
  `Job URL = listing_url`, `Stage = "1. Discovered"`,
  `Agent run ID = "chrome-scan-visible-{YYYY-MM-DD-HHMM}"`,
  `Discovered date = today`.
- ALSO populate a new field if it exists: `Apply URL = apply_url`. If
  the field doesn't exist in the schema, append to `Fit notes` as
  `[apply_url] {apply_url}`.

Batch the writes 25-per-call. Dedup against Notion's existing rows
the same way `morning-scan.md` does: one `scripts/notion/notion-query.mjs --json` of
the last 30 days before writing, filter listing_urls.

## Sign-in detection per portal

Adapt these JS probes; first one returning truthy means signed-in:

| Portal | Signed-in probe (JS) |
|--------|---------------------|
| LinkedIn | `!!document.querySelector('.global-nav__me, [data-test-global-nav-me]')` |
| Xing | `!!document.querySelector('[data-testid="navigation-meta-menu-button"], header [aria-label*="user" i]')` |
| eFC | `!!document.querySelector('[data-test="user-menu"], a[href*="logout"]')` |
| ~~WTTJ~~ | — moved to Apify, no sign-in probe needed |
| Handshake | `!!document.querySelector('[data-hook="header-profile"], button[aria-label*="account" i]')` |

## Output contract (write to stdout, ONE block)

```
--- ROUTINE_CONTRACT ---
ROUTINE: chrome-scan-visible
TIMESTAMP_UTC: {iso}
PORTALS_ATTEMPTED: 6
PORTALS_SIGNED_IN: {n}
PORTALS_TIMED_OUT_AT_SIGNIN: {n}
ADS_SCRAPED_RAW: {n}                    # before dedup
ADS_AFTER_CROSS_DEDUP: {n}              # after cross-portal dedup
ADS_PER_PORTAL_AFTER_DEDUP: {portal:n,...}
REPLACEMENTS_NEEDED: {portal:n,...}
APPLY_URLS_RESOLVED: {n}                # ads where drill-in found a non-inline apply URL
INLINE_APPLY_FLAGS: {n}
NOTION_ROWS_WRITTEN: {n}
DUPLICATES_AGAINST_NOTION: {n}
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- Chrome MCP disconnects mid-run → abort cleanly, no Notion writes.
- One portal fails entirely → log to ERROR_DETAILS, continue with rest.
- Sign-in timeout on a portal → skip portal, do not retry.
- Drill-in fails for one ad → record `apply_url = ""`, continue.
- Notion rate-limit → 30s wait, retry once.

## What this routine does NOT do

- Does NOT submit applications — only discovers + writes Stage 1.
- Does NOT evaluate (auto-eval at 21:00 does that).
- Does NOT generate PDFs.
- Does NOT use Bright Data or Apify — pure Chrome MCP.
- Does NOT run under a headless agent CLI (it requires user-present sign-in).
