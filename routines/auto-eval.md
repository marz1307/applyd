# Routine: Nightly Auto-Evaluation (21:00 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). No human is available to clarify or approve mid-run. Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT prompt for confirmation. Do NOT pause and wait.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 21:00 UK time. Companion routine: `auto-draft.md` (21:30 UK, drafts artifacts for Stage 2 rows that cleared the floor).

## Goal

Take everything in **Stage `1. Discovered`** in the Notion Applications DB and run an A–G evaluation (`modes/oferta.md`) for each, scoring on 0–100. Transition to `2. Triaged` if Match score ≥ `triage.score_floor` (default 80). Otherwise archive the row (`trash_below_floor: true` semantic — Notion `archived: true`) rather than moving it to `Not pursuing`; the DB then only holds candidates worth drafting. This replaces the human-driven evaluate-each-URL step in Cowork.

## Config (read from `config/profile.yml`)

- `notion.applications_data_source_id` — Applications DB UUID.
- `triage.score_floor` — defaults to 80. Surface in Fit notes if you used a different value.
- `triage.override_floor` — defaults to a few points below `score_floor`. The recruiter-sim INVITE override MAY promote a sub-floor row into `2. Triaged` on qualitative signals (sponsor-license window, visa-clock urgency, unmistakable tier-1 fit) — but NEVER below `override_floor`. Enforce this deterministically in the eval-write step; do not trust prompt discipline alone.
- `triage.max_evaluations_per_run` — hard cap; do NOT exceed.

If `config/profile.yml` is missing, log `ROUTINE_ABORT: config/profile.yml missing` and exit non-zero.

## Pre-flight checks (fail fast)

1. `cwd` must be the repo root.
2. Notion MCP reachable. Single `notion-search` against the Applications DB with `query: ""` — if auth fails, log `ROUTINE_ABORT: notion oauth needed` and exit.
3. Read `modes/oferta.md` and `modes/notion-tracker.md` once into context — they are the evaluation rubric and the schema.

## Steps

1. **Enumerate the full Stage-1 queue via the REST helper:**
   ```
   node scripts/notion/notion-query.mjs --stage "1. Discovered" --json > data/.routine-tmp/eval-queue.json
   ```
   This calls the official Notion REST API with proper filter + pagination (the `notion-search` MCP tool is capped at 25 semantic results and previously missed ~85% of the queue). Sort the JSON array by `discovered_date` ASC (oldest first — fairer), then process up to `triage.max_evaluations_per_run` rows. If the script aborts with `NOTION_TOKEN env var not set`, log `ROUTINE_ABORT: NOTION_TOKEN missing — operator needs to provision integration token` and exit.

