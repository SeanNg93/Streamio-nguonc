'use strict';

// Route only geo-blocked hosts (NguonC API, StreamC embeds) through upstream HTTP
// proxies; everything else (video CDNs) stays direct.
//
//   UPSTREAM_PROXIES=home=http://10.0.0.2:3128,office=http://10.0.0.3:3128
//   UPSTREAM_PROXY=http://host:port            (legacy single proxy, still accepted)
//   UPSTREAM_PROXY_HOSTS=nguonc.com,streamc.xyz
//
// Proxy choice (ProxyPool):
//  - A background probe (every PROXY_PROBE_SEC, default 60) fetches a small NguonC API
//    page through every proxy, so we know which ones are up and how fast they are.
//  - Real requests also feed the latency average, and a transport error or Cloudflare
//    403 marks that proxy down and retries the request once on the next best proxy.
//  - StreamC rate limits per egress IP: a 429 puts only that proxy in a cooldown
//    (Retry-After) for that site, and the request moves to another proxy.
//  - Pick = healthy, not cooling, lowest average latency. If every proxy is down we
//    still try them all (best effort) rather than fail without trying.

const PROBE_URL = process.env.PROXY_PROBE_URL || 'https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1';

function parseProxies(env = process.env) {
  const list = String(env.UPSTREAM_PROXIES || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map((item, i) => {
      const eq = item.indexOf('=');
      const named = eq > 0 && !item.slice(0, eq).includes(':');
      return { name: named ? item.slice(0, eq) : `proxy${i + 1}`, url: named ? item.slice(eq + 1) : item };
    });
  if (!list.length && env.UPSTREAM_PROXY) list.push({ name: 'proxy1', url: env.UPSTREAM_PROXY });
  return list;
}

function siteOf(host) { return host.split('.').slice(-2).join('.'); }

function isCloudflareBlock(res) {
  return res.status === 403 && /cloudflare/i.test(res.headers.get('server') || '');
}

class ProxyPool {
  constructor(proxies, { makeAgent, fetchVia, now = () => Date.now(), logger = console,
                         minGapMs = {}, default429Sec = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    this.now = now;
    this.minGapMs = minGapMs;          // site -> minimum ms between requests (throttle)
    this.default429Sec = default429Sec;
    this.sleep = sleep;
    this.nextAt = new Map();           // site -> earliest time the next request may start
    this.logger = logger;
    this.fetchVia = fetchVia;   // (input, init, agent) => Response
    this.proxies = proxies.map((p) => ({
      ...p, agent: makeAgent(p.url), ok: true, checked: 0, latency: null,
      failures: 0, lastError: null, downUntil: 0, cooling: new Map()   // site -> until
    }));
  }

  usable(p, site) {
    return p.ok && p.downUntil <= this.now() && (p.cooling.get(site) || 0) <= this.now();
  }

  // Best first: usable ones by latency, then the rest (best effort when all look down).
  order(site) {
    const lat = (p) => (p.latency ?? 5000);
    const good = this.proxies.filter((p) => this.usable(p, site)).sort((a, b) => lat(a) - lat(b));
    const rest = this.proxies.filter((p) => !good.includes(p))
      .filter((p) => (p.cooling.get(site) || 0) <= this.now())     // never hit a rate-limited IP
      .sort((a, b) => a.downUntil - b.downUntil || lat(a) - lat(b));
    return [...good, ...rest];
  }

  observe(p, ms) { p.latency = p.latency == null ? ms : Math.round(p.latency * 0.7 + ms * 0.3); }

  markDown(p, error) {
    p.failures++;
    p.lastError = String(error).slice(0, 160);
    // 30 s, 60 s, ... up to 5 min; the probe can bring it back earlier.
    p.downUntil = this.now() + Math.min(300, 30 * p.failures) * 1000;
    if (p.ok) this.logger.warn(`[proxy] ${p.name} down: ${p.lastError}`);
    p.ok = false;
  }

  markUp(p) {
    if (!p.ok) this.logger.log(`[proxy] ${p.name} back up (${p.latency} ms)`);
    p.ok = true; p.failures = 0; p.downUntil = 0; p.lastError = null;
  }

  // Space requests to one site so the relay IPs stay under the upstream rate limit.
  async gate(site) {
    const gap = Number(this.minGapMs[site]) || 0;
    if (gap <= 0) return;
    const at = Math.max(this.now(), this.nextAt.get(site) || 0);
    this.nextAt.set(site, at + gap);
    const wait = at - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  async fetch(input, init = {}, host = '') {
    const site = siteOf(host);
    const order = this.order(site);
    if (!order.length) {
      // Every proxy is rate limited for this site: answer like the site would.
      const until = Math.min(...this.proxies.map((p) => p.cooling.get(site) || Infinity));
      const secs = Math.max(1, Math.ceil((until - this.now()) / 1000));
      return new Response('{"error":"rate limited on every proxy"}', { status: 429, headers: { 'retry-after': String(secs) } });
    }
    let lastErr;
    for (const p of order.slice(0, 2)) {           // at most one retry on another proxy
      const t0 = this.now();
      try {
        await this.gate(site);
        if (init?.signal?.aborted) throw init.signal.reason;
        const res = await this.fetchVia(input, init, p.agent);
        if (res.status === 429) {
          const secs = Math.min(3600, Math.max(30, Number(res.headers.get('retry-after')) || this.default429Sec));
          p.cooling.set(site, this.now() + secs * 1000);
          this.logger.warn(`[proxy] ${p.name} rate limited by ${site} for ${secs}s`);
          lastErr = res;
          continue;
        }
        if (isCloudflareBlock(res) && site === 'nguonc.com') {
          // NguonC answers a blocked egress IP with a Cloudflare 403 page.
          this.markDown(p, `HTTP 403 from ${site}`);
          lastErr = res;
          continue;
        }
        this.observe(p, this.now() - t0);
        if (!p.ok) this.markUp(p);
        return res;
      } catch (e) {
        if (init?.signal?.aborted) throw e;        // caller timeout, not the proxy's fault
        this.markDown(p, e?.cause?.code || e?.message || e);
        lastErr = e;
      }
    }
    if (lastErr instanceof Response) return lastErr;
    throw lastErr;
  }

  async probe(fetchVia = this.fetchVia) {
    await Promise.all(this.proxies.map(async (p) => {
      const t0 = this.now();
      try {
        const res = await fetchVia(PROBE_URL, {
          signal: AbortSignal.timeout(8000),
          headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
        }, p.agent);
        await res.arrayBuffer().catch(() => {});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.observe(p, this.now() - t0);
        this.markUp(p);
      } catch (e) {
        this.markDown(p, e?.cause?.code || e?.message || e);
      } finally { p.checked = this.now(); }
    }));
  }

  status() {
    const now = this.now();
    return this.proxies.map((p) => ({
      name: p.name, url: p.url, ok: this.usable(p, ''), latencyMs: p.latency,
      lastError: p.lastError, checkedAgoSec: p.checked ? Math.round((now - p.checked) / 1000) : null,
      cooling: Object.fromEntries([...p.cooling].filter(([, u]) => u > now).map(([s, u]) => [s, Math.round((u - now) / 1000)]))
    }));
  }
}

let pool = null;
const proxies = parseProxies();
if (proxies.length) {
  const { ProxyAgent, fetch: undiciFetch } = require('undici');
  const hosts = (process.env.UPSTREAM_PROXY_HOSTS || 'nguonc.com,streamc.xyz')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const viaProxy = (host) => hosts.some((h) => host === h || host.endsWith('.' + h));
  // PROXY_MIN_GAP_MS=nguonc.com=400,streamc.xyz=1000
  const minGapMs = Object.fromEntries(String(process.env.PROXY_MIN_GAP_MS || '').split(',')
    .map((s) => s.trim().split('=')).filter(([k, v]) => k && Number(v) > 0).map(([k, v]) => [k.toLowerCase(), Number(v)]));
  pool = new ProxyPool(proxies, {
    minGapMs,
    default429Sec: Number(process.env.PROXY_429_SEC) || 300,
    makeAgent: (url) => new ProxyAgent(url),
    fetchVia: (input, init, agent) => undiciFetch(input, { ...init, dispatcher: agent })
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    let host = '';
    try { host = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname.toLowerCase(); } catch {}
    return viaProxy(host) ? pool.fetch(input, init, host) : nativeFetch(input, init);
  };
  const every = Math.max(10, Number(process.env.PROXY_PROBE_SEC) || 60) * 1000;
  pool.probe().then(() => console.log('[proxy] ' + pool.status().map((s) => `${s.name}=${s.ok ? s.latencyMs + 'ms' : 'down'}`).join(' ')));
  setInterval(() => pool.probe(), every).unref();
  console.log(`Upstream proxies (${proxies.map((p) => p.name).join(', ')}) for: ${hosts.join(', ')}`);
}

module.exports = { ProxyPool, parseProxies, getPool: () => pool };
