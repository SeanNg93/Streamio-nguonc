# NguonC Stremio Addon

A self-hosted [Stremio](https://www.stremio.com/) addon for **NguonC** (phim.nguonc.com): Vietnamese catalogs, search, metadata, episodes and in-player streams, plus a **NguonC tab on regular IMDb titles** (Cinemeta, Trakt lists, etc.).

Built for Node.js 20+ with one dependency (`undici`). Runs in Docker behind any HTTPS reverse proxy, with optional Cloudflare edge acceleration for video.

> Personal-use project. It reads NguonC's public API and public player pages. It does not bypass logins, Turnstile or DRM, and it has no download feature. Availability depends on the upstream sites.

---

## Features

- **Catalogs:** Phim le, Phim bo, newest movies, newest series, animation/anime, all searchable.
- **Native playback:** resolves NguonC/StreamC players (including encrypted HLS playlists) into normal HLS that Stremio plays directly. No browser pop-ups.
- **NguonC tab on IMDb titles:** open any movie or episode from Cinemeta and NguonC streams appear next to your other sources, matched by IMDb id (with a strict title + year fallback) and season.
- **Extra sources on IMDb titles:** Phim4K (VSMOV, `vsmov.com/api`) and KKPhim (`phimapi.com`) are queried in parallel with NguonC. Each source gets its own time budget (`PROVIDER_STREAM_TIMEOUT_MS`), so a slow source never hides the others, and each keeps its own `bingeGroup` so binge-watching stays on the same source. Turn them off with `EXTRA_PROVIDERS=`.
- **Disguised segments:** some CDNs hide MPEG-TS behind a fake PNG header (`*.png` segment names). The `/play/` proxy and the Worker strip it before the player sees it.
- **Fast by design:**
  - catalogs and details cached (stale-while-revalidate) and kept warm in the background,
  - popular Cinemeta titles pre-matched every few hours, matches persisted to disk,
  - next episodes pre-resolved while you watch,
  - optional **Cloudflare Worker** serves video segments from the edge nearest the viewer,
  - optional **home segment proxy** (`vnseg/`) serves NguonC segments from a Vietnamese residential PC through a Cloudflare Tunnel, with automatic fallback to the server.
- **Geo-block aware:** only NguonC/StreamC requests go through a Vietnamese relay; video never does.

---

## How it works

```
                  small requests: catalogs, details, stream links
Stremio --HTTPS--> Cloudflare --> your server (nginx -> Docker :7000) --VPN--> VN relay --> NguonC / StreamC
   |
   +--HTTPS--> Cloudflare edge (Worker /edge/*) --> video CDN      (HLS segments, cached at the edge)
   +--HTTPS--> Cloudflare Tunnel --> home PC (vnseg) --> NguonC CDN (optional, NguonC segments)
   +--HTTPS--> your server /play/ --> video CDN                    (fallback for everything above)
```

| Path | Carries | Why |
|---|---|---|
| Stremio -> your server | manifest, catalogs, metadata, playlists | the addon has to run somewhere public over HTTPS |
| your server -> VN relay -> NguonC/StreamC | small API/page requests | NguonC and StreamC block non-Vietnamese IPs |
| Stremio -> Cloudflare Worker -> CDN | the video | keeps video close to the viewer and off your server |

If your server is already in Vietnam you can skip the relay. If you skip the Worker, your server proxies the video itself.

---

## 1. Quick start (local test)

```bash
git clone https://github.com/SeanNg93/Streamio-nguonc.git
cd Streamio-nguonc
npm ci
npm test
npm start
```

Open `http://127.0.0.1:7000/manifest.json`. In Stremio Desktop on the **same computer**: Addons -> paste that URL -> Install.

From outside Vietnam the catalogs will be empty until you set up the relay (section 3).

---

## 2. Deploy on a VPS (Docker + HTTPS)

### 2.1 Run the container

```bash
git clone https://github.com/SeanNg93/Streamio-nguonc.git /opt/nguonc-stremio
cd /opt/nguonc-stremio
cp .env.example .env            # then edit .env
mkdir -p data && chown 1000:1000 data
docker compose up -d --build
curl http://127.0.0.1:7000/manifest.json
```

The container listens on `127.0.0.1:7000` only; the internet reaches it through your reverse proxy.

At minimum set in `.env`:

```ini
PUBLIC_BASE_URL=https://stremio.example.com
```

### 2.2 DNS

Create an `A` record `stremio.example.com -> <your server IP>`. With Cloudflare, turn the proxy **on** (orange cloud), see section 4.

### 2.3 Reverse proxy + certificate

Use `deploy/nginx.conf.example` (replace the hostname):

```bash
cp deploy/nginx.conf.example /etc/nginx/sites-available/stremio.example.com
ln -s /etc/nginx/sites-available/stremio.example.com /etc/nginx/sites-enabled/
mkdir -p /var/www/acme
# first issue the cert with only the port-80 block enabled, or with a temporary cert, then:
certbot certonly --webroot -w /var/www/acme -d stremio.example.com
nginx -t && systemctl reload nginx
```

Keep `proxy_buffering off;` so playlists and segments stream immediately. Behind Cloudflare, the example's commented `real_ip` lines make the access log show real client IPs, and its log format records request time.

### 2.4 Install in Stremio

Addons -> paste `https://stremio.example.com/manifest.json` -> Install. Reinstall the addon whenever the manifest changes (new version), because Stremio caches it.

Private addon: set `ACCESS_TOKEN` and install `https://stremio.example.com/<token>/manifest.json` instead; the plain URL then answers 404. Public `/health` only says `ok`; proxy details are shown to direct local requests (`curl http://127.0.0.1:7000/health`).

---

## 3. Vietnamese egress (relay)

NguonC and StreamC answer `403 Sorry, you have been blocked` to non-Vietnamese IPs, including cloud providers and Cloudflare WARP. If your server is outside Vietnam, give it a Vietnamese exit for **those two domains only**.

### 3.1 Run the relay on a machine in Vietnam

`relay/relay.py` is a ~100-line HTTP CONNECT proxy (Python 3.8+, no packages). It only accepts your server, only tunnels to the allowlisted domains on port 443, and TLS stays end-to-end.

Connect both machines with a private VPN such as [Tailscale](https://tailscale.com/) (free), then on the Vietnamese machine:

```bash
# Linux / macOS
RELAY_LISTEN_HOST=<this machine's VPN IP> \
RELAY_ALLOWED_CLIENTS=<server's VPN IP> \
python3 relay/relay.py
```

```powershell
# Windows (PowerShell)
$env:RELAY_LISTEN_HOST="<this machine's VPN IP>"
$env:RELAY_ALLOWED_CLIENTS="<server's VPN IP>"
python relay\relay.py
```

Make it start on boot (systemd service on Linux, Task Scheduler "At startup" on Windows) and allow inbound TCP 3128 from the VPN range only (`100.64.0.0/10` for Tailscale).

### 3.2 Point the addon at it

In `.env`:

```ini
UPSTREAM_PROXY=http://<relay VPN IP>:3128
UPSTREAM_PROXY_HOSTS=nguonc.com,streamc.xyz
STREAMC_HTTP2=0
```

Then `docker compose up -d`. Check from the server:

```bash
curl -x http://<relay VPN IP>:3128 https://phim.nguonc.com/api/films/phim-moi-cap-nhat
```

Only those domains use the relay. Video CDNs are fetched directly, so the relay carries kilobytes, not movies. The relay machine must be online for catalogs and new stream links.

Alternatives: a cheap VPS in Vietnam (run the addon there, no relay needed) or a paid Vietnamese HTTP proxy in `UPSTREAM_PROXY`.

---

## 4. Cloudflare: make it fast

Cloudflare is optional, but it gives you free TLS at the edge, hides your server IP, and (with the Worker) moves video delivery next to the viewer.

### 4.1 Proxy the hostname

- DNS record `stremio` -> your server, **Proxied** (orange cloud).
- SSL/TLS mode **Full (strict)** with a real certificate on the origin (section 2.3).
- Optional hardening: allow ports 80/443 on the server only from [Cloudflare IP ranges](https://www.cloudflare.com/ips/). If you do, Let's Encrypt HTTP-01 still works because validation goes through the Cloudflare proxy.

### 4.2 Edge relay Worker for video (recommended)

Without it, every 2-second HLS segment goes CDN -> your server -> Cloudflare -> viewer. If your server is far from your viewers (for example a US server and viewers in Vietnam), each segment crosses the ocean. The video CDN also rejects requests without a StreamC `Referer`, so players cannot fetch it directly.

The Worker in `cloudflare/worker.js` fixes that:

1. The addon rewrites each segment in the playlist to a **signed** URL `/edge/<url>/<referer>/<HMAC>/seg.ts`.
2. Cloudflare runs the Worker at the data center closest to the viewer.
3. The Worker verifies the HMAC (so it is not an open proxy), fetches the segment with the right `Referer`, caches it at the edge and streams it back.

Measured from Vietnam with a US server: about 0.5 to 1 s per segment via the edge, versus over 1 s just to reach the US server before any video is transferred.

Deploy:

```bash
cd cloudflare
# edit wrangler.toml: replace stremio.example.com / example.com with your hostname / zone
npx wrangler login                 # or export CLOUDFLARE_API_TOKEN=...
npx wrangler deploy
openssl rand -hex 32               # generate a secret
npx wrangler secret put EDGE_SECRET   # paste the secret
```

API token permissions if you use a token instead of `wrangler login`: **Account > Workers Scripts > Edit** and **Zone > Workers Routes > Edit**.

Then put the same secret in the addon's `.env` and restart:

```ini
EDGE_SECRET=<the same secret>
EDGE_RELAY=1
```

```bash
docker compose up -d
```

Verify: open a stream playlist (`/stream/movie/<id>.json` -> `url`) and the segment lines should start with `/edge/`. Fetch one; the response has header `X-Edge-Colo` (the Cloudflare location that served it).

To switch back to server-side video at any time: `EDGE_RELAY=0`.

Per-CDN exceptions:

- `EDGE_BYPASS_HOSTS=streamc.xyz` keeps sessions whose segment host or referer host ends with one of these suffixes on `/play/`. Use it for CDNs that refuse the Worker. NguonC's segment CDN (behind Cloudflare itself) only answers HTTP/2 clients and treats a Worker subrequest like the viewer's own HTTP version, so HTTP/1.1 players (ffmpeg, mpv, ExoPlayer) get `403` through the edge.
- `EDGE_IMAGE_SEGMENTS=0` keeps image-named segments (`*.png`, fake PNG header) on `/play/`. By default they go through the Worker, which strips the header.
- The server fetches video CDNs directly over HTTP/2 (`DIRECT_HTTP2=1`, default), because NguonC's segment CDN rejects HTTP/1.1.

Notes:

- Workers free plan: 100,000 requests/day, about 55 hours of video per day at one request per 2-second segment.
- Cloudflare's terms discourage serving large volumes of video through its CDN. Fine for personal use; do not run a public service on it.

### 4.3 Home segment proxy for NguonC (optional)

If the edge cannot reach a CDN well (NguonC, see above) and your viewers are in Vietnam, a PC on a Vietnamese home connection can serve those segments instead: `vnseg/vnseg.js` (no dependencies) behind a Cloudflare Tunnel. Setup is in [`vnseg/README.md`](vnseg/README.md). On the addon side:

```ini
VNSEG_BASE=https://vnseg.example.com
VNSEG_HOSTS=streamc.xyz
# VNSEG_SECRET defaults to EDGE_SECRET; it must equal the secret on the home PC.
```

Matching playlists get absolute `VNSEG_BASE/seg/...` segment URLs (signed with the same HMAC scheme as `/edge/`), and the next few segments are prefetched on the home PC. The addon checks `VNSEG_BASE/health` every `VNSEG_HEALTH_SEC`; after `VNSEG_FAIL_AFTER` failures new playlists fall back to `/play/` until it recovers. `/health` on the addon shows the vnseg state. Leave `VNSEG_BASE` empty to disable it.

---

## 5. NguonC tab on IMDb titles

The stream resource accepts `tt...` ids, so when you open a title from Cinemeta (or any IMDb-based catalog) the addon looks for the same film on NguonC:

1. Title and year from Cinemeta.
2. Candidates from a persisted IMDb -> NguonC index (built from NguonC's newest uploads and every film seen) or from NguonC search.
3. A candidate is accepted only if its own IMDb id equals the requested one; if NguonC has no IMDb id, the original title and year (+-1) must match exactly.
4. Series match NguonC's per-season entries (`tmdb.season`); long-running season-less entries use absolute episode numbering.

Background jobs keep this fast: popular titles are pre-matched every `IMDB_PREFETCH_HOURS`, results are stored in `data/imdb-cache.json` and served instantly while they refresh in the background. Disable with `IMDB_MATCH=0`.

**Source order in Stremio** follows addon install order. To show NguonC near the top, reorder your addons (for example with the community Stremio Addon Manager) and put it right after Cinemeta.

---

## 6. Configuration

All settings are environment variables (see `.env.example`).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7000` | listen port |
| `PUBLIC_BASE_URL` | inferred | public HTTPS origin used in playback URLs |
| `NGUONC_API_BASE` | `https://phim.nguonc.com/api` | upstream API |
| `API_TIMEOUT_MS` | `9000` | upstream API timeout |
| `RESOLVE_EMBEDS` | `1` | resolve StreamC players into HLS |
| `UPSTREAM_PROXIES` | empty | `name=url` list of HTTP CONNECT proxies with Vietnamese IPs; fastest healthy one wins, with failover |
| `UPSTREAM_PROXY` | empty | legacy single proxy (used when `UPSTREAM_PROXIES` is empty) |
| `PROXY_PROBE_SEC` | `60` | proxy health/latency probe interval |
| `PROXY_PROBE_URL` | NguonC newest page 1 | URL fetched by the probe |
| `PROXY_MIN_GAP_MS` | none | per-site request spacing, e.g. `nguonc.com=400,streamc.xyz=800` |
| `PROXY_429_SEC` | `300` | proxy cooldown after a 429 without `Retry-After` |
| `UPSTREAM_PROXY_HOSTS` | `nguonc.com,streamc.xyz` | domains sent through the proxy |
| `STREAMC_HTTP2` | `1` | HTTP/2 fallback for StreamC; always off when a proxy is configured (it would bypass it) |
| `EDGE_SECRET` | empty | HMAC secret shared with the Worker; empty disables the edge relay |
| `EDGE_RELAY` | `1` | `0` serves video from the server even if a secret is set |
| `WARM_INTERVAL_MIN` | `8` | background catalog refresh (0 = off) |
| `WARM_STREAMS` | `10` | pre-resolved top movies per movie catalog |
| `RESOLVE_CACHE_MIN` | `30` | reuse resolved stream links for N minutes (keep above `WARM_INTERVAL_MIN`) |
| `API_CONCURRENCY` | `4` | parallel upstream API requests (1..16) |
| `API_CACHE_MAX` | `3000` | max cached API responses |
| `SEARCH_MAX_PAGES` | `18` | upstream pages walked per search |
| `SEARCH_CACHE_SEC` | `90` | ranked search cache lifetime |
| `PREFETCH_NEXT_EPISODES` | `2` | pre-resolve the next N episodes |
| `IMDB_MATCH` | `1` | `0` disables the NguonC tab on IMDb titles |
| `IMDB_CACHE_FILE` | none | where matches and the index are saved |
| `IMDB_PREFETCH_HOURS` | `3` | popular-title pre-matching interval (0 = off) |
| `IMDB_INDEX_PAGES` | `20` | newest-upload pages indexed per run |
| `IMDB_PREFETCH_STREAMS` | `20` | pre-matched titles whose streams are pre-resolved |
| `IMDB_PREFETCH_DELAY_SEC` | `30` | delay before the first pre-matching run |
| `IMDB_SEARCH_PAGES` | `8` | upstream search pages tried per title when matching |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Cinemeta endpoint |
| `ACCESS_TOKEN` | empty | private addon: routes are served under `/<token>/` (install `/<token>/manifest.json`) |
| `CATALOG_MAX_SKIP` | `200` | deepest catalog `skip`; beyond it the catalog ends |
| `PLAYBACK_DIR` | empty | persist playback sessions here so `/play/` URLs survive restarts (empty = memory only) |
| `PLAYBACK_MAX_SESSIONS` | `80` | playback sessions kept in memory (least recently used leave first) |
| `PLAYBACK_MAX_FILES` | `500` | session files kept in `PLAYBACK_DIR` (expired ones are pruned hourly) |
| `PLAYBACK_SECRET` | `EDGE_SECRET` | keys the session ids, so the same playlist keeps its id across restarts |
| `EDGE_BYPASS_HOSTS` | empty | segment or referer host suffixes kept on `/play/` instead of the Worker, e.g. `streamc.xyz` |
| `EDGE_IMAGE_SEGMENTS` | `1` | `0` keeps image-named (fake PNG) segments on `/play/` instead of the Worker |
| `DIRECT_HTTP2` | `1` | direct (non-proxied) fetches may use HTTP/2; NguonC's segment CDN rejects HTTP/1.1 |
| `EXTRA_PROVIDERS` | `vsmov,kkphim` | extra sources on IMDb titles (comma list; empty = NguonC only) |
| `PROVIDER_STREAM_TIMEOUT_MS` | `6000` | per-source time budget for one `/stream/` answer; late sources keep resolving for the next request |
| `PROVIDER_TIMEOUT_MS` | `7500` | timeout of one VSMOV/KKPhim API request |
| `PROVIDER_CONCURRENCY` | `4` | parallel API requests per extra provider |
| `VSMOV_API_BASE` | `https://vsmov.com/api` | Phim4K (VSMOV) API |
| `KKPHIM_API_BASE` | `https://phimapi.com` | KKPhim API |
| `VNSEG_BASE` | empty | public URL of the home segment proxy (empty = disabled) |
| `VNSEG_HOSTS` | empty | segment or referer host suffixes sent to vnseg, e.g. `streamc.xyz` |
| `VNSEG_SECRET` | `EDGE_SECRET` | HMAC secret shared with vnseg |
| `VNSEG_HEALTH_SEC` | `30` | vnseg health check interval |
| `VNSEG_HEALTH_TIMEOUT_MS` | `3000` | vnseg health check timeout |
| `VNSEG_FAIL_AFTER` | `2` | failed checks before falling back to `/play/` |
| `VNSEG_PREFETCH` | `6` | segments prefetched on vnseg after a playlist is served (0 = off) |

Home segment proxy (`vnseg/vnseg.js`, set on the home PC, not in the addon):

| Variable | Default | Meaning |
|---|---|---|
| `VNSEG_SECRET` | required | same secret as the addon's `VNSEG_SECRET` / `EDGE_SECRET` |
| `VNSEG_PORT` | `8787` | listen port (always bound to `127.0.0.1`) |
| `VNSEG_CACHE_MB` | `300` | in-memory segment cache |
| `VNSEG_HEADER_MS` | `6000` | upstream response header timeout before one retry |
| `VNSEG_EGRESS_HINT` | empty | free text shown in `/health` (e.g. ISP name) |

---

## 7. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Stremio: "Failed to fetch" manifest | open the manifest URL in a browser on that device | DNS not propagated, blocker, or HTTPS not set up |
| Catalogs empty | `docker logs nguonc-stremio` shows `NguonC API HTTP 403` | relay missing/offline, or domain not in the relay allowlist |
| Relay unreachable (curl `000`) | `curl -x http://<relay>:3128 https://phim.nguonc.com/api/...` | relay not running, VPN down, or firewall on the relay machine |
| No NguonC tab on a title | NguonC may not have it, or the title is not indexed yet | search inside the NguonC catalogs; matches refresh hourly for misses |
| Video does not start | fetch the playlist, then one `/edge/...` segment | `403` = EDGE_SECRET mismatch; `502` = CDN refused; try `EDGE_RELAY=0` or add the host to `EDGE_BYPASS_HOSTS` |
| NguonC segments `403` from the server | `docker logs` `[play] asset ... host=` | the CDN needs HTTP/2: keep `DIRECT_HTTP2=1` |
| vnseg not used | addon `/health` field `vnseg` | `healthy:false` = tunnel or home PC down (playback falls back to `/play/`); check `VNSEG_BASE/health` |
| Only Phim4K/KKPhim show on first click | normal for a cold NguonC lookup | NguonC keeps resolving in the background; reopen, or raise `PROVIDER_STREAM_TIMEOUT_MS` |
| After changing code | `npm test` then `docker compose up -d --build` | |

Logs worth knowing: `[warm]` (background refresh), `[prematch]` (IMDb pre-matching), `[imdb]` (cache load), `[play]` (segment proxy errors with the failing host). Background work (warm-up, pre-matching, next-episode prefetch, stale refreshes) waits behind interactive requests for an upstream API slot.

---

## 8. Project layout

```
server.js            entry point, background jobs
src/addon.js         manifest, catalogs, meta, streams, warm-up, pre-matching
src/api.js           NguonC API client with stale-while-revalidate cache
src/egress.js        routes only selected domains through the VN proxies, HTTP/2 for direct fetches
src/imdb.js          IMDb -> NguonC matching, index, persistence
src/streams.js       embed resolution, stream objects
src/providers.js     Phim4K (VSMOV) and KKPhim sources for IMDb titles
src/search.js        ranked search across upstream pages
src/vnseg.js         home segment proxy client: signed URLs, health check, prefetch
src/streamc.js       StreamC player/playlist handling
src/playback.js      HLS playlist proxy, persisted sessions, signed edge URLs
src/http.js          HTTP routes
cloudflare/          edge relay Worker + wrangler.toml
vnseg/               home segment proxy (runs on a PC in Vietnam) + its tests
relay/relay.py       allowlisted HTTPS relay for a Vietnamese exit IP
deploy/              nginx example
tests/               node --test suite (vnseg server tests: node --test vnseg/test/*.test.js, needs openssl)
```

## License

MIT. See `LICENSE`.
