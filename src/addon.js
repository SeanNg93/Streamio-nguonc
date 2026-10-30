'use strict';

const { NguoncApi } = require('./api');
const { preview, parseMediaId, detailMeta, typeOf } = require('./mapper');
const { EmbedResolver, buildStreams } = require('./streams');
const { PlaybackStore } = require('./playback');
const { ImdbMatcher, parseImdbId } = require('./imdb');
const { SearchCatalog } = require('./search');

const CATALOGS = [
  { type: 'movie', id: 'nguonc-phim-le', name: 'NguồnC • Phim lẻ', source: 'phim-le' },
  { type: 'series', id: 'nguonc-phim-bo', name: 'NguồnC • Phim bộ', source: 'phim-bo' },
  { type: 'movie', id: 'nguonc-moi-phim-le', name: 'NguồnC • Phim lẻ mới cập nhật', source: 'moi', filter: true },
  { type: 'series', id: 'nguonc-moi-phim-bo', name: 'NguồnC • Phim bộ mới cập nhật', source: 'moi', filter: true },
  { type: 'series', id: 'nguonc-hoat-hinh', name: 'NguồnC • Hoạt hình / Anime', source: 'hoat-hinh' }
];

const manifest = {
  id: 'com.personal.nguonc.stremio',
  version: '1.2.0',
  name: 'NguồnC Việt Nam',
  description: 'NguồnC: danh mục phim và luồng phát trực tiếp trong Stremio nếu nguồn cho phép. Không mở website ngoài.',
  resources: [
    { name: 'catalog', types: ['movie', 'series'] },
    { name: 'meta', types: ['movie', 'series'], idPrefixes: ['nguonc:'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['nguonc:', 'tt'] }
  ],
  types: ['movie', 'series'],
  idPrefixes: ['nguonc:', 'tt'],
  catalogs: CATALOGS.map(({ type, id, name }) => ({
    type, id, name,
    extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
  })),
  behaviorHints: { adult: false, p2p: false }
};

function listItems(body) {
  return Array.isArray(body?.items) ? body.items :
    Array.isArray(body?.data?.items) ? body.data.items : [];
}

function pagination(body) {
  return body?.paginate || body?.pagination || body?.data?.params?.pagination || {};
}

function countPerPage(body) {
  const p = pagination(body);
  return Number(p.items_per_page || p.itemsPerPage) || listItems(body).length || 12;
}

function totalPages(body) {
  const p = pagination(body);
  return Number(p.total_page || p.totalPages) || 999;
}

function createAddon({ client = new NguoncApi(), resolver = new EmbedResolver(),
                       playback = new PlaybackStore(), logger = console, imdb = null } = {}) {
  imdb ||= new ImdbMatcher({ client, logger });
  const search = new SearchCatalog({ client, logger,
    maxPages: Number(process.env.SEARCH_MAX_PAGES) || 18,
    ttlMs: (Number(process.env.SEARCH_CACHE_SEC) || 90) * 1000 });
  function normalizeResult(items, catalog) {
    const targetType = catalog.type;
    const filtered = catalog.filter ? items.filter((item) => typeOf(item) === targetType) : items;
    return filtered.map((item) => preview(item, targetType)).filter(Boolean);
  }

  async function getCatalog(type, id, extra = {}) {
    const catalog = CATALOGS.find((c) => c.id === id && c.type === type);
    if (!catalog) return { metas: [] };
    const skip = Math.min(200, Math.max(0, Number.parseInt(extra.skip, 10) || 0));
    const keyword = String(extra.search || '').trim().slice(0, 120);
    const useSearch = !!keyword;

    try {
      if (useSearch) {
        const result = await search.get(keyword);
        const metas = normalizeResult(result.items.filter((item) => typeOf(item) === type), catalog)
          .slice(skip, skip + 15);
        if (!result.complete && !metas.length) throw new Error('Search results temporarily incomplete');
        return result.complete ? { metas } : { metas, cacheMaxAge: 0 };
      }
      if (catalog.filter) {
        // Walk a bounded number of upstream pages so filtered catalogs use
        // stable Stremio `skip` pagination without duplicated entries.
        const metas = [];
        const pageLimit = 18;
        const target = Math.min(260, skip + 15);
        let knownPages = 1;
        for (let page = 1; page <= pageLimit && metas.length < target; page++) {
          const fetchPage = (p) => client.list(catalog.source, p);
          const body = await fetchPage(page);
          knownPages = Math.min(pageLimit, totalPages(body));
          for (let ahead = page + 1; ahead <= Math.min(knownPages, page + 2); ahead++) fetchPage(ahead).catch(() => {});
          const batch = listItems(body);
          if (!batch.length) break;
          metas.push(...normalizeResult(batch, catalog));
          if (page >= totalPages(body) || batch.length < countPerPage(body)) break;
        }
        return { metas: metas.slice(skip, skip + 15) };
      }

      // Unfiltered catalog: calculate NguonC page number from its own page size.
      const first = await client.list(catalog.source, 1);
      const size = Math.max(1, Math.min(100, countPerPage(first)));
      const page = Math.floor(skip / size) + 1;
      const offset = skip % size;
      const result = page === 1 ? first : await client.list(catalog.source, page);
      const items = listItems(result).slice(offset);
      if (offset > 0 && items.length < size && page < totalPages(result)) {
        const following = await client.list(catalog.source, page + 1);
        items.push(...listItems(following).slice(0, size - items.length));
      }
      return { metas: normalizeResult(items, catalog) };
    } catch (error) {
      logger.warn(`[NguonC] catalog ${id}: ${error.message}`);
      throw error; // An upstream failure is not a successful empty catalog.
    }
  }

  async function getDetail(type, id) {
    const parsed = parseMediaId(id);
    if (!parsed || parsed.episode) return { meta: null };
    try {
      const data = await client.detail(parsed.slug);
      const movie = data?.movie || data?.data?.movie || data;
      if (!movie?.name) return { meta: null };
      return { meta: detailMeta(movie, type, parsed.slug) };
    } catch (error) {
      logger.warn(`[NguonC] meta ${parsed.slug}: ${error.message}`);
      return { meta: null };
    }
  }

  async function getStreams(type, id, publicBaseUrl = null, opts = {}) {
    if (parseImdbId(id)) {
      // IMDb title from Cinemeta/other catalogs: find the matching NguonC film first.
      if (process.env.IMDB_MATCH === '0') return { streams: [] };
      try {
        const match = await imdb.resolve(type, id);
        if (!match) return { streams: [] };
        const internal = type === 'series' ? `nguonc:${match.slug}:ep:${match.episode}` : `nguonc:${match.slug}`;
        return await getStreams(type, internal, publicBaseUrl, opts);
      } catch (error) {
        logger.warn(`[NguonC] imdb ${id}: ${error.message}`);
        return { streams: [] };
      }
    }
    const parsed = parseMediaId(id);
    if (!parsed) return { streams: [] };
    if (type === 'series' && !parsed.episode) return { streams: [] };
    try {
      const data = await client.detail(parsed.slug);
      const movie = data?.movie || data?.data?.movie || data;
      if (!movie?.episodes) return { streams: [] };
      const streams = await buildStreams(movie, {
        episode: type === 'series' ? parsed.episode : null, resolver, playback, publicBaseUrl
      });
      // Watching an episode? Resolve the next ones in the background so "next episode" is instant.
      const ahead = Number(process.env.PREFETCH_NEXT_EPISODES ?? 2);
      if (type === 'series' && !opts.prefetch && ahead > 0) {
        setTimeout(async () => {
          for (let n = parsed.episode + 1; n <= parsed.episode + ahead; n++) {
            try { await getStreams('series', `nguonc:${parsed.slug}:ep:${n}`, null, { prefetch: true }); } catch {}
          }
        }, 0).unref?.();
      }
      return { streams };
    } catch (error) {
      logger.warn(`[NguonC] stream ${parsed.slug}: ${error.message}`);
      return { streams: [] };
    }
  }

  // Keep catalogs and the details of their first items hot so browsing does not
  // wait on the (slow, proxied) upstream. Called periodically from server.js.
  async function warm({ detailsPerCatalog = 15, streamsPerMovieCatalog = Number(process.env.WARM_STREAMS ?? 10),
                        concurrency = 3 } = {}) {
    const slugs = new Set();
    const movieIds = new Set();
    for (const c of CATALOGS) {
      const { metas } = await getCatalog(c.type, c.id, {});
      for (const m of metas.slice(0, detailsPerCatalog)) {
        const parsed = parseMediaId(m.id);
        if (parsed) slugs.add(parsed.slug);
      }
      if (c.type === 'movie') metas.slice(0, streamsPerMovieCatalog).forEach((m) => movieIds.add(m.id));
    }
    const queue = [...slugs];
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (queue.length) {
        const slug = queue.shift();
        try { await imdb.detail(slug); } catch {}
      }
    }));
    // Pre-resolve embeds for the top movies (no playback session is created here;
    // the resolver cache makes the real /stream request near-instant).
    const movies = [...movieIds];
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (movies.length) { try { await getStreams('movie', movies.shift(), null); } catch {} }
    }));
    return { catalogs: CATALOGS.length, details: slugs.size, streams: movieIds.size };
  }

  // Background pre-matching so the NguonC tab on IMDb titles is ready before it is opened:
  // index NguonC's newest uploads, match Cinemeta's popular titles, pre-resolve top streams.
  async function prematch({ streams = Number(process.env.IMDB_PREFETCH_STREAMS ?? 20) } = {}) {
    const indexed = await imdb.crawlNewest();
    const { checked, found } = await imdb.prefetchPopular();
    const queue = found.slice(0, streams);
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length) { const f = queue.shift(); try { await getStreams(f.type, f.id, null); } catch {} }
    }));
    return { indexed, totalIndexed: imdb.learned.size, checked, matched: found.length };
  }

  return { manifest, getCatalog, getDetail, getStreams, playback, warm, prematch, imdb };
}

module.exports = { CATALOGS, manifest, createAddon };
