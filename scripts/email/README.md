# Email response-tracking layer

Read-only inbox layer that auto-files employer replies as `Rejected` / `Responded` on the matching Notion row. Never sends, never mutates the mailbox.

## Enable

1. Add a Gmail MCP connector to your agent. In Claude Code:
   - Interactive session → `/mcp` → pick the Gmail connector, OR
   - Add Gmail via the Connectors panel on claude.ai, then reconnect the session.
   - Other agents: add the Gmail MCP server to that agent's MCP config file per its docs.

2. Complete the OAuth flow in your browser. **Only read + label scopes are required.** Decline any send / compose scope the connector requests — the layer does not use them.

3. Set the following in your `.env`:

   ```
   EMAIL_LAYER=gmail
   ```

   For an IMAP-compatible mail MCP with a different name, use its slug (`fastmail`, `outlook`, etc.) — the layer treats it identically as long as it exposes label + message reads.

4. Verify with a dry run (touches nothing):

   ```
   node scripts/email/probe.mjs --dry-run
   ```

## Files

- `apply.mjs` — auto-files confirmations. Runs incrementally per `scan-state.mjs`.
- `match.mjs` (+ `match.test.mjs`) — fingerprints employer replies against Notion Applications rows. Sub-brand matching from parent brand supported.
- `probe.mjs` — read-only probe (safe to run any time, in dry-run or live).
- `scan-state.mjs` — incremental scan-state persistence so a re-run resumes mid-inbox.

## Contract

- **Never sends.** No `send`, `draft`, `forward`, `reply`, or `trash` operations. The layer would fail loudly if a caller ever tried.
- **Never mutates the mailbox.** Labels are read, not written.
- **Notion writes go through `scripts/notion/notion-eval-write.mjs`** — the same code path a manual triage would use. The email layer never writes Notion directly.
- **`EMAIL_LAYER` empty or unset → layer is disabled** and all `email/*` scripts no-op.

## Mailbox requirements

Any MCP that exposes:
- List messages by label + timestamp
- Read message headers (`From`, `Subject`, `Date`) + body text

...works. Gmail is the reference implementation because its label model makes filing trivial. Standard IMAP mailboxes work via any IMAP-compatible MCP.
