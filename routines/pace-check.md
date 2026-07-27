# Routine: Daily Pace Check (17:00 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). No human is available to clarify or approve mid-run. Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT prompt for confirmation. Do NOT pause and wait.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 17:00 UK time. Companion routines: `morning-scan.md` (07:00 UK), `lunchtime-scan.md` (12:30 UK).

## Goal

Read today's apply pace from `data/applications.md` via `scripts/metrics/pace-alarm.mjs`. If pace is below target (read from `config/profile.yml → pace.target_per_day`) for **two consecutive weekdays**, surface an alarm by appending a comment to the most recent Notion row at Stage 1 or 2. The alarm is the only side effect — no email, no push.

## Config

Read these from `config/profile.yml` (single source of truth) — do NOT hardcode:
- `notion.applications_data_source_id` — Applications DB UUID for the Notion comment.
- `pace.*` — scripts/metrics/pace-alarm.mjs reads these directly; defer to whatever the script emits.

## Pre-flight checks (fail fast)

1. `cwd` must be the repo root.
2. `node scripts/metrics/pace-alarm.mjs --json` must succeed and emit a `--- ROUTINE_CONTRACT ---` block.
3. Notion MCP reachable — **OPTIONAL, not fatal (2026-07-06).** The pace read runs on `NOTION_TOKEN` REST and never needs the MCP. The MCP is used only to post the alarm *comment* (step 4), and the OAuth Notion MCP is frequently absent in headless `claude -p` runs. If it is unreachable, do NOT fail the run and do NOT count it as an error: skip the comment, set `NOTION_CARD_ID: none-mcp-unavailable`, keep `ERRORS: 0`, and note the skip in `ERROR_DETAILS` as an informational line. The alarm is still captured in routine-log history and reflected on the dashboard, so the side effect degrades gracefully.

## Steps

1. **Run pace-alarm in JSON mode**:
   ```
   node scripts/metrics/pace-alarm.mjs --json
   ```
   Capture stdout. The script emits BOTH a JSON blob AND a `--- ROUTINE_CONTRACT ---` block. Echo the contract block VERBATIM as your routine output (see "Output contract" below) — do not re-derive numbers, do not transcribe field names from this doc. The script also emits `CACHE_STALE: true|false`; when stale, the script auto-downgrades alarm → warning, so the contract block's `ALARM_TRIGGERED` value already reflects that decision.

2. **Decide whether to alarm**:
   - Trust the script's `ALARM_TRIGGERED` field from the contract block.
   - If `CACHE_STALE: true`, prefer `ALARM_TRIGGERED: false` (script already handles this) but ALWAYS surface the stale-cache fact in your final output.

3. **If alarming**, find the most recent Notion row at Stage `1. Discovered` OR `2. Triaged`:
   ```
   notion-search against the data_source_id from config/profile.yml (notion.applications_data_source_id)
   filter: Stage in ["1. Discovered", "2. Triaged"]
   sort: Discovered date desc
   limit: 1
   ```

4. **Append a comment** to that row via `notion-create-comment` (skip cleanly with `ERRORS: 0` if the Notion MCP is unavailable — see pre-flight #3):
   ```
   PACE ALARM ({YYYY-MM-DD}): apply pace below target for {N} consecutive weekdays.
   Today: {today_count}/{target_per_day}. Yesterday: {yesterday_count}/{target_per_day}.
   Weekly gap: {weekly_gap} applications below the weekly target (from config).
   Next action: triage and apply on this card today.
   ```

5. **No git commit needed** — scripts/metrics/pace-alarm.mjs does not write files. The applications.md state was already committed when the application was logged.

## Output contract (write to stdout, ONE block)

Echo `scripts/metrics/pace-alarm.mjs`'s `--- ROUTINE_CONTRACT ---` block verbatim, then append two routine-specific lines (`NOTION_CARD_ID`, `ERROR_DETAILS`) before the closing `--- END_ROUTINE_CONTRACT ---`. The wrapper validates the presence of this block — if missing, the run is treated as failed.

```
--- ROUTINE_CONTRACT ---
ROUTINE: pace-check
TIMESTAMP_UTC: {from pace-alarm}
TODAY_COUNT: {from pace-alarm}
YESTERDAY_COUNT: {from pace-alarm}
ROLLING_7D_AVG: {from pace-alarm}
TARGET_PER_DAY: {from pace-alarm}
ALARM_THRESHOLD_PER_DAY: {from pace-alarm}
CONSECUTIVE_BELOW_TARGET_DAYS: {from pace-alarm}
WEEKLY_ACTUAL: {from pace-alarm}
WEEKLY_TARGET: {from pace-alarm}
WEEKLY_GAP: {from pace-alarm}
ALARM_TRIGGERED: {from pace-alarm}
CACHE_STALE: {from pace-alarm}
CACHE_MTIME: {from pace-alarm}
CACHE_HOURS_OLD: {from pace-alarm}
NOTION_CARD_ID: {uuid or "none" or "none-no-stage-12-rows"}
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

`TARGET_PER_DAY`, `WEEKLY_TARGET`, etc. are NOT hardcoded in this doc — they come from the script, which reads `config/profile.yml`. Update the targets there.

## Failure handling

- `scripts/metrics/pace-alarm.mjs` fails → log `ROUTINE_ABORT: scripts/metrics/pace-alarm.mjs failed: {stderr}` and exit non-zero. No Notion writes.
- No Stage 1/2 row exists to comment on → set `ALARM_TRIGGERED: true` and `NOTION_CARD_ID: none-no-stage-12-rows` and exit 0. The alarm condition still gets logged for `pace-check.md` history.
- Notion rate-limit → wait 30s, retry once.

## What this routine does NOT do

- Does NOT generate PDFs, scan portals, or evaluate JDs.
- Does NOT message the candidate externally (no email, no Slack — Notion is the surface).
- Does NOT auto-apply to anything. Pace recovery is the candidate's decision, made in Cowork the next morning.
