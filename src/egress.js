'use strict';

// Route only geo-blocked hosts (NguonC API, StreamC embeds) through an upstream
// HTTP proxy; everything else (video CDNs) stays direct.
// UPSTREAM_PROXY=http://host:port  UPSTREAM_PROXY_HOSTS=nguonc.com,streamc.xyz
const proxyUrl = process.env.UPSTREAM_PROXY;
if (proxyUrl) {
  const { ProxyAgent, fetch: undiciFetch } = require('undici');
  const agent = new ProxyAgent(proxyUrl);
  const hosts = (process.env.UPSTREAM_PROXY_HOSTS || 'nguonc.com,streamc.xyz')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const viaProxy = (host) => hosts.some((h) => host === h || host.endsWith('.' + h));
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    let host = '';
    try { host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname.toLowerCase(); } catch {}
    return viaProxy(host) ? undiciFetch(input, { ...init, dispatcher: agent }) : nativeFetch(input, init);
  };
  console.log(`Upstream proxy enabled for: ${hosts.join(', ')}`);
}
