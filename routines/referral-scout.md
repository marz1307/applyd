# Routine: Nightly Referral Scout (21:45 UK weekdays)

**PURE-SCRIPT routine (2026-07-07).** Executed as `node scripts/scan/referral-scout-run.mjs` directly by `routines/run-routine.ps1` — NOT via `claude -p`, so it is immune to the headless-OAuth 401 that empties the LLM routines' logs. It needs only `NOTION_TOKEN`. This file is now the human-readable **spec** for the writer: the steps below describe what `referral-scout-run.mjs` does deterministically (it self-provisions the queue, classifies, and writes). No LLM runs it.

## Owner

Claude Code, scheduled via Windows Task Scheduler. Runs weekdays at 21:45 UK time, **after** `auto-draft.md` (21:30) so the Stage-3 `Drafted` queue is populated before scouting.

## Goal

For every row in **Stage `3. Drafted`** that does NOT already carry the `[referral-scout` sentinel in `Fit notes`, generate an **affiliation-first referral scouting plan** and write it back to the row. By the morning apply window, every drafted application carries a ready warm-path plan so the candidate (or the Cowork `contacto` mode) can act before applying cold.

**Hard boundary — what this routine CANNOT do headless:** it cannot browse the candidate's logged-in LinkedIn, so it cannot pull actual 2nd-degree names. That step is reserved for the Cowork side (`modes/contacto.md` Step 0, driven via Claude-in-Chrome with the candidate present). This routine produces the *scouting plan + search URLs*; the human/Cowork step executes the warm-intro pull. Do not attempt logged-in LinkedIn scraping here.

## Config (read from `config/profile.yml`)

- `notion.applications_data_source_id` / `notion.applications_database_id`
- `triage.max_drafts_per_run` — reuse as the per-run cap (default 20).
- Affiliation bases are fixed (below) — they come from `cv.md` / `modes/_profile.md`.

## Affiliation bases (the warm-path inputs)

Read from `config/profile.yml` and `cv.md`:
- **Universities:** from the candidate's education history
- **Employers:** from the candidate's work history
- **Programs/Communities:** from the candidate's affiliations (e.g. professional networks, open-source communities)

## Pre-flight checks

1. `cwd` must be the repo root.
2. `NOTION_TOKEN` set, else `ROUTINE_ABORT: NOTION_TOKEN missing — operator needs to provision integration token`.
3. `notion-query.mjs` present.

## Steps

1. **Enumerate the Drafted queue:**
   ```
   node scripts/notion/notion-query.mjs --stage "3. Drafted" --json > data/.routine-tmp/scout-queue.json
   ```
   Filter to rows whose `fit_notes` does NOT contain `[referral-scout`. Sort by `match_score` DESC. Cap at `triage.max_drafts_per_run`.

2. **For each row, build the scouting plan deterministically:**

   **2a. Classify the company type** from `Company` + JD:
   - **Staffing / intermediary** (name contains "Consulting", "HR Service", "Recruit", "Staffing", "Personal", "GmbH" that is clearly an agency, or the JD is an undisclosed-client posting) → no affiliation play. Plan = "Contact the posting recruiter directly; ask which end client." Set warm_angle = `recruiter-direct`. Skip search-URL generation.
   - **End employer** → continue to 2b.

   **2b. Rank the warm angle** for this company (highest first that plausibly applies):
   1. `ex-colleague` — always list as a check (the candidate's former employers' alumni who moved there).
   2. `2nd-degree` — defer to Cowork (note it; cannot run headless).
   3. `alumni` — the candidate's universities (read from profile).
   4. `mlsa` — the candidate's professional network memberships (from profile) (boost for adjacent / large enterprises).
   5. `community` — dbt / modern-data-stack (boost for modern-stack scaleups).

   **2c. Generate 2 LinkedIn search URLs** using the keyword-search format (URL-encode spaces as `%20`, quotes as `%22`):
   - Alumni: `https://www.linkedin.com/search/results/people/?keywords={Company}%20%22<university-from-profile>%22`
   - Program: `https://www.linkedin.com/search/results/people/?keywords={Company}%20%22<program-from-profile>%22`
   - For companies in the candidate's primary country, prefer the alumni URL first (best overlap). For large enterprises, prefer the program URL first.

   **2d. Pick the cold fallback** (if no warm path is found): `hiring-manager` for scaleups, `recruiter` for enterprises — to be drafted later via `contacto.md`.

   **2e. Decide whether a genuine warm path exists** (this is the trigger the weekly Layer-3 cold-scout, `bd-referral-scout`, reads). Set `warm_path = none` ONLY when there is no plausible affiliation overlap, i.e.:
   - the company is a **staffing / intermediary** (2a routed it to `recruiter-direct`), OR
   - the company is an **end employer** but none of the ranked warm angles in 2b plausibly applies: no ex-colleague path, outside the candidate's alumni footprint, not in the candidate's professional networks, and not a modern-data-stack community fit — so the alumni/MLSA keyword URLs would surface nobody real.

   Otherwise set `warm_path = found`. Be conservative: a generic alumni/MLSA keyword URL that is unlikely to surface an actual mutual is NOT a warm path — prefer `none` so Layer-3 can attempt cold public-profile discovery. When `warm_path = none`, still record the cold fallback from 2d.

