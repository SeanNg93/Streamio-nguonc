'use strict';

const DEFAULT_API = 'https://phim.nguonc.com/api';

class NguoncApi {
  constructor({ baseUrl = process.env.NGUONC_API_BASE || DEFAULT_API,
                fetchImpl = (...args) => fetch(...args),
                timeoutMs = Number(process.env.API_TIMEOUT_MS) || 9000,
                maxCache = Number(process.env.API_CACHE_MAX) || 3000 } = {}) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol)) {
      throw new TypeError('NGUONC_API_BASE must be http(s)');
    }
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxCache = maxCache;
    this.cache = new Map();
  }

  async get(path, ttlMs = 120000) {
    if (!/^\/[a-zA-Z0-9_\-/]+(?:\?.*)?$/.test(path) || path.includes('..')) {
      throw new Error('Invalid API path');
    }
    const key = path;
    const old = this.cache.get(key);
    if (old && old.until > Date.now()) return old.promise;
    // Stale-while-revalidate: serve the last good value instantly, refresh in background.
    if (old && old.value !== undefined && !old.refreshing) {
      old.refreshing = true;
      this.fetchFresh(key, ttlMs).catch(() => { old.refreshing = false; });
      return old.value;
    }
    if (old && old.refreshing && old.value !== undefined) return old.value;
    return this.fetchFresh(key, ttlMs);
  }

  fetchFresh(key, ttlMs) {
    const previous = this.cache.get(key);
    const promise = (async () => {
      const url = `${this.baseUrl}${key}`;
      const response = await this.fetchImpl(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'NguonC-Stremio/1.0 (+personal-use)' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (!response.ok) throw new Error(`NguonC API HTTP ${response.status}`);
      const result = await response.json();
      if (result?.status === 'error' || result?.status === false) {
        throw new Error('NguonC API reported an error');
      }
      return result;
    })();
    const entry = { until: Date.now() + ttlMs, promise, value: previous?.value };
    if (previous?.value === undefined) this.cache.set(key, entry);
    promise.then((value) => {
      this.cache.delete(key);
      this.cache.set(key, { until: Date.now() + ttlMs, promise: Promise.resolve(value), value });
      while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
    }, () => {
      if (this.cache.get(key)?.promise === promise) this.cache.delete(key);
    });
    return promise;
  }

  list(category, page = 1) {
    const paths = {
      'phim-le': '/films/danh-sach/phim-le',
      'phim-bo': '/films/danh-sach/phim-bo',
      'hoat-hinh': '/films/danh-sach/hoat-hinh',
      'moi': '/films/phim-moi-cap-nhat'
    };
    if (!paths[category]) throw new Error('Unknown category');
    return this.get(`${paths[category]}?page=${Math.max(1, Math.floor(page))}`, 180000);
  }

  search(keyword, page = 1) {
    const q = String(keyword || '').trim().slice(0, 120);
    if (!q) return Promise.resolve({ items: [], paginate: { total_page: 0 } });
    return this.get(`/films/search?keyword=${encodeURIComponent(q)}&page=${Math.max(1, Math.floor(page))}`, 90000);
  }

  detail(slug) {
    if (!/^[a-z\d_-]{1,150}$/i.test(slug)) throw new Error('Invalid film slug');
    return this.get(`/film/${slug}`, 3600000);
  }
}

module.exports = { NguoncApi, DEFAULT_API };
