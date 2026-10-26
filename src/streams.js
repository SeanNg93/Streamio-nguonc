'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');
const { link, pickEpisode, serverList, SOURCE_ORIGIN } = require('./mapper');
const {
  UA, MAX_HTML, MAX_PLAYLIST, fetchHttp2, decryptHlsManifest, resolveBootstrap
} = require('./streamc');

function isPrivateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 88) || (a === 192 && b === 0) ||
      (a === 198 && b === 51) || (a === 203 && b === 0);
  }
  if (net.isIP(ip) === 6) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') ||
      /^fe[89ab]/.test(s) || s.startsWith('2001:db8:');
  }
  return true;
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    const name = u.hostname.toLowerCase();
    if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') ||
      name.endsWith('.internal') || name.endsWith('.test') || !name.includes('.')) return false;
    if (net.isIP(name) && isPrivateIp(name)) return false;
    return true;
  } catch { return false; }
}

async function safeToFetch(url, lookup = dns.lookup) {
  if (!isSafeUrl(url)) return false;
  const hostname = new URL(url).hostname;
  if (net.isIP(hostname)) return !isPrivateIp(hostname);
  try {
    const results = await lookup(hostname, { all: true });
    return Array.isArray(results) && results.length > 0 &&
      results.every((result) => net.isIP(result.address) && !isPrivateIp(result.address));
  } catch { return false; }
}

function directMedia(raw, base = SOURCE_ORIGIN) {
  const abs = link(raw, base);
  if (!abs || !isSafeUrl(abs)) return undefined;
  const path = new URL(abs).pathname;
  return /\.(?:m3u8|mp4|mpd|webm|mkv)$/i.test(path) ? abs : undefined;
}

function unpackPacker(html) {
  // A constrained textual unpacker for old p,a,c,k,e,d payloads; NEVER eval JS.
  if (typeof html !== 'string' || html.length > 500000 || !html.includes('eval(function(p,a,c,k,e,d)')) return '';
  const packed = /eval\(function\(p,a,c,k,e,d\)[\s\S]*?\}\('((?:\\.|[^'\\])*)',\s*(\d{1,3}),\s*(\d{1,5}),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/.exec(html);
  if (!packed) return '';
  let [, script, radixText, countText, lookup] = packed;
  const radix = Number(radixText), count = Number(countText);
  if (radix < 2 || radix > 62 || count > 5000) return '';
  script = script.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const keys = lookup.split('|');
  const encode = (value) => {
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let valueText = '';
    do { valueText = alphabet[value % radix] + valueText; value = Math.floor(value / radix); } while (value);
    return valueText;
  };
  for (let i = count - 1; i >= 0; i--) {
    if (keys[i]) script = script.replace(new RegExp(`\\b${encode(i)}\\b`, 'g'), () => keys[i]);
  }
  return script.slice(0, 500000);
}

function extractFromHtml(html, sourceUrl) {
  if (typeof html !== 'string') return null;
  const origin = new URL(sourceUrl).origin;
  const referer = sourceUrl;
  const obf = /\bdata-obf\s*=\s*["']([^"']{1,16384})["']/i.exec(html);
  if (obf) {
    try {
      const payload = JSON.parse(Buffer.from(obf[1], 'base64').toString('utf8'));
      const value = payload?.sUb || payload?.url || payload?.file;
      if (typeof value === 'string' && value.length < 8192) {
        const url = new URL(value, `${origin}/`);
        // Legacy StreamC encodes a token in sUb; its endpoint ends in .m3u8.
        if (payload.sUb && !/\.(?:m3u8|mp4)(?:$)/i.test(url.pathname)) url.pathname += '.m3u8';
        if (isSafeUrl(url.href) && directMedia(url.href)) {
          const out = { url: url.href, referer };
          if (typeof payload.hD === 'string') out.videoHash = payload.hD;
          return out;
        }
      }
    } catch { /* Ignore malformed base64 JSON. */ }
  }
  const decoded = [html, unpackPacker(html)].join('\n')
    .replace(/\\\//g, '/').replace(/&amp;/gi, '&')
    .replace(/\\u0026/gi, '&');
  const absoluteMatch = /https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\]*)?/i.exec(decoded);
  if (absoluteMatch) {
    const url = directMedia(absoluteMatch[0]);
    if (url) return { url, referer };
  }
  // HTML5 <video>, JWPlayer file, or hls.js scripts with relative HLS paths.
  const relative = /(?:\b(?:file|src|source)\s*[:=]\s*["'])(\/[^"']+?\.m3u8(?:\?[^"']*)?)["']/i.exec(decoded);
  if (relative) {
    const url = directMedia(relative[1], `${origin}/`);
    if (url) return { url, referer };
  }
  return null;
}

