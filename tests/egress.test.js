'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ProxyPool, parseProxies } = require('../src/egress');

const quiet = { log() {}, warn() {} };
function makePool(behaviour, clock = { t: 0 }) {
  const calls = [];
  const pool = new ProxyPool([{ name: 'a', url: 'http://a' }, { name: 'b', url: 'http://b' }], {
    makeAgent: (url) => url, now: () => clock.t, logger: quiet,
    fetchVia: async (input, init, agent) => { calls.push(agent); clock.t += behaviour[agent].ms || 0; return behaviour[agent].fn(String(input)); }
  });
  return { pool, calls, clock };
}

test('parseProxies: named list, legacy single proxy', () => {
  assert.deepEqual(parseProxies({ UPSTREAM_PROXIES: 'home=http://1.2.3.4:3128, http://5.6.7.8:3128' }),
    [{ name: 'home', url: 'http://1.2.3.4:3128' }, { name: 'proxy2', url: 'http://5.6.7.8:3128' }]);
  assert.deepEqual(parseProxies({ UPSTREAM_PROXY: 'http://x:1' }), [{ name: 'proxy1', url: 'http://x:1' }]);
});

test('probe ranks proxies by latency; requests use the fastest', async () => {
  const ok = () => new Response('{}', { status: 200 });
  const { pool, calls } = makePool({ 'http://a': { ms: 900, fn: ok }, 'http://b': { ms: 200, fn: ok } });
  await pool.probe();
  calls.length = 0;
  await pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com');
  assert.deepEqual(calls, ['http://b']);
});

test('a dead proxy is skipped and the request retried on the other one', async () => {
  const { pool, calls } = makePool({
    'http://a': { ms: 10, fn: () => { throw new TypeError('fetch failed'); } },
    'http://b': { ms: 300, fn: () => new Response('{}', { status: 200 }) }
  });
  pool.proxies[0].latency = 10; pool.proxies[1].latency = 300;
  const res = await pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com');
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ['http://a', 'http://b']);
  assert.equal(pool.status()[0].ok, false);
  calls.length = 0;
  await pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com');
  assert.deepEqual(calls, ['http://b']);
});

test('StreamC 429 cools only that proxy for that site; all cooling -> synthetic 429', async () => {
  const limited = (u) => new Response('{}', u.includes('streamc') ? { status: 429, headers: { 'retry-after': '600' } } : { status: 200 });
  const ok = () => new Response('{}', { status: 200 });
  const { pool, calls, clock } = makePool({ 'http://a': { fn: limited }, 'http://b': { fn: ok } });
  pool.proxies[0].latency = 10; pool.proxies[1].latency = 300;
  assert.equal((await pool.fetch('https://embed1.streamc.xyz/x', {}, 'embed1.streamc.xyz')).status, 200);
  calls.length = 0;
  await pool.fetch('https://embed1.streamc.xyz/x', {}, 'embed1.streamc.xyz');
  assert.deepEqual(calls, ['http://b']);                  // a is cooling for streamc
  calls.length = 0;
  await pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com');
  assert.deepEqual(calls, ['http://a']);                  // but still fine for nguonc
  pool.proxies[1].cooling.set('streamc.xyz', clock.t + 100000);
  calls.length = 0;
  const r = await pool.fetch('https://embed1.streamc.xyz/x', {}, 'embed1.streamc.xyz');
  assert.equal(r.status, 429);
  assert.equal(calls.length, 0);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('per-site min gap spaces requests; other sites are not throttled', async () => {
  const clock = { t: 0 };
  const waits = [];
  const pool = new ProxyPool([{ name: 'a', url: 'http://a' }], {
    makeAgent: (url) => url, now: () => clock.t, logger: quiet, minGapMs: { 'nguonc.com': 400 },
    sleep: async (ms) => { waits.push(ms); clock.t += ms; },
    fetchVia: async () => new Response('{}', { status: 200 })
  });
  await Promise.all([1, 2, 3].map(() => pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com')));
  assert.deepEqual(waits, [400, 400]);
  await pool.fetch('https://embed.streamc.xyz/x', {}, 'embed.streamc.xyz');
  assert.deepEqual(waits, [400, 400]);
});

test('429 without Retry-After uses default429Sec', async () => {
  const clock = { t: 0 };
  const pool = new ProxyPool([{ name: 'a', url: 'http://a' }], {
    makeAgent: (url) => url, now: () => clock.t, logger: quiet, default429Sec: 120,
    fetchVia: async () => new Response('', { status: 429 })
  });
  await pool.fetch('https://phim.nguonc.com/api', {}, 'phim.nguonc.com');
  assert.equal(pool.status()[0].cooling['nguonc.com'], 120);
});
