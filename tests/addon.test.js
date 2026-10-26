'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NguoncApi } = require('../src/api');
const { createAddon, manifest } = require('../src/addon');
const { createServer } = require('../src/http');
const {
  preview, typeOf, parseMediaId, detailMeta, primaryEpisodeList, pickEpisode
} = require('../src/mapper');
const {
  buildStreams, EmbedResolver, extractFromHtml, isSafeUrl, safeToFetch
} = require('../src/streams');
const { decryptHlsManifest, unwrapBootstrap } = require('../src/streamc');
const { PlaybackStore, rewriteManifest } = require('../src/playback');
const crypto = require('node:crypto');

const MOVIE = {
  slug: 'phim-thu-nghiem', name: 'Phim Thử Nghiệm', original_name: 'Sample Film',
  poster_url: 'https://cdn.example.org/poster.jpg', year: 2025, total_episodes: 1,
  current_episode: 'Full', quality: 'FHD', language: 'Vietsub',
  episodes: [{ server_name: 'Vietsub', items: [
    { name: 'Full', m3u8: 'https://cdn.example.org/film.m3u8' }
  ] }]
};
const SERIES = {
  slug: 'phim-bo-thu-nghiem', name: 'Bộ Phim Thử', total_episodes: 2,
  quality: 'HD', language: 'Vietsub',
  category: [{ group: { name: 'Danh sách' }, list: [{ name: 'Phim bộ' }] }],
  episodes: [
    { server_name: 'Server Vietsub', items: [
      { name: 'Tập 1', m3u8: 'https://cdn.example.org/a1.m3u8' },
      { name: 'Tập 2', embed: 'https://player.example.org/embed/ep2' }
    ] },
    { server_name: 'Server Thuyết minh', items: [
      { name: 'Ep 01', m3u8: 'https://cdn.example.org/b1.m3u8' },
      { name: 'Ep 02', m3u8: 'https://cdn.example.org/b2.m3u8' }
    ] }
  ]
};

function fakeClient() {
  const pages = {
    'phim-le': [
      { items: [MOVIE, { ...MOVIE, slug: 'phim-2' }], paginate: { items_per_page: 2, total_page: 2 } },
      { items: [{ ...MOVIE, slug: 'phim-3' }], paginate: { items_per_page: 2, total_page: 2 } }
    ],
    'phim-bo': [ { items: [SERIES], paginate: { items_per_page: 2, total_page: 1 } } ],
    'moi': [ { items: [MOVIE, SERIES], paginate: { items_per_page: 2, total_page: 1 } } ]
  };
  return {
    list: async (key, page) => pages[key]?.[page - 1] || { items: [], paginate: { total_page: 0 } },
    search: async (q, page) => page === 1
      ? { items: [SERIES, MOVIE], paginate: { items_per_page: 2, total_page: 2 } }
      : { items: [{ ...MOVIE, slug: 'phim-2' }], paginate: { items_per_page: 2, total_page: 2 } },
    detail: async (slug) => ({ status: 'success', movie: slug === SERIES.slug ? SERIES : MOVIE })
  };
}

test('Manifest has Stremio resources and categories', () => {
  assert.equal(manifest.id, 'com.personal.nguonc.stremio');
  assert.equal(manifest.resources.length, 3);
  assert.equal(manifest.catalogs.length, 5);
  assert.equal(manifest.version, '1.2.0');
  assert.deepEqual(manifest.types, ['movie', 'series']);
});

test('Normalize movie metadata and classify titles', () => {
  const p = preview(MOVIE);
  assert.equal(p.id, 'nguonc:phim-thu-nghiem');
  assert.equal(p.type, 'movie');
  assert.equal(p.poster, MOVIE.poster_url);
  assert.equal(p.releaseInfo, '2025');
  assert.equal(typeOf(SERIES), 'series');
  assert.deepEqual(parseMediaId('nguonc:phim-bo-thu-nghiem:ep:2'),
    { slug: 'phim-bo-thu-nghiem', episode: 2 });
  assert.equal(parseMediaId('nguonc:../../etc/passwd'), null);
});

test('NguonC API uses documented endpoints, encodes Unicode and caches', async () => {
  let count = 0;
  const calls = [];
  const api = new NguoncApi({ fetchImpl: async (url) => {
    count++;
    calls.push(url);
    return { ok: true, json: async () => ({ status: 'success', items: [] }) };
  } });
  await api.list('phim-le', 1);
  await api.list('phim-le', 1);
  await api.search('Hà Nội', 1);
  await api.detail('phim-test');
  assert.equal(count, 3);
  assert.match(calls[0], /\/api\/films\/danh-sach\/phim-le\?page=1$/);
  assert.match(calls[1], /films\/search\?keyword=H%C3%A0%20N%E1%BB%99i&page=1$/);
  assert.match(calls[2], /\/api\/film\/phim-test$/);
});

