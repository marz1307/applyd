# Routine: Nightly Auto-Draft (21:30 UK weekdays)

You are running under a **headless agent CLI** (default: `claude -p`; alternatives: `codex exec`, `gemini -p`, …; dispatched by `routines/run-routine.ps1` via an adapter under `routines/adapters/`). No human is available to clarify or approve mid-run. Complete the routine in one pass and exit cleanly. Do NOT ask the user any questions. Do NOT prompt for confirmation. Do NOT pause and wait.

## Owner

Your agent's headless CLI, scheduled via Windows Task Scheduler. Runs weekdays at 21:30 UK time, after `auto-eval.md` (21:00). The 30-minute gap is intentional — auto-eval should be done before auto-draft runs.

## Goal

For every row in **Stage `2. Triaged`** in the Notion Applications DB that does NOT already have a Resume + Cover Letter attached, generate the tailored CV PDF + cover letter draft, attach them, and transition to `3. Drafted`. By the next morning's apply window, the candidate sees a queue of ready-to-send applications.

**Do NOT re-apply the score floor here.** Reaching `2. Triaged` IS the triage decision, made by auto-eval against `triage.score_floor` AND the bounded recruiter-sim override (`triage.override_floor`). Re-testing the score at draft time second-guesses that decision and, worse, silently strands every sim-promoted row: it can never be drafted and never leaves Stage 2. Draft what is at Stage 2.

## Config (read from `config/profile.yml`)

- `notion.applications_data_source_id`
- `triage.score_floor` — read for reporting only, defaults to 80.
- `triage.override_floor` — read for reporting only, informs which rows reached Stage 2 via the sim override.
- `triage.max_drafts_per_run` — per-SESSION chunk (default 7). Small session chunks keep `claude -p` context small; the drain-loop wrapper (`routines/drain-routine.ps1`) re-fires a fresh session per iteration until the target-stage backlog hits 0, so daily throughput is unchanged. The checkpoint is the Stage transition itself.
- `apply.channel_preference` — informs which channels to flag for follow-up.

## Pre-flight checks

1. `cwd` must be the repo root.
2. Notion MCP reachable.
3. `node scripts/cv/generate-pdf-tailored.mjs --help` (or a dry parse) must succeed.
4. `node scripts/cv/generate-pdf-tailored.mjs --archetype MASTER --lang en --company smoketest` must succeed and produce a PDF in `output/`. Delete any smoketest output after.
5. Read `modes/cv-quality-rules.md` ONCE into context — these rules govern every CV/cover-letter the routine produces (replaces resume-writer / tech-cv-review / humanizer / recruiter-sim IDE plugins).
4. `cv.md` AND `cv-de.md` must exist; `templates/cv-template.html` must exist.
5. Playwright Chromium installed (`%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64\chrome-headless-shell.exe` exists). If missing, log `ROUTINE_ABORT: playwright chromium missing` and exit non-zero.

## Steps

0. **Run branch-dedup FIRST (idempotent).** Apply the one-application-per-(company,city) rule before any draft work — recruiters flag scattershot applications.
   ```
   node scripts/tracker/branch-dedup.mjs
   ```
   Picks the highest-scoring row per (company, city) and **archives the rest to Notion Trash** (30-day restore window). Tie-breakers: Match score → recency → remote flexibility → stable APP-id. Idempotent — re-running on a clean queue is a no-op. After this step, the Stage-2 queue contains at most one row per branch.

