# vnseg: home segment proxy

A small HTTP server that runs on a PC with a Vietnamese home internet connection and serves NguonC video segments to Stremio. The player talks HTTP/1.1 to it; vnseg fetches the CDN over HTTP/2 (which that CDN requires), strips fake PNG headers, streams the bytes through and keeps a memory cache. It is published with a Cloudflare named tunnel, so the PC needs no open ports.

- Single file, no dependencies, Node.js 18 or newer (Windows or Linux).
- Binds `127.0.0.1` only. Every request must carry an HMAC signed by the addon, so it is not an open proxy.
- Routes: `GET|HEAD /seg/<b64url url>/<b64url referer>/<hmac>/seg.ts`, `POST /prefetch`, `GET /health`.

## 1. Run vnseg

Copy `vnseg.js` to the PC and set a secret (the same value as the addon's `VNSEG_SECRET`, or its `EDGE_SECRET` if you do not set a separate one).

Linux:

```bash
export VNSEG_SECRET=<secret>      # openssl rand -hex 32
export VNSEG_PORT=8787            # optional, default 8787
node vnseg.js
```

Windows (cmd):

```bat
set VNSEG_SECRET=<secret>
set VNSEG_PORT=8787
node C:\vnseg\vnseg.js
```

Check: `curl http://127.0.0.1:8787/health` returns `{"ok":true,...}`.

Make it start on boot: a systemd service on Linux, or a Task Scheduler task "At startup" running a small `.cmd` that sets the variables and loops `node vnseg.js` on Windows. Keep the secret file readable only by the service account.

Optional settings: `VNSEG_CACHE_MB` (300), `VNSEG_HEADER_MS` (6000, upstream header timeout before one retry), `VNSEG_EGRESS_HINT` (free text shown in `/health`).

## 2. Publish it with a Cloudflare named tunnel

Install `cloudflared` on the same PC, then:

```bash
cloudflared tunnel login
cloudflared tunnel create vnseg
cloudflared tunnel route dns vnseg vnseg.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 vnseg
```

Or create the tunnel in the Cloudflare dashboard (Zero Trust > Networks > Tunnels), add a public hostname `vnseg.example.com` pointing to `http://127.0.0.1:8787`, and install the connector with the token it shows (`cloudflared service install <token>` on Windows or Linux).

Check from anywhere: `curl https://vnseg.example.com/health`.

If the PC runs a commercial VPN, exclude `node` and `cloudflared` from it (split tunneling); otherwise the segments leave through the VPN and the tunnel may connect to a far Cloudflare location.

Two PCs can run the same tunnel (same token) as replicas. Cloudflare sends traffic to one connector and moves to the other within seconds if it disconnects.

## 3. Point the addon at it

In the addon's `.env`:

```ini
VNSEG_BASE=https://vnseg.example.com
VNSEG_HOSTS=streamc.xyz
VNSEG_SECRET=<secret>    # optional, defaults to EDGE_SECRET
```

Restart the addon. New NguonC playlists now list `https://vnseg.example.com/seg/...` segment URLs. The addon checks `/health` every 30 s; when vnseg is down, new playlists use the server's `/play/` proxy instead, and switch back once it recovers. Leave `VNSEG_BASE` empty to turn it off.

## Tests

```bash
node --test vnseg/test/*.test.js    # from the repo root; needs openssl on PATH
```
