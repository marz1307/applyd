# applyd — Claude Code overlay

> **This file layers Claude-Code-specific bindings on top of `AGENTS.md`. Read `AGENTS.md` first.** Everything project-wide — architecture, data contract, ethics, offer-verification rules, onboarding, TSV format, canonical states, Notion contract — lives there and applies to every agent equally.

This overlay lists only the bits that are specific to Claude Code:

## Tool bindings

When a mode says a generic thing like "fetch the JD", "search the repo", "read a file", or "invoke another mode", use Claude Code's tools:

| Operation (from `modes/*.md`) | Claude Code tool |
|---|---|
| "Fetch a URL / JD" (static page fallback) | `WebFetch` |
| "Search the repo for X" | `Grep` |
| "Read a file / image / PDF" | `Read` |
| "Write / edit a file" | `Write` / `Edit` |
| "Verify a job posting is live" (interactive) | Playwright MCP: `browser_navigate` + `browser_snapshot` |
| "Run a background research task" | `Task` |
| "Run another mode" (e.g. `oferta`, `pdf`) | `Skill` tool or `/applyd <mode>` slash command |
| "Web search" | `WebSearch` |
| "Batch process without a session" | `claude -p "..."` (headless) |

Modes generally use generic wording (e.g. "fetch the URL and read the JD") so the same instructions run under other agents. When a mode gives an example that names a specific Claude tool, treat it as an example, not as an exclusion.

## Plugin marketplace

applyd installs as a Claude Code plugin. The marketplace entry points must stay at repo root — moving them breaks `/plugin install marz1307/applyd`:

- `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json`
- `.mcp.json`
- `SKILL.md`
- `CLAUDE.md`
- `AGENTS.md`

The `/applyd` slash command is defined via `SKILL.md` and the plugin manifest. Onboarding, mode routing, and the recurring-scan setup are all reachable from that entry point.

## MCP servers

Project-level MCP config lives in `.mcp.json`. Currently declares `brightdata` (via `npx -y @brightdata/mcp`, env var `API_TOKEN=${BRIGHTDATA_API_KEY}`).

Notion is reached one of two ways depending on context:
- **Cowork / interactive Claude sessions:** the account-level Notion MCP with tool prefix `mcp__claude_ai_Notion__*` (or the community server, `mcp__notion__*`).
- **Scheduled routines:** REST via `scripts/notion/*.mjs` + `NOTION_TOKEN`. The wrapper (`routines/run-routine.ps1`) launches Claude with `--strict-mcp-config --mcp-config <repo>/.mcp.json`, so ONLY the brightdata server loads — every account-level MCP is excluded from a routine's context.

## Headless routines

Scheduled unattended runs use `claude -p` under `routines/run-routine.ps1`. The wrapper handles per-routine allowlists (`--allowedTools`), strict MCP config, subscription-vs-API-credit billing guards, per-routine timeouts, self-healing retries, and structured alerts. This is the reference implementation of the multi-agent dispatcher described in `AGENTS.md → Headless / batch mode`; other agent CLIs are wired via sibling adapters under `routines/adapters/`.

### Environment isolation (strict MCP config)

`run-routine.ps1` launches `claude -p` with `--strict-mcp-config --mcp-config <repo>/.mcp.json`, so a scheduled routine loads ONLY the servers this project declares — every account-level MCP (Notion, Slack, Gmail, Figma, plugin MCPs, etc.) is excluded from its context. This cuts per-run standup from ~500K+ cache tokens to low tens of K. Safe because no scheduled routine talks to the account-level Notion MCP; they reach Notion via REST scripts under `scripts/notion/*.mjs` with `NOTION_TOKEN`. Any `mcp__…__*` entries left in a routine's `--allowedTools` are harmless no-ops under strict config. Plugin skills / agents still load; disabling unused plugins (or `--bare`) is the next lever if further trimming is wanted.

### Subscription-only (no `ANTHROPIC_API_KEY`)

