# Porting Guide

This document is for someone porting changes *between* an applyd install. It codifies the discipline that keeps the public `applyd` remote agent-neutral and personal-data-free while a downstream **personal fork** carries the operator's own CV, comp numbers, employer names, Notion DB IDs and Windows scheduled-task names. If you are only running applyd against your own job hunt, you can stop reading here — this file is not required to *use* applyd, only to safely *ship* changes from a personal fork upstream.

For the multi-agent contract that these files must never break, see [`AGENT_COMPAT.md`](AGENT_COMPAT.md).

---

## Topology

Three repositories, three roles:

```
  PERSONAL FORK                       LOCAL STAGING                      PUBLIC REMOTE
  <personal-org>/<fork>       ->      career-ops (this checkout)  ->     origin/main (applyd)
  ─────────────────                   ─────────────────────                ────────────────────
  populated cv.md, cv-de.md,          nothing personal on disk;            what everybody clones
  config/profile.yml,                 tracked files match the              agent-neutral,
  modes/_profile.md, portals.yml      public remote 1:1;                   example configs only,
  data/*, output/*, reports/*         .example.yml + .template.md         tests must pass on a
  personal Notion DB IDs,             counterparts stay tracked            fresh clone
  personal Task Scheduler names       populated ones are gitignored
```

The **personal fork** is where the operator lives day-to-day. It stays local (or on a private remote — never a public one). It is the source of truth for what the code is trying to do in the real world.

The **local staging** clone is a normal checkout of the public remote. When a generic improvement lands in the fork, it is applied here first, verified against the leak grep and the test suite, and only then pushed to the public remote.

The **public remote** never learns about the fork. Its own working copy carries no `cv.md`, no populated `profile.yml`, no populated `_profile.md`, no `data/*`, no `reports/*`. Every downstream user gets the same clean base.

---

## The seven implicit port rules

Written down here so a fresh port session doesn't have to re-derive them.

### 1. Never push a personal fork to the public remote.

A personal fork holds populated CVs, real employer names, real Notion DB UUIDs, real salary numbers. It cannot go to `origin/main` — not on a branch, not as a squash, not "quickly for review". The port flow is one-way: fork → staging → public, and each step drops content that shouldn't cross the boundary.

If in doubt about a git operation, run it against the staging clone first, not the fork.

### 2. Sanitize identifiers at port time.

Personal names, e-mail addresses, employer references (both current and former), university names, Notion database UUIDs, personal salary numbers, personal apartment addresses, Task Scheduler task names ending in the operator's chosen prefix — all get replaced with placeholders or dropped before the change lands in staging.

The leak grep pattern below is the checklist. Run it against the staging clone after any port and treat every hit as a blocker.

### 3. Ship examples, never populated configs.

For every file the operator populates (`config/profile.yml`, `modes/_profile.md`, `portals.yml`, `cv_master.json`, `experience-pool.json`, `project-pool.json`, `nda-safe-list.yml`, `role-taxonomy.yml`), the public remote tracks a `.example.yml` / `.example.json` / `.template.md` counterpart and gitignores the populated one. When you add a new populated file to the fork, you MUST add a scrubbed example alongside it in the same commit, and add the populated path to `.gitignore` **before** it can be staged by accident.

If you find yourself editing a populated config in staging, you're editing the wrong copy. Move the change to its example twin.

### 4. Data folders never port.

`data/`, `output/`, `reports/`, `interview-prep/`, `jds/` and their subtrees contain per-run artefacts — Notion snapshots, generated PDFs, evaluation reports, JD full-text captures. Even when a snippet inside one of these folders is genuinely useful for others (a scan-history TSV header, a routine-log format), the port is: extract the *shape* (a fixture, a golden example, a README), don't copy the file. `data/routine-logs/*` is an especially load-bearing example — every log line names a company, a role and a score that some individual person wrote.

### 5. Personal proof-points never port.

`cv.md`, `cv-de.md`, `article-digest.md`, `modes/candidate-profile.md`, `writing-samples/*` — these are the operator's own written words about themselves. The public repo tracks templates and scaffolding for these files, never the populated versions. If a mode file needs to reason about "the candidate's stack", it does so by reading `_profile.md → Honest Boundaries` at runtime; it does not embed the operator's actual stack.

