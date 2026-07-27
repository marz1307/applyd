// cv/jd-role-title.mjs — derive the VERBATIM advertised job title from a
// draft-queue row, for the CV job-title header (the tagline / subhead).
//
// WHY THIS EXISTS
// ---------------
// The rule (modes/candidate-profile.md §Step 4.1 and routines/auto-draft.md 2a):
// the CV tagline must LEAD with the role exactly as advertised in the JD — NOT
// the archetype/family label. The deterministic auto-draft driver used to pass
// row.position[0] (the coarse Notion role-FAMILY tag) as --role-title. Because
// the variant is derived from that same tag, the override collapsed to a no-op
// and every CV rendered the variant's generic subhead
// ("Data Analyst · Analytics Engineer", ...) instead of the advertised role.
//
// This module recovers the recruiter's actual title from the row without an LLM
// or a JD fetch: the job_url slug encodes it on every dominant portal, and
// fit_notes usually opens with it. Everything is deterministic and guarded so a
// low-confidence extraction falls back to the clean role family rather than
// leaking a city / work-mode / JD flavour text into the header.
//
// Single source of truth: imported by batch/_autodraft_cv_run.mjs and any
// CV bulk-regeneration script so headers stay JD-led across every path.

const ROLE_HEAD = /(engineer|analyst|scientist|developer|consultant|architect|specialist|statistician|modell?er|administrator|strategist)/i;
const ROLE_KW = new RegExp(ROLE_HEAD.source + '|(analytics|\\bdata\\b|\\bbi\\b|\\bml\\b|\\bai\\b|mlops|reporting|research|quant|intelligence)', 'i');

// Words that can legitimately LEAD a data-role title — so we keep them instead
// of mistaking them for a leading geo token (Xing encodes the city first).
const ANCHOR = new Set(['data', 'analytics', 'analytical', 'machine', 'ml', 'ai', 'bi', 'business', 'cloud',
  'marketing', 'people', 'sports', 'senior', 'junior', 'lead', 'principal', 'staff', 'working', 'werkstudent',
  'praktikant', 'graduate', 'trainee', 'associate', 'digital', 'product', 'platform', 'financial', 'sales',
  'risk', 'credit', 'quant', 'quantitative', 'research', 'applied', 'clinical', 'healthcare', 'retail',
  'master', 'bachelor', 'database', 'reporting', 'insight', 'insights', 'statistical', 'statistics',
  'intelligence', 'ecommerce']);

const WORKMODE = /\b(hybrid|remote|onsite|on[- ]?site|vollzeit|teilzeit|festanstellung|permanent|contract|full[- ]?time|part[- ]?time|befristet|unbefristet|freelance|contractor|inhouse|in[- ]?house)\b/gi;

const ACRONYMS = new Set(['AI', 'ML', 'BI', 'ERP', 'SAP', 'SQL', 'ETL', 'ELT', 'IT', 'HR', 'QA', 'KI', 'NLP', 'LLM', 'MLOps', 'GenAI']);

