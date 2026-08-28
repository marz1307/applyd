// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Personio provider — reads the public job-board XML feed:
//   https://{slug}.jobs.personio.de/xml
// Auto-detects from careers_url pattern `https://<slug>.jobs.personio.de`.
//
// The feed is a flat <workzag-jobs><position>…</position></workzag-jobs> list
// with no nesting inside the fields we read, so it is parsed with regex rather
// than by adding an XML dependency — the repo currently ships only dotenv,
// js-yaml and playwright, and one shallow feed does not justify a fourth.
//
// The feed carries no permalink, only <id>, so the posting URL is constructed
// as `https://{slug}.jobs.personio.de/job/{id}` — Personio's public job-page
// format. If Personio ever changes that scheme the titles still scan correctly
// but the links break, so treat a run of dead Personio URLs as a signal to
// re-check this line rather than the feed.

const POSITION_RE = /<position>([\s\S]*?)<\/position>/g;

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&'); // last: avoid double-decoding &amp;lt;
}

// Reads the first direct <tag> value in a <position> block. Nested repeats
// (e.g. <additionalOffices><office>) are deliberately not merged — the first
// <office> is the primary location and is what the location filter wants.
function field(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1].trim()) : '';
}

function resolveSlug(entry) {
  const url = entry.careers_url || '';
  const match = url.match(/^https?:\/\/([^./]+)\.jobs\.personio\.(?:de|com)/);
  return match ? match[1] : null;
}

/** @type {Provider} */
export default {
  id: 'personio',

  detect(entry) {
    const slug = resolveSlug(entry);
    return slug ? { url: `https://${slug}.jobs.personio.de/xml` } : null;
  },

  async fetch(entry, ctx) {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`personio: cannot derive board slug for ${entry.name}`);
    const xml = await ctx.fetchText(`https://${slug}.jobs.personio.de/xml`);
    const out = [];
    for (const [, block] of xml.matchAll(POSITION_RE)) {
      const id = field(block, 'id');
      const title = field(block, 'name');
      if (!id || !title) continue;
      const offices = [field(block, 'office')].filter(Boolean);
      out.push({
        title,
        url: `https://${slug}.jobs.personio.de/job/${id}`,
        company: field(block, 'subcompany') || entry.name,
        location: offices.join(', '),
      });
    }
    return out;
  },
};
