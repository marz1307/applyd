# Mode: contacto — LinkedIn Outreach

Generate targeted outreach messages to recruiters, hiring managers, and peers at companies in the user's active pipeline. When Notion is wired up, write every message to a Referral & Outreach DB and link it to the related Applications row.

> If Notion integration is enabled, **READ `modes/notion-tracker.md` FIRST** for the Referral & Outreach DB schema and the note-template enum.

## Workflow

### Step 0b — NAMING a real person (the one method that reliably works)

**Read this before reaching for any cold scout.** Every automated path this repo
ships has produced named humans only intermittently: `referral-scout` (Layer 1)
writes a ranked warm angle and a *search URL* and names nobody, and
`bd-referral-scout.mjs` (Layer 3) returns Google-SERP hits with names
reverse-engineered from URL slugs and **no connection degree at all** because
it never logs in. Treat their output as leads to CHECK, never leads to write to.

The one method that scales is a Claude session driving a browser MCP against
the operator's own logged-in LinkedIn.

**The procedure, in order.**

**LinkedIn is the ONLY source for people, whatever portal the JD came from.**
A row found on Indeed, Xing, Stepstone, eFinancialCareers or WTTJ is still
scouted on LinkedIn. Xing exposes no connection degree and no mutuals — the two
fields that make a contact worth having and that nothing else can supply — and
the rest have no people graph at all. The JD's portal decides only where the
employer gets verified, never where the people come from.

1. **Quoted people-search first.** It needs no company slug, and the quotes
   stop LinkedIn matching the words separately:
   ```
   linkedin.com/search/results/people/?keywords="Company Name" analytics engineer&spellCorrectionEnabled=false
   ```
   `spellCorrectionEnabled=false` is load-bearing: without it LinkedIn silently
   autocorrects near-neighbour company names and returns unrelated profiles.
2. **Read the results with a page-text tool.** On a people-SEARCH results page
   it returns everything needed: name, degree, headline, location, and the
   "X is a mutual connection" line. This is the simplest reader — start here.

   **When you need profile URLs too**, a page-scripting tool works, but it is
   refused if the script RETURNS cookie or query-string data. Returning
   `location.href` on a search page trips it, because the URL carries the
   query. Reading hrefs and DOM text does not. Sketch:

   ```js
   [...new Set([...document.querySelectorAll('a[href*="/in/"]')].map(a => a.href.split('?')[0]))]
     .map(u => {
       let n = document.querySelector(`a[href^="${u}"]`);
       while (n && n.innerText.trim().length < 20 && n.parentElement) n = n.parentElement;
       return u.split('/in/')[1].replace(/\/$/,'') + ' :: ' +
         (n ? n.innerText.trim().split('\n').filter(Boolean).slice(0,3).join(' | ') : '');
     })
     .filter(s => /EMPLOYER NAME/i.test(s))
     .join('\n')
   ```

   The `.filter` is the useful part: it keeps only rows whose headline names
   the employer, so what comes back is already confirmed. It returns
   `slug :: Name | degree | headline`. **Caveat:** mutual-connection links are
   anchored on the same page, so a few rows come back reading "X & Y are
   mutual connections" instead of a headline. Those are the mutuals, not
   results — discard them.
3. **Company People tab** (`/company/{slug}/people/?keywords=data`) — use when
   the name is also a common word, or to widen beyond the first search page.
   - Slugs fail often. Find the slug via a **company** search
     (`/search/results/companies/?keywords=…`) and read the href.
   - **A plain page-text read returns only the header here**, no profile rows.
     Use the scripting snippet above instead. On this tab it returns names and
     degrees but NOT headlines, so it tells you who to look at, not who they
     work for. Confirm the employer from the search results or by opening the
     profile.
   - It also picks up page FOLLOWERS ("X follows this page"), who are not
     employees. Discard them.
4. **If the tab shows no directory at all** — only a "People you may know"
   panel — go to step 6. That happens on smaller company pages.
5. **When both fail, identify the employer from the ATS** on the job URL
   first, then search the real legal name.
6. **Best expansion path: open ONE confirmed employee's profile.** Its "More
   profiles for you" sidebar lists similar people, and their headlines usually
   name the employer. In practice this produces the largest yield after both
   the search and the People tab have run dry.
7. **Confirm the employer from the person's own headline or profile.** Do NOT
   trust the "People you may know" panel — it mixes in non-employees. A name
   that appears ONLY in that panel is unconfirmed until you open the profile
   and read the employer block.
8. **Record the degree and the mutual by name** ("2nd, via {mutual name}").
   Degree is only visible logged-in, and it is the single most valuable field
   here — it is what any headless scout can never supply.

**Verify the employer before writing a single message.** Tracker `Company`
fields are our tag, not the employer's legal name. A row tagged with a
holding-company name can be matched to the wrong operating entity — different
industry, different city — and every contact drafted against it becomes an
embarrassing message about the wrong job. The row's Location field is the
cheapest tell; the posting body is the proof.

**This cannot run headless.** It needs a logged-in browser, so it is a
prompt/interactive task and must never be scheduled under a strict-MCP-config
headless CLI, which cannot see the browser connector.

### Step 1 — Identify the target

Via web search + LinkedIn browsing:

