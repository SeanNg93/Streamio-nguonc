'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NguoncApi } = require('../src/api');
const { createAddon } = require('../src/addon');
const { streamObject, providerKey, buildStreams } = require('../src/streams');
const { OPhimCompatibleProvider } = require('../src/providers');

const silent = { warn() {}, error() {}, log() {} };

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

function jsonResponse(body) {
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
}

test('bingeGroup: provider names are accent-folded, NguonC keeps its old prefix', async () => {
  assert.equal(providerKey('NguồnC'), 'nguonc');
  assert.equal(providerKey('Đông Á'), 'donga');
  const base = { url: 'https://cdn.example.org/a.m3u8', name: 'Vietsub #1', quality: 'FHD', language: 'Vietsub' };
  assert.equal(streamObject(base).behaviorHints.bingeGroup, 'nguonc-Vietsub #1-Vietsub');
  assert.equal(streamObject({ ...base, provider: 'NguồnC' }).behaviorHints.bingeGroup, 'nguonc-Vietsub #1-Vietsub');
  assert.equal(streamObject({ ...base, provider: 'VSMOV' }).behaviorHints.bingeGroup, 'vsmov-Vietsub #1-Vietsub');
  assert.equal(streamObject({ ...base, provider: 'KKPhim' }).behaviorHints.bingeGroup, 'kkphim-Vietsub #1-Vietsub');
  assert.equal(streamObject({ ...base, language: '' }).behaviorHints.bingeGroup, 'nguonc-Vietsub #1-vietsub');
  const [s] = await buildStreams({ slug: 'x', quality: 'HD', language: 'Thuyết Minh',
    episodes: [{ server_name: 'Server A', items: [{ name: 'Full', m3u8: 'https://cdn.example.org/f.m3u8' }] }] },
  { resolver: { resolve: async () => null } });
  assert.equal(s.behaviorHints.bingeGroup, 'nguonc-Server A-Thuyết Minh');
});

test('NguonC: a cached detail missing the requested episode is refetched once it is 2 min old', async () => {
  await withEnv({ PREFETCH_NEXT_EPISODES: '0' }, async () => {
    const ep = (n) => ({ name: `Tập ${n}`, m3u8: `https://cdn.example.org/e${n}.m3u8` });
    let episodes = [ep(1), ep(2)];
    let calls = 0;
    const client = new NguoncApi({ fetchImpl: async () => {
      calls++;
      return jsonResponse({ status: 'success', movie: { slug: 'show', name: 'Show', quality: 'HD', language: 'Vietsub',
        episodes: [{ server_name: 'Vietsub', items: [...episodes] }] } });
    } });
    const addon = createAddon({ client, imdb: {}, extraProviders: [], logger: silent,
      resolver: { resolve: async () => null } });
    assert.equal((await addon.getStreams('series', 'nguonc:show:ep:1')).streams.length, 1);
    assert.equal(calls, 1);
    episodes = [ep(1), ep(2), ep(3)];   // episode 3 airs; our cached copy (1 h TTL) lacks it
    // Fresh cache entry: no refetch yet (bounded to one per 2 min per title).
    assert.deepEqual((await addon.getStreams('series', 'nguonc:show:ep:3')).streams, []);
    assert.equal(calls, 1);
    client.cache.get('/film/show').at -= 3 * 60 * 1000;
    const { streams } = await addon.getStreams('series', 'nguonc:show:ep:3');
    assert.equal(calls, 2);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, 'https://cdn.example.org/e3.m3u8');
    // Existing episodes never trigger a refetch.
    client.cache.get('/film/show').at -= 3 * 60 * 1000;
    await addon.getStreams('series', 'nguonc:show:ep:2');
    assert.equal(calls, 2);
    // Background prefetches never refetch.
    await addon.getStreams('series', 'nguonc:show:ep:4', null, { prefetch: true });
    assert.equal(calls, 2);
  });
});

test('Extra provider: stale detail without the episode is refetched (30 min cache)', async () => {
  let detailCalls = 0;
  let items = [{ name: '1', link_m3u8: 'https://s.example.org/1/index.m3u8' }];
  const provider = new OPhimCompatibleProvider({
    id: 'kkphim', label: 'KKPhim', baseUrl: 'https://kk.example.org', referer: 'https://kk.example.org/',
    searchPath: (q) => `/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}`,
    detailPath: (s) => `/phim/${s}`,
    fetchImpl: async (url) => {
      if (url.includes('/tim-kiem')) return jsonResponse({ data: { items: [{ slug: 'show-s2', name: 'Show (Phần 2)', origin_name: 'Show (Season 2)', type: 'series', year: 2026, imdb: { id: 'tt0000099' } }] } });
      detailCalls++;
      return jsonResponse({ movie: { slug: 'show-s2', name: 'Show (Phần 2)', quality: 'FHD', lang: 'Vietsub' },
        episodes: [{ server_name: 'Vietsub', server_data: [...items] }] });
    }
  });
  const args = { imdb: 'tt0000099', season: 2, episode: 2, meta: { name: 'Show', year: '2025', videos: [{ season: 2, episode: 1, released: '2026-01-01' }] } };
  assert.equal((await provider.streamsForImdb('series', { ...args, episode: 1 })).length, 1);
  items = [...items, { name: '2', link_m3u8: 'https://s.example.org/2/index.m3u8' }];
  assert.deepEqual(await provider.streamsForImdb('series', args), []);
  assert.equal(detailCalls, 1, 'young cache entry is not refetched');
  provider.api.cache.get('/phim/show-s2').at -= 3 * 60 * 1000;
  const streams = await provider.streamsForImdb('series', args);
  assert.equal(detailCalls, 2);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://s.example.org/2/index.m3u8');
  assert.equal(streams[0].behaviorHints.bingeGroup, 'kkphim-Vietsub-Vietsub');
});

