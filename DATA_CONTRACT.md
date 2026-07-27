# Data Contract

This document defines which files belong to the **system** (auto-updatable) and which belong to the **user** (never touched by updates).

## User Layer (NEVER auto-updated)

These files contain your personal data, customizations, and work product. Updates will NEVER modify them.

| File | Purpose |
|------|---------|
| `cv.md` | Your CV in markdown |
| `config/profile.yml` | Your identity, targets, comp range |
| `modes/_profile.md` | Your archetypes, narrative, negotiation scripts |
| `article-digest.md` | Your proof points from portfolio |
| `interview-prep/story-bank.md` | Your accumulated STAR+R stories |
| `portals.yml` | Your customized company list |
| `data/applications.md` | Your application tracker |
| `data/pipeline.md` | Your URL inbox |
| `data/scan-history.tsv` | Your scan history |
| `data/follow-ups.md` | Your follow-up history |
| `data/uk-sponsor-register/*` | Your downloaded gov.uk Register of licensed sponsors (CSV) + the generated `index.json`. Point-in-time snapshot you re-download periodically; refresh with `node sponsor-check.mjs --rebuild`. |
| `writing-samples/*` | Your personal writing samples for style calibration (except `writing-samples/README.md`, which is system-owned documentation delivered by updates) |
| `reports/*` | Your evaluation reports |
| `output/*` | Your generated PDFs |
| `jds/*` | Your saved job descriptions |
| `assets/candidate-photo.jpg` | Personal photo embedded in DE Lebenslauf PDFs |
| `data/routine-logs/*` | Headless `claude -p` routine logs (gitignored, machine-generated) |
| `data/wrapper-trace.log` | One-line-per-invocation trace from `routines/run-routine.ps1` (gitignored) |
| `data/scan-failures.json` | Per-company consecutive-failure ledger for scan.mjs stale-portal detection (gitignored) |

## System Layer (safe to auto-update)

These files contain system logic, scripts, templates, and instructions that improve with each release.

| File | Purpose |
|------|---------|
| `modes/_shared.md` | Scoring system, global rules, tools |
| `modes/oferta.md` | Evaluation mode instructions |
| `modes/pdf.md` | PDF generation instructions |
| `modes/scan.md` | Portal scanner instructions |
| `modes/batch.md` | Batch processing instructions |
| `modes/apply.md` | Application assistant instructions |
| `modes/auto-pipeline.md` | Auto-pipeline instructions |
| `modes/contacto.md` | LinkedIn outreach instructions |
| `modes/deep.md` | Research prompt instructions |
| `modes/ofertas.md` | Comparison instructions |
| `modes/pipeline.md` | Pipeline processing instructions |
| `modes/project.md` | Project evaluation instructions |
| `modes/tracker.md` | Tracker instructions |
| `modes/training.md` | Training evaluation instructions |
| `modes/patterns.md` | Pattern analysis instructions |
| `modes/followup.md` | Follow-up cadence instructions |
| `modes/<lang>/*` | Translated modes (user-created, e.g. `modes/de/` for DACH) |
| `modes/notion-tracker.md` | Notion tracker contract spec |
| `CLAUDE.md` | Agent instructions |
| `AGENTS.md` | Shared agent instructions (included by CLAUDE.md) |
| `*.mjs` | Utility scripts |
| `batch/batch-prompt.md` | Batch worker prompt |
| `batch/batch-runner.sh` | Batch orchestrator |
| `dashboard/*` | Go TUI dashboard |
| `templates/*` | Base templates |
| `templates/states.yml` | Canonical application states |
| `fonts/*` | Self-hosted fonts |
| `.mcp.json` | Project-level MCP server registration (Bright Data via `BRIGHTDATA_API_KEY`) |
| `routines/*.md` | Self-completing prompts for headless `claude -p` (morning/lunchtime scan, pace check) |
| `routines/run-routine.ps1` | Windows Task Scheduler wrapper — validates output contract, enforces timeouts, per-routine MCP allowlists |
| `test-pdf-smoke.mjs` | Regression smoke test for `generate-pdf-tailored.mjs` (EN + DE happy path) |
| `.claude/skills/*` | Skill definitions (symlink → .agents/skills/) |
| `.agents/skills/*` | Authoritative skill manifest |
| `docs/*` | Documentation |
| `DATA_CONTRACT.md` | This file |
| `writing-samples/README.md` | System-owned onboarding documentation for the writing-samples directory |

## The Rule

**If a file is in the User Layer, no update process may read, modify, or delete it.**

**If a file is in the System Layer, it can be safely replaced with the latest version from the upstream repo.**
