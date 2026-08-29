# applyd — User Manual

A step-by-step walkthrough from "I have nothing installed" to "I just clicked Submit on a tailored application." If you're skimming, the [README](README.md) gives the 90-second pitch. This file is the full operating manual.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [First-run onboarding (the ten questions)](#3-first-run-onboarding)
4. [Daily workflow](#4-daily-workflow)
   - [Morning: review the scheduled scan](#41-morning-review-the-scheduled-scan)
   - [Evaluate a specific posting](#42-evaluate-a-specific-posting)
   - [Generate the tailored CV and cover letter](#43-generate-the-tailored-cv-and-cover-letter)
   - [Submit the application](#44-submit-the-application)
5. [Interview prep cycle](#5-interview-prep-cycle)
6. [Tracker hygiene and patterns](#6-tracker-hygiene-and-patterns)
7. [Customising the system](#7-customising-the-system)
8. [Troubleshooting](#8-troubleshooting)
9. [Quick command reference](#9-quick-command-reference)

---

## 1. Prerequisites

| Tool | Why | How to check |
|---|---|---|
| [Claude Code](https://www.claude.com/product/claude-code) | The skill runs inside it | `claude --version` |
| [Node.js 18 or newer](https://nodejs.org) | Runs the engine scripts | `node --version` |
| [Git](https://git-scm.com) | Clone the skill into your skills directory | `git --version` |
| [Notion account](https://www.notion.so) | Tracker database (auto-created on first run) | log in once at notion.so |
| Bright Data account (optional) | Powers LinkedIn / Indeed / Glassdoor scraping. Without it, you fall back to free ATS endpoints. | https://brightdata.com |
| Go 1.24+ (optional) | Only needed if you want to use the terminal-UI dashboard | `go version` |

If any of the four required tools is missing, install it before continuing.

---

## 2. Installation

The whole repo IS the skill bundle — you clone it into your Claude Code skills directory once.

### macOS / Linux

```bash
git clone https://github.com/marz1307/applyd ~/.claude/skills/applyd
cd ~/.claude/skills/applyd
npm install
```

### Windows (PowerShell)

```powershell
git clone https://github.com/marz1307/applyd $env:USERPROFILE\.claude\skills\applyd
cd $env:USERPROFILE\.claude\skills\applyd
npm install
```

That's the install done. You never need to clone again — Claude Code will find the skill at `~/.claude/skills/applyd/SKILL.md` and load it whenever you type `/applyd`.

### Set up your workspace

The skill is read-only. Your personal data (CV, profile, tracker, generated PDFs) lives in a separate **workspace** folder you pick. Most people use a dedicated directory:

```bash
mkdir ~/applyd-workspace
cd    ~/applyd-workspace
```

You can use any folder. From now on, **always cd into your workspace before running `/applyd`**. The skill writes user-layer files to whichever directory it sees as `cwd`.

### Optional: install Firecrawl for clean scraping

Firecrawl is an optional second-tier fetcher used by Step −1 (URL ↔ JD coherence) to return clean markdown + metadata for any URL. **You don't have to install it now** — onboarding will walk you through it and offer alternatives if Docker isn't available.

If you want to install it ahead of time, the bundled script handles everything:

```bash
# macOS / Linux / Git Bash
bash ~/.claude/skills/applyd/scripts/install-firecrawl.sh

# Windows PowerShell
& "$env:USERPROFILE\.claude\skills\applyd\scripts\install-firecrawl.ps1"
```

It clones Firecrawl into `~/.applyd/firecrawl`, runs `docker compose up -d`, and waits for the health check on `http://localhost:3002`. Re-running is safe; it fast-forwards the checkout and brings the container up if it's already there.

Three paths exist for Firecrawl support:
- **Self-host** (this script) — no keys, fully local. Requires Docker.
- **Cloud** — paste a `FIRECRAWL_API_KEY` from https://firecrawl.dev. Paid per scrape.
- **Skip** — the fetch-chain falls through to Bright Data → Playwright → WebFetch automatically.

If you skip Firecrawl AND Bright Data, the scanner still works — it just covers fewer portals (Greenhouse / Ashby / Lever / Workable only). See §3 onboarding for the trade-off.

### Start Claude Code

In your workspace, launch Claude Code:

```bash
claude
```

You'll get a chat prompt. Type:

```
/applyd
```

If everything is wired up, you'll see the onboarding flow start.

---

## 3. First-run onboarding

The skill asks you ten questions in three batches (4 + 4 + 2). You can think about them ahead of time; here's what each one is for and what to have ready.

### Batch 1: identity and direction

| # | Question | What to have ready |
|---|---|---|
| 1 | **Where is your CV?** | A markdown / PDF / DOCX file path, OR your LinkedIn URL, OR "draft from scratch" (the skill will ask 5–8 questions to build a CV). |
| 2 | **LinkedIn URL?** | Your full profile URL (`https://linkedin.com/in/your-handle`). |
| 3 | **Portfolio URL?** | Personal site URL, or GitHub URL, or skip if you don't have one. |
| 4 | **Target markets?** | Multi-select: UK / EU broad / US / Remote anywhere. Pick everything that applies. |

The skill writes whatever you give it into your workspace as:
- `cv.md` — canonical CV in markdown (you can edit this any time)
- `config/profile.yml` — identity, contact, target markets

### Batch 2: roles, secrets, scheduling

| # | Question | What to have ready |
|---|---|---|
| 5 | **Target roles?** | Either paste a list (e.g. "Senior Backend Engineer, Staff Platform Engineer, AI Engineer") OR pick "infer from my CV" and the skill extracts role titles from your most recent 2 positions. |
| 6 | **Bright Data API key?** | **Default is to skip** (free ATS APIs only — Greenhouse / Ashby / Lever / Workable, ~150 companies). Paste a key only if you want LinkedIn / Glassdoor / Indeed / Monster coverage. You can add a key later. |
| 7 | **Notion integration token?** | If you don't have one yet, pick "walk me through" and the skill talks you through creating it at https://www.notion.com/profile/integrations. Then paste the token (starts with `ntn_`). Also paste the URL of the Notion page where you want the tracker DB to live. |
| 8 | **Scheduled scan hour?** | When do you want the recurring scan to fire? Presets: 07:00 (catch overnight postings), 12:30 (lunchtime), 18:00 (end-of-day), Custom, or Off. Pick whichever fits your local rhythm. |

### Batch 3: Firecrawl + email layer (both optional)

| # | Question | What to have ready |
|---|---|---|
| 9 | **Firecrawl for clean scraping?** | **Default is self-host** (Docker required, no keys, fully local). Alternatives: skip (Playwright + WebFetch fallback, always works) or cloud (paste a `FIRECRAWL_API_KEY`, paid per scrape). The skill detects Docker — if it's missing, it offers cloud / skip automatically. |
| 10 | **Email response-tracking layer?** | **Default is skip** (you check replies manually). Enable it and applyd will read your Gmail inbox READ-ONLY and auto-file employer replies as `Rejected` / `Responded` on the matching Notion row. Requires a Gmail MCP connector in your agent (Claude Code: `/mcp` → add Gmail; other agents: their own MCP config). Only read + label OAuth scopes needed — decline any send scopes. Sets `EMAIL_LAYER=gmail` in `.env`. Never sends anything. Gmail-compatible IMAP mailboxes work too via a compatible MCP — set `EMAIL_LAYER=<mcp-name>` yourself. |

At the end of Batch 2, the skill:

1. Writes `BRIGHTDATA_API_KEY` and `NOTION_TOKEN` to `.env` (gitignored — these never leave your workspace).
2. Calls Notion's API to **auto-create the Applications database** with the canonical schema (Job URL, Match score, Stage, Resume, Cover Letter, Recruiter contact, etc.).
3. Adds **three Notion views**:
   - **Pipeline board** — kanban grouped by Stage (your daily triage view).
   - **By score** — table sorted by Match score DESC, filtered to Stages 2–3 (your drafting queue).
   - **Active interviews** — board filtered to Stages 5–9 (your interview cockpit).
4. Copies `portals.yml` from the template, applying your target-role keywords and target-market location filter.
5. Registers a recurring `/applyd scan` via the `/schedule` skill at the hour you picked.
6. Prints the Notion DB URL so you can open it.

Setup is done. You're at Stage 0 of an empty pipeline.

---

## 4. Daily workflow

The end-to-end loop is **scan → triage → draft → submit**. The skill automates everything except the final click — you stay in control of what goes out.

### 4.1 Morning: review the scheduled scan

If you set a scan hour, by the time you sit down the skill has already:

- Hit Greenhouse / Ashby / Lever / Workable JSON endpoints for every company in your `portals.yml`.
- If Bright Data is configured, scraped LinkedIn / Indeed / Glassdoor / Welcome to the Jungle / Reed UK.
- Deduped against the Notion DB on `Job URL`.
- Written every new posting as a `Stage 1. Discovered` row in Notion.

Open your Notion **Pipeline board** view and look at the new Stage 1 cards. You can either:

- Let the next scheduled run auto-evaluate them, OR
- Trigger evaluation immediately by running `/applyd pipeline` in your workspace.

`/applyd pipeline` reads every Stage 1 row, runs the A–G evaluation (see [4.2](#42-evaluate-a-specific-posting) for what that means), and updates each row's Stage and Match score in Notion.

### 4.2 Evaluate a specific posting

You can also evaluate one posting at a time, on demand. Paste a job URL into your Claude Code chat:

```
https://job-boards.greenhouse.io/anthropic/jobs/12345678
```

#### Step −1 first: URL ↔ JD coherence check (automatic)

Before any A–G block runs, the skill performs a pre-flight check via Playwright (or WebFetch in batch mode):

| Check | Fails if… | Outcome |
|---|---|---|
| **URL stability** | The URL redirects to a generic `/jobs` or `/careers` page (i.e. the specific posting is gone) | `URL_LOST` — skill stops, asks you for a different URL |
| **Title coherence** | The page title doesn't include the role-family keywords you named | `TITLE_MISMATCH` — skill stops, asks you to confirm or correct |
| **Company coherence** | The company name on the page doesn't match what you named in chat | `COMPANY_MISMATCH` — skill stops, asks you to confirm |
| **Liveness** | The page body has < 500 chars of meaningful JD content (it's a 404, login wall, or "this job is no longer available" placeholder) | `JD_DEAD` — Notion row → `Withdrew` with timestamped Fit notes |

These are HARD STOPS. If any check fires, the skill writes nothing — no report, no Notion row, no PDF — and surfaces the mismatch for you to resolve. This is what stops you from ever sitting on a folder full of beautifully tailored CVs pointing at the wrong job.

When all four checks pass, the skill writes a `**Verified:**` block at the top of the report capturing the page title, the company-on-page, the role-on-page, and the JD body length. CI (`scripts/test-all.mjs` Check 13) re-reads this block on every push to detect drift between a report's H1 and the verified page facts.

#### Then the A–G evaluation blocks run

The skill runs **A–G evaluation blocks** against your `cv.md` and `modes/_profile.md`:

| Block | What it does |
|---|---|
| **A. Role summary** | One-line TL;DR — archetype, domain, function, seniority, remote/hybrid/onsite, team size. |
| **B. Match with CV** | Maps every JD requirement to specific lines in your CV. Surfaces gaps. |
| **C. Level and strategy** | "Sell senior without lying" plan plus "if they downlevel me" plan, adapted to the archetype. |
| **D. Comp and demand** | Researches market rate via Glassdoor, Levels.fyi, Reed UK, local job boards. Output is a range with sources cited. |
| **E. Customisation plan** | Top 5 changes to make to your CV and your LinkedIn for this specific role. |
| **F. Interview plan** | 6–10 STAR+R stories mapped to JD requirements. Reflection column shows what you learned (senior signal). |
| **G. Posting legitimacy** | Detects ghost jobs by analysing posting freshness, description quality, hiring signals, reposting patterns. |

Output goes to:
- A markdown report at `reports/{NNN}-{company-slug}-{YYYY-MM-DD}.md` in your workspace.
- The matching Notion row updated to `Stage 2. Triaged` with Match score, Fit notes, Recruiter-sim verdict.

**Hard floor**: if Match score is below 70/100, the row auto-routes to `Not pursuing` and **no draft is generated**. You can override only with a specific reason (recruiter referral, etc.).

### 4.3 Generate the tailored CV and cover letter

If the evaluation surfaced a fit (Match score ≥ 70), tailor a CV and cover letter:

```
/applyd pdf
```

(Or paste the URL again — the auto-pipeline handles this end-to-end.)

The skill:

1. Detects the archetype from the JD (e.g. Analytics Engineer vs Data Scientist vs Backend Engineer — defined in `modes/_profile.md → Your Adaptive Framing`).
2. Extracts 15–20 keywords from the JD.
3. Tailors the CV — reorders the skills section, reorders experience bullets so the most JD-relevant comes first, and tweaks the profile opener.
4. **Never invents skills you don't have.** Every claim has to be defensible in a 45-minute interview.
5. Applies your writing-style rules (no em dashes, action verbs, no buzzwords, consistent spelling per `writing-samples/WRITING_STYLE.md`).
6. Renders to A4 PDF via Playwright at `output/<YourName>_CV_<CompanySlug>_<YYYY-MM-DD>.pdf`.
7. Drafts a 1-page cover letter at `output/<YourName>_Cover_Letter_<CompanySlug>_<YYYY-MM-DD>.pdf`.
8. Attaches both files to the Notion row and transitions it to `Stage 3. Drafted`.

Open both files and **read them**. The skill is good but it's not psychic — if a bullet reads wrong, tell the skill ("the second bullet under my current role should lead with the pipeline work, not the modelling") and it'll regenerate.

### 4.4 Submit the application

When you're ready to apply, navigate to the application form in your browser. Then in Claude Code:

```
/applyd apply
```

The skill:

1. Reads what's on your active Chrome tab (URL, form questions).
2. Loads the matching report from `reports/`.
3. Identifies every visible form question — free text, dropdowns, yes/no, salary, upload fields.
4. Generates an answer for each one, using:
   - Proof points from `cv.md` and `article-digest.md`.
   - STAR stories from Block F of the report.
   - The "I'm choosing you" framing for "why this company" questions.
   - Reference to something specific from the JD currently on screen.
5. Presents the answers in the chat for copy-paste, plus uploads the tailored CV PDF and cover letter PDF.

**The skill stops before clicking Submit.** It hands you the form to review. You click Submit, then come back and say "submitted" (or "applied" or "sent it"). The skill:

1. Transitions the Notion row to `Stage 4. Applied`.
2. Stamps `Apply date` to today.
3. Sets `Next action = "Wait 1 week, then follow up if no response"`.
4. Writes the final submitted answers into the report's Section G for audit.
5. Suggests outreach: "want me to draft a LinkedIn note to the named recruiter or hiring manager?" — that's `/applyd contacto`.

That's the full cycle. From posting URL to submitted application, with the agent doing everything except the final click and the answer review.

---

## 5. Interview prep cycle

When a company replies and schedules a call:

```
/applyd interview-prep <company-name>
```

The skill reads the original A–G report (specifically Block F's STAR+R stories) and builds a 6-document prep pack in `interview-prep/{NNN}-{company-slug}/`:

1. **Company intel** — recent news, product launches, hiring signals, leadership team, key metrics.
2. **Likely questions** — mapped to your STAR stories, ranked by likelihood given the JD.
3. **JD-tailored stories** — your STAR+R stories rewritten to lead with the JD's biggest signals.
4. **Technical stack drill** — deep dive on the JD's named technologies with example interview questions.
5. **Questions to ask them** — 5–8 thoughtful questions that signal you've read the JD and researched the company.
6. **Comp negotiation prep** — bands from Block D, your walk-away number, scripts for the comp conversation.

After each interview, tell the skill what happened ("phone screen done, went well, next round is a tech interview with the data team lead on Tuesday"). The skill transitions the Notion row to the next Stage and updates Next action / Next action date.

---

## 6. Tracker hygiene and patterns

A few maintenance modes worth knowing:

### `/applyd tracker`
Status snapshot — applications this week, response rate, stages by count, average time per stage, anything stale (Stage 6 for more than 10 days, Stage 9 with no response within a week, etc.).

### `/applyd patterns`
Once you have 30+ applications, this runs pattern analysis on your data. Surfaces things like:
- "Most rejections happen at Stage 6 (phone screen). Your CV is good but the screening conversation isn't selling. Consider mock screens."
- "Tier-1 companies converting at 3× the rate of Tier-2. Allocate more weight there in `portals.yml`."
- "Recruiter-sim verdict `MAYBE` rows are converting better than `INVITE` rows — the verdict is under-calibrated; review the heuristic in `modes/_profile.md`."

### `/applyd followup`
Calculates which Stage-4 applications are due for a polite check-in (default cadence: 7 weekdays after Apply date, then one more after another 5).

### `/applyd contacto`
Drafts LinkedIn outreach messages to recruiters, hiring managers, peers, or interviewers — three-sentence hook → proof → CTA, max 300 chars for the first message.

---

## 7. Customising the system

Everything about *you* lives in user-layer files. Updates to the skill (via `git pull` in the skill folder) **never overwrite them**. Just ask the skill in chat:

| You say… | The skill edits… |
|---|---|
| "Change my target roles to Backend Engineer and Platform Engineer" | `config/profile.yml.target_roles` + `modes/_profile.md → Your Target Roles` + `portals.yml.title_filter.positive` |
| "Add these companies to my portals" | `portals.yml.tracked_companies` |
| "Adjust the scoring weights to prioritise remote roles" | `modes/_profile.md → Scoring Weights` |
| "Update my CV — I just shipped a new project" | `cv.md` + `article-digest.md` |
| "Tighten the seniority filter to mid-level only" | `modes/_profile.md → Seniority band` + `portals.yml.title_filter.negative` + `config/profile.yml.target_roles.archetypes[].level` |
| "Switch the score floor to 75 — I want fewer drafts" | `config/profile.yml → triage.score_floor` |
| "Change the recurring scan from 07:00 to 12:30" | `config/profile.yml → schedule.scan_hour_local` |

The boundary between "user data the skill must never touch on update" and "system files that updates can freely overwrite" is documented in [`DATA_CONTRACT.md`](DATA_CONTRACT.md).

---

## 8. Troubleshooting

### `/applyd` doesn't trigger anything
- Check `~/.claude/skills/applyd/SKILL.md` exists.
- Try `claude --version` — older versions of Claude Code may not load skills from `~/.claude/skills/`. Update if needed.
- Make sure you `cd`'d into your workspace, not into the skill folder. The skill runs against `cwd`.

### Notion DB didn't get created
- Check `.env` has a valid `NOTION_TOKEN` (starts with `ntn_`).
- Confirm you shared the parent Notion page with your integration (Notion page → ··· → Connections → Add → your integration). If you didn't, the skill can't write to it.
- Run `/applyd setup` to re-trigger the DB creation step alone.
- **Or run the shell-based creator directly** — useful when the Notion MCP isn't loaded or you want to script it across machines:

  ```bash
  cd $WORKSPACE
  node ~/.claude/skills/applyd/scripts/notion/notion-dashboard.mjs --parent-page <notion-page-url-or-id>
  ```

  This calls the official Notion REST API (no MCP dependency) to create the Applications DB with the canonical schema, plus a "📊 Dashboard" child page with three linked-database blocks (Pipeline / By score / Active interviews) you customise in the Notion UI. Writes the new IDs back into your workspace's `config/profile.yml`. Works from bash, Git Bash, PowerShell, and Windows CMD.

  Verify an existing DB matches the canonical schema:
  ```bash
  node ~/.claude/skills/applyd/scripts/notion/notion-dashboard.mjs --check
  ```

### Scanner returns zero results
- If you skipped Bright Data, the scanner only hits free ATS endpoints. Check `portals.yml.tracked_companies` has companies with `careers_url` pointing to Greenhouse / Ashby / Lever / Workable boards.
- Verify `portals.yml.title_filter.positive` has keywords that actually appear in the JDs you're targeting.
- Run `npm run scan` directly from your workspace to see the raw output (`cd $WORKSPACE && node ~/.claude/skills/applyd/scripts/scan/scan.mjs`).

### PDF generation fails
- Playwright sometimes needs a one-time browser install: `cd ~/.claude/skills/applyd && npx playwright install chromium`.
- Check `cv.md` is parseable — it needs an H1 (your name) plus H2 sections like `## Experience`, `## Skills`, etc.
- Re-run with `npm run pdf -- --debug` to see the intermediate HTML output.

### "Setup complete" but the next session can't find anything
- You ran `/applyd` from a different folder. Each session, `cd` back to your workspace first.

### Firecrawl container died / not responding on :3002

Check status:
```bash
bash ~/.claude/skills/applyd/scripts/install-firecrawl.sh --status
```

If it reports the container is down, restart it:
```bash
cd ~/.applyd/firecrawl && docker compose up -d
```

If it still won't start, check the logs:
```bash
cd ~/.applyd/firecrawl && docker compose logs --tail 50
```

Common culprits:
- Docker Desktop quit on logout / reboot. Open Docker Desktop and let it finish starting.
- Port 3002 is taken by another process. Find what's using it (`lsof -i:3002` on macOS/Linux, `netstat -ano | findstr :3002` on Windows) and either stop that process or change Firecrawl's port (edit `~/.applyd/firecrawl/.env` and update `FIRECRAWL_URL` in your workspace `.env` to match).
- Disk full — the Firecrawl images need ~1 GB.

### Docker isn't installed and I want to add Firecrawl later

Two options:
1. Install Docker Desktop from https://docker.com, then run `bash ~/.claude/skills/applyd/scripts/install-firecrawl.sh`.
2. Get a Firecrawl Cloud API key from https://firecrawl.dev and add `FIRECRAWL_API_KEY=fc-...` to your workspace `.env`. The fetch-chain picks up cloud automatically.

### Help! I want to start over
- Delete your workspace folder and run `/applyd` in a fresh empty directory. Notion DB stays; the skill will recognise the existing one if `notion.applications_db_id` is preserved in `config/profile.yml`.

---

## 9. Quick command reference

In any Claude Code session, after `cd`ing into your workspace:

| Command | Effect |
|---|---|
| `/applyd` | Help menu / re-run onboarding |
| `/applyd setup` | Force-re-run onboarding |
| `/applyd scan` | Scan portals for new postings |
| `/applyd pipeline` | Process all pending Stage-1 URLs (evaluate them) |
| paste a JD URL | Auto-pipeline: evaluate + draft + log |
| `/applyd oferta <url>` | Evaluate one specific JD only |
| `/applyd ofertas` | Compare multiple offers side-by-side |
| `/applyd pdf` | Generate a tailored CV PDF for the current draft |
| `/applyd apply` | Interactive form-fill assistant |
| `/applyd interview-prep <company>` | Build a tailored prep doc |
| `/applyd contacto` | LinkedIn outreach drafts |
| `/applyd deep <company>` | Company research brief |
| `/applyd tracker` | Status snapshot of your pipeline |
| `/applyd patterns` | Rejection-pattern analysis (needs 30+ apps) |
| `/applyd followup` | Follow-up cadence calculator |
| `/applyd project <name>` | Evaluate adding a portfolio project |
| `/applyd training <course>` | Evaluate a course or certification |

### npm scripts (run from your workspace, point to engine)

```bash
# pattern: cd $WORKSPACE && node ~/.claude/skills/applyd/<script>.mjs

npm run scan          # zero-token portal scanner
npm run pdf           # HTML to ATS-optimised PDF
npm run merge         # merge batch tracker TSVs into applications.md
npm run verify        # data-integrity check on the tracker
npm run dedup         # remove duplicate tracker rows
npm run normalize     # normalise status values
npm run liveness      # check if a job URL is still active
npm run patterns      # analyse outcomes and report patterns
npm run doctor        # repo health check
npm run notion:setup  # shell-based Notion DB + dashboard creator
npm run notion:check  # verify Notion DB schema matches canonical
```

---

## Ethical reminder

- **The agent never submits applications.** It fills forms, drafts answers, generates PDFs — but stops before Submit / Send / Apply. You make the final call every time.
- **Honour the score floor.** Applications with Match score below your `triage.score_floor` (default 70/100) auto-route to `Not pursuing` and never get a draft. Override only with a specific reason.
- **Quality over speed.** A well-targeted application to 5 companies beats a generic blast to 50.
- **Respect recruiters' time.** Every application a human reads costs someone's attention. Only send what's worth reading.

---

[← back to README](README.md) · [security policy](SECURITY.md) · [data contract](DATA_CONTRACT.md) · [customisation guide](docs/CUSTOMIZATION.md)
