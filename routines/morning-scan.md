# Routine: Morning API Scan (07:00 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). No human is available to clarify or approve mid-run. Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT prompt for confirmation. Do NOT pause and wait.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 07:00 UK time. Companion routines: `lunchtime-scan.md` (12:30 UK, Chrome/Bright Data portals), `pace-check.md` (17:00 UK, pace alarm).

## Goal

Scan the standard ATS API portals (Greenhouse, Ashby, Lever, BambooHR, Teamtailor, Workable), dedup against Notion, write new postings into the Notion Applications DB at **Stage 1. Discovered**, and append to `data/pipeline.md` for downstream evaluation.

## Config

Read these from `config/profile.yml` (single source of truth) — do NOT hardcode:
- `notion.applications_data_source_id` — Applications DB UUID for all Notion writes.

If `config/profile.yml` is missing, log `ROUTINE_ABORT: config/profile.yml missing` and exit non-zero.

## Pre-flight checks (fail fast)

1. `cwd` must be the repo root. If `package.json` is not present in the current directory, log `ROUTINE_ABORT: not in repo root` and exit.
2. `node --version` must succeed. If not, log `ROUTINE_ABORT: node missing` and exit.
3. The Notion MCP must be reachable. Try a single `notion-search` against the Applications DB (using the data_source_id from config) with `query: ""`. If the tool errors with auth, log `ROUTINE_ABORT: notion oauth needed — run claude interactively in this repo to authorise` and exit. (One-time setup. After the first interactive OAuth, the token persists in `~/.claude/`.)

## Steps

1. **Run the scanner.** Execute `node scripts/scan/scan.mjs` via Bash. The scanner is zero-token (hits the ATS APIs directly, no LLM cost). Capture stdout to memory. The scanner emits a machine-stable `--- SCAN_CONTRACT ---` block at the end with the canonical counts — use those numbers verbatim for the routine output contract; do NOT recount from the pipeline file.

2. **Parse hits.** The scanner outputs candidate hits to `data/pipeline.md` (append-only) and writes its dedup state to `data/scan-history.tsv`. Read both.

3. **Apply the hard pre-insert filters** per `modes/notion-tracker.md`:
   - Country in `{Germany, Austria, Switzerland, UK, Netherlands, Ireland, EU (other), Remote}`
   - Role family in `{Analytics Engineer, Data Scientist, Data Engineer, BI Engineer, Analytics Consultant, ML Engineer, Data Analyst}`
   - Title does NOT contain `Senior|Sr|Lead|Staff|Principal|Head|Director|VP|Manager` (mid-only band per `modes/_profile.md`)
   - URL not already in Notion (single `notion-search` snapshot upfront against last 30 days, build an in-memory `seen_urls` set)

4. **For each surviving hit**, write a row to the Notion Applications DB via `notion-create-pages`:
   - `parent`: `{type: "data_source_id", data_source_id: <notion.applications_data_source_id from config/profile.yml>}`
   - `Company`: title
   - `Position`: multi_select (array of role-family tags)
   - `Stage`: `"1. Discovered"`
   - `Job URL`: dedup key
   - `Source portal`: one of `LinkedIn, Xing, Stepstone, Handshake, Welcome to the Jungle, eFinancialCareers, Indeed, Greenhouse, Lever, Company site, Other`
   - `Country`: derived from the hit
   - `Location`: city / "Remote"
   - `Company tier`: `"Tier 1 (Target)"` if Company in portals.yml tier-1 list, else `"Tier 2"` if tracked in portals.yml, else `"Tier 3"`
   - `Agent run ID`: `"morning-scan-{YYYY-MM-DD-HHMM}"`
   - `date:Discovered date:start`: today (ISO date)
   - `date:Discovered date:is_datetime`: 0

5. **Git commit** the pipeline.md and scan-history.tsv diffs:
   ```
   git add data/pipeline.md data/scan-history.tsv
   git -c user.name="career-ops bot" -c user.email="<git-email-from-profile>" commit -m "scan: morning API run $(date -u +%Y-%m-%dT%H:%MZ)" || echo "nothing to commit"
   ```
   Do NOT push. Local commit only — the candidate pushes when they review.

## Output contract (write to stdout, ONE block)

The wrapper (`run-routine.ps1`) validates the presence and integrity of this block — if it's missing, the run is treated as a failure regardless of `claude -p`'s exit code. Echo numbers VERBATIM from the scanner's `--- SCAN_CONTRACT ---` block; do not recompute.

```
--- ROUTINE_CONTRACT ---
ROUTINE: morning-scan
TIMESTAMP_UTC: {iso, from SCAN_CONTRACT.TIMESTAMP_UTC}
PORTALS_SCANNED: {n, from SCAN_CONTRACT.PORTALS_SCANNED}
HITS_RAW: {n, from SCAN_CONTRACT.HITS_RAW}
HITS_AFTER_FILTER: {n, from SCAN_CONTRACT.HITS_AFTER_FILTER}
NOTION_ROWS_WRITTEN: {n, your own count from step 4}
DUPLICATES_SKIPPED: {n, from SCAN_CONTRACT.DUPLICATES_SKIPPED}
COMMIT_SHA: {short_sha or "no-changes"}
ERRORS: {n, from SCAN_CONTRACT.ERRORS}
STALE_COMPANIES_COUNT: {n, from SCAN_CONTRACT.STALE_COMPANIES_COUNT}
STALE_COMPANIES: {comma-list, from SCAN_CONTRACT.STALE_COMPANIES — surface these as a separate alert if non-empty}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

This output is parsed by the wrapper and by `routines/pace-check.md` to compute weekly pace.

## Failure handling

- Any failure in steps 1–4 for a SINGLE hit → log to ERROR_DETAILS, skip that hit, continue.
- Failure of the scanner itself (step 1) → log `ROUTINE_ABORT: scan.mjs failed: {stderr}` and exit with non-zero. No Notion writes, no commit.
- Notion rate-limit → wait 30s, retry once. If still failing, log to ERROR_DETAILS and exit with the rows you did manage to write.
- Git commit failure → log to ERROR_DETAILS but do NOT exit non-zero. Notion is the system of record; the local commit is a convenience.

## What this routine does NOT do

- Does NOT evaluate JDs (that's `modes/oferta.md`, run by the candidate in Cowork).
- Does NOT generate PDFs.
- Does NOT submit applications.
- Does NOT scan Chrome/Bright Data portals — that's `routines/lunchtime-scan.md`.
- Does NOT push to git.
