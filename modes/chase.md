# Mode: chase — ask what happened, through a person

```
pick the silent → pick the right human → one status message → log it → STOP
```

**Trigger.** The user says `/chase`, says "chase", "follow up on
applications", "nobody has replied", "silent applications", "overdue
follow-ups", or names a company whose application was already sent. Argument
(optional): a company name — omit to work the whole silent queue, longest
first. **Skip for applications less than 7 days old.**

**Never send anything.** Drafts and records; the operator sends. Same wall as
`apply` and `referral`.

## Why this exists separately from `referral`

`referral` is Stage-3 only: the application is drafted and unsent, so a
contact can still change whether and how it goes out.

**This is the other half.** Contacts built to chase already-sent applications
have an apply date *before* their contact-created date, so they exist to
chase, not to refer. When `referral` is Stage-3-only they are orphaned:
correctly excluded there, and included nowhere else. This mode owns them.

It also attacks the oldest open problem in the funnel: **applications overdue
for a chase with no follow-up ever recorded.**

## Step 1 — Build the queue — STAGE 4+ ONLY

Eligible: stage is `4. Applied` or later, **no response date**, apply date at
least **7 days** ago (`followup-cadence.mjs`'s `applied_first`). Longest
silent first.

```bash
node scripts/metrics/followup-cadence.mjs --summary --overdue-only
```

Cross-reference the Referral & Outreach DB for contacts already linked to
those rows. **A row with a named contact chases through the person. A row
without one is not this mode's problem** — it goes to the ordinary email
follow-up.

**Never chase a row with a response date.** That conversation is live and
belongs to the response tracker, not here.

## Step 2 — Pick ONE person, and prefer the recruiter

Opposite of `referral`'s ranking. A status question is administrative, and
the person who can answer it in one line is:

| Rank | Who | Why |
|---|---|---|
| 1 | **In-house recruiter / talent partner** | Owns the pipeline, can see the status, answering costs them nothing |
| 2 | Hiring manager | Can answer, but you are spending a bigger favour on a smaller question |
| 3 | Peer | Cannot see the status. Only useful if you want a read on the team, not a chase |

**One person per application. Ever.** Chasing two people at one employer
about one application is the single clearest desperation signal there is.

## Step 3 — The register: closure, not hope

At 40+ days the honest position is that this has probably moved on. **Say
that.** It is the strongest available frame, because it costs the recipient
nothing to confirm and it makes a "no" useful rather than painful.

**The message must:**

- **State the fact plainly** — applied on {date}, for {role}. Not a plea, a
  date.
- **Ask one closed question** answerable in a word: *is it still moving?*
- **Make "no" explicitly valuable** — *"if it's gone, that's genuinely useful
  to know and I'll stop watching for it."* This is the Bohns escape hatch:
  written asks are the easiest to refuse, and a costless refusal produces
  more replies than a pressured one, not fewer.
- **Assume nothing was owed.** No "I haven't heard back", which reads as an
  accusation.

**The message must NOT:**

- **Re-pitch.** They have the CV. Restating it reads as anxiety and answers a
  question nobody asked.
- **Apologise for following up.** "Sorry to chase" concedes it was wrong to.
- **Repeat.** One chase per application, then stop, whatever the outcome.
- **Ask for a referral.** Wrong mode and wrong moment — the application is
  already in; a referral now is a different, larger favour.

Keep it to about 60–80 words. Length reads as need.

## Step 4 — Log it

**Only after the operator confirms the message actually went out.** Recording
a send that did not happen corrupts the one honest record of what left the
building.

```bash
node scripts/outreach.mjs --mark "Person Name" --status "Note sent" --app APP-XXX --apply
```

`outreach.mjs` enforces the state machine (you cannot record a reply before a
send), refuses ambiguous names rather than guessing, and stamps the send
date. Then add a `[chase {date}]` sentinel to the application's `Fit notes`.

**This is the part historical pipelines routinely miss.** When `Outreach
status` has one writer that only ever sets `Not contacted`, every contact
sits at `Not contacted` and nothing measures whether any of this works. A
chase that is not logged cannot be counted, and worse, cannot stop a second
chase going out later.

Check the state of play any time with `node scripts/outreach.mjs --report`,
and see which sent notes have gone unanswered past the window with
`node scripts/outreach.mjs --due`.

## Step 5 — Report and stop

Per application: who was chosen and why, days silent, the drafted message,
and what was logged. Then stop. The operator sends.

**If a chase gets no reply after ~10 days, that is the answer.** Move the row
to `Withdrew` rather than chasing again — the standing rule is that
`Withdrew` means nothing came of it, and a second chase buys nothing but
reputation.
