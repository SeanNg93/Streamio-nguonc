'use strict';

// Map Stremio IMDb ids (tt123 for movies, tt123:S:E for episodes) to NguonC films.
//
// Matching: a NguonC film is accepted only when its own `imdb.id` equals the
// requested id (or, if NguonC has no IMDb id for it, an exact original-title +
// year match). Series seasons use NguonC's `tmdb.season`; a season-less
// long-running entry is mapped with absolute numbering from Cinemeta's episodes.
//
// Speed: everything slow happens in the background.
//  - `learned`: IMDb -> NguonC index built from film details we have seen and from
//    crawling NguonC's newest uploads, so most lookups need no search at all.
//  - `matches`: results are persisted to disk and served stale-while-revalidate,
//    so after the first lookup a viewer never waits for a refresh.
//  - `prefetchPopular()`: pre-matches Cinemeta's popular movies and series.

const fs = require('node:fs');
const path = require('node:path');
const { yearOf } = require('./mapper');

const CINEMETA = (process.env.CINEMETA_URL || 'https://v3-cinemeta.strem.io').replace(/\/$/, '');
const HIT_TTL = 6 * 60 * 60 * 1000;
const MISS_TTL = 60 * 60 * 1000;

function parseImdbId(id) {
  const m = /^(tt\d{3,10})(?::(\d{1,4}):(\d{1,5}))?$/.exec(id || '');
  return m ? { imdb: m[1], season: m[2] ? Number(m[2]) : null, episode: m[3] ? Number(m[3]) : null } : null;
}

function norm(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Season marker in a title, e.g. "Jujutsu Kaisen (Season 2)", "Chú Thuật Hồi Chiến (Phần 2)",
// "Jujutsu Kaisen 3rd Season", "Season 2". Works on norm()-ed text.
const SEASON_PATTERNS = [
  /^(.*?)\s*\b(?:season|phan|mua)\s+(\d{1,2})$/,
  /^(.*?)\s*\b(\d{1,2})(?:st|nd|rd|th)\s+season$/,
  /^(.*?)\s*\bs(\d{1,2})$/
];

function splitSeason(text) {
  const n = norm(text);
  for (const re of SEASON_PATTERNS) {
    const m = re.exec(n);
    if (m && Number(m[2]) >= 1) return { base: m[1].trim(), season: Number(m[2]) };
  }
  return { base: n, season: null };
}

// Every title a NguonC film goes by: name plus each comma-separated original name
// (anime entries often list several, e.g. "Jujutsu Kaisen 0, Gekijouban Jujutsu Kaisen 0").
function titleVariants(movie) {
  const orig = String(movie?.original_name || movie?.origin_name || '');
  // Whole name too: "/" separates alt names but also belongs to titles like "Fate/Zero".
  const raw = [movie?.name, orig, ...orig.split(/\s*[,;|/]\s*/)];
  return raw.map((t) => ({ full: norm(t), ...splitSeason(t) })).filter((v) => v.full);
}

function listItems(body) {
  return Array.isArray(body?.items) ? body.items : Array.isArray(body?.data?.items) ? body.data.items : [];
}

function movieOf(data) { return data?.movie || data?.data?.movie || null; }

async function pool(items, concurrency, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) { const item = queue.shift(); try { await fn(item); } catch {} }
  }));
}

class ImdbMatcher {
  constructor({ client, fetchImpl = (...args) => fetch(...args), logger = console, timeoutMs = 8000,
                dataFile = process.env.IMDB_CACHE_FILE || null } = {}) {
    this.client = client;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.metaCache = new Map();      // `${type}:${imdb}` -> { until, promise }
    this.matches = new Map();        // `${type}:${imdb}:${season}` -> { at, film|null }
    this.inflight = new Map();
    this.learned = new Map();        // slug -> { imdb, season, kind }
    this.byImdb = new Map();         // imdb -> Set(slug)
    this.dataFile = dataFile;
    this.load();
  }

