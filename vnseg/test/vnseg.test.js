"use strict";
// Run: node --test test/*.test.js   (needs openssl on PATH)
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const http2 = require('http2');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createServer, H2Pool, stripPng, tsOffset, signedPath } = require('../vnseg.js');

const SECRET = 'test-secret';
const REF = 'https://embed11.streamc.xyz/embed.php?hash=abc';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vnseg-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const r = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

function tsBody(n, fill = 0xaa) {
  const b = Buffer.alloc(188 * n, fill);
  for (let i = 0; i < n; i++) b[i * 188] = 0x47;
  return b;
}
const TS = tsBody(20);
const BIG = tsBody(2000, 0xbb); // 376 KB
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 0x47 ^ 0xff), TS]);

let upstream, origin, proxy, base, hits, logs;
let holdActive = 0, holdMax = 0;

test.before(async () => {
  hits = {}; logs = [];
  upstream = http2.createSecureServer(makeCert(), async (req, res) => {
    const p = req.url;
    hits[p] = (hits[p] || 0) + 1;
    if (req.headers.referer !== REF) { res.writeHead(403); return res.end('no ref'); }
    if (p === '/a.ts' || p.startsWith('/h.ts')) { res.writeHead(200, { 'content-length': TS.length }); return res.end(TS); }
    if (p.startsWith('/b.png')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    if (p.startsWith('/slow')) { // first 1880 bytes now, the rest 400 ms later
      res.writeHead(200, { 'content-length': BIG.length });
      res.write(BIG.subarray(0, 1880));
      await sleep(400);
      return res.end(BIG.subarray(1880));
    }
    if (p.startsWith('/drip.png')) { // PNG prefix arrives in tiny pieces
      res.writeHead(200, { 'content-length': PNG.length });
      for (let i = 0; i < 200; i += 7) { res.write(PNG.subarray(i, Math.min(i + 7, 200))); await sleep(2); }
      return res.end(PNG.subarray(200));
    }
    if (p.startsWith('/stall')) { // first attempt never answers, the retry does
      if (hits[p] === 1) return;
      res.writeHead(200, { 'content-length': TS.length }); return res.end(TS);
    }
    if (p.startsWith('/hold/')) {
      holdActive++; holdMax = Math.max(holdMax, holdActive);
      await sleep(150);
      holdActive--;
      res.writeHead(200, { 'content-length': TS.length }); return res.end(TS);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  origin = `https://localhost:${upstream.address().port}`;
  proxy = createServer({ secret: SECRET, egressHint: 'test', log: (l) => logs.push(l), headerTimeoutMs: 300, pool: new H2Pool({ connectOpts: { rejectUnauthorized: false } }) });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${proxy.address().port}`;
});
test.after(() => { proxy.close(); upstream.close(); });

function get(p, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now(); let ttfb = null;
    const req = http.request(base + p, { method }, (res) => {
      const c = []; res.on('data', (d) => { if (ttfb == null) ttfb = Date.now() - t0; c.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c), ttfb, total: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const seg = (p, ref = REF) => signedPath(SECRET, `${origin}${p}`, ref);

test('rejects a bad HMAC with 403 and malformed paths with 404', async () => {
  const good = seg('/a.ts');
  const bad = good.replace(/\/([0-9a-f]{64})\//, (m, s) => `/${(s[0] === 'a' ? 'b' : 'a') + s.slice(1)}/`);
  assert.strictEqual((await get(bad)).status, 403);
  assert.strictEqual((await get(signedPath('other', `${origin}/a.ts`, REF))).status, 403);
  assert.strictEqual((await get('/seg/xx/yy/zz/seg.ts')).status, 404);
  assert.strictEqual(hits['/a.ts'], undefined, 'upstream must not be hit');
});

test('rejects non-https targets', async () => {
  assert.strictEqual((await get(signedPath(SECRET, 'http://localhost:1/a.ts', REF))).status, 403);
});

test('passes MPEG-TS through unchanged with length and Accept-Ranges none', async () => {
  const r = await get(seg('/a.ts'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-type'], 'video/mp2t');
  assert.strictEqual(r.headers['accept-ranges'], 'none');
  assert.strictEqual(r.headers['access-control-allow-origin'], '*');
  assert.match(r.headers['cache-control'], /max-age=86400/);
  assert.strictEqual(Number(r.headers['content-length']), TS.length);
  assert.ok(r.body.equals(TS));
});

test('strips the fake PNG prefix (whole and dripped in tiny chunks)', async () => {
  const r = await get(seg('/b.png'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body[0], 0x47);
  assert.strictEqual(r.body.length % 188, 0);
  assert.ok(r.body.equals(TS));
  const d = await get(seg('/drip.png'));
  assert.strictEqual(d.status, 200);
  assert.strictEqual(Number(d.headers['content-length']), TS.length, 'length = upstream length minus prefix');
  assert.ok(d.body.equals(TS));
  assert.ok(stripPng(TS) === TS, 'non-PNG returned as is');
  assert.strictEqual(tsOffset(PNG.subarray(0, 100), false), -1, 'needs more bytes');
  assert.strictEqual(tsOffset(PNG), 128);
});

test('streams the body: first bytes arrive before upstream finishes', async () => {
  const r = await get(seg('/slow.ts'));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.equals(BIG));
  assert.ok(r.ttfb < 250, `ttfb ${r.ttfb}ms should be well under the 400 ms upstream pause`);
  assert.ok(r.total >= 350, `total ${r.total}`);
  const again = await get(seg('/slow.ts'));
  assert.strictEqual(again.headers['x-vnseg-cache'], 'HIT');
  assert.ok(again.body.equals(BIG));
  assert.strictEqual(hits['/slow.ts'], 1);
});

test('concurrent requests share one upstream fetch', async () => {
  const [a, b] = await Promise.all([get(seg('/slow2.ts')), (async () => { await sleep(50); return get(seg('/slow2.ts')); })()]);
  assert.ok(a.body.equals(BIG) && b.body.equals(BIG));
  assert.strictEqual(b.headers['x-vnseg-cache'], 'JOIN');
  assert.strictEqual(hits['/slow2.ts'], 1);
});

test('client abort mid-stream still completes and caches the segment', async () => {
  await new Promise((resolve) => {
    const req = http.get(base + seg('/slow3.ts'), (res) => {
      res.once('data', () => { req.destroy(); resolve(); });
    });
    req.on('error', () => {});
  });
  await sleep(600);
  const r = await get(seg('/slow3.ts'));
  assert.strictEqual(r.headers['x-vnseg-cache'], 'HIT');
  assert.ok(r.body.equals(BIG));
  assert.strictEqual(hits['/slow3.ts'], 1);
  assert.ok(proxy.vnseg.stats.aborts >= 1);
});

test('HEAD on a miss answers headers only; HEAD on a hit too', async () => {
  const h = await get(seg('/h.ts'), 'HEAD');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.length, 0);
  assert.strictEqual(Number(h.headers['content-length']), TS.length);
  await sleep(50);
  const h2 = await get(seg('/h.ts'), 'HEAD');
  assert.strictEqual(h2.headers['x-vnseg-cache'], 'HIT');
  assert.strictEqual(hits['/h.ts'], 1);
});

test('prefetch fills the cache, accepts absolute URLs, ignores unsigned paths; health reports', async () => {
  const signed = seg('/b.png?x=1');
  const abs = 'https://vnseg.example.org' + seg('/b.png?x=2');
  const r = await get('/prefetch', 'POST', JSON.stringify([signed, abs, '/seg/a/b/' + '0'.repeat(64) + '/seg.ts', 'junk']));
  assert.strictEqual(r.status, 202);
  assert.strictEqual(JSON.parse(r.body).accepted, 2);
  for (let i = 0; i < 50 && !(hits['/b.png?x=1'] && hits['/b.png?x=2']); i++) await sleep(20);
  await sleep(50);
  assert.strictEqual((await get(signed)).headers['x-vnseg-cache'], 'HIT');
  const h = JSON.parse((await get('/health')).body);
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.egressHint, 'test');
  assert.ok(h.prefetched >= 2);
  assert.strictEqual((await get('/prefetch')).status, 405);
});

test('prefetch runs at most 6 upstream fetches at once', async () => {
  const list = Array.from({ length: 14 }, (_, i) => seg(`/hold/${i}.ts`));
  const r = await get('/prefetch', 'POST', JSON.stringify(list));
  assert.strictEqual(JSON.parse(r.body).accepted, 14);
  for (let i = 0; i < 100 && proxy.vnseg.stats.prefetched < 16; i++) await sleep(20);
  assert.ok(holdMax <= 6, `max concurrent ${holdMax}`);
  assert.strictEqual(holdMax, 6);
  for (let i = 0; i < 14; i++) assert.strictEqual(hits[`/hold/${i}.ts`], 1);
});

test('upstream non-200 becomes 502 and is logged on one line', async () => {
  const before = logs.length;
  const m = await get(seg('/missing.ts'));
  assert.strictEqual(m.status, 502);
  assert.strictEqual(m.body.toString(), 'upstream 404');
  assert.strictEqual((await get(seg('/a.ts', 'https://wrong/'))).status, 502);
  assert.strictEqual(logs.length - before, 2);
  assert.ok(logs.every((l) => !l.includes('\n')));
});

test('a stalled first attempt is retried after the header timeout', async () => {
  const r = await get(seg('/stall.ts'));
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.equals(TS));
  assert.strictEqual(hits['/stall.ts'], 2);
  assert.ok(r.total >= 280 && r.total < 2000, `total ${r.total}`);
  assert.ok(logs.some((l) => l.includes('RETRY') && l.includes('no headers')));
});
