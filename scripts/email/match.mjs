/**
 * match.mjs — the credential-free core of the response-tracking layer.
 *
 * Takes a message and the Notion pipeline, returns a PROPOSED stage transition.
 * Pure functions, no network, no auth, no side effects: the mailbox is read by
 * whatever caller has access (currently the Gmail MCP connector in an
 * interactive session) and the Notion write is done by the existing REST
 * scripts. That split is deliberate — scheduled routines run under
 * `--strict-mcp-config` and cannot see account-level connectors, so keeping the
 * logic credential-free means it survives whichever fetch path wins later.
 *
 * NOTHING HERE APPLIES ANYTHING. It proposes; a caller decides.
 */

import { APPLIED_STAGES, TERMINAL_STAGES } from '../metrics/metrics-core.mjs';

/* ─────────────────────────────── company text ────────────────────────────── */

// Legal suffixes and recruiting-boilerplate words carry no identifying signal.
// "Acme SE" and "Acme GmbH" are the same employer for matching purposes,
// and "careers"/"talent"/"noreply" appear in half of all recruiting senders.
const NOISE = new Set([
  'gmbh', 'ag', 'se', 'kg', 'mbh', 'co', 'ltd', 'limited', 'plc', 'inc', 'llc',
  'bv', 'nv', 'sa', 'as', 'oy', 'ab', 'group', 'holding', 'holdings',
  'deutschland', 'germany', 'uk', 'international', 'technologies', 'technology',
  'solutions', 'services', 'consulting', 'the', 'and', 'und',
  'careers', 'career', 'jobs', 'job', 'recruiting', 'recruitment', 'talent',
  'hr', 'team', 'noreply', 'no', 'reply', 'donotreply', 'mail', 'email', 'via',
]);

/**
 * Industry words that cannot identify an employer ON THEIR OWN in a data-jobs
 * pipeline. Guards against a real false positive: a company name that
 * tokenises to just ["data"] once "talent" and "gmbh" drop out as boilerplate
 * matches almost every subject line in a data-jobs pipeline.
 *
 * These are NOT removed from the token set (that would break "Delivery Hero"
 * style names); they are only disqualified from being the SOLE evidence.
 */
const GENERIC = new Set([
  'data', 'analytics', 'analytic', 'analysis', 'tech', 'digital', 'cloud',
  'ai', 'ml', 'software', 'systems', 'system', 'labs', 'lab', 'media',
  'health', 'global', 'people', 'work', 'staff', 'personnel', 'engineering',
  'engineer', 'science', 'sciences', 'scientist', 'intelligence', 'insight',
  'insights', 'partners', 'associates', 'ventures', 'capital', 'studio',
  'studios', 'agency', 'network', 'online', 'web', 'apps', 'app', 'platform',
]);

/**
 * A company is matchable by free text only if it has at least one token that
 * is not a generic industry word. Otherwise text matching is meaningless and
 * the row must be identified some other way (domain) or left to a human.
 */
export function isDiscriminating(companyTokens) {
  return (companyTokens || []).some((t) => !GENERIC.has(t));
}

export function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t && !NOISE.has(t));
}

/**
 * Token-subset match. NEVER substring: substring matching is how "Scala" gets
 * found inside "scalable" in cover-letter gap checkers, and the same trap
 * would match "Finn" inside "Finnair" or "Abound" inside "Aboundant".
 */
export function companyIn(haystack, companyTokens) {
  if (!companyTokens || !companyTokens.length) return false;
  const hay = new Set(tokens(haystack));
  return companyTokens.every((t) => hay.has(t));
}

// Portals and ATS vendors send on the employer's behalf, so their domain
// identifies the tool, not the company. When the sender is one of these the
// display name and subject carry the whole load.
export const RELAY_DOMAINS =
  /(^|\.)(indeed|linkedin|xing|stepstone|efinancialcareers|welcometothejungle|glassdoor|totaljobs|reed|monster|greenhouse|greenhouse-mail|lever|ashbyhq|workday|myworkdayjobs|smartrecruiters|teamtailor|teamtailor-mail|personio|workable|recruitee|jobvite|icims|taleo|successfactors|bamboohr|join|eightfold|phenompeople|talosats|fountain|avature|concludis|d-vinci|rexx-systems|levlr|jobleads)\./i;

export function senderDomain(address) {
  const m = String(address || '').match(/@([^>\s]+)/);
  return m ? m[1].toLowerCase() : '';
}

export function isRelay(address) {
  return RELAY_DOMAINS.test(senderDomain(address) + '.');
}

/* ──────────────────────────────── classify ───────────────────────────────── */

