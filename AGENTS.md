# applyd — AI Job Search Pipeline

> **This is the primary project contract.** It is agent-neutral and applies to any coding agent that reads `AGENTS.md` (Claude Code, Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, Aider, …). Agent-specific overlays live in sibling files: `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/applyd.mdc`, `.aider.conf.yml`. See `docs/AGENT_COMPAT.md` for the full matrix.

## Origin

applyd is a fork of [career-ops](https://github.com/santifer/career-ops), originally built and used by [santifer](https://santifer.io) for AI/automation roles. This release keeps the architecture generic so any candidate can install it under the agent of their choice and reshape it for their own market and target roles.

## What is applyd

AI-powered job search automation. End-to-end pipeline: scan job portals → evaluate offers with A–G blocks → draft tailored CV + cover letter → human approves → submit → log everything to the tracker.

The system is designed to be driven by an AI coding agent. Every "mode" under `modes/` is a plain-Markdown instruction file the agent reads and executes. Every "routine" under `routines/` is either a self-contained prompt run by a headless agent CLI or a pure Node script — see `routines/run-routine.ps1` for the multi-agent CLI dispatcher.

## Architecture: who owns what

There are two layers and a strict rule about where personal data goes.

**User Layer (personalisation — never overwritten by updates):**
- `cv.md` · `config/profile.yml` · `modes/_profile.md` · `article-digest.md` · `portals.yml`
- `writing-samples/` · `interview-prep/`
- `data/*` · `reports/*` · `output/*`

**System Layer (default rules and routing — overrideable via `_profile.md`):**
- `modes/_shared.md` · `modes/oferta.md` and all other mode files
- `AGENTS.md` · `CLAUDE.md` · `GEMINI.md` · `.cursor/rules/*` · `.aider.conf.yml`
- `*.mjs` scripts · `dashboard/*` · `templates/*` · `batch/*` · `routines/*`

**THE RULE: when changing anything candidate-specific (archetypes, narrative, negotiation scripts, proof points, location policy, comp targets, seniority band, confidentiality stance), ALWAYS write to `modes/_profile.md` or `config/profile.yml`. NEVER edit `modes/_shared.md` for personal content.** `_profile.md` reads after `_shared.md` and overrides it. This is the discipline that keeps the override architecture intact.

For the full user-vs-system file boundary, see `DATA_CONTRACT.md`.

### Main files

| File | Function |
|------|----------|
| `cv.md` | Canonical CV. Created during onboarding from the candidate's uploaded CV, LinkedIn, or typed input. |
| `article-digest.md` | Deep proof points beyond the one-page CV — full project inventory, MCP / skills / eval-spec evidence. |
| `config/profile.yml` | Identity, contact, target roles, comp, language preferences, file output conventions, reference CV variants. |
| `modes/_profile.md` | Archetypes, adaptive framing, scoring weights, seniority band, confidentiality calibration, comp scripts, location policy, writing style. **Read first by every mode.** |
| `modes/_shared.md` | System defaults — auto-updatable in upstream, overridden by `_profile.md`. |
| `portals.yml` | Portal scanner config (LinkedIn, Indeed, Greenhouse, Ashby, Lever, Workable, Welcome to the Jungle, Handshake, Reed UK) and tracked companies. |
| `writing-samples/` | `WRITING_STYLE.md` — voice rules for all candidate-facing output. |
| `interview-prep/story-bank.md` | Master STAR+R stories. Appended to by every Block F run. |
| `interview-prep/{company}-{role}.md` | Company-specific interview intel reports. |
| `data/applications.md` | Local tracker cache. Notion is system of record when wired up. |
| `data/pipeline.md` | Inbox of pending URLs to evaluate. |
| `data/scan-history.tsv` | Scanner dedup history. |
| `data/follow-ups.md` | Follow-up history tracker. |
| `reports/` | Evaluation reports (format: `{###}-{company-slug}-{YYYY-MM-DD}.md`). A–F + G (Posting Legitimacy) + Machine Summary YAML. Header includes `**Legitimacy:** {tier}`. |
| `templates/cv-template.html` | HTML template for CV rendering. Single-column, ATS-clean. |
| `templates/cv-template.tex` | LaTeX/Overleaf template (alternative). |
| `templates/states.yml` | Canonical application states. |
| `scripts/cv/generate-pdf.mjs` | Playwright HTML → PDF renderer. |
| `scripts/cv/generate-latex.mjs` | LaTeX CV validator + pdflatex compiler. |
| `scripts/cv/cv-qa.mjs` | LLM-powered post-draft QA over a generated CV (and optional cover letter) against the JD + `modes/cv-quality-rules.md`. Auto-patches verbatim fixes with a bounded cover-letter regen loop. Runs on the local agent CLI (default `claude`; overridable via env). Skips gracefully (exit 0) if no CLI is available. |
| `scripts/scan/scan.mjs` | Zero-token portal scanner — hits Greenhouse/Ashby/Lever/Workable/SmartRecruiters APIs directly. |
| `providers/smartrecruiters.mjs` | Scanner provider for SmartRecruiters-backed careers sites (public Posting API). Auto-loaded; enable per company with `provider: smartrecruiters` + `sr_company` in `portals.yml`. |
| `scripts/scan/sponsor-check.mjs` | UK licensed-sponsor lookup for candidates who need UK sponsorship (`config/profile.yml → work_eligibility.needs_uk_sponsorship`). Matches an employer against the local gov.uk register. Drives the `uk-sponsor-licensed` / `uk-sponsor-route-mismatch` / `uk-no-sponsor-licence` tags in `oferta.md` Step 6. |
| `scripts/scan/role-taxonomy.mjs` | Optional, opt-in title-filter/archetype source. Reads `config/role-taxonomy.yml` (copy from `.example.yml`); absent → scanner uses `portals.yml title_filter`. |
| `scripts/metrics/funnel-metrics.mjs` | Real outcome KPIs from the Notion Applications DB (response / screen / rejection rate by portal, country, referral, sponsorship). Needs `NOTION_TOKEN`. |
| `scripts/metrics/caveats-audit.mjs` | Zero-LLM lint over generated CVs / cover letters for `cv-quality-rules.md` violations. |
| `scripts/scan/check-liveness.mjs` · `scripts/scan/liveness-core.mjs` · `scripts/scan/liveness-browser.mjs` | Job posting liveness checks. |
| `scripts/tracker/merge-tracker.mjs` · `scripts/tracker/dedup-tracker.mjs` · `scripts/tracker/normalize-statuses.mjs` · `scripts/tracker/verify-pipeline.mjs` | Tracker maintenance scripts. |
| `scripts/metrics/analyze-patterns.mjs` | Pattern analysis on rejection / response data (JSON output). |
| `scripts/metrics/followup-cadence.mjs` | Follow-up cadence calculator (JSON output). |
| `scripts/cv/cv-sync-check.mjs` | Sanity check: `cv.md` alignment with `profile.yml`. |
| `scripts/doctor.mjs` | Repo health check. |

### Skill modes

Modes live as plain Markdown files under `modes/`. How you *invoke* one depends on your agent — see `docs/AGENT_COMPAT.md`. The routing table below is the same everywhere:

| If the user... | Mode |
|----------------|------|
| Pastes JD or URL | auto-pipeline (evaluate + report + PDF + tracker) |
| Asks to evaluate offer | `oferta` |
| Asks to compare offers | `ofertas` |
| Wants LinkedIn outreach | `contacto` |
| Asks for company research | `deep` |
| Preps for interview at specific company | `interview-prep` |
| Wants to generate CV/PDF | `pdf` |
| Wants LaTeX CV | `latex` |
| Evaluates a course/cert | `training` |
| Evaluates portfolio project | `project` |
| Asks about application status | `tracker` |
| Fills out application form | `apply` |
| Searches for new offers | `scan` |
| Processes pending URLs | `pipeline` |
| Batch processes offers | `batch` |
| Asks about rejection patterns | `patterns` |
| Asks about follow-ups | `followup` |

### CV source of truth

- `cv.md` is the canonical CV created during onboarding.
- `article-digest.md` carries detailed proof points and the additional projects not on the one-page CV.
- **NEVER hardcode metrics.** Read them from these files at evaluation time. For project metrics, `article-digest.md` takes precedence over `cv.md`.

### Language

Default modes are in `modes/` (English). To add another language, copy the English modes into `modes/<lang>/` and translate. Set `language.modes_dir: modes/<lang>` in `config/profile.yml` to switch globally.

---

## First run — onboarding

**Before doing ANYTHING else, check if the system is set up.** The agent should run these checks silently at the start of every session:

1. Does `cv.md` exist?
2. Does `config/profile.yml` exist (not just `profile.example.yml`)?
3. Does `modes/_profile.md` exist (not just `_profile.template.md`)?
4. Does `portals.yml` exist (not just `templates/portals.example.yml`)?

If `modes/_profile.md` is missing, copy from `modes/_profile.template.md` silently. This is the user's customization file — it will never be overwritten by updates.

**If ANY of these is missing, enter onboarding mode.** Do NOT proceed with evaluations, scans, or any other mode until the basics are in place.

#### Step 1: CV (required)
If `cv.md` is missing, ask:
> "I don't have your CV yet. You can either:
> 1. Paste your CV here and I'll convert it to markdown
> 2. Paste a path to your CV file (PDF / DOCX / MD) and I'll read it
> 3. Paste your LinkedIn URL and I'll extract the key info
> 4. Tell me about your experience and I'll draft a CV for you
>
> Which do you prefer?"

Create `cv.md` from whatever they provide. Make it clean markdown with standard sections (Summary, Experience, Projects, Education, Skills).

#### Step 2: Profile (required)
If `config/profile.yml` is missing, copy from `config/profile.example.yml` and then ask:
> "I need a few details to personalize the system:
> - Your full name and email
> - Your location and timezone
> - What roles are you targeting? (e.g., 'Senior Backend Engineer', 'AI Product Manager')
> - Your salary target range
>
> I'll set everything up for you."

Fill in `config/profile.yml` with their answers. For archetypes and targeting narrative, store the user-specific mapping in `modes/_profile.md` or `config/profile.yml` rather than editing `modes/_shared.md`.

#### Step 3: Portals (recommended)
If `portals.yml` is missing:
> "I'll set up the job scanner with the bundled company list. Want me to customize the search keywords for your target roles?"

Copy `templates/portals.example.yml` → `portals.yml`. If they gave target roles in Step 2, update `title_filter.positive` to match.

#### Step 4: Bright Data (optional but recommended)
If `BRIGHTDATA_API_KEY` is not set, ask:
> "I can scan portals like LinkedIn, Indeed, and Welcome to the Jungle through Bright Data. If you have a Bright Data API key, paste it now and I'll write it into your `.env`. If you'd rather skip, I'll fall back to free ATS endpoints (Greenhouse / Ashby / Lever / Workable)."

Write the key to `.env` (gitignored) — never to `config/profile.yml`.

#### Step 5: Tracker
If `data/applications.md` doesn't exist, create it:
```markdown
# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
```

#### Step 6: Get to know the user (important for quality)

After the basics are set up, proactively ask for more context. The more the system knows, the better its evaluations:

> "The basics are ready. But the system works much better when it knows you well. Can you tell me more about:
> - What makes you unique? What's your 'superpower' that other candidates don't have?
> - What kind of work excites you? What drains you?
> - Any deal-breakers? (e.g., no on-site, no startups under 20 people, no Java shops)
> - Your best professional achievement — the one you'd lead with in an interview
> - Any projects, articles, or case studies you've published?
>
> The more context you give me, the better I filter."

Store insights in `config/profile.yml` (under `narrative`), `modes/_profile.md`, or in `article-digest.md` if the user shares proof points. Do NOT put user-specific archetypes or framing into `modes/_shared.md`.

**After every evaluation, learn.** If the user says "this score is too high, I wouldn't apply here" or "you missed that I have experience in X", update your understanding in `modes/_profile.md`, `config/profile.yml`, or `article-digest.md`. The system should get smarter with every interaction without putting personalization into system-layer files.

#### Step 7: Ready
Once all files exist, confirm the user can:
- Paste a job URL to evaluate it
- Run the `scan` mode to search portals
- Ask which modes are available

Then suggest automation:
> "Want me to scan for new offers automatically? A recurring scan every few days means you don't miss anything."

If the user accepts and their agent supports scheduling (Claude Code `/loop` or `/schedule`, cron, Windows Task Scheduler), wire up a recurring `scan`. Otherwise remind them to run `scan` periodically.

### Personalization

This system is designed to be customized by the agent on the user's behalf. When the user asks to change archetypes, translate modes, adjust scoring, add companies, or modify negotiation scripts — do it directly. The agent reads the same files it uses, so it knows exactly what to edit.

**Common customisation requests:**

| The user says... | The agent edits... |
|---|---|
| "Change my target roles to Backend Engineer" | `config/profile.yml → target_roles` + `modes/_profile.md → Your Target Roles` |
| "Change my comp targets" | `config/profile.yml → compensation` + `modes/_profile.md → Your Comp Targets` |
| "Add these companies to my portals" | `portals.yml → tracked_companies` |
| "Add a new project to my proof points" | `article-digest.md` |
| "Append a new STAR story" | `interview-prep/story-bank.md` (documented format) |
| "Update my CV" | `cv.md` |
| "Change the CV template design" | `templates/cv-template.html` |
| "Adjust the scoring weights" | `modes/_profile.md → Scoring Weights`. Never edit `modes/_shared.md` for user-specific content. |
| "Tighten my seniority filter" | `modes/_profile.md → Seniority band` AND `portals.yml → title_filter.negative` AND `config/profile.yml → target_roles.archetypes[].level`. All three must stay in sync. |
| "Change the archetypes to [backend / frontend / data / devops]" | `modes/_profile.md` or `config/profile.yml` |
| "Update my profile" | `config/profile.yml` |

---

## Ethical Use — CRITICAL

**This system is designed for quality, not quantity.** The goal is to help the user find and apply to roles where there is a genuine match — not to spam companies with mass applications.

- **NEVER submit an application without the user reviewing it first.** Fill forms, draft answers, generate PDFs, prepare cover letters — but always STOP before clicking Submit / Send / Apply. The user makes the final call.
- **Honour the score floor.** Applications with Match score below `triage.score_floor` (default 70) are auto-routed to `Not pursuing`, not drafted, not surfaced for human review. Only override with a specific reason (recruiter referral, internal lead).
- **Strongly discourage low-fit applications.** If the A–G global score is below 4.0/5, explicitly recommend against applying. The user's time and the recruiter's time are both valuable.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50. Guide the user toward fewer, better applications.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

## Offer Verification — MANDATORY

**NEVER trust a plain web fetch alone to verify if an offer is still active.** Whenever running interactively, use a full browser (Playwright / your agent's browser-automation tool):

1. Navigate to the URL.
2. Snapshot the rendered page.
3. Only footer/navbar without JD content = closed. Title + description + Apply button = active.

**Exception for batch/headless workers:** A full browser is often unavailable in a headless CLI (`claude -p`, `codex exec`, `gemini -p`, …). In that case, use the agent's plain web-fetch capability as fallback and mark the report header with `**Verification:** unconfirmed (batch mode)`. The user can verify manually later.

---

## Headless / batch mode

Long-running batches and scheduled routines run via a headless agent CLI. The dispatcher is `routines/run-routine.ps1`, which reads `$env:CAREER_OPS_AGENT_CLI` (default: `claude`) and forwards to a matching adapter under `routines/adapters/`:

- `routines/adapters/claude.ps1` → `claude -p "..."`
- `routines/adapters/codex.ps1` → `codex exec "..."`
- `routines/adapters/gemini.ps1` → `gemini -p "..."` (stub)

A self-contained prompt for the batch worker is in `batch/batch-prompt.md`.

---

## Stack and Conventions

- Node.js (mjs modules), Playwright (PDF + scraping), YAML (config), HTML/CSS (template), Markdown (data).
- Scripts in `.mjs`, configuration in YAML.
- Output in `output/` (gitignored), Reports in `reports/`.
- JDs in `jds/` (referenced as `local:jds/{file}` in `pipeline.md`).
- Batch in `batch/` (gitignored except scripts and prompts).
- Report numbering: sequential 3-digit zero-padded, max existing + 1.
- **RULE: After each batch of evaluations, run `npm run merge`** (or `node scripts/tracker/merge-tracker.mjs`) to merge tracker additions and avoid duplications.
- **RULE: NEVER create new entries in `applications.md` if `company+role` already exists.** Update the existing entry.

### TSV format for tracker additions

Write one TSV file per evaluation to `batch/tracker-additions/{num}-{company-slug}.tsv`. Single line, 9 tab-separated columns:

```
{num}\t{date}\t{company}\t{role}\t{status}\t{score}/5\t{pdf_emoji}\t[{num}](reports/{num}-{slug}-{date}.md)\t{note}
```

**Column order (IMPORTANT — status BEFORE score in TSV):**
1. `num` — sequential integer
2. `date` — YYYY-MM-DD
3. `company` — short company name
4. `role` — job title
5. `status` — canonical status (e.g., `Evaluated`) — see `templates/states.yml`
6. `score` — format `X.X/5` (e.g., `4.2/5`)
7. `pdf` — `✅` or `❌`
8. `report` — markdown link `[num](reports/...)`
9. `notes` — one-line summary

**Note:** In `applications.md` the order is reversed (score BEFORE status). `scripts/tracker/merge-tracker.mjs` handles the column swap automatically.

### Pipeline integrity

1. **NEVER edit `applications.md` to ADD new entries** — write a TSV in `batch/tracker-additions/` and let `scripts/tracker/merge-tracker.mjs` handle the merge.
2. **YES you can edit `applications.md` to UPDATE status / notes of existing entries.**
3. All reports MUST include `**URL:**` in the header (between Score and PDF). Include `**Legitimacy:** {tier}` (see Block G in `modes/oferta.md`).
4. All statuses MUST be canonical (see `templates/states.yml`).
5. Health check: `npm run verify` (or `node scripts/tracker/verify-pipeline.mjs`).
6. Normalise statuses: `npm run normalize` (or `node scripts/tracker/normalize-statuses.mjs`).
7. Dedup: `npm run dedup` (or `node scripts/tracker/dedup-tracker.mjs`).

### Canonical states (`applications.md`)

**Source of truth:** `templates/states.yml`

| State | When to use |
|-------|-------------|
| `Evaluated` | Report completed, pending decision |
| `Applied` | Application sent |
| `Responded` | Company responded |
| `Interview` | In interview process |
| `Offer` | Offer received |
| `Rejected` | Rejected by company |
| `Discarded` | Discarded by candidate or offer closed |
| `SKIP` | Doesn't fit, don't apply |

**RULES:**
- No markdown bold (`**`) in status field
- No dates in status field (use the date column)
- No extra text (use the notes column)

---

## Notion integration (optional)

If the user wants Notion as system of record, the contract lives in `modes/notion-tracker.md`. The user provides:

- A Notion internal-integration token (`NOTION_TOKEN` in `.env`).
- An Applications database ID and data source ID (added to `config/profile.yml → notion.*`).

`data/applications.md` continues to work in parallel as a local cache.

Stage pipeline: `1. Discovered → 2. Triaged → 3. Drafted → 4. Applied → 5. Assessment/OA → 6. Phone screen → 7. Tech interview → 8. Onsite/Final → 9. Offer → Signed` (terminals: `Rejected`, `Withdrew`, `Not pursuing`).

Contract rules:
- Dedup on `Job URL` before insert.
- Hard score floor: Match score ≥ `triage.score_floor` (default 70) to surface for drafting. Below → Stage `Not pursuing`, no human triage.
- Priority: Match score DESC end to end.
