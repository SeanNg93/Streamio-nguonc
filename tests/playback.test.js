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
  const addon = createAddon({ client: {}, playback: store, logger: silent, imdb: {} });
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
