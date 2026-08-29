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

Run this after any port session, on the staging clone, before pushing. Three passes — an identifier grep for named-person data, a **structural grep** for the classes of leak that hide in test fixtures and comments, and a **full-repo grep** (not just `git diff`) because leaks carry through unchanged file copies.

### Pass 1 — identifier grep

Fill in the placeholders with your fork's real identifiers — this file's public copy names none of them:

```bash
# Personal-name / identifier grep. Every fork extends this list with:
#   * The operator's given name(s) and surname
#   * Any handle they use across social/git (github, linkedin slug, x handle)
#   * Every past and current employer named in the fork's cv.md
#   * Every school / university named in the fork's cv.md
#   * Any personal e-mail domain (@<theirs>.com), never a work address
#   * The fork's Notion database UUIDs (both applications and referral DBs)
#   * The fork's Task Scheduler task-name prefix (typically the maintainer's initials)
#   * Every employer / person named in the fork's HANDOFF chain (session notes
#     accumulate real names as they document real incidents — always grep
#     against the last ~10 session-note files, not just the standing quarantine
#     list)
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

### Pass 2 — structural grep (catches what Pass 1 misses)

This exists because a 2026-08-29 leak sweep found 22 references the identifier grep had missed. Every one was in a test fixture, a comment, or a docstring — grep had nothing to match because the operator's name wasn't in it. The leak was a **structural pattern**:

- **`APP-####` references** in code comments and self-tests. The fork's own Notion application IDs (from a `data/applications.md` ledger) traceable back to specific rows. Test fixtures use them as "we observed this bug on X" callouts.
- **Real employer names inside self-test fixtures.** Even known-public companies (Fortune 500 logistics, DAX-listed reinsurers, etc.) tie a test to a specific application-history incident.
- **URL patterns derived from real employer sites** (`careers.<employer>.com/en/job/…`, `<employer>consulting.avature.net`, `group.<employer>.com`) — used as functional test inputs for scanners / resolvers.
- **DACH-market brand names in classifier regexes** that correlate with the fork's target market — even without the operator's name attached.

```bash
# Pass 2: structural leak grep. No placeholders — these patterns work on any fork.

# a) APP-#### references anywhere. Every real fork ID is a blocker unless it
#    matches an obviously-generic placeholder (APP-XXXX, APP-1000..1003,
#    APP-1234, APP-2000, APP-9000 are the conventions in the public repo).
git grep -nE '\bAPP-[0-9]{3,5}\b' -- '*.mjs' '*.js' '*.cjs' '*.md' '*.ps1' 2>/dev/null \
  | grep -viE 'APP-XXXX|APP-1000\b|APP-1001\b|APP-1002\b|APP-1003\b|APP-1010|APP-101\b|APP-1234|APP-2000\b|APP-3000\b|APP-5678\b|APP-54\b|APP-999\b|APP-9000\b|APP-123\b'

# b) Real-looking employer names inside self-tests. Grep every string that
#    reads like `Employer GmbH` / `Employer AG` / `Employer Ltd` / `Employer plc`
#    inside a *.test.mjs, *.test.js, or a self-test block. Every hit needs a
#    generic-placeholder or an intentional-fixture justification.
git grep -nE '[A-Z][A-Za-z]{2,15}\s+(GmbH|AG|SE|KG|Ltd|LLC|plc|Inc)' \
  -- '*.test.mjs' '*.test.js' '*self-test*' 2>/dev/null

# c) URLs that resolve to a real employer's careers or Impressum surface.
#    A test fixture that ships with a real employer's URL ties it to that
#    employer's site as a debug reference point.
git grep -nE 'careers\.[a-z0-9-]+\.(com|de|co\.uk|eu)|group\.[a-z0-9-]+\.com|[a-z0-9-]+\.avature\.net' \
  -- '*.test.mjs' '*.test.js' '*.mjs' '*.js' '*.cjs' 2>/dev/null \
  | grep -viE 'example\.com|example\.de|exampleco\.'

# d) Non-generic brand names in classifier regexes. This is the class that hides
#    inside a functional pattern. Run the pattern alphabet against the fork's
#    HANDOFF-known employers rather than a fixed list — the fixed list rots.
```

### Pass 3 — scope: `git diff` is NOT enough

The 22 references above lived in files the port didn't touch this cycle — they came in with an earlier port cycle and rode through unchanged. `git diff <baseline>..HEAD` misses them.

Run every pass on the **full working tree**, not the diff:

```bash
# Right — scans every tracked file:
git grep -nE '<pattern>' -- '*.mjs' '*.js' '*.cjs' '*.md'

# Wrong — misses everything a prior port already leaked:
git diff <baseline>..HEAD | grep -E '<pattern>'
```

Every hit is a blocker until you can explain it:

- It's inside a `README.md` legitimately crediting the upstream maintainer? OK.
- It's inside an example JSON shipped as `<file>.example.json` alongside the gitignored real one? OK.
- It's a generic-placeholder token (`APP-XXXX`, `Example Corp`, `example.com`)? OK.
- It's anywhere else? Blocker. Fix before pushing.

`scripts/test-all.mjs` runs a version of Pass 1 as its **Personal data leak check** section — a fresh clone must never trip it. Passes 2 and 3 are operator responsibility; wire them into your own pre-push checklist.

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
- **Slash commands are prefixed `/applyd`, not `/career-ops` or `/<fork-name>-…`.** The upstream re-brand happened in v2.1; a personal fork may still use the older name locally, but the port strips it back to `/applyd`.

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