Scheduled routines run on the operator's Claude subscription via `claude.exe -p`, not against paid API credits. `run-routine.ps1` strips `ANTHROPIC_API_KEY` from the child-process environment before launching, and CV/CL helpers (`scripts/cv/cv-qa.mjs`, `scripts/cv/profile-enrich.mjs`) default to the same subscription path. Do NOT export `ANTHROPIC_API_KEY` or set `CAREEROPS_QA_USE_API=1` unless the operator has explicitly opted in — silently switching to API billing has surprised operators before. Recovery for a subscription quota hit is either to wait or to fall through to the mechanical template path (`cv-quality-rules.md` self-audit).

### Session-length capping (per-session chunks + drain loop)

Nightly LLM routines (`auto-eval`, `auto-draft`) don't try to process the whole backlog in one `claude -p` session — that used to swell the context to multi-MB and re-read everything each turn. Instead, per-run caps in `config/profile.yml → triage.*` are small **per-session chunks** (defaults: `max_evaluations_per_run: 15`, `max_drafts_per_run: 7`, `auto-interview-prep: 5 packs`). Daily throughput is preserved by a **drain loop**: `routines/drain-routine.ps1 -Routine <r> -Stage <s>` re-fires the routine as a fresh small session per iteration until the target stage's Notion depth reaches 0 (checkpoint = the stage transition itself), with a ceiling on iterations and a no-progress guard. `auto-interview-prep` stays single-fire because its Stage-5+ backlog is normally small.

### ROUTINE_CONTRACT format

Every routine ends its stdout with a machine-parseable block that `run-routine.ps1` validates. If the block is missing, malformed, or reports `ROUTINE_ABORT`, the run is treated as a failure regardless of the CLI's exit code:

```
--- ROUTINE_CONTRACT ---
ROUTINE: {routine-name}
TIMESTAMP_UTC: {iso}
{routine-specific counters, one per line, key: value}
ERRORS: {n}
ERROR_DETAILS: |
  {one error per line, if any}
--- END_ROUTINE_CONTRACT ---
```

Watchdog routines (`system-eval`) emit a parallel `--- SYSTEM_EVAL_CONTRACT --- … --- END SYSTEM_EVAL_CONTRACT ---` block. Do not summarise, re-format, or code-fence contract blocks in your own output — the validator scans for the literal markers.

### Dashboard publishing removed

There is no `publish-dashboard.sh` in this repo and there should not be. Dashboards are read from the local `dashboard.html` that `scripts/dashboard/build-dashboard.mjs` writes, and nowhere else. Historically a publish path silently failed for months against a deleted remote; nothing surfaced it because the exit code went only into the trace. Re-introducing it would be a route for employer names, match scores and rejections to leave a private machine.

### Applies-window mechanism

`apply-window.mjs` reads `config/profile.yml → apply.*` (Tue–Thu 06:30–09:00 UK in the reference profile — chosen because DACH recruiter inbox-opens land at ~07:30 CET, which is 06:30 UK, catching DACH + UK + EU-remote simultaneously). The script emits `RECOMMENDATION: send | hold | send-now-fast | skip-stale` per candidate URL and is consumed by both the scheduled `pace-check` routine and the interactive `apply.md` mode. Modes must NOT hardcode times — always read from the config.

Notable Claude-specific gotchas the wrapper defends against:
- `claude -p` in headless mode needs a long-lived token from `claude setup-token` — short-lived interactive OAuth tokens can't refresh under `-p`.
- `ANTHROPIC_API_KEY` in the process env silently switches `claude.exe` to API-credit billing instead of the subscription. The wrapper strips it before launching (see "Subscription-only" above).
- Windows Task Scheduler defaults (`DisallowStartIfOnBatteries: true`) will silently no-op headless runs on laptops. New tasks need `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries` + `StartWhenAvailable`.

## Skills and skill-style helpers

Modes are consumable both by the `Skill` tool and by any agent that reads the file. If you're running under Claude Code and a mode's flow refers to another mode, prefer the `Skill` invocation — it loads the mode file and follows it without you having to paste the whole prompt.

## Batch worker

`batch/batch-prompt.md` is the self-contained prompt for `claude -p` parallel evaluations. See `AGENTS.md → Headless / batch mode` for the agent-neutral dispatcher.

@AGENTS.md
