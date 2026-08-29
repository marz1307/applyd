# Mode: referral — name real humans, draft the outreach

```
pick targets → search LinkedIn logged-in → verify employer → write to Notion → draft note + follow-up → STOP
```

**Trigger.** The user says `/referral`, says "referral", "referrals", "find
contacts", "find people at", "who can refer me", "warm path", or asks for
outreach to a named company. Argument (optional): a company name — omit to
sweep every Stage-3 row with no contact.

**Never send anything.** No connection request, no message, no InMail. This
mode drafts and records; the operator sends. Same wall as `apply`.

## Why this mode exists

The automated referral paths in this repo do NOT reliably name humans.
`referral-scout` (Layer 1) writes a *search URL* and names nobody, and
`bd-referral-scout.mjs` (Layer 3) has repeatedly returned empty selections and
returns Google-SERP hits with names reverse-engineered from URL slugs and no
connection degree at all — it never logs in. This mode makes the one method
that scales — an agent driving a browser MCP against a logged-in LinkedIn —
repeatable.

It cannot be scheduled. It needs a logged-in browser, and a strict-MCP-config
headless CLI cannot see the browser connector. It is a prompt task.

## Step 1 — Pick the targets — STAGE 3 ONLY

**This mode operates on `3. Drafted` and nothing else.** Not Stage 1, not
Stage 2, not Stage 4+, not a terminal. If asked for a company whose row is not
at Stage 3, say so and stop rather than working it. Stage-4+ chases through a
named contact belong to the `chase` mode.

The reason is that Stage 3 is the only place outreach changes an outcome. A
Stage-3 row is drafted and **unsent**, so a named contact can still shape
whether and how it goes out. At Stage 4+ the letter has already gone. Below
Stage 3 there is no application to talk about yet.

**Called with no argument, target every Stage-3 row that has no contact yet** —
the whole gap, not a sample. Work highest Match score first. With a company
name, do that company only, after checking it is at Stage 3.

```bash
node scripts/notion/notion-query.mjs --stage "3. Drafted" --json > data/.routine-tmp/s3.json
```

Then exclude applications already represented in the Referral & Outreach DB
(`notion.referral_database_id` in `config/profile.yml`). **Match on the
`Linked application` relation, NOT on the `Company` name string.** The relation
is ground truth; the name is not — Step 2 frequently corrects it, and
name-matching puts the corrected row straight back in the queue and duplicates
its contacts.

```js
const linked = new Set();
for (const p of contacts)
  for (const rel of (p.properties['Linked application']?.relation || [])) linked.add(rel.id);
const remaining = stage3Rows.filter(r => !linked.has(r.id));
```

**Idempotent by design:** running the mode twice must not produce duplicate
people, so it is safe to re-run after a partial pass and picks up only what is
still empty.

## Step 2 — VERIFY THE EMPLOYER before searching

Do this first, every time. The tracker's `Company` field is our tag, not the
employer's legal name, and it can be wrong.

- Open the row's `job_url` and read who the posting says it is.
- Cross-check against the row's `location`. That is the cheapest tell.

Two failure modes worth naming.

- **Wrong operating entity.** A tag that names a holding company or a group
  brand can be matched to the wrong subsidiary — different industry, different
  city, hundreds of km apart. Contacts drafted against the wrong entity have
  to be deleted, and any message that goes out reads as noise.
- **Right function, wrong employer.** A search result whose headline names a
  peer employer (both UK law firms, both German pharma holdings) can look
  right for degree, function and seniority and still be at the wrong company.
  **Open the profile; a search result is not a verification.**

**Never trust a headless liveness check on bot-walled portals.** Some job
boards (notably eFinancialCareers) return a false "expired" to non-browser
fetchers. Killing a "confirmed dead" row without checking it in the logged-in
browser has thrown away live applications. Trust only an explicit HTTP 410 or
a "no longer accepting" string.

## Step 3 — Find the people — LINKEDIN ONLY

