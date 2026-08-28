# Mode: job — Full A-G Evaluation

When the candidate pastes a job (text or URL), ALWAYS deliver the 7 blocks (A-F evaluation + G legitimacy).

---

## Step −1 — URL ↔ JD coherence (MANDATORY, BEFORE anything else)

**Before** running Step 0 (archetype detection) or any A–G block, verify that what is being evaluated actually matches the URL being recorded. A wrong title or company on a real URL contaminates every downstream artefact: the report, the Notion row, the tailored CV filename, the apply step, the tracker stats, the patterns analysis. Getting this right is non-negotiable.

### What to fetch and what to compare

1. **Fetch the live JD via the providers fetch-chain** (`$ENGINE_DIR/providers/_fetch-chain.mjs`):

   ```js
   import { fetchForCoherence } from "<engine_dir>/providers/_fetch-chain.mjs";
   const result = await fetchForCoherence(url, { interactive: true });
   ```

   The chain tries each tier in order until one succeeds:
   - **Firecrawl** (self-host or cloud) — preferred when configured. Returns clean markdown + metadata.
   - **Bright Data Web Unlocker** — used when `BRIGHTDATA_API_KEY` is set. Bypasses bot detection.
   - **Browser automation** (interactive only) — falls through with `code='agent-playwright-fallback'`; the agent then navigates + snapshots the rendered page directly (Claude: Playwright MCP `browser_navigate` + `browser_snapshot`; other agents: their equivalent).
   - **Plain web fetch** — last-resort no-auth fetch for headless / batch mode (Claude: `WebFetch`; Codex: shell + curl).

   The result shape:
   ```
   { finalUrl, title, company, body, isAlive, source }
   ```

   Capture all five fields plus `source` (records which tier produced the data — written into the Verified block for audit).

2. **Extract the same fields from the user-provided source**:
   - If the user pasted a URL only → use the URL itself plus whatever they said about it in chat ("evaluate this Analytics Engineer role at Acme").
   - If the user pasted JD text → use the title and company from the text.

3. **Compare**:
   - **URL stability**: final URL after redirect must contain a posting-style path segment (e.g. `/jobs/`, `/job-listing/`, `/careers/`, `/positions/`, a posting ID). If the redirect lands on a generic page (`/jobs`, `/careers`, `/`), flag URL_LOST.
   - **Title coherence**: the page `<title>` or H1 must contain the role-family keywords the user named. If the user said "Analytics Engineer" and the page shows "Senior Sales Director", flag TITLE_MISMATCH.
   - **Company coherence**: the company name on the page must match what the user named (case-insensitive substring, both directions). If the user said "Acme" and the page shows "Acme Corporation" or vice versa → match. If they're entirely different brands → flag COMPANY_MISMATCH.
   - **Liveness**: page body must contain JD content, not just nav/footer/login wall. If body is < 500 meaningful chars or matches known dead-page templates ("This job is no longer available", "404", "Access denied"), flag JD_DEAD.

### Failure handling (HARD STOPS)