test('Catalog supports source paging with skip', async () => {
  const addon = createAddon({ client: fakeClient(), logger: { warn: () => {} } });
  const page1 = await addon.getCatalog('movie', 'nguonc-phim-le');
  const page2 = await addon.getCatalog('movie', 'nguonc-phim-le', { skip: '2' });
  assert.deepEqual(page1.metas.map((m) => m.id), ['nguonc:phim-thu-nghiem', 'nguonc:phim-2']);
  assert.deepEqual(page2.metas.map((m) => m.id), ['nguonc:phim-3']);
});

test('Search and mixed newly updated catalogs filter movie vs series', async () => {
  const addon = createAddon({ client: fakeClient(), logger: { warn: () => {} } });
  const movies = await addon.getCatalog('movie', 'nguonc-phim-le', { search: 'test' });
  const series = await addon.getCatalog('series', 'nguonc-phim-bo', { search: 'test' });
  const newMovies = await addon.getCatalog('movie', 'nguonc-moi-phim-le');
  const newSeries = await addon.getCatalog('series', 'nguonc-moi-phim-bo');
  assert.equal(movies.metas.length, 2);
  assert.equal(series.metas.length, 1);
  assert.equal(newMovies.metas.length, 1);
  assert.equal(newSeries.metas.length, 1);
});

test('Series meta includes unique episodes and correct ID, movie has no videos', async () => {
  const addon = createAddon({ client: fakeClient(), logger: { warn: () => {} } });
  const { meta: seriesMeta } = await addon.getDetail('series', 'nguonc:phim-bo-thu-nghiem');
  assert.equal(seriesMeta.name, SERIES.name);
  assert.equal(seriesMeta.videos.length, 2);
  assert.equal(seriesMeta.videos[1].id, 'nguonc:phim-bo-thu-nghiem:ep:2');
  assert.equal(seriesMeta.videos[1].episode, 2);
  assert.match(seriesMeta.videos[0].released, /^\d{4}-/);
  const { meta: filmMeta } = await addon.getDetail('movie', 'nguonc:phim-thu-nghiem');
  assert.equal(filmMeta.videos, undefined);
  assert.equal(filmMeta.releaseInfo, '2025');
});

test('Episode numbers match across different servers', () => {
  assert.equal(primaryEpisodeList(SERIES).length, 2);
  assert.equal(pickEpisode(SERIES.episodes[1].items, 2).name, 'Ep 02');
  assert.equal(detailMeta(SERIES, 'series', SERIES.slug).videos.length, 2);
});

test('Direct HLS link is returned as native Stremio stream', async () => {
  const resolver = { resolve: async () => null };
  const streams = await buildStreams(MOVIE, { resolver });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example.org/film.m3u8');
  assert.equal(streams[0].behaviorHints.notWebReady, true);
});

test('Unresolved embeds are hidden; the addon never opens a browser', async () => {
  const streams = await buildStreams(SERIES, { episode: 2, resolver: { resolve: async () => null } });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example.org/b2.m3u8');
  assert.equal(streams.every((stream) => !('externalUrl' in stream)), true);
});

test('Resolve public StreamC data-obf HTML without evaluating JavaScript', async () => {
  const value = Buffer.from(JSON.stringify({ sUb: 'playlist/movie.m3u8' })).toString('base64');
  const result = extractFromHtml(`<div data-obf="${value}"></div>`, 'https://streamc.example.org/v/123');
  assert.equal(result.url, 'https://streamc.example.org/playlist/movie.m3u8');
  const resolver = new EmbedResolver({
    lookup: async () => [{ address: '8.8.8.8' }],
    fetchImpl: async () => ({ ok: true, status: 200,
      headers: { get: () => '' }, body: null,
      text: async () => `<div data-obf='${value}'></div>` })
  });
  assert.deepEqual(await resolver.resolve('https://streamc.example.org/v/123'), result);
});