// Ordered: the first match wins, so the more specific outcomes are tested
// before the generic ones. A rejection that also contains the word "interview"
// ("...we will not be progressing to interview") must classify as a rejection.
const KINDS = [
  {
    kind: 'rejection',
    stage: 'Rejected',
    re: /\b(unfortunately|regret to inform|we regret|not (be )?(moving|progressing|proceeding|taking)[^.]{0,40}(forward|further|ahead)|not (been )?(successful|shortlisted|selected)|decided to (proceed|move forward) with (other|another)|unsuccessful on this occasion|will not be progressing|no longer under consideration|leider|absage|nicht (weiter|berücksichtigen)|eine andere? (bewerberin|bewerber|entscheidung))\b/i,
  },
  {
    kind: 'offer',
    stage: '9. Offer',
    re: /\b(pleased to offer|delighted to offer|offer of employment|formal offer|job offer|we would like to offer|stellenangebot|vertragsangebot)\b/i,
  },
  {
    kind: 'assessment',
    stage: '5. Assessment/OA',
    re: /\b(online assessment|take[- ]home|technical (test|assessment|challenge)|coding (test|challenge|exercise)|hackerrank|codility|codesignal|testgorilla|karat|assessment (invite|invitation|link)|online[- ]test)\b/i,
  },
  {
    kind: 'interview',
    stage: '6. Phone screen',
    re: /\b(invite you to|invitation to interview|would like to (invite|schedule|arrange|set up)|schedule a (call|chat|conversation|time)|book a (time|slot|call)|your availability|are you available|next steps? (in|of) (the|your|our)|first[- ]stage (call|interview)|phone screen|screening call|vorstellungsgespräch|einladung zum|gespräch vereinbaren|kennenlernen)\b/i,
  },
  {
    kind: 'confirmation',
    stage: '4. Applied',
    // Wide enough to catch real forwarded mail: "Your application at Acme"
    // and "Your recent job application for Junior Data Scientist" do not use
    // the classic thank-you/received phrasings. Rejections are tested BEFORE
    // this, so "unfortunately, regarding your application" still reads as a
    // rejection rather than being swallowed here.
    re: /\b(we (have )?(got|received|have) your application|thank you for (your )?(applying|application|your interest)|application (has been )?received|successfully (applied|submitted)|your (recent )?(job )?application\b|application (at|to|for) \w|eingang ihrer bewerbung|bewerbung erhalten|vielen dank für (ihre|deine) bewerbung)\b/i,
  },
];

/**
 * Classify a message by what it says. Returns kind 'other' when nothing
 * matches, which is the common case and is not a failure — most mail in the
 * label will be noise.
 */
export function classify({ subject = '', body = '' } = {}) {
  const text = `${subject}\n${body}`;
  for (const { kind, stage, re } of KINDS) {
    const m = text.match(re);
    if (m) return { kind, proposedStage: stage, signal: m[0] };
  }
  return { kind: 'other', proposedStage: null, signal: null };
}

/* ───────────────────────────────── matching ──────────────────────────────── */

// Only rows that were actually submitted can receive a response. A row still
// at Discovered/Triaged/Drafted was never sent, so an inbound "we got your
// application" cannot belong to it.
// DERIVED, never hand-listed. metrics-core owns the stage taxonomy and this
// repo's rule is that no script re-states it locally. "Respondable" is
// APPLIED_STAGES minus the terminals: a row that was submitted and is still
// open. Signed/Rejected are excluded because a closed row should not absorb a
// new response. If the taxonomy ever changes, this follows it automatically.
export const RESPONDABLE_STAGES = Object.freeze(
  APPLIED_STAGES.filter((s) => !TERMINAL_STAGES.includes(s))
);

/**
 * A confirmation is the one kind that legitimately matches a row still at
 * Drafted — it is the evidence that the submission happened, which is exactly
 * the transition the tracker is missing when a human sends the application
 * directly without flipping the stage.
 */
export const CONFIRMABLE_STAGES = Object.freeze(['3. Drafted', ...RESPONDABLE_STAGES]);

function stagesFor(kind) {
  return kind === 'confirmation' ? CONFIRMABLE_STAGES : RESPONDABLE_STAGES;
}

/**
 * Split a company name into the brand segments a recruiter might actually write.
 *
 * A parent + sub-brand row is one employer with several writable names, and
 * strict all-tokens matching needs every one of them present — so mail from
 * plain "ParentBrand" would match nothing while the row sits open at Applied.
 * Sub-brands, "X, a Y company" and "X | Y" all have this shape.
 *
 * Segments that reduce to generic industry words are dropped, so a bare
 * industry token in the middle of a name can never carry a match on its own
 * — same guard as `isDiscriminating`, for the same reason.
 */
export function brandSegments(title) {
  return String(title || '')
    .split(/,| by | \| | \/ | - |\(|\)/i)
    .map((seg) => tokens(seg))
    .filter((toks) => toks.length && isDiscriminating(toks));
}

/**
 * Find the pipeline rows a message could belong to.
 *
 * Signals, in the order they are trusted:
 *   1. sender display name  — survives ATS relays ("Acme via Greenhouse")
 *   2. sender domain        — useless when the sender is a relay, hence the flag
 *   3. subject line         — often carries the employer for confirmations
 */