1. **Enumerate the full draft queue via the REST helper:**
   ```
   node scripts/notion/notion-query.mjs --stage "2. Triaged" --sentinel-missing --json > data/.routine-tmp/draft-queue.json
   ```
   The `--sentinel-missing` flag returns only rows whose `Fit notes` do NOT yet contain `[auto-draft` — i.e. rows that need drafting. The script uses the official Notion REST API with proper filter + pagination (the `notion-search` MCP tool's 25-result cap previously prevented full queue enumeration). Sort the result by `match_score` DESC (highest-fit drafted first), cap at `triage.max_drafts_per_run`. If `NOTION_TOKEN` is missing, abort with `ROUTINE_ABORT: NOTION_TOKEN missing — operator needs to provision integration token`. NOTE: no `--min-score` filter — the score gate was already applied by auto-eval; re-applying it here strands sim-override promotions permanently.

2. **For each row:**

   **2a. Determine PDF language, archetype, country, and JD role title.**
   - Language: if the JD or Notion `Language` field is German → `--lang de`; else `--lang en`.
   - Archetype: the dominant `Position` multi-select tag → `--archetype AE | DS | DE | DA | BI`.
   - Country: `--country DE | AT | CH | UK | NL | IE | ...` from `Country`. DACH → photo embeds automatically.
   - **JD role title (for `--role-title` flag):** the CV tagline must LEAD with the exact job title as advertised in the JD header — NOT the archetype/family label (e.g. "BI Developer", "Data Analytics Engineer", "Machine Learning Engineer"; strip "Senior/Lead" since we target mid-level). `--role-title` overrides the tagline's lead token so the headline mirrors the JD's own language. Store as `jd_role_title`.
     - **The deterministic driver derives this automatically.** `batch/_autodraft_cv_run.mjs` now calls `extractJdRoleTitleVerbose(row)` from [`cv/jd-role-title.mjs`](../cv/jd-role-title.mjs), which recovers the verbatim title from the `job_url` slug (LinkedIn / eFinancialCareers / Xing) or `fit_notes`, cleaning geo / gender / work-mode noise and falling back to the clean role family only when it can't confidently parse one. Do NOT pass `row.position[0]` — that collapses the override to a no-op and every CV reverts to the generic variant subhead (the regression fixed 2026-07-06).
     - **Bulk regeneration must re-derive it too.** Any script that re-renders existing CVs after a content fix (`scripts/cv/generate-pdf-tailored.mjs` without `--role-title` resets the header to the variant default). Use [`cv/backfill-role-title-headers.mjs`](../cv/backfill-role-title-headers.mjs) (upgrade-only, local, safe) to remediate the Stage-3 send-ready backlog without regressing already-specific headers.

   **2b. Pre-flight: read `modes/cv-quality-rules.md` ONCE.** This file replaces the IDE-only `resume-writer` / `tech-cv-review` / `humanizer` / `recruiter-sim` skills under headless `claude -p`. Apply every rule from Sections 1–7 of that file to the draft. Variant + lang selection rules are in Section 1.

   **2c. Pick variant + lang per `cv-quality-rules.md` Section 1:**
   - `--variant de` for **Data Engineer** / Platform-data / Backend-data / DataOps titles (lead foregrounds ingestion, CDC, warehouse, dbt-under-CI, Dagster)
   - `--variant ae` for **Analytics Engineer** titles specifically (lead foregrounds dimensional models, dbt transformations, BI delivery)
   - `--variant da` for **Data Analyst / BI Analyst / Reporting Analyst / Analytics Consultant** titles (lead foregrounds SQL + Power BI / Tableau dashboards + decisions-from-data; ML demoted in skills order)
   - `--variant ds` for **Data Scientist / Research / Quant** titles (lead foregrounds applied ML — survival, causal, SHAP)
   - `--variant me` for **Machine Learning Engineer / MLOps / AI Engineer (serving)** titles (lead foregrounds model serving + explainability via FastAPI/MCP — scoped to the serving-and-explainability subset, NOT full-platform MLOps like Kubeflow/SageMaker/Vertex)
   - `--variant master` for role-neutral / unclear
   - **Disambiguation when the title is ambiguous** ("Data Engineer (Analytics)", "Data Specialist", etc.): pick by JD weight. Pipelines / ingestion / CDC / Airflow / Kafka / Spark / DataOps → `de`. dbt / dimensional modelling / metrics / data marts → `ae`. SQL + dashboards + reporting + stakeholder enablement → `da`. ML / experimentation / inference → `ds`. Model serving / MCP / FastAPI / SHAP / production ML → `me`.
   - `--lang de` for DACH country + German-majority JD
   - `--lang en` otherwise

   **2d. Extract 6–12 JD-specific competency keywords** from the JD (tools, languages, frameworks named explicitly):
   - DE: `Airflow, Kafka, Spark, Dagster, dbt, Snowflake, BigQuery, Python, SQL, CDC, Terraform`
   - AE: `dbt, Kimball, Snowflake, Databricks, BigQuery, ELT, Python, SQL`
   - DA: `SQL, Power BI, Tableau, Looker, Excel, DAX, Python, dashboards, stakeholder reporting`
   - DS: `Python, scikit-learn, XGBoost, SHAP, MLflow, Airflow, AWS Sagemaker`
   - ME: `Python, scikit-learn, XGBoost, SHAP, MLflow, FastAPI, Docker, model serving, MCP, PostgresML`
   - DE: `Snowflake, Airflow, Spark, Kafka, AWS, dbt, Python, SQL`

   These get embedded as a `<!-- tailor-keywords: ... -->` banner in the generated HTML so the PDF generator can pick them up.

   **The keywords also drive PROJECT SELECTION (added 2026-07-03):** `generate-pdf-tailored.mjs` scores every project in `cv/project-pool.json` (the 4 CV-core projects plus the portfolio-only inventory — SQL Server schema design, R regression, clinical trial stats, RoBERTa NLP study, Power BI dashboard, MCP server) against the keywords and archetype, pins the dissertation first, and renders the top 4. So extract keywords from what the JD actually emphasises, not just the stack line — a Power-BI-heavy JD should carry `Power BI, DAX, dashboards` so the Economic Resilience project surfaces; an NLP JD should carry `NLP, transformer, sentiment` so the Conflict Sentiment study surfaces. When the candidate publishes a new GitHub project, it enters rotation via a `cv/project-pool.json` entry (grounded in `article-digest.md` first — never invent metrics).

   **2e. Generate the tailored CV HTML via the canonical generator:**
   ```
   mkdir -p output/cv-drafts/{NUM}-{slug}/
   node scripts/cv/generate-pdf-tailored.mjs \
     --variant {de|ae|da|ds|me|master} \
     --lang {en|de} \
     --out output/cv-drafts/{NUM}-{slug}/ \
     --tailor-keywords "{kw1,kw2,kw3,...}" \
     --role-title "{jd_role_title}"
   ```
   The `--role-title` flag sets the CV tagline's first token to the verbatim JD title (e.g. "BI Developer" instead of the variant default "Data Analyst"). The secondary anchor (e.g. "· Analytics Engineer") is preserved from the variant. If the JD title exactly matches the variant default (e.g. JD says "Analytics Engineer" and variant is `ae`), the flag is still passed — it is idempotent.

   Output: `output/cv-drafts/{NUM}-{slug}/cv_{variant}_{lang}.html`.

   **2f-qa. Run the LLM QA agent on HTML + cover letter (BEFORE PDF render).**

   The QA agent reads the CV HTML and cover letter markdown directly — no PDF needed. This
   minimises token cost and allows patches to be applied to the source files before the
   final render. Requires `ANTHROPIC_API_KEY` in environment.

   The agent runs a **self-contained regeneration loop** for cover letter failures: if the
   CL scores WEAK or CRITICAL_FAIL and the failure is not an NDA issue or framing mismatch,
   the agent automatically writes a new CL using the critique as context, then re-evaluates.
   Up to 2 attempts (configurable via `--max-regen`). The pipeline sees only the final
   exit code — regen is internal to the script.

   ```
   node scripts/cv/cv-qa.mjs \
     --cv  "output/cv-drafts/{NUM}-{slug}/cv_{variant}_{lang}.html" \
     --cl  "output/cover-letters/{NUM}-{company-slug}-{YYYY-MM-DD}.md" \
     --jd  "{full JD text, escaped}" \
     --company "{Company}" \
     --role-title "{jd_role_title}" \
     --max-regen 2 \
     --json > data/.routine-tmp/qa-{NUM}.json
   ```

   Interpret the exit code:
   - `0` (PASS) → clean pass (or regen succeeded and all remaining issues auto-patched);
     proceed to PDF render.
   - `2` (PATCH_AND_PASS) → auto-patches applied (and/or regen improved CL); proceed to
     PDF render. Log: `[cv-qa] auto-patched {n} issues`.
   - `3` (REGENERATE) → critical issues remain after all regen attempts. This means either:
     (a) NDA violation requiring human review, (b) CV framing mismatch requiring a different
     CV variant, or (c) CL structural issues that could not be resolved in 2 attempts.
     Write the QA JSON to `data/.routine-tmp/qa-{NUM}.json`. Prepend to Fit notes:
     `[cv-qa {YYYY-MM-DD}] REGENERATE_NEEDED: {summary of flags}`. Still proceed to PDF
     render using the partially-patched files — a flagged CV is better than blocking the row.
   - Any other exit → log as QA_ERROR in ERROR_DETAILS; do NOT block PDF render.

   The QA agent checks:
   1. Role classification (classifies the role from JD content, not just title)
   2. Role-title alignment (tagline vs JD title)
   3. NDA compliance (using candidate-profile.md Section 5, if applicable)
   4. Cover letter quality (company-specific recruiter persona + brutal CL rubric)
   5. Above-the-fold signal strength vs JD priorities

   **2f. Render to PDF via the HTML-aware renderer (runs AFTER 2f-qa patches):**
   ```
   node scripts/cv/html-to-pdf.mjs \
     --in  output/cv-drafts/{NUM}-{slug}/cv_{variant}_{lang}.html \
     --out output/cv-drafts/{NUM}-{slug}/<Name>-CV-{Company}.pdf
   ```
   Confirm `status: ok`, `page_count <= 2`. Capture `pdf_path`. (The HTML's `@page A4 / margin 0.75cm 1.0cm` already encodes the print geometry — no extra flags needed. Playwright resolves `<photo-from-profile>` (the candidate's headshot) from the HTML's directory; ensure `cv/<photo-from-profile>` is symlinked or copied into the per-application dir before render — see step 2e-bis.)

   **2f-pagination-check. Verify section-heading orphan rule.** The CV template has the orphan-prevention CSS baked in (`h2 { break-after: avoid; page-break-after: avoid; break-inside: avoid; page-break-inside: avoid; }`) so a section heading like EDUCATION never sits alone at the bottom of a page. Confirm BOTH conditions before proceeding:
   1. The rendered HTML contains the sentinel comment `Never let a section heading orphan` inside the h2 CSS block. If absent, the template was tampered with and the CV will paginate badly. Halt and surface a clear error to the run log.
   2. Open the resulting PDF (`status` + `page_count` from the renderer). If `page_count > 2` AND `page_count <= 1` is structurally impossible for the CV content size, accept; otherwise visually-inspect by reading page 1 via the Read tool's `pages: "1"` PDF mode. The last visible element on any page that is NOT the final page must NOT be a section heading. If a heading orphan slipped through, the bullet density in that section is wrong for the page break, NOT the template — adjust bullet lengths and re-render rather than disabling the rule.

   **2e-bis. Stage the photo asset:**
   ```
   cp cv/<photo-from-profile> output/cv-drafts/{NUM}-{slug}/<photo-from-profile>
   ```
   (No-op for `--lang en` since the EN templates don't render the photo. Safe to always copy.)

   **2g. Self-audit against `cv-quality-rules.md` Sections 2–5** before accepting:
   - Every Experience bullet XYZ-compliant (Section 2).
   - No banned vocabulary from Section 4 (`leverage` as verb, `crucial`, `delve`, `synergize`, `pivotal`, em-dashes in paste-ready text, etc.).
   - Predicted 30-second-scan verdict (Section 5): INVITE or MAYBE → proceed; REJECT → write `[auto-draft] PREDICTED_REJECT: {reason}` to Fit notes and mark Stage 4-blocked.
   - Log honest interview-conversion probability per Section 7 in Fit notes.

   **2h. Generate the cover letter / Anschreiben through the deterministic pipeline, then enrich the content. Free-form LLM drafting of the whole letter is FORBIDDEN — LLM-direct letters lose the DIN envelope, the company address, and all company-specific knowledge. The reference standard for what this step must produce: a DIN-format Anschreiben whose opener leads with a domain truth relevant to the employer's product area, snapped to named company specifics (product / system / founding date), and closes with a specific capability claim tied to the candidate's real experience.**

   **2h-1. STRUCTURE — run the pipeline first:**
   ```
   node scripts/cover-letters/generate.js --job-url "<Job URL>" --app-id <NUM> \
        --company "<Company>" --country "<Country>" --role-hint <ae|ds|de|da|me> --keep-md
   ```
   This is the only source of the letter skeleton. It researches the company via Firecrawl (now self-healing — the daemon outage that silently killed research in late June is fixed), captures the **company postal address** (JobPosting JSON-LD → Impressum regex) for the **DIN 5008 Anschrift**, and emits the top matter that is NON-NEGOTIABLE on every letter, EN and DE alike: sender block (name, city, phone, email, links), recipient block (company, z. Hd. contact or Personalabteilung/Hiring Team, street, PLZ + city, country — omit only lines the research could not source), city + date line, and a Bewerbung-als/Re: subject from the sanitised job title. It also applies the salary guard and the varied closer.
   - If the brief reports `company_address` null, do ONE targeted lookup (company Impressum / contact page via WebFetch or BD) and write the address fields into the brief JSON (`cover-letters/briefs/{NUM}-*.json`), then re-run generate.js. Only ship an address-less recipient block when both attempts fail.

   **2h-2. CONTENT — enrich ¶1 and ¶3 (the icing on the cake):**
   Read the brief JSON. If it holds fewer than 2 high-confidence company facts beyond `tech_stack`, research the company (site, blog, recent news) and add facts to the brief. Then rewrite ONLY the opener (¶1) and the company-interest paragraph (¶3) of the generated `.md` so that a recruiter can tell the candidate knows: **what the company actually does** (product, domain, named systems), **why they are plausibly hiring for this role now** (growth, new platform, data-team buildout, regulatory pressure), and where possible **a recent concrete challenge or milestone** the candidate's work addresses. The bar for the opener: a domain truth about the employer's product area, snapped to named company specifics (product / platform / founding date), snapped to a specific capability claim ("this is exactly what I build"). Facts must be verifiable and sourced from the brief — never invented. Do NOT touch the envelope, subject line, ¶4 (availability/salary), or the closer. After editing, re-render (`md-to-pdf.mjs`) and re-upload.
   - For DE JDs the body follows `cv-quality-rules.md` §9.9 (Sie-form, 250–350 words, German number formatting, 0 em/en-dashes); run the §9.10 self-check before saving.
   - For EN JDs: 180–280 words, plain paragraphs, opens with role + company name.
   - **GROUNDING RULE (HARD, added 2026-07-03 after a shipped letter claimed daily Microsoft Fabric use that the attached CV cannot support):** every first-person experience claim ("I work with X", "ich arbeite mit X", "X ist mir vertraut") MUST name only tools/methods present in `cv.md` or `article-digest.md`. JD tools OUTSIDE that evidence base get transfer framing instead — "your X setup maps onto my dbt/Kimball layered practice" — or an honest gap disclosure. A recruiter reads letter and CV side by side; one unsupported claim poisons every true one.
   - **SALARY RULE (HARD, added 2026-07-03 after a letter quoted £60–75k against a posted £33–40k band):** EN/UK letters state NO salary figure unless the posting explicitly requires one. DE Anschreiben keep the expected Gehaltsvorstellung. In all cases: if the posting names a band, the stated range must sit INSIDE it (use `detectPostedBand`/`clampToBand` from `cover-letters/lib/draft-v2.js`); if our floor exceeds the posted ceiling, omit the figure entirely. Never quote above a posted band.
   - **STRUCTURE VARIATION:** do not reuse one fixed paragraph skeleton and closing formula across letters in the same batch — recruiters at different companies compare notes less than ATS vendors do, but the QA agent should see varied openings/closings across a batch.
   - **Apply `cv-quality-rules.md` Section 4 (humanizer rules) inline** — scrub the banned vocabulary list (`leverage` as verb, `crucial`, `delve`, `synergize`, `pivotal`, `key role`, `enduring`, `garner`, `showcase`, `boasts`, etc.); avoid em/en dashes; break copula-avoidance (`serves as` → `is`); kill negative parallelisms and forced rules-of-three. Vary sentence rhythm. The recruiter in 2026 spots ChatGPT cover letters in 5 seconds — these rules are not optional.
   - **NO INSIDER ABBREVIATIONS (the candidate's standing caveat, §4):** never "JD", "CL", "ATS" in recruiter-facing text — write "the posting" / "die Ausschreibung". Enforced mechanically by `cv/writing-eval.mjs` CL_ABBREV.
   - The pipeline writes the draft to `output/cover-letters/{NUM}-{company-slug}-{YYYY-MM-DD}.{md|de.md}`; your content edits happen in that file.

   **2f-bis. Detect form-apply vs inline-apply and generate form answers if needed.**
   Read the row's `Apply URL` field (or `apply_url` from chrome-scan results). If it starts with `inline-apply:` → SKIP this step (LinkedIn-EasyApply-style; downstream apply.md drives Chrome). Otherwise treat as an EXTERNAL APPLICATION FORM and generate `output/form-answers/{NUM}-{company-slug}-{YYYY-MM-DD}.md` containing draft answers for common application-form fields:
   - **"Why this company?"** (60-90 words, JD-specific signals)
   - **"Why this role?"** (60-90 words)
   - **"Salary expectations"** (concrete range in the JD's currency; for DE roles cite Stepstone Gehaltsreport midpoint ±15%. If the posting names a band, stay INSIDE it — clamp per the SALARY RULE in 2h; if our floor exceeds the posted ceiling answer "Flexible; happy to align with your published band.")
   - **"Notice period / earliest start date"** (use `current_status.availability` from profile)
   - **"Visa / right to work"** (use `location.visa_status`)
   - **"Years of relevant experience"** (use `years_experience`)
   - **"Sponsorship needed?"** (yes/no based on `visa_status` and JD's country)
   - **"Highest education"** (from cv.md / cv-de.md Education section)
   - **"References available?"** (default: "Available on request")
   - **JD-specific screening questions** (extract from JD body; common patterns: "Years with dbt", "Cloud-platform comfort", "Languages spoken", "Open to relocation"). For each, draft a 30-60 word answer keyed to the candidate's actual experience.
   The file should be parseable: each question on its own H3 (`### Question text`) with the answer in the paragraph below. Cowork-side `modes/apply.md` reads this to paste into form fields on submit.

   **2f-bis-humanize. Apply ALL Section 4 humanizer rules to the form-answers draft.** The form-answers file is paste-ready text that goes straight into recruiter-facing application forms — the recruiter sees it before they see the CV. Treat it with the same scrutiny as the cover letter. Specifically:

   - **ZERO em dashes (`—`) and ZERO en dashes (`–`).** Rewrite every occurrence as colons, commas, periods, or parentheses. Do NOT use them for emphasis, parenthetical asides, or range separators. Use "to" for ranges ("3 to 5 years", not "3–5 years"). This is non-negotiable — the eraneos-2026-05-26 draft had 12 em dashes and triggered this hard rule.
   - **Banned vocabulary** (Section 4 list): scrub `leverage` as verb, `crucial`, `delve`, `synergize`, `pivotal`, `key role`, `enduring`, `garner`, `showcase`, `boasts`, `transformative`, `groundbreaking`, `seamless`, `robust solution`, `cutting-edge`. Replace with the direct phrasing.
   - **Copula avoidance**: `serves as` / `stands as` / `marks` / `represents` → `is` / `was`.
   - **No negative parallelism**: `not just X, but Y` → direct statement.
   - **No forced rules-of-three**: if you can honestly defend two items, write two.
   - **No "from X to Y"** unless X and Y are on a real scale.

   **Self-check before saving the file**: grep your own draft for `—` and `–` characters. If any found, rewrite that paragraph. If banned vocabulary appears, rewrite that paragraph. Only then write to disk.

   **2h-bis. MECHANICAL scrub + audit gate — ENFORCED BY CODE, not the LLM self-check above.**
   The §4 / §9 humanizer rules are not optional and are no longer left to the model's discipline (309 em dashes shipped historically because they were instruction-only). After every cover letter and form-answers file is written, ALWAYS run, in order:
   ```bash
   node scripts/metrics/caveats-scrub.mjs --root output/cover-letters     # deterministically fix em dashes, spaced en dashes (Gedankenstrich), "not just"
   node scripts/metrics/caveats-scrub.mjs --root output/form-answers
   node scripts/metrics/caveats-audit.mjs  --root output/cover-letters     # VERIFY — must report 0 em (—) and 0 spaced en ( – ) dashes + 0 banned vocab
   node scripts/metrics/caveats-audit.mjs  --root output/form-answers
   ```
   The scrub auto-fixes; the audit verifies. If `caveats-audit` still reports any em dash, spaced en dash, or banned vocabulary, the offending paragraph must be rewritten and the scrub re-run before proceeding. (Unspaced date ranges like `2018–2019` are exempt and stay.) Only render the PDF AFTER this gate passes — the renderers (`md-to-pdf.mjs`, `din-render.mjs`) also strip em/spaced-en dashes as a last-resort net, and the final `cv/writing-eval.mjs` gate fails on `CL_EM_DASH` / `CL_EN_DASH` / `CL_BANNED_VOCAB` / `DE_DU_FORM` / `DE_NUM_FORMAT`, so a dirty draft cannot reach Notion.

   **2g. Upload artifacts to Notion via REST, then update the page.**

   **HANG GUARD (HARD, added 2026-07-06 after the scheduled run hung ~2 weeks):** run every `notion-upload-file.mjs` call SYNCHRONOUSLY in the FOREGROUND — one blocking Bash call per file, waited to completion. NEVER launch the uploads through a background driver / `run_in_background` / a detached `batch/_autodraft_upload_run.mjs`-style script and then "await" it: in headless `claude -p` you cannot wait across a detached process, so the turn ends without the contract block and the wrapper fails the run with `RUNTIME_ERROR`. If there are many rows, upload them in a simple sequential loop (foreground), not in the background. The routine MUST reach step "Output contract" and print the `--- ROUTINE_CONTRACT ---` block as its final action even if some uploads failed (report the failures inside the contract).

   The MCP's `notion-update-page` can't set file-type properties; the REST API can. Use `node scripts/notion/notion-upload-file.mjs` (built 2026-05-25, verified working on Eraneos APP-44). The script does the 3-step upload + attach in one call.

   For each row:

   ```bash
   # 1. Upload the tailored CV PDF to the Resume property
   node scripts/notion/notion-upload-file.mjs \
     --file "{pdf_path}" \
     --page "{notion_page_id}" \
     --property "Resume" \
     --json

   # 2. Upload the cover letter markdown to the Cover Letter property
   node scripts/notion/notion-upload-file.mjs \
     --file "{cover_letter_path}" \
     --page "{notion_page_id}" \
     --property "Cover Letter" \
     --json

   # 3. If form-answers file was generated (step 2f-bis), upload it too.
   # The Notion DB may not have a 'Form answers' file property — if the
   # upload returns 400 'unknown property', skip silently and reference
   # the path in Fit notes instead.
   node scripts/notion/notion-upload-file.mjs \
     --file "{form_answers_path}" \
     --page "{notion_page_id}" \
     --property "Form answers" \
     --json    # OK to fail; fall back to Fit notes mention
   ```

   These uploads put the files on Notion's own S3 — clickable from the Notion UI, no file:/// mangling. Each PDF ends up at a `prod-files-secure.s3.us-west-2.amazonaws.com/...` URL inside the page property.

   Then the page-property update (via MCP `notion-update-page` is fine for non-file properties):
   - `Stage`: `3. Drafted`.
   - `CV variant`: `EN-tailored` (if `--lang en`) or `DE-tailored` (if `--lang de`).
   - `CL variant`: `EN` or `DE`.
   - `Agent run ID`: `auto-draft-{YYYY-MM-DD-HHMM}`.
   - `Fit notes` (rich_text, prepend with separator): preserve any prior auto-eval notes, then add:
     ```
     [auto-draft {YYYY-MM-DD-HHMM}]
     CV + cover letter uploaded to this row's Resume / Cover Letter file properties.
     {if form_answers_uploaded: "Form answers also attached."}
     {if inline-apply: "Inline-apply (Chrome MCP path) — see apply.md when sending."}
     ```

   **The Resume / Cover Letter / Form answers properties NOW contain real files**, not local paths. Open the Notion row to click and view them. No more file:/// mangling.

3. **Do NOT submit anything.** Stage 3 → 4 is human-triggered always.

## Output contract (write to stdout, ONE block)

```
--- ROUTINE_CONTRACT ---
ROUTINE: auto-draft
TIMESTAMP_UTC: {iso}
QUEUE_DEPTH: {n}                       # Stage-2 sentinel-missing rows before this run
DRAFTED: {n}                           # rows successfully drafted
RESUME_WRITER_INVOCATIONS: {n}         # how many tailored CV-md files written to output/cv-tailored/
PDF_GENERATED: {n}
TECH_CV_REVIEW_WARNINGS: {n}           # rows where tech-cv-review surfaced critical issues (proceed anyway)
QA_PASS: {n}                           # rows where cv-qa exit 0 (clean pass, no regen needed)
QA_AUTO_PATCHED: {n}                   # rows where cv-qa exit 2 (patched or regen-then-patched)
QA_REGENERATE_NEEDED: {n}             # rows where cv-qa exit 3 (still failing after regen attempts)
QA_CL_REGEN_ATTEMPTS: {n}             # total CL regen API calls across all rows
QA_ERRORS: {n}                         # rows where cv-qa failed to run
COVER_LETTERS_GENERATED: {n}
HUMANIZER_INVOCATIONS: {n}             # should equal COVER_LETTERS_GENERATED
SKIPPED_NO_FLOOR: {n}
SKIPPED_ALREADY_DRAFTED: {n}
PDF_FAILURES: {n}
NOTION_WRITE_FAILURES: {n}
SCORE_FLOOR_USED: {n}
TOP_DRAFT: {short}                     # e.g. "SAP-Analytics-Engineer-Berlin(91)"
AVG_KEYWORDS_PER_DRAFT: {f}            # sanity: should be 6-12
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line if any}
--- END_ROUTINE_CONTRACT ---
```

## Pre-Notion writing QA gate (run last, before reporting done)

After all rows are drafted and uploaded, run the mechanical writing eval:

```
node scripts/cv/writing-eval.mjs
```

It scans every Stage-3 row and flags the defect classes that have shipped to
Notion before: `LANG_MISMATCH` (DACH role with an English CV), `CV_MISSING`,
`CV_HALFGEN`, `CL_MISSING`, `CL_ASTERISK` (a `**` that renders literally — the
fixed renderer handles paired bold and German gender-star subjects, so only a
genuinely unpaired `**` flags), `AVAIL_STALE` (a pre-`availability_from` month
in the availability sentence). Exit 0 = clean; exit 1 = defects listed.

On a non-zero exit, fix each by class and re-run until clean — this is the
self-diagnosing loop:
- `LANG_MISMATCH` → delete the CV dir, `node cv-bulk-reupload.mjs --regenerate-missing --stage 3` (pickLang regenerates it in German).
- `AVAIL_STALE` / `CL_ASTERISK` → root causes live in `cover-letters/lib/draft-v2.js` (availability now reads `config/profile.yml`) and `cover-letters/lib/md-to-pdf.mjs` (bold regex allows inner gender-star). If a stray defect remains on an old letter, patch the `.md`, re-render via `md-to-pdf.mjs`, re-upload with `notion-upload-file.mjs --property "Cover Letter"`.
- `CV_MISSING` / `CV_HALFGEN` → `cv-bulk-reupload.mjs --regenerate-missing`.

Surface the final `defect_count` in the routine contract so the wrapper flags a
dirty batch loudly.

## Failure handling

- PDF generation fails for a row → log to ERROR_DETAILS, leave row at Stage 2 (will retry tomorrow), continue.
- Cover letter LLM fails → still attach the PDF and write `Cover letter: ROUTINE_TODO: cover letter draft failed; please draft manually`. Transition to Stage 3 anyway — a missing CL is better than blocking the row.
- Notion rate-limit → 30s wait, retry. After 3 retries, exit with already-drafted rows intact.
- `triage.max_drafts_per_run` reached → exit cleanly; remaining wait until tomorrow.
- Playwright crash → log and exit non-zero so the wrapper flags it loudly.

## What this routine does NOT do

- Does NOT submit applications.
- Does NOT modify rows at Stage 3 or beyond.
- Does NOT evaluate (that's auto-eval's job).
- Does NOT generate PDFs for `Not pursuing` rows.
- Does NOT push to git.
