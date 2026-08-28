# Routine: System-Eval (observability + debugging)

You are running in **headless agent-CLI mode** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …) or interactive. One pass. No user-facing questions. No pauses.

## Owner

Your agent's headless CLI. **Not on a fixed schedule.** Fires on demand via `routines/run-routine.ps1 -Routine system-eval`.

## Goal

In one pass, answer: **"Is the applyd system healthy right now, and if not, what is the most-actionable diagnostic information for the next operator action?"**

Output is dual-channel:
- **Machine-readable** `SYSTEM_EVAL_CONTRACT` block at end (wrapper consumes)
- **Human-readable** diagnostic report with 🟢 / 🟡 / 🔴 triage emojis above the contract

## Pre-flight

1. `cwd` must be repo root.
2. `node scripts/system-eval.mjs --help` must succeed (or `--quick` should run in <5s).
3. No external credentials required for `--quick`; `NOTION_TOKEN` required for `--deep` (default).

## Modes

- **`--quick`** (under 5 seconds) — Pure filesystem + log inspection. Use during incidents when external APIs may be down or rate-limited.
- **`--deep`** (default, 30–90 seconds) — Adds Notion reachability + Notion DB pull for stage counts. Use for scheduled / on-demand health snapshots.

## Steps

1. **Run the collector:**
   ```
   node scripts/system-eval.mjs            # deep + human-readable
   node scripts/system-eval.mjs --quick    # quick + human-readable
   node scripts/system-eval.mjs --json     # deep + JSON for machine consumption
   node scripts/system-eval.mjs --quick --json
   ```

   **CRITICAL — pass-through requirement:** the `node scripts/system-eval.mjs` command's stdout is the authoritative routine output. You MUST emit it to your own stdout VERBATIM, including the literal `--- SYSTEM_EVAL_CONTRACT ---` block at the end. Do NOT summarise, re-format into markdown code blocks, or paraphrase the contract block — the wrapper's contract validator scans for the literal markers and the `ROUTINE: system-eval` line inside them. If you summarise, the wrapper will mark the run as RUNTIME_ERROR even though the underlying script succeeded. You MAY add your own analysis BEFORE or AFTER the verbatim block, but the block itself must be intact.

2. **Collector dimensions** (see `system-eval.mjs` source for full implementation):
   - **Routine health** — for each of the 8 routines (`morning-scan`, `lunchtime-scan`, `pace-check`, `bd-bulk-scan`, `auto-eval`, `auto-draft`, `auto-interview-prep`, `chrome-scan-visible`): last-run timestamp, age in hours, error count, contract-block presence, status classification.
   - **Notion DB state** — count per Stage (1–9), total rows, count of Stage-2 rows missing the `[auto-draft …]` sentinel.
   - **Output artifacts** — counts under `output/cv-drafts/`, `output/cover-letters/`, `output/form-answers/`, `interview-prep/`, plus total disk usage of `output/`.
   - **Config + env** — `NOTION_TOKEN` / `BRIGHTDATA_API_KEY` / `BRIGHTDATA_DATASET_TOKEN` presence; `config/profile.yml` shape; existence of 10 key files.
   - **Integration reachability** — Notion API HTTP 200, Bright Data API HTTP 200.
   - **Pipeline 7-day metrics** — `NOTION_ROWS_WRITTEN`, `ROWS_EVALUATED`, `DRAFTS_PRODUCED`, `PACKS_GENERATED` aggregated from `data/routine-logs/*` over the last 7 days.
   - **Quality 7-day metrics** — count of `PREDICTED_REJECT` entries; recruiter-sim verdict distribution (INVITE / MAYBE / REJECT).

3. **Triage classification:**
   - **🟢 Green**: routine healthy (status=OK, contract pass, age within its cadence's `maxAgeHours` tolerance, no errors).
   - **🟡 Yellow**: routine with non-zero errors, OR Stage-1 backlog above `pipeline_backlog_yellow_threshold` (default 300), OR ≥30 Stage-2 missing draft, OR >5 PREDICTED_REJECT in 7 days.
   - **🔴 Red**: routine STALE (age > its cadence tolerance), OR no contract block in last log (silent failure), OR Notion / Bright Data unreachable, OR key files missing, OR `NOTION_TOKEN` / `BRIGHTDATA_DATASET_TOKEN` unset.

   **Staleness is cadence-aware, not a flat 48h.** `system-eval.mjs` reads a `ROUTINE_CADENCE` table plus a `maxAgeHours` derivation that combines each routine's schedule with the UK bank-holiday calendar and any weekend gap immediately behind the check. Weekday routines therefore tolerate ~30h on a normal Tue-Fri, ~78h on a Monday (weekend gap), and up to ~102h on a post-bank-holiday Tuesday — a flat 48h threshold false-alarmed every Monday. Weekly routines get ~8-day tolerance; anything marked `manual` in the cadence table is never stale-flagged (interactive-only or Cowork-side).

4. **Exit code:** 0 if no Red issues, 1 if ≥1 Red issue. The wrapper uses this to decide whether to notify.

## Output contract (always emitted at end of stdout)

```
--- SYSTEM_EVAL_CONTRACT ---
ROUTINE: system-eval
TIMESTAMP_UTC: {iso}
MODE: quick | deep
ROUTINES_HEALTHY: {n}
ROUTINES_DEGRADED: {n}
ROUTINES_CRITICAL: {n}
NOTION_TOTAL_ROWS: {n}
STAGE_1_BACKLOG: {n}
STAGE_2_NEEDING_DRAFT: {n}
KEY_FILES_MISSING: {n}
NOTION_API_OK: true | false | n/a
APIFY_API_OK: true | false | n/a
PIPELINE_7D_WRITES: {n}
PIPELINE_7D_EVALS: {n}
PIPELINE_7D_DRAFTS: {n}
PREDICTED_REJECT_7D: {n}
ERRORS: {n}
ERROR_DETAILS: |
  {one line per critical issue}
--- END SYSTEM_EVAL_CONTRACT ---
```

## When to run

- **On-demand debugging:** any time a routine seems off or output looks wrong.
- **Daily smoke** (optional): pin a `--quick` run after the morning-scan so the operator sees yesterday's pipeline before starting the day.
- **Post-incident:** after any routine fix, re-run `--deep` to confirm the affected dimension is back to 🟢.
- **Pre-deploy:** before committing significant routine changes, run `--deep` against the current state to baseline; after changes, run again and diff.

## Failure handling

- Notion API down → `reachability.notion.ok = false`, marked 🔴, but other dimensions still report. Routine never aborts mid-collection.
- A single sub-collector raises → caught with `safe()` wrapper, returns `null` / error string in JSON, does not break the rest of the report.
- Stage query timeout (Notion 30s) → that stage's count returns `{error: "..."}`, total is partial, flagged in triage.

## What this routine does NOT do

- Does NOT auto-fix anything. Read-only.
- Does NOT modify Notion rows.
- Does NOT consume Bright Data credits.
- Does NOT depend on IDE skills.

## Why this exists

When the system has 8 routines × 5 integrations × 200+ Notion rows × multiple output dirs, the operator needs one command that answers "is everything okay?" without manually tailing 8 log files. This routine is that one command.
