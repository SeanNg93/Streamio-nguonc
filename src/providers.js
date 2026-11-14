'use strict';

// Phim4K (VSMOV, vsmov.com/api) and KKPhim (phimapi.com) providers, adapted from
// henryhnguy/vietstream-nuvio-addon and wired into NguonC's IMDb matcher, playback
// store, and PNG-prefixed MPEG-TS stripping.

const { NguoncApi } = require('./api');
const { link, pickEpisode, serverList } = require('./mapper');
const { norm, splitSeason, titleVariants } = require('./imdb');
const { isSafeUrl, streamObject, hasEpisode } = require('./streams');

const STALE_EPISODE_MS = 120000;   // refetch a cached detail missing the episode once it is this old

const KKPHIM_API = 'https://phimapi.com';
const VSMOV_API = 'https://vsmov.com/api';

function listOf(body) {
  return Array.isArray(body?.items) ? body.items : Array.isArray(body?.data?.items) ? body.data.items : [];
}

function detectAudio(text, fallback = 'Vietsub') {
  const s = String(text || '').toLowerCase();
  if (/song\s*ng[uữ]/i.test(s)) return 'Song Ngữ';
  if (/thuy[eế]t\s*minh|\btm\b/i.test(s)) return 'Thuyết Minh';
  if (/l[oồ]ng\s*ti[eế]ng/i.test(s)) return 'Lồng Tiếng';
  if (/vietsub|ph[uụ]\s*[dđ][eề]|\bvs\b/i.test(s)) return 'Vietsub';
  return fallback;
}

// VSMOV's streamvsmov embed HTML defines `signedMasterUrl` (required when
// `enableSignedUrl: true`), `baseUrl` + `videoHash`, and a `subtitles` JSON array.
function parseVsmovEmbed(html, embedUrl) {
  if (typeof html !== 'string' || !html) return null;
  let origin = 'https://vsmov.com';
  try { origin = new URL(embedUrl).origin; } catch {}
  const signed = /\bsignedMasterUrl\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i.exec(html);
  const bm = /\bbaseUrl\s*=\s*["']([^"']+)["']/.exec(html);
  const vh = /\bvideoHash\s*=\s*["']([^"']+)["']/.exec(html);
  const anyM3u8 = /https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/i.exec(html);
  const playlistUrl = signed?.[1] ||
    (bm && vh ? `${bm[1].replace(/\/+$/, '')}/stream/${vh[1]}/master.m3u8` : anyM3u8?.[0] || null);
  if (!playlistUrl || !isSafeUrl(playlistUrl)) return null;
  const subtitles = [];
  const subMatch = /\bsubtitles\s*:\s*(\[[\s\S]{1,16384}?\])/.exec(html);
  if (subMatch) {
    try {
      for (const item of JSON.parse(subMatch[1])) {
        const url = link(item?.url, origin);
        if (!url || !isSafeUrl(url)) continue;
        const lang = String(item.code || item.lang || 'vie').toLowerCase();
        subtitles.push({ id: `vsmov-${lang}-${subtitles.length + 1}`, url, lang });
      }
    } catch {}
  }
  return { playlistUrl, videoHash: vh?.[1] || '', referer: embedUrl, subtitles };
}

class OPhimCompatibleProvider {
  constructor({ id, label, baseUrl, referer, searchPath, detailPath, proxiedPlaylist = false,
                api = null, fetchImpl = (...args) => fetch(...args), logger = console } = {}) {
    this.id = id;
    this.label = label;
    this.referer = referer;
    this.searchPath = searchPath;
    this.detailPath = detailPath;
    this.proxiedPlaylist = proxiedPlaylist;
    this.logger = logger;
    this.api = api || new NguoncApi({
      baseUrl, fetchImpl,
      timeoutMs: Number(process.env.PROVIDER_TIMEOUT_MS) || 7500,
      maxConcurrent: Number(process.env.PROVIDER_CONCURRENCY) || 4
    });
  }

  search(keyword, page = 1) {
    const q = String(keyword || '').trim().slice(0, 120);
    if (!q) return Promise.resolve({ items: [] });
    return this.api.get(this.searchPath(q, Math.max(1, Math.floor(page))), 300000);
  }

