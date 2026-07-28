# Mode: tracker — Application Status Overview

Reads `data/applications.md` and surfaces the current pipeline.

> Notion is the system of record. This mode also queries the Notion Applications DB (see `modes/notion-tracker.md`) for live status and reconciles it against the local cache. When in conflict, Notion wins and `applications.md` is updated to match.

## Format of `data/applications.md` (local cache)

```markdown
| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
```

## Canonical states (`templates/states.yml`)

`Evaluated` → `Applied` → `Responded` → `Interview` → `Offer` / `Rejected` / `Discarded` / `SKIP`

- `Evaluated` — report completed, pending decision
- `Applied` — application sent (Notion Stage 4)
- `Responded` — company replied (Notion Stages 5+ if interview process started)
- `Interview` — in active interview process
- `Offer` — offer received
- `Rejected` — rejected by company
- `Discarded` — withdrawn by the user or posting closed (Notion `Withdrew`)
- `SKIP` — doesn't fit, don't apply (Notion `Not pursuing`, set automatically when Match score < 70)

If the user asks to update a status, edit the corresponding row in both Notion (via `notion-update-page`) and `applications.md`. Notion first.

## Surface stats (every run)

- **Volume:** total applications, by state, applied this week, applied this month
- **Quality:** average Match score (Notion field), average Recruiter-sim verdict distribution (INVITE / MAYBE / REJECT %)
- **Coverage:** % of rows with PDF generated, % with report generated, % with Notion row
- **Pace vs target:** applied/day for the last 7 days, vs the 29/day target (≥200/week). Flag if pace < 25/day for 2+ consecutive days (the pace alarm — see `scripts/metrics/pace-alarm.mjs`).
- **Tier-1 distribution:** how many of the active pipeline are at tier-1 companies (the tier-1 targets in `portals.yml`)
- **Funnel:** Discovered → Triaged → Drafted → Applied → Interview → Offer (counts and conversion rates)

## Per-row drill-down (on request)

If the user asks about a specific row (e.g. "where am I with Zalando AE?"):

1. Look up by `Job URL` in Notion via `notion-search`.
2. Surface: current Stage, Apply date, Next action + Next action date, Recruiter name + contact, Resume + Cover Letter file URLs, the full Fit notes.
3. If a report exists in `reports/`, link to it.

## Reconciliation

On every `/applyd tracker` run:

1. Fetch all Notion rows updated since the last reconciliation timestamp.
2. Compare to `applications.md` rows on `Company + Role` (or `Job URL` if present in cache).
3. For drifts (e.g. `applications.md` says `Evaluated` but Notion says `Applied`), update `applications.md` to match Notion. Surface the drift count.
4. Save reconciliation timestamp.

## Closing line (REQUIRED)

End the tracker output with a one-line "next move" suggestion, e.g.:

- "5 drafts await your review in Notion. Top by Match score: Personio AE (87), GetYourGuide DE (84), Trade Republic DS (81)."
- "Pace alarm: 18/day for the last 2 days vs 29 target. Want me to broaden the role-family filter on the next scan?"
- "All caught up. Next scan scheduled for tomorrow 07:00 UK."
