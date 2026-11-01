'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dns = require('node:dns').promises;
const { isSafeUrl, safeToFetch } = require('./streams');
const { UA, MAX_PLAYLIST, decryptHlsManifest } = require('./streamc');

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const RESAVE_AFTER_MS = 30 * 60 * 1000;   // persist a sliding expiry at most this often
const ID_RE = /^[a-f\d]{36}$/;

function resolvePlaylistUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl).href;
    return isSafeUrl(url) ? url : null;
  } catch { return null; }
}

// mapUrl(uri, { playlist }) is told whether the URI is itself a playlist: the line after
// #EXT-X-STREAM-INF, or the URI of #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF. Those must
// stay on /play/ (they may need decrypting and rewriting) even without a .m3u8 suffix.
function rewriteManifest(text, baseUrl, mapUrl) {
  if (typeof text !== 'string' || !text.startsWith('#EXTM3U')) return null;
  let variantNext = false;
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF\b/i.test(line)) variantNext = true;
      const playlist = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)\b/i.test(line);
      // Rewrite AES-128 keys, EXT-X-MAP, alternative audio and subtitle tracks.
      return line.replace(/\bURI=(['"])([^'"]+)\1/g, (all, quote, raw) => {
        const uri = resolvePlaylistUrl(raw, baseUrl);
        return uri ? `URI=${quote}${mapUrl(uri, { playlist })}${quote}` : all;
      });
    }
    const playlist = variantNext;
    variantNext = false;
    const uri = resolvePlaylistUrl(line.trim(), baseUrl);
    return uri ? mapUrl(uri, { playlist }) : line;
  }).join('\n');
}

async function limitedResponseText(response, cap = MAX_PLAYLIST) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > cap) return null;
  const chunks = [];
  let total = 0;
  if (!response.body) return '';
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.byteLength;
    if (total > cap) { await response.body.cancel().catch(() => {}); return null; }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Playback sessions hold a resolved (often decrypted) HLS playlist so Stremio can play it.
// - One session per playlist: the id is derived from the playlist identity, so repeated
//   /stream/ calls (and Stremio's binge prefetch) get the same /play/ URL.
// - Least recently used sessions leave memory first; playing a session keeps it fresh.
// - With PLAYBACK_DIR set, sessions are also written to disk (gzip JSON) and reloaded on a
//   miss, so a restart or a memory eviction no longer breaks a /play/ URL Stremio holds.
class PlaybackStore {
  constructor({ fetchImpl = (...args) => fetch(...args), lookup = dns.lookup,
                timeoutMs = 20000, maxSessions = Number(process.env.PLAYBACK_MAX_SESSIONS) || 80,
                dir = process.env.PLAYBACK_DIR || null, ttlMs = SESSION_TTL_MS,
                maxFiles = Number(process.env.PLAYBACK_MAX_FILES) || 500,
                secret = process.env.PLAYBACK_SECRET || process.env.EDGE_SECRET || '',
                logger = console } = {}) {
    this.sessions = new Map();   // id -> session, least recently used first
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.timeoutMs = timeoutMs;
    this.maxSessions = Math.max(1, maxSessions);
    this.ttlMs = ttlMs;
    this.dir = dir;
    this.maxFiles = Math.max(1, maxFiles);
    // Without a configured secret ids are still unguessable, just not stable across restarts.
    this.secret = secret || crypto.randomBytes(32).toString('hex');
    this.logger = logger;
    this.saveTimers = new Map();
    if (this.dir) {
      this.pruneFiles().catch(() => {});
      setInterval(() => this.pruneFiles().catch(() => {}), 60 * 60 * 1000).unref?.();
    }
  }

  idFor(playlistUrl, referer, videoHash) {
    return crypto.createHmac('sha256', `${this.secret}:playback`)
      .update(`${playlistUrl}\n${referer}\n${videoHash}`).digest('hex').slice(0, 36);
  }

  fileFor(id) { return path.join(this.dir, `${id}.json.gz`); }

