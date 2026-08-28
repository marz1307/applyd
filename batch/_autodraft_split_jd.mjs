#!/usr/bin/env node
// Split a Bright Data scrape_batch result file into per-application jd.txt files.
//
// The routine fetches JDs a few at a time through the BD MCP; the result lands
// as a JSON array of {status, value:{url, content}}. This maps each URL back
// to its application row and writes output/cv-drafts/{APPID}-{slug}/jd.txt
// with the portal's own chrome trimmed off. Chrome-stripping matters twice
// over:
//   - _autodraft_cv_run's looksGermanText() reads jd.txt; a German XING shell
//     around an English posting would flip the CV to a Lebenslauf.
//   - The cover-letter research layer has previously mistaken portal
//     furniture for company facts (a portal's "external DPO" landing block
//     landing on unrelated employers).
//
// Usage: node batch/_autodraft_split_jd.mjs <batch-result.json> [<batch-result.json> ...]
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DRAFTS = path.join(ROOT, 'output', 'cv-drafts');
const QUEUE = path.join(ROOT, 'data', '.routine-tmp', 'draft-queue-filtered.json');
const slugify = (s) => String(s || 'co').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// The queue is only needed for a live split; a --self-test invocation drives
// stripChrome() against inline fixtures and never touches it.
const rows = process.argv.includes('--self-test') || !fs.existsSync(QUEUE)
  ? []
  : JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
const byUrl = new Map(rows.map((r) => [String(r.job_url || '').trim(), r]));

