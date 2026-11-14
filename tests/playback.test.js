'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAddon } = require('../src/addon');
const { createServer } = require('../src/http');
const { PlaybackStore } = require('../src/playback');

const silent = { warn() {}, error() {}, log() {} };
const PLAYLIST = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nseg0.ts\n#EXTINF:2,\nseg1.ts\n';
const BASE = 'https://media.example.org/film/index.m3u8';
const lookup = async () => [{ address: '8.8.8.8' }];

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nguonc-play-')); }

async function withServer(store, fn) {
  const addon = createAddon({ client: {}, playback: store, logger: silent, imdb: {}, extraProviders: [] });
  const server = createServer(addon, { logger: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('playback: repeated stream calls reuse one session per playlist', () => {
  const store = new PlaybackStore({ lookup, secret: 'k' });
  const a = store.create({ playlist: PLAYLIST, playlistUrl: BASE, referer: BASE });
  const again = store.create({ playlist: PLAYLIST, playlistUrl: BASE, referer: BASE });
  const other = store.create({ playlist: PLAYLIST, playlistUrl: 'https://media.example.org/other/index.m3u8', referer: BASE });
  assert.match(a, /^[a-f\d]{36}$/);
  assert.equal(again, a);
  assert.notEqual(other, a);
  assert.equal(store.sessions.size, 2);
});

test('playback: memory keeps the most recently used sessions, not the newest', () => {
  const store = new PlaybackStore({ lookup, secret: 'k', maxSessions: 2 });
  const url = (n) => `https://media.example.org/${n}/index.m3u8`;
  const a = store.create({ playlist: PLAYLIST, playlistUrl: url('a'), referer: BASE });
  const b = store.create({ playlist: PLAYLIST, playlistUrl: url('b'), referer: BASE });
  assert.ok(store.get(a));                // a is being watched
  const c = store.create({ playlist: PLAYLIST, playlistUrl: url('c'), referer: BASE });
  assert.ok(store.sessions.has(a));
  assert.ok(store.sessions.has(c));
  assert.equal(store.sessions.has(b), false);
});

test('playback: sessions persist on disk and survive a restart or memory eviction', async () => {
  const dir = tmpDir();
  const fetchImpl = async () => new Response(Buffer.from('key bytes'), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  try {
    const first = new PlaybackStore({ lookup, fetchImpl, dir, secret: 'k', logger: silent });
    const id = first.create({ playlist: PLAYLIST, playlistUrl: BASE, referer: BASE, videoHash: 'h' });
    const before = await withServer(first, async (host) => (await fetch(`${host}/play/${id}/index.m3u8`)).text());
    assert.match(before, new RegExp(`/play/${id}/asset/0`));
    await first.flush();
    assert.ok(fs.existsSync(path.join(dir, `${id}.json.gz`)));

    // New process: nothing in memory, the URL Stremio still holds must keep working.
    const second = new PlaybackStore({ lookup, fetchImpl, dir, secret: 'k', logger: silent });
    assert.equal(second.sessions.size, 0);
    await withServer(second, async (host) => {
      const index = await fetch(`${host}/play/${id}/index.m3u8`);
      assert.equal(index.status, 200);
      assert.equal(await index.text(), before);
      const key = await fetch(`${host}/play/${id}/asset/0`);
      assert.equal(key.status, 200);
      assert.equal(await key.text(), 'key bytes');
    });
    // Same secret, same playlist -> the same id after the restart too.
    assert.equal(second.create({ playlist: PLAYLIST, playlistUrl: BASE, referer: BASE, videoHash: 'h' }), id);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('playback: expired session files are neither served nor kept', async () => {
  const dir = tmpDir();
  try {
    const store = new PlaybackStore({ lookup, dir, secret: 'k', ttlMs: 30, logger: silent });
    const id = store.create({ playlist: PLAYLIST, playlistUrl: BASE, referer: BASE });
    await store.flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const fresh = new PlaybackStore({ lookup, dir, secret: 'k', ttlMs: 30, logger: silent });
    assert.equal(fresh.get(id), null);
    assert.equal(await fresh.pruneFiles(Date.now() + 3 * 3600000), 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('playback: edge relay carries segments only; extensionless variant and rendition playlists stay on /play/', async () => {
  const saved = process.env.EDGE_SECRET;
  process.env.EDGE_SECRET = 'edge-test-secret';
  try {
    const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="https://cdn.example.org/audio/en"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"\nhttps://cdn.example.org/video/720\n';
    const variant = '#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.org/seg/1\n#EXTINF:2,\nhttps://cdn.example.org/seg/2.ts\n';
    const store = new PlaybackStore({ lookup, secret: 'k', fetchImpl: async () =>
      new Response(variant, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }) });
    const id = store.create({ playlist: master, playlistUrl: 'https://cdn.example.org/master', referer: BASE });
    await withServer(store, async (host) => {
      const text = await (await fetch(`${host}/play/${id}/index.m3u8`)).text();
      assert.doesNotMatch(text, /\/edge\//);
      assert.match(text, new RegExp(`URI="/play/${id}/asset/\\d+"`));
      assert.match(text, new RegExp(`BANDWIDTH=800000,AUDIO="a"\\n/play/${id}/asset/\\d+`));
      const child = await (await fetch(`${host}/play/${id}/asset/1`)).text();
      const segments = child.split('\n').filter((l) => l && !l.startsWith('#'));
      assert.equal(segments.length, 2);
      assert.ok(segments.every((l) => l.startsWith('/edge/') && l.endsWith('/seg.ts')));
    });
  } finally {
    if (saved === undefined) delete process.env.EDGE_SECRET; else process.env.EDGE_SECRET = saved;
  }
});

test('playback: PNG-prefixed MPEG-TS segments go to /edge/ by default; with EDGE_IMAGE_SEGMENTS=0 they stay on /play/ with the fake PNG header stripped', async () => {
  const { findTsOffset } = require('../src/playback');
  const pngHeader = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(493, 0x11)
  ]);
  const tsPackets = Buffer.alloc(188 * 4, 0xaa);
  for (let i = 0; i < 4; i++) tsPackets[i * 188] = 0x47;
  const disguised = Buffer.concat([pngHeader, tsPackets]);
  assert.equal(findTsOffset(disguised), 501);

  const saved = process.env.EDGE_SECRET;
  const savedImg = process.env.EDGE_IMAGE_SEGMENTS;
  process.env.EDGE_SECRET = 'edge-test-secret';
  try {
    const playlist = '#EXTM3U\n#EXTINF:3,\nhttps://p25.example.org/file/tiktok/file-tiktok_1.png\n';
    const store = new PlaybackStore({ lookup, secret: 'k', fetchImpl: async () =>
      new Response(disguised, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(disguised.length) } }) });
    const id = store.create({ playlist, playlistUrl: 'https://v8.example.org/stream/hash/master.m3u8', referer: 'https://v8.example.org/video/hash' });
    await withServer(store, async (host) => {
      delete process.env.EDGE_IMAGE_SEGMENTS;
      const viaEdge = await (await fetch(`${host}/play/${id}/index.m3u8`)).text();
      assert.match(viaEdge, /\/edge\//, 'edge worker strips PNG headers, so image segments use it by default');
      process.env.EDGE_IMAGE_SEGMENTS = '0';
      const m3u8 = await (await fetch(`${host}/play/${id}/index.m3u8`)).text();
      assert.doesNotMatch(m3u8, /\/edge\//, 'EDGE_IMAGE_SEGMENTS=0 keeps PNG-disguised segments off /edge/');
      assert.match(m3u8, new RegExp(`/play/${id}/asset/0`));
      const segResp = await fetch(`${host}/play/${id}/asset/0`);
      assert.equal(segResp.status, 200);
      assert.equal(segResp.headers.get('content-type'), 'video/mp2t');
      const segBuf = Buffer.from(await segResp.arrayBuffer());
      assert.equal(segBuf.length, tsPackets.length);
      assert.equal(segBuf[0], 0x47);
      assert.equal(segBuf[188], 0x47);
    });
  } finally {
    if (saved === undefined) delete process.env.EDGE_SECRET; else process.env.EDGE_SECRET = saved;
    if (savedImg === undefined) delete process.env.EDGE_IMAGE_SEGMENTS; else process.env.EDGE_IMAGE_SEGMENTS = savedImg;
  }
});

test('providers: VSMOV signed embed + subtitles and KKPhim direct m3u8 merge into IMDb streams', async () => {
  const { OPhimCompatibleProvider, parseVsmovEmbed } = require('../src/providers');
  const { EmbedResolver } = require('../src/streams');
  const embedHtml = `
    <script>
      const baseUrl = "https://v2.example.org";
      const videoHash = "hash123";
      var config = {
        signedMasterUrl: "https://v2.example.org/stream/hash123/master.m3u8?expires=999&signature=abc",
        subtitles: [{"language":"Vietnamese","code":"vie","url":"/video/hash123/subtitle/vie.vtt","default":true}]
      };
    </script>`;
  const parsed = parseVsmovEmbed(embedHtml, 'https://v2.example.org/video/hash123');
  assert.equal(parsed.playlistUrl, 'https://v2.example.org/stream/hash123/master.m3u8?expires=999&signature=abc');
  assert.equal(parsed.subtitles.length, 1);
  assert.equal(parsed.subtitles[0].url, 'https://v2.example.org/video/hash123/subtitle/vie.vtt');

  const vsmov = new OPhimCompatibleProvider({
    id: 'vsmov', label: 'VSMOV', baseUrl: 'https://vsmov.example.org/api', referer: 'https://vsmov.example.org/',
    searchPath: (q) => `/tim-kiem?keyword=${encodeURIComponent(q)}`,
    detailPath: (s) => `/phim/${s}`, proxiedPlaylist: true,
    fetchImpl: async (url) => ({ ok: true, json: async () => url.includes('/tim-kiem')
      ? { items: [{ slug: 'mobland-s2', name: 'Lãnh Địa Tử Chiến - Phần 2', origin_name: 'MobLand - Season 2', type: 'series', year: 2026, imdb: { id: 'tt31510819' }, tmdb: { type: 'tv', season: 2 } }] }
      : { movie: { slug: 'mobland-s2', name: 'Lãnh Địa Tử Chiến - Phần 2', quality: 'FHD', lang: 'Vietsub' },
          episodes: [{ server_name: 'Vietsub #1', server_data: [{ name: '9', link_embed: 'https://v2.example.org/video/hash123' }] }] } })
  });
  const kkphim = new OPhimCompatibleProvider({
    id: 'kkphim', label: 'KKPhim', baseUrl: 'https://kk.example.org', referer: 'https://kk.example.org/',
    searchPath: (q) => `/v1/api/tim-kiem?keyword=${encodeURIComponent(q)}`,
    detailPath: (s) => `/phim/${s}`, proxiedPlaylist: false,
    fetchImpl: async (url) => ({ ok: true, json: async () => url.includes('/tim-kiem')
      ? { data: { items: [{ slug: 'mobland-s2', name: 'Lãnh Địa Tử Chiến (Phần 2)', origin_name: 'MobLand (Season 2)', type: 'series', year: 2026, imdb: { id: 'tt31510819' }, tmdb: { type: 'tv', season: 2 } }] } }
      : { movie: { slug: 'mobland-s2', name: 'Lãnh Địa Tử Chiến (Phần 2)', quality: 'FHD', lang: 'Vietsub' },
          episodes: [{ server_name: '#Hà Nội (Vietsub)', server_data: [{ name: 'Tập 09', link_m3u8: 'https://s6.example.org/hls/index.m3u8' }] }] } })
  });
  const resolver = new EmbedResolver({
    enableHttp2: false, lookup,
    fetchImpl: async (url) => ({
      ok: true, status: 200, headers: { get: () => '' }, body: null,
      text: async () => url.includes('.m3u8') ? '#EXTM3U\n#EXTINF:3,\nhttps://p25.example.org/seg1.png\n' : embedHtml
    })
  });
  const store = new PlaybackStore({ lookup, secret: 'k' });
  const imdb = {
    resolve: async () => null,
    cinemeta: async () => ({ name: 'MobLand', year: '2025–', videos: [{ season: 2, episode: 9, released: '2026-03-01' }] }),
    byImdb: new Map()
  };
  const addon = createAddon({ client: {}, resolver, playback: store, imdb, extraProviders: [vsmov, kkphim], logger: silent });
  const { streams } = await addon.getStreams('series', 'tt31510819:2:9', 'https://stremio.example.org');
  assert.equal(streams.length, 2);
  assert.equal(streams[0].name, 'VSMOV FHD');
  assert.match(streams[0].url, /^https:\/\/stremio\.example\.org\/play\/[a-f\d]{36}\/index\.m3u8$/);
  assert.equal(streams[0].subtitles?.length, 1);
  assert.equal(streams[1].name, 'KKPhim FHD');
  assert.equal(streams[1].url, 'https://s6.example.org/hls/index.m3u8');
  assert.equal(streams[1].behaviorHints.proxyHeaders, undefined);
});

test('playback: EDGE_BYPASS_HOSTS keeps segments of matching hosts or referers on /play/', async () => {
  const saved = { s: process.env.EDGE_SECRET, b: process.env.EDGE_BYPASS_HOSTS };
  process.env.EDGE_SECRET = 'edge-test-secret';
  process.env.EDGE_BYPASS_HOSTS = 'streamc.xyz, blocked.example';
  try {
    const store = new PlaybackStore({ lookup, secret: 'k' });
    const sess = (referer) => ({ referer });
    assert.equal(store.edgePath(sess('https://embed3.streamc.xyz/embed.php?hash=x'), 'https://sings3.amass2.top/a/streamaaa0000.html'), null);
    assert.equal(store.edgePath(sess('https://v8.example.org/video/h'), 'https://cdn.blocked.example/a.ts'), null);
    assert.match(store.edgePath(sess('https://v8.example.org/video/h'), 'https://p25.example.org/file-tiktok_1.png'), /^\/edge\//);
  } finally {
    for (const [k, v] of [['EDGE_SECRET', saved.s], ['EDGE_BYPASS_HOSTS', saved.b]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
