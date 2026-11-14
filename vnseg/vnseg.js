#!/usr/bin/env node
'use strict';
// vnseg: home segment proxy. Player speaks HTTP/1.1 to us, we fetch the
// StreamC CDN over HTTP/2 with large flow-control windows and stream the body
// straight through (PNG disguise stripped on the fly), filling an LRU cache.
// Route: GET|HEAD /seg/<b64url(url)>/<b64url(referer)>/<hmac hex>/seg.ts
// HMAC-SHA256 hex over `${url}\n${referer}` with VNSEG_SECRET.
// POST /prefetch  body: JSON array of signed /seg/ paths (or absolute URLs).
// GET /health. Binds 127.0.0.1 only (published through cloudflared).
// No dependencies. Node >= 18.

const http = require('http');
const http2 = require('http2');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_SCAN = 8192; // the TS sync offset must start within the first 8 KB
const PREFETCH_MAX = 6;
const PREFETCH_QUEUE_MAX = 200;

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
function b64urlEncode(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function sign(secret, url, referer) {
  return crypto.createHmac('sha256', secret).update(`${url}\n${referer}`).digest('hex');
}
function verify(secret, url, referer, sig) {
  if (!secret || !/^[0-9a-f]{64}$/i.test(sig || '')) return false;
  const a = Buffer.from(sign(secret, url, referer), 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signedPath(secret, url, referer) {
  return `/seg/${b64urlEncode(url)}/${b64urlEncode(referer)}/${sign(secret, url, referer)}/seg.ts`;
}

// Offset of the first TS sync byte (>= 8) that repeats at +188 and +376 in a
// PNG-disguised body. Returns 0 for a non-PNG body, -1 if more bytes are
// needed (final=false), and 0 when no sync shows up within PNG_SCAN.
function tsOffset(buf, final = true) {
  if (buf.length < 8) return final ? 0 : -1;
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return 0;
  const lim = Math.min(PNG_SCAN, buf.length - 377);
  for (let i = 8; i <= lim; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  if (!final && buf.length < PNG_SCAN + 377) return -1;
  return 0;
}
function stripPng(buf) {
  const o = tsOffset(buf, true);
  return o > 0 ? buf.subarray(o) : buf;
}

function parseSegPath(pathname) {
  const m = /^\/seg\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]*)\/([0-9a-fA-F]{64})\/seg\.ts$/.exec(pathname);
  if (!m) return null;
  return { url: b64urlDecode(m[1]), referer: b64urlDecode(m[2]), sig: m[3].toLowerCase() };
}

class LruCache {
  constructor(maxBytes) { this.max = maxBytes; this.bytes = 0; this.map = new Map(); }
  get(k) {
    const v = this.map.get(k);
    if (!v) return undefined;
    this.map.delete(k); this.map.set(k, v);
    return v;
  }
  has(k) { return this.map.has(k); }
  set(k, buf) {
    if (buf.length > this.max) return;
    if (this.map.has(k)) { this.bytes -= this.map.get(k).length; this.map.delete(k); }
    this.map.set(k, buf); this.bytes += buf.length;
    while (this.bytes > this.max) {
      const [ok, ov] = this.map.entries().next().value;
      this.map.delete(ok); this.bytes -= ov.length;
    }
  }
  get size() { return this.map.size; }
}

class H2Pool {
  constructor(opts = {}) {
    this.sessions = new Map();
    this.window = opts.window || 32 * 1024 * 1024;
    this.streamWindow = opts.streamWindow || 8 * 1024 * 1024;
    this.connectOpts = opts.connectOpts || {};
  }
  session(origin) {
    let s = this.sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    s = http2.connect(origin, { ...this.connectOpts, settings: { initialWindowSize: this.streamWindow } });
    const drop = () => { if (this.sessions.get(origin) === s) this.sessions.delete(origin); };
    s.on('connect', () => { try { s.setLocalWindowSize(this.window); } catch {} });
    s.on('goaway', drop); s.on('close', drop);
    s.on('error', () => { drop(); });
    s.setTimeout(120000, () => { drop(); s.close(); });
    s.unref && s.unref();
    this.sessions.set(origin, s);
    return s;
  }
  // Streaming request: resolves on response headers with { status, headers, stream }.
  // After that, failures arrive as 'vnseg-error' on the stream.
  open(url, headers, timeoutMs = 20000, headerMs = timeoutMs) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      let s;
      try { s = this.session(u.origin); } catch (e) { return reject(e); }
      let req;
      try {
        req = s.request({ ':method': 'GET', ':path': u.pathname + u.search, ...headers });
      } catch (e) { this.sessions.delete(u.origin); return reject(e); }
      let settled = false;
      const ht = setTimeout(() => { // response headers must arrive within headerMs
        if (settled) return;
        settled = true;
        req.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error(`no headers in ${headerMs}ms`));
      }, headerMs);
      req.on('response', () => clearTimeout(ht));
      req.on('close', () => clearTimeout(ht));
      req.setTimeout(timeoutMs, () => { // idle: no headers or no data for timeoutMs
        const e = new Error('upstream timeout');
        req.close(http2.constants.NGHTTP2_CANCEL);
        if (!settled) { settled = true; reject(e); } else req.emit('vnseg-error', e);
      });
      req.on('response', (h) => { if (!settled) { settled = true; resolve({ status: h[':status'], headers: h, stream: req }); } });
      req.on('error', (e) => {
        this.sessions.delete(u.origin);
        if (!settled) { settled = true; reject(e); } else req.emit('vnseg-error', e);
      });
      req.end();
    });
  }
  close() { for (const s of this.sessions.values()) s.close(); this.sessions.clear(); }
}

