'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

const DEFAULT_API = 'https://phim.nguonc.com/api';
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

class NguoncApi {
  constructor({ baseUrl = process.env.NGUONC_API_BASE || DEFAULT_API,
                fetchImpl = (...args) => fetch(...args),
                timeoutMs = Number(process.env.API_TIMEOUT_MS) || 9000,
                maxCache = Number(process.env.API_CACHE_MAX) || 3000,
                maxConcurrent = Number(process.env.API_CONCURRENCY) || 4,
                maxQueue = 32, retryDelayMs = 300, failureBackoffMs = 15000,
                maxStaleMs = 6 * 3600000 } = {}) {
    const url = new URL(baseUrl);
    if (!['https:', 'http:'].includes(url.protocol)) throw new TypeError('NGUONC_API_BASE must be http(s)');
    this.baseUrl = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.maxCache = maxCache;
    this.maxConcurrent = Number.isFinite(maxConcurrent) ? Math.max(1, Math.min(16, Math.floor(maxConcurrent))) : 4;
    this.maxQueue = Number.isFinite(maxQueue) ? Math.max(0, Math.min(128, Math.floor(maxQueue))) : 32;
    this.retryDelayMs = retryDelayMs;
    this.failureBackoffMs = failureBackoffMs; this.maxStaleMs = maxStaleMs;
    this.cache = new Map(); this.inflight = new Map(); this.active = 0; this.queue = [];
  }

  async get(path, ttlMs = 120000, { fresh = false } = {}) {
    if (!/^\/[a-zA-Z0-9_\-/]+(?:\?.*)?$/.test(path) || path.includes('..')) throw new Error('Invalid API path');
    const old = this.cache.get(path);
    const now = Date.now();
    if (old?.value !== undefined) {
      if (old.until > now) return old.value;
      if (!fresh && now - old.at < this.maxStaleMs) {
        if (!this.inflight.has(path) && !(old.retryAt > now)) this.fetchFresh(path, ttlMs).catch(() => {});
        return old.value;
      }
    }
    if (old?.error && old.retryAt > now) throw old.error;
    return this.inflight.get(path) || this.fetchFresh(path, ttlMs);
  }

  trimCache() {
    while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
  }

  fetchFresh(key, ttlMs) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const previous = this.cache.get(key);
    const promise = this.request(key).then((value) => {
      const now = Date.now();
      this.cache.delete(key);
      this.cache.set(key, { until: now + ttlMs, at: now, value });
      this.trimCache();
      return value;
    }).catch((error) => {
      // Preserve the last good page; do not replace it with a failed refresh.
      this.cache.set(key, { ...previous, error, retryAt: Date.now() + this.failureBackoffMs });
      this.trimCache();
      throw error;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async acquire(signal) {
    signal.throwIfAborted();
    if (this.active < this.maxConcurrent) { this.active++; return; }
    if (this.queue.length >= this.maxQueue) throw new Error('NguonC API request queue full');
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }
  release() {
    while (this.queue.length) {
      const waiter = this.queue.shift();
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      waiter.resolve(); // Transfer this slot rather than decrementing/incrementing.
      return;
    }
    this.active--;
  }

  async request(key) {
    // Queue wait, network I/O, and the single retry share one deadline.
    const signal = AbortSignal.timeout(this.timeoutMs);
    await this.acquire(signal);
    try {
      signal.throwIfAborted();
      for (let attempt = 0; attempt < 2; attempt++) {
        let delay = this.retryDelayMs;
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${key}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'NguonC-Stremio/1.0 (+personal-use)' }, signal
          });
          if (!response.ok) {
            const error = new Error(`NguonC API HTTP ${response.status}`);
            error.status = response.status;
            const after = response.headers?.get?.('retry-after');
            if (after) {
              const seconds = Number(after);
              const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
              if (Number.isFinite(wait)) delay = Math.max(delay, wait);
            }
            await response.body?.cancel?.().catch(() => {});
            throw error;
          }
          const result = await response.json();
          if (result?.status === 'error' || result?.status === false) throw new Error('NguonC API reported an error');
          return result;
        } catch (error) {
          const transient = TRANSIENT.has(error.status) || (error instanceof TypeError && !error.status);
          if (attempt || !transient || signal.aborted || delay > 1500) throw error;
          if (delay > 0) await sleep(delay, undefined, { signal });
          signal.throwIfAborted();
        }
      }
    } finally { this.release(); }
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

  search(keyword, page = 1, options = {}) {
    const q = String(keyword || '').trim().slice(0, 120);
    if (!q) return Promise.resolve({ items: [], paginate: { total_page: 0 } });
    return this.get(`/films/search?keyword=${encodeURIComponent(q)}&page=${Math.max(1, Math.floor(page))}`, 90000, options);
  }

  detail(slug) {
    if (!/^[a-z\d_-]{1,150}$/i.test(slug)) throw new Error('Invalid film slug');
    return this.get(`/film/${slug}`, 3600000);
  }
}

module.exports = { NguoncApi, DEFAULT_API };
