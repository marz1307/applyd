# Mode: pdf — ATS-Optimised PDF Generation

Generates a tailored PDF CV per JD. Reads `cv.md` and the candidate's profile, applies an archetype-driven tailoring pattern, and renders to a single-column A4 PDF.

---

## Sources of truth

| Source | Used for |
|--------|----------|
| `cv.md` (project root) | Canonical CV. The user maintains this. |
| `article-digest.md` | Deeper proof points beyond the one-page CV. Read when a JD signal calls for a project not on `cv.md`. |
| `config/profile.yml` | Identity, contact, target roles, comp, language preferences, file output conventions. |
| `modes/_profile.md` | Archetypes, adaptive framing, tailoring pattern, locked profile opener, output filename conventions. **Read first.** |
| `writing-samples/WRITING_STYLE.md` | Writing voice — no em dashes, first person, action verbs, no buzzwords. |
| `templates/cv-template.html` | HTML template — single-column, ATS-clean. |

**HARD RULES:**
- **NEVER** invent skills the candidate does not have.
- **NEVER** write to `cv.md` — it is canonical, read-only from this mode.
- **NEVER** alter the locked profile opener (the identity line from `_profile.md`).
- **NEVER** disclose anonymised client names, schema, or confidential figures (see `_profile.md` → "Confidentiality Calibration" if defined).

---

## Full pipeline

### Step 1 — Read sources

1. Read `modes/_profile.md` for archetype-detection rules, adaptive framing, output conventions.
2. Read `config/profile.yml` for identity and contact.
3. Read `cv.md`.
4. Read `article-digest.md` for additional proof points.

### Step 2 — Detect JD language

Default: English. If the JD is in a non-English language and the user has set `language.modes_dir` in `config/profile.yml`, follow that override. Otherwise generate the CV in English.

**Paper format is ALWAYS A4** unless the user's `config/profile.yml → cv.paper_size` says otherwise.

**Page count is ALWAYS ≤ 2 pages** — golden rule (see `_profile.md → CV length`). The generator enforces this and exits non-zero if the rendered PDF exceeds 2 pages. If that fires: tighten content (drop the oldest role, merge older experience into a one-liner, trim Projects, drop optional Certifications) and regenerate.

### Step 3 — Detect archetype

Classify the JD into one of the user's archetypes (see `_profile.md` → "Your Target Roles"). If hybrid, name the two closest. The archetype drives the tailoring pattern in Step 5.

### Step 4 — Extract JD keywords and check seniority

1. Extract 15–20 keywords from the JD (tools, methodologies, domain, soft skills).
2. **Check seniority band.** Read `_profile.md` → "Seniority band". If the JD's seniority is outside the user's band:
   - Cap the global match expectation.
   - Surface the seniority mismatch as the first red flag in the cover letter / outreach.
   - Do NOT inflate the CV to chase the title.

### Step 5 — Tailor

Match the tailoring pattern defined in `_profile.md → Your Adaptive Framing`. Typically only the **profile opener** and the **skills section order** change between variants; experience bullets, projects, and education stay identical across variants.

### Step 6 — Inject JD keywords ethically

Reword real experience using the JD's exact vocabulary. **NEVER add skills the user does not have.** Every claim must be defensible in a 45-minute interview.

### Step 7 — Build the competency grid

6–8 phrases drawn directly from the JD's must-haves and the user's actual stack.

### Step 8 — Reorder experience bullets

Keep the same bullets. Reorder so the most JD-relevant bullet appears first in each role.

### Step 9 — Apply writing-style discipline

Read `modes/_profile.md` → "Writing Style". HARD rules:

- **No em dashes.** Use commas, colons, parentheses, or full stops.
- **No exclamation marks. No emojis.**
- **Consistent spelling**: pick British or American per `profile.yml` and stay consistent.
- **First person** in the profile paragraph.
- **Action verbs**: built, designed, engineered, owned, connected, delivered, rebuilt, cleaned, automated, orchestrated, shipped. Never "responsible for" or "involved in".
- **Numbers as words** in narrative prose. **Digits** in CV bullets, skill lists, and project tags.
- **No buzzwords**: drop *passionate, results-driven, leverage, synergy, robust* (without specifics), *cutting-edge, innovative, AI* (as a standalone noun — name the model instead).

### Step 10 — Generate HTML

1. Read `templates/cv-template.html`.
2. Substitute placeholders (see table below).
3. Write to `/tmp/{CandidateName}_CV_{CompanySlug}_{YYYY-MM-DD}.html`.

### Step 11 — Render to PDF

```bash
node scripts/cv/generate-pdf.mjs \
  /tmp/{CandidateName}_CV_{CompanySlug}_{YYYY-MM-DD}.html \
  output/{CandidateName}_CV_{CompanySlug}_{YYYY-MM-DD}.pdf \
  --format=a4
```

When rendering via `scripts/cv/generate-pdf-tailored.mjs`, `--role-title "<title>"` overrides the CV tagline for that render only (never edits `cv.md`) — handy when a JD's title differs from your default headline.

### Step 11b — Optional: LLM QA pass

If an agent CLI is available on `PATH` (default: `claude`; override via env — see `scripts/cv/cv-qa.mjs`), QA the rendered CV before accepting it. Under Claude Code it runs on the Claude subscription via `claude -p` (no API key); under other agents it uses the CLI you point it at:

```bash
node scripts/cv/cv-qa.mjs --cv <cv.html> --jd-file <jd.txt> --company "<name>" --role-title "<title>"
```

Exit 0 = pass, 2 = auto-patched, 3 = needs manual work. If no CLI is available it prints a notice and skips (exit 0), and the Step 5 self-audit against `cv-quality-rules.md` remains the fallback.

### Step 12 — Report

Output JSON to stdout:

```json
{
  "status": "ok",
  "pdf_path": "output/{CandidateName}_CV_{CompanySlug}_{YYYY-MM-DD}.pdf",
  "pages": 1,
  "keyword_coverage_pct": 87,
  "archetype": "<detected archetype>",
  "tailoring_variant": "<variant>",
  "source_cv": "cv.md",
  "warnings": []
}
```

### Step 13 — Post-generation tracker write

Update `data/applications.md` — change the PDF column from `❌` to `✅` for the relevant row. If Notion integration is wired, also attach the generated PDF to the matching Notion row (`Resume` file field) and transition stage to `3. Drafted`.

---

## ATS rules (clean parsing)

- Single-column layout, no sidebars, no parallel columns.
- Standard section headers: "Professional Summary", "Work Experience", "Education", "Skills", "Certifications", "Projects".
- No text inside images or SVGs.
- No critical info in PDF headers or footers (ATS ignores them).
- UTF-8, selectable text (not rasterised).
- No nested tables.
- Keywords distributed: profile (top 5), first bullet of each role, skills section.

## PDF design

- **Fonts:** Space Grotesk (headings, 600–700) + DM Sans (body, 400–500). Self-hosted in `fonts/`.
- **Header:** name in Space Grotesk 24px bold + a 2px accent line + contact row (location, phone, email, LinkedIn, GitHub, portfolio).
- **Section headers:** Space Grotesk 13px, uppercase, letter-spacing 0.05em.
- **Body:** DM Sans 11px, line-height 1.5.
- **Margins:** 0.6in (A4).
- **Background:** pure white.

## Template placeholders

| Placeholder | Content |
|-------------|---------|
| `{{LANG}}` | `en` by default |
| `{{PAGE_WIDTH}}` | `210mm` — A4 |
| `{{NAME}}` | from `profile.yml.candidate.full_name` |
| `{{PHONE}}` | from `profile.yml.candidate.phone` |
| `{{EMAIL}}` | from `profile.yml.candidate.email` |
| `{{LINKEDIN_URL}}` | from `profile.yml.candidate.linkedin` |
| `{{PORTFOLIO_URL}}` | from `profile.yml.candidate.portfolio_url` |
| `{{LOCATION}}` | from `profile.yml.candidate.location` |
| `{{SECTION_SUMMARY}}` | Professional Summary |
| `{{SUMMARY_TEXT}}` | Tailored profile paragraph. Opens with the locked identity line from `_profile.md`. |
| `{{SECTION_COMPETENCIES}}` | Core Competencies |
| `{{COMPETENCIES}}` | `<span class="competency-tag">keyword</span>` × 6–8 |
| `{{SECTION_EXPERIENCE}}` | Work Experience |
| `{{EXPERIENCE}}` | HTML for each role with bullets reordered per JD relevance |
| `{{SECTION_PROJECTS}}` | Projects |
| `{{PROJECTS}}` | HTML for top 3–4 projects |
| `{{SECTION_EDUCATION}}` | Education |
| `{{EDUCATION}}` | Education HTML |
| `{{SECTION_CERTIFICATIONS}}` | Certifications |
| `{{CERTIFICATIONS}}` | Certifications HTML |
| `{{SECTION_SKILLS}}` | Technical Skills |
| `{{SKILLS}}` | Skills HTML — reordered per tailoring variant |
| `{{SECTION_LANGUAGES}}` | Languages |
| `{{LANGUAGES}}` | from `profile.yml.candidate.languages` |
| `{{SECTION_COMMUNITY}}` | Community & Leadership |
| `{{COMMUNITY}}` | Community / leadership entries |

## Cover-letter generation (when the form allows one)

Include a cover letter if the application form has the field. Rules:

- 1 page max.
- Same visual design as the CV.
- **Opening line**: the locked identity line, then a one-sentence bridge to the JD's domain.
- **Three body paragraphs**: (1) two specific JD requirements mapped to specific proof points from `cv.md` or `article-digest.md`, (2) a sentence on why this company specifically — research the company first, (3) the exit narrative re-framed against the role.
- **Closing**: one line, no "I look forward to hearing from you" boilerplate.
- **Salutation**: "Dear [Name]" if named, "Dear Hiring Team" otherwise.
- **Sign-off**: "Best regards, {CandidateName}".

Output path: `output/{CandidateName}_Cover_Letter_{CompanySlug}_{YYYY-MM-DD}.pdf`.

## Post-generation report

After the PDF (and optional cover letter) is generated, surface to the user:

- Path to the PDF (and cover letter, if generated).
- Page count.
- Keyword coverage % (15–20 keywords from JD, count matches in the rendered text).
- Archetype detected.
- Tailoring variant applied.
- Any warnings: missing JD context, low keyword coverage, seniority mismatch, etc.
