# Mode: contacto — LinkedIn Outreach

Generate targeted outreach messages to recruiters, hiring managers, and peers at companies in the user's active pipeline. When Notion is wired up, write every message to a Referral & Outreach DB and link it to the related Applications row.

> If Notion integration is enabled, **READ `modes/notion-tracker.md` FIRST** for the Referral & Outreach DB schema and the note-template enum.

## Workflow

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
