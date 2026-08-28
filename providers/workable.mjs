// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workable provider — hits the public account widget endpoint:
//   https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true
// Auto-detects from careers_url pattern `https://apply.workable.com/<slug>`.
//
// The widget endpoint returns the full published list in one response (no
// pagination), so unlike SmartRecruiters there is no page loop here. Job URLs
// come straight from the payload (`url`) rather than being reconstructed from
// the shortcode, so a Workable URL-scheme change can't silently produce dead
// links. Used for Hugging Face (apply.workable.com/huggingface).

function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/apply\.workable\.com\/([^/?#]+)/);
  if (!match) return null;
  const slug = match[1];
  // `apply.workable.com/j/<shortcode>` is a single-job permalink, not a board.
  if (slug === 'j') return null;
  return slug;
}

/** @type {Provider} */
export default {
  id: 'workable',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://apply.workable.com/api/v1/widget/accounts/${slug}?details=true` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`workable: cannot derive account slug for ${entry.name}`);
    const json = await ctx.fetchJson(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(slug)}?details=true`,
    );
    const jobs = Array.isArray(json?.jobs) ? json.jobs : [];
    return jobs
      .filter(j => j?.title && (j.url || j.shortlink))
      .map(j => ({
        title: String(j.title).trim(),
        url: j.url || j.shortlink,
        company: entry.name,
        // `telecommuting` is Workable's remote flag; city/country are absent on
        // fully-remote posts, so fall back to it rather than emitting ''.
        location: [j.city, j.country].filter(Boolean).join(', ')
          || (j.telecommuting ? 'Remote' : ''),
      }));
  },
};