2. **For each row, in order:**
   - Fetch the `Job URL` from the Notion page. If absent, write `Fit notes: ROUTINE_SKIP: no Job URL` and **leave the row at Stage 1** (don't transition).
   - Fetch the JD content via WebFetch on `Job URL`. If 404 or expired (no apply control, expired-listing signals per `modes/oferta.md` Block G), set `Stage = Not pursuing`, write `Match score = 0`, and start Fit notes with `[demoted YYYY-MM-DD] reason: posting_expired | <one-line detail>` per the structured-reason rule below.

   - **Employer-name reconciliation (locked 2026-05-30).** If the row's `Company` field starts with `Undisclosed (` OR matches any of these failure patterns (`Xing posting`, `LinkedIn posting`, contains ` — ` followed by a city name, looks like a job title with `(m/w/d)` or `(f/m/x)` suffix, or matches a known recruiter chain like `Jobriver`, `HEADMATCH`, `apsa`, `Hays`, `Page Group`, `Robert Half`, `Michael Page`), then:
     1. Parse `application/ld+json` blocks from the fetched JD HTML
     2. Find the `JobPosting` entry, read `hiringOrganization.name`
     3. If different from the current `Company` value, PATCH the Notion `Company` title with the JSON-LD name (truncate to 200 chars)
     4. Append `[auto-eval employer-fix] Company corrected from "{old}" via JSON-LD hiringOrganization.` to Fit notes
   This is the post-hoc fix for the failure mode where lunchtime-scan / bd-bulk-scan captured a recruiter chain or a job-title-as-company. Real employers reach recruiters; placeholders and titles do not.
   - If the JD is reachable, run the **A–G evaluation per `modes/oferta.md`**:
     - A. Compensation / band fit (use `compensation.target_range` from profile)
     - B. Role family / archetype match (use `target_roles.archetypes`)
     - C. Location / country gate (use `target_markets`)
     - D. Tech-stack signal (use `narrative.superpowers` + role family)
     - E. Seniority band — **Junior AND mid-level are the primary target band, on equal footing.** Well-fitting Graduate/Trainee/entry-scheme data-AI roles are also in scope. Score Junior and mid roles the same on this axis; do NOT down-score a role for being Junior or entry-level. Only OVER-level terms disqualify: Senior/Lead/Staff/Principal/Manager/Director.
     - F. Company-tier preference (Tier 1 > Tier 2 > Tier 3 per `portals.yml`)
     - G. Posting legitimacy (per `modes/oferta.md` Block G)
   - Compute a 1–5 global score per the rubric, then `Match score = round(global * 20)`.

   - **Then run an inline recruiter-sim using the rules in `modes/cv-quality-rules.md` Section 5** (no IDE skill dependency under headless `claude -p`). Apply the INVITE/MAYBE/REJECT predictors against the JD + the profile's CV. The verdict is stored as the row's `Recruiter-sim verdict` (Notion select field). Compare against the A-G score:
     - If A-G ≥ `score_floor` AND recruiter-sim = `REJECT` → demote to `Not pursuing` and prepend `⚠ Recruiter-sim REJECT despite global ≥ 75 ({reason})` to Fit notes. This catches the "looks good on paper but hidden filter would block it" case (visa, seniority, location subtlety).
     - If A-G < `score_floor` AND recruiter-sim = `INVITE` → promote to `2. Triaged` anyway. Recruiter intuition beats the rubric in this case.
     - Otherwise → use A-G score for the Stage transition decision.

   - Write to Notion via the deterministic writer **`node scripts/notion/notion-eval-write.mjs`** — the single tested write path (mirrors `notion-draft-write.mjs`; handles Match score + Recruiter-sim verdict + Fit notes + Agent run ID + Stage transition + below-floor archive in one call). Do NOT hand-roll inline `notion-update-page`/REST writes — they drift from the script. Compute the values below, then invoke it once per row (see the invocation block at the end of this step):
     - `Match score` (number, 0–100) — **MANDATORY for every row, including demotions.** Never leave null. If the JD couldn't be evaluated for any reason, write a low integer with the reason (e.g. 0 for "unreachable", 10 for "aggregator", 20 for "off-role", 30 for "wrong-geo", etc.). Operator must be able to filter by score in Notion at any time.
     - `Recruiter-sim verdict` (select: INVITE / MAYBE / REJECT)
     - `Fit notes` (rich_text): two paragraphs — first sentence the biggest gap or strongest fit, second the score breakdown by block, third the recruiter-sim reasoning (one sentence).
     - **For any DEMOTION (trash OR Not pursuing) the FIRST line of Fit notes MUST be a structured reason tag in this exact format:**
       ```
       [demoted YYYY-MM-DD] reason: <category> | <one-line detail>
       ```
       where `<category>` is one of:
       - `posting_expired` — JD URL returns 404, "no longer accepting", or expired-listing signals
       - `aggregator` — recruiter aggregator / job-board reseller (Hire Feed, Indeed reseller, Morgan McKinley generic role, etc.)
       - `off_role` — role outside the candidate's target band (Software Engineer, Frontend, Embedded, hardware, sales, marketing)
       - `wrong_geo` — country/work-authorisation makes the role impractical (US, India, SG, hard-relocation)
       - `seniority_mismatch` — OVER-level only: Senior/Staff/Principal/Manager/Director. **Graduate/Trainee/Junior data-or-AI roles are IN scope (candidate is open to entry-level bands that fit) — do NOT demote these.** Only demote Intern/Werkstudent/Apprentice student placements with no graduate-hire path.
       - `language_gate` — C1+ German required, candidate is B1 → B2
       - `low_score` — A-G < `score_floor` AND recruiter-sim ≠ INVITE
       - `recruiter_sim_reject` — A-G ≥ `score_floor` but recruiter-sim returns REJECT
       - `duplicate` — already in Stage 2+ for same company+city
       - `dead_company` — known stale / shell / agency-only listing
       Examples:
       - `[demoted 2026-06-13] reason: aggregator | Hire Feed generic Data Engineer cross-post`
       - `[demoted 2026-06-13] reason: off_role | role is Software Engineer (backend Go), not data`
       - `[demoted 2026-06-13] reason: wrong_geo | US-only, no relocation budget mentioned`
       - `[demoted 2026-06-13] reason: seniority_mismatch | Staff Engineer / 10+ years required`
       - `[demoted 2026-06-13] reason: language_gate | Job ad requires verhandlungssicheres Deutsch (C1)`
       - `[demoted 2026-06-13] reason: posting_expired | Stepstone returned "Stellenanzeige nicht mehr verfügbar"`
       The structured tag goes BEFORE the existing two-paragraph score breakdown. Operator filter: `Fit notes contains "reason: aggregator"` immediately surfaces all rows demoted for that category.
     - **Invocation** (once per row):
       ```
       node scripts/notion/notion-eval-write.mjs --page {id} --score {0-100} \
         --verdict {INVITE|MAYBE|REJECT} --decision {promote|demote|notpursuing} \
         --runid auto-eval-{YYYY-MM-DD-HHMM} --notes "{fit notes text}"
       ```
        - `--decision promote` → `Stage = 2. Triaged` (+ Agent run ID). Use for effective-PROMOTE.
        - `--decision demote` → **archives the page** (`{ archived: true }` → Notion Trash, recoverable 30d, hidden from views), per `triage.trash_below_floor: true`. This is the operator's "never save below-floor rows" rule from 2026-05-25. Use for below-floor / trash demotions.
        - `--decision notpursuing` → `Stage = Not pursuing` (kept as a visible funnel record rather than trashed — use for expired/off-role you want to still see).

3. **Do NOT generate any PDFs or cover letters.** Drafting is `auto-draft.md`'s job at 21:30. Just score and transition.

4. **Emit drop-and-replace signal for the next chrome-scan.** After all rows in this run are decided, tally how many were demoted to `Not pursuing` per portal. Write `data/.routine-tmp/replacements-needed.json`:
   ```json
   {
     "generated_at": "{iso}",
     "ttl_hours": 24,
     "needed": {
       "Xing": 12,
       "LinkedIn": 3,
       "Stepstone": 7,
       ...
     }
   }
   ```
   The next `chrome-scan-visible` run reads this file; if it exists and is fresher than `ttl_hours`, each portal's scrape target becomes `30 + needed[portal]` (over-fetch to backfill the rejected ones). After the chrome-scan consumes it, it deletes the file. This is the "drop and replace" handshake — `<75` rows get dropped to Not pursuing AND the system actively backfills.

## Output contract (write to stdout, ONE block)

The wrapper (`run-routine.ps1`) validates the presence of this block. Echo NUMBERS verbatim — no narration prose.

```
--- ROUTINE_CONTRACT ---
ROUTINE: auto-eval
TIMESTAMP_UTC: {iso}
QUEUE_DEPTH: {n}                       # Stage-1 rows before this run
EVALUATED: {n}                         # rows processed
PROMOTED_TO_TRIAGED: {n}                # effective decision (A-G + recruiter-sim)
DEMOTED_TO_NOT_PURSUING: {n}            # effective decision
SKIPPED_NO_URL: {n}
SKIPPED_FETCH_FAILED: {n}
SCORE_FLOOR_USED: {n}
AVERAGE_SCORE: {f}                      # over EVALUATED
HIGHEST_SCORE_COMPANY: {short}          # e.g. "Zalando(91)" or "none"
RECRUITER_SIM_INVOCATIONS: {n}          # should equal EVALUATED
RECRUITER_SIM_INVITE: {n}
RECRUITER_SIM_MAYBE: {n}
RECRUITER_SIM_REJECT: {n}
RECRUITER_SIM_OVERRIDES: {n}            # cases where recruiter-sim flipped the A-G decision
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- Individual row failure → log to `ERROR_DETAILS`, leave row at Stage 1, continue.
- LLM rate-limit / 429 → wait 60s, retry that row once. If it fails again, skip and continue.
- Notion rate-limit → wait 30s, retry. After 3 retries, exit non-zero with rows-already-written intact.
- WebFetch blocked for a domain → fall back to Bright Data `bdata scrape` if available (lunchtime-scan-style); else mark `SKIPPED_FETCH_FAILED` and continue.
- `triage.max_evaluations_per_run` reached → exit cleanly with `EVALUATED: max`; remaining rows wait for tomorrow.

## What this routine does NOT do

- Does NOT generate PDFs (`auto-draft.md`'s job).
- Does NOT submit applications (always human).
- Does NOT auto-promote Stage 2 → Stage 3.
- Does NOT modify rows already past Stage 1.
