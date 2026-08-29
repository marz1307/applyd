# applyd — Glossary

Terms you will see in the Notion tracker, in mode output, and in this repo's docs. Grouped by topic. Where a term maps to a Notion field or a mode file, that's noted.

---

## Stages (Notion `Stage` field)

The pipeline is stage-tracked from discovery to signed offer. Every application row lives in exactly one stage.

| Stage | Meaning | Who advances it |
|---|---|---|
| `1. Discovered` | Just scraped from a portal, not evaluated yet. | Scanner (`scan.mjs`, `bd-bulk-scan.mjs`) |
| `2. Triaged` | Passed the A–G evaluation and Match score ≥ floor. | `auto-eval` routine |
| `3. Drafted` | Tailored CV + cover letter generated and attached. | `auto-draft` routine |
| `4. Applied` | You submitted the application. | **You** (manual) |
| `5. Assessment/OA` | Got a take-home / online assessment. | You |
| `6. Phone screen` | Recruiter screening call scheduled or done. | You |
| `7. Tech interview` | Technical round. | You |
| `8. Onsite/Final` | Final round. | You |
| `9. Offer` | They made an offer. | You |
| `Signed` | You accepted (terminal). | You |
| `Rejected` | They rejected you (terminal). | You (or email layer auto-files) |
| `Withdrew` | You withdrew (terminal). | You |
| `Not pursuing` | Filtered out before applying (terminal). | You or `auto-eval` |

**Note:** `isApplied` in `metrics-core.mjs` counts `Rejected` as applied — a `Rejected` row is a genuine send that got a no. Removing `Rejected` from `APPLIED_STAGES` would silently drop real applications from the funnel.

---

## Match score (0–100)

The composite score from the A–G evaluation rubric in `modes/oferta.md`. Higher = better fit.

| Band | Meaning | Routing |
|---|---|---|
| **90+** | Drop everything, submit first | Drafts first |
| **80–89** | High-conviction | Drafts today |
| **75–79** | Solid | Drafts if you have capacity |
| **< score_floor** (default 80) | Below floor | Auto-archived via `trash_below_floor` |

Bands are re-calibrated by `scripts/metrics/metrics-core.mjs → scoreCalibration()` against your actual funnel outcomes. Read the dashboard's "Score calibration" card to see whether the score is predictive on your current data (it often isn't past the response step — score predicts responses, not screens).

### Related floor terms

- **`score_floor`** — the triage cut-off (default 80). Set in `config/profile.yml → triage.score_floor`.
- **`override_floor`** — high-conviction manual overrides (recruiter referrals, INVITE-only rows) get through this second gate even below the score floor.
- **`cleanup_floor`** — retroactive-cleanup floor. Decoupled from `score_floor` so raising the triage floor doesn't sweep old Stage-3 drafts.

---

## A–G evaluation blocks (`modes/oferta.md`)

Each posting is scored across 7 dimensions:

| Block | Weight anchor |
|---|---|
| **A. Compensation** | Band fit vs your `compensation.target_range` |
| **B. Role family** | Match to your archetype (AE / DS / DE / BI / etc.) |
| **C. Location** | Country/city gate + market-tail visa fit |
| **D. Tech-stack signal** | Overlap with your CV's stack |
| **E. Seniority band** | Mid-level only unless explicitly overridden |
| **F. Company-tier preference** | Tier 1 > 2 > 3 per your `portals.yml` |
| **G. Posting legitimacy** | Ghost-ad detection + reposts + recruiter aggregators |

Score sum → Match score. Per-dimension bands feed the calibration layer via the `[blocks scoreA=N,scoreB=N,...]` sentinel in `Fit notes`.

---

## Recruiter-sim verdict

The LLM imagines being a recruiter reading your CV against a specific JD. Three verdicts:

