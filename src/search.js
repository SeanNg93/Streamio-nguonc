'use strict';

const { htmlText, slugOf } = require('./mapper');

function queryKey(value) {
  return String(value || '').normalize('NFC').trim().replace(/\s+/gu, ' ').slice(0, 120).toLowerCase();
}
function words(value) {
  return htmlText(String(value || '')).normalize('NFC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function fold(value) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
}
function phrase(title, query) { return ` ${title} `.includes(` ${query} `); }
function allTokens(title, query) {
  const tokens = new Set(title.split(' '));
  return query.split(' ').every((token) => tokens.has(token));
}
function score(title, query) {
  if (!title || !query) return 0;
  if (title === query) return 1000;
  if (phrase(title, query)) return 900;
  if (allTokens(title, query)) return 700;
  const ft = fold(title); const fq = fold(query);
  if (ft === fq) return 600;
  if (phrase(ft, fq)) return 500;
  if (allTokens(ft, fq)) return 300;
  return 0;
}
function rankItems(items, keyword) {
  const query = words(keyword);
  return items.map((item) => ({ item, score: Math.max(
    score(words(item.name), query), score(words(item.original_name), query), score(words(item.origin_name), query)
  ) })).sort((a, b) => b.score - a.score).map(({ item }) => item);
}
function itemsOf(body) {
  const items = body?.items ?? body?.data?.items;
  if (!Array.isArray(items)) throw new Error('Invalid NguonC search response');
  return items;
}
function pagesOf(body, count) {
  const p = body?.paginate || body?.pagination || body?.data?.params?.pagination || {};
  const total = Number(p.total_page ?? p.totalPages);
  if (Number.isFinite(total) && total >= 0) return Math.max(1, Math.floor(total));
  const size = Number(p.items_per_page ?? p.itemsPerPage) || 10;
  return count < size ? 1 : 18;
}

// One ranked candidate set per query, shared by all catalog rows and skip pages.
// Keep the last complete answer through outages. Incomplete answers are never cached.
class SearchCatalog {
  constructor({ client, logger = console, ttlMs = 90000, staleMs = 6 * 3600000,
                maxCache = 300, maxPages = 18 } = {}) {
    this.client = client; this.logger = logger; this.ttlMs = ttlMs; this.staleMs = staleMs;
    this.maxCache = maxCache; this.maxPages = maxPages;
    this.cache = new Map(); this.inflight = new Map();
  }

  async get(keyword) {
    const key = queryKey(keyword);
    if (!key) return { items: [], complete: true };
    const old = this.cache.get(key);
    const now = Date.now();
    if (old && old.until > now) return old.result;
    if (old && now - old.at < this.staleMs) {
      if (!this.inflight.has(key) && !(old.retryAt > now)) this.refresh(key, old).catch(() => {});
      return { ...old.result, complete: false };
    }
    return this.inflight.get(key) || this.refresh(key, null);
  }

  refresh(key, old) {
    const promise = this.collect(key).then((result) => {
      if (result.complete) {
        const now = Date.now();
        this.cache.delete(key);
        this.cache.set(key, { result, at: now, until: now + this.ttlMs });
        while (this.cache.size > this.maxCache) this.cache.delete(this.cache.keys().next().value);
      } else if (old) old.retryAt = Date.now() + 15000;
      return result;
    }).catch((error) => {
      if (old) old.retryAt = Date.now() + 15000;
      throw error;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async collect(key) {
    const first = await this.client.search(key, 1, { fresh: true });
    const candidates = itemsOf(first).slice();
    const total = Math.min(this.maxPages, pagesOf(first, candidates.length));
    let complete = true;
    // Read page 1 before scheduling any others. Never speculate beyond total_page.
    // At most two more pages at once, even when all five Stremio rows request search.
    for (let page = 2; page <= total && candidates.length; page += 2) {
      const numbers = [page, page + 1].filter((n) => n <= total);
      const results = await Promise.allSettled(numbers.map(async (n) => itemsOf(await this.client.search(key, n, { fresh: true }))));
      for (const result of results) {
        if (result.status === 'fulfilled') candidates.push(...result.value);
        else { complete = false; this.logger.warn(`[NguonC] partial search: ${result.reason.message}`); }
      }
      if (!complete) break; // Do not amplify an upstream outage with more requests.
    }
    const seen = new Set();
    const unique = candidates.filter((item) => {
      const slug = slugOf(item);
      if (!slug || seen.has(slug)) return false;
      seen.add(slug); return true;
    });
    return { items: rankItems(unique, key), complete };
  }
}

module.exports = { SearchCatalog, queryKey, rankItems };