  detail(slug, { fresh = false, maxAgeMs = null } = {}) {
    if (!/^[a-z\d_-]{1,150}$/i.test(slug || '')) return Promise.resolve(null);
    return this.api.get(this.detailPath(slug), 1800000, { fresh, maxAgeMs }).then((body) => {
      const movie = body?.movie || body?.data?.movie;
      if (!movie) return null;
      const episodes = body?.episodes || body?.data?.episodes || movie.episodes || [];
      return { ...movie, episodes };
    });
  }

  // Pick matching candidate slugs from search results for a Cinemeta title.
  matchItems(items, { type, imdb, season, meta, localQueries = [] }) {
    const title = norm(meta?.name);
    const parts = String(meta?.name || '').split(/\s*[:\u2013]\s+|\s+-\s+/).map(norm).filter((x) => x.length >= 4);
    const aliases = new Set([title, ...parts, ...localQueries.map(norm)].filter(Boolean));
    const year = Number(String(meta?.year || meta?.releaseInfo || '').slice(0, 4)) || null;
    const videos = Array.isArray(meta?.videos) ? meta.videos : [];
    const seasonYear = (s) => {
      const ys = videos.filter((v) => Number(v.season) === s && v.released)
        .map((v) => new Date(v.released).getUTCFullYear()).filter(Boolean);
      return ys.length ? Math.min(...ys) : null;
    };
    const exact = [];
    const seasonless = [];
    for (const item of items) {
      if (!item?.slug) continue;
      const ownImdb = item.imdb?.id || null;
      const itemType = String(item.type || item.tmdb?.type || '').toLowerCase();
      const variants = titleVariants(item);
      const titled = variants.some((v) => aliases.has(v.full) || aliases.has(v.base));
      if (ownImdb ? ownImdb !== imdb : !titled) continue;
      const itemYear = Number(item.year) || null;
      const rank = (refYear) => [ownImdb ? 0 : 1, refYear && itemYear ? Math.abs(itemYear - refYear) : 0];
      if (type === 'movie') {
        if (['series', 'tv', 'tvshows'].includes(itemType)) continue;
        if (!ownImdb && year && itemYear && Math.abs(itemYear - year) > 1) continue;
        exact.push({ slug: item.slug, offset: 0, rank: rank(year) });
        continue;
      }
      if (['single', 'movie'].includes(itemType)) continue;
      const titleSeason = variants.find((v) => v.season)?.season ?? null;
      const rawSeason = Number(item.tmdb?.season) || null;
      // KKPhim/VSMOV file long-running shows under season 1 or 30; only trust a season
      // number > 1 from tmdb when the title has no explicit season marker.
      const itemSeason = titleSeason ?? (rawSeason && rawSeason > 1 && rawSeason <= 20 ? rawSeason : null);
      if (itemSeason !== null) {
        if (itemSeason !== season) continue;
        const sy = seasonYear(season);
        if (!ownImdb && sy && itemYear && Math.abs(itemYear - sy) > 1) continue;
        exact.push({ slug: item.slug, offset: 0, rank: rank(sy) });
        continue;
      }
      const start = seasonYear(1) || year;
      if (start && itemYear && Math.abs(itemYear - start) > 1) continue;
      const offset = season > 1 ? videos.filter((v) => Number(v.season) >= 1 && Number(v.season) < season).length : 0;
      seasonless.push({ slug: item.slug, offset, rank: rank(start) });
    }
    const sort = (arr) => arr.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
    return [...sort(exact), ...sort(seasonless)];
  }

  async findMatch(type, { imdb, season, meta, localQueries = [] }) {
    if (!meta?.name) return null;
    const parts = meta.name.split(/\s*[:\u2013]\s+|\s+-\s+/).map((x) => x.trim()).filter((x) => x.length >= 3);
    const queries = [...new Set([meta.name, ...parts, ...localQueries])].filter(Boolean).slice(0, 3);
    const seen = new Map();
    for (const q of queries) {
      try {
        for (const item of listOf(await this.search(q, 1))) if (item?.slug) seen.set(item.slug, item);
      } catch {}
    }
    return this.matchItems([...seen.values()], { type, imdb, season, meta, localQueries })[0] || null;
  }