- **INVITE** — recruiter would call you. Ignores the score floor (the `override_floor` mechanism only opens a gate for INVITE).
- **MAYBE** — on the fence; depends on volume. Does NOT open the floor override.
- **REJECT** — recruiter would skip you. If the global score is ≥ 80 but the sim says REJECT, you see `⚠ Recruiter-sim REJECT despite global ≥ 80` — usually a hidden visa requirement, seniority subtlety, or non-EU location.

---

## Outreach states (Notion `Outreach status` field)

The six-state machine in `modes/contacto.md`. Only `scripts/outreach.mjs` can write these.

| State | Meaning |
|---|---|
| `Not contacted` | Lead added to the Referral & Outreach DB by `/referral` or `bd-referral-scout`; no message sent yet. Default entry state. |
| `Contacted` | You sent them a first-touch message (connection note / DM / cold email). Timestamp on `First contact date`. |
| `Follow-up 1` | You sent a second nudge after silence. Typically 7–14 days after `Contacted`. |
| `Follow-up 2` | You sent a third and final nudge. If no reply after this, retire the thread as `Dead`. |
| `Referral confirmed` | The contact confirmed they will (or did) refer you. **Setting this state also flips `Referral?` = `Referred!` on the linked application row** (this is the only automatic write from outreach → application). |
| `Dead` | Thread abandoned — no reply after `Follow-up 2`, or the contact explicitly said no. Terminal. Use `outreach.mjs --retire-dead` to bulk-mark. |

**`outreach.mjs` is the ONLY writer** — refuses ambiguous names, stamps send dates, protects the state machine. Dry-run by default; `--apply` writes. Never mark a send you did not actually make.

---

## Referral status (Notion `Referral?` field on Applications DB)

Reflects whether the application had a warm-path referral behind it.

- `Not referred` — cold application. Default.
- `Referred!` — a contact confirmed a referral (set automatically when the linked outreach reaches `Referral confirmed`).

Used by `metrics-core.mjs → isReferred()` and `referralComparison()` for the dashboard's referred-vs-cold response-rate table.

---

## Funnel outcomes (`metrics-core.mjs` classifiers)

| Classifier | Meaning |
|---|---|
| **applied** | Sent an application (Stage 4+ OR `Rejected`, per `APPLIED_STAGES`) |
| **responded** | Any employer reply, positive or negative — includes a plain rejection |
| **screened** | Got past the ATS to a human conversation (Stage 5+) |
| **progressed** | Got past a screen call (Stage 6+) |
| **ghosted** | Applied ≥ 21 days ago with no response, no rejection |
| **referred** | Has `Referral?` = `Referred!` — otherwise cold |

Response rate = responded / applied. Screen rate = screened / applied. Progression rate = progressed / screened.

---

## Routines

Scheduled scripts under `routines/`. Fire from Windows Task Scheduler via `run-routine.ps1` (which dispatches to a per-CLI adapter).

| Routine | Cadence | What it does |
|---|---|---|
| `morning-scan` | Daily | Free ATS APIs (Greenhouse, Ashby, Lever, Workable) |
| `bd-bulk-scan` | Daily | Bright Data SERP + Firecrawl on auth-walled portals |
| `auto-eval` | Daily | Runs A–G evaluation on Stage-1 rows, promotes to Stage 2 |
| `auto-draft` | Daily | Generates tailored CV + cover letter for Stage-2 rows, promotes to Stage 3 |
| `auto-interview-prep` | Daily | Builds a 6-doc pack for Stage 4+ rows |
| `bd-referral-scout` | Weekly | Layer 3 cold public-profile discovery |
| `pace-check` | Daily | Apply-pace vs `pace.target_per_week` |
| `system-eval` | Twice-daily | Watchdog: routine health, stale-log alerts, outreach health |
| `dashboard-heartbeat` | Twice-daily | Rebuilds local `dashboard.html` from Notion |
| `drain-pipeline` | Manual | Overnight close-out; runs `auto-eval` + `auto-draft` back-to-back until Stage 2 & 3 depths hit zero |

---

## Cadence (`ROUTINE_CADENCE` in `scripts/system-eval.mjs`)

Governs staleness thresholds for the watchdog.