function fakeProvider(label, behaviour) {
  const p = { id: label.toLowerCase(), label, calls: 0 };
  p.streamsForImdb = async () => {
    p.calls++;
    return behaviour();
  };
  return p;
}

const stream = (provider, n) => streamObject({ url: `https://cdn.example.org/${provider}-${n}.m3u8`, provider, name: 'S', quality: 'HD', language: 'Vietsub' });

test('IMDb streams: providers run in parallel, a slow or failing source cannot delay the others', async () => {
  await withEnv({ PROVIDER_STREAM_TIMEOUT_MS: '200', PREFETCH_NEXT_EPISODES: '0' }, async () => {
    const vsmov = fakeProvider('VSMOV', async () => { await new Promise((r) => setTimeout(r, 120)); return [stream('VSMOV', 1)]; });
    const slow = fakeProvider('Slow', () => new Promise((r) => setTimeout(() => r([stream('Slow', 1)]), 3000).unref()));
    const broken = fakeProvider('Broken', async () => { throw new Error('boom'); });
    const kkphim = fakeProvider('KKPhim', async () => [stream('KKPhim', 1)]);
    const film = { slug: 'film', name: 'Film', quality: 'HD', episodes: [{ server_name: 'Vietsub', items: [{ name: 'Full', m3u8: 'https://cdn.example.org/nguonc.m3u8' }] }] };
    const client = { detail: async () => { await new Promise((r) => setTimeout(r, 150)); return { movie: film }; } };
    const imdb = { resolve: async () => ({ slug: 'film', episode: null }), cinemeta: async () => ({ name: 'Film' }), byImdb: new Map() };
    const addon = createAddon({ client, imdb, extraProviders: [vsmov, slow, broken, kkphim], logger: silent,
      resolver: { resolve: async () => null } });
    const started = Date.now();
    const result = await addon.getStreams('movie', 'tt0000001', 'https://stremio.example.org');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed} ms`);
    // NguonC first even though it answered after KKPhim, then providers in configured order.
    assert.deepEqual(result.streams.map((s) => s.name.split(' ')[0]), ['NguồnC', 'VSMOV', 'KKPhim']);
    assert.equal(result.cacheMaxAge, 0, 'partial answer must not be cached');

    // A slow NguonC does not hold back the providers either.
    const slowClient = { detail: () => new Promise((r) => setTimeout(() => r({ movie: film }), 3000).unref()) };
    const addon2 = createAddon({ client: slowClient, imdb, extraProviders: [vsmov, kkphim], logger: silent,
      resolver: { resolve: async () => null } });
    const t2 = Date.now();
    const r2 = await addon2.getStreams('movie', 'tt0000001', 'https://stremio.example.org');
    assert.ok(Date.now() - t2 < 1000);
    assert.deepEqual(r2.streams.map((s) => s.name.split(' ')[0]), ['VSMOV', 'KKPhim']);
    assert.equal(r2.cacheMaxAge, 0);

    // Everybody in time: normal cacheable answer.
    const addon3 = createAddon({ client, imdb, extraProviders: [vsmov, kkphim], logger: silent,
      resolver: { resolve: async () => null } });
    const r3 = await addon3.getStreams('movie', 'tt0000001', 'https://stremio.example.org');
    assert.equal(r3.streams.length, 3);
    assert.equal(r3.cacheMaxAge, undefined);
  });
});

test('Background pre-resolves (prefetch, prematch, warm) never call the extra providers', async () => {
  await withEnv({ PREFETCH_NEXT_EPISODES: '0' }, async () => {
    const provider = fakeProvider('VSMOV', async () => [stream('VSMOV', 1)]);
    const film = { slug: 'film', name: 'Film', episodes: [{ server_name: 'Vietsub', items: [{ name: 'Full', m3u8: 'https://cdn.example.org/n.m3u8' }] }] };
    let streamsAsked = 0;
    const client = {
      list: async () => ({ items: [film], paginate: { items_per_page: 12, total_page: 1 } }),
      search: async () => ({ items: [] }),
      detail: async () => { streamsAsked++; return { movie: film }; }
    };
    const imdb = {
      resolve: async () => ({ slug: 'film', episode: null }), cinemeta: async () => ({ name: 'Film' }), byImdb: new Map(),
      detail: async () => film, learned: new Map(),
      crawlNewest: async () => 0,
      prefetchPopular: async () => ({ checked: 2, found: [{ type: 'movie', id: 'tt0000001' }, { type: 'series', id: 'tt0000002:1:1' }] })
    };
    const addon = createAddon({ client, imdb, extraProviders: [provider], logger: silent, resolver: { resolve: async () => null } });
    const pre = await addon.getStreams('movie', 'tt0000001', null, { prefetch: true });
    assert.equal(pre.streams.length, 1);
    await addon.prematch({ streams: 5 });
    await addon.warm({ streamsPerMovieCatalog: 1 });
    assert.equal(provider.calls, 0);
    assert.ok(streamsAsked > 0, 'NguonC streams were still pre-resolved');
    // An interactive request does use it.
    await addon.getStreams('movie', 'tt0000001', null);
    assert.equal(provider.calls, 1);
  });
});
