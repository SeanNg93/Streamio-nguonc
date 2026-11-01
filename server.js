'use strict';

require('./src/egress');
const { createAddon } = require('./src/addon');
const { createServer } = require('./src/http');
const { runInBackground } = require('./src/api');

const port = Number(process.env.PORT || 7000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}
const addon = createAddon();
const server = createServer(addon);
const warmMinutes = Number(process.env.WARM_INTERVAL_MIN ?? 8);
if (warmMinutes > 0) {
  let running = false;
  const runWarm = () => {
    if (running) return;   // a slow warm (upstream trouble) must not stack another one
    running = true;
    const started = Date.now();
    runInBackground(() => addon.warm()).then((r) => console.log(`[warm] ${r.catalogs} catalogs, ${r.details} details, ${r.streams} movie streams in ${Date.now() - started} ms`))
      .catch((e) => console.warn(`[warm] failed: ${e.message}`)).finally(() => { running = false; });
  };
  setTimeout(runWarm, 2000).unref();
  setInterval(runWarm, warmMinutes * 60 * 1000).unref();
}
const prematchHours = Number(process.env.IMDB_PREFETCH_HOURS ?? 3);
if (prematchHours > 0 && process.env.IMDB_MATCH !== '0') {
  let running = false;
  const runPrematch = () => {
    if (running) return;
    running = true;
    const started = Date.now();
    runInBackground(() => addon.prematch()).then((r) => console.log(`[prematch] indexed +${r.indexed} (total ${r.totalIndexed}), popular: ${r.matched} matches (movies + series seasons) from ${r.checked} titles in ${Math.round((Date.now() - started) / 1000)} s`))
      .catch((e) => console.warn(`[prematch] failed: ${e.message}`)).finally(() => { running = false; });
  };
  setTimeout(runPrematch, (Number(process.env.IMDB_PREFETCH_DELAY_SEC ?? 30) || 30) * 1000).unref();
  setInterval(runPrematch, prematchHours * 60 * 60 * 1000).unref();
}
server.listen(port, '0.0.0.0', () => {
  console.log(`NguồnC Stremio addon is running`);
  console.log(`Manifest: http://127.0.0.1:${port}/manifest.json`);
  console.log('For other devices, deploy behind HTTPS (Render, VPS, or reverse proxy).');
});

// `docker stop` sends SIGTERM to PID 1: write pending playback sessions, then exit
// (without a handler Node as PID 1 ignores it and Docker kills it after 10 s).
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  setTimeout(() => process.exit(0), 3000).unref();
  Promise.resolve(addon.playback?.flush?.()).catch(() => {}).finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
