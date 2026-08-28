const HARD_EXPIRED_PATTERNS = [
  /job (is )?no longer available/i,
  /job.*no longer open/i,
  /position has been filled/i,
  /this job has expired/i,
  /job posting has expired/i,
  /no longer accepting applications/i,
  /this (position|role|job) (is )?no longer/i,
  /this job (listing )?is closed/i,
  /job (listing )?not found/i,
  /the page you are looking for doesn.t exist/i,
  /applications?\s+(?:(?:have|are|is)\s+)?closed/i,
  /closed on \d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /closed on (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i,
  /diese stelle (ist )?(nicht mehr|bereits) besetzt/i,
  // Xing's dead-advert page. Observed 2026-08-16 on APP-3804, which was only
  // caught because Xing happened to also return 410 — the text is the reliable
  // signal, the status code is not guaranteed.
  /dieses stellenangebot existiert nicht/i,
  /offre (expirée|n'est plus disponible)/i,
];

const LISTING_PAGE_PATTERNS = [
  /\d+\s+jobs?\s+found/i,
  /search for jobs page is loaded/i,
  // LinkedIn's expired-advert shell. It does NOT say the job is gone — it
  // silently serves a full search-results page, ~30-38k chars of real content,
  // which reads as a healthy advert on every length- and apply-text-based check.
  // APP-4425 (Awaze) and APP-3431 (King) both sat in the pipeline as "alive"
  // for weeks on 30k+ char bodies. This line only ever appears at the bottom of
  // a results list, never on a single advert.
  /you.ve viewed all jobs for this search/i,
];

const EXPIRED_URL_PATTERNS = [
  /[?&]error=true/i,
  // LinkedIn states expiry in the redirect itself and nowhere in the body: an
  // expired advert 301s to a role-search page carrying `trk=expired_jd_redirect`.
  // That is the platform's own machine-readable marker, and it is far more
  // reliable than anything in the rendered text — the page it lands on is a
  // normal search page with no expiry wording at all. APP-3431 (King) was
  // classified alive on a 30,705-char body that was exactly this redirect.
  /[?&]trk=expired_jd_redirect/i,
];

const APPLY_PATTERNS = [
  /\bapply\b/i,
  /\bsolicitar\b/i,
  /\bbewerben\b/i,
  /\bpostuler\b/i,
  /submit application/i,
  /easy apply/i,
  /start application/i,
  /ich bewerbe mich/i,
];

const MIN_CONTENT_CHARS = 300;

function firstMatch(patterns, text = '') {
  return patterns.find((pattern) => pattern.test(text));
}

function hasApplyControl(controls = []) {
  return controls.some((control) => APPLY_PATTERNS.some((pattern) => pattern.test(control)));
}

export function classifyLiveness({ status = 0, finalUrl = '', bodyText = '', applyControls = [] } = {}) {
  if (status === 404 || status === 410) {
    return { result: 'expired', code: 'http_gone', reason: `HTTP ${status}` };
  }

  const expiredUrl = firstMatch(EXPIRED_URL_PATTERNS, finalUrl);
  if (expiredUrl) {
    return { result: 'expired', code: 'expired_url', reason: `redirect to ${finalUrl}` };
  }

  const expiredBody = firstMatch(HARD_EXPIRED_PATTERNS, bodyText);
  if (expiredBody) {
    return { result: 'expired', code: 'expired_body', reason: `pattern matched: ${expiredBody.source}` };
  }

  if (hasApplyControl(applyControls)) {
    return { result: 'active', code: 'apply_control_visible', reason: 'visible apply control detected' };
  }

  const listingPage = firstMatch(LISTING_PAGE_PATTERNS, bodyText);
  if (listingPage) {
    return { result: 'expired', code: 'listing_page', reason: `pattern matched: ${listingPage.source}` };
  }

  if (bodyText.trim().length < MIN_CONTENT_CHARS) {
    return { result: 'expired', code: 'insufficient_content', reason: 'insufficient content — likely nav/footer only' };
  }

  return { result: 'uncertain', code: 'no_apply_control', reason: 'content present but no visible apply control found' };
}

/**
 * Codes that justify retiring a row to `Withdrew`.
 *
 * Deliberately narrower than `result === 'expired'`. Two of the expired codes
 * are not evidence a posting is dead, only that the fetcher could not read it:
 *
 *   insufficient_content — a bot wall and a dead advert both return a near-empty
 *     body. eFinancialCareers walls every headless fetcher this way. On
 *     2026-08-14 a Firecrawl pass proved 154 of 160 rows that headless
 *     Playwright could not adjudicate were fully live job adverts.
 *   no_apply_control — measures the detector's blindness to consent walls and
 *     JS-rendered buttons, not the advert's state. It was 91% of that same run.
 *
 * Withdrawing on either would gut a live pipeline. Keep this set hard-signal
 * only: an HTTP status, an expiry URL, or explicit expiry text.
 */
export const WITHDRAWABLE_CODES = Object.freeze([
  'http_gone',
  'expired_url',
  'expired_body',
  'listing_page',
]);

export function isWithdrawable(code) {
  return WITHDRAWABLE_CODES.includes(code);
}
