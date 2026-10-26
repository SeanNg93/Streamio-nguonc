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
      for (const [k, v] of Object.entries(data.matches || {})) this.matches.set(k, v);
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
          matches: Object.fromEntries(this.matches), learned: Object.fromEntries(this.learned)
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

  match(type, imdb, season = null) {
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
      if (Date.now() - entry.at > ttl) refresh();   // stale: answer now, refresh in background
      return Promise.resolve(entry.film);
    }
    return refresh();
  }

  async findFilm(type, { imdb, season }) {
    const meta = await this.cinemeta(type, imdb);
    // Index first: films already known to carry this IMDb id need no search.
    const known = [...(this.byImdb.get(imdb) || [])];
    const film = known.length ? await this.pick(type, imdb, season, meta, known) : null;
    if (film) return film;
    if (!meta?.name) return null;

    const queries = [...new Set([meta.name, meta.name.replace(/[:\-\u2013].*$/, '').trim()])].filter(Boolean);
    const seen = new Map();
    for (const q of queries) {
      try { for (const item of listItems(await this.client.search(q, 1))) if (item?.slug) seen.set(item.slug, item); } catch {}
      if (seen.size >= 10) break;
    }
    if (!seen.size) return null;
    const title = norm(meta.name);
    const score = (item) => {
      const names = [norm(item.original_name), norm(item.name)];
      if (names.includes(title)) return 3;
      return names.some((n) => n && (n.includes(title) || title.includes(n))) ? 2 : 1;
    };
    const slugs = [...seen.values()].sort((a, b) => score(b) - score(a)).slice(0, 10).map((i) => i.slug);
    return this.pick(type, imdb, season, meta, slugs);
  }

  async pick(type, imdb, season, meta, slugs) {
    const title = norm(meta?.name);
    const year = Number(String(meta?.year || meta?.releaseInfo || '').slice(0, 4)) || null;
    const details = await Promise.all(slugs.map((s) => this.detail(s).catch(() => null)));
    let seasonless = null;
    for (const m of details) {
      if (!m?.slug) continue;
      const ownImdb = m.imdb?.id || null;
      const filmYear = Number(yearOf(m)) || null;
      const exactTitle = !!title && (norm(m.original_name) === title || norm(m.name) === title);
      const yearOk = !year || !filmYear || Math.abs(filmYear - year) <= 1;
      const accepted = ownImdb ? ownImdb === imdb : (exactTitle && yearOk);
      if (!accepted) continue;
      const tmdbType = m.tmdb?.type || null;
      const episodeCount = Math.max(0, ...(m.episodes || []).map((s) => (s.items || []).length));
      if (type === 'movie') {
        if (tmdbType === 'tv' || episodeCount > 1) continue;
        return { slug: m.slug, offset: 0 };
      }
      if (tmdbType === 'movie') continue;
      const filmSeason = m.tmdb?.season ?? null;
      if (filmSeason === season) return { slug: m.slug, offset: 0 };
      if (filmSeason === null && !seasonless) seasonless = m;
    }
    if (!seasonless) return null;
    if (season === 1) return { slug: seasonless.slug, offset: 0 };
    // Season-less entry with continuous numbering: episodes of earlier seasons come first.
    const videos = Array.isArray(meta?.videos) ? meta.videos : [];
    const earlier = videos.filter((v) => Number(v.season) >= 1 && Number(v.season) < season).length;
    return earlier ? { slug: seasonless.slug, offset: earlier } : null;
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
        if (await this.match('movie', imdb)) found.push({ type, id: imdb });
        return;
      }
      const meta = await this.cinemeta('series', imdb);
      const seasons = [...new Set((meta?.videos || []).map((v) => Number(v.season)).filter((s) => s >= 1))]
        .sort((a, b) => a - b).slice(0, maxSeasons);
      for (const s of seasons.length ? seasons : [1]) {
        if (await this.match('series', imdb, s)) found.push({ type, id: `${imdb}:${s}:1` });
      }
    });
    return { checked: ids.length, found };
  }
}

module.exports = { ImdbMatcher, parseImdbId, norm };