| Flag | Action |
|---|---|
| `URL_LOST` (redirected to generic page) | **Do NOT evaluate.** Surface to the user: "The URL redirected to {final_url}, which doesn't look like a job posting. The original posting may have been pulled. Want me to skip, or do you have a different URL?" |
| `TITLE_MISMATCH` (page title doesn't include the role family the user named) | **Do NOT evaluate.** Surface: "You said this is a {claimed_role}, but the page shows {actual_title}. This usually means the URL is stale or you pasted the wrong one. Confirm before I continue, or paste the correct URL." |
| `COMPANY_MISMATCH` (page company doesn't match the user's named company) | **Do NOT evaluate.** Surface: "You said this is at {claimed_company}, but the page is on {actual_company}. Confirm or correct." |
| `JD_DEAD` (page body lacks JD content) | **Do NOT evaluate.** Set the Notion row's Stage to `Withdrew` with `Fit notes: "JD dead / page returned no content at {timestamp}"`. Surface to user. |

If any of these fires, **stop here**. Do not write a report, do not create a Notion row, do not generate a PDF. The whole point of Step −1 is to catch the mismatch before it propagates.

### Success — record the verified facts

When all four checks pass, record the verified facts at the top of the report:

```markdown
**Verified:** URL ↔ JD coherence checked at {YYYY-MM-DDTHH:MMZ}
- Final URL: {final_url_after_redirect}
- Page title: "{page_title}"
- Company on page: {company}
- Role on page: {role_title}
- JD body length: {N} chars (passes liveness)
```

This block is REQUIRED in every report. It is what later tracker hygiene checks read to detect drift between the row's claimed identity and the URL's actual content.

### Batch / headless mode

When running under a headless agent CLI (`claude -p`, `codex exec`, `gemini -p`, …) with no browser automation, the same checks apply via a plain web fetch. Mark the report header `**Verification:** unconfirmed (batch mode, web-fetch only)` and run a tighter title-only match — never write a Notion row at Stage 2 or higher from batch mode if the title check fails.

---

## Step 0 — Archetype Detection

Classify the job into one of the 6 archetypes (see `_shared.md`). If it is a hybrid, indicate the 2 closest ones. This determines:
- Which proof points to prioritize in block B
- How to rewrite the summary in block E
- Which STAR stories to prepare in block F

## Block A — Role Summary

Table with:
- Archetype detected
- Domain (platform/agentic/LLMOps/ML/enterprise)
- Function (build/consult/manage/deploy)
- Seniority
- Remote (full/hybrid/onsite)
- Team size (if mentioned)
- TL;DR in 1 sentence

## Block B — Match with CV

Read `cv.md`. Create a table with each JD requirement mapped to exact lines in the CV.

**Adapted to the archetype:**
- If FDE → prioritize delivery speed and client-facing proof points
- If SA → prioritize system design and integrations
- If PM → prioritize product discovery and metrics
- If LLMOps → prioritize evals, observability, pipelines
- If Agentic → prioritize multi-agent, HITL, orchestration
- If Transformation → prioritize change management, adoption, scaling

**Gaps** section with mitigation strategy for each. For each gap:
1. Is it a hard blocker or a nice-to-have?
2. Can the candidate demonstrate adjacent experience?
3. Is there a portfolio project that covers this gap?
4. Concrete mitigation plan (phrase for cover letter, quick project, etc.)

## Block C — Level and Strategy

1. **Level detected** in the JD vs **candidate's natural level for that archetype**
2. **"Sell senior without lying" plan**: specific phrases adapted to the archetype, concrete achievements to highlight, how to position founder experience as an advantage
3. **"If they downlevel me" plan**: accept if compensation is fair, negotiate 6-month review, clear promotion criteria

## Block D — Comp and Demand

**Read `modes/_profile.md` → "Your Comp Targets" first.** It contains the candidate's primary market, reference ranges, and research-source preferences. Adapt the steps below to whichever market the candidate has set.

### Step 1 — Research sources

1. **Glassdoor** — company + title at the country's locale (e.g. `glassdoor.com`, `glassdoor.co.uk`, `glassdoor.fr`).
2. **LinkedIn Salary Insights** — title + city.
3. **Levels.fyi** — strong for tech-company total comp at the senior+ end.
4. **Local job-board salary reports** — Reed.co.uk for UK, Honeypot.io for pan-European tech, etc.
5. **Company reputation read** — Glassdoor reviews, Blind, or a local equivalent.

**UK addenda:** note IR35 status if the role is contract.

### Step 2 — Currency and quoting conventions

- **Quote in the currency the contracting entity uses** (USD, GBP, EUR, etc.).
- **Always specify annual gross** unless the user's market convention is different.
- **Note benefits explicitly** — vacation days, pension, equity, bonuses, transport / meal subsidies — anything that materially changes total comp.

### Step 3 — Cross-check against the candidate's seniority band

Read `modes/_profile.md` → "Candidate Persona" and "Scoring Weights" for the candidate's target band. If the JD's salary range is **above** the candidate's band (e.g. JD says Senior, candidate is targeting mid-level), this is itself a seniority-mismatch flag and should propagate into Block C ("Level and Strategy") as a red flag.

### Step 4 — Output table

| Source | Role title | City / region | Range (gross, annual) | Currency | Notes |
|--------|-----------|---------------|------------------------|----------|-------|
| Glassdoor | ... | ... | X–Y | ... | (n=N reports) |
| LinkedIn Salary Insights | ... | ... | X–Y | ... | ... |
| Company-specific reputation | ... | ... | n/a | — | rating, common complaints, common praise |

### Step 5 — Salary-not-stated handling

Salary-line norms differ by market. In some markets (e.g. Germany) omission is common and not a red flag; in others (UK, US tech) it is more unusual. Note it neutrally and flag in Block G only if the market convention treats omission as concerning.

### Step 6 — Visa and work eligibility

Read `config/profile.yml → work_eligibility` (and any override in `modes/_profile.md` → "Your Location Policy") for the candidate's right to work. Use `work_eligibility.summary` and the per-market notes to flag any eligibility check the role needs (e.g. work-permit minimum salary thresholds, sponsorship availability). Never invent a visa story — if the profile doesn't say, note it as unknown.

Set the report/Notion `Visa/sponsorship` field to one of `Required` / `Not required` / `Unclear` based on whether this specific role needs sponsorship for this candidate.

**UK sponsor-licence check (only when `work_eligibility.needs_uk_sponsorship: true`).**
If the candidate needs UK sponsorship AND the role is UK-based, don't guess from company size — a UK employer can only sponsor a Skilled Worker visa if it holds a licence on the gov.uk register. Check it:

```
node scripts/scan/sponsor-check.mjs --company "<employer name>" --json
```

This matches the employer against the local copy of the gov.uk Register of licensed sponsors (`data/uk-sponsor-register/`, normalised + fuzzy) and returns `match` (high/medium/low/none), `skilledWorker` (holds a Skilled Worker licence), and `recommendedTag`. Apply the result:

| `recommendedTag` | Meaning | Scoring action |
|---|---|---|
| `uk-sponsor-licensed` | On register, holds a **Skilled Worker** licence (`match` high/medium) | Employer CAN sponsor. No visa penalty; tag `uk-sponsor-licensed`. |
| `uk-sponsor-route-mismatch` | On register but **not** for Skilled Worker (e.g. only Temporary Worker / GBM) | Licence won't cover a Skilled Worker hire. Treat as a visa risk; tag `uk-sponsor-route-mismatch` and flag in Block G. |
| `uk-no-sponsor-licence` | Not found (`match` none/low) | Employer likely **cannot sponsor** — treat as the first red flag and **deprioritise** (do not auto-skip unless the candidate has said so). Tag `uk-no-sponsor-licence`. |

**Eyeball `best.name` on EVERY match, not just medium/low.** Fuzzy resolution can pick the wrong legal entity even at `match: high` — a franchisee, subsidiary, or same-name-different-industry can outscore the real parent. Read the returned `best.name` before writing any `uk-sponsor-*` tag. The register is a point-in-time snapshot (filename carries the date, echoed in `registerSource`); if it's stale or the index is missing, see `data/uk-sponsor-register/README.md` (download the CSV, then `node scripts/scan/sponsor-check.mjs --rebuild`).

If `work_eligibility.needs_uk_sponsorship` is false (or the role isn't UK-based), skip this check entirely.

### Step 7 — Demand-trend read

Use one web search for the role-title + market + current year (e.g. `"Analytics Engineer" London 2026 demand`). Note: hiring freezes, layoff news, expansion announcements that affect this role.

### Step 8 — Sources and confidence

Cite every source. If multiple sources disagree, surface the range, not a single point estimate. **If no data is available, state it. Never invent a number.**

### Closing line (REQUIRED)

End the Block D output with the exact line:

> *"Verify current market rate before negotiating."*

## Block E — Customization Plan

| # | Section | Current status | Proposed change | Why |
|---|---------|---------------|------------------|---------|
| 1 | Summary | ... | ... | ... |
| ... | ... | ... | ... | ... |

Top 5 changes to CV + Top 5 changes to LinkedIn to maximize match.

## Block F — Interview Plan

6-10 STAR+R stories mapped to JD requirements (STAR + **Reflection**):

| # | JD Requirement | STAR+R Story | S | T | A | R | Reflection |
|---|-----------------|-----------------|---|---|---|---|------------|

The **Reflection** column captures what was learned or what would be done differently. This signals seniority — junior candidates describe what happened, senior candidates extract lessons.

**Story Bank:** If `interview-prep/story-bank.md` exists, check if any of these stories are already there. If not, append new ones. Over time this builds a reusable bank of 5-10 master stories that can be adapted to any interview question.

**Selected and framed according to the archetype:**
- FDE → emphasize delivery speed and client-facing
- SA → emphasize architectural decisions
- PM → emphasize discovery and trade-offs
- LLMOps → emphasize metrics, evals, production hardening
- Agentic → emphasize orchestration, error handling, HITL
- Transformation → emphasize adoption, organizational change

Also include:
- 1 recommended case study (which of their projects to present and how)
- Red-flag questions and how to answer them (e.g., "why did you sell your company?", "do you have a team of reports?")

## Block G — Posting Legitimacy

Analyze the job posting for signals that indicate whether this is a real, active opening. This helps the user prioritize their effort on opportunities most likely to result in a hiring process.

**Ethical framing:** Present observations, not accusations. Every signal has legitimate explanations. The user decides how to weigh them.

### Signals to analyze (in order):

**1. Posting Freshness** (from Playwright snapshot, already captured in Step 0):
- Date posted or "X days ago" -- extract from page
- Apply button state (active / closed / missing / redirects to generic page)
- If URL redirected to generic careers page, note it

**2. Description Quality** (from JD text):
- Does it name specific technologies, frameworks, tools?
- Does it mention team size, reporting structure, or org context?
- Are requirements realistic? (years of experience vs technology age)
- Is there a clear scope for the first 6-12 months?
- Is salary/compensation mentioned?
- What ratio of the JD is role-specific vs generic boilerplate?
- Any internal contradictions? (entry-level title + staff requirements, etc.)

**3. Company Hiring Signals** (2-3 web searches, combine with Block D research):
- Search: `"{company}" layoffs {year}` -- note date, scale, departments
- Search: `"{company}" hiring freeze {year}` -- note any announcements
- If layoffs found: are they in the same department as this role?

**4. Reposting Detection** (from scan-history.tsv):
- Check if company + similar role title appeared before with a different URL
- Note how many times and over what period

**5. Role Market Context** (qualitative, no additional queries):
- Is this a common role that typically fills in 4-6 weeks?
- Does the role make sense for this company's business?
- Is the seniority level one that legitimately takes longer to fill?

### Output format:

**Assessment:** One of three tiers:
- **High Confidence** -- Multiple signals suggest a real, active opening
- **Proceed with Caution** -- Mixed signals worth noting
- **Suspicious** -- Multiple ghost job indicators, investigate before investing time

**Signals table:** Each signal observed with its finding and weight (Positive / Neutral / Concerning).

**Context Notes:** Any caveats (niche role, government job, evergreen position, etc.) that explain potentially concerning signals.

### Edge case handling:
- **Government/academic postings:** Longer timelines are standard. Adjust thresholds (60-90 days is normal).
- **Evergreen/continuous hire postings:** If the JD explicitly says "ongoing" or "rolling," note it as context -- this is not a ghost job, it is a pipeline role.
- **Niche/executive roles:** Staff+, VP, Director, or highly specialized roles legitimately stay open for months. Adjust age thresholds accordingly.
- **Startup / pre-revenue:** Early-stage companies may have vague JDs because the role is genuinely undefined. Weight description vagueness less heavily.
- **No date available:** If posting age cannot be determined and no other signals are concerning, default to "Proceed with Caution" with a note that limited data was available. NEVER default to "Suspicious" without evidence.
- **Recruiter-sourced (no public posting):** Freshness signals unavailable. Note that active recruiter contact is itself a positive legitimacy signal.

---

## Post-evaluation

**ALWAYS** after generating blocks A-G:

### 1. Save report .md

Save full evaluation in `reports/{###}-{company-slug}-{YYYY-MM-DD}.md`.

- `{###}` = next sequential number (3 digits, zero-padded)
- `{company-slug}` = company name in lowercase, without spaces (use hyphens)
- `{YYYY-MM-DD}` = current date

**Report format:**

```markdown
# Evaluation: {Company} — {Role}

**Date:** {YYYY-MM-DD}
**URL:** {final_url_after_redirect}
**Archetype:** {detected}
**Score:** {X/5}
**Legitimacy:** {High Confidence | Proceed with Caution | Suspicious}
**PDF:** {path or pending}

**Verified:** URL ↔ JD coherence checked at {YYYY-MM-DDTHH:MMZ}
- Fetched via: {source} (firecrawl | bright-data | playwright | webfetch)
- Page title: "{page_title}"
- Company on page: {company} (matches header: yes/no)
- Role on page: {role_title} (matches header: yes/no)
- JD body length: {N} chars (passes liveness ≥ 500)

---

## A) Role Summary
(full content of block A)

## B) Match with CV
(full content of block B)

## C) Level and Strategy
(full content of block C)

## D) Comp and Demand
(full content of block D)

## E) Customization Plan
(full content of block E)

## F) Interview Plan
(full content of block F)

## G) Posting Legitimacy
(full content of block G)

## H) Draft Application Answers
(only if score >= 4.5 — draft answers for the application form)

---

## Keywords extracted
(list of 15-20 keywords from the JD for ATS optimization)
```

### 2. Record in Notion (system of record) + applications.md (local cache)

**READ `modes/notion-tracker.md` FIRST.** It has the DB IDs, schema, field mappings, stage transitions, and the hard 80-score floor.

**Step 2a — Notion write (PRIMARY).**

1. Run `notion-search` on the Applications DB filtered by `Job URL = {url}`. Dedup key.
2. If a row exists → `notion-update-page`. If not → `notion-create-pages` against the data source ID configured in `config/profile.yml → notion.data_source_id`.
3. Fields to write on UPSERT:
   - `Job URL` (the canonical posting URL — required, dedup key)
   - `Company` (title)
   - `Position` (multi_select — one tag per role family, e.g. `Analytics Engineer`)
   - `Source portal` (select — derived from URL host, see portal map in `notion-tracker.md`)
   - `Country`, `Location`, `Language`, `Work model`, `Industry`, `Seniority` (extracted from JD by Block A)
   - `Company tier` (set `Tier 1` if company is in `portals.yml` with `tier: 1`)
   - `Match score` (number, 0–100 — multiply the 1–5 global score by 20)
   - `Recruiter-sim verdict` (`INVITE` / `MAYBE` / `REJECT`) — see "Recruiter-sim integration" below for how this is computed
   - `Fit notes` (rich_text — 2 sentences: first names the report link + biggest strength, second names the biggest gap)
   - `JD snapshot` (first 2000 chars of the JD — only on INSERT, do not overwrite on update)
   - `Salary band` (string from Block D)
   - `Visa/sponsorship` (`Required` / `Not required` / `Unclear`)
   - `Discovered date` (today if INSERT; do not overwrite if UPDATE)
   - `Agent run ID` (current batch ID, or `interactive-{YYYY-MM-DD-HHMM}` for interactive runs)

4. **Stage transition logic (HARD):**
   - If **Match score < 75** → set `Stage = Not pursuing`. Write a one-sentence reason into `Fit notes`. **STOP HERE — do NOT continue to PDF generation.** No draft, no human triage.
   - If **Match score ≥ 75** → set `Stage = 2. Triaged`. Continue to downstream pdf mode.

5. Read `modes/notion-tracker.md → Error handling` for retry / fail behaviour.

**Step 2b — applications.md (LOCAL CACHE, parallel write).**

On Notion write SUCCESS, append the TSV row to `batch/tracker-additions/{id}.tsv` (the existing pipeline). If the Notion write failed, skip the TSV write — better to have no record than a diverging one. Surface the Notion error.

**TSV format (9 tab-separated columns; status BEFORE score; see `AGENTS.md → TSV format`):**

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report |
| 045 | 2026-05-23 | Zalando | Analytics Engineer | 4.3/5 | Evaluated | ✅ | [045](reports/045-zalando-2026-05-23.md) |
```

---

## Recruiter-sim integration

The Recruiter-sim verdict (`INVITE` / `MAYBE` / `REJECT`) is computed by an optional `recruiter-sim.md` slash command. If the user has one installed in `.claude/commands/recruiter-sim.md`, invoke it. That command runs a senior-recruiter persona over the CV + JD and returns a structured verdict with reasoning. If no such command exists, fall back to the simple global-score mapping below.

**Order of operations after Block F:**

1. Pass `cv.md` + the JD text + Block A's summary into the recruiter-sim command. If running interactively, invoke `/recruiter-sim`. If running in batch mode, the prompt body is the contents of `recruiter-sim.md` + the JD payload — run it through the local agent CLI (`claude -p`, `codex exec`, `gemini -p`, …) and capture the JSON output.
2. The recruiter-sim returns a structured response:
   ```yaml
   verdict: INVITE | MAYBE | REJECT
   reasons_for: ["...", "...", "..."]
   reasons_against: ["...", "...", "..."]
   biggest_blocker: "..."
   estimated_phone_screen_probability: 0–100
   filter_check:
     location_filter: pass | trigger
     language_filter: pass | trigger
   industry_diversity_read: "..."
   ```
3. **Write the verdict to Notion** (`Recruiter-sim verdict` field).
4. **Write the reasoning as a Notion comment** on the row via `notion-create-comment`. Comment body format:
   ```
   Recruiter-sim verdict: {verdict}
   Phone-screen probability: {N}%

   Reasons for: ...
   Reasons against: ...
   Biggest blocker: ...

   Filter checks: location={pass|trigger}, language={pass|trigger}
   Industry diversity read: ...
   ```
5. If `filter_check.location_filter` or `filter_check.language_filter` triggers, surface it as a hard flag in `Fit notes` — these are screening filters before the human ever sees the application.

**Fallback (when the recruiter-sim command is not available or fails):**

Use the simple global-score mapping: global ≥ 4.5 → `INVITE`; 3.5–4.4 → `MAYBE`; < 3.5 → `REJECT`. Note in `Fit notes` that this is the fallback mapping, not the full recruiter-sim run.

**Consistency check:**

If the global score is high (≥ 4.5) but the recruiter-sim returns `REJECT`, this is a meaningful signal — usually a hidden filter (location, visa, seniority above band) that the A–G evaluation didn't fully weight. Surface it as the first line in `Fit notes`, prefixed with `⚠ Recruiter-sim REJECT despite global 