3. **Write the plan back to Notion via the deterministic writer** — run `node scripts/scan/referral-scout-run.mjs` (mirrors how `auto-eval.md` invokes `notion-eval-write.mjs`; do NOT hand-roll inline `notion-update-page`/REST writes — they drift, and `notion-update-page` is not a script). It reads `data/.routine-tmp/scout-queue.json` from Step 1, applies the §2a–2e classification deterministically (staffing vs end-employer; warm-path via alumni-footprint / MLSA / modern-stack heuristics), writes the fields below, appends the Step-4 playbook, and emits the ROUTINE_CONTRACT. Preview safely with `--dry-run` (writes nothing).
   - `Fit notes` (prepend, preserve prior notes). The `Warm path:` line is the machine-read handoff to Layer-3 — when `none`, it carries the literal token `no-warm-path` so `bd-referral-scout` selects the row:
     ```
     [referral-scout {YYYY-MM-DD}]
     Warm path: {found | none, cold-only (no-warm-path)}
     Warm angle (ranked): {e.g. alumni > mlsa > 2nd-degree | none}
     LinkedIn (alumni): {url | n/a}
     LinkedIn (MLSA):   {url | n/a}
     2nd-degree pull: run from logged-in LinkedIn (Cowork contacto Step 0).
     Cold fallback: {hiring-manager|recruiter}.
     ```
   - `Next action` (only if currently empty or a generic apply note): `Scout referral (warm-mutual) before applying — see Fit notes`.
   - Do NOT change `Stage`. Do NOT touch file properties.

4. **Playbook append (handled by the writer in Step 3):** `referral-scout-run.mjs` appends a dated `## Auto-scout {YYYY-MM-DD}` section to `data/referral-scouting.md` — one line per company with its ranked warm angle + the two URLs (idempotent: rows are appended under an existing same-day heading rather than duplicating it). No manual write needed.

5. **Do NOT** browse LinkedIn, send any message, or create outreach DB rows. Outreach drafting + the 2nd-degree pull are Cowork-side (`contacto.md`).

## Output contract (write to stdout, ONE block)

```
--- ROUTINE_CONTRACT ---
ROUTINE: referral-scout
TIMESTAMP_UTC: {iso}
QUEUE_DEPTH: {n}                # Stage-3 rows without [referral-scout sentinel before this run
SCOUTED: {n}                    # rows given a scouting plan this run
END_EMPLOYER: {n}               # rows classified as end employers (got affiliation search URLs)
STAFFING_INTERMEDIARY: {n}      # rows routed to recruiter-direct (no affiliation play)
NO_WARM_PATH: {n}               # rows flagged warm_path=none (the Layer-3 cold-scout queue)
TOP_TARGET: {short}             # e.g. "Zalando-Data-Engineer(91)"
NOTION_WRITE_FAILURES: {n}
SKIPPED_ALREADY_SCOUTED: {n}
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- Notion rate-limit → 30s wait, retry. After 3 retries, exit with rows scouted so far intact.
- `triage.max_drafts_per_run` reached → exit cleanly; remaining wait until tomorrow.
- A single row fails to update → log to ERROR_DETAILS, continue with the rest.

## What this routine does NOT do

- Does NOT browse logged-in LinkedIn or pull 2nd-degree names (Cowork-only).
- Does NOT send outreach or write to the Referral & Outreach DB (that's `contacto.md`).
- Does NOT change Stage or touch file properties.
- Does NOT submit applications.
- Does NOT push to git.
