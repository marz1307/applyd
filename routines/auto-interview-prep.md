# Routine: Auto-Interview-Prep (22:00 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT pause.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 22:00 UK time, after `auto-draft.md` (21:30). Fires on demand via `routines/run-routine.ps1 -Routine auto-interview-prep`.

## Goal

For each Notion row at **Stage 5 (Assessment/OA) or beyond (6. Phone screen, 7. Tech interview, 8. Onsite/Final, 9. Offer)** that does NOT yet have an interview-prep pack, generate a six-document pack tailored to that specific application, save under `interview-prep/{NUM}-{slug}/`, upload the key artifacts to the Notion row, and update Fit notes with a sentinel so re-runs skip it.

**Trigger rule (2026-07-01 design decision): interview prep fires ONLY at Stage 5 and beyond.** Stage 4 (Applied) is excluded: merely having applied is not an interview, so no prep is generated until a recruiter response advances the row to Stage 5+ (an assessment or interview).

When the candidate gets a recruiter response, the prep pack is already waiting.

## Config (read from `config/profile.yml`)

- `notion.applications_database_id`
- `triage.score_floor` — info-only, prep runs at any score that reached the trigger stage. The score gate was already applied upstream in auto-eval; do not re-apply it here.
- `candidate.*`, `narrative.*`, `target_roles.*`, `compensation.*` — used in prep generation.

## Pre-flight

1. `cwd` must be repo root.
2. `NOTION_TOKEN` present.
3. Notion MCP reachable.
4. Read `modes/oferta.md`, `cv.md`, `cv-de.md`, `interview-prep/story-bank.md`, `article-digest.md`, `modes/_profile.md` once into context — these are the personal context.

## Steps

### 1. Enumerate the prep queue

```
node scripts/notion/notion-query.mjs --json > data/.routine-tmp/all-rows.json
```

Filter client-side to rows whose `stage` is one of `["5. Assessment/OA", "6. Phone screen", "7. Tech interview", "8. Onsite/Final", "9. Offer"]` AND whose `fit_notes` does NOT contain `[interview-prep ` sentinel. **`4. Applied` is deliberately NOT in this set**: prep starts only once a row reaches an interview stage.

Sort by stage progression (later stages first, since a final round is more urgent than a fresh assessment), then by `apply_date` ascending (oldest first). Cap at 5 packs per run (per-session chunk, lowered from 10 on 2026-07-06 to keep the session small; each pack is context-heavy). Stage 5+ backlog is normally small, so remaining rows wait for the next 22:00 fire.

### 2. For each row, build the 6-doc pack

Output directory: `interview-prep/{APP-id}-{company-slug}/` (e.g. `interview-prep/APP-60-sumup/`).

Mkdir the directory. Then create exactly these 6 files:

#### `00-company-intel.md` — Company research

- Read `JD snapshot` from Notion (rich context already there).
- WebFetch the company's careers page or About page.
- Capture: funding stage (Crunchbase if reachable; Bright Data fallback), recent news (search "{company} news 2026"), employee count + growth trajectory, Glassdoor rating + 2 representative reviews, tech stack (from JD + careers page + GitHub if public), known recent hires at similar level.
- Output sections: **Snapshot**, **Funding & growth**, **Tech stack**, **Culture signals**, **Recent news (last 90 days)**, **Recent reviews — themes**, **Who you'll likely interview with** (try to extract names from LinkedIn search via the connected session if any).

#### `01-likely-questions.md` — Predicted interview questions

Generate ~25 likely questions tailored to:
- The JD's stated requirements (extract from `JD snapshot`)
- The company's interview style (Glassdoor Interview Reviews if available; otherwise inference from company tier and industry)
- The current `Stage` (e.g. 6. Phone screen → behavioural + motivation; 7. Tech interview → SQL/dbt/system design)

Organise as:
- **Behavioural (5–8)** — "Tell me about a time you …" by theme
- **Role-specific (8–12)** — tech-stack-grounded (e.g. AE roles: dbt incremental strategies, dimensional modelling trade-offs, SQL window functions for cohort analysis)
- **Case / take-home patterns (2–4)** — likely format if applicable
- **Reverse / motivation (3–5)** — "Why this company?", "Why are you leaving?", "Where do you see yourself in 3 years?"

For each question, add one line: *Best STAR-bank story to draw from:* {story name from `interview-prep/story-bank.md`}.

#### `02-star-stories.md` — JD-mapped STAR+R stories

Read `interview-prep/story-bank.md`. Select the 5–7 stories most relevant to THIS JD's requirements. For each:
- Title (matching the story bank)
- 2-line situation
- 3-line action (technical specifics: tool, scale, decision)
- 2-line result (metric)
- 1-line reflection: what you'd do differently / what you learned
- **JD-tie:** one sentence connecting the story to a specific JD requirement.