// Strip gender markers, work-mode tokens, "in <City>" tails, and job-id digits.
export function cleanRoleTitle(raw) {
  if (!raw) return '';
  let t;
  try { t = decodeURIComponent(raw); } catch { t = raw; }
  t = t.replace(/[_+]/g, ' ').replace(/-/g, ' ');
  t = t.replace(/\(?\s*(?:all\s*genders?|m\s*[/|]\s*w\s*[/|]\s*[dx]|w\s*[/|]\s*m\s*[/|]\s*[dx]|d\s*[/|]\s*m\s*[/|]\s*w|f\s*[/|]\s*m\s*[/|]\s*d|gn|divers)\s*\)?/gi, ' ');
  t = t.replace(WORKMODE, ' ');
  t = t.replace(/\bin\s+[A-Za-zÀ-ÿ.\- ]+$/i, ' ');   // eFC "... in München"
  t = t.replace(/\b\d{4,}\b/g, ' ');                  // stray job-id fragments
  return t.replace(/[·|/]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Drop up to 2 leading geo/noise tokens until the title starts with an anchor
// word or a role head (Xing prefixes 1–2 geo tokens: "berlin-", "frankfurt-main-").
function stripLeadingGeo(words) {
  const w = [...words];
  let drops = 0;
  while (w.length > 1 && drops < 2 && !ANCHOR.has(w[0].toLowerCase()) && !ROLE_HEAD.test(w[0])) {
    w.shift(); drops++;
  }
  return w;
}

// Keep from start through the first role-head noun (plus one immediately-adjacent
// head so compound titles like "Data Scientist Consultant" survive), trimming
// JD flavour tails ("... Schwerpunkt Finanzdaten", "... Sports Betting").
function truncateAtRoleHead(words) {
  for (let i = 0; i < words.length; i++) {
    if (ROLE_HEAD.test(words[i])) {
      const end = (words[i + 1] && ROLE_HEAD.test(words[i + 1])) ? i + 2 : i + 1;
      return words.slice(0, end);
    }
  }
  return words;
}

function titleCase(t) {
  return t.split(' ').filter(Boolean).map((w) => {
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    if (/^[A-ZÄÖÜ][a-zà-ÿ]/.test(w)) return w;        // already cased (eFC) — keep
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ');
}

// Some ads pack the title into a dash-separated list where the ROLE sits in the
// middle, not the start — e.g. eFC "Asset_Wealth_Management_-_Data_Scientist_-_Associate".
// Split on clause separators (eFC "_-_" or a spaced dash — NEVER the bare word
// hyphens LinkedIn/Xing use) and keep the first clause that holds a role head.
function preferRoleClause(raw) {
  const clauses = raw.split(/_-_|\s[-–—]\s/);
  if (clauses.length > 1) {
    for (const c of clauses) {
      if (ROLE_HEAD.test(c.replace(/[_-]/g, ' '))) return c;
    }
  }
  return raw;
}

function normalize(raw) {
  if (!raw) return '';
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { decoded = raw; }
  const cleaned = cleanRoleTitle(preferRoleClause(decoded));
  if (!cleaned) return '';
  let words = cleaned.split(' ').filter(Boolean);
  words = stripLeadingGeo(words);
  words = truncateAtRoleHead(words);
  return titleCase(words.join(' '));
}

// job_url slug — the recruiter's own advertised string, present on every row.
function fromUrl(url) {
  if (!url) return '';
  let m;
  m = url.match(/\/jobs\/view\/(.+?)-at-[a-z0-9-]*-\d{6,}\/?(?:\?|$)/i); if (m) return m[1];   // LinkedIn
  m = url.match(/jobs-[^-/]+-[^-/]+-([^/]+?)\.id\d+/i); if (m) return m[1];                     // eFinancialCareers
  m = url.match(/xing\.com\/jobs\/(.+?)-\d{6,}\b/i); if (m) return m[1];                        // Xing
  return '';
}

// fit_notes fallback for portals whose URLs are opaque (Greenhouse/Ashby/Lever).
function fromFit(fit) {
  if (!fit) return '';
  let m = fit.match(/^\s*(?:strong |solid |clean |good )?fit:?\s*([A-Z][A-Za-zÀ-ÿ&/ .-]{2,55}?)(?:,| [—-] | at | \()/i);
  if (m && ROLE_KW.test(m[1])) return m[1];
  m = fit.match(/^([A-Z][A-Za-zÀ-ÿ&/ .-]{2,45}?(?:Engineer|Analyst|Scientist|Developer|Consultant|Architect|Specialist))\b/);
  if (m) return m[1];
  return '';
}

// Clean role-FAMILY fallback (mirrors the old driver's roleTitle()).
export function positionTitle(position) {
  const t = (Array.isArray(position) ? position[0] : String(position || '')) || 'Data Professional';
  if (/^ml engineer$/i.test(t)) return 'Machine Learning Engineer';
  return t.replace(/^senior\s+/i, '');
}

// A candidate title is accepted only if it looks like a real role: 1–5 words,
// contains a role keyword, and carries no residual work-mode noise.
function accept(t) {
  const words = t.split(' ').filter(Boolean);
  return Boolean(t) && words.length >= 1 && words.length <= 5 && ROLE_KW.test(t) && !WORKMODE.test(t);
}

// Returns { title, source } — source ∈ 'url' | 'fit' | 'position'.
export function extractJdRoleTitleVerbose(row) {
  for (const [source, raw] of [['url', fromUrl(row.job_url)], ['fit', fromFit(row.fit_notes)]]) {
    const t = normalize(raw);
    if (accept(t)) return { title: t, source };
  }
  return { title: positionTitle(row.position), source: 'position' };
}

// Convenience: just the title string (with internal fallback to the role family).
export function extractJdRoleTitle(row) {
  return extractJdRoleTitleVerbose(row).title;
}

// Rewrite a "Lead · Anchor" tagline so it LEADS with `override` (the verbatim
// advertised title), preserving the anchor(s) and deduping. Idempotent when the
// tagline already leads with it. Mirrors the inline applyRoleTitle in
// generate-pdf-tailored.mjs.
export function applyRoleTitle(subhead, override) {
  if (!override || !subhead || !subhead.includes(' · ')) return subhead;
  const o = override.trim();
  const parts = subhead.split(' · ').map((s) => s.trim());
  if (o.toLowerCase() === parts[0].toLowerCase()) return subhead;
  const anchors = parts.slice(1).filter((s) => s.toLowerCase() !== o.toLowerCase());
  return anchors.length ? `${o} · ${anchors.join(' · ')}` : o;
}
