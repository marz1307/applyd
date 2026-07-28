# Mode: notion-tracker — Notion as System of Record

This file is the **contract spec** between applyd and the Notion job tracker. Every mode that reads or writes tracker state reads this file first to get the schema, dedup rule, score floor, stage transitions, and field mappings.

Notion is **the system of record** for live status and human approval. `data/applications.md` is a local cache that runs in parallel.

The Applications database is **auto-created during onboarding** by the `/applyd` skill (see `.claude/skills/applyd/SKILL.md` Step 4). The skill calls `notion-create-database` with the canonical schema below, then writes the returned IDs into `config/profile.yml`.

---

## Manual wire-up (only if you skipped the skill flow)

1. Create a Notion internal integration at https://www.notion.com/profile/integrations.
2. Share the parent page with the integration (page → ··· → Connections → Add → your integration).
3. Add the integration token to `.env`:
   ```
   NOTION_TOKEN=ntn_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
4. Run `/applyd setup` and pick "I have a Notion integration token" — the skill will create the database for you.
5. Or hand-create the Applications database using the schema below, then add the IDs to `config/profile.yml`:
   ```yaml
   notion:
     applications_db_id: "<DB ID — 32 hex chars without dashes>"
     applications_data_source_id: "<data source UUID with dashes>"
   ```

To find the IDs: open the DB in Notion → ··· → Copy link. The 32-char hex string in the URL is the DB ID. To get the data source ID, call `notion-search` once and look at the response.

## Dashboard views

The skill also adds three views to the Applications DB at create time:

1. **Pipeline board** — kanban grouped by Stage. Card title = Company; preview shows Position, Match score, Country.
2. **By score** — table sorted by Match score DESC, filtered to Stages `2. Triaged` / `3. Drafted`. The user's daily drafting queue.
3. **Active interviews** — board grouped by Stage, filtered to Stages 5–9. The interview cockpit.

If you skipped the skill flow, add these views by hand in the Notion UI or re-run `/applyd setup`.

---

## Applications DB — schema

The primary write target for everything applyd produces.

### Properties

| Property | Type | Purpose | Filled by |
|----------|------|---------|-----------|
| **Company** | title | Short company name | scan / pipeline (on discover) |
| **Position** | multi_select | One or more role-family tags (e.g. `Analytics Engineer`, `Data Scientist`) | scan |
| **Source portal** | select | `LinkedIn`, `Indeed`, `Glassdoor`, `Monster`, `Monster UK`, `eFinancialCareers UK`, `Welcome to the Jungle`, `Handshake`, `Greenhouse`, `Ashby`, `Lever`, `Workable`, `Reed UK`, `Hays UK`, `Company site`, `Other` | scan |
| **Country** | select | Target market: `United Kingdom`, `Ireland`, `Netherlands`, `Germany`, etc. | scan |
| **Location** | rich_text | Specific city or "Remote" string from the JD | scan |
| **Language** | select | JD language: `English`, `Other` | scan |
| **Work model** | select | `Remote`, `Hybrid`, `On-site` | scan / oferta |
| **Company tier** | select | `Tier 1`, `Tier 2`, `Tier 3` (set per `portals.yml`) | scan |
| **Industry** | select | `SaaS`, `Fintech`, `Healthcare`, `E-commerce`, etc. | scan |
| **Seniority** | select | `Mid`, `Senior`, `Lead`, `Staff`, `Principal`, `Head` | scan |
| **Recruiter-sim verdict** | select | `INVITE`, `MAYBE`, `REJECT` | oferta |
| **Match score** | number | 0–100 — used for routing and priority. Below `triage.score_floor` → auto Not pursuing. | oferta |
| **Fit notes** | rich_text | 1–3 sentence summary of fit + biggest gap | oferta |
| **JD snapshot** | rich_text | First 2000 chars of the JD, captured at discover time | scan |
| **Stage** | select | See "Stage pipeline" below | scan → oferta → pdf → apply |
| **CV variant** | select | e.g. `General`, `Analytics Engineer`, `Data Scientist` (set per the user's archetypes) | pdf |
| **CL variant** | select | `General`, `Cover Letter`, `Skipped` | pdf |
| **Discovered date** | date | When scan first found the posting | scan |
| **Apply date** | date | When the user clicked submit | apply |
| **Response date** | date | When the company responded | manual / response-tracker |
| **Next action** | rich_text | What the user needs to do next | oferta / pdf / apply |
| **Next action date** | date | When the next action is due | oferta / pdf / apply |
| **Recruiter name** | rich_text | Named recruiter if known | manual / contacto |
| **Recruiter contact** | rich_text | Email / LinkedIn URL | manual / contacto |
| **Salary band** | rich_text | Researched range from Block D | oferta |
| **Visa/sponsorship** | select | `Required`, `Not required`, `Unclear` | oferta |
| **Resume** | files | Tailored CV PDF | pdf |
| **Cover Letter** | files | Tailored cover letter PDF | pdf |
| **Referral?** | checkbox | True if a warm referral was used | manual / contacto |
| **Application ID** | unique_id (auto) | Auto-incremented application number | Notion |
| **Job URL** | url | The canonical posting URL — DEDUP KEY | scan |
| **Agent run ID** | rich_text | Tag the batch run that touched this row | scan / oferta / batch |

### Dedup rule (HARD)

**`Job URL` is the unique key.** Before inserting any new row:

1. Run `notion-search` against the Applications DB filtered by `Job URL` equals the candidate URL.
2. If a row exists, **update** instead of insert. Never create duplicate rows.
3. The same posting on two portal aliases (e.g. a LinkedIn URL and the company-site URL for the same job) must be merged manually — the dedup is URL-string-exact, not semantic.

---

## Stage pipeline

| # | Stage | When applyd sets this | Notes |
|---|-------|----------------------------|-------|
| 1 | `1. Discovered` | scan finds a new posting | First insert |
| 2 | `2. Triaged` | oferta finishes A–G evaluation | Match score, Recruiter-sim verdict, Fit notes are written |
| 3 | `3. Drafted` | pdf generates Resume + Cover Letter files | Files attached; CV variant + CL variant set |
| 4 | `4. Applied` | apply records human submit | Apply date written. **The user triggers this, not the agent.** |
| 5 | `5. Assessment/OA` | response-tracker mode | Online assessment received |
| 6 | `6. Phone screen` | response-tracker mode | First call scheduled |
| 7 | `7. Tech interview` | response-tracker mode | Technical interview scheduled |
| 8 | `8. Onsite/Final` | response-tracker mode | Final round |
| 9 | `9. Offer` | response-tracker mode | Offer received |
| — | `Signed` | manual | Contract signed |

**Terminal states (no further transitions):**

| Stage | When applyd sets this |
|-------|----------------------------|
| `Rejected` | Company rejected. Captured on response. |
| `Withdrew` | The user withdrew. Manual or apply. |
| `Not pursuing` | **Auto-set when Match score < `triage.score_floor`.** No human triage. Fit notes explain why. |

### Stage transition rules

- `1. Discovered` → `2. Triaged`: oferta sets this after writing Match score + verdict + Fit notes.
- `2. Triaged` → `Not pursuing`: AUTOMATIC if Match score < score floor. Skip Stage 3. No draft generated.
- `2. Triaged` → `3. Drafted`: pdf sets this after attaching Resume + Cover Letter.
- `3. Drafted` → `4. Applied`: apply sets this when the user confirms submit. NEVER auto-transition. **Apply date is written here.**
- Any active stage → `Rejected` / `Withdrew`: terminal.

---

## Automation contract (defaults — override in `config/profile.yml → triage.*`)

| Parameter | Default | Where to override |
|-----------|---------|-------------------|
| **Hard score floor** | Match score ≥ 70 surfaces for drafting. Below → `Not pursuing`. | `config/profile.yml → triage.score_floor` |
| **Priority** | Match score DESC end to end. | implicit |
| **Daily draft quota** | Top 35 / day | `config/profile.yml → triage.max_drafts_per_run` |
| **Pace alarm threshold** | If apply pace < threshold for N consecutive days, alarm | `config/profile.yml → pace.*` |
| **Dedup** | `Job URL` exact-string match | implicit |
| **Agent run ID** | Every batch run writes a unique ID into `Agent run ID` | implicit |

---

## Field mapping — applyd → Notion

| Local TSV column | Notion field | Notes |
|------------------|--------------|-------|
| `num` (sequential) | `Application ID` (auto) | Notion auto-assigns. |
| `date` | `Discovered date` / `Apply date` | Two separate fields. |
| `company` | `Company` (title) | |
| `role` | `Position` (multi_select) | One tag per role family. |
| `status` (canonical) | `Stage` (select) | Map `Evaluated` → `2. Triaged`, `Applied` → `4. Applied`, `Rejected` → `Rejected`, `Discarded` → `Withdrew`, `SKIP` → `Not pursuing`. |
| `score` (X.X / 5) | `Match score` (number 0–100) | Multiply by 20. |
| `pdf` (✅/❌) | `Resume` (files) | Attach the file when generated. |
| `report` (md link) | `Fit notes` (rich_text) | First sentence is the link description + score, second sentence is the biggest gap. |
| `notes` (1-sentence) | `Fit notes` (rich_text) | Same target. |
| (none) | `Job URL` (url) | Dedup key. Always required. |
| (none) | `Agent run ID` (rich_text) | Tag every write. |
| (none) | `Source portal` (select) | Detected from the URL host. |
| (none) | `Country` / `Location` / `Language` | Extracted from JD by oferta. |
| (none) | `Recruiter-sim verdict` (select) | Output of the optional recruiter-sim slash command. |
| (none) | `CV variant` / `CL variant` (select) | Set by pdf mode after tailoring. |

---

## Source portal detection

When scan/pipeline writes a row, map the URL host to the `Source portal` select value.

| URL host fragment | Source portal |
|-------------------|----------------|
| `linkedin.com/jobs` | `LinkedIn` |
| `glassdoor.com/job-listing` / `glassdoor.co.uk/job-listing` | `Glassdoor` |
| `monster.com/job-openings` | `Monster` |
| `monster.co.uk/job-openings` | `Monster UK` |
| `efinancialcareers.co.uk` | `eFinancialCareers UK` |
| `joinhandshake.com` | `Handshake` |
| `welcometothejungle.com` | `Welcome to the Jungle` |
| `indeed.com` / `indeed.co.uk` | `Indeed` |
| `reed.co.uk` | `Reed UK` |
| `hays.co.uk` | `Hays UK` |
| `boards.greenhouse.io` / `job-boards.greenhouse.io` / `boards-api.greenhouse.io` | `Greenhouse` |
| `jobs.lever.co` | `Lever` |
| `jobs.ashbyhq.com` | `Ashby` |
| `apply.workable.com` | `Workable` |
| Anything else | `Company site` |

If unsure, set `Other`. Never block on this.

---

## Referral & Outreach DB (optional, schema)

Secondary DB for tracking recruiter / referral outreach. Wire it up the same way as the Applications DB.

| Property | Type | Purpose | Filled by |
|----------|------|---------|-----------|
| **Name** | title | Contact's full name | contacto / manual |
| **Company** | rich_text | Their employer | contacto |
| **Role** | rich_text | Their role at the company | contacto |
| **LinkedIn URL** | url | Profile link | contacto |
| **Outreach status** | select | `Not contacted`, `Note sent`, `Replied`, `Referral confirmed`, `Declined`, `No response` | contacto |
| **Note template** | select | `Cold-EN`, `Warm-mutual-EN`, `Recruiter-inbound` (extend with localised variants as needed) | contacto |
| **Country** | select | Their location | contacto |
| **Date** | date | First outreach date | contacto |
| **Linked application** | relation → Applications DB | The application this outreach is tied to | contacto |

---

## Notion MCP tools — quick reference

The Notion MCP server exposes these tools (loaded via ToolSearch as needed):

| Tool | Use case |
|------|----------|
| `notion-search` | Look up a row by `Job URL` (dedup), find rows by Stage |
| `notion-create-pages` | Insert a new row into the Applications DB |
| `notion-update-page` | Update Stage, Match score, attach files, set Apply date, etc. |
| `notion-fetch` | Read a specific page by ID |
| `notion-create-comment` | Add a comment to a row |
| `notion-get-users` | Get a user's user ID for assignment fields |

---

## Parallel-write rule (Notion + applications.md)

Every Notion write triggers a parallel write to `data/applications.md` via the existing TSV pipeline:

1. Career-ops writes to Notion first.
2. On success, write the equivalent TSV row to `batch/tracker-additions/{id}.tsv`.
3. Periodically (or on demand), `node scripts/tracker/merge-tracker.mjs` merges the TSV rows into `applications.md`.

**Order matters.** If the Notion write fails, the TSV write is skipped. Surface the Notion error to the user.

For UPDATE operations on existing rows: update Notion first, then update `applications.md` directly.

---

## Error handling

| Failure mode | Action |
|--------------|--------|
| Notion API rate limit / 5xx | Retry up to 3× with exponential backoff (1s, 4s, 16s). Then surface to the user with the row payload preserved. |
| `Job URL` dedup hit at insert time | Update the existing row instead. Append a comment noting the re-discovery date. |
| Required Notion field missing | Surface a clear error: "Notion DB schema does not include Stage option X — add it in Notion before re-running." Never silently coerce. |
| Match score < score floor but oferta still tried to draft | Hard fail. Log the bug. Set Stage to `Not pursuing` regardless. |
| Local `applications.md` write fails after Notion write succeeded | Notion is source of truth; surface a warning that local cache is stale. |

---

## What this contract does NOT do

- **Does not auto-submit applications.** Stage `4. Applied` is set by `modes/apply.md` ONLY when the user confirms the submit.
- **Does not auto-transition past Stage 4.** Stages 5–9 are set by `response-tracker` mode or manually.
- **Does not delete rows.** Use the `Withdrew` or `Discarded` terminal states.
- **Does not move money or accept offers.** Offer acceptance is a human decision.
