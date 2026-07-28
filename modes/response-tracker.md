# Mode: response-tracker — Stages 5-9 (Post-application transitions)

After the user submits an application (Stage 4: Applied), the row sits waiting for the company to respond. This mode handles every transition past Stage 4: assessment received, phone screen scheduled, technical round, onsite, offer, rejection.

> Notion is the system of record. Every stage transition writes to Notion first, then mirrors to `data/applications.md`. See `modes/notion-tracker.md` for the contract.

## Trigger surfaces

Three ways the mode gets invoked:

1. **Manual** — the user says "got a reply from {Company}" or pastes recruiter email text. Most common path until the Gmail MCP is wired.
2. **Gmail MCP (future)** — when the Gmail connector reconnects, a scheduled job can poll for replies matching applied-company domains and trigger this mode automatically.
3. **the user updates Notion directly** — the user flips the Stage manually in Notion. This mode then runs reconciliation to update `applications.md` to match.

## Stage transition table

| From → To | What triggers it | What this mode writes |
|-----------|-------------------|------------------------|
| `4. Applied` → `5. Assessment/OA` | Online assessment / take-home email received | `Stage`, `Response date`, `Next action = "Complete assessment by {deadline}"`, `Next action date` |
| `4. Applied` → `6. Phone screen` | Recruiter schedules first call (no OA first) | `Stage`, `Response date`, `Next action = "Phone screen with {recruiter} on {date}"`, `Recruiter name`, `Recruiter contact` |
| `5. Assessment/OA` → `6. Phone screen` | OA passed, recruiter scheduled call | `Stage`, `Next action date` |
| `5. Assessment/OA` → `Rejected` | OA failed | `Stage = Rejected`, `Response date`, optional comment with feedback |
| `6. Phone screen` → `7. Tech interview` | Phone screen passed, next round scheduled | `Stage`, `Next action`, `Next action date` |
| `6. Phone screen` → `Rejected` | Phone screen failed | `Stage = Rejected`, comment with reason if known |
| `7. Tech interview` → `8. Onsite/Final` | Tech round passed | `Stage`, `Next action`, `Next action date` |
| `7. Tech interview` → `Rejected` | Tech round failed | `Stage = Rejected`, comment with feedback |
| `8. Onsite/Final` → `9. Offer` | Offer extended | `Stage`, `Response date`, `Salary band` (verbal offer amount), `Next action = "Decide by {deadline}"` |
| `8. Onsite/Final` → `Rejected` | Final round failed | `Stage = Rejected` |
| `9. Offer` → `Signed` | the user signs | `Stage = Signed`, attach signed contract to row if available |
| `9. Offer` → `Withdrew` | the user declines | `Stage = Withdrew`, comment with reason |

## Workflow

### Step 1 — Identify the application

the user says: *"Got a phone-screen request from {Company}."* Or pastes recruiter email text. Extract:

- **Company name** (case-insensitive)
- **Role** if mentioned (helps disambiguate when the user has multiple applications at the same company)
- **Type of event** (assessment / phone screen / tech / onsite / offer / rejection)

Search Notion via `notion-search` filtered by `Company = {name}` AND `Stage IN (4. Applied, 5. Assessment/OA, 6. Phone screen, 7. Tech interview, 8. Onsite/Final, 9. Offer)`. If multiple rows match, list them and ask the user which one.

### Step 2 — Parse the event details

If the user pasted email text, extract:

- **Date / time** of the next step (phone screen, OA deadline)
- **Recruiter name + email** (write to `Recruiter name` and `Recruiter contact` if not already set)
- **Specific platform** (HackerRank, Codility, Greenhouse Talkscreen, etc. — store in the comment)
- **Format** (1-on-1, panel, take-home, live coding)
- **Any preparation hints** (e.g. "we'll cover SQL and dimensional modelling" — feed into the interview-prep mode below)

If the user just told you in plain text without pasting an email, ask the minimum needed: date and format.

