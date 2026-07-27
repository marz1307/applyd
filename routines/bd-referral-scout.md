# Routine: bd-referral-scout (PURE-SCRIPT ROUTINE)

> Reference documentation only. This routine is a **pure Node script**
> (`bd-referral-scout.mjs`), NOT a headless-agent-CLI prompt. `run-routine.ps1`
> invokes the script directly (no LLM, no subscription/API cost beyond Bright Data).

## What it does

Layer 3 of the referral system — Bright Data **cold PUBLIC-profile discovery**.
For Stage-3 (`3. Drafted`) rows that `referral-scout` flagged with no warm path,
it runs up to 3 SERP queries per company (affiliation / hiring-manager /
recruiter) through a Bright Data unblocker zone, extracts public
`linkedin.com/in` URLs, classifies them, and writes LEADS to the **Referral &
Outreach** database (`Outreach status = Not contacted`, linked to the
Applications row).

Public data only. NO logged-in LinkedIn, NO connection graph, NEVER messages.
(The logged-in-LinkedIn 2nd-degree pull stays Cowork-side — see
`modes/contacto.md` Step 0.)

## Schedule

Weekly — Monday 13:30 UK (`CareerOps_BdReferralScout`).

## Config

`config/profile.yml → referral_scout` (SERP zone, caps, `target_titles`). The
query titles default to `referral_scout.target_titles`, falling back to the three
core archetypes (Data Engineer, Analytics Engineer, Data Scientist) — a small set
by design, since SERP queries must stay compact (do NOT expand to the full
role-taxonomy list).

## Requires

`BRIGHTDATA_API_KEY`. Caps come from `config/profile.yml`.

## Invocation

```
node scripts/scan/bd-referral-scout.mjs          # live
node scripts/scan/bd-referral-scout.mjs --dry-run
```
Run via the wrapper: `pwsh routines/run-routine.ps1 -Routine bd-referral-scout`.