The FATAL-flag rubric in `modes/cv-cl-brutal-eval.md` is a good discipline test: read it and confirm that the file lists *categories* of failure (Evidence-Claim Mismatch, Salary Anchor Mismatch, Template-Fill Detection), not *examples* naming real employers, tools, or salary figures. If a personal example ever gets ported by mistake, it will read as an F5 Fabricated-Claim template for other operators.

### 6. Personal infrastructure paths never port.

Windows Task Scheduler task names, hardcoded `C:\Users\<name>\...` paths, personal Notion database UUIDs, personal Bright Data zone names, home LAN hostnames — none of these belong in the public repo. Scheduled tasks and cron examples ship as `.example.ps1` / `.example.sh` with placeholder task-name prefixes; the operator renames them when they install locally.

Watch especially for absolute paths inside routine wrappers, `.ps1` files, and any script that uses `%LOCALAPPDATA%` or `~/Library`. If it names a directory only the fork's operator has, it will look plausible on a public checkout and break silently.

### 7. Reverted-in-fork commits stay unported.

If the fork tried a change, ran it in anger, and reverted it, do NOT port the *original*. The revert is the fork's answer, not a bug in the porting workflow. When surveying commits to port, always include the range up to the current fork `HEAD`, then diff the accumulated port set against `HEAD` — anything reverted by a later commit should drop out.

---

## The port cycle

A single port session, from the fork to the public remote:

1. **Survey.** Skim the fork's recent commits since the last port (`git log --oneline <last-port-tag>..HEAD` in the fork). Group by intent: bug fixes / mechanism improvements / personal-config changes / experiments-then-reverted.
2. **Classify.** For each candidate change, decide: PORT (generic mechanism), SCRUB-AND-PORT (generic mechanism carrying personal detail), DROP (personal-only or reverted-in-fork). Write the classification down before you start writing code — it prevents the mid-port drift where a personal number quietly rides along on a generic patch.
3. **Apply.** Open the change against the staging clone, not the fork. Rewrite personal identifiers inline. If the change references a populated config the public repo doesn't ship, add the change against the `.example` twin instead.
4. **Validate.** Run `node scripts/test-all.mjs --quick` and the leak grep (below). Both must pass on the staging clone before commit.
5. **Commit.** Small commits per concept — a single commit that mixes score-floor changes with a new mode file is harder to revert cleanly than three commits doing each in turn. Keep the commit messages agent-neutral (no "<operator> noticed…" language, no personal timestamps like "over the weekend I…").
6. **Push.** To the public remote's `main` (or a PR branch, if the fork's operator prefers). Never push the fork.
7. **Release.** Bump `VERSION` (semver), tag if the port is a milestone, and update the fork's port-log so the next session knows what has already crossed the boundary.

---

## The leak grep

Run this after any port session, on the staging clone, before pushing. Fill in the placeholders with your fork's real identifiers — this file's public copy names none of them:

```bash
# Personal-name / identifier grep. Every fork extends this list with:
#   * The operator's given name(s) and surname
#   * Any handle they use across social/git (github, linkedin slug, x handle)
#   * Every past and current employer named in the fork's cv.md
#   * Every school / university named in the fork's cv.md
#   * Any personal e-mail domain (@<theirs>.com), never a work address
#   * The fork's Notion database UUIDs (both applications and referral DBs)
#   * The fork's Task Scheduler task-name prefix (typically the maintainer's initials)
PATTERNS=(
  "<personal-first-name>" "<personal-last-name>"
  "<git-handle>" "<linkedin-slug>"
  "<current-employer>" "<past-employer-1>" "<past-employer-2>"
  "<university>"
  "@<personal-domain>"
  "<notion-applications-db-uuid>"
  "<task-scheduler-prefix>"
)
for p in "${PATTERNS[@]}"; do
  git grep -n "$p" -- '*.md' '*.yml' '*.json' '*.mjs' '*.js' '*.cjs' '*.html' '*.ps1' '*.sh' \
    ':!README*.md' ':!LICENSE' 2>/dev/null
done
```

