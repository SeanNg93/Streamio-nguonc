'use strict';

const SOURCE_ORIGIN = 'https://phim.nguonc.com';
const ID_PREFIX = 'nguonc:';
const FALLBACK_DATE = '1970-01-01T00:00:00.000Z'; // Protocol requires released for series video items.

function htmlText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/p|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[ \t]{2,}/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}

function link(input, origin = SOURCE_ORIGIN) {
  if (typeof input !== 'string' || !input.trim()) return undefined;
  try {
    const u = new URL(input.trim(), origin);
    return ['http:', 'https:'].includes(u.protocol) ? u.href : undefined;
  } catch { return undefined; }
}

function slugOf(movie) {
  return movie && typeof movie.slug === 'string' && /^[a-z\d_-]{1,150}$/i.test(movie.slug)
    ? movie.slug : null;
}

function mediaId(slug) { return `${ID_PREFIX}${slug}`; }
function episodeId(slug, episode) { return `${mediaId(slug)}:ep:${episode}`; }
function parseMediaId(id) {
  const m = /^nguonc:([a-z\d_-]{1,150})(?::ep:([1-9]\d{0,4}))?$/i.exec(id || '');
  return m ? { slug: m[1], episode: m[2] ? Number(m[2]) : null } : null;
}

function groupValues(movie) {
  const category = Array.isArray(movie?.category) ? movie.category : [];
  return category.flatMap((g) => Array.isArray(g.list)
    ? g.list.map((c) => ({ group: g.group?.name || '', name: c.name || '' })) : []);
}

function typeOf(item) {
  const names = groupValues(item).map((g) => g.name.toLocaleLowerCase('vi'));
  if (names.some((n) => /^phim bộ$/i.test(n))) return 'series';
  if (names.some((n) => /^phim lẻ$/i.test(n))) return 'movie';
  if (['series', 'phimbo'].includes(String(item?.type || '').toLowerCase())) return 'series';
  if (['single', 'movie'].includes(String(item?.type || '').toLowerCase())) return 'movie';
  if (Number(item?.total_episodes) > 1) return 'series';
  const cur = String(item?.current_episode || '');
  if (/\b(?:tập|tap|episode|ep)\s*\d+(?:\s*\/\s*\d+)?/iu.test(cur) && !/\bfull\b/i.test(cur)) return 'series';
  return 'movie';
}

function yearOf(item) {
  const candidates = [item?.year, ...groupValues(item).filter((g) =>
    /năm|year/i.test(g.group)).map((g) => g.name)];
  for (const value of candidates) {
    const m = /\b(19\d{2}|20\d{2})\b/.exec(String(value || ''));
    if (m) return m[1];
  }
  return undefined;
}

function preview(item, typeOverride) {
  const slug = slugOf(item);
  if (!slug) return null;
  const output = {
    id: mediaId(slug),
    type: typeOverride || typeOf(item),
    name: htmlText(item.name || item.original_name) || slug
  };
  const poster = link(item.poster_url || item.thumb_url);
  if (poster) output.poster = poster;
  const year = yearOf(item);
  if (year) output.releaseInfo = year;
  const description = htmlText(item.description);
  if (description) output.description = description.slice(0, 1000);
  return output;
}

function serverList(movie) {
  return (Array.isArray(movie?.episodes) ? movie.episodes : [])
    .map((server) => ({
      name: String(server.server_name || 'NguồnC').trim(),
      items: Array.isArray(server.items) ? server.items :
        Array.isArray(server.server_data) ? server.server_data : []
    }))
    .filter((server) => server.items.length > 0);
}

function episodeNumber(ep, index) {
  const label = String(ep?.name || '').trim();
  const slug = String(ep?.slug || '').trim();
  for (const value of [label, slug]) {
    let m = /(?:^|\b)(?:tập|tap|episode|ep|e)\s*[-.:# ]*0*(\d{1,4})\b/iu.exec(value);
    if (m) return Number(m[1]);
    m = /^0*(\d{1,4})$/.exec(value);
    if (m) return Number(m[1]);
  }
  return index + 1;
}

function primaryEpisodeList(movie) {
  const servers = serverList(movie);
  if (!servers.length) return [];
  // More complete server wins. For each number, retain just one entry across servers.
  const primary = [...servers].sort((a, b) => b.items.length - a.items.length)[0];
  const episodeMap = new Map();
  primary.items.forEach((ep, i) => {
    const n = episodeNumber(ep, i);
    if (n >= 1 && !episodeMap.has(n)) episodeMap.set(n, { number: n, label: ep.name });
  });
  return [...episodeMap.values()].sort((a, b) => a.number - b.number);
}

function releasedDate(movie) {
  const year = yearOf(movie);
  if (year) return `${year}-01-01T00:00:00.000Z`;
  const date = movie.created || movie.modified;
  if (date && !Number.isNaN(Date.parse(date))) return new Date(date).toISOString();
  return FALLBACK_DATE;
}

function detailMeta(movie, type, requestedSlug) {
  const slug = slugOf(movie) || requestedSlug;
  const base = preview({ ...movie, slug }, type) || { id: mediaId(slug), name: slug, type };
  const desc = htmlText(movie.description || movie.content);
  const origName = htmlText(movie.original_name || movie.origin_name);
  const output = {
    ...base,
    description: [origName && origName !== base.name ? `Tên gốc: ${origName}` : '', desc]
      .filter(Boolean).join('\n\n').slice(0, 10000),
    website: `${SOURCE_ORIGIN}/phim/${encodeURIComponent(slug)}`,
    poster: link(movie.poster_url || movie.thumb_url),
    background: link(movie.thumb_url || movie.poster_url),
    genres: groupValues(movie)
      .filter((g) => /thể loại|genre/i.test(g.group))
      .map((g) => g.name)
      .filter(Boolean)
      .slice(0, 15)
  };
  if (!output.poster) delete output.poster;
  if (!output.background) delete output.background;
  if (!output.genres.length) delete output.genres;
  if (!output.description) delete output.description;
  const cast = String(movie.casts || movie.actor || '').split(',').map((s) => s.trim()).filter(Boolean);
  const director = String(movie.director || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cast.length) output.cast = cast;
  if (director.length) output.director = director;
  if (movie.time) output.runtime = String(movie.time);
  if (type === 'series') {
    const released = releasedDate(movie);
    output.videos = primaryEpisodeList(movie).map((ep) => ({
      id: episodeId(slug, ep.number),
      title: htmlText(ep.label) || `Tập ${ep.number}`,
      season: 1,
      episode: ep.number,
      released,
      available: true
    }));
  }
  return output;
}

function pickEpisode(items, wantedNum, isMovie = false) {
  if (!Array.isArray(items) || !items.length) return null;
  if (isMovie) return items.find((it) => /full|tập 1|tap 1/i.test(it.name || '')) || items[0];
  let match = items.find((it, i) => episodeNumber(it, i) === wantedNum);
  if (!match && wantedNum > 0 && items.length >= wantedNum) match = items[wantedNum - 1];
  return match || null;
}

module.exports = {
  SOURCE_ORIGIN, htmlText, link, slugOf, mediaId, episodeId, parseMediaId,
  typeOf, yearOf, preview, serverList, episodeNumber, primaryEpisodeList,
  detailMeta, pickEpisode
};
