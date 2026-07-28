# applyd — Gemini CLI overlay

> **This file layers Gemini-CLI-specific bindings on top of `AGENTS.md`. Read `AGENTS.md` first.** Everything project-wide — architecture, data contract, ethics, offer-verification rules, onboarding, TSV format, canonical states, Notion contract — lives there and applies to every agent equally.

## Invoking a mode

Modes are plain-Markdown files under `modes/`. From an interactive `gemini` session, load one with `@modes/<name>.md` (Gemini CLI resolves `@` as a file include) and follow its instructions.

For example:

```
> @modes/oferta.md
> Evaluate this posting: https://example.com/jobs/123
```

## Headless / batch mode

`routines/run-routine.ps1` supports Gemini via `routines/adapters/gemini.ps1`. Enable it before invoking the wrapper:

```
$env:CAREER_OPS_AGENT_CLI = "gemini"
powershell -File routines/run-routine.ps1 -Routine morning-scan
```

The Gemini adapter is a best-effort stub — run `system-eval` (read-only) manually first before scheduling anything paid or mutating.

## MCP servers

Gemini CLI reads MCP config from `~/.gemini/settings.json` under the `mcpServers` key. The project's `.mcp.json` (used by Claude Code) is a starting point — copy its `brightdata` entry into your Gemini settings file, keeping the env var reference `${BRIGHTDATA_API_KEY}`. Notion access in scheduled routines uses REST via `scripts/notion/*.mjs` + `NOTION_TOKEN` regardless of agent, so no Notion MCP is required.

See `docs/AGENT_COMPAT.md` for the full compatibility matrix.
