'use strict';

// Interoperability with publicly exposed StreamC HTML and HLS playlists.
// This does not bypass logins, CAPTCHAs, Turnstile or media DRM.
const crypto = require('node:crypto');
const http2 = require('node:http2');
const tls = require('node:tls');
const dns = require('node:dns').promises;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_HTML = 1024 * 1024;
const MAX_PLAYLIST = 2 * 1024 * 1024;

function decodeAesGcm(ciphertext, key, nonce, additionalData) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 17 || nonce.length !== 12 || key.length !== 32) {
    throw new Error('Invalid encrypted payload');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  if (additionalData) decipher.setAAD(additionalData);
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}

function unwrapBootstrap(payload, apiUrl) {
  if (!payload || typeof payload !== 'object') throw new Error('Invalid bootstrap response');
  if (payload.format !== 'aesgcm-v1') return payload;
  if (!/^[a-f\d]{24}$/i.test(payload.iv || '') || typeof payload.data !== 'string') {
    throw new Error('Invalid bootstrap envelope');
  }
  const aad = Buffer.from(`stream-bootstrap-v1\n${apiUrl}`, 'utf8');
  const key = crypto.createHash('sha256').update(aad).digest();
  const decrypted = decodeAesGcm(Buffer.from(payload.data, 'base64'), key, Buffer.from(payload.iv, 'hex'), aad);
  return JSON.parse(decrypted.toString('utf8'));
}

function decryptHlsManifest(encrypted, videoHash) {
  if (typeof encrypted !== 'string') return null;
  if (!encrypted.includes('#ENC-AESGCM')) return encrypted.startsWith('#EXTM3U') ? encrypted : null;
  if (typeof videoHash !== 'string' || !/^[a-z\d_-]{6,160}$/i.test(videoHash)) return null;
  const header = encrypted.match(/^#ENC-AESGCM[^\r\n]*\biv=([a-f\d]{24})\b/im);
  const payload = encrypted.split(/\r?\n/).map((s) => s.trim())
    .find((s) => s && !s.startsWith('#'));
  if (!header || !payload || payload.length > MAX_PLAYLIST) return null;
  try {
    const key = crypto.createHmac('sha256', 'stream-derive-v1').update(videoHash, 'utf8').digest();
    const clear = decodeAesGcm(Buffer.from(payload, 'base64'), key, Buffer.from(header[1], 'hex'));
    const text = clear.toString('utf8');
    return text.startsWith('#EXTM3U') ? text : null;
  } catch { return null; }
}

function extractBootstrapConfig(html) {
  if (typeof html !== 'string') return null;
  const match = /<script\b(?=[^>]*\bid\s*=\s*["']stream-bootstrap["'])[^>]*>([\s\S]{1,32768}?)<\/script\s*>/i.exec(html);
  if (!match) return null;
  try {
    const config = JSON.parse(match[1]);
    return config && typeof config.api === 'string' ? config : null;
  } catch { return null; }
}

// Optional HTTP/2 transport for public embed hosts that refuse plain HTTP/1.1.
// DNS is pinned to a verified public IP for the connection to prevent rebinding.
async function fetchHttp2(url, { method = 'GET', headers = {}, body = null, timeoutMs = 6500,
                                 lookup = dns.lookup, isPublicIp = () => false } = {}) {
  const dest = new URL(url);
  if (dest.protocol !== 'https:' || dest.username || dest.password) throw new Error('Only public HTTPS is supported');
  const ips = await lookup(dest.hostname, { all: true });
  if (!Array.isArray(ips) || !ips.length || ips.some((entry) => !isPublicIp(entry.address))) {
    throw new Error('No public DNS address');
  }
  const ip = ips[0].address;
  const origin = dest.origin;
  const client = http2.connect(origin, {
    createConnection: () => tls.connect({
      host: ip, port: Number(dest.port) || 443, servername: dest.hostname,
      ALPNProtocols: ['h2'], rejectUnauthorized: true
    })
  });
  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const done = (error, data) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(data);
      client.destroy();
    };
    const timer = setTimeout(() => done(new Error('HTTP/2 timeout')), timeoutMs);
    timer.unref?.();
    const finish = (error, data) => { clearTimeout(timer); done(error, data); };
    client.once('error', (e) => finish(e));
    const reqHeaders = {
      ':method': method, ':scheme': 'https', ':authority': dest.host,
      ':path': dest.pathname + dest.search,
      'user-agent': UA,
      'accept': 'text/html,application/json,application/vnd.apple.mpegurl,*/*',
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
    };
    const stream = client.request(reqHeaders);
    const pieces = [];
    let total = 0;
    let status = 0;
    stream.on('response', (h) => { status = Number(h[':status'] || 0); });
    stream.on('data', (piece) => {
      total += piece.byteLength;
      if (total > MAX_PLAYLIST) return finish(new Error('HTTP/2 response too large'));
      pieces.push(piece);
    });
    stream.on('end', () => finish(null, { status, text: Buffer.concat(pieces).toString('utf8') }));
    stream.on('error', (e) => finish(e));
    if (body) stream.end(body);
    else stream.end();
  });
  return result;
}

async function resolveBootstrap({ html, embedUrl, filmUrl, requestText }) {
  const config = extractBootstrapConfig(html);
  if (!config) return null;
  const embedOrigin = new URL(embedUrl).origin;
  const apiUrl = new URL(config.api, embedUrl).href;
  if (new URL(apiUrl).origin !== embedOrigin) return null;
  const filmOrigin = new URL(filmUrl).origin;
  const requestBody = JSON.stringify({
    action: 'bootstrap',
    referrer: filmUrl.slice(0, 4096),
    frame_origins: [filmOrigin],
    request_grant: true,
    playlist_format: 'aesgcm-v2',
    pretty_url: true,
    path_chunks: true,
    bootstrap_format: 'aesgcm-v1'
  });
  try {
    const response = await requestText(apiUrl, {
      method: 'POST', body: requestBody,
      headers: { 'Content-Type': 'application/json', 'Origin': embedOrigin, 'Referer': embedUrl }
    });
    if (!response || response.status !== 200) return null;
    const value = unwrapBootstrap(JSON.parse(response.text), apiUrl);
    // If the site requires CAPTCHA/Turnstile confirmation, stop: no bypass.
    if (value.turnstileEnabled && !value.preissued) return null;
    const target = value.preissued?.playlist;
    if (typeof target !== 'string') return null;
    const playlistUrl = new URL(target, embedUrl).href;
    if (new URL(playlistUrl).origin !== embedOrigin) return null;
    const playlist = await requestText(playlistUrl, { headers: { Referer: embedUrl, Origin: embedOrigin } });
    if (!playlist || playlist.status !== 200) return null;
    const videoHash = String(value.video || new URL(embedUrl).searchParams.get('hash') || '');
    if (playlist.text.includes('#ENC-AESGCM')) {
      const decoded = decryptHlsManifest(playlist.text, videoHash);
      return decoded ? { playlist: decoded, playlistUrl, referer: embedUrl } : null;
    }
    return playlist.text.startsWith('#EXTM3U') ? { url: playlistUrl, referer: embedUrl } : null;
  } catch { return null; }
}

module.exports = {
  UA, MAX_HTML, MAX_PLAYLIST, decodeAesGcm, unwrapBootstrap,
  decryptHlsManifest, extractBootstrapConfig, fetchHttp2, resolveBootstrap
};