### Step 3 — Notion update

Per the transition table above:

1. `notion-update-page` with the new `Stage`, `Response date` (if it's the first response), `Next action`, `Next action date`.
2. Add a comment via `notion-create-comment` capturing the raw email or the user's plain-text description, plus the parsed event details. This is the audit trail.
3. If the transition is to `Rejected` and the user has feedback (recruiter said "we went with someone more senior" / "your German isn't where we need"), capture that in the comment — it feeds `patterns.md` for rejection-trend analysis.

### Step 4 — Local cache mirror

Update `applications.md`: change the row's `Status`:

- `Applied` → `Responded` (any of stages 5–8)
- `Responded` → `Interview` (when stage is 6, 7, or 8 — i.e. actively interviewing)
- `Interview` → `Offer` (stage 9)
- `Offer` → no change in `applications.md` for `Signed` (out of scope of the local cache; surface in tracker)
- Any active stage → `Rejected` / `Discarded` (for `Withdrew`)

If the Notion write failed, do NOT update `applications.md`. Notion is source of truth.

### Step 5 — Suggest next action

After the Notion + local cache writes:

- **For Stages 5–8 (active interview process):**
  - Suggest `/applyd interview-prep {company} {role}` to generate a tailored prep doc for the specific upcoming round. Pulls from `interview-prep/story-bank.md` and the original report.
  - If `Next action date` is < 48 hours away, surface a "tight timeline" warning.
- **For Stage 9 (Offer):**
  - Suggest `/applyd oferta-compare` if there are other active offers to weigh against (Stage 9 in multiple rows).
  - Surface the comp research from Block D of the original report alongside the verbal offer to inform negotiation.
- **For Rejected:**
  - Capture the rejection reason in the comment for `patterns.md` analysis.
  - Suggest `/applyd patterns` if the user has had 5+ rejections at the same stage across companies — there's likely a fixable signal.
- **For Signed:**
  - One-line summary: company, role, signed comp, start date.
  - Suggest closing the loop on the Referral & Outreach DB if a referral was involved (mark the linked outreach row as `Replied` / `Success`).
  - Suggest archiving the rest of the active pipeline (move Stages 1–3 to `Withdrew` since the user is no longer looking).

## Patterns the user should track

Surface these proactively when the data supports them:

- **Stage where rejections cluster.** If most rejections happen at Stage 6 (phone screen), the CV is good but the screening conversation isn't. If they cluster at Stage 7 (tech), the technical bar is the gap.
- **Average time per stage.** "Stage 6 → 7 takes the user 9 days on average across this dataset" — useful for setting realistic next-action dates.
- **Recruiter-sim verdict vs actual outcome.** If `INVITE` rows still get rejected at Stage 4 (Applied → Rejected without interview), the recruiter-sim is over-optimistic. If `MAYBE` rows convert to offer, it's under-calibrated. Surface this on a per-month basis.
- **Tier-1 outcomes specifically.** Track conversion separately for any company marked `tier: 1` in `portals.yml`.

## Market etiquette

The user's target market sets the response cadence and tone. Default rules:

- **Response time:** reply within 48 hours on weekdays. If too busy, send a one-line acknowledgement to buy time and commit to a longer reply by a specific date.
- **Language:** if the recruiter wrote in language X and the user's level in X is conversational+, reply in X. Otherwise reply in English with a one-line acknowledgement.
- **Salary discussion:** when asked for a salary expectation early, anchor on the Block D research from the original report. Quote a range, not a point.
- **Probation periods:** many markets have a standard probation (often 3–6 months). Don't negotiate this away — it's usually mutual and culturally expected.
- **References:** some markets (notably Germany) request written work references before the offer stage. Surface gaps early.

## Closing rule

Every transition adds a Notion comment with the raw input that triggered it (email text, conversation note). This is the audit trail. Without it, six months from now the Stage history is just a sequence of dates with no context for why each transition happened.
