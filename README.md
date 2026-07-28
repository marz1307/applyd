# applyd

Job-search pipeline that lives in your terminal. It scans portals, scores postings against your CV, drafts tailored CVs and cover letters, and logs everything to a Notion tracker. It never submits — that part is on you.

Fork of Santiago Fernández de Valderrama's [career-ops](https://github.com/santifer/career-ops) (MIT), extended with multi-agent CLI dispatch, UK sponsor licensing checks, cross-portal deduplication, and a shared metrics semantic layer.

Reference implementation runs as a Claude Code plugin. The same modes and routines work under Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, and Aider via [`AGENTS.md`](AGENTS.md).

[![Made for Claude Code](https://img.shields.io/badge/Made_for-Claude_Code-000?style=flat&logo=anthropic&logoColor=white)](https://www.claude.com/product/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)](https://playwright.dev)
[![Notion](https://img.shields.io/badge/Notion-000?style=flat&logo=notion&logoColor=white)](https://notion.so)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

📖 For a step-by-step walkthrough from install to first submitted application, see [MANUAL.md](MANUAL.md).

---

## ✨ What you get

- 🔍 **Portal scanner** — LinkedIn, Indeed, Glassdoor, Welcome to the Jungle, Handshake, Reed UK, plus free ATS endpoints (Greenhouse, Ashby, Lever, Workable).
- 📊 **A–G evaluation** — every posting scored 0–100 against your CV, with the reasoning written out.
- 📝 **Tailored CVs and cover letters** — archetype-driven, ATS-clean, one page A4.
- 🗂️ **Notion tracker** — auto-created on first run with three dashboard views (pipeline kanban, by score, active interviews).
- 🎯 **Interview prep** — STAR+R stories, company intel, JD-tailored questions.
- ⏰ **Scheduled scans** — pick a time of day, it runs itself.
- 🛑 **No auto-submit** — fills forms and drafts answers, then hands the tab back to you.

---

## 🤖 Supported agents

The project contract lives in [`AGENTS.md`](AGENTS.md) and is agent-neutral. Claude Code is the reference implementation, which is what the quickstart below covers. The same modes and routines run under Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, and Aider via sibling overlay files ([`GEMINI.md`](GEMINI.md), [`.cursor/rules/applyd.mdc`](.cursor/rules/applyd.mdc), [`.aider.conf.yml`](.aider.conf.yml)). Headless scheduled routines dispatch through [`routines/run-routine.ps1`](routines/run-routine.ps1) to `routines/adapters/${CAREER_OPS_AGENT_CLI}.ps1`, defaulting to Claude.

Per-agent setup, MCP wiring, and known caveats live in [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md).

---

## 🚀 Quickstart

For the full walkthrough (every onboarding question explained, every daily-workflow mode, troubleshooting), see [MANUAL.md](MANUAL.md).

### 1. Install

```bash
# macOS / Linux
git clone https://github.com/marz1307/applyd ~/.claude/skills/applyd
cd ~/.claude/skills/applyd && npm install

# Windows (PowerShell)
git clone https://github.com/marz1307/applyd $env:USERPROFILE\.claude\skills\applyd
cd $env:USERPROFILE\.claude\skills\applyd; npm install
```

The clone is the skill bundle. Engine code, modes, templates, and node deps all live in `~/.claude/skills/applyd/`.

### 2. Run

Pick any folder as your workspace. That is where your CV, profile, applications tracker, and generated PDFs will live.

```bash
mkdir ~/applyd-workspace
cd    ~/applyd-workspace
```

Then start your agent in that folder. Claude Code is the reference path:

```bash
claude
# then in chat:
/applyd
```

Under another agent, invoke a mode file directly:

```bash
codex  exec "Read modes/auto-pipeline.md and follow it."
cursor .           # then in chat: @modes/auto-pipeline.md
gemini -p "Read modes/auto-pipeline.md and follow it."
```

Per-agent setup (MCP wiring, scheduled routines, known caveats): [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md).

### 3. Onboarding

The skill walks you through eight questions:

| # | Question | Why |
|---|---|---|
| 1 | Where's your CV? | Paste, file path, LinkedIn, or draft from scratch |
| 2 | LinkedIn URL? | Goes in your profile |
| 3 | Portfolio / GitHub? | Optional |
| 4 | Target markets? | UK, EU, US, remote — multi-select |
| 5 | Target roles? | List them, or let the skill infer from your CV |
| 6 | Bright Data API key? | Powers LinkedIn, Indeed, and Glassdoor scraping |
| 7 | Notion integration token? | Auto-creates your Applications database |
| 8 | Scheduled scan hour? | 07:00 / 12:30 / 18:00 / custom / off |

When it finishes, your workspace has `cv.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md`, `.env`, and a fresh Notion DB with three dashboard views.

---

## 🧭 How it works

```
                ┌──────────────┐
                │   /applyd    │   ← you invoke the skill
                └──────┬───────┘
                       ▼
         ┌─────────────────────────────┐
         │  scan portals               │ ← Stage 1 (Discovered)
         └─────────┬───────────────────┘
                   ▼
         ┌─────────────────────────────┐
         │  A–G evaluation             │ ← Stage 2 (Triaged)
         │  Match score 0–100          │   < score_floor → Not pursuing
         └─────────┬───────────────────┘
                   ▼
         ┌─────────────────────────────┐
         │  tailored CV + cover letter │ ← Stage 3 (Drafted)
         │  attached to Notion row     │
         └─────────┬───────────────────┘
                   ▼
              [you review]
                   ▼
         ┌─────────────────────────────┐
         │  apply (you click Submit)   │ ← Stage 4 (Applied)
         └─────────────────────────────┘
```

Everything past Stage 4 (assessment, phone screen, tech, onsite, offer) is tracked through `modes/response-tracker.md`.

---

## 📂 What's in the box

| Layer | File | Notes |
|-------|------|-------|
| Project contract | [`AGENTS.md`](AGENTS.md) | Agent-neutral source of truth: routing, ethical rules, TSV format, canonical states, mode index |
| Claude-Code overlay | [`CLAUDE.md`](CLAUDE.md), [`SKILL.md`](SKILL.md), [`.claude-plugin/`](.claude-plugin) | Claude tool bindings and plugin marketplace manifest (drives `/applyd`) |
| Other-agent overlays | [`GEMINI.md`](GEMINI.md), [`.cursor/rules/applyd.mdc`](.cursor/rules/applyd.mdc), [`.cursorrules`](.cursorrules), [`.aider.conf.yml`](.aider.conf.yml) | One-screen pointers to `AGENTS.md` for Gemini, Cursor, Aider |
| Agent-compat matrix | [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md) | What runs where: 7 agents, per-agent setup, known caveats |
| Your config | [`config/profile.example.yml`](config/profile.example.yml), [`modes/_profile.template.md`](modes/_profile.template.md) | Identity, archetypes, scoring weights, comp targets, writing style |
| Your CV | `cv.md` (created on first run) | Canonical CV in markdown |
| Proof points | `article-digest.md` (created on first run) | Projects, case studies, deeper evidence than the CV |
| Portal scanner | [`templates/portals.example.yml`](templates/portals.example.yml), [`scripts/scan/scan.mjs`](scripts/scan/scan.mjs) | LinkedIn, Indeed, Glassdoor, Greenhouse, Ashby, Lever, Workable, Welcome to the Jungle, Handshake, Reed UK |
| Per-JD evaluation | [`modes/oferta.md`](modes/oferta.md) | A–G blocks, comp research, tracker write |
| PDF generation | [`modes/pdf.md`](modes/pdf.md), [`scripts/cv/generate-pdf.mjs`](scripts/cv/generate-pdf.mjs) | A4 always, role-tailored variants |
| Metrics semantic layer | [`scripts/metrics/metrics-core.mjs`](scripts/metrics/metrics-core.mjs) | One definition of applied, responded, screened, ghosted, plus Match-score band calibration; shared by every metric consumer |
| Interview prep | `interview-prep/` (created on first run) | STAR+R stories, company intel, JD-tailored prep |
| Notion contract | [`modes/notion-tracker.md`](modes/notion-tracker.md) | DB schema, stage transitions, field map |
| Scheduled routines | [`routines/run-routine.ps1`](routines/run-routine.ps1), [`routines/adapters/`](routines/adapters) | Multi-CLI dispatch: `$env:CAREER_OPS_AGENT_CLI` selects `claude`, `codex`, or `gemini` adapter |
| Batch worker | [`batch/batch-prompt.md`](batch/batch-prompt.md) | Self-contained prompt for headless agent-CLI parallel evaluations |

---

## 🛠️ Requirements

- A supported AI coding agent: [Claude Code](https://www.claude.com/product/claude-code) (reference implementation, one-click plugin install), or Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, Aider (via [`AGENTS.md`](AGENTS.md); see [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md)).
- Node.js 18 or later.
- Git.
- A Notion account with an [internal integration token](https://www.notion.com/profile/integrations). The onboarding flow walks you through it.
- A Bright Data account (optional) for LinkedIn, Indeed, and Glassdoor scraping. Without it, the scanner uses free ATS endpoints only.

---

## ⚙️ Commands

In a Claude Code session (after onboarding), invoke via slash command:

| Command | What it does |
|---|---|
| `/applyd` | Help menu, or re-run onboarding |
| `/applyd scan` | Scan portals for new postings |
| `/applyd pipeline` | Process pending URLs from inbox |
| paste a JD URL | Auto-pipeline: evaluate, draft, log |
| `/applyd pdf` | Generate a tailored CV PDF |
| `/applyd apply` | Interactive form-fill assistant |
| `/applyd interview-prep <company>` | Build a tailored prep doc |
| `/applyd contacto` | LinkedIn outreach drafts |
| `/applyd deep <company>` | Company research brief |
| `/applyd tracker` | Status snapshot of your pipeline |
| `/applyd patterns` | Rejection-pattern analysis |
| `/applyd followup` | Follow-up cadence calculator |

Under other agents, invoke the corresponding mode file directly: `codex exec "Read modes/scan.md and follow it."`, `@modes/scan.md` in Cursor, `gemini -p "Read modes/apply.md and follow it."`, and so on. See [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md).

### npm scripts (for direct CLI use)

Scanning and tracker hygiene:
```
npm run scan               # zero-token portal scanner (Greenhouse / Ashby / Lever / Workable APIs)
npm run bd:scan            # Bright Data bulk scanner (Xing, eFC, LinkedIn, Indeed, WTTJ, ...)
npm run bd:referral        # Bright Data cold public-profile discovery for referral leads
npm run merge              # merge batch tracker TSVs into applications.md
npm run verify             # data-integrity check on the tracker
npm run dedup              # remove duplicate tracker rows
npm run dedup:cross-portal # collapse same-posting cross-portal duplicates
npm run normalize          # normalise status values
npm run liveness           # check if a job URL is still active
npm run sponsor            # UK licensed-sponsor lookup
```

Metrics and observability:
```
npm run funnel             # applied to responded to screened funnel, plus Match-score calibration
npm run pace               # apply-pace against target
npm run window             # is it inside the tue–thu apply window?
npm run patterns           # rejection-pattern analysis
npm run caveats            # CV / cover-letter caveat lint
npm run system-eval        # scheduled-routines health report
```

CV, tests, Notion:
```
npm run pdf                # HTML to ATS-optimised PDF
npm run pdf:tailored       # JD-driven tailored PDF
npm run sync-check         # validate CV / profile alignment
npm run cv:qa              # CV writing-quality gate
npm run notion:setup       # first-time Notion DB scaffold
npm run notion:check       # verify Notion schema
npm run test               # full test suite
npm run doctor             # repo health check
```

Full reference: [`docs/SCRIPTS.md`](docs/SCRIPTS.md). Run `npm run` for the complete list.

---

## 🎛️ Customisation

Everything about you lives in user-layer files that updates will not overwrite. Ask the agent in-session to change anything:

| You say | The skill edits |
|---|---|
| "Change my target roles to Backend Engineer" | `config/profile.yml`, `modes/_profile.md` |
| "Add these companies to my portals" | `portals.yml` |
| "Adjust the scoring weights to prioritise remote" | `modes/_profile.md` |
| "Update my CV, I just shipped a new project" | `cv.md`, `article-digest.md` |
| "Tighten my seniority filter to mid-level only" | `modes/_profile.md`, `portals.yml`, `config/profile.yml` |

See [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md) and [`DATA_CONTRACT.md`](DATA_CONTRACT.md) for the user-vs-system file boundary.

---

## 🤝 Ethical use

- The agent never submits applications. It fills forms, drafts answers, generates PDFs, then stops before Submit / Send / Apply. You make the final call.
- Hard score floor (default 70 / 100) sends low-fit rows to `Not pursuing` rather than drafting them. Override only with a specific reason.
- Quality over speed. A well-targeted application to five companies beats a generic blast to fifty.
- No impersonation. The skill will not pretend to be you in live recruiter conversations.

---

## ❓ FAQ

**Do I need a Bright Data account?**
No. Without one, the scanner only hits free ATS endpoints (Greenhouse, Ashby, Lever, Workable). LinkedIn, Indeed, and Glassdoor coverage drops.

**Do I need a Notion account?**
Recommended. The skill auto-creates an Applications database with three dashboard views. Without Notion, the tracker falls back to `data/applications.md` (local-only).

**Can I run this without Claude Code?**
Yes. v2.3.0 made the project agent-neutral. Claude Code is the reference implementation (that is where the `/applyd` slash command and one-click plugin install live), and the same modes and routines run under Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, and Aider via [`AGENTS.md`](AGENTS.md) and the sibling overlay files. Scheduled routines dispatch through [`routines/adapters/`](routines/adapters); set `CAREER_OPS_AGENT_CLI=codex` (or `gemini`) to swap. Full compatibility matrix and per-agent setup: [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md).

**Will updates overwrite my CV or profile?**
No. `DATA_CONTRACT.md` enforces a hard split: engine files in `~/.claude/skills/applyd/`, your personal files in your workspace. Updates only touch the engine.

**Can I use this for non-tech roles?**
Yes. The archetypes in `modes/_profile.md` are user-editable. Tell the skill "change my archetypes to product management" and it rewrites the scoring weights, framing, and CV templates to match.

**Can I fork this for my own market or language?**
Yes. Default portals cover the UK and EU broadly. Edit `portals.yml` for your market, and translate `modes/` if you want a non-English flow.

---

## 🧩 Contributing

PRs welcome, especially for:

- Additional portal scanners (per-country job boards)
- ATS-specific form-fillers
- New archetypes or industry verticals
- Better interview-prep heuristics

Open an issue first if you are planning a structural change.

---

## 📜 Credit

Built on Santiago Fernández de Valderrama's original [career-ops](https://github.com/santifer/career-ops) (MIT). The mode-routing system, the Playwright PDF pipeline, the TSV tracker discipline, and the ethical-use rules are his.

This build adds the Claude Code skill wrapper, Notion auto-creation, Glassdoor support, scheduled scans, the onboarding flow, and the engine-vs-workspace separation.

## 📄 Licence

MIT. See [LICENSE](LICENSE).

---

<sub>If this helps you land a role, star ⭐ the repo and tell me about it. Good hunting.</sub>
