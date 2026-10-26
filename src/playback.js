'use strict';

const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const dns = require('node:dns').promises;
const { isSafeUrl, safeToFetch } = require('./streams');
const { UA, MAX_PLAYLIST, decryptHlsManifest } = require('./streamc');

function resolvePlaylistUrl(raw, baseUrl) {
  try {
    const url = new URL(raw, baseUrl).href;
    return isSafeUrl(url) ? url : null;
  } catch { return null; }
}

function rewriteManifest(text, baseUrl, mapUrl) {
  if (typeof text !== 'string' || !text.startsWith('#EXTM3U')) return null;
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) {
      // Rewrite AES-128 keys, EXT-X-MAP, alternative audio and subtitle tracks.
      return line.replace(/\bURI=(['"])([^'"]+)\1/g, (all, quote, raw) => {
        const uri = resolvePlaylistUrl(raw, baseUrl);
        return uri ? `URI=${quote}${mapUrl(uri)}${quote}` : all;
      });
    }
    const uri = resolvePlaylistUrl(line.trim(), baseUrl);
    return uri ? mapUrl(uri) : line;
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

class PlaybackStore {
  constructor({ fetchImpl = (...args) => fetch(...args), lookup = dns.lookup,
                timeoutMs = 20000, maxSessions = 80 } = {}) {
    this.sessions = new Map();
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.timeoutMs = timeoutMs;
    this.maxSessions = maxSessions;
  }

  create({ playlist, playlistUrl, referer, videoHash }) {
    if (!playlist || !playlist.startsWith('#EXTM3U') || !isSafeUrl(playlistUrl)) return null;
    const id = crypto.randomBytes(18).toString('hex');
    for (const [key, session] of this.sessions) {
      if (session.until < Date.now()) this.sessions.delete(key);
    }
    while (this.sessions.size >= this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(id, {
      until: Date.now() + 6 * 60 * 60 * 1000,
      playlist, playlistUrl,
      referer: isSafeUrl(referer) ? referer : playlistUrl,
      videoHash: typeof videoHash === 'string' ? videoHash : '',
      assets: [],
      assetIndices: new Map()
    });
    return id;
  }

  // Media segments go through the Cloudflare edge relay (signed URL, Referer added
  // at the edge) when EDGE_SECRET is set; playlists stay here (they may need decrypting).
  edgePath(session, url) {
    const secret = process.env.EDGE_SECRET;
    if (!secret || process.env.EDGE_RELAY === '0') return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== 'https:' || /\.m3u8$/i.test(parsed.pathname)) return null;
    const b64 = (v) => Buffer.from(v).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${url}\n${session.referer}`).digest('hex');
    return `/edge/${b64(url)}/${b64(session.referer)}/${sig}/seg.ts`;
  }

  assetPath(id, session, url) {
    const edge = this.edgePath(session, url);
    if (edge) return edge;
    let number = session.assetIndices.get(url);
    if (number === undefined) {
      if (session.assets.length > 20000) throw new Error('Too many playlist assets');
      number = session.assets.length;
      session.assets.push(url);
      session.assetIndices.set(url, number);
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
    const [, id, path, assetIndex] = match;
    const session = this.sessions.get(id);
    if (!session || Date.now() > session.until) {
      res.writeHead(404, this.headers('text/plain').headers); res.end(); return true;
    }
    session.until = Date.now() + 6 * 60 * 60 * 1000;
    if (path === 'index.m3u8') {
      const rewritten = rewriteManifest(session.playlist, session.playlistUrl,
        (url) => this.assetPath(id, session, url));
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
        const normalized = rewriteManifest(text, target, (uri) => this.assetPath(id, session, uri));
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