- **`weekday`** — expected to run Mon–Fri. Staleness tolerance ~30 h + any weekend/holiday behind the check.
- **`weekly`** — expected once a week. ~8-day tolerance.
- **`daily`** — expected every day (weekends included). ~26 h tolerance.
- **`manual`** — Cowork-side or on-demand, never stale-flagged.
- **`retired`** — deliberately disabled, never stale-flagged.

---

## Contract lines (`ROUTINE_CONTRACT`)

Every routine emits a `--- ROUTINE_CONTRACT ---` block at the tail of its log. `run-routine.ps1` validates the block; missing → `NO_CONTRACT` failure mode. Common lines:

- `ROUTINE_END: <name>` — the closing sentinel
- `FINAL_STATE: success | partial | failed`
- `FAILURE_MODE: TIMEOUT | CRASH | RUNTIME_ERROR | EMPTY_LOG | SESSION_LIMIT | WEEKLY_LIMIT | NO_CONTRACT`
- `ROWS_PROCESSED: <n>`, `ROWS_DRAFTED: <n>`, `ROWS_APPLIED: <n>` — routine-specific
- `OUTREACH_LEADS: <n>`, `OUTREACH_FOLLOWUPS_DUE: <n>` — outreach health (`outreach.mjs`)
- `APPLY_DATE_RESCUE: <n>` — from `stage-sync-applied.mjs`
- `STAGE_SYNC: <n>` — Stage-3 → Stage-4 syncs post-apply
- `CROSS_PORTAL_SKIPPED: <n>` — bd-bulk-scan cross-portal dedup gate

---

## Agent adapters (`routines/adapters/`)

`run-routine.ps1` reads `$env:CAREER_OPS_AGENT_CLI` (default `claude`) and dispatches to the matching adapter.

- **`claude.ps1`** — reference. Uses `claude -p` with `--strict-mcp-config`, `--allowedTools`, subscription-OAuth check.
- **`codex.ps1`** — best-effort stub. `codex exec` with approval flags OFF by default.
- **`gemini.ps1`** — best-effort stub. `gemini -p`.

Both non-Claude stubs are dispatch-verified but not yet real-world smoke-tested; verify locally before scheduling.

---

## Files a user might mistake

- `cv.md` vs `cv-de.md` — the canonical CV in EN and DE. User content. Populated on onboarding.
- `cv/cv_master.json` — the CV variant renderer's data source. **Populated user-only** — gitignored; ships as `cv_master.example.json` with placeholder content.
- `modes/_profile.md` — YOUR archetypes / seniority band / negotiation scripts / narrative. **Populated user-only** — ships as `_profile.template.md`.
- `config/profile.yml` — identity, contact, comp targets, markets. **Populated user-only** — ships as `profile.example.yml`.
- `modes/_shared.md` — system defaults. **Do not edit for personal content** — use `_profile.md` instead. `_profile.md` reads after `_shared.md` and overrides it.

---

## Repo-topology terms

- **Fork** — a personal, local-only clone (`MY_career-ops` in this project's origin) where user data lives. Never pushes.
- **Staging clone** — a local dir tracking `marz1307/applyd`. Ports run here (`career-ops/` in this project's origin).
- **Applyd** — the public remote at `github.com/marz1307/applyd`.
- **Port cycle** — moving portable improvements fork → staging → applyd. Rules in `docs/PORTING.md`.

---

## See also

- **[MANUAL.md](../MANUAL.md)** — full step-by-step walkthrough (onboarding, daily flow, submission, troubleshooting).
- **[README.md](../README.md)** — pitch + commands + quickstart.
- **[docs/AGENT_COMPAT.md](AGENT_COMPAT.md)** — which coding agents this runs under and how to set each one up.
- **[docs/PORTING.md](PORTING.md)** — the port policy for shipping changes from a personal fork back to this repo.
- **`modes/`** — every slash-command destination is a mode file. Read the mode to see what a `/applyd <mode>` invocation does.
