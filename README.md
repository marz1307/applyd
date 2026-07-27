# career-ops

> **Your AI job-search co-pilot.**
> Scans portals, scores every posting against your profile, drafts tailored CVs and cover letters, logs everything to a Notion tracker — and stops before clicking Submit so you stay in control.
> Runs natively as a Claude Code plugin and works out of the box under Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, and Aider via the shared [`AGENTS.md`](AGENTS.md) contract.

[![Made for Claude Code](https://img.shields.io/badge/Made_for-Claude_Code-000?style=flat&logo=anthropic&logoColor=white)](https://www.claude.com/product/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)](https://playwright.dev)
[![Notion](https://img.shields.io/badge/Notion-000?style=flat&logo=notion&logoColor=white)](https://notion.so)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> 📖 **Full step-by-step walkthrough from install to your first submitted application: [MANUAL.md](MANUAL.md)**

---

## ✨ What you get

- 🔍 **Portal scanner** — LinkedIn, Indeed, Glassdoor, Welcome to the Jungle, Handshake, Reed UK, plus zero-cost ATS APIs (Greenhouse, Ashby, Lever, Workable)
- 📊 **A–G evaluation blocks** — every posting scored 0–100 against your CV, with reasoning
- 📝 **Tailored CVs + cover letters** — archetype-driven, ATS-clean, one-page A4
- 🗂️ **Notion tracker auto-created** — full schema, three dashboard views (Pipeline kanban, By score, Active interviews)
- 🎯 **Interview prep** — STAR+R stories, company intel, JD-tailored question bank
- ⏰ **Scheduled scans** — pick a time of day, it runs itself
- 🛑 **Never auto-submits** — fills forms, drafts answers, stops at Submit

---

## 🤖 Supported agents

The project contract lives in [`AGENTS.md`](AGENTS.md) and is agent-neutral. Claude Code is the reference implementation (that's what the quickstart below covers), and the same modes and routines run under **Codex CLI, Cursor, Zed, OpenCode, Gemini CLI, and Aider** via sibling overlay files ([`GEMINI.md`](GEMINI.md), [`.cursor/rules/career-ops.mdc`](.cursor/rules/career-ops.mdc), [`.aider.conf.yml`](.aider.conf.yml)). Headless scheduled routines dispatch through [`routines/run-routine.ps1`](routines/run-routine.ps1) → `routines/adapters/${CAREER_OPS_AGENT_CLI}.ps1`, defaulting to Claude.

Full setup notes per agent, MCP wiring, and known caveats live in [`docs/AGENT_COMPAT.md`](docs/AGENT_COMPAT.md).

---

## 🚀 Quickstart

*For the full step-by-step walkthrough with every onboarding question explained, every daily-workflow mode, and a troubleshooting section, see **[MANUAL.md](MANUAL.md)**.*

### 1. Install

```bash
# macOS / Linux
git clone https://github.com/marz1307/career-ops ~/.claude/skills/career-ops
cd ~/.claude/skills/career-ops && npm install

# Windows (PowerShell)
git clone https://github.com/marz1307/career-ops $env:USERPROFILE\.claude\skills\career-ops
cd $env:USERPROFILE\.claude\skills\career-ops; npm install
```

That's it. The clone *is* the skill bundle — engine code, modes, templates, and node deps all live in `~/.claude/skills/career-ops/`.

### 2. Run

Pick any folder to be your **workspace** (where your CV, profile, applications tracker, and generated PDFs will live):

```bash
mkdir ~/career-ops-workspace
cd    ~/career-ops-workspace
claude
```

Then in the Claude Code chat:

```
/career-ops
```

### 3. Onboarding

The skill walks you through eight questions:

| # | Question | Why |
|---|---|---|
| 1 | Where's your CV? | Paste / file path / LinkedIn / draft from scratch |
| 2 | LinkedIn URL? | Goes in your profile |
| 3 | Portfolio / GitHub? | Optional |
| 4 | Target markets? | UK / EU / US / Remote (multi-select) |
| 5 | Target roles? | List them, or have the skill infer from your CV |
| 6 | Bright Data API key? | Powers LinkedIn / Indeed / Glassdoor scraping |
| 7 | Notion integration token? | Auto-creates your Applications database |
| 8 | Scheduled scan hour? | 07:00 / 12:30 / 18:00 / custom / off |

When you're done, your workspace contains `cv.md`, `config/profile.yml`, `portals.yml`, `modes/_profile.md`, `.env`, plus a fresh Notion DB with three dashboard views.

---

## 🧭 How it works

```
                ┌──────────────┐
                │  /career-ops │   ← you invoke the skill
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

Beyond Stage 4 (assessment, phone screen, tech, onsite, offer) is tracked through `modes/response-tracker.md`.

---

## 📂 What's in the box

| Layer | File | Notes |
|-------|------|-------|
| Slash-command entry | [`SKILL.md`](SKILL.md) | Marketplace skill manifest — drives `/career-ops` and onboarding |
| Agent brain | [`CLAUDE.md`](CLAUDE.md) + [`AGENTS.md`](AGENTS.md) | Routing, ethical rules, mode index (developer reference) |
| Your config | [`config/profile.example.yml`](config/profile.example.yml) + [`modes/_profile.template.md`](modes/_profile.template.md) | Identity, archetypes, scoring weights, comp targets, writing style |
| Your CV | `cv.md` (created on first run) | Canonical CV in markdown |
| Proof points | `article-digest.md` (created on first run) | Projects, case studies, deeper evidence than the CV |
| Portal scanner | [`templates/portals.example.yml`](templates/portals.example.yml) + [`scripts/scan/scan.mjs`](scripts/scan/scan.mjs) | LinkedIn, Indeed, Glassdoor, Greenhouse, Ashby, Lever, Workable, Welcome to the Jungle, Handshake, Reed UK |
| Per-JD evaluation | [`modes/oferta.md`](modes/oferta.md) | A–G blocks, comp research, tracker write |
| PDF generation | [`modes/pdf.md`](modes/pdf.md) + [`scripts/cv/generate-pdf.mjs`](scripts/cv/generate-pdf.mjs) | A4 always, role-tailored variants |
| Interview prep | `interview-prep/` (created on first run) | STAR+R stories, company intel, JD-tailored prep |
| Notion contract | [`modes/notion-tracker.md`](modes/notion-tracker.md) | DB schema, stage transitions, field map |
| Batch worker | [`batch/batch-prompt.md`](batch/batch-prompt.md) | Self-contained prompt for `claude -p` parallel evaluations |

---

## 🛠️ Requirements

- **Claude Code** — [claude.com/product/claude-code](https://www.claude.com/product/claude-code)
- **Node.js 18+**
- **Git**
- **Notion account** with an [internal integration token](https://www.notion.com/profile/integrations) (the skill walks you through it)
- **Bright Data account** *(optional)* — for LinkedIn / Indeed / Glassdoor scraping. Without it, the scanner falls back to free ATS endpoints.

---

## ⚙️ Commands

In any Claude Code session, after onboarding:

| Command | What it does |
|---|---|
| `/career-ops` | Help menu / re-run onboarding |
| `/career-ops scan` | Scan portals for new postings |
| `/career-ops pipeline` | Process pending URLs from inbox |
| paste a JD URL | Auto-pipeline: evaluate + draft + log |
| `/career-ops pdf` | Generate a tailored CV PDF |
| `/career-ops apply` | Interactive form-fill assistant |
| `/career-ops interview-prep <company>` | Build a tailored prep doc |
| `/career-ops contacto` | LinkedIn outreach drafts |
| `/career-ops deep <company>` | Company research brief |
| `/career-ops tracker` | Status snapshot of your pipeline |
| `/career-ops patterns` | Rejection-pattern analysis |
| `/career-ops followup` | Follow-up cadence calculator |

### npm scripts (for direct CLI use)

```
npm run scan          # zero-token portal scanner (Greenhouse / Ashby / Lever / Workable APIs)
npm run merge         # merge batch tracker TSVs into applications.md
npm run verify        # data-integrity check on the tracker
npm run dedup         # remove duplicate tracker rows
npm run normalize     # normalise status values
npm run sync-check    # validate CV / profile alignment
npm run pdf           # HTML to ATS-optimised PDF
npm run liveness      # check if a job URL is still active
npm run patterns      # analyse outcomes and report patterns
npm run doctor        # repo health check
```

Full reference: [`docs/SCRIPTS.md`](docs/SCRIPTS.md).

---

## 🎛️ Customisation

Everything about you lives in user-layer files that **updates will never overwrite**. Ask Claude in-session to change anything:

| You say… | The skill edits… |
|---|---|
| "Change my target roles to Backend Engineer" | `config/profile.yml` + `modes/_profile.md` |
| "Add these companies to my portals" | `portals.yml` |
| "Adjust the scoring weights to prioritise remote" | `modes/_profile.md` |
| "Update my CV — I just shipped a new project" | `cv.md` + `article-digest.md` |
| "Tighten my seniority filter to mid-level only" | `modes/_profile.md` + `portals.yml` + `config/profile.yml` |

See [`docs/CUSTOMIZATION.md`](docs/CUSTOMIZATION.md) and [`DATA_CONTRACT.md`](DATA_CONTRACT.md) for the user-vs-system file boundary.

---

## 🤝 Ethical use

- **The agent never submits applications.** It fills forms, drafts answers, generates PDFs — but stops before Submit / Send / Apply. You make the final call.
- **Hard score floor** (default 70 / 100) sends low-fit rows to `Not pursuing` rather than drafting them. Override only with a specific reason.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **No impersonation.** The skill won't pretend to be you in live recruiter conversations.

---

## ❓ FAQ

**Do I need a Bright Data account?**
No — but without one, the scanner only hits free ATS endpoints (Greenhouse, Ashby, Lever, Workable). LinkedIn, Indeed, and Glassdoor coverage drops.

**Do I need a Notion account?**
Strongly recommended. The skill auto-creates an Applications database with three dashboard views. If you skip Notion, the tracker falls back to `data/applications.md` (local-only).

**Can I run this without Claude Code?**
The skill is built for Claude Code. Most `.mjs` scripts work standalone (`npm run scan`, `npm run pdf`), but the slash-command flow, mode routing, and onboarding require Claude Code.

**Will updates overwrite my CV / profile?**
No. The `DATA_CONTRACT.md` enforces a hard split — engine files in `~/.claude/skills/career-ops/`, your personal files in your workspace. Updates only touch the engine.

**Can I use this for non-tech roles?**
Yes. The archetypes in `modes/_profile.md` are user-editable. Tell the skill "change my archetypes to product management" and it rewrites the scoring weights, framing, and CV templates to match.

**Can I fork this for my own market / language?**
Absolutely. The default portals are UK + EU broad. Edit `portals.yml` for your market, and translate `modes/` if you want a non-English flow.

---

## 🧩 Contributing

PRs welcome — especially for:

- Additional portal scanners (per-country job boards)
- ATS-specific form-fillers
- New archetypes / industry verticals
- Better interview-prep heuristics

Open an issue first if you're planning a structural change.

---

## 📜 Credit

Built on Santiago Fernández de Valderrama's original [career-ops](https://github.com/santifer/career-ops) (MIT). The mode-routing system, the Playwright PDF pipeline, the TSV tracker discipline, and the ethical-use rules are his.

This marketplace build adds the Claude Code skill wrapper, Notion auto-creation, Glassdoor support, scheduled scans, the onboarding flow, and the engine-vs-workspace separation.

## 📄 Licence

MIT. See [LICENSE](LICENSE).

---

<sub>Star ⭐ the repo if it helps you land a role — and tell me about it. Good hunting.</sub>
