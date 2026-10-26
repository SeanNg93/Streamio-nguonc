// NguonC edge segment relay: serves HLS segments from the Cloudflare edge nearest
// the viewer, adding the Referer the CDN requires. Only URLs signed by the addon
// (HMAC-SHA256 with EDGE_SECRET) are fetched, so this is not an open proxy.
// Path: /edge/<b64url(url)>/<b64url(referer)>/<sig>
const enc = new TextEncoder();
const b64d = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
let keyPromise;
function hmacKey(secret) {
  keyPromise ||= crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return keyPromise;
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*',
               'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Expose-Headers': '*' };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
    const m = /^\/edge\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/([a-f0-9]{64})(?:\/[^/]*)?$/.exec(new URL(request.url).pathname);
    if (!m) return new Response('Not found', { status: 404, headers: CORS });
    let target, referer;
    try { target = b64d(m[1]); referer = b64d(m[2]); } catch { return new Response('Bad request', { status: 400 }); }
    const ok = /^[a-f0-9]{64}$/.test(m[3]) && await crypto.subtle.verify('HMAC', await hmacKey(env.EDGE_SECRET),
      hexToBytes(m[3]), enc.encode(`${target}\n${referer}`));
    if (!ok) return new Response('Forbidden', { status: 403, headers: CORS });
    const t = new URL(target);
    if (t.protocol !== 'https:') return new Response('Forbidden', { status: 403 });
    const headers = {
      'Referer': referer, 'Origin': new URL(referer).origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
    };
    const range = request.headers.get('Range');
    if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
    const upstream = await fetch(target, { method: request.method, headers, redirect: 'follow',
      cf: range ? undefined : { cacheEverything: true, cacheTtl: 86400 } });
    if (!upstream.ok && upstream.status !== 206) {
      return new Response(`Upstream ${upstream.status}`, { status: 502, headers: CORS });
    }
    const out = new Headers(CORS);
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = upstream.headers.get(k); if (v) out.set(k, v);
    }
    const ct = upstream.headers.get('content-type') || '';
    out.set('Content-Type', /mpegurl/i.test(ct) ? ct : 'video/mp2t');
    out.set('Cache-Control', 'public, max-age=86400, immutable');
    out.set('X-Edge-Colo', String(request.cf?.colo || ''));
    return new Response(upstream.body, { status: upstream.status, headers: out });
  }
};
