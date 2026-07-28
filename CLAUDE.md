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

Notable Claude-specific gotchas the wrapper defends against:
- `claude -p` in headless mode needs a long-lived token from `claude setup-token` — short-lived interactive OAuth tokens can't refresh under `-p`.
- `ANTHROPIC_API_KEY` in the process env silently switches `claude.exe` to API-credit billing instead of the subscription. The wrapper strips it before launching.
- Windows Task Scheduler defaults (`DisallowStartIfOnBatteries: true`) will silently no-op headless runs on laptops. New tasks need `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries` + `StartWhenAvailable`.

## Skills and skill-style helpers

Modes are consumable both by the `Skill` tool and by any agent that reads the file. If you're running under Claude Code and a mode's flow refers to another mode, prefer the `Skill` invocation — it loads the mode file and follows it without you having to paste the whole prompt.

## Batch worker

`batch/batch-prompt.md` is the self-contained prompt for `claude -p` parallel evaluations. See `AGENTS.md → Headless / batch mode` for the agent-neutral dispatcher.

@AGENTS.md
