// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Recruitee provider — hits the public offers endpoint:
//   https://{slug}.recruitee.com/api/offers/
// Auto-detects from careers_url pattern `https://<slug>.recruitee.com`.
//
// Recruitee boards are per-entity, not per-group: a multinational usually has
// one board per country subsidiary. `company_name` from the payload is
// therefore preferred over the portals.yml label, so a job scraped from the
// adesso Netherlands board is attributed to "adesso Netherlands" rather than
// to the group entry that pointed at it.

function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/^https?:\/\/([^./]+)\.recruitee\.com/);
  return match ? match[1] : null;
}

/** @type {Provider} */
export default {
  id: 'recruitee',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://${slug}.recruitee.com/api/offers/` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`recruitee: cannot derive board slug for ${entry.name}`);
    const json = await ctx.fetchJson(`https://${slug}.recruitee.com/api/offers/`);
    const offers = Array.isArray(json?.offers) ? json.offers : [];
    return offers
      .filter(o => o?.title && o.careers_url)
      .map(o => ({
        title: String(o.title).trim(),
        url: o.careers_url,
        company: o.company_name || entry.name,
        location: o.location || [o.city, o.country].filter(Boolean).join(', ')
          || (o.remote ? 'Remote' : ''),
      }));
  },
};
