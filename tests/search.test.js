'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAddon } = require('../src/addon');
const { createServer } = require('../src/http');
const { NguoncApi } = require('../src/api');
const { SearchCatalog } = require('../src/search');
const silent = { warn() {}, error() {}, log() {} };
const season = (n) => ({ slug: `de-che-dai-han-phan-${n}`, name: `Đế Chế Đại Hàn (Phần ${n})`,
  original_name: `Made in Korea (Season ${n})`, total_episodes: 6 });
const noise = (n) => ({ slug: `noise-${n}`, name: `Đại Chiến ${n}`, total_episodes: 8 });
const page = (items, total = 1, size = 10) => ({ items, paginate: { total_page: total, items_per_page: size } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeAddon(client) { return createAddon({ client, logger: silent, imdb: {} }); }

test('Partial Vietnamese title ranks literal phrase ahead of loose and accent-folded matches across pages', async () => {
  const calls = [];
  const batches = [page(Array.from({ length: 10 }, (_, n) => noise(n)), 4),
    page(Array.from({ length: 10 }, (_, n) => noise(n + 10)), 4),
    page([{ slug: 'han', name: 'Đại Hán Hiền Hậu', total_episodes: 40 }, season(1), ...Array.from({ length: 8 }, (_, n) => noise(n + 20))], 4),
    page([season(1), season(2)], 4)];
  const addon = makeAddon({ search: async (q, n) => { calls.push(n); return batches[n - 1]; } });
  const result = await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'đại hàn' });
  assert.deepEqual(result.metas.slice(0, 2).map((m) => m.id), ['nguonc:de-che-dai-han-phan-1', 'nguonc:de-che-dai-han-phan-2']);
  assert.equal(new Set(result.metas.map((m) => m.id)).size, result.metas.length);
  assert.deepEqual(calls.sort((a, b) => a - b), [1, 2, 3, 4]);
  const next = await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'đại hàn', skip: '15' });
  assert.equal(next.metas.some((m) => result.metas.some((p) => p.id === m.id)), false);
  assert.equal(calls.length, 4, 'pagination must reuse the same ranked candidate set');
});

test('All catalog rows share one query walk; case and Unicode normalization do not multiply requests', async () => {
  const calls = [];
  const addon = makeAddon({ search: async (q, n) => { calls.push([q, n]); await tick(); return page([season(1)]); } });
  const results = await Promise.all([
    addon.getCatalog('series', 'nguonc-phim-bo', { search: '  ĐẠI   HÀN  ' }),
    addon.getCatalog('series', 'nguonc-moi-phim-bo', { search: 'đại hàn'.normalize('NFD') }),
    addon.getCatalog('movie', 'nguonc-phim-le', { search: 'đại hàn' })
  ]);
  assert.deepEqual(calls, [['đại hàn', 1]]);
  assert.equal(results[0].metas[0].id, season(1).slug.replace(/^/, 'nguonc:'));
  assert.equal(results[1].metas.length, 1);
  assert.equal(results[2].metas.length, 0);
});

test('Accentless and original-language phrases rank genuine phrase matches ahead of loose tokens', async () => {
  for (const query of ['dai han', 'made in korea']) {
    const addon = makeAddon({ search: async () => page([noise(1), season(1)]) });
    const result = await addon.getCatalog('series', 'nguonc-phim-bo', { search: query });
    assert.equal(result.metas[0].id, 'nguonc:de-che-dai-han-phan-1');
  }
});

test('Search does not request nonexistent pages and bounds concurrent page fetches', async () => {
  let active = 0; let maxActive = 0; const calls = [];
  const addon = makeAddon({ search: async (q, n) => {
    active++; maxActive = Math.max(maxActive, active); calls.push(n); await tick(); active--;
    return page([noise(n)], 6, 1);
  } });
  await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'đại' });
  assert.deepEqual(calls.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.ok(maxActive <= 2);
});

test('Later-page failure preserves partial hits without marking them cacheable', async () => {
  let fail = true;
  const addon = makeAddon({ search: async (q, n) => {
    if (n === 2 && fail) throw new Error('NguonC API HTTP 502');
    return n === 1 ? page([season(1)], 2, 1) : page([season(2)], 2, 1);
  } });
  const partial = await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'đại hàn' });
  assert.equal(partial.metas.length, 1);
  assert.equal(partial.cacheMaxAge, 0);
  fail = false;
  assert.equal((await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'đại hàn' })).metas.length, 2);
});

