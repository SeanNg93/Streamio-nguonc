'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAddon } = require('../src/addon');
const { createServer } = require('../src/http');
const { NguoncApi, runInBackground } = require('../src/api');
const { EmbedResolver } = require('../src/streams');

const silent = { warn() {}, error() {}, log() {} };
const film = (slug, extra = {}) => ({ slug, name: `Phim ${slug}`, total_episodes: 1, ...extra });
const page = (items, total = 1, size = 10) => ({ items, paginate: { total_page: total, items_per_page: size } });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function serve(addon, options, fn) {
  const server = createServer(addon, { logger: silent, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('catalog: skip past the limit or past the last page ends the list instead of repeating a page', async () => {
  const calls = [];
  const client = { list: async (source, n) => { calls.push(n); return page([film(`p${n}a`), film(`p${n}b`)], 3, 2); } };
  const addon = createAddon({ client, logger: silent, imdb: {} });
  assert.equal((await addon.getCatalog('movie', 'nguonc-phim-le', { skip: '2' })).metas[0].id, 'nguonc:p2a');
  calls.length = 0;
  assert.deepEqual(await addon.getCatalog('movie', 'nguonc-phim-le', { skip: '300' }), { metas: [] });
  assert.deepEqual(calls, []);   // beyond CATALOG_MAX_SKIP: no upstream walk at all
  assert.deepEqual((await addon.getCatalog('movie', 'nguonc-phim-le', { skip: '10' })).metas, []);
  assert.equal(calls.includes(6), false);   // page 6 > total_page 3 is never requested
});

test('catalog: a search page past partial results is an uncached end, not a 502', async () => {
  const client = { search: async (q, n) => {
    if (n === 2) throw new Error('NguonC API HTTP 502');
    return page([film('a', { category: [{ list: [{ name: 'Phim lẻ' }] }] })], 2, 1);
  } };
  const addon = createAddon({ client, logger: silent, imdb: {} });
  await serve(addon, {}, async (host) => {
    const first = await fetch(`${host}/catalog/movie/nguonc-phim-le/search=abc.json`);
    assert.equal(first.status, 200);
    const later = await fetch(`${host}/catalog/movie/nguonc-phim-le/search=abc&skip=15.json`);
    assert.equal(later.status, 200);
    assert.equal(later.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await later.json(), { metas: [] });
  });
});

test('meta: an upstream failure is 502 no-store; a title NguonC removed is meta null', async () => {
  const client = { detail: async (slug) => {
    const error = new Error(`NguonC API HTTP ${slug === 'gone' ? 404 : 503}`);
    error.status = slug === 'gone' ? 404 : 503;
    throw error;
  } };
  const addon = createAddon({ client, logger: silent, imdb: {} });
  await serve(addon, {}, async (host) => {
    const failed = await fetch(`${host}/meta/movie/nguonc:busy.json`);
    assert.equal(failed.status, 502);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    const gone = await fetch(`${host}/meta/movie/nguonc:gone.json`);
    assert.equal(gone.status, 200);
    assert.equal(gone.headers.get('cache-control'), 'public, max-age=300');
    assert.deepEqual(await gone.json(), { meta: null });
  });
});

test('health: proxy details only for direct local requests, not through the reverse proxy', async () => {
  const addon = createAddon({ client: {}, logger: silent, imdb: {} });
  await serve(addon, {}, async (host) => {
    const local = await (await fetch(`${host}/health`)).json();
    assert.equal(local.ok, true);
    assert.ok(Array.isArray(local.proxies));
    const proxied = await (await fetch(`${host}/health`, { headers: { 'X-Forwarded-For': '203.0.113.9' } })).json();
    assert.deepEqual(proxied, { ok: true, addon: addon.manifest.name });
  });
});

test('ACCESS_TOKEN: addon routes need the token prefix; /play/ and /health stay reachable', async () => {
  const client = { list: async () => page([film('x')]) };
  const addon = createAddon({ client, logger: silent, imdb: {} });
  await serve(addon, { accessToken: 'tok-123' }, async (host) => {
    assert.equal((await fetch(`${host}/manifest.json`)).status, 404);
    assert.equal((await fetch(`${host}/wrong-token/manifest.json`)).status, 404);
    assert.equal((await fetch(`${host}/catalog/movie/nguonc-phim-le.json`)).status, 404);
    const manifest = await fetch(`${host}/tok-123/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal((await manifest.json()).id, addon.manifest.id);
    assert.equal((await (await fetch(`${host}/tok-123/catalog/movie/nguonc-phim-le.json`)).json()).metas[0].id, 'nguonc:x');
    assert.match(await (await fetch(`${host}/tok-123/`)).text(), /\/tok-123\/manifest\.json/);
    assert.equal((await fetch(`${host}/health`)).status, 200);
    const play = await fetch(`${host}/play/${'0'.repeat(36)}/index.m3u8`);
    assert.equal(play.status, 404);
    assert.equal(play.headers.get('content-type'), 'text/plain');   // answered by the playback store
  });
});

test('streamc: the HTTP/2 fallback (which bypasses proxies) is off when a proxy is configured', () => {
  const saved = { p: process.env.UPSTREAM_PROXIES, s: process.env.UPSTREAM_PROXY, h: process.env.STREAMC_HTTP2 };
  try {
    delete process.env.UPSTREAM_PROXY; delete process.env.STREAMC_HTTP2;
    process.env.UPSTREAM_PROXIES = 'home=http://10.0.0.2:3128';
    assert.equal(new EmbedResolver().enableHttp2, false);
    delete process.env.UPSTREAM_PROXIES;
    assert.equal(new EmbedResolver().enableHttp2, true);
    process.env.STREAMC_HTTP2 = '0';
    assert.equal(new EmbedResolver().enableHttp2, false);
  } finally {
    for (const [k, v] of [['UPSTREAM_PROXIES', saved.p], ['UPSTREAM_PROXY', saved.s], ['STREAMC_HTTP2', saved.h]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('API: interactive requests get a slot before queued background work, and joining promotes it', async () => {
  const order = []; const gates = [];
  const api = new NguoncApi({ maxConcurrent: 1, timeoutMs: 2000, fetchImpl: async (url) => {
    order.push(url.split('/film/')[1]);
    await new Promise((resolve) => gates.push(resolve));
    return Response.json({ movie: { name: 'x' } });
  } });
  const busy = api.detail('busy'); await tick();
  const bg = runInBackground(() => Promise.all([api.detail('bg-1'), api.detail('bg-2'), api.detail('shared')]));
  await tick();
  assert.equal(api.bgQueue.length, 3);
  const user = Promise.all([api.detail('user'), api.detail('shared')]);   // joins the queued background fetch
  await tick();
  assert.equal(api.queue.length, 2);
  for (let i = 0; i < 5; i++) { gates.shift()(); await tick(); await tick(); }
  await Promise.all([busy, bg, user]);
  assert.deepEqual(order, ['busy', 'user', 'shared', 'bg-1', 'bg-2']);
  assert.equal(api.active, 0);
  assert.equal(api.tickets.size, 0);
});