This is the document the candidate re-reads in the 30 minutes before the interview.

#### `03-technical-prep.md` — Stack-specific drill

Read the JD's tech stack. For each named tool/concept, write a 3–6 line "if asked, here's the answer pattern":
- Concept name
- the candidate's direct experience (cite evidence from cv.md / article-digest.md with numbers)
- One trade-off question + concise answer (e.g. "When would you use a snapshot vs an incremental? Snapshot when SCD-2 history matters; incremental when raw is append-only and recompute is expensive…")
- One landmine to avoid (anti-pattern the company likely cares about)

Cover the 6–10 most-mentioned items in the JD. No fluff.

#### `04-questions-to-ask.md` — Questions for the interviewer

8–12 questions, varied by interviewer type:
- **For the hiring manager (3–4):** team shape, what success looks like in 90 days, what they wish they'd known when they joined
- **For peers / IC interviewers (3–4):** how data quality is enforced, on-call cadence, CI/CD culture, what they're proud of, what they'd change
- **For the recruiter (2–3):** comp band, timeline, next steps
- **For the founder/exec (rare, 2–3):** strategic priorities, the team's 2-year arc

Each question should not be Google-able from the company website.

#### `05-comp-negotiation.md` — Salary research + walk-away

- Researched range for THIS role + city + seniority (use Stepstone Gehaltsreport for DE / Glassdoor + Reed for UK; cite the source).
- the candidate's anchor (from `compensation.target_range`).
- Walk-away floor (from `compensation.minimum` if set; otherwise calculated as market 25th-percentile − 5%).
- Counter-offer scripts: "If they offer at the low end…", "If they ask my expectation first…", "If they say no to my anchor…"
- Non-comp levers worth pursuing: signing bonus, equity refresh, training budget, 30/35 vacation days, EU Blue Card sponsorship support.

### 3. Upload key artifacts to Notion

For each row, upload via `node scripts/notion/notion-upload-file.mjs`:
- `00-company-intel.md` → attach to **Cover Letter** files (appended, not replacing). Naming: `Interview-Prep-Intel-{Company}.md`.
- `01-likely-questions.md` + `02-star-stories.md` + `03-technical-prep.md` → concatenate into one `Interview-Prep-Q-and-Stories-{Company}.md` and append to Cover Letter files.
- `04-questions-to-ask.md` + `05-comp-negotiation.md` → concatenate into one `Interview-Prep-Asks-and-Comp-{Company}.md` and append to Cover Letter files.

(The Notion DB has no dedicated "Interview prep" file property — appending to Cover Letter keeps everything per-row clickable without schema changes.)

### 4. Update Fit notes (rich_text, prepend with separator)

```
[interview-prep {YYYY-MM-DD-HHMM}]
6-doc prep pack at interview-prep/{NUM}-{slug}/
Uploaded to this row's Cover Letter files: 3 markdown bundles.
Review 30 min before the interview. Re-run this routine to regenerate after any JD update.
```

Preserve all prior Fit notes content.

## Output contract

```
--- ROUTINE_CONTRACT ---
ROUTINE: auto-interview-prep
TIMESTAMP_UTC: {iso}
QUEUE_DEPTH: {n}                     # Stage 5+ rows missing prep
PACKS_GENERATED: {n}
COMPANY_INTEL_DOCS: {n}
LIKELY_Q_DOCS: {n}
STAR_STORIES_DOCS: {n}
TECH_PREP_DOCS: {n}
ASKS_DOCS: {n}
COMP_DOCS: {n}
NOTION_UPLOADS_SUCCEEDED: {n}
NOTION_UPLOAD_FAILURES: {n}
WEBFETCH_FAILURES: {n}
TOP_PACK: {short}                    # e.g. "Eraneos-Analytics-Engineer(7. Tech interview)"
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Failure handling

- WebFetch of company page fails → use `JD snapshot` + Glassdoor search via `mcp__brightdata__*` as fallback. If still no data, mark company intel as `[needs manual research]` and continue with the other 5 docs.
- Notion upload fails → log to ERROR_DETAILS, keep local files (they're the source of truth), continue.
- LLM rate-limit → 60s wait, retry once.
- Cap reached (5 packs/run) → exit cleanly with TOP_PACK noted.

## What this routine does NOT do

- Does NOT submit applications.
- Does NOT modify rows at Stages 1–3.
- Does NOT touch the recruiter — no outbound messaging.
- Does NOT regenerate prep for rows that already have the sentinel (unless explicitly told to via a future `--force` flag).
- Does NOT delete prior auto-eval / auto-draft Fit notes content.

## Why this exists

The window between "I got the recruiter response" and "I'm on the call" is often 24–72 hours. Candidates typically spend 4–6 hours per interview on prep. This routine front-runs that work so the prep pack is already in Notion when the response email arrives. Total saved time per interview: ~5 hours of focused research.