- **Recruiter** — talent acquisition, sourcing, recruiting role at the company.
- **Hiring Manager** — the person who leads the hiring team (look for the JD's "reports to" line, then LinkedIn for their profile).
- **Peer** — someone with a similar role in the team (indirect referral / soft introduction).
- **Interviewer** — someone the user already has a scheduled round with.

Surface 1 primary + 2 alternates.

### Step 2 — Classify and select the note template

| Template | When to use |
|----------|-------------|
| `Cold-EN` | First-time outreach in English. |
| `Warm-mutual-EN` | Recipient and the user share a mutual connection. |
| `Recruiter-inbound` | The user is REPLYING to a recruiter who reached out first. |

If the user has localised templates for non-English markets (e.g. `Cold-DE`, `Cold-FR`), use them when the recipient or JD is in that language.

### Step 3 — Generate the message

Apply the user's writing-style discipline from `modes/_profile.md → Writing Style`: no em dashes, first person, action verbs, no buzzwords.

#### Recruiter (cold)

3 sentences, max 300 characters (LinkedIn connection request limit):

1. **Fit:** direct match — role, relevant experience, availability, or location.
2. **Proof:** one data point that answers their screening filter before they ask.
3. **CTA:** "Happy to share my CV if this aligns with what you're hiring for."

#### Hiring Manager (cold)

1. **Hook:** specific challenge their team is facing (from the JD, company blog, recent news, or product release).
2. **Proof:** the user's most quantifiable achievement solving a similar problem (pull from `cv.md` + `article-digest.md` — never invent).
3. **CTA:** "Would love to hear how your team is approaching {specific challenge}." (Curiosity, not pitch.)

#### Peer (cold)

1. **Interest:** genuine reference to their work — blog post, talk, OSS project, conference paper. Specific, not generic.
2. **Connection:** something the user is doing in the same space (NOT a job pitch).
3. **CTA:** "I've been working on similar problems at {the user's context}, would love your take on {topic}."

**Rule:** Do NOT ask for a referral or a job in the first message. The referral happens naturally if the conversation flows. If the user must ask, do it in the third or fourth message after the relationship is real.

#### Interviewer (pre-interview)

1. **Research:** reference to something specific from their published work or trajectory.
2. **Context:** light connection to the user's experience in that area.
3. **CTA:** "Looking forward to our conversation on {date}."

Light tone. Not desperate.

#### Recruiter-inbound (REPLYING to recruiter outreach)

1. **Reciprocate:** thank them for reaching out, surface a specific detail from the JD or their message that interested the user.
2. **Fit confirmation:** 1 sentence confirming the match on the points they led with (location, role, language, availability).
3. **Propose the call:** "I can do {two specific time slots in their timezone}. What works on your side?"

### Status lifecycle

| Status | When |
|--------|------|
| `Not contacted` | Row created, draft on file, message not yet sent. |
| `Note sent` | The user confirmed the message went out. |
| `Replied` | Recipient responded. |
| `Referral confirmed` | Recipient confirmed they'll refer / introduce. |
| `Declined` | Recipient explicitly declined. |
| `No response` | Past the 7-weekday follow-up window with no reply. |

### Step 4 — Persist the outreach

If Notion is wired, create a row in the Referral & Outreach DB with the contact's name, company, role, LinkedIn URL, outreach status, note template, country, date, and a relation to the matching row in the Applications DB. Otherwise log it locally — track the same fields in `data/outreach.md` (TSV table).

Surface the drafted message to the user with two choices:
- **Send now** → the user copies and sends, then comes back and says "sent" → update status to `Note sent`.
- **Edit first** → present the message in chat, let the user edit, then write the edited version + update status once it goes out.

### Step 5 — Track conversion (informational, per `tracker.md`)

The `tracker.md` mode surfaces outreach conversion stats:

- Notes sent this week.
- Reply rate per note template.
- Reply rate per country.
- Outreach-to-application conversion.
- Stale unanswered: rows still on `Note sent` with date older than 7 weekdays — the user decides whether to send one follow-up.

## Message rules (universal)

- **Maximum 300 characters** for first-touch LinkedIn connection requests. For follow-up DMs after connection is accepted, stay under 1000 characters.
- **No corporate-speak.** No "passionate about", "robust solutions", "synergies", "leveraging".
- **No exclamation marks.** No emojis in outreach DMs.
- **First person, active verbs.** "I shipped", "I built", "I owned" — never "I have been responsible for delivering".
- **NEVER share phone number.** Email + LinkedIn only. Phone gets shared after a phone-screen is scheduled.
- **The contact type changes the EMPHASIS, not the structure.** All templates are 3-sentence hook-proof-CTA.

## Localisation

When writing to recipients whose primary language is not English:

- Match the local register (formal vs informal). Some markets default to formal address (titles + surnames) until invited to switch.
- Preserve English tech-stack names (dbt, Dagster, Snowflake) — translating them reads as amateurish.
- Never claim more proficiency in the recipient's language than the user actually has. If the user can't reply at depth, switch to English with a one-line acknowledgement.

## What NOT to do

- Never send the same message to multiple recipients at the same company (recruiters compare notes — this reads as spam).
- Never ask for a referral in the first message to a peer.
- Never lead with "I'm passionate about" or "I'm excited about the opportunity to" — instant filter for any senior recruiter.
