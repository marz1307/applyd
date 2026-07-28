# Mode: apply — Live Application Assistant

Interactive mode for when the candidate is filling out an application form in Chrome. It reads what is on the screen, loads the previous context of the job, and generates personalized responses for each form question.

**Fit judgment is upstream.** Rows reaching this mode are already at Stage `3. Drafted` in Notion, meaning `modes/oferta.md` scored them ≥ `triage.score_floor` (default 70/100) and `modes/pdf.md` generated the tailored CV + cover letter. Do NOT re-evaluate the role's fit at apply time — that's stale work. Pull the existing Resume file and Cover letter from Notion; use them. If the user wants to bail on a Stage 3 row, set `Stage = Not pursuing` with reason in `Fit notes`. Do NOT downgrade to Stage 2.

## Requirements

- **Best with a browser-automation tool in visible mode** (Claude: Playwright MCP; other agents: their equivalent). The candidate sees the browser and the agent can interact with the page.
- **Without browser automation**: the candidate shares a screenshot or pastes the questions manually.

## Workflow

```text
1. DETECT      → Read active Chrome tab (screenshot/URL/title)
2. IDENTIFY    → Extract company + role from the page
3. SEARCH      → Match against existing reports in reports/
4. LOAD        → Read full report + Section G (if it exists)
5. COMPARE     → Does the role on screen match the one evaluated? If it changed → notify
6. ANALYZE     → Identify ALL visible form questions
7. GENERATE    → For each question, generate a personalized response
8. PRESENT     → Show formatted responses for copy-paste
```

## Step 1 — Detect the job

**With browser automation:** Take a snapshot of the active page. Read title, URL, and visible content.

**Without browser automation:** Ask the candidate to:
- Share a screenshot of the form (the agent's file-read capability can usually accept images)
- Or paste the form questions as text
- Or say company + role so we can search for it

## Step 2 — Identify and search for context

1. Extract company name and role title from the page
2. Search in `reports/` by company name (case-insensitive grep)
3. If there is a match → load the full report
4. If there is a Section G → load previous draft answers as a base
5. If there is NO match → notify and offer to run a quick auto-pipeline

## Step 3 — Detect changes in the role

If the role on screen differs from the one evaluated:
- **Notify the candidate**: "The role has changed from [X] to [Y]. Do you want me to re-evaluate or adapt the responses to the new title?"
- **If adapt**: Adjust responses to the new role without re-evaluating
- **If re-evaluate**: Execute full A-F evaluation, update report, regenerate Section G
- **Update tracker**: Change role title in applications.md if applicable

## Step 4 — Analyze form questions

Identify ALL visible questions:
- Free text fields (cover letter, why this role, etc.)
- Dropdowns (how did you hear, work authorization, etc.)
- Yes/No (relocation, visa, etc.)
- Salary fields (range, expectation)
- Upload fields (resume, cover letter PDF)

Classify each question:
- **Already answered in Section G** → adapt the existing response
- **New question** → generate response from the report + cv.md

## Step 5 — Generate responses

For each question, generate the response following:

1. **Report context**: Use proof points from block B, STAR stories from block F
2. **Previous Section G**: If a draft response exists, use it as a base and refine
3. **"I'm choosing you" tone**: Same auto-pipeline framework
4. **Specificity**: Reference something specific from the JD visible on screen
5. **applyd proof point**: Include in "Additional info" if there is a field for it

**Output format:**

```text
## Responses for [Company] — [Role]

Based on: Report #NNN | Score: X.X/5 | Archetype: [type]

---

### 1. [Exact form question]
> [Response ready for copy-paste]

### 2. [Next question]
> [Response]

...

---

Notes:
- [Any observations about the role, changes, etc.]
- [Personalization suggestions the candidate should review]
```

## Step 6 — Post-apply (Notion + local cache)

**READ `modes/notion-tracker.md` FIRST.** This step is the ONLY place applyd transitions a Notion row into Stage `4. Applied`. It is triggered by the user's explicit confirmation, never automatically.

### Trigger

the user must explicitly confirm submission. Examples that count as confirmation:
- "Submitted."
- "Done, applied."
- "Sent it."
- Pressing the confirm action in any UI prompt applyd surfaces.

A click-on-Submit observed via Playwright is NOT sufficient on its own — confirm verbally before transitioning the Notion row, in case the submission failed silently.

### Step 6a — Notion write (PRIMARY)

1. **Look up the Notion row by `Job URL`.** Run `notion-search` on the Applications DB filtered by `Job URL = {url}`. The row should already exist (created at Stage 1 by `scan.md` or `pipeline.md`, transitioned to Stage 2 by `oferta.md`, transitioned to Stage 3 by `pdf.md`).
2. **Verify pre-conditions** before transitioning:
   - The row's current `Stage` must be `3. Drafted`. If it's still `2. Triaged`, the PDF was not generated — flag and refuse the transition until `pdf.md` has run.
   - If it's already `4. Applied` → no-op, surface to the user with the existing `Apply date`.
   - If it's any later stage (`5. Assessment/OA` through `Signed`) or a terminal state (`Rejected`/`Withdrew`/`Not pursuing`) → refuse the transition and surface to the user. This is data integrity, not a feature.
3. **`notion-update-page` the row with:**
   - `Stage` = `4. Applied`
   - `Apply date` = today
   - `Resume` (files) — attach the tailored CV PDF generated by `pdf.md` (path: `output/{CandidateName}_CV_{CompanySlug}_{YYYY-MM-DD}.pdf`)
   - `Cover Letter` (files) — attach the cover letter PDF if one was generated (`output/{CandidateName}_Cover_Letter_{CompanySlug}_{YYYY-MM-DD}.pdf`)
   - `CV variant` (select) — per the variant `pdf.md` chose (one of the variants defined in `_profile.md`)
   - `CL variant` (select) — `General` / `Cover Letter` / `Skipped` (if no cover letter was generated)
   - `Recruiter name` and `Recruiter contact` if a named recruiter was identified during outreach
   - `Referral?` (checkbox) — true if a warm referral was used
   - `Next action` — default to `"Wait 1 week, then follow up if no response"`
   - `Next action date` — today + 7 days

4. **On Notion success**, add a comment to the row via `notion-create-comment` with the final form answers the user submitted (for audit). The comment body should reference Section G of the report.

### Step 6b — Local cache (parallel write)

After the Notion write succeeds:

1. Update `applications.md` directly: change the row's `Status` from `Evaluated` to `Applied`. (`apply.md` is allowed to UPDATE existing rows in `applications.md` — only INSERTs are restricted to the TSV pipeline.)
2. Update Section G of the report with the final responses the user submitted.

### Step 6c — Suggest next step

After both writes succeed:

- `/applyd contacto` for LinkedIn outreach to a named recruiter or referral.
- Or set up an explicit follow-up reminder using the scheduled-tasks system: "remind me in 7 days to chase {Company}".

### Error handling

If the Notion write fails:
- Do NOT update `applications.md`. Both writes must succeed together OR fail together — diverging states are worse than no state.
- Surface the error verbatim to the user with the row payload preserved so it can be retried.
- Do NOT auto-retry. the user decides whether the application actually went through and whether to retry the Notion transition.

## Scroll handling

If the form has more questions than the visible ones:
- Ask the candidate to scroll and share another screenshot
- Or paste the remaining questions
- Process in iterations until the entire form is covered