async function readLimitedText(response, maxBytes = MAX_HTML) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (contentLength > maxBytes) return null;
  if (!response.body?.getReader) {
    const text = await response.text();
    return Buffer.byteLength(text) <= maxBytes ? text : null;
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

class EmbedResolver {
  constructor({ fetchImpl = (...args) => fetch(...args), lookup = dns.lookup,
                resolveEmbeds = process.env.RESOLVE_EMBEDS !== '0',
                enableHttp2 = process.env.STREAMC_HTTP2 !== '0', timeoutMs = 8500 } = {}) {
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.resolveEmbeds = resolveEmbeds;
    this.enableHttp2 = enableHttp2;
    this.timeoutMs = timeoutMs;
    this.cache = new Map();
  }

  async fetchText(url, { method = 'GET', body = null, headers = {} } = {}) {
    if (!await safeToFetch(url, this.lookup)) return null;
    const h = {
      'User-Agent': UA,
      'Accept': 'text/html,application/json,application/vnd.apple.mpegurl,*/*',
      'Referer': `${SOURCE_ORIGIN}/`,
      ...headers
    };
    let response;
    try {
      response = await this.fetchImpl(url, {
        method, body: body || undefined,
        redirect: 'manual', headers: h, signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (response.ok && response.status < 300) {
        const text = await readLimitedText(response, method === 'GET' ? MAX_PLAYLIST : MAX_HTML);
        return text === null ? null : { status: response.status, text };
      }
    } catch { /* HTTP/2 fallback for restrictive public embed hosts */ }
    if (!this.enableHttp2 || new URL(url).protocol !== 'https:') return null;
    try {
      const result = await fetchHttp2(url, {
        method, body, headers: h, timeoutMs: this.timeoutMs,
        lookup: this.lookup, isPublicIp: (ip) => net.isIP(ip) && !isPrivateIp(ip)
      });
      return result.status === 200 ? result : null;
    } catch { return null; }
  }

  async resolve(embedUrl, filmUrl = `${SOURCE_ORIGIN}/`) {
    if (!this.resolveEmbeds || !embedUrl || !isSafeUrl(embedUrl)) return null;
    const key = `${embedUrl}|${filmUrl}`;
    const item = this.cache.get(key);
    if (item && item.until > Date.now()) return item.promise;
    const promise = (async () => {
      const page = await this.fetchText(embedUrl, { headers: { Referer: filmUrl } });
      if (!page?.text || page.status !== 200) return null;
      const extracted = extractFromHtml(page.text, embedUrl);
      if (extracted) {
        if (extracted.videoHash && /\.m3u8(?:\?|$)/i.test(extracted.url)) {
          const response = await this.fetchText(extracted.url, { headers: { Referer: embedUrl } });
          if (response?.text.includes('#ENC-AESGCM')) {
            const plaintext = decryptHlsManifest(response.text, extracted.videoHash);
            return plaintext ? { playlist: plaintext, playlistUrl: extracted.url,
              videoHash: extracted.videoHash, referer: embedUrl } : null;
          }
        }
        return extracted;
      }
      return resolveBootstrap({
        html: page.text, embedUrl, filmUrl,
        requestText: (url, options) => this.fetchText(url, options)
      });
    })().catch(() => null);
    // Failed resolves retry after 1 min; good ones are reused for RESOLVE_CACHE_MIN (default 30).
    const ttl = (Number(process.env.RESOLVE_CACHE_MIN) || 30) * 60 * 1000;
    this.cache.set(key, { until: Date.now() + ttl, promise });
    promise.then((v) => { if (!v && this.cache.get(key)?.promise === promise) this.cache.get(key).until = Date.now() + 60 * 1000; });
    if (this.cache.size > 600) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }
}

function extractItemUrls(item) {
  const likelyDirect = [item?.m3u8, item?.link_m3u8, item?.url, item?.stream, item?.file];
  for (const [i, value] of likelyDirect.entries()) {
    if (!value || typeof value !== 'string') continue;
    const abs = link(value);
    if (!abs || !isSafeUrl(abs)) continue;
    // Explicit HLS fields may be signed extensionless URLs, but not iframes.
    if ((i < 2 && !/\/(?:embed|iframe|watch|player)\b/i.test(new URL(abs).pathname)) || directMedia(abs)) {
      return { direct: abs };
    }
  }
  const embed = link(item?.embed || item?.link_embed);
  if (!embed || !isSafeUrl(embed)) return {};
  return { direct: directMedia(embed), embed };
}

function streamObject({ url, name, quality, language, referer, proxied = false }) {
  const ref = link(referer) || `${SOURCE_ORIGIN}/`;
  const stream = {
    name: `NguồnC ${quality || ''}`.trim(),
    title: `${name} • ${language || 'Vietsub'}${quality ? ` • ${quality}` : ''}`,
    url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `nguonc-${name}-${language || 'vietsub'}`.slice(0, 100)
    }
  };
  if (!proxied) {
    stream.behaviorHints.proxyHeaders = {
      request: { 'Referer': ref, 'Origin': new URL(ref).origin, 'User-Agent': UA }
    };
  }
  return stream;
}

async function buildStreams(movie, { episode = null, resolver = new EmbedResolver(), maxServers = 8,
                                    playback = null, publicBaseUrl = null } = {}) {
  const servers = serverList(movie).slice(0, maxServers);
  const requests = servers.map(async (server) => {
    const ep = pickEpisode(server.items, episode, episode === null);
    if (!ep) return null;
    const { direct, embed } = extractItemUrls(ep);
    let video = direct;
    let referer = embed || `${SOURCE_ORIGIN}/`;
    let proxied = false;
    if (!video && embed) {
      const filmUrl = movie.slug ? `${SOURCE_ORIGIN}/phim/${encodeURIComponent(movie.slug)}` : `${SOURCE_ORIGIN}/`;
      const result = await resolver.resolve(embed, filmUrl);
      if (result?.url && isSafeUrl(result.url)) {
        video = result.url;
        referer = result.referer || referer;
      } else if (result?.playlist && playback && publicBaseUrl) {
        const id = playback.create(result);
        if (id) {
          video = `${publicBaseUrl.replace(/\/$/, '')}/play/${id}/index.m3u8`;
          referer = result.referer || referer;
          proxied = true;
        }
      }
    }
    if (!video) return null;
    return streamObject({ url: video, name: server.name || 'NguồnC',
      quality: movie.quality || '', language: movie.language || '', referer, proxied });
  });
  const results = (await Promise.all(requests)).filter(Boolean);
  const seen = new Set();
  return results.filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
}

module.exports = {
  isPrivateIp, isSafeUrl, safeToFetch, directMedia, extractFromHtml,
  readLimitedText, unpackPacker, EmbedResolver, extractItemUrls, buildStreams
};