**People always come from LinkedIn, whatever portal the JD is on.** A row
discovered on Indeed, Xing, Stepstone, eFinancialCareers or WTTJ is still
scouted on LinkedIn and nowhere else. Xing shows no connection degree and no
mutuals, which are the two fields that make a contact worth having, and the
other portals have no people graph at all. The JD's portal decides only where
Step 2 verifies the posting — never where the people come from.

Practical consequence for Xing-sourced rows: the Xing job page is
login-walled and often will not render for verification. Verify those from
the LinkedIn company page plus the row's location instead, and say in the
report that the posting itself could not be read.

Full procedure and its traps: **`modes/contacto.md` → Step 0b**. That file is
authoritative; do not restate the technique here, follow it. In short:

1. Quoted people-search first, `spellCorrectionEnabled=false`.
2. Read results with a page-text tool. A page-scripting tool also works and
   gives you profile URLs in one call — just never RETURN `location.href` or
   anything else carrying the query string, which is refused as
   `[BLOCKED: Cookie/query string data]`.
3. Company People tab to widen. Plain page-text returns only the header
   there — use the scripting snippet, which does work on that tab (names and
   degrees, no headlines, plus some page followers to discard).
4. If the tab shows no directory at all, open ONE confirmed employee and mine
   the **"More profiles for you"** sidebar — in practice this often produces
   the largest yield.
5. Confirm each employer from the person's own headline or profile.
6. Never trust the "People you may know" panel.

### Search method — plain keyword search is the WEAKEST option

**A bare keyword search matches profile TEXT, not employers.** Searching a
company name and a bare skill together returns people at unrelated employers
whose profiles happen to name the skill. Every one of those becomes a message
to a stranger about a job they have no connection to.

In order of reliability:

1. **Company People tab** — `/company/{slug}/people/`. It is
   employer-filtered, so a hit is *evidence of employment*. This is the default.
   - **NEVER append `?keywords=`.** It does not search headlines and silently
     hides the people you want. Read the bare tab and filter by eye.
   - **Look the slug up**; guessing lands on `/company/unavailable/` and
     returns an empty list that looks exactly like "nobody works here". Find
     it with `/search/results/companies/?keywords=X` and read the
     `/company/{slug}` href.
   - **Universities use `/school/{slug}/`** — but that tab lists **alumni,
     not staff**, so it is useless for reaching a hiring team.
   - A small firm or agency often has a real page with **no employee
     directory**. That is not evidence nobody works there; go to the SERP
     fallback.
2. **Quoted exact company name in people search**, then keep only profiles
   whose own headline says "at X" / "bei X". This surfaces 1st-degree
   contacts other passes miss.
3. **SERP fallback — `node scripts/scan/bd-referral-scout.mjs --dry --test-company "X"`.**
   The Google-style meta search. It reaches profiles LinkedIn's own UI will
   not show. **It returns unverified URLs classified from search snippets, so
   it generates LEADS, never rows.** Verify every one on LinkedIn before
   logging.

**Always filter to 1st and 2nd degree first** (`network=["F","S"]`). A
1st-degree contact needs no invite, no acceptance and no 300-char note.

**"No one found" is a claim that needs all three methods tried.** In real
runs, most rows recorded as empty had actually not been searched thoroughly.

### Agencies are NOT a dead end

A consultant at a recruitment agency can refer you *internally* — they pass
you to the colleague running that vacancy. That is a genuine referral route.
Scout agencies like any other employer, target a consultant, and make it an
explicit routing question: **who is running that vacancy?** Do not pretend the
consultant you found is the one hiring.

Target 3–5 people per company, ranked:

| Rank | Who | Why |
|---|---|---|
| 1 | Hiring manager for the function (Head of Data, Analytics Manager) | Closest to the decision |
| 2 | Peer on the team (Analytics Engineer, Data Engineer, Data Scientist) | Highest reply rate, no gatekeeping |
| 3 | In-house recruiter / talent partner | Can route, cannot vouch |

**Record connection degree and the named mutual** ("2nd, via {mutual name}").
It is only visible logged-in, and it is the field nothing else can supply. A
2nd-degree peer beats a 3rd-degree manager.

## Step 3b — The hiring manager and the recruiter

