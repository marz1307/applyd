# Mode: pipeline — URL Inbox (Second Brain)

Process job URLs stored in `data/pipeline.md`. The user adds URLs at any time and then executes `/career-ops pipeline` to process them all.

## Workflow

1. **Read** `data/pipeline.md` → search for `- [ ]` items in the "Pending" section
2. **For each pending URL**:
   a. Calculate the next sequential `REPORT_NUM` (read `reports/`, take the highest number + 1)
   b. **Extract JD** using browser automation (preferred) → plain web fetch → web search. (Claude reference bindings: Playwright MCP `browser_navigate` + `browser_snapshot` → `WebFetch` → `WebSearch`.)
   c. If the URL is not accessible → mark as `- [!]` with a note and continue
   d. **Execute full auto-pipeline**: Evaluation A-F → Report .md → PDF (if score >= 3.0) → Tracker
   e. **Move from "Pending" to "Processed"**: `- [x] #NNN | URL | Company | Role | Score/5 | PDF ✅/❌`
3. **If there are 3+ pending URLs**, launch agents in parallel (Agent tool with `run_in_background`) to maximize speed.
4. **At the end**, show summary table:

```
| # | Company | Role | Score | PDF | Recommended action |
```

## Format of pipeline.md

```markdown
## Pending
- [ ] https://jobs.example.com/posting/123
- [ ] https://boards.greenhouse.io/company/jobs/456 | Company Inc | Senior PM
- [!] https://private.url/job — Error: login required

## Processed
- [x] #143 | https://jobs.example.com/posting/789 | Acme Corp | AI PM | 4.2/5 | PDF ✅
- [x] #144 | https://boards.greenhouse.io/xyz/jobs/012 | BigCo | SA | 2.1/5 | PDF ❌
```

## Intelligent JD detection from URL

1. **Browser automation (preferred):** navigate + snapshot the rendered page. Works with all SPAs. (Claude: Playwright MCP `browser_navigate` + `browser_snapshot`; other agents: their equivalent.)
2. **Plain web fetch (fallback):** For static pages or when browser automation is unavailable. (Claude: `WebFetch`; Codex: shell + curl.)
3. **Web search (last resort):** Search in secondary portals that index the JD.

**Special cases:**
- **LinkedIn**: May require login → mark `[!]` and ask the user to paste the text
- **PDF**: If the URL points to a PDF, read it directly using the agent's file-read capability (Claude: `Read`; other agents: their equivalent).
- **`local:` prefix**: Read the local file. Example: `local:jds/linkedin-pm-ai.md` → read `jds/linkedin-pm-ai.md`

## Automatic numbering

1. List all files in `reports/`
2. Extract the number from the prefix (e.g., `142-medispend...` → 142)
3. New number = maximum found + 1

## Source synchronization

Before processing any URL, verify sync:
```bash
node scripts/cv/cv-sync-check.mjs
```
If there is a desynchronization, warn the user before continuing.

---

## Notion write on each URL

Pipeline mode delegates the per-URL work to the auto-pipeline (Evaluation A–G → Report .md → PDF → Tracker), which routes through `modes/oferta.md`. `oferta.md` is the file that does the Notion write — see `modes/notion-tracker.md` for the schema and stage transitions.

**However, pipeline mode itself is responsible for one Notion-side concern: dedup before processing.**

For each URL in `## Pending`:

1. Before calling the auto-pipeline, run `notion-search` on the Applications DB filtered by `Job URL = {url}`.
2. If a row already exists:
   - If its `Stage` is one of `4. Applied` / `5. Assessment/OA` / `6. Phone screen` / `7. Tech interview` / `8. Onsite/Final` / `9. Offer` / `Signed` / `Rejected` / `Withdrew` → **skip evaluation** (it's already in flight or terminal). Mark in `pipeline.md` as `- [~]` with a note like "already in Notion at Stage X". Continue to the next URL.
   - If its `Stage` is `1. Discovered` / `2. Triaged` / `Not pursuing` → **re-evaluate** (situation may have changed). The downstream Notion write in `oferta.md` will UPDATE the existing row rather than INSERT, per the dedup rule.
3. If no row exists → proceed with the auto-pipeline as usual. `oferta.md` will INSERT a new row at the end.

This keeps the pipeline efficient and avoids re-running expensive evaluations on URLs already mid-flight.

---

## Notion write on each URL

Pipeline mode delegates the per-URL work to the auto-pipeline (Evaluation A–G → Report .md → PDF → Tracker), which routes through `modes/oferta.md`. `oferta.md` is the file that does the Notion write — see `modes/notion-tracker.md` for the schema and stage transitions.

**However, pipeline mode itself is responsible for one Notion-side concern: dedup before processing.**

For each URL in `## Pending`:

1. Before calling the auto-pipeline, run `notion-search` on the Applications DB filtered by `Job URL = {url}`.
2. If a row already exists:
   - If its `Stage` is one of `4. Applied` / `5. Assessment/OA` / `6. Phone screen` / `7. Tech interview` / `8. Onsite/Final` / `9. Offer` / `Signed` / `Rejected` / `Withdrew` → **skip evaluation** (it's already in flight or terminal). Mark in `pipeline.md` as `- [~]` with a note like "already in Notion at Stage X". Continue to the next URL.
   - If its `Stage` is `1. Discovered` / `2. Triaged` / `Not pursuing` → **re-evaluate** (situation may have changed). The downstream Notion write in `oferta.md` will UPDATE the existing row rather than INSERT, per the dedup rule.
3. If no row exists → proceed with the auto-pipeline as usual. `oferta.md` will INSERT a new row at the end.

This keeps the pipeline efficient and avoids re-running expensive evaluations on URLs already mid-flight.