test('Cold search failure is HTTP 502 no-store, not a cacheable empty success', async () => {
  let failed = true;
  const addon = makeAddon({ search: async () => { if (failed) throw new Error('NguonC API HTTP 429'); return page([]); } });
  const server = createServer(addon, { logger: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/catalog/series/nguonc-phim-bo/search=test.json`;
  try {
    const failure = await fetch(url);
    assert.equal(failure.status, 502);
    assert.equal(failure.headers.get('cache-control'), 'no-store');
    assert.equal((await failure.json()).error, 'Upstream request failed');
    failed = false;
    const empty = await fetch(url);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { metas: [] });
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Partial HTTP results are no-store and expose only Stremio fields; missing types are not empty successes', async () => {
  const addon = makeAddon({ search: async (q, n) => {
    if (n === 2) throw new Error('NguonC API HTTP 502');
    return page([season(1)], 2, 1);
  } });
  const server = createServer(addon, { logger: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const series = await fetch(`${base}/catalog/series/nguonc-phim-bo/search=test.json`);
    assert.equal(series.status, 200);
    assert.equal(series.headers.get('cache-control'), 'no-store');
    const body = await series.json();
    assert.deepEqual(Object.keys(body), ['metas']);
    assert.equal(body.metas.length, 1);
    const movie = await fetch(`${base}/catalog/movie/nguonc-phim-le/search=test.json`);
    assert.equal(movie.status, 502);
    assert.equal(movie.headers.get('cache-control'), 'no-store');
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('Ranked search cache retains complete last-good set across partial and total refresh failures', async () => {
  let mode = 'ok'; let calls = 0;
  const search = new SearchCatalog({ logger: silent, client: { search: async (q, n) => {
    calls++;
    if (mode === 'failed' || (mode === 'partial' && n === 2)) throw new Error('HTTP 502');
    return page([season(n)], 2, 1);
  } } });
  assert.equal((await search.get('đại hàn')).items.length, 2);
  for (const failure of ['partial', 'failed']) {
    const old = search.cache.get('đại hàn'); old.until = 0; old.retryAt = 0; mode = failure;
    const stale = await search.get('đại hàn');
    assert.equal(stale.items.length, 2);
    assert.equal(stale.complete, false);
    for (let n = 0; n < 5; n++) await tick();
    const after = calls;
    assert.equal((await search.get('đại hàn')).items.length, 2);
    assert.equal(calls, after, 'failed refresh must back off');
    assert.equal(search.cache.get('đại hàn').result.items.length, 2);
  }
});

test('Malformed search payload is a failure rather than a false no-match', async () => {
  const addon = makeAddon({ search: async () => ({ status: 'success' }) });
  await assert.rejects(addon.getCatalog('series', 'nguonc-phim-bo', { search: 'test' }), /Invalid/);
});

test('Two cache layers never promote stale API pages into a fresh search during an outage', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const items of [[], [season(1)]]) {
    let failed = false;
    const client = new NguoncApi({ retryDelayMs: 0, fetchImpl: async () =>
      failed ? new Response('', { status: 502 }) : Response.json(page(items)) });
    const addon = makeAddon(client);
    const server = createServer(addon, { logger: silent });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/catalog/series/nguonc-phim-bo/search=test.json`;
    try {
      const initial = await fetch(url);
      assert.equal(initial.status, 200);
      await initial.json();
      now += 100000; failed = true;
      for (let n = 0; n < 3; n++) {
        const response = await fetch(url);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(response.status, items.length ? 200 : 502);
        const body = await response.json();
        if (items.length) assert.equal(body.metas.length, 1);
        for (let j = 0; j < 5; j++) await tick();
      }
    } finally { await new Promise((resolve) => server.close(resolve)); }
  }
});

test('API retries transient errors once, honors long Retry-After without immediate retry, never retries 403', async () => {
  for (const status of [429, 502, 503, 504]) {
    let calls = 0;
    const api = new NguoncApi({ retryDelayMs: 0, fetchImpl: async () => {
      calls++; return calls === 1 ? new Response('', { status }) : Response.json({ items: [season(1)] });
    } });
    assert.equal((await api.search('test')).items.length, 1);
    assert.equal(calls, 2);
  }
  for (const [status, headers] of [[403, {}], [429, { 'Retry-After': '60' }]]) {
    let calls = 0;
    const api = new NguoncApi({ retryDelayMs: 0, fetchImpl: async () => { calls++; return new Response('', { status, headers }); } });
    await assert.rejects(api.search('test'));
    assert.equal(calls, 1);
  }
});

test('API dedupes in-flight requests and limits total upstream concurrency', async () => {
  let active = 0; let maxActive = 0; let calls = 0;
  const api = new NguoncApi({ maxConcurrent: 2, fetchImpl: async () => {
    calls++; active++; maxActive = Math.max(maxActive, active); await tick(); active--;
    return Response.json({ items: [] });
  } });
  await Promise.all(Array.from({ length: 12 }, (_, n) => api.search(`query${n % 6}`)));
  assert.equal(calls, 6);
  assert.ok(maxActive <= 2);
});

test('API queue is bounded and expired waiters are removed without consuming a slot', async () => {
  let finish;
  const api = new NguoncApi({ maxConcurrent: 1, maxQueue: 2, timeoutMs: 1000,
    fetchImpl: async () => { await new Promise((resolve) => { finish = resolve; }); return Response.json(page([])); } });
  const active = api.search('active'); await tick();
  api.timeoutMs = 30;
  const pending = [api.search('queued-a'), api.search('queued-b')];
  const settled = Promise.allSettled(pending);
  await assert.rejects(api.search('overflow'), /queue full/i);
  assert.equal(api.queue.length, 2);
  const keepAlive = setTimeout(() => {}, 200);
  const outcomes = await settled;
  clearTimeout(keepAlive);
  assert.ok(outcomes.every((r) => r.status === 'rejected' && r.reason.name === 'TimeoutError'));
  assert.equal(api.queue.length, 0);
  assert.equal(api.active, 1);
  finish(); await active;
  assert.equal(api.active, 0);
  assert.equal(api.inflight.size, 0);
});

test('Playback detail timeout includes time waiting behind search backlog', async () => {
  let finish; let detailStarted = false;
  const api = new NguoncApi({ maxConcurrent: 1, timeoutMs: 1000, fetchImpl: async (url) => {
    if (url.includes('/film/')) detailStarted = true;
    await new Promise((resolve) => { finish = resolve; });
    return Response.json(page([]));
  } });
  const search = api.search('busy'); await tick();
  api.timeoutMs = 30;
  const keepAlive = setTimeout(() => {}, 200);
  await assert.rejects(api.detail('playback-title'), { name: 'TimeoutError' });
  clearTimeout(keepAlive);
  assert.equal(detailStarted, false);
  assert.equal(api.queue.length, 0);
  finish(); await search;
  assert.equal(api.active, 0);
});

test('Background IMDb prematching waits for stale refreshes instead of flooding the API queue', async () => {
  const { ImdbMatcher } = require('../src/imdb');
  const matcher = new ImdbMatcher({ client: {}, logger: silent });
  const ids = Array.from({ length: 40 }, (_, n) => ({ type: n % 2 ? 'series' : 'movie', imdb: `tt${10000 + n}` }));
  matcher.popularIds = async () => ids;
  matcher.cinemeta = async () => ({ videos: [{ season: 1 }, { season: 2 }] });
  for (const { type, imdb } of ids) {
    for (const season of type === 'movie' ? [''] : [1, 2])
      matcher.matches.set(`${type}:${imdb}:${season}`, { at: 0, film: { slug: 'known', offset: 0 } });
  }
  let active = 0; let maximum = 0; let finished = 0;
  matcher.findFilm = async () => {
    active++; maximum = Math.max(maximum, active); await tick(); active--; finished++;
    return { slug: 'known', offset: 0 };
  };
  await matcher.prefetchPopular();
  assert.ok(maximum <= 2, `background concurrency was ${maximum}`);
  assert.equal(finished, 60);
  assert.equal(matcher.inflight.size, 0);
});

test('Failed stale refresh retains last good data and backs off subsequent refreshes', async () => {
  let calls = 0; let fail = false;
  const api = new NguoncApi({ retryDelayMs: 0, fetchImpl: async () => {
    calls++; return fail ? new Response('', { status: 502 }) : Response.json({ items: [season(1)] });
  } });
  await api.search('test');
  const entry = [...api.cache.values()][0]; entry.until = 0; fail = true;
  assert.equal((await api.search('test')).items.length, 1);
  for (let n = 0; n < 10; n++) await tick();
  const previousCalls = calls;
  assert.equal((await api.search('test')).items.length, 1);
  assert.equal(calls, previousCalls);
  assert.ok(calls <= 3);
});