**Check the JD for a named contact, but do not expect one.** A named
`Ansprechpartner` is a DACH convention and even there only a small minority
of adverts carry one; UK adverts almost never name anyone. LinkedIn's "Meet
the hiring team" block renders only if the poster opts in. Company research
JSON typically has no person field at all.

So: grep the JD and the letter's `facts_used` block for `Ansprechpartner` /
`contact` / a named person. If you find one, search LinkedIn for the name
**plus the employer** and only log it if their headline names that employer.
A name with no employer confirmation is left unlogged rather than guessed.

**Otherwise the hiring manager is inferred, not extracted** — the function
owner by title (Head of Data, Analytics Manager, Team Lead Data), confirmed
from their own headline. That is Step 3 and it already works.

Log recruiters and JD-named contacts to the same DB, with `NAMED IN THE JD`
in the Role field so nobody mistakes an HR contact for the hiring line.

### Register for a recruiter or HR contact — invert the pitch

**Lead with availability and right to work, not enthusiasm.** That is the
information they are paid to collect, and supplying it unprompted reads as
competence rather than need.

**Desperation is not a tone, it is six specific signals.** Avoid each by name:

1. Repeating the ask — one ask, then stop. This is the clearest marker of all.
2. A message that only extracts — offer a view or a question worth answering.
3. Needing the answer — "happy either way" also lowers refusal cost, which
   per Bohns raises reply rather than lowering it.
4. Status disclaimers — never "I know you're busy", "sorry to bother",
   "grateful for any chance". They announce low status and nothing else.
5. Unprompted credentials — they have the CV. Re-pitching it reads as anxiety.
6. Generic questions — ask what only an insider would think to ask.

## Step 4 — Write them to Notion

One row per person in the Referral & Outreach DB, `Outreach status = Not
contacted`, linked to the Applications row via `Linked application`. Schema
and the `Note template` enum are in `modes/notion-tracker.md`.

**Only write people whose employer you confirmed in Step 3.4.** A row you are
unsure of is worse than no row — it becomes a message to a stranger about a
job they have no connection to. If a person is plausible but unconfirmed, say
so in the report and leave them out.

## Step 5 — Draft the messages

Two per person, per `modes/contacto.md` Step 3 templates:

- **Connection note** — under 300 characters, LinkedIn's hard limit.
- **After they accept** — the real message, sent only once connected.

Language follows the JD, not the country: German JD → German note. Use the
`Cold-DACH-DE` / `Warm-mutual-DE` templates for those.

**Voice rules, non-negotiable** (these are the same ones the cover letters
live under):

- Written for a person, not a data lead. **No model metrics, no test counts,
  no row counts.** Method and outcome, never the numbers.
- **Never name variables, column names, or app/vendor names** from
  NDA-covered work.
- Ask for a steer, not a referral, on first contact. The referral is the
  second conversation.

Write the drafts to `output/week0/` or a dated file alongside it, and put the
connection note in the row's `Note template` context so it travels with the
record.

## Step 6 — Report and stop

State per company: employer verified (and against what), people found with
degree, what was written to Notion, what was drafted, and **anything you
could not confirm**. Then stop. The operator sends.

Do not update `Outreach status` past `Not contacted` — that field tracks what
was actually sent, and moving it would fabricate outreach that never happened.

**When the operator confirms a note went out**, record it — this mode drafts,
but the send is only measurable if it is logged:

```bash
node scripts/outreach.mjs --mark "Person Name" --status "Note sent" --app APP-XXX --apply
node scripts/outreach.mjs --report          # sends, answers, referrals, and who owns whom
node scripts/outreach.mjs --due             # sent, unanswered, past the 7-weekday window
```

## Contacts with no application attached

The DB also holds **standalone contacts** — people worth knowing who are not
tied to one posting (user-group organisers, community connectors, past
colleagues).

Leave `Linked application` empty for these. They are deliberately outside
this mode's Stage-3 sweep, and `outreach.mjs --report` files them under *no
application* rather than flagging them as orphans. **Anyone met in person
belongs here** — the offline channel outperforms LinkedIn and is easy to
forget to record.