  create({ playlist, playlistUrl, referer, videoHash }) {
    if (!playlist || !playlist.startsWith('#EXTM3U') || !isSafeUrl(playlistUrl)) return null;
    const ref = isSafeUrl(referer) ? referer : playlistUrl;
    const hash = typeof videoHash === 'string' ? videoHash : '';
    const id = this.idFor(playlistUrl, ref, hash);
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.until < now) this.sessions.delete(key);
    }
    const existing = this.get(id, now);
    if (existing) {
      // Same playlist identity: reuse it. A re-resolve may bring refreshed playlist text;
      // asset numbers are append-only, so URLs already handed out keep working.
      if (existing.playlist !== playlist) { existing.playlist = playlist; this.persist(id, existing); }
      return id;
    }
    const session = {
      until: now + this.ttlMs, savedUntil: 0,
      playlist, playlistUrl, referer: ref, videoHash: hash,
      assets: [], assetIndices: new Map()
    };
    this.remember(id, session);
    this.persist(id, session);
    return id;
  }

  remember(id, session) {
    this.sessions.delete(id);
    this.sessions.set(id, session);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
  }

  // Look a session up (memory first, then disk) and mark it as used.
  get(id, now = Date.now()) {
    if (!ID_RE.test(id)) return null;
    let session = this.sessions.get(id);
    if (session && session.until < now) { this.sessions.delete(id); session = null; }
    if (!session) session = this.load(id, now);
    if (!session) return null;
    session.until = now + this.ttlMs;
    this.remember(id, session);
    if (session.until - session.savedUntil > RESAVE_AFTER_MS) this.persist(id, session);
    return session;
  }

  load(id, now) {
    if (!this.dir) return null;
    try {
      const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.fileFor(id))).toString('utf8'));
      if (data?.v !== 1 || !(data.until > now) || typeof data.playlist !== 'string' ||
          !isSafeUrl(data.playlistUrl) || !isSafeUrl(data.referer)) return null;
      const assets = Array.isArray(data.assets) ? data.assets.filter((u) => typeof u === 'string') : [];
      return {
        until: data.until, savedUntil: data.until,
        playlist: data.playlist, playlistUrl: data.playlistUrl, referer: data.referer,
        videoHash: typeof data.videoHash === 'string' ? data.videoHash : '',
        assets, assetIndices: new Map(assets.map((u, i) => [u, i]))
      };
    } catch (e) {
      if (e.code !== 'ENOENT') this.logger.warn?.(`[play] session ${id.slice(0, 8)} load failed: ${e.message}`);
      return null;
    }
  }

  // Debounced write (tmp + rename) so bursts of asset registrations cost one write.
  persist(id, session) {
    if (!this.dir || this.saveTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete(id);
      this.write(id, session).catch((e) => this.logger.warn?.(`[play] session save failed: ${e.message}`));
    }, 1000);
    timer.unref?.();
    this.saveTimers.set(id, timer);
  }

  async write(id, session) {
    const until = session.until;
    const body = zlib.gzipSync(JSON.stringify({
      v: 1, until, playlist: session.playlist, playlistUrl: session.playlistUrl,
      referer: session.referer, videoHash: session.videoHash, assets: session.assets
    }));
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(id);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, body, { mode: 0o600 });
    await fs.promises.rename(tmp, file);
    session.savedUntil = until;
  }

  // Write pending sessions now (tests, graceful shutdown).
  async flush() {
    for (const [id, timer] of [...this.saveTimers.entries()]) {
      clearTimeout(timer);
      this.saveTimers.delete(id);
      const session = this.sessions.get(id);
      if (session) await this.write(id, session);
    }
  }

  // Delete expired session files and keep at most maxFiles. A file is rewritten whenever
  // its sliding expiry moved RESAVE_AFTER_MS, so mtime + ttl + that margin bounds it.
  async pruneFiles(now = Date.now()) {
    if (!this.dir) return 0;
    let names;
    try { names = await fs.promises.readdir(this.dir); } catch { return 0; }
    const files = [];
    for (const name of names) {
      const tmp = /^[a-f\d]{36}\.json\.gz\..+\.tmp$/.test(name);
      if (!tmp && !/^[a-f\d]{36}\.json\.gz$/.test(name)) continue;
      const file = path.join(this.dir, name);
      try { files.push({ file, tmp, mtime: (await fs.promises.stat(file)).mtimeMs }); } catch {}
    }
    let removed = 0;
    const keep = [];
    for (const f of files) {
      const limit = f.tmp ? 10 * 60 * 1000 : this.ttlMs + RESAVE_AFTER_MS;
      if (f.mtime + limit < now) { await fs.promises.unlink(f.file).catch(() => {}); removed++; }
      else if (!f.tmp) keep.push(f);
    }
    keep.sort((a, b) => a.mtime - b.mtime);
    while (keep.length > this.maxFiles) { await fs.promises.unlink(keep.shift().file).catch(() => {}); removed++; }
    return removed;
  }

  // Media segments go through the Cloudflare edge relay (signed URL, Referer added
  // at the edge) when EDGE_SECRET is set. Playlists, with or without a .m3u8 suffix,
  // stay here: they may need decrypting and their URIs must be rewritten.
  edgePath(session, url, { playlist = false } = {}) {
    const secret = process.env.EDGE_SECRET;
    if (!secret || process.env.EDGE_RELAY === '0' || playlist) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:' || /\.m3u8$/i.test(parsed.pathname)) return null;
    const b64 = (v) => Buffer.from(v).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${url}\n${session.referer}`).digest('hex');
    return `/edge/${b64(url)}/${b64(session.referer)}/${sig}/seg.ts`;
  }

  assetPath(id, session, url, hint = {}) {
    const edge = this.edgePath(session, url, hint);
    if (edge) return edge;
    let number = session.assetIndices.get(url);
    if (number === undefined) {
      if (session.assets.length > 20000) throw new Error('Too many playlist assets');
      number = session.assets.length;
      session.assets.push(url);
      session.assetIndices.set(url, number);
      this.persist(id, session);
    }
    return `/play/${id}/asset/${number}`;
  }

  headers(contentType, status = 200, additional = {}) {
    return { status, headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      ...additional
    } };
  }

  async upstream(url, referer, range) {
    let target = url;
    for (let redirect = 0; redirect <= 2; redirect++) {
      if (!await safeToFetch(target, this.lookup)) return null;
      const headers = { 'User-Agent': UA, 'Referer': referer, 'Origin': new URL(referer).origin };
      if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
      const response = await this.fetchImpl(target, {
        redirect: 'manual', headers, signal: AbortSignal.timeout(this.timeoutMs)
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) return null;
        target = resolvePlaylistUrl(location, target);
        if (!target) return null;
        continue;
      }
      return { response, target };
    }
    return null;
  }

  async handle(req, res, pathname) {
    const match = /^\/play\/([a-f\d]{36})\/(index\.m3u8|asset\/(\d{1,5}))$/.exec(pathname);
    if (!match) return false;
    const [, id, route, assetIndex] = match;
    const session = this.get(id);
    if (!session) {
      res.writeHead(404, this.headers('text/plain').headers); res.end(); return true;
    }
    if (route === 'index.m3u8') {
      const rewritten = rewriteManifest(session.playlist, session.playlistUrl,
        (url, hint) => this.assetPath(id, session, url, hint));
      if (!rewritten) { res.writeHead(502); res.end(); return true; }
      res.writeHead(200, this.headers('application/vnd.apple.mpegurl').headers);
      res.end(req.method === 'HEAD' ? undefined : rewritten);
      return true;
    }
    const url = session.assets[Number(assetIndex)];
    if (!url) { res.writeHead(404); res.end(); return true; }
    try {
      const outcome = await this.upstream(url, session.referer, req.headers.range);
      if (!outcome || !outcome.response.ok) {
        let host = '?'; try { host = new URL(url).host; } catch {}
        console.warn(`[play] asset ${assetIndex} upstream failed host=${host} status=${outcome ? outcome.response.status : 'blocked-or-redirect'}`);
        res.writeHead(502); res.end(); return true;
      }
      const { response, target } = outcome;
      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      const isHls = /(?:mpegurl|\.m3u8(?:$|\?))/i.test(contentType + ' ' + target);
      if (isHls && req.method !== 'HEAD') {
        let text = await limitedResponseText(response);
        if (text?.includes('#ENC-AESGCM')) text = decryptHlsManifest(text, session.videoHash);
        const normalized = rewriteManifest(text, target, (uri, hint) => this.assetPath(id, session, uri, hint));
        if (!normalized) { res.writeHead(502); res.end(); return true; }
        res.writeHead(200, this.headers('application/vnd.apple.mpegurl').headers);
        res.end(normalized);
        return true;
      }
      const responseHeaders = {};
      for (const key of ['content-length', 'content-range', 'etag', 'last-modified']) {
        const value = response.headers.get(key);
        if (value) responseHeaders[key] = value;
      }
      const status = response.status === 206 ? 206 : 200;
      res.writeHead(status, this.headers(contentType, status, responseHeaders).headers);
      if (req.method === 'HEAD' || !response.body) { res.end(); return true; }
      let count = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, callback) {
          count += chunk.byteLength;
          if (count > 64 * 1024 * 1024) callback(new Error('Asset size limit exceeded'));
          else callback(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(response.body), limiter, res);
    } catch (err) {
      let host = '?'; try { host = new URL(url).host; } catch {}
      console.warn(`[play] asset ${assetIndex} error host=${host}: ${err && (err.cause?.message || err.message)}`);
      if (!res.headersSent) res.writeHead(502);
      res.destroyed ? undefined : res.end();
    }
    return true;
  }
}

module.exports = { PlaybackStore, rewriteManifest, limitedResponseText };