  // ---------- persistence ----------
  load() {
    if (!this.dataFile) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      // v3 matcher (season titles, multi-page search): forget older misses.
      for (const [k, v] of Object.entries(data.matches || {})) if (v?.film || data.version >= 4) this.matches.set(k, v);
      for (const [slug, v] of Object.entries(data.learned || {})) {
        if (v?.imdb) this.remember(slug, v); else this.learned.set(slug, { imdb: null });
      }
      this.logger.log(`[imdb] loaded ${this.matches.size} matches, ${this.learned.size} indexed films`);
    } catch (e) { if (e.code !== 'ENOENT') this.logger.warn(`[imdb] cache load failed: ${e.message}`); }
  }

  save() {
    if (!this.dataFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        const tmp = `${this.dataFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
          version: 4, matches: Object.fromEntries(this.matches), learned: Object.fromEntries(this.learned)
        }));
        fs.renameSync(tmp, this.dataFile);
      } catch (e) { this.logger.warn(`[imdb] cache save failed: ${e.message}`); }
    }, 5000);
    this.saveTimer.unref?.();
  }

  // ---------- IMDb -> NguonC index ----------
  remember(slug, { imdb, season = null, kind = null }) {
    if (!slug || !/^tt\d+$/.test(imdb || '')) return;
    this.learned.set(slug, { imdb, season, kind });
    if (!this.byImdb.has(imdb)) this.byImdb.set(imdb, new Set());
    this.byImdb.get(imdb).add(slug);
  }

  learn(movie) {
    if (!movie?.slug) return;
    const imdb = movie.imdb?.id;
    const before = this.learned.get(movie.slug);
    if (!imdb) {
      if (!before) { this.learned.set(movie.slug, { imdb: null }); this.save(); }
      return;
    }
    this.remember(movie.slug, { imdb, season: movie.tmdb?.season ?? null, kind: movie.tmdb?.type || null });
    if (before?.imdb !== imdb) this.save();
  }

  async detail(slug) {
    const movie = movieOf(await this.client.detail(slug));
    this.learn(movie);
    return movie;
  }

  // Walk NguonC's newest uploads and index any film we have not seen yet.
  async crawlNewest(pages = Number(process.env.IMDB_INDEX_PAGES) || 20) {
    let fresh = 0;
    for (let page = 1; page <= pages; page++) {
      let items = [];
      try { items = listItems(await this.client.list('moi', page)); } catch { break; }
      if (!items.length) break;
      const unseen = items.filter((i) => i?.slug && !this.learned.has(i.slug));
      await pool(unseen, 2, async (i) => { await this.detail(i.slug); fresh++; });
    }
    if (fresh) this.save();
    return fresh;
  }

  // ---------- Cinemeta ----------
  cinemeta(type, imdb) {
    const key = `${type}:${imdb}`;
    const hit = this.metaCache.get(key);
    if (hit && hit.until > Date.now()) return hit.promise;
    const promise = (async () => {
      const r = await this.fetchImpl(`${CINEMETA}/meta/${type}/${imdb}.json`,
        { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
      if (!r.ok) return null;
      return (await r.json())?.meta || null;
    })().catch(() => null);
    this.metaCache.set(key, { until: Date.now() + 24 * HIT_TTL, promise });
    promise.then((v) => { const e = this.metaCache.get(key); if (!v && e?.promise === promise) e.until = Date.now() + MISS_TTL; });
    if (this.metaCache.size > 3000) this.metaCache.delete(this.metaCache.keys().next().value);
    return promise;
  }

  // ---------- matching ----------
  // Returns { slug, episode } (episode null for movies) or null.
  async resolve(type, id) {
    const parsed = parseImdbId(id);
    if (!parsed) return null;
    if (type === 'series' && !parsed.episode) return null;
    const film = await this.match(type, parsed.imdb, parsed.season);
    if (!film) return null;
    return type === 'series' ? { slug: film.slug, episode: film.offset + parsed.episode }
      : { slug: film.slug, episode: null };
  }

  match(type, imdb, season = null, { waitForRefresh = false } = {}) {
    const key = `${type}:${imdb}:${type === 'series' ? season ?? '' : ''}`;
    const entry = this.matches.get(key);
    const refresh = () => {
      if (this.inflight.has(key)) return this.inflight.get(key);
      const p = this.findFilm(type, { imdb, season }).catch(() => undefined).then((film) => {
        this.inflight.delete(key);
        if (film === undefined) return entry?.film ?? null;   // network error: keep old answer
        this.matches.delete(key);
        this.matches.set(key, { at: Date.now(), film });
        while (this.matches.size > 20000) this.matches.delete(this.matches.keys().next().value);
        this.save();
        return film;
      });
      this.inflight.set(key, p);
      return p;
    };
    if (entry) {
      const ttl = entry.film ? HIT_TTL : MISS_TTL;
      if (Date.now() - entry.at > ttl) {
        const pending = refresh();
        // Background workers must await refresh to keep their pool genuinely bounded.
        // Interactive lookups still return the cached answer immediately.
        // A stale miss is re-checked before answering: serving it would hide a title
        // that NguonC added (or that only failed transiently) for another hour.
        if (waitForRefresh || !entry.film) return pending;
      }
      return Promise.resolve(entry.film);
    }
    return refresh();
  }

  async findFilm(type, { imdb, season }) {
    const meta = await this.cinemeta(type, imdb);
    // Index first: films already known to carry this IMDb id need no search.
    // Only an exact season hit short-circuits; season-less guesses are compared against search results.
    const known = [...(this.byImdb.get(imdb) || [])];
    const strip = (f) => f && { slug: f.slug, offset: f.offset };
    const film = known.length ? await this.pick(type, imdb, season, meta, known).catch(() => null) : null;
    if (film?.exact) return strip(film);
    if (!meta?.name) return strip(film);

    // "Demon Slayer: Kimetsu no Yaiba" -> also search each side of the colon.
    const parts = meta.name.split(/\s*[:\u2013]\s+|\s+-\s+/).map((x) => x.trim()).filter((x) => x.length >= 3);
    // "Steins; Gate" (Cinemeta) is "Steins;Gate" upstream, and its search is literal.
    const queries = [...new Set([meta.name, meta.name.replace(/([;:,.!?])\s+/g, '$1'), ...parts])].filter(Boolean);
    const seen = new Map();
    let failed = false;   // an upstream error must not be cached as "not on NguonC"
    const title = norm(meta.name);
    const aliases = new Set([title, ...parts.map(norm)].filter((x) => x.split(' ').length >= 2 || x.length >= 6));
    const maxPages = Math.max(1, Number(process.env.IMDB_SEARCH_PAGES) || 8);
    // Walk every result page (bounded): popular franchises bury the TV entry, e.g. the
    // One Piece series sits on page 4 behind ~30 movies and specials.
    const walk = async (q) => {
      let first;
      try { first = await this.client.search(q, 1); } catch { failed = true; return; }
      for (const item of listItems(first)) if (item?.slug) seen.set(item.slug, item);
      const p = first?.paginate || first?.pagination || first?.data?.params?.pagination || {};
      const total = Math.min(maxPages, Number(p.total_page ?? p.totalPages) || 1);
      for (let page = 2; page <= total; page += 2) {
        const pages = [page, page + 1].filter((n) => n <= total);
        const bodies = await Promise.allSettled(pages.map((n) => this.client.search(q, n)));
        for (const b of bodies) {
          if (b.status !== 'fulfilled') { failed = true; continue; }
          for (const item of listItems(b.value)) if (item?.slug) seen.set(item.slug, item);
        }
      }
    };
    const score = (item) => {
      const vs = titleVariants(item);
      if (vs.some((v) => v.full === title)) return 4;
      if (vs.some((v) => v.base === title || aliases.has(v.base))) return 3;
      return vs.some((v) => v.full.includes(title) || title.includes(v.full)) ? 2 : 1;
    };
    const candidates = () => [...new Set([...known,
      ...[...seen.values()].sort((a, b) => score(b) - score(a)).slice(0, 12).map((i) => i.slug)])];
    for (const q of queries) await walk(q);
    let found = seen.size || known.length ? await this.pick(type, imdb, season, meta, candidates(), aliases) : null;
    if (type === 'series' && !found?.exact) {
      // Other seasons of the same show (matched by IMDb id) reveal its local titles,
      // e.g. "Duoc Su Tu Su (Phan 3)" -> search "duoc su tu su" to find Phan 1.
      const local = new Set();
      for (const slug of candidates()) {
        const m = await this.detail(slug).catch(() => null);
        if (m?.imdb?.id !== imdb) continue;
        for (const v of titleVariants(m)) if (v.season && v.base && !aliases.has(v.base) && !queries.includes(v.base)) local.add(v.base);
      }
      const extra = [...local].slice(0, 2);
      if (extra.length) {
        for (const q of extra) { aliases.add(q); await walk(q); }
        found = await this.pick(type, imdb, season, meta, candidates(), aliases) || found;
      }
    }
    if (!found && failed) throw new Error('search incomplete');
    return strip(found);
  }

  async pick(type, imdb, season, meta, slugs, aliases = new Set([norm(meta?.name)])) {
    const title = norm(meta?.name);
    const year = Number(String(meta?.year || meta?.releaseInfo || '').slice(0, 4)) || null;
    const videos = Array.isArray(meta?.videos) ? meta.videos : [];
    // Year the requested season started airing (season entries carry their own year).
    const seasonYear = (s) => {
      const ys = videos.filter((v) => Number(v.season) === s && v.released)
        .map((v) => new Date(v.released).getUTCFullYear()).filter(Boolean);
      return ys.length ? Math.min(...ys) : null;
    };
    let detailFailed = false;
    // Few at a time: ten parallel details per lookup overflowed the shared API queue.
    const details = new Array(slugs.length).fill(null);
    await pool(slugs.map((s, i) => [s, i]), 3, async ([s, i]) => {
      details[i] = await this.detail(s).catch(() => { detailFailed = true; return null; });
    });
    const live = (m) => titleVariants(m).some((v) => /\blive action\b/.test(v.full));
    const exact = [];
    const seasonless = [];
    for (const m of details) {
      if (!m?.slug) continue;
      const ownImdb = m.imdb?.id || null;
      const filmYear = Number(yearOf(m)) || null;
      const variants = titleVariants(m);
      const titled = !!title && variants.some((v) => v.full === title || v.base === title || aliases.has(v.full) || aliases.has(v.base));
      if (ownImdb ? ownImdb !== imdb : !titled) continue;
      const tmdbType = m.tmdb?.type || null;
      const episodeCount = Math.max(0, ...(m.episodes || []).map((s) => (s.items || []).length));
      const rank = (refYear) => [ownImdb ? 0 : 1, live(m) ? 1 : 0, refYear && filmYear ? Math.abs(filmYear - refYear) : 0];
      if (type === 'movie') {
        if (tmdbType === 'tv' || episodeCount > 1) continue;
        if (!ownImdb && year && filmYear && Math.abs(filmYear - year) > 1) continue;
        exact.push({ m, rank: rank(year) });
        continue;
      }
      if (tmdbType === 'movie') continue;
      // NguonC often has an IMDb id but no tmdb.season; the title still says "Season 3".
      const filmSeason = m.tmdb?.season ?? variants.find((v) => v.season)?.season ?? null;
      if (filmSeason !== null) {
        if (filmSeason !== season) continue;
        const sy = seasonYear(season);
        if (!ownImdb && sy && filmYear && Math.abs(filmYear - sy) > 1) continue;
        exact.push({ m, rank: rank(sy) });
        continue;
      }
      // Season-less entry: must start when the show started (rejects a later arc filed
      // under the show's IMDb id, e.g. Tokyo Revengers "Santen Sensou-hen" 2026).
      const start = seasonYear(1) || year;
      if (start && filmYear && Math.abs(filmYear - start) > 1) continue;
      seasonless.push({ m, rank: rank(start), episodeCount });
    }
    const best = (list) => list.sort((a, b) => {
      for (let i = 0; i < 3; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
      return 0;
    })[0];
    const hit = best(exact);
    if (hit) return { slug: hit.m.slug, offset: 0, exact: true };
    const pickSeasonless = (offset) => best(seasonless.filter((c) => !c.episodeCount || c.episodeCount > offset));
    if (season === 1 || type === 'movie') {
      const c = type === 'series' ? pickSeasonless(0) : null;
      if (c) return { slug: c.m.slug, offset: 0 };
    } else if (season > 1) {
      // Continuous numbering: episodes of earlier seasons come first.
      const earlier = videos.filter((v) => Number(v.season) >= 1 && Number(v.season) < season).length;
      const c = earlier ? pickSeasonless(earlier) : null;
      if (c) return { slug: c.m.slug, offset: earlier };
    }
    if (detailFailed) throw new Error('detail failed');
    return null;
  }

  // ---------- background pre-matching ----------
  async popularIds() {
    const out = [];
    for (const type of ['movie', 'series']) {
      try {
        const r = await this.fetchImpl(`${CINEMETA}/catalog/${type}/top.json`,
          { signal: AbortSignal.timeout(this.timeoutMs), redirect: 'follow' });
        const metas = r.ok ? (await r.json())?.metas || [] : [];
        for (const m of metas) if (/^tt\d+$/.test(m?.id || '')) out.push({ type, imdb: m.id });
      } catch {}
    }
    return out;
  }

  // Match Cinemeta's popular titles (every season of series) before anyone opens them.
  async prefetchPopular({ maxSeasons = 12 } = {}) {
    const ids = await this.popularIds();
    const found = [];
    await pool(ids, 2, async ({ type, imdb }) => {
      if (type === 'movie') {
        if (await this.match('movie', imdb, null, { waitForRefresh: true })) found.push({ type, id: imdb });
        return;
      }
      const meta = await this.cinemeta('series', imdb);
      const seasons = [...new Set((meta?.videos || []).map((v) => Number(v.season)).filter((s) => s >= 1))]
        .sort((a, b) => a - b).slice(0, maxSeasons);
      for (const s of seasons.length ? seasons : [1]) {
        if (await this.match('series', imdb, s, { waitForRefresh: true })) found.push({ type, id: `${imdb}:${s}:1` });
      }
    });
    return { checked: ids.length, found };
  }
}

module.exports = { ImdbMatcher, parseImdbId, norm, splitSeason, titleVariants };