// One upstream fetch shared by every client that asks for the same segment.
// Emits 'head' ({status, length}), 'data' (Buffer), 'end', 'error'.
class Fill extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.on('error', () => {}); // never throw when nobody is listening
    this.head = null; this.chunks = []; this.bytes = 0; this.done = false; this.err = null; this.joined = false;
  }
}

function createServer(opts = {}) {
  const secret = opts.secret ?? process.env.VNSEG_SECRET ?? '';
  const cache = new LruCache(opts.cacheBytes ?? (Number(process.env.VNSEG_CACHE_MB || 300) * 1024 * 1024));
  const pool = opts.pool || new H2Pool(opts.poolOpts);
  const egressHint = opts.egressHint ?? process.env.VNSEG_EGRESS_HINT ?? '';
  const log = opts.log || ((line) => console.error(line));
  const timeoutMs = opts.upstreamTimeoutMs ?? 20000;
  const headerMs = opts.headerTimeoutMs ?? Number(process.env.VNSEG_HEADER_MS || 6000);
  const fills = new Map();
  const stats = { hits: 0, misses: 0, joins: 0, errors: 0, aborts: 0, prefetched: 0 };
  let prefetchActive = 0; const prefetchQueue = [];

  function upstreamHeaders(referer) {
    const headers = { 'user-agent': UA, accept: '*/*' };
    if (referer && referer !== '-') {
      headers.referer = referer;
      try { headers.origin = new URL(referer).origin; } catch {}
    }
    return headers;
  }

  // Start (or join) the upstream fetch for url+referer. Never throws; errors
  // are delivered on the Fill. The fetch runs to completion even if every
  // client aborts, so the cache still gets the segment.
  function fill(url, referer) {
    const key = `${url}\n${referer}`;
    const existing = fills.get(key);
    if (existing) { stats.joins++; existing.joined = true; return existing; }
    stats.misses++;
    const f = new Fill();
    fills.set(key, f);
    const finish = (err) => {
      if (f.done) return;
      f.done = true; f.err = err || null;
      fills.delete(key);
      if (err) { stats.errors++; f.emit('error', err); }
      else f.emit('end');
    };
    (async () => {
      const headers = upstreamHeaders(referer);
      let r;
      try { r = await pool.open(url, headers, timeoutMs, headerMs); }
      catch (e) { // one retry (fresh session if the old one broke)
        log(`${new Date().toISOString()} RETRY ${hostOf(url)} ${e.message}`);
        r = await pool.open(url, headers, timeoutMs, timeoutMs);
      }
      if (r.status !== 200) {
        r.stream.on('vnseg-error', () => {});
        r.stream.resume();
        try { r.stream.close(http2.constants.NGHTTP2_CANCEL); } catch {}
        f.head = { status: r.status, length: null };
        f.emit('head', f.head);
        return finish(Object.assign(new Error(`upstream ${r.status}`), { status: r.status }));
      }
      const cl = Number(r.headers['content-length']);
      let pending = []; let pendingBytes = 0;
      const push = (c) => {
        if (!c.length) return;
        f.chunks.push(c); f.bytes += c.length; f.emit('data', c);
      };
      const release = (final) => {
        const buf = Buffer.concat(pending, pendingBytes);
        const offset = tsOffset(buf, final);
        if (offset < 0) return;
        f.head = { status: 200, length: Number.isFinite(cl) && cl > 0 ? cl - offset : null };
        pending = null;
        f.emit('head', f.head);
        push(offset ? buf.subarray(offset) : buf);
      };
      r.stream.on('data', (c) => {
        if (pending) { pending.push(c); pendingBytes += c.length; release(false); }
        else push(c);
      });
      r.stream.on('end', () => {
        if (pending) release(true);
        const body = Buffer.concat(f.chunks, f.bytes);
        if (f.head.length != null && body.length !== f.head.length) return finish(new Error(`short body ${body.length}/${f.head.length}`));
        cache.set(key, body);
        finish();
      });
      r.stream.on('vnseg-error', (e) => finish(e));
      r.stream.on('close', () => { if (!f.done) setImmediate(() => finish(new Error('upstream closed'))); });
    })().catch((e) => {
      if (!f.head) { f.head = { status: 0, length: null }; f.emit('head', f.head); }
      finish(e);
    });
    return f;
  }

  function hostOf(u) { try { return new URL(u).host; } catch { return '?'; } }

  function pumpPrefetch() {
    while (prefetchActive < PREFETCH_MAX && prefetchQueue.length) {
      const { url, referer } = prefetchQueue.shift();
      const key = `${url}\n${referer}`;
      if (cache.has(key) || fills.has(key)) continue;
      prefetchActive++;
      const f = fill(url, referer);
      let settled = false;
      const done = () => { if (settled) return; settled = true; prefetchActive--; stats.prefetched++; pumpPrefetch(); };
      f.once('end', done);
      f.once('error', (e) => { log(`${new Date().toISOString()} PREFETCH ${hostOf(url)} ${e.message}`); done(); });
    }
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS' };
  function send(res, code, body, type = 'text/plain') {
    res.writeHead(code, { ...cors, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    res.end(body);
  }
  function segHeaders(cacheState, t0, length) {
    const h = {
      ...cors,
      'Content-Type': 'video/mp2t',
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'none',
      'X-Vnseg-Cache': cacheState,
      'X-Vnseg-Ms': String(Date.now() - t0),
    };
    if (length != null) h['Content-Length'] = length;
    return h;
  }

  function serveSeg(req, res, seg) {
    const t0 = Date.now();
    const head = req.method === 'HEAD';
    const key = `${seg.url}\n${seg.referer}`;
    const hit = cache.get(key);
    if (hit) {
      stats.hits++;
      res.writeHead(200, segHeaders('HIT', t0, hit.length));
      return res.end(head ? undefined : hit);
    }
    const f = fill(seg.url, seg.referer);
    const state = f.joined ? 'JOIN' : 'MISS';
    let sent = 0; let started = false; let closed = false;
    const cleanup = () => { f.off('data', onData); f.off('end', onEnd); f.off('error', onError); f.off('head', onHead); };
    const fail = (e) => {
      log(`${new Date().toISOString()} ${req.method} ${hostOf(seg.url)} ${e && e.message} after ${sent}B ${Date.now() - t0}ms`);
      if (!started) {
        started = true;
        const st = e && e.status;
        return send(res, 502, st ? `upstream ${st}` : 'upstream error');
      }
      res.destroy(); // truncated body: the player retries
    };
    function onData(c) { if (!closed) { sent += c.length; res.write(c); } }
    function onEnd() { cleanup(); if (!closed) res.end(); }
    function onError(e) { cleanup(); if (!closed) fail(e); }
    function onHead(h) { if (h.status === 200 && !closed && !started) start(); }
    function start() {
      started = true;
      res.writeHead(200, segHeaders(state, t0, f.head.length));
      if (head) { cleanup(); return res.end(); }
      for (const c of f.chunks) { sent += c.length; res.write(c); }
      if (f.done) { cleanup(); return f.err ? fail(f.err) : res.end(); }
      f.on('data', onData);
    }
    res.on('close', () => {
      if (!res.writableFinished) { closed = true; stats.aborts++; cleanup(); }
    });
    f.on('error', onError);
    f.on('end', onEnd);
    if (f.head && f.head.status === 200) start();
    else f.on('head', onHead);
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return send(res, 400, 'bad url'); }
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (pathname === '/health') {
      return send(res, 200, JSON.stringify({ ok: true, egressHint, cacheItems: cache.size, cacheMB: Math.round(cache.bytes / 1048576), inflight: fills.size, prefetchQueue: prefetchQueue.length, prefetchActive, ...stats }), 'application/json');
    }
    if (pathname === '/prefetch') {
      if (req.method !== 'POST') return send(res, 405, 'method not allowed');
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        let list;
        try { list = JSON.parse(raw); } catch { return send(res, 400, 'bad json'); }
        if (!Array.isArray(list)) list = list && Array.isArray(list.paths) ? list.paths : null;
        if (!list) return send(res, 400, 'expected array');
        let accepted = 0;
        for (const p of list.slice(0, 50)) {
          let pn;
          try { pn = new URL(String(p), 'http://x').pathname; } catch { continue; }
          const seg = parseSegPath(pn);
          if (!seg || !seg.url.startsWith('https://') || !verify(secret, seg.url, seg.referer, seg.sig)) continue;
          if (prefetchQueue.length >= PREFETCH_QUEUE_MAX) break;
          prefetchQueue.push(seg); accepted++;
        }
        pumpPrefetch();
        send(res, 202, JSON.stringify({ accepted }), 'application/json');
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const seg = parseSegPath(pathname);
    if (!seg) return send(res, 404, 'not found');
    if (!verify(secret, seg.url, seg.referer, seg.sig)) return send(res, 403, 'forbidden');
    if (!seg.url.startsWith('https://')) return send(res, 403, 'https only');
    serveSeg(req, res, seg);
  });
  server.on('close', () => pool.close());
  server.vnseg = { cache, pool, stats, fills, prefetchQueue, get prefetchActive() { return prefetchActive; } };
  return server;
}

module.exports = { createServer, H2Pool, LruCache, stripPng, tsOffset, sign, verify, signedPath, parseSegPath, b64urlEncode, b64urlDecode, PREFETCH_MAX };

if (require.main === module) {
  if (!process.env.VNSEG_SECRET) { console.error('VNSEG_SECRET is required'); process.exit(1); }
  const port = Number(process.env.VNSEG_PORT || 8787);
  const host = '127.0.0.1'; // never exposed directly; cloudflared publishes it
  process.on('uncaughtException', (e) => console.error(`${new Date().toISOString()} uncaught ${(e && e.stack) || e}`));
  createServer().listen(port, host, () => console.log(`vnseg listening on http://${host}:${port}`));
}
