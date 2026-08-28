// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Arbeitnow provider — reads the free public job-board API:
//   https://www.arbeitnow.com/api/job-board-api
// Auto-detects from careers_url pattern `https://www.arbeitnow.com`.
//
// Unlike every other provider here, Arbeitnow is an AGGREGATOR, not a single
// company's ATS. Two consequences:
//
//   1. `company` comes from each posting's `company_name`, never from the
//      portals.yml label — otherwise several hundred unrelated employers would
//      all be filed under "Arbeitnow" and the dedup/attribution downstream
//      would be meaningless.
//   2. The feed is broad German-market volume (~175 postings/page, mostly
//      irrelevant to data roles) ordered by `created_at` descending. Newest
//      first means MAX_PAGES acts as a recency window, not a truncation of
//      relevance: the title filter in scan.mjs discards the bulk of it anyway.
//
// The API's own terms ask callers not to abuse it and to link back, hence the
// modest page cap and no retry loop.

const BASE = 'https://www.arbeitnow.com/api/job-board-api';
const MAX_PAGES = 3; // ~525 newest postings per scan

/** @type {Provider} */
export default {
  id: 'arbeitnow',

  detect(entry) {
    const url = entry.careers_url || '';
    return /^https?:\/\/(www\.)?arbeitnow\.com/.test(url) ? { url: BASE } : null;
  },

  async fetch(entry, ctx) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await ctx.fetchJson(`${BASE}?page=${page}`);
      const data = Array.isArray(json?.data) ? json.data : [];
      for (const j of data) {
        if (!j?.title || !j.url) continue;
        out.push({
          title: String(j.title).trim(),
          url: j.url,
          company: j.company_name || '',
          location: j.location || (j.remote ? 'Remote' : ''),
        });
      }
      if (!json?.links?.next || data.length === 0) break;
    }
    return out;
  },
};
