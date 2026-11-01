'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');

function sendJson(res, obj, maxAge = 60, status = 200, headOnly = false) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(headOnly ? undefined : text);
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return null; }
}

function sameToken(candidate, token) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Requests that arrive through a reverse proxy (nginx sets X-Forwarded-For) are public;
// only a direct local request (docker healthcheck, curl on the host) is not.
function isDirectRequest(req) {
  return !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'] && !req.headers['x-real-ip'];
}

// ACCESS_TOKEN (optional) makes the addon private: everything except /play/ (already
// unguessable per-playlist URLs) and /health must be requested under /<token>/, e.g.
// https://host/<token>/manifest.json. Stremio derives every resource URL from the
// manifest URL, so installing that URL is all a client needs.
function createServer(addon, { logger = console, accessToken = process.env.ACCESS_TOKEN || '' } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, {}, 0, 204, true);
    if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, { error: 'Method not allowed' }, 0, 405);
    const head = req.method === 'HEAD';
    const uri = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    let pathname = uri.pathname;
    let prefix = '';
    if (accessToken && !pathname.startsWith('/play/') && pathname !== '/health') {
      const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
      if (!m || !sameToken(safeDecode(m[1]) ?? '', accessToken)) return sendJson(res, { error: 'Not found' }, 0, 404, head);
      prefix = `/${m[1]}`;
      pathname = m[2] || '/';
    }
    if (pathname === '/manifest.json') return sendJson(res, addon.manifest, 3600, 200, head);
    if (pathname === '/health') {
      const body = { ok: true, addon: addon.manifest.name };
      // Proxy names, latency and last errors are for the operator only.
      if (isDirectRequest(req)) body.proxies = require('./egress').getPool()?.status().map(({ url, ...s }) => s) || [];
      return sendJson(res, body, 0, 200, head);
    }
    if (pathname === '/') {
      const manifestUrl = `${uri.origin}${prefix}/manifest.json`.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NguồnC Stremio</title></head><body style="font:16px system-ui,sans-serif;max-width:650px;margin:64px auto;padding:0 24px;line-height:1.7"><h1>NguồnC — Stremio Addon</h1><p>Addon đang hoạt động.</p><p>Trong Stremio, vào Addons và dán đường dẫn manifest:</p><p><code>${manifestUrl}</code></p><p><a href="${prefix}/manifest.json">Kiểm tra manifest</a> · <a href="/health">Health</a></p><p>Add-on không lưu trữ nội dung phim.</p></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
      return res.end(head ? undefined : html);
    }
    if (pathname.startsWith('/play/')) {
      if (!addon.playback) return sendJson(res, { error: 'Playback unavailable' }, 0, 404, head);
      try {
        if (await addon.playback.handle(req, res, pathname)) return;
      } catch (error) {
        logger.warn('[NguonC] playback error:', error.message);
        if (!res.headersSent) return sendJson(res, { error: 'Playback failed' }, 0, 502, head);
        return res.end();
      }
      return sendJson(res, { error: 'Invalid playback path' }, 0, 404, head);
    }
    // /catalog/movie/nguonc-phim-le/search=...&skip=15.json
    // /meta/movie/nguonc:some-slug.json
    // /stream/series/nguonc:some-slug:ep:1.json
    const matched = /^\/(catalog|meta|stream)\/(movie|series)\/([^/]+)(?:\/([^/]+))?\.json$/.exec(pathname);
    if (!matched) return sendJson(res, { error: 'Not found' }, 0, 404, head);
    const [, resource, type, rawId, rawExtra] = matched;
    const id = safeDecode(rawId);
    if (!id) return sendJson(res, { error: 'Invalid ID' }, 0, 400, head);
    if (rawExtra && resource !== 'catalog') return sendJson(res, { error: 'Not found' }, 0, 404, head);
    const extra = Object.fromEntries(new URLSearchParams(rawExtra || uri.search));
    try {
      if (resource === 'catalog') {
        const { cacheMaxAge = 180, ...body } = await addon.getCatalog(type, id, extra);
        return sendJson(res, body, cacheMaxAge, 200, head);
      }
      if (resource === 'meta') {
        const { cacheMaxAge = 600, ...body } = await addon.getDetail(type, id);
        return sendJson(res, body, cacheMaxAge, 200, head);
      }
      // PUBLIC_BASE_URL is recommended behind a reverse proxy or on cloud hosting.
      const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
      const inferredBase = `${proto}://${req.headers.host || '127.0.0.1'}`;
      let configuredBase = inferredBase;
      try {
        if (process.env.PUBLIC_BASE_URL) {
          const explicit = new URL(process.env.PUBLIC_BASE_URL);
          if (['http:', 'https:'].includes(explicit.protocol)) configuredBase = explicit.origin;
        }
      } catch { /* Fall back to request host. */ }
      return sendJson(res, await addon.getStreams(type, id, configuredBase), 30, 200, head);
    } catch (error) {
      logger.error('[NguonC] request failed:', error);
      return sendJson(res, { error: 'Upstream request failed' }, 0, 502, head);
    }
  });
}

module.exports = { createServer };