test('Private hostnames are rejected for remote embed resolution', async () => {
  assert.equal(isSafeUrl('http://127.0.0.1/admin'), false);
  assert.equal(isSafeUrl('http://localhost/admin'), false);
  assert.equal(isSafeUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(await safeToFetch('https://example.org', async () => [{ address: '192.168.1.10' }]), false);
});

test('HTTP routes serve manifest, catalog, meta, stream + CORS', async () => {
  const addon = createAddon({ client: fakeClient(), logger: { warn: () => {} } });
  const server = createServer(addon);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${origin}/manifest.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal((await response.json()).name, 'NguồnC Việt Nam');
    const cat = await fetch(`${origin}/catalog/movie/nguonc-phim-le/search=Phim%20Th%E1%BB%AD.json`);
    assert.equal(cat.status, 200);
    assert.ok((await cat.json()).metas.length);
    const detail = await fetch(`${origin}/meta/series/nguonc:phim-bo-thu-nghiem.json`);
    assert.equal((await detail.json()).meta.videos.length, 2);
    const stream = await fetch(`${origin}/stream/series/nguonc:phim-bo-thu-nghiem:ep:1.json`);
    assert.equal((await stream.json()).streams.length, 2);
    assert.equal((await fetch(`${origin}/not-found`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test('StreamC legacy obfuscation token is converted into an actual .m3u8 URL', () => {
  const blob = Buffer.from(JSON.stringify({ sUb: 'abcDEF123', hD: 'videoHash123' })).toString('base64');
  const value = extractFromHtml(`<div data-obf='${blob}'></div>`, 'https://player.example.org/watch?x=1');
  assert.equal(value.url, 'https://player.example.org/abcDEF123.m3u8');
  assert.equal(value.videoHash, 'videoHash123');
});

test('Modern StreamC bootstrap produces native HLS, not a browser link', async () => {
  const embed = 'https://embed.example.org/watch?hash=abc123abc123';
  const api = 'https://embed.example.org/api/bootstrap';
  const m3u8 = 'https://embed.example.org/signed/index.m3u8';
  const calls = [];
  const resolver = new EmbedResolver({
    enableHttp2: false,
    lookup: async () => [{ address: '8.8.8.8' }],
    fetchImpl: async (url, options) => {
      calls.push([url, options.method || 'GET']);
      const text = url === embed
        ? `<script id="stream-bootstrap">${JSON.stringify({ api })}</script>`
        : url === api
          ? JSON.stringify({ preissued: { playlist: m3u8 }, video: 'abc123abc123' })
          : '#EXTM3U\n#EXTINF:5,\nvideo.ts\n';
      return { status: 200, ok: true, headers: { get: () => '' }, body: null, text: async () => text };
    }
  });
  const output = await resolver.resolve(embed, 'https://phim.nguonc.com/phim/test');
  assert.equal(output.url, m3u8);
  assert.equal(output.referer, embed);
  assert.deepEqual(calls.map((c) => c[1]), ['GET', 'POST', 'GET']);
});

test('Encrypted StreamC playlists can be decrypted with publicly provided metadata', async () => {
  const embed = 'https://embed.example.org/watch?hash=abcdef012345';
  const api = 'https://embed.example.org/api/bootstrap';
  const m3u8 = 'https://embed.example.org/token.m3u8';
  const videoHash = 'abcdef012345';
  const plain = '#EXTM3U\n#EXTINF:5,\nmedia/0.ts\n';
  const iv = Buffer.alloc(12, 3);
  const key = crypto.createHmac('sha256', 'stream-derive-v1').update(videoHash).digest();
  const enc = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([enc.update(plain, 'utf8'), enc.final(), enc.getAuthTag()]);
  const protectedManifest = `#ENC-AESGCM iv=${iv.toString('hex')}\n${ciphertext.toString('base64')}`;
  assert.equal(decryptHlsManifest(protectedManifest, videoHash), plain);
  const bootstrapAAD = Buffer.from(`stream-bootstrap-v1\n${api}`);
  const bootstrapKey = crypto.createHash('sha256').update(bootstrapAAD).digest();
  const bootstrapNonce = Buffer.alloc(12, 4);
  const bootstrapCipher = crypto.createCipheriv('aes-256-gcm', bootstrapKey, bootstrapNonce);
  bootstrapCipher.setAAD(bootstrapAAD);
  const bootstrapData = Buffer.concat([
    bootstrapCipher.update(JSON.stringify({ video: videoHash, preissued: { playlist: m3u8 } }), 'utf8'),
    bootstrapCipher.final(), bootstrapCipher.getAuthTag()
  ]);
  const envelope = { format: 'aesgcm-v1', iv: bootstrapNonce.toString('hex'), data: bootstrapData.toString('base64') };
  assert.equal(unwrapBootstrap(envelope, api).video, videoHash);
  const resolver = new EmbedResolver({
    enableHttp2: false,
    lookup: async () => [{ address: '8.8.8.8' }],
    fetchImpl: async (url) => {
      const text = url === embed ? `<script id="stream-bootstrap">${JSON.stringify({ api })}</script>`
        : url === api ? JSON.stringify(envelope) : protectedManifest;
      return { status: 200, ok: true, headers: { get: () => '' }, body: null, text: async () => text };
    }
  });
  const decrypted = await resolver.resolve(embed, 'https://phim.nguonc.com/phim/test');
  assert.equal(decrypted.playlist, plain);
  assert.equal(decrypted.playlistUrl, m3u8);
  const playback = new PlaybackStore();
  const nativeStreams = await buildStreams({ ...MOVIE, episodes: [{ server_name: 'StreamC', items: [{ name: 'Full', embed }] }] }, {
    resolver: { resolve: async () => decrypted }, playback, publicBaseUrl: 'http://127.0.0.1:7000'
  });
  assert.equal(nativeStreams.length, 1);
  assert.match(nativeStreams[0].url, /^http:\/\/127\.0\.0\.1:7000\/play\/[a-f\d]{36}\/index\.m3u8$/);
  assert.equal(nativeStreams[0].externalUrl, undefined);
});

test('HLS proxy rewrites child playlists, key links, and serves segments', async () => {
  const base = 'https://media.example.org/movie/master.m3u8';
  const source = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-STREAM-INF:BANDWIDTH=500000\nquality/360.m3u8\n';
  const store = new PlaybackStore({
    lookup: async () => [{ address: '8.8.8.8' }],
    fetchImpl: async (url) => url.endsWith('.m3u8')
      ? new Response('#EXTM3U\n#EXTINF:5,\nseg0.ts\n', { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })
      : new Response(Buffer.from('test bytes'), { status: 200, headers: { 'Content-Type': 'video/mp2t' } })
  });
  const id = store.create({ playlist: source, playlistUrl: base, referer: base });
  assert.equal(rewriteManifest(source, base, (uri) => uri).includes('https://media.example.org/movie/key.bin'), true);
  const addon = createAddon({ client: fakeClient(), playback: store, logger: { warn: () => {} } });
  const server = createServer(addon);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${server.address().port}`;
  try {
    const masterResp = await fetch(`${host}/play/${id}/index.m3u8`);
    assert.equal(masterResp.status, 200);
    const master = await masterResp.text();
    assert.match(master, /#EXT-X-KEY:METHOD=AES-128,URI="\/play\/[a-f\d]{36}\/asset\/0"/);
    assert.match(master, /#EXT-X-STREAM-INF:BANDWIDTH=500000\n\/play\/[a-f\d]{36}\/asset\/1/);
    const variant = await fetch(`${host}/play/${id}/asset/1`);
    assert.equal(variant.status, 200);
    const variantText = await variant.text();
    assert.match(variantText, /\/play\/[a-f\d]{36}\/asset\/2/);
    const segment = await fetch(`${host}/play/${id}/asset/2`);
    assert.equal(await segment.text(), 'test bytes');
    assert.equal((await fetch(`${host}/play/${'0'.repeat(36)}/index.m3u8`)).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('IMDb ids are parsed for movies and episodes, others rejected', () => {
  const { parseImdbId, norm } = require('../src/imdb');
  assert.deepEqual(parseImdbId('tt20215968'), { imdb: 'tt20215968', season: null, episode: null });
  assert.deepEqual(parseImdbId('tt0903747:2:3'), { imdb: 'tt0903747', season: 2, episode: 3 });
  assert.equal(parseImdbId('nguonc:abc'), null);
  assert.equal(parseImdbId('tt12:x:1'), null);
  assert.equal(norm('Đoàn Tùy Tùng: Part 2 & More'), 'doan tuy tung part 2 and more');
});

test('IMDb matcher uses the learned index, persists, and serves stale answers instantly', async () => {
  const os = require('node:os'); const fsx = require('node:fs'); const pathx = require('node:path');
  const { ImdbMatcher } = require('../src/imdb');
  const file = pathx.join(fsx.mkdtempSync(pathx.join(os.tmpdir(), 'imdb-')), 'cache.json');
  let searches = 0;
  const film = { slug: 'phim-a', name: 'Phim A', original_name: 'Film A', year: 2024,
    imdb: { id: 'tt1234567' }, tmdb: { type: 'movie', season: null }, episodes: [{ items: [{ name: 'FULL' }] }] };
  const client = {
    detail: async (slug) => (slug === 'phim-a' ? { movie: film } : { movie: null }),
    search: async () => { searches++; return { items: [] }; },
    list: async () => ({ items: [{ slug: 'phim-a' }] })
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ meta: { name: 'Film A', year: '2024' } }) });
  const m = new ImdbMatcher({ client, fetchImpl, dataFile: file, logger: { log() {}, warn() {} } });
  assert.equal(await m.crawlNewest(1), 1);
  assert.deepEqual(await m.resolve('movie', 'tt1234567'), { slug: 'phim-a', episode: null });
  assert.equal(searches, 0, 'index hit must not search');
  // stale entry is returned immediately
  m.matches.get('movie:tt1234567:').at = 0;
  assert.deepEqual(await m.resolve('movie', 'tt1234567'), { slug: 'phim-a', episode: null });
  await new Promise((r) => setTimeout(r, 5200));
  const reloaded = new ImdbMatcher({ client, fetchImpl, dataFile: file, logger: { log() {}, warn() {} } });
  assert.ok(reloaded.matches.has('movie:tt1234567:'));
  assert.ok(reloaded.byImdb.get('tt1234567').has('phim-a'));
});