export function findCandidates(msg, rows, kind = null) {
  const allowed = stagesFor(kind);
  const live = rows.filter((r) => allowed.includes(r.stage) && r.title);
  const name = msg.senderName || '';
  const domain = senderDomain(msg.sender).replace(/\./g, ' ');
  const subject = msg.subject || '';
  const relay = isRelay(msg.sender);

  const hits = [];
  const hay = new Set([...tokens(name), ...tokens(subject), ...tokens(msg.body || '')]);
  for (const row of live) {
    const toks = tokens(row.title);
    // A name that reduces to generic industry words would match nearly every
    // subject in this pipeline. Skip it rather than emit a confident wrong
    // answer.
    if (!toks.length || !isDiscriminating(toks)) continue;
    const via = [];
    if (companyIn(name, toks)) via.push('display_name');
    if (!relay && companyIn(domain, toks)) via.push('domain');
    if (companyIn(subject, toks)) via.push('subject');
    if (via.length) hits.push({ row, via });
  }

  // RESCUE PASS — only when the strict pass found nothing at all. A sub-brand
  // row ("SubBrand, AI by ParentBrand") never contains all its tokens in mail
  // from the parent brand. Running this only on an empty result keeps every
  // existing strict match byte-identical, so the relaxation can add matches but
  // can never change one.
  if (!hits.length) {
    for (const row of live) {
      const segs = brandSegments(row.title);
      // A single-segment name gains nothing here and would only widen the net.
      if (segs.length < 2) continue;
      const via = [];
      if (segs.some((seg) => companyIn(name, seg))) via.push('display_name~brand');
      if (!relay && segs.some((seg) => companyIn(domain, seg))) via.push('domain~brand');
      if (segs.some((seg) => companyIn(subject, seg))) via.push('subject~brand');
      if (via.length) hits.push({ row, via });
    }
  }

  // Same company, more than one open application: try to resolve WHICH role the
  // message is about before giving up. "Your recent job application for Junior
  // Data Scientist" names it outright, and a row's Position carries the same
  // words. Narrow only when exactly one row's role is fully named — two rows
  // for the same title stay ambiguous, which is the correct answer.
  if (hits.length > 1) {
    const byRole = hits.filter((h) => {
      const roleToks = tokens((h.row.position || []).join(' '));
      return roleToks.length && roleToks.every((t) => hay.has(t));
    });
    if (byRole.length === 1) {
      byRole[0].via.push('role');
      return { hits: byRole, relay, disambiguated_by_role: true };
    }
  }

  return { hits, relay };
}

/**
 * Full proposal for one message. Confidence drives what a caller may do:
 *
 *   high     exactly one candidate row and a recognised outcome  → auto-appliable
 *   ambiguous  several candidate rows                            → human picks
 *   unmatched  no candidate row                                  → human triages
 *   ignore     classified 'other'                                → no action
 */
export function propose(msg, rows) {
  const cls = classify(msg);
  const { hits, relay } = findCandidates(msg, rows, cls.kind);

  let confidence;
  if (cls.kind === 'other') confidence = 'ignore';
  else if (hits.length === 1) confidence = 'high';
  else if (hits.length > 1) confidence = 'ambiguous';
  else confidence = 'unmatched';

  return {
    message_id: msg.id,
    date: msg.date,
    sender: msg.sender,
    sender_name: msg.senderName || null,
    subject: msg.subject,
    relay_sender: relay,
    kind: cls.kind,
    signal: cls.signal,
    proposed_stage: cls.proposedStage,
    confidence,
    candidates: hits.map((h) => ({
      application_id: h.row.application_id,
      id: h.row.id,
      company: h.row.title,
      stage: h.row.stage,
      matched_via: h.via,
    })),
  };
}

/**
 * Kinds that may be applied without a human looking, and ONLY when matched to
 * exactly one row.
 *
 *   rejection     terminal and recoverable. A wrongly-filed rejection costs a
 *                 stage flip to undo.
 *   confirmation  RECORDS a submission that already happened. Does not touch
 *                 the never-auto-submit rule: the human still decides to
 *                 apply, this only writes down that they did. Without it the
 *                 Stage 3 backlog stays fictional.
 *
 * Everything else is surfaced, and the asymmetry is deliberate rather than
 * timid: a mis-filed rejection costs a stage flip, a mis-filed or missed
 * interview invite costs an opportunity.
 *
 * `ambiguous` never auto-applies — that is the "two roles at one company"
 * case. findCandidates() first tries to resolve it by role name; if it still
 * cannot tell, the message goes to the human queue rather than guessing.
 */
export const AUTO_APPLIABLE_KINDS = Object.freeze(['rejection', 'confirmation']);

export function isAutoAppliable(proposal) {
  return proposal.confidence === 'high' && AUTO_APPLIABLE_KINDS.includes(proposal.kind);
}

/**
 * Everything a human must look at: an outcome was recognised but the row is
 * uncertain, or the outcome is one we refuse to file automatically.
 */
export function needsAttention(proposal) {
  if (proposal.confidence === 'ignore') return false;
  return !isAutoAppliable(proposal);
}

export default { tokens, companyIn, classify, findCandidates, propose, isAutoAppliable, needsAttention, isDiscriminating, brandSegments, RESPONDABLE_STAGES, CONFIRMABLE_STAGES, AUTO_APPLIABLE_KINDS, RELAY_DOMAINS };