  async resolveEpisode(ep, { movie, resolver, playback, publicBaseUrl }) {
    const direct = link(ep?.link_m3u8 || ep?.m3u8);
    if (direct && isSafeUrl(direct)) {
      return { url: direct, referer: this.referer, proxied: false };
    }
    const embed = link(ep?.link_embed || ep?.embed);
    if (!embed || !isSafeUrl(embed)) return null;
    try {
      const inner = new URL(embed).searchParams.get('url');
      if (inner && isSafeUrl(inner) && /\.m3u8(?:\?|$)/i.test(inner)) {
        return { url: inner, referer: this.referer, proxied: false };
      }
    } catch {}
    if (!this.proxiedPlaylist || !resolver || !playback || !publicBaseUrl) return null;
    const html = await resolver.fetchText(embed, { headers: { Referer: this.referer } });
    const parsed = parseVsmovEmbed(html?.text, embed);
    if (!parsed) return null;
    const m3u8 = await resolver.fetchText(parsed.playlistUrl, { headers: { Referer: embed } });
    if (!m3u8?.text?.startsWith('#EXTM3U')) return null;
    const id = playback.create({
      playlist: m3u8.text, playlistUrl: parsed.playlistUrl,
      referer: embed, videoHash: parsed.videoHash
    });
    if (!id) return null;
    return {
      url: `${publicBaseUrl.replace(/\/$/, '')}/play/${id}/index.m3u8`,
      referer: embed, proxied: true, subtitles: parsed.subtitles
    };
  }

  async streamsForImdb(type, { imdb, season, episode, meta, localQueries = [], resolver, playback, publicBaseUrl }) {
    try {
      const match = await this.findMatch(type, { imdb, season, meta, localQueries });
      if (!match) return [];
      let movie = await this.detail(match.slug);
      if (!movie?.episodes) return [];
      const epNum = type === 'series' ? match.offset + episode : null;
      if (type === 'series' && !hasEpisode(movie, epNum)) {
        // A new episode aired after the detail was cached (30 min TTL): refetch once, at
        // most every STALE_EPISODE_MS, instead of answering [] until the TTL runs out.
        const fresher = await this.detail(match.slug, { fresh: true, maxAgeMs: STALE_EPISODE_MS }).catch(() => null);
        if (fresher?.episodes) movie = fresher;
      }
      const servers = serverList(movie).slice(0, 6);
      const out = await Promise.all(servers.map(async (server) => {
        const ep = pickEpisode(server.items, epNum, type !== 'series');
        if (!ep) return null;
        const resolved = await this.resolveEpisode(ep, { movie, resolver, playback, publicBaseUrl });
        if (!resolved?.url) return null;
        const audio = detectAudio(server.name, detectAudio(movie.lang, 'Vietsub'));
        const stream = streamObject({
          url: resolved.url, provider: this.label, name: server.name.replace(/\s+/g, ' ').trim(),
          quality: movie.quality || 'HD', language: audio,
          referer: resolved.referer, proxied: resolved.proxied, noHeaders: !resolved.proxied
        });
        if (resolved.subtitles?.length) stream.subtitles = resolved.subtitles;
        return stream;
      }));
      return out.filter(Boolean);
    } catch (e) {
      this.logger.warn?.(`[${this.label}] ${imdb}: ${e.message}`);
      return [];
    }
  }
}

function createExtraProviders({ fetchImpl, logger = console } = {}) {
  const raw = process.env.EXTRA_PROVIDERS ?? 'vsmov,kkphim';
  const enabled = new Set(String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (enabled.has('0') || enabled.has('none') || enabled.has('off')) return [];
  const providers = [];
  if (enabled.has('vsmov') || enabled.has('phim4k')) {
    providers.push(new OPhimCompatibleProvider({
      id: 'vsmov', label: 'VSMOV',
      baseUrl: process.env.VSMOV_API_BASE || VSMOV_API,
      referer: 'https://vsmov.com/',
      searchPath: (q, p) => `/tim-kiem?keyword=${encodeURIComponent(q)}&page=${p}`,
      detailPath: (slug) => `/phim/${encodeURIComponent(slug)}`,
      proxiedPlaylist: true, fetchImpl, logger
    }));
  }
  if (enabled.has('kkphim')) {
    providers.push(new OPhimCompatibleProvider({
      id: 'kkphim', label: 'KKPhim',
      baseUrl: process.env.KKPHIM_API_BASE || KKPHIM_API,
      referer: 'https://phimapi.com/',
      searchPath: (q, p) => `/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}&page=${p}&limit=24`,
      detailPath: (slug) => `/phim/${encodeURIComponent(slug)}`,
      proxiedPlaylist: false, fetchImpl, logger
    }));
  }
  return providers;
}

module.exports = { OPhimCompatibleProvider, createExtraProviders, parseVsmovEmbed, detectAudio };
