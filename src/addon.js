'use strict';

const { NguoncApi, runInBackground } = require('./api');
const { preview, parseMediaId, detailMeta, typeOf } = require('./mapper');
const { EmbedResolver, buildStreams, hasEpisode } = require('./streams');
const { PlaybackStore } = require('./playback');
const { ImdbMatcher, parseImdbId, splitSeason } = require('./imdb');
const { SearchCatalog } = require('./search');
const { createExtraProviders } = require('./providers');

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

// A cached film detail that lacks the requested episode is refetched once it is older
// than this (new episodes air while the 1 h detail cache still holds the old list).
const STALE_EPISODE_MS = 120000;

function movieOf(data) { return data?.movie || data?.data?.movie || data; }

// Resolve to { value } or, after ms, to { timedOut: true }; the work itself keeps
// running (its caches warm up for the next request), it just no longer delays this one.
function settleWithin(promise, ms) {
  let timer;
  // Not unref'd: it is always cleared, and an unref'd race can let the process exit early.
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  return Promise.race([Promise.resolve(promise).then((value) => ({ value })), timeout])
    .finally(() => clearTimeout(timer));
}

function totalPages(body) {
  const p = pagination(body);
  return Number(p.total_page || p.totalPages) || 999;
}

function createAddon({ client = new NguoncApi(), resolver = new EmbedResolver(),
                       playback = new PlaybackStore(), logger = console, imdb = null,
                       extraProviders = null } = {}) {
  imdb ||= new ImdbMatcher({ client, logger });
  const providers = Array.isArray(extraProviders) ? extraProviders
    : createExtraProviders({ fetchImpl: client.fetchImpl, logger });
  const search = new SearchCatalog({ client, logger,
    maxPages: Number(process.env.SEARCH_MAX_PAGES) || 18,
    ttlMs: (Number(process.env.SEARCH_CACHE_SEC) || 90) * 1000 });
  function normalizeResult(items, catalog) {
    const targetType = catalog.type;
    const filtered = catalog.filter ? items.filter((item) => typeOf(item) === targetType) : items;
    return filtered.map((item) => preview(item, targetType)).filter(Boolean);
  }

  // Deepest `skip` served. Beyond it the catalog ends (empty page) instead of repeating
  // the last page, which made Stremio's endless scroll show the same titles again.
  const maxSkip = Number(process.env.CATALOG_MAX_SKIP) || 200;

  async function getCatalog(type, id, extra = {}) {
    const catalog = CATALOGS.find((c) => c.id === id && c.type === type);
    if (!catalog) return { metas: [] };
    const skip = Math.max(0, Number.parseInt(extra.skip, 10) || 0);
    if (skip > maxSkip) return { metas: [] };
    const keyword = String(extra.search || '').trim().slice(0, 120);
    const useSearch = !!keyword;

    try {
      if (useSearch) {
        const result = await search.get(keyword);
        const metas = normalizeResult(result.items.filter((item) => typeOf(item) === type), catalog)
          .slice(skip, skip + 15);
        if (!result.complete && !metas.length) {
          // A later page past the partial results is just the end for now (not cached).
          if (skip > 0) return { metas: [], cacheMaxAge: 0 };
          throw new Error('Search results temporarily incomplete');
        }
        return result.complete ? { metas } : { metas, cacheMaxAge: 0 };
      }
      if (catalog.filter) {
        // Walk a bounded number of upstream pages so filtered catalogs use
        // stable Stremio `skip` pagination without duplicated entries.
        const metas = [];
        const pageLimit = 18;
        const filteredMax = 260;
        if (skip >= filteredMax) return { metas: [] };
        const target = Math.min(filteredMax, skip + 15);
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
      if (page > totalPages(first)) return { metas: [] };
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
      if (!movie?.name) return { meta: null, cacheMaxAge: 60 };
      return { meta: detailMeta(movie, type, parsed.slug) };
    } catch (error) {
      // A title NguonC no longer has is a real "no meta". Anything else (timeout, 403,
      // 429, 5xx) must not be cached by clients as an empty page: let HTTP return 502.
      if (error.status === 404 || /Invalid film slug/.test(error.message)) return { meta: null, cacheMaxAge: 300 };
      logger.warn(`[NguonC] meta ${parsed.slug}: ${error.message}`);
      throw error;
    }
  }

  // opts.prefetch marks background pre-resolves (warm, prematch, next-episode prefetch):
  // NguonC only, no extra providers, no next-episode chaining, no stale-episode refetch.
  async function getStreams(type, id, publicBaseUrl = null, opts = {}) {
    const imdbParsed = parseImdbId(id);
    if (imdbParsed) {
      // IMDb title from Cinemeta/other catalogs: NguonC and the extra providers (VSMOV,
      // KKPhim) run in parallel, each bounded by PROVIDER_STREAM_TIMEOUT_MS.
      if (process.env.IMDB_MATCH === '0') return { streams: [] };
      if (type === 'series' && !imdbParsed.episode) return { streams: [] };
      const nguoncTask = (async () => {
        try {
          const match = await imdb.resolve(type, id);
          if (!match) return [];
          const internal = type === 'series' ? `nguonc:${match.slug}:ep:${match.episode}` : `nguonc:${match.slug}`;
          return (await getStreams(type, internal, publicBaseUrl, opts)).streams;
        } catch (error) {
          logger.warn(`[NguonC] imdb ${id}: ${error.message}`);
          return [];
        }
      })();
      if (opts.prefetch || !providers.length) return { streams: await nguoncTask };
      const metaPromise = Promise.resolve().then(() => imdb.cinemeta(type, imdbParsed.imdb)).catch(() => null);
      const localQueries = [];
      for (const slug of imdb.byImdb?.get?.(imdbParsed.imdb) || []) {
        const cached = client.cache?.get?.(`/film/${slug}`)?.value;
        const m = cached?.movie || cached?.data?.movie;
        const base = splitSeason(m?.name).base;
        if (base && !localQueries.includes(base)) localQueries.push(base);
      }
      const extraTasks = providers.map(async (p) => p.streamsForImdb(type, {
        imdb: imdbParsed.imdb, season: imdbParsed.season, episode: imdbParsed.episode,
        meta: await metaPromise, localQueries, resolver, playback, publicBaseUrl
      }));
      const labels = ['NguonC', ...providers.map((p) => p.label || p.id || 'provider')];
      const ms = Math.max(100, Number(process.env.PROVIDER_STREAM_TIMEOUT_MS) || 6000);
      const settled = await Promise.allSettled([nguoncTask, ...extraTasks].map((t) => settleWithin(t, ms)));
      let partial = false;
      // Order: NguonC first, then the providers in configured order (VSMOV, KKPhim).
      const lists = settled.map((r, i) => {
        if (r.status === 'rejected') {
          logger.warn(`[streams] ${labels[i]} ${id}: ${r.reason?.message || r.reason}`);
          return [];
        }
        if (r.value.timedOut) {
          partial = true;
          logger.warn(`[streams] ${labels[i]} ${id}: no answer within ${ms} ms, skipped`);
          return [];
        }
        return Array.isArray(r.value.value) ? r.value.value : [];
      });
      const seen = new Set();
      const streams = lists.flat().filter((s) => {
        if (!s?.url || seen.has(s.url)) return false;
        seen.add(s.url);
        return true;
      });
      // A source that timed out may answer on the next try (its work continues): no caching.
      return partial ? { streams, cacheMaxAge: 0 } : { streams };
    }
    const parsed = parseMediaId(id);
    if (!parsed) return { streams: [] };
    if (type === 'series' && !parsed.episode) return { streams: [] };
    try {
      let movie = movieOf(await client.detail(parsed.slug));
      if (type === 'series' && !opts.prefetch && !hasEpisode(movie, parsed.episode)) {
        // The cached detail predates this episode: refetch once (at most every 2 min).
        const fresher = movieOf(await client.detail(parsed.slug, { fresh: true, maxAgeMs: STALE_EPISODE_MS })
          .catch((e) => { logger.warn(`[NguonC] refresh ${parsed.slug}: ${e.message}`); return null; }));
        if (fresher?.episodes) movie = fresher;
      }
      if (!movie?.episodes) return { streams: [] };
      const streams = await buildStreams(movie, {
        episode: type === 'series' ? parsed.episode : null, resolver, playback, publicBaseUrl
      });
      // Watching an episode? Resolve the next ones in the background so "next episode" is
      // instant. NguonC ids only, so this never reaches the extra providers.
      const ahead = Number(process.env.PREFETCH_NEXT_EPISODES ?? 2);
      if (type === 'series' && !opts.prefetch && ahead > 0) {
        setTimeout(() => runInBackground(async () => {
          for (let n = parsed.episode + 1; n <= parsed.episode + ahead; n++) {
            try { await getStreams('series', `nguonc:${parsed.slug}:ep:${n}`, null, { prefetch: true }); } catch {}
          }
        }), 0).unref?.();
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
    // prefetch: NguonC only (no VSMOV/KKPhim), queued behind interactive API work.
    const movies = [...movieIds];
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (movies.length) {
        const id = movies.shift();
        try { await runInBackground(() => getStreams('movie', id, null, { prefetch: true })); } catch {}
      }
    }));
    return { catalogs: CATALOGS.length, details: slugs.size, streams: movieIds.size };
  }

  // Background pre-matching so the NguonC tab on IMDb titles is ready before it is opened:
  // index NguonC's newest uploads, match Cinemeta's popular titles, pre-resolve top streams.
  async function prematch({ streams = Number(process.env.IMDB_PREFETCH_STREAMS ?? 20) } = {}) {
    const indexed = await imdb.crawlNewest();
    const { checked, found } = await imdb.prefetchPopular();
    const queue = found.slice(0, streams);
    // prefetch: NguonC only (no VSMOV/KKPhim, no next-episode chain), background priority.
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (queue.length) {
        const f = queue.shift();
        try { await runInBackground(() => getStreams(f.type, f.id, null, { prefetch: true })); } catch {}
      }
    }));
    return { indexed, totalIndexed: imdb.learned.size, checked, matched: found.length };
  }

  return { manifest, getCatalog, getDetail, getStreams, playback, warm, prematch, imdb };
}

module.exports = { CATALOGS, manifest, createAddon };
