'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createAddon } = require('../src/addon');
const { createServer } = require('../src/http');
const { PlaybackStore } = require('../src/playback');
const { VnsegRelay } = require('../src/vnseg');

const silent = { warn() {}, error() {}, log() {} };
const lookup = async () => [{ address: '8.8.8.8' }];
const VBASE = 'https://vnseg.example.org';
const REF = 'https://embed3.streamc.xyz/embed.php?hash=x';
const NGUONC = '#EXTM3U\n#EXTINF:2,\nhttps://sings3.amass2.top/a/streamaaa0000.html\n#EXTINF:2,\nhttps://sings3.amass2.top/a/streamaaa0001.png\n' +
  Array.from({ length: 8 }, (_, i) => `#EXTINF:2,\nhttps://sings3.amass2.top/a/streamaaa${String(i + 2).padStart(4, '0')}.png\n`).join('');
const OTHER = '#EXTM3U\n#EXTINF:3,\nhttps://p25.example.org/file/file-tiktok_1.png\n';

// Health endpoint stub: `up` toggles it; every call and POST body is recorded.
function fakeVnseg() {
  const state = { up: true, health: 0, prefetch: [] };
  const fetchImpl = async (url, opts = {}) => {
    if (url === `${VBASE}/health`) {
      state.health++;
      if (!state.up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url === `${VBASE}/prefetch`) { state.prefetch.push(JSON.parse(opts.body)); return new Response('{"accepted":1}', { status: 202 }); }
    throw new Error(`unexpected ${url}`);
  };
  const relay = new VnsegRelay({ base: VBASE, hosts: 'streamc.xyz', secret: 'edge-test-secret', fetchImpl, logger: silent, autoStart: false });
  return { relay, state };
}

async function withServer(store, fn) {
  const addon = createAddon({ client: {}, playback: store, logger: silent, imdb: {}, extraProviders: [] });
  const server = createServer(addon, { logger: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}
const segLines = (text) => text.split('\n').filter((l) => l && !l.startsWith('#'));

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

test('vnseg: healthy relay gives matching sessions absolute signed vnseg URLs and prefetches the first 6', () =>
  withEnv({ EDGE_SECRET: 'edge-test-secret', EDGE_BYPASS_HOSTS: 'streamc.xyz' }, async () => {
    const { relay, state } = fakeVnseg();
    assert.equal(await relay.check(), true);
    const store = new PlaybackStore({ lookup, secret: 'k', vnseg: relay, logger: silent });
    const id = store.create({ playlist: NGUONC, playlistUrl: 'https://sings3.amass2.top/a/index.m3u8', referer: REF });
    await withServer(store, async (host) => {
      const lines = segLines(await (await fetch(`${host}/play/${id}/index.m3u8`)).text());
      assert.equal(lines.length, 10);
      for (const l of lines) {
        const m = /^https:\/\/vnseg\.example\.org\/seg\/([\w-]+)\/([\w-]+)\/([0-9a-f]{64})\/seg\.ts$/.exec(l);
        assert.ok(m, l);
        const url = Buffer.from(m[1], 'base64url').toString();
        const ref = Buffer.from(m[2], 'base64url').toString();
        assert.equal(ref, REF);
        assert.equal(m[3], crypto.createHmac('sha256', 'edge-test-secret').update(`${url}\n${ref}`).digest('hex'));
      }
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(state.prefetch.length, 1);
      assert.equal(state.prefetch[0].length, 6);
      assert.ok(state.prefetch[0].every((p, i) => p === lines[i].slice(VBASE.length)));
      await fetch(`${host}/play/${id}/index.m3u8`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(state.prefetch.length, 1, 'a re-fetched playlist does not prefetch again');
    });
  }));

test('vnseg: after 2 failed health checks sessions fall back to /play/, and switch back when healthy', () =>
  withEnv({ EDGE_SECRET: 'edge-test-secret', EDGE_BYPASS_HOSTS: 'streamc.xyz' }, async () => {
    const { relay, state } = fakeVnseg();
    await relay.check();
    const store = new PlaybackStore({ lookup, secret: 'k', vnseg: relay, logger: silent });
    const id = store.create({ playlist: NGUONC, playlistUrl: 'https://sings3.amass2.top/a/index.m3u8', referer: REF });
    await withServer(store, async (host) => {
      const get = async () => segLines(await (await fetch(`${host}/play/${id}/index.m3u8`)).text());
      state.up = false;
      await relay.check();
      assert.equal(relay.healthy, true, 'one failure is tolerated');
      assert.ok((await get()).every((l) => l.startsWith(`${VBASE}/seg/`)));
      await relay.check();
      assert.equal(relay.healthy, false);
      assert.equal(relay.status().lastError, 'ECONNREFUSED');
      const fallback = await get();
      assert.deepEqual(fallback, fallback.map((_, i) => `/play/${id}/asset/${i}`));
      state.up = true;
      await relay.check();
      assert.ok((await get()).every((l) => l.startsWith(`${VBASE}/seg/`)));
    });
  }));

test('vnseg: unknown health (never checked) and non-HTTP-200 health keep /play/', async () => {
  const { relay } = fakeVnseg();
  const sess = { referer: REF };
  assert.equal(relay.urlFor(sess, 'https://sings3.amass2.top/a/x.png'), null);
  const bad = new VnsegRelay({ base: VBASE, hosts: 'streamc.xyz', secret: 's', logger: silent, autoStart: false, failAfter: 1,
    fetchImpl: async () => new Response('Bad gateway', { status: 530 }) });
  assert.equal(await bad.check(), false);
  assert.equal(bad.lastError, 'HTTP 530');
});

test('vnseg: non-matching sessions are unaffected (edge / play as before), playlists never go to vnseg', () =>
  withEnv({ EDGE_SECRET: 'edge-test-secret', EDGE_BYPASS_HOSTS: 'streamc.xyz' }, async () => {
    const { relay, state } = fakeVnseg();
    await relay.check();
    const store = new PlaybackStore({ lookup, secret: 'k', vnseg: relay, logger: silent });
    const sess = (referer) => ({ referer });
    assert.match(store.edgePath(sess('https://v8.example.org/video/h'), 'https://p25.example.org/file-tiktok_1.png'), /^\/edge\//);
    assert.equal(store.edgePath(sess(REF), 'https://sings3.amass2.top/a/index.m3u8'), null);
    assert.equal(store.edgePath(sess(REF), 'https://sings3.amass2.top/a/v1', { playlist: true }), null);
    assert.match(store.edgePath(sess('https://other.example/'), 'https://cdn.streamc.xyz/a.ts'), /^https:\/\/vnseg\.example\.org\/seg\//, 'segment host match alone is enough');
    const id = store.create({ playlist: OTHER, playlistUrl: 'https://v8.example.org/stream/h/master.m3u8', referer: 'https://v8.example.org/video/h' });
    await withServer(store, async (host) => {
      const lines = segLines(await (await fetch(`${host}/play/${id}/index.m3u8`)).text());
      assert.ok(lines.every((l) => l.startsWith('/edge/')));
    });
    assert.equal(state.prefetch.length, 0);
    const off = new VnsegRelay({ base: '', hosts: 'streamc.xyz', secret: 's', autoStart: false });
    assert.equal(off.enabled, false);
  }));
