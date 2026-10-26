# NguonC Stremio Addon

A self-hosted [Stremio](https://www.stremio.com/) addon for **NguonC** (phim.nguonc.com): Vietnamese catalogs, search, metadata, episodes and in-player streams, plus a **NguonC tab on regular IMDb titles** (Cinemeta, Trakt lists, etc.).

Built for Node.js 20+ with one dependency (`undici`). Runs in Docker behind any HTTPS reverse proxy, with optional Cloudflare edge acceleration for video.

> Personal-use project. It reads NguonC's public API and public player pages. It does not bypass logins, Turnstile or DRM, and it has no download feature. Availability depends on the upstream sites.

---

## Features

- **Catalogs:** Phim le, Phim bo, newest movies, newest series, animation/anime, all searchable.
- **Native playback:** resolves NguonC/StreamC players (including encrypted HLS playlists) into normal HLS that Stremio plays directly. No browser pop-ups.
- **NguonC tab on IMDb titles:** open any movie or episode from Cinemeta and NguonC streams appear next to your other sources, matched by IMDb id (with a strict title + year fallback) and season.
- **Fast by design:**
  - catalogs and details cached (stale-while-revalidate) and kept warm in the background,
  - popular Cinemeta titles pre-matched every few hours, matches persisted to disk,
  - next episodes pre-resolved while you watch,
  - optional **Cloudflare Worker** serves video segments from the edge nearest the viewer.
- **Geo-block aware:** only NguonC/StreamC requests go through a Vietnamese relay; video never does.

---

## How it works

```
                  small requests: catalogs, details, stream links
Stremio --HTTPS--> Cloudflare --> your server (nginx -> Docker :7000) --VPN--> VN relay --> NguonC / StreamC
   |
   +--HTTPS--> Cloudflare edge (Worker /edge/*) --> video CDN      (HLS segments, cached at the edge)
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

Keep `proxy_buffering off;` so playlists and segments stream immediately.

### 2.4 Install in Stremio

Addons -> paste `https://stremio.example.com/manifest.json` -> Install. Reinstall the addon whenever the manifest changes (new version), because Stremio caches it.

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

Notes:

- Workers free plan: 100,000 requests/day, about 55 hours of video per day at one request per 2-second segment.
- Cloudflare's terms discourage serving large volumes of video through its CDN. Fine for personal use; do not run a public service on it.

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
| `UPSTREAM_PROXY` | empty | HTTP CONNECT proxy with a Vietnamese IP |
| `UPSTREAM_PROXY_HOSTS` | `nguonc.com,streamc.xyz` | domains sent through the proxy |
| `STREAMC_HTTP2` | `1` | set `0` when using `UPSTREAM_PROXY` |
| `EDGE_SECRET` | empty | HMAC secret shared with the Worker; empty disables the edge relay |
| `EDGE_RELAY` | `1` | `0` serves video from the server even if a secret is set |
| `WARM_INTERVAL_MIN` | `8` | background catalog refresh (0 = off) |
| `WARM_STREAMS` | `10` | pre-resolved top movies per movie catalog |
| `RESOLVE_CACHE_MIN` | `30` | reuse resolved stream links for N minutes |
| `PREFETCH_NEXT_EPISODES` | `2` | pre-resolve the next N episodes |
| `IMDB_MATCH` | `1` | `0` disables the NguonC tab on IMDb titles |
| `IMDB_CACHE_FILE` | none | where matches and the index are saved |
| `IMDB_PREFETCH_HOURS` | `3` | popular-title pre-matching interval (0 = off) |
| `IMDB_INDEX_PAGES` | `20` | newest-upload pages indexed per run |
| `IMDB_PREFETCH_STREAMS` | `20` | pre-matched titles whose streams are pre-resolved |
| `CINEMETA_URL` | `https://v3-cinemeta.strem.io` | Cinemeta endpoint |

---

## 7. Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| Stremio: "Failed to fetch" manifest | open the manifest URL in a browser on that device | DNS not propagated, blocker, or HTTPS not set up |
| Catalogs empty | `docker logs nguonc-stremio` shows `NguonC API HTTP 403` | relay missing/offline, or domain not in the relay allowlist |
| Relay unreachable (curl `000`) | `curl -x http://<relay>:3128 https://phim.nguonc.com/api/...` | relay not running, VPN down, or firewall on the relay machine |
| No NguonC tab on a title | NguonC may not have it, or the title is not indexed yet | search inside the NguonC catalogs; matches refresh hourly for misses |
| Video does not start | fetch the playlist, then one `/edge/...` segment | `403` = EDGE_SECRET mismatch; `502` = CDN refused; try `EDGE_RELAY=0` |
| After changing code | `npm test` then `docker compose up -d --build` | |

Logs worth knowing: `[warm]` (background refresh), `[prematch]` (IMDb pre-matching), `[imdb]` (cache load), `[play]` (segment proxy errors with the failing host).

---

## 8. Project layout

```
server.js            entry point, background jobs
src/addon.js         manifest, catalogs, meta, streams, warm-up, pre-matching
src/api.js           NguonC API client with stale-while-revalidate cache
src/egress.js        routes only selected domains through UPSTREAM_PROXY
src/imdb.js          IMDb -> NguonC matching, index, persistence
src/streams.js       embed resolution, stream objects
src/streamc.js       StreamC player/playlist handling
src/playback.js      HLS playlist proxy, signed edge URLs
src/http.js          HTTP routes
cloudflare/          edge relay Worker + wrangler.toml
relay/relay.py       allowlisted HTTPS relay for a Vietnamese exit IP
deploy/              nginx example
tests/               node --test suite
```

## License

MIT. See `LICENSE`.
