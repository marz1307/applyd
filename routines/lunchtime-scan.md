# Routine: Lunchtime Chrome / Bright Data Scan (12:30 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). No human is available to clarify or approve mid-run. Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT prompt for confirmation. Do NOT pause and wait.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 12:30 UK time. Companion routines: `morning-scan.md` (07:00 UK, API portals), `pace-check.md` (17:00 UK, pace alarm).

## Goal

Scan the **auth-walled and SPA-heavy portals** (LinkedIn, Xing, Stepstone, Indeed.de, eFinancialCareers.de, Handshake, Welcome to the Jungle, custom company careers pages). In headless mode the Claude in Chrome extension is NOT reachable — go straight to the Bright Data fallback per `modes/chrome-scan.md → Fallback path: Bright Data`. Same end state as morning-scan: Stage 1. Discovered rows in Notion + appended pipeline.md.

## Pre-flight checks (fail fast)

1. `cwd` must be the repo root. If `package.json` is not present, log `ROUTINE_ABORT: not in repo root` and exit.
2. `BRIGHTDATA_API_KEY` must be set in the environment. If `echo $env:BRIGHTDATA_API_KEY` (PowerShell) or `printenv BRIGHTDATA_API_KEY` (bash) returns empty, log `ROUTINE_ABORT: BRIGHTDATA_API_KEY env var missing — set via setx in PowerShell` and exit.
3. Bright Data MCP server (`mcp__brightdata__*`) OR `bdata` CLI must be available. Prefer the MCP tools if present (registered in `.mcp.json`); fall back to `bdata scrape` via Bash if not. If neither is available, log `ROUTINE_ABORT: no bright data path available` and exit.
4. Notion MCP must be reachable (single `notion-search` smoke test against the Applications DB). Same OAuth-needed handling as morning-scan.

## Steps

1. **Load chrome-scan portal queue** from `portals.yml`:
   - All `tracked_companies` entries with `scan_method: chrome_scan`
   - All `search_queries` entries with `scan_method: chrome_scan`
   Order: Tier-1 companies first, then other tracked, then search queries.

2. **Snapshot existing Notion dedup state**: single `notion-search` against the Applications DB filtered to last 30 days. Build an in-memory `seen_urls` set. (Avoids one Notion call per page.)

3. **For each portal in the queue, fetch via Bright Data:**
   - If `mcp__brightdata__scrape_as_markdown` is available, call it with the portal URL.
   - Else: `bdata scrape "<url>" --format markdown` via Bash.
   - Cap: max **50 BD pages per run**. If the queue exceeds this, process the first 50 and log `BD_CAP_HIT: skipped {n} portals` in the output. (Per-page cost discipline from `modes/chrome-scan.md`.)

4. **Parse the markdown** for job-card patterns specific to each portal:
   - LinkedIn / Xing: look for h3/h2 with role title + location pattern (`Hamburg`, `Berlin`, `Remote`, etc.) + a `/jobs/` URL
   - Stepstone: `[data-testid="job-item"]`-equivalent text blocks in the markdown
   - Indeed.de: salary + employer lines
   - Custom careers pages: heading-based listing (role title as H2/H3, location nearby)

5. **Apply the hard pre-insert filters** per `modes/notion-tracker.md` (identical to morning-scan):
   - Country in DACH/UK/EU/Remote set
   - Role family in active list
   - Title does NOT contain `Senior|Sr|Lead|Staff|Principal|Head|Director|VP|Manager`
   - URL not already in `seen_urls`

6. **For each surviving hit**, write a Notion row via `notion-create-pages` with the same schema as morning-scan, plus:
   - `Agent run ID`: `"lunchtime-scan-{YYYY-MM-DD-HHMM}"`
   - `Source portal`: derived from URL host (xing.com → Xing, linkedin.com → LinkedIn, stepstone.de → Stepstone, etc.)
   - In `Fit notes`: prefix with `[BD-fallback]` so it's visible the row came through Bright Data, not Chrome MCP.

   **Company-name rule (locked 2026-05-30).** The `Company` field is recruiter-facing in Notion — it must be the **actual employer** or an honest "Undisclosed (Xing)" placeholder. Never put any of the following in `Company`:
   - Job titles (e.g. `Data Engineer (f/m/x) — Wien`, `Data Scientist (w/m/d) — Hamburg`)
   - Aggregator / SERP descriptors (e.g. `Xing posting — Hamburg DS`)
   - Recruiter-chain labels (e.g. `Jobriver / freenet`, `HEADMATCH`) UNLESS the recruiter IS the underlying employer
   For Xing / Stepstone / Indeed rows where the SERP snippet shows a recruiter agency (apsa, Hays, Jobriver, HEADMATCH, Page Group, Robert Half, Michael Page) but NOT the underlying employer, set `Company` to `"Undisclosed ({Portal})"` and stash the recruiter name in `Fit notes` as `recruiter={name}`. The downstream `auto-eval` step fetches the JD detail page and pulls `hiringOrganization` from JSON-LD; it then PATCHes the real Company name. Better to write "Undisclosed" than a wrong name — wrong names propagate into PDFs and recruiter-facing messages.

7. **Log each BD call** to `data/scan-history.tsv` with `method=bright-data` for spend audit.

8. **Git commit** the pipeline.md and scan-history.tsv diffs:
   ```
   git add data/pipeline.md data/scan-history.tsv
   git -c user.name="career-ops bot" -c user.email="<git-email-from-profile>" commit -m "scan: lunchtime BD run $(date -u +%Y-%m-%dT%H:%MZ)" || echo "nothing to commit"
   ```
   Do NOT push.

## Output contract (write to stdout, ONE block)

The wrapper (`run-routine.ps1`) validates the presence of this block — if missing, the run is treated as failed. The Notion DB id is read from `config/profile.yml` (`notion.applications_data_source_id`); do NOT hardcode.

```
--- ROUTINE_CONTRACT ---
ROUTINE: lunchtime-scan
TIMESTAMP_UTC: {iso}
PORTALS_SCANNED: {n}
BD_PAGES_USED: {n}
BD_CAP_HIT: {true|false}
HITS_RAW: {n}
HITS_AFTER_FILTER: {n}
NOTION_ROWS_WRITTEN: {n}
DUPLICATES_SKIPPED: {n}
COMMIT_SHA: {short_sha or "no-changes"}
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- BD scrape failure for a single portal → log, skip that portal, continue. Do NOT retry (BD billing).
- BD rate-limit / 429 → wait 60s, retry that portal once. Then continue.
- Notion rate-limit → wait 30s, retry once. Then exit with rows already written.
- BD account out of balance (`bdata balance` returns 0 or error mentions insufficient funds) → log `ROUTINE_ABORT: bright data balance exhausted` and exit. Do NOT keep calling.
- Git commit failure → log to ERROR_DETAILS but do NOT exit non-zero.

## What this routine does NOT do

- Does NOT open visible Chrome tabs (headless mode — Chrome MCP unreachable; the visible-tab behaviour from `modes/chrome-scan.md` is Cowork-interactive only).
- Does NOT evaluate JDs.
- Does NOT generate PDFs.
- Does NOT submit applications.
- Does NOT scan API portals (that's `morning-scan.md`).
- Does NOT push to git.
