# Agent Compatibility Matrix

applyd is **agent-neutral**. The project contract lives in [`AGENTS.md`](../AGENTS.md) — a plain-Markdown file that any modern coding-agent CLI can read. This document is the compatibility matrix: what works where, what needs setup, and where the sharp edges are.

The reference implementation is Claude Code (that's what the project was originally built and tested against). Every other agent listed here is **supported by contract** — the modes, routines, and scripts are written in generic terms and work with any agent that reads `AGENTS.md`. Community verification is welcome; open an issue if you find something drift.

---

## Compatibility matrix

| Agent | Reads for instructions | Slash / mode invocation | MCP | Routine scheduler | Tested? |
|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` + `AGENTS.md` (imported) | `/applyd <mode>` slash command; `Skill` tool for chained modes | `.mcp.json` (project-level); account-level Notion MCP for interactive sessions | `routines/run-routine.ps1` via `routines/adapters/claude.ps1` | **reference / tested** |
| **Codex CLI** | `AGENTS.md` | `codex exec` reads the prompt; paste the mode file's body or `@include` it | `~/.codex/config.toml` `[mcp_servers]` — copy the entry from `.mcp.json` | `run-routine.ps1` with `CAREER_OPS_AGENT_CLI=codex` → `routines/adapters/codex.ps1` | supported, community-verify |
| **Cursor** | `.cursor/rules/applyd.mdc` + `AGENTS.md` | `@modes/<name>.md` in chat or composer | `.cursor/mcp.json` (mirror the shape of `.mcp.json`) | not natively; drive `run-routine.ps1` from a separate shell | supported, community-verify |
| **Zed** | `AGENTS.md` (Zed's assistant reads `AGENTS.md` automatically) | `/prompt @modes/<name>.md` or paste the mode body | Zed's `settings.json` `mcp_servers` | drive `run-routine.ps1` from an external shell | supported, community-verify |
| **OpenCode** | `AGENTS.md` | mode invocation via OpenCode's session commands | OpenCode's MCP config path | drive `run-routine.ps1` externally | supported, community-verify |
| **Gemini CLI** | `GEMINI.md` + `AGENTS.md` | `@modes/<name>.md` in an interactive session | `~/.gemini/settings.json` `mcpServers` | `run-routine.ps1` with `CAREER_OPS_AGENT_CLI=gemini` → `routines/adapters/gemini.ps1` | supported, community-verify |
| **Aider** | `.aider.conf.yml` pre-loads `AGENTS.md` + `modes/_shared.md` + `modes/_profile.template.md` | `/read modes/<name>.md` in an aider session, then act on it | Aider does not currently support MCP; MCP-dependent modes need a fallback path | drive `run-routine.ps1` externally; aider itself is not wired as an adapter yet | supported, community-verify |

---

## Setup per agent

### Claude Code (reference)

- Install via the plugin marketplace: `/plugin install marz1307/applyd`.
- Onboarding: type `/applyd` in a fresh Claude Code session.
- Modes: `/applyd <mode>` or paste a JD URL to trigger `auto-pipeline`.
- Routines: Windows Task Scheduler → `routines/run-routine.ps1 -Routine <name>` (defaults to the Claude adapter).
- MCP: `.mcp.json` at repo root; the wrapper launches with `--strict-mcp-config` so only the declared servers load in scheduled runs.

### Codex CLI

- Install: `npm i -g @openai/codex-cli` (or your preferred install method).
- Run a mode:
  ```
  codex exec < modes/oferta.md
  ```
  or pass the file's body as the prompt argument.
- MCP: add the equivalent of `.mcp.json`'s `brightdata` entry to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.brightdata]
  command = "npx"
  args = ["-y", "@brightdata/mcp"]
  env = { API_TOKEN = "${BRIGHTDATA_API_KEY}" }
  ```
- Routines:
  ```
  $env:CAREER_OPS_AGENT_CLI = "codex"
  powershell -File routines/run-routine.ps1 -Routine morning-scan
  ```
- Approvals: the Codex adapter launches `codex exec` without auto-approve flags. If a routine needs file writes or shell, set your Codex `approval_mode` in `config.toml` accordingly, or edit `routines/adapters/codex.ps1`.

### Cursor

- Add the repo to a Cursor workspace. `.cursor/rules/applyd.mdc` auto-applies.
- Invoke a mode: type `@modes/oferta.md` in the composer, then send.
- MCP: mirror `.mcp.json` into `.cursor/mcp.json` (Cursor's own MCP config lives per-workspace).
- Routines: run `routines/run-routine.ps1` from an external terminal.

### Zed

- Zed's built-in assistant reads `AGENTS.md` automatically.
- Invoke a mode: reference `modes/<name>.md` in an assistant prompt (`/prompt @modes/oferta.md`) or paste the file body.
- MCP: configure via `settings.json` under `mcp_servers`. Copy the shape from `.mcp.json`.
- Routines: run `routines/run-routine.ps1` externally.

### OpenCode

- Point OpenCode at the repo. It picks up `AGENTS.md` as the primary contract.
- Invoke a mode: use OpenCode's session command to read `modes/<name>.md` and follow it.
- MCP: configure per OpenCode's docs; use the `brightdata` entry from `.mcp.json` as a template.
- Routines: external.

### Gemini CLI

- Install: `npm i -g @google/gemini-cli`.
- Run a mode interactively: start `gemini`, then `@modes/oferta.md`.
- MCP: edit `~/.gemini/settings.json`:
  ```json
  {
    "mcpServers": {
      "brightdata": {
        "command": "npx",
        "args": ["-y", "@brightdata/mcp"],
        "env": { "API_TOKEN": "${BRIGHTDATA_API_KEY}" }
      }
    }
  }
  ```
- Routines:
  ```
  $env:CAREER_OPS_AGENT_CLI = "gemini"
  powershell -File routines/run-routine.ps1 -Routine morning-scan
  ```
- The Gemini adapter is a stub — verify locally with `system-eval` first.

### Aider

- Install: `pip install aider-chat`.
- `.aider.conf.yml` at the repo root auto-loads `AGENTS.md`, `modes/_shared.md`, and `modes/_profile.template.md` into every session.
- Invoke a mode: in an aider session, `/read modes/<name>.md` then instruct aider to follow it.
- MCP: aider does not currently support MCP. For MCP-dependent modes (LinkedIn/Xing scraping via Bright Data), run the corresponding `scripts/scan/*.mjs` or `scripts/notion/*.mjs` helpers directly and feed the output back to aider.
- Routines: no aider adapter ships yet; drive the wrapper from another agent or a plain shell.

---

## Known caveats

- **`SKILL.md` + `.claude-plugin/` are Claude-Code-only.** They exist for the plugin marketplace listing. Other agents ignore them; the mode-routing table (in `AGENTS.md`) is the portable contract.
- **MCP-dependent modes only work under agents with MCP support.** Any mode that says "use the Bright Data MCP" or "use the Notion MCP" needs either (a) native MCP in the agent, or (b) a fallback via the equivalent REST script in `scripts/notion/`, `scripts/scan/`, or a manual Bright Data call. Aider is the notable "no MCP" agent as of writing.
- **`routines/*.ps1` are Windows-first.** They target Windows Task Scheduler and use PowerShell 5.1 syntax. Linux and macOS users can adapt the pattern with `routines/drain-pipeline.sh` and shell equivalents, or run the underlying `.mjs` scripts directly via `node`.
- **Some modes may reference agent-specific browser tools** (`browser_snapshot`, `browser_navigate`, etc.). These are Playwright-MCP tool names as exposed by Claude Code and Cursor's Playwright plugin. Under other agents, use your CLI's equivalent (Playwright MCP directly, a Chrome-driver MCP, or a fresh Playwright script). The rule of intent — "read the rendered JD before trusting the URL is live" — is agent-neutral.
- **Adapter stubs are not production-verified.** `routines/adapters/codex.ps1` and `routines/adapters/gemini.ps1` are best-effort implementations. Run a read-only routine like `system-eval` manually before scheduling anything that costs money or mutates Notion.
- **Windows Task Scheduler battery defaults will silently no-op headless runs on laptops.** New tasks need `AllowStartIfOnBatteries` + `DontStopIfGoingOnBatteries` + `StartWhenAvailable`. This is Task-Scheduler-specific, not agent-specific.