// Cut everything before the first real JD heading and everything after the
// portal's footer furniture. Conservative: if a marker is not found the text
// is left alone rather than truncated to nothing.
// Bright Data returns ESCAPED markdown (`\*\*Key Responsibilities:`), so the
// converter's own `#` headings can be absent — these markers key off the
// portals' literal furniture text instead.
const CUTS = [
  { host: /linkedin\.com/i,
    // Body begins after the last sign-in/report block and ends at the
    // metadata footer. "Show more Show less" is LinkedIn's own truncation
    // control and sits at the end of the posting text.
    start: /\[Report this job\]\([^)]*\)\s*\n/gi,
    // LinkedIn repeats its sign-in modal above the posting; the LAST one is
    // the one immediately preceding the body.
    startLast: true,
    end: /\n(Show more\s+Show less|Seniority level|Referrals increase your chances)/i },
  // XING wraps the posting in a "Ähnliche Jobs" rail that appears BOTH above
  // and below the body. The rail above is why a naive first-match end marker
  // cuts to nothing — but XING does expose a stable section heading pair, so
  // the body can be isolated exactly as long as the end marker is sought
  // AFTER the start. Headings are locale-dependent: XING serves the German
  // shell to DE postings and the English one to AT/EN postings.
  { host: /xing\.com/i,
    start: /^##\s+(Über diesen Job|About this job)\s*$/m,
    // Salary panels / aggregator blocks / related-jobs rails are cut, not
    // merely tolerated: an aggregator can misstate the pay period ("per
    // month" instead of "per year") or type a permanent role as a summer job
    // — either of which a cover letter could faithfully repeat.
    end: /^##\s+(Gehalts-Prognose|Salary|Unternehmens-Details|Company details|Ähnliche Jobs|Similar jobs|Extra Informationen|Extra information|About the company|Über das Unternehmen)\s*$/m },
  { host: /stepstone\./i, prose: true },
  // eFC wraps the posting in nav + a related-jobs rail + full footer. The
  // rail lists OTHER postings' titles; the footer is bilingual site chrome.
  // The rail has NO heading above it on some layouts — the cards themselves
  // are the reliable anchor: a bare `Apply now` line, then markdown links to
  // other /jobs- URLs on the same host. A posting body never links to
  // another eFC advert, so the first such link ends the body.
  { host: /efinancialcareers\./i,
    start: /^#\s+\S.*$/m,
    end: /^(?:(?:##\s+(?:Treiben Sie Ihre Karriere voran|Boost your career)|Weitere Jobs von diesem Unternehmen|More jobs from (?:this|the) (?:company|employer)|Ähnliche Jobangebote|Similar jobs|Apply now)\s*$|\[[^\]]+\]\(https?:\/\/[^)\s]*efinancialcareers\.[^)\s]*\/jobs-)/m },
  // Bright Network's "Apply now / Save" pair is rendered client-side and is
  // absent from the scrape, so a marker-based start never fires and cookie
  // banner + nav menus survive into the JD. The posting's H1 is the first
  // `# ` on the page — the site title above it is plain text, not a heading.
  { host: /brightnetwork\.co\.uk/i,
    start: /^#\s+\S.*$/m,
    end: /^###\s+(Related Jobs|Similar opportunities|You might also like)\s*$/m },
];

// Shape-based body extraction, for portals whose rail cannot be cut by markers.
// A job-ad sentence is long and punctuated; a similar-jobs card is a short
// line or a bare markdown link. Keeping only prose blocks drops the rail, the
// nav and the footer in one pass without needing to know the portal's DOM.
function extractProse(t) {
  return t
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => {
      if (b.length < 90) return false;
      if (!/[.!?:]/.test(b)) return false;
      const linkChars = (b.match(/[[\]()]/g) || []).length;
      if (linkChars > b.length / 12) return false;      // link-card rubble
      if (/^\[[^\]]*\]\(/.test(b)) return false;        // starts as a link
      if (/€|EUR\s*\d|weitere$/m.test(b) && b.length < 200) return false;
      // Related-jobs cards can be image blocks and orphaned link tails that
      // clear the 90-char floor and contain `.` and `:` from the URL. Measure
      // what is left once link, image and bare-URL syntax is removed: a real
      // paragraph still reads as a sentence, a rail card collapses to nothing.
      const residue = b
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')  // images
        .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')   // links
        .replace(/\]\([^)]*\)/g, ' ')           // orphaned link tails
        .replace(/https?:\/\/\S+/g, ' ')        // bare urls
        .replace(/\s+/g, ' ')
        .trim();
      if (residue.length < 60) return false;
      return true;
    })
    .join('\n\n');
}

// Firecrawl emits SETEXT headings (`Über diesen Job` underlined with `-----`)
// where Bright Data emitted ATX (`## Über diesen Job`). Every XING/eFC marker
// above anchors on `^##` / `^#`, so when the primary fetcher becomes Firecrawl,
// none of those cuts can fire. Normalising setext to ATX first makes the
// markers fetcher-independent instead of duplicating each one.
function setextToAtx(t) {
  return t.replace(
    /^(?![ \t]*(?:[#>*+-]|\d+\.)\s)([^\n]*\S[^\n]*)\n[ \t]*(={3,}|-{3,})[ \t]*$/gm,
    (_m, title, rule) => `${rule[0] === '=' ? '#' : '##'} ${title.trim()}`,
  );
}

function stripChrome(md, url) {
  let t = setextToAtx(String(md || '').replace(/\r\n/g, '\n'));
  const cut = CUTS.find((c) => c.host.test(url));
  if (cut && cut.prose) {
    t = t.replace(/\\([*_[\]()&#-])/g, '$1');
    return extractProse(t).replace(/\n{3,}/g, '\n\n').trim();
  }
  if (cut) {
    if (cut.start) {
      const re = new RegExp(cut.start.source, cut.start.flags.replace('g', '') + 'g');
      let at = -1, m;
      while ((m = re.exec(t))) {
        at = m.index + m[0].length;
        // Bright Network's "Apply now / Save" pair appears once above the
        // body and again beside the related-jobs rail; taking the last match
        // there would keep only the rail. Only LinkedIn wants the last
        // occurrence.
        if (!cut.startLast) break;
      }
      if (at > 0) t = t.slice(at);
    }
    if (cut.end) {
      const e = t.search(cut.end);
      if (e > 400) t = t.slice(0, e);
    }
    // LinkedIn sometimes renders its "Use AI to assess how you fit" upsell
    // BELOW the report-job link, so the start cut lands above three more
    // sign-in modals. Every one ends with the same consent sentence, and the
    // posting body follows the last of them.
    if (/linkedin\.com/i.test(url)) {
      const consent = /By clicking Continue to join or sign in[^\n]*\n/g;
      let at = -1, m;
      while ((m = consent.exec(t))) at = m.index + m[0].length;
      if (at > 0 && t.length - at > 600) t = t.slice(at);
    }
  }
  // Unescape BD's markdown escaping so keyword extraction and the enrichment
  // prompt see plain prose rather than `\*\*Key Responsibilities:`.
  t = t.replace(/\\([*_[\]()&#-])/g, '$1');
  // Drop pure-navigation lines: bare links, image placeholders, bracket rubble.
  t = t.split('\n').filter((l) => {
    const s = l.trim();
    if (!s) return true;
    if (/^[[\]()#*_\\-]{0,4}$/.test(s)) return false;
    if (/^\[?\]?\([^)]*\)[[\]]*$/.test(s)) return false;   // `](/companies)[`
    if (/^\[[^\]]*\]\([^)]*\)$/.test(s) && s.length < 80) return false; // lone short link
    // Image-only lines. XING's logo rail renders as hundreds of these, each
    // one long enough (signed imagecache URLs) to clear every length-based
    // filter.
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(s)) return false;
    if (/^\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)$/.test(s)) return false; // linked image
    return true;
  }).join('\n');
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

// An EXPIRED LinkedIn posting does not 404. LinkedIn serves the generic
// job-search shell instead, at full length and HTTP 200, so every size- and
// chrome-based guard passes. That shell can be 20-30k chars of unrelated
// cards with zero mentions of the employer or the role. Written to jd.txt it
// becomes the text the CV enrichment, the seniority detector and the cover
// letter are all tailored against. These strings belong to the search shell
// and never to a posting body.
const DEAD_SHELL = [
  /You've viewed all jobs for this search/i,
  /You’ve viewed all jobs for this search/i,
  /Where are the filters\?/i,
  /You're now using AI-powered job search/i,
  /You’re now using AI-powered job search/i,
  /No matching jobs found/i,
  /This job is no longer available/i,
  /Diese Stellenanzeige ist nicht mehr verfügbar/i,
];

function deadShell(clean) {
  if (String(clean).trim().length < 800) return 'under-800-chars';
  const hit = DEAD_SHELL.find((re) => re.test(clean));
  return hit ? hit.source : null;
}

// `node batch/_autodraft_split_jd.mjs --self-test` — guards the portal cuts.
// Worth having: the XING body can be silently reduced to the company blurb
// for weeks (every requirements bullet is a single line under the prose
// extractor's 90-char floor, while the signed-URL logo rail sails through
// it), and the failure looks exactly like a bot-wall from the outside.
if (process.argv.includes('--self-test')) {
  const XING_DE = [
    '![](https://www.xing.com/imagecache/public/scaled_original_image/eyJ1dWlkIjoiYzAzNGYzNDEtY2VmNC00YTM1LTk0MzUtM2Y4YTBmZGZjNTc2In0?signature=deadbeefcafe "acmedata GmbH")',
    '### Ähnliche Jobs', 'Oldenburg **\\+ 0 weitere**', '55.500 € – 71.500 €',
    '## Über diesen Job', '', '# Data Engineer (m/w/d)', '', '## Das sind wir', '',
    // Padded to a realistic length: the end cut is guarded by `e > 400` so it
    // can never truncate a body to nothing, and a toy fixture would skip that
    // path.
    'Die Beispiel Group ist ein international taetiges Unternehmen mit 2.000 Mitarbeitenden in ueber 30 Laendern.',
    'Erfolgreiche Entscheidungen basieren heute nicht nur auf Fachkompetenz, sondern auch auf Daten. Deshalb entwickeln',
    'wir unsere Data Plattform kontinuierlich weiter und schaffen die Basis fuer datengetriebenes Arbeiten im gesamten',
    'Unternehmen. Aktuell modernisieren wir die Plattform und etablieren Best Practices wie automatisierte',
    'Qualitaetssicherung und End-to-End-Verantwortung fuer unsere Datenprodukte.', '',
    '**Deine Aufgaben**', '', '*   Anbindung neuer Datenquellen', '*   Mitgestaltung von CI/CD', '',
    '## Das bringst du mit:', '', '*   Sichere SQL-Kenntnisse', '*   Erfahrung mit dbt', '',
    '## Gehalts-Prognose', '61.500 €', '## Ähnliche Jobs', '### Ganz anderer Job',
  ].join('\n');
  const XING_EN = XING_DE.replace('## Über diesen Job', '## About this job').replace('## Gehalts-Prognose', '## About the company');
  const BN = ['Cookies — it\'s your choice', '[Home](/)Find an opportunity', '# Junior Data Analyst 2026', '',
    'We are seeking a motivated Junior Data Analyst to join our team, ideal for a graduate or early-career candidate',
    'looking to build a career in data and analytics. The role holder will support the wider Data and Insight team by',
    'extracting and checking data and building straightforward reports under the guidance of senior colleagues. This is',
    'a supportive, learning-focused role with clear opportunities for progression as skills and experience develop.', '',
    '## Responsibilities', '*   Retrieve data from SQL Server.', '',
    '### Related Jobs', '*   ![Canonical logo](https://example.test/x.png)'].join('\n');

  let pass = 0, fail = 0;
  const check = (name, cond) => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };
  for (const [label, md, url] of [['xing-de', XING_DE, 'https://www.xing.com/jobs/x-1'], ['xing-en', XING_EN, 'https://www.xing.com/jobs/x-2']]) {
    const out = stripChrome(md, url);
    check(`${label}: keeps the Aufgaben bullet`, out.includes('Anbindung neuer Datenquellen'));
    check(`${label}: keeps the requirements bullet`, out.includes('Sichere SQL-Kenntnisse'));
    check(`${label}: drops the logo rail`, !out.includes('imagecache'));
    check(`${label}: drops the salary/company panel`, !out.includes('61.500') && !out.includes('Ganz anderer Job'));
    check(`${label}: drops the rail ABOVE the body`, !out.includes('55.500'));
  }
  // Stepstone: the posting body is plain prose, but the page ends in a
  // related-jobs rail built from image blocks and orphaned link tails. Those
  // clear the naive guards, so rival postings' titles would reach the drafter
  // as if they were this employer's requirements.
  const STEP = [
    '**Data Analyst – Fraud & Financial Crime**[N26 GmbH](https://www.stepstone.de/cmp/de/N26-GmbH-146811/jobs.html)', '',
    'We are seeking an organized and self-motivated Data Analyst with deep expertise in causal inference, experimentation, and statistical research to work embedded in our Banking Foundations team.', '',
    'Highly experienced with SQL and Python/R for analytics, and with one or more common data visualisation tools such as Tableau, Metabase, Looker or Superset.', '',
    '![KWS Berlin GmbH](https://www.stepstone.de/upload_DE/logo/1/logoKWS-Berlin-GmbH-287480DE-2303010828.gif?im=Resize=(40,40))', '',
    '](/stellenangebote--Data-Analyst-with-focus-on-Source-to-Pay-mw-d-m-w-d-Berlin-KWS-Berlin-GmbH--14368840-inline.html)', '',
    '](/stellenangebote--Data-Integration-Architect-all-genders-Berlin-Andersen-Lab--14234294-inline.html)', '',
    '](/stellenangebote--Referent-Data-Science-Reporting-m-w-d-Berlin-S-Kreditpartner-GmbH--14304404-inline.html)'].join('\n');
  const step = stripChrome(STEP, 'https://www.stepstone.de/stellenangebote--x-1.html');
  check('stepstone: keeps the body', step.includes('causal inference') && step.includes('Tableau'));
  check('stepstone: drops the logo rail', !step.includes('KWS') && !step.includes('upload_DE'));
  check('stepstone: drops rival postings\' titles', !step.includes('Data Integration Architect') && !step.includes('Referent Data Science'));

  const bn = stripChrome(BN, 'https://www.brightnetwork.co.uk/graduate-jobs/x');
  check('brightnetwork: keeps the body', bn.includes('motivated Junior Data Analyst') && bn.includes('SQL Server'));
  check('brightnetwork: drops cookie banner + nav', !bn.includes('Cookies') && !bn.includes('Find an opportunity'));
  check('brightnetwork: drops related-jobs rail', !bn.includes('Canonical'));

  // eFC: nav above, related-jobs rail + bilingual footer below. The rail
  // names OTHER postings — if it survives, its tech terms leak into gap
  // detection downstream.
  const EFC = ['Analytics Engineer, Officer | Krakau PL', '',
    '*   [Jobsuche](/jobs "Jobsuche")', '*   [Jobnews](/nachrichten "Jobnews")', '',
    'Anmelden / Registrieren [Für Arbeitgeber](https://recruitershub.example "Für Arbeitgeber")', '',
    '# Analytics Engineer, Officer, Beispiel Investment Management', '',
    'Beispiel Corporation Krakau, Polen', 'Jetzt bewerben Speichern', '',
    'The Analytics Engineer will serve as a hands-on technical contributor within the intelligence and insights team,',
    'supporting the development and maintenance of Tableau dashboards, analytical reporting solutions and the underlying',
    'data infrastructure that enables informed decision-making across the business. The role contributes to ETL pipeline',
    'development, data integration, data quality activities and the delivery of scalable analytical products at scale.', '',
    '**Key Responsibilities**', '',
    '*   Contribute to the development and maintenance of analytical products across the analytics lifecycle',
    '*   Support the design and maintenance of ETL pipelines within a scalable analytical infrastructure', '',
    '## Treiben Sie Ihre Karriere voran', '',
    'Ähnliche Jobangebote', '',
    '[Senior Scala Developer, Beispiel Bank](https://www.efinancialcareers.de/jobs-x.id1 "Senior Scala Developer")',
    '[Rust Engineer, Beispiel Fintech](https://www.efinancialcareers.de/jobs-y.id2 "Rust Engineer")', '',
    '[Über uns](/uber/uber-uns "Über uns") [Impressum](/uber/impressum "Impressum")',
    '© 2026 eFinancialCareers - Alle Rechte vorbehalten'].join('\n');
  const efc = stripChrome(EFC, 'https://www.efinancialcareers.de/jobs-Poland-Krak%C3%B3w-x.id24521005');
  check('efc: keeps the body', efc.includes('hands-on technical contributor') && efc.includes('ETL pipelines'));
  check('efc: drops nav above the body', !efc.includes('Jobsuche') && !efc.includes('Registrieren'));
  check('efc: drops the related-jobs rail (other postings\' tech)', !efc.includes('Scala Developer') && !efc.includes('Rust Engineer'));
  check('efc: drops the footer', !efc.includes('Alle Rechte vorbehalten') && !efc.includes('Impressum'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

let wrote = 0, missed = 0;
for (const file of process.argv.slice(2)) {
  const batch = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of batch) {
    if (item.status !== 'fulfilled' || !item.value) { console.log(`  ! ${item.reason || 'rejected'}`); missed++; continue; }
    const { url, content } = item.value;
    const row = byUrl.get(String(url).trim());
    if (!row) { console.log(`  ! no queue row for ${url}`); missed++; continue; }
    const dir = path.join(DRAFTS, `${row.application_id}-${slugify(row.title)}`);
    const clean = stripChrome(content, url);
    const dead = deadShell(clean);
    if (dead) {
      console.log(`  ! ${row.application_id} ${row.title}: DEAD_POSTING (/${dead}/) — jd.txt NOT written`);
      missed++;
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'jd.txt'), clean);
    console.log(`  ok ${row.application_id} ${row.title}: ${clean.length} chars (raw ${String(content).length}) -> ${dir}`);
    wrote++;
  }
}
console.log(`jd split: ${wrote} written, ${missed} missed`);