Every hit is a blocker until you can explain it:

- It's inside a `README.md` legitimately crediting the upstream maintainer? OK.
- It's inside an example CV shipped as `cv.example.md` alongside the gitignored real one? OK.
- It's anywhere else? Blocker. Fix before pushing.

`scripts/test-all.mjs` runs a stricter version of this grep as its **Personal data leak check** section — a fresh clone must never trip it.

---

## Example JSON extraction

When the fork carries a populated JSON store (`cv_master.json`, `experience-pool.json`, `project-pool.json`, `nda-safe-list.yml`), the public repo needs a scrubbed twin the reader can copy and edit. The pattern:

1. **Read the populated file.** Identify structural fields (schema, keys, allowed values) vs. content fields (an actual project title, a real employer, a real metric).
2. **Preserve the schema.** Every key in the populated file appears in the example, in the same nesting, so the loader treats them identically.
3. **Replace content with plausible placeholders.** A real title-at-real-employer entry becomes "Senior Backend Engineer at Acme Corp". Metrics become round numbers ("40%", "2K stars") that clearly aren't the operator's real KPIs.
4. **Add a `# Copy this file to ...` header comment.** Point the reader at where to save the populated version (which is gitignored) and what to fill in.
5. **Never invent claims a real candidate could plagiarise.** The point of the example is to *demonstrate the schema*, not to hand out ready-to-ship CV content — if you notice yourself writing polished bullet points that could survive a paste-in, back off.

`config/profile.example.yml`, `templates/portals.example.yml`, `scripts/cv/cv_master.example.json`, `scripts/cv/experience-pool.example.json`, `scripts/cv/project-pool.example.json` and `config/role-taxonomy.example.yml` are the reference cases.

---

## Multi-CLI adapter preservation

Applyd is agent-neutral (see [`AGENT_COMPAT.md`](AGENT_COMPAT.md)) and this constraint bites at port time.

- **No mode file may name Claude Code as the runtime.** They say "the agent" or "the headless CLI". Where a Claude-specific tool has no other-agent equivalent (Playwright MCP, the Notion MCP, Chrome extension), name the tool in parentheses as *one* example, then describe the capability in the neutral form so another agent's equivalent is obvious.
- **`routines/run-routine.ps1` dispatches through `routines/adapters/<agent>.ps1`.** A port that hardcodes `claude -p …` in a routine is a regression — go through the adapter.
- **`.mcp.json` at the project root is the Claude-Code shape.** Every other agent has its own MCP-config path, listed in `AGENT_COMPAT.md`. When you add an MCP dependency, update all three: the `.mcp.json`, the per-agent config example, and the mode file's Prerequisites section.
- **Slash commands are prefixed `/applyd`, not `/career-ops` or `/marvis-…`.** The upstream re-brand happened in v2.1; a personal fork may still use the older name locally, but the port strips it back to `/applyd`.

---

## Fresh-port checklist

Copy this into the port session's scratch notes and tick as you go.

- [ ] Fork's `git log` reviewed; each commit classified PORT / SCRUB-AND-PORT / DROP / already-ported.
- [ ] Changes applied against the *staging* clone, not the fork.
- [ ] Every `.example` / `.template` twin updated when its populated sibling changed.
- [ ] `.gitignore` covers any newly-added populated config.
- [ ] Windows Task Scheduler task names, absolute paths, and personal DB UUIDs sanitised.
- [ ] `node scripts/test-all.mjs --quick` passes (or, if a genuinely-new failure surfaced, addressed and passes).
- [ ] Leak grep clean (`git grep` on the personal patterns above returns no unallowed hits).
- [ ] `docs/repo-map.html` updated if the structural graph changed (nodes added / removed, edges added / removed).
- [ ] `AGENTS.md` and `CLAUDE.md` still hold together — no personal detail leaked into the agent-neutral overlay.
- [ ] Commits split by concept; commit messages agent-neutral.
- [ ] `VERSION` bumped and, for a milestone port, tagged.
- [ ] Push confirmed to go to the *public* remote, not the fork.
- [ ] Port-log in the fork updated with what crossed the boundary in this session.
