'use strict';

const crypto = require('node:crypto');

// Home segment proxy ("vnseg", a Vietnamese residential PC behind a Cloudflare
// tunnel). Matching sessions get ABSOLUTE segment URLs
// `${VNSEG_BASE}/seg/<b64url(url)>/<b64url(referer)>/<hmac>/seg.ts`, signed with
// the same secret as /edge/. A background health check (every 30 s, 3 s timeout)
// marks it unhealthy after 2 failures; playlists rendered while unhealthy fall
// back to /play/ (VPS), and switch back after the next successful check.
class VnsegRelay {
  constructor({
    base = process.env.VNSEG_BASE || '',
    hosts = process.env.VNSEG_HOSTS || '',
    secret = process.env.VNSEG_SECRET || process.env.EDGE_SECRET || '',
    fetchImpl = (...args) => fetch(...args),
    intervalMs = Number(process.env.VNSEG_HEALTH_SEC || 30) * 1000,
    timeoutMs = Number(process.env.VNSEG_HEALTH_TIMEOUT_MS || 3000),
    failAfter = Number(process.env.VNSEG_FAIL_AFTER || 2),
    prefetchCount = Number(process.env.VNSEG_PREFETCH || 6),
    logger = console,
    autoStart = true
  } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.hosts = String(hosts).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    this.secret = secret;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.failAfter = Math.max(1, failAfter);
    this.prefetchCount = Math.max(0, prefetchCount);
    this.logger = logger;
    this.healthy = false;   // unknown until the first check succeeds
    this.failures = 0;
    this.lastError = null;
    this.checkedAt = 0;
    this.timer = null;
    this.prefetched = new Map(); // key -> time, so a re-fetched playlist does not prefetch again
    if (autoStart && this.enabled) this.start();
  }

  get enabled() { return Boolean(this.base && this.secret && this.hosts.length); }

  start() {
    if (this.timer || !this.enabled) return;
    this.check().catch(() => {});
    this.timer = setInterval(() => this.check().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async check() {
    let ok = false; let err = null;
    try {
      const res = await this.fetchImpl(`${this.base}/health`, {
        headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(this.timeoutMs)
      });
      const body = await res.json().catch(() => null);
      ok = res.status === 200 && body?.ok === true;
      if (!ok) err = `HTTP ${res.status}`;
    } catch (e) { err = e?.name === 'TimeoutError' ? 'timeout' : (e?.cause?.code || e?.message || String(e)); }
    this.checkedAt = Date.now();
    const was = this.healthy;
    if (ok) { this.failures = 0; this.healthy = true; this.lastError = null; }
    else {
      this.failures++; this.lastError = err;
      if (this.failures >= this.failAfter) this.healthy = false;
    }
    if (was !== this.healthy) this.logger.warn?.(`[vnseg] ${this.healthy ? 'healthy' : `unhealthy (${err})`}: ${this.base}`);
    return this.healthy;
  }

  matches(session, url) {
    const hit = (host) => this.hosts.some((h) => host === h || host.endsWith(`.${h}`));
    let host = ''; let refHost = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch {}
    try { refHost = new URL(session.referer).hostname.toLowerCase(); } catch {}
    return Boolean((host && hit(host)) || (refHost && hit(refHost)));
  }

  signedPath(url, referer) {
    const b64 = (v) => Buffer.from(v).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(`${url}\n${referer}`).digest('hex');
    return `/seg/${b64(url)}/${b64(referer)}/${sig}/seg.ts`;
  }

  // Absolute vnseg URL for a media segment, or null (not enabled, unhealthy, no match).
  urlFor(session, url) {
    if (!this.enabled || !this.healthy || !this.matches(session, url)) return null;
    return this.base + this.signedPath(url, session.referer);
  }

  // Fire and forget: warm the first segments of a playlist we just served.
  prefetch(key, urls) {
    if (!this.enabled || !this.healthy || !this.prefetchCount) return false;
    const paths = urls.filter((u) => typeof u === 'string' && u.startsWith(`${this.base}/seg/`))
      .slice(0, this.prefetchCount).map((u) => u.slice(this.base.length));
    if (!paths.length) return false;
    const now = Date.now();
    if (this.prefetched.has(key) && now - this.prefetched.get(key) < 30 * 60 * 1000) return false;
    this.prefetched.set(key, now);
    if (this.prefetched.size > 500) this.prefetched.delete(this.prefetched.keys().next().value);
    Promise.resolve().then(() => this.fetchImpl(`${this.base}/prefetch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(paths), signal: AbortSignal.timeout(this.timeoutMs)
    })).then((r) => r.body?.cancel?.().catch(() => {}))
      .catch((e) => this.logger.warn?.(`[vnseg] prefetch failed: ${e?.message || e}`));
    return true;
  }

  status() {
    return { enabled: this.enabled, healthy: this.healthy, failures: this.failures, lastError: this.lastError,
      checkedAgoSec: this.checkedAt ? Math.round((Date.now() - this.checkedAt) / 1000) : null };
  }
}

module.exports = { VnsegRelay };
