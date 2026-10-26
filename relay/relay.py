"""Tiny allowlisted HTTPS relay (HTTP CONNECT proxy) for the NguonC addon.

Run it on a machine with a Vietnamese IP (home PC, VN VPS). The addon server
sends only NguonC/StreamC requests through it (UPSTREAM_PROXY), so it carries
a few KB per request, never the video.

Safety:
- Listens on one address only (use a private VPN address such as Tailscale).
- Accepts only the client IPs in RELAY_ALLOWED_CLIENTS.
- Tunnels only to RELAY_ALLOWED_HOSTS on port 443; TLS stays end-to-end,
  so the relay cannot read or change the traffic.

Configuration (environment variables):
  RELAY_LISTEN_HOST       address to bind, e.g. your Tailscale IP   (required)
  RELAY_LISTEN_PORT       default 3128
  RELAY_ALLOWED_CLIENTS   comma-separated client IPs, e.g. the addon server's VPN IP (required)
  RELAY_ALLOWED_HOSTS     default "nguonc.com,streamc.xyz" (host or any subdomain)

Requires Python 3.8+, no extra packages.
"""
import asyncio
import datetime
import os
import sys

LISTEN_HOST = os.environ.get("RELAY_LISTEN_HOST", "")
LISTEN_PORT = int(os.environ.get("RELAY_LISTEN_PORT", "3128"))
ALLOWED_CLIENTS = {c.strip() for c in os.environ.get("RELAY_ALLOWED_CLIENTS", "").split(",") if c.strip()}
ALLOWED_HOSTS = tuple(h.strip().lower() for h in
                      os.environ.get("RELAY_ALLOWED_HOSTS", "nguonc.com,streamc.xyz").split(",") if h.strip())
ALLOWED_PORTS = {443}
LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "relay.log")


def log(msg):
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n"
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 5_000_000:
            os.replace(LOG, LOG + ".1")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def host_ok(host):
    host = host.lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in ALLOWED_HOSTS)


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle(cr, cw):
    peer = cw.get_extra_info("peername")[0]
    try:
        if peer not in ALLOWED_CLIENTS:
            log(f"DENY client {peer}")
            return cw.close()
        head = await asyncio.wait_for(cr.readuntil(b"\r\n\r\n"), 15)
        method, target, _ = head.split(b"\r\n", 1)[0].decode("latin-1").split(" ", 2)
        if method.upper() != "CONNECT":
            cw.write(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
            await cw.drain()
            return cw.close()
        host, _, port = target.rpartition(":")
        port = int(port or 0)
        if not host_ok(host) or port not in ALLOWED_PORTS:
            log(f"DENY target {target} from {peer}")
            cw.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            await cw.drain()
            return cw.close()
        ur, uw = await asyncio.wait_for(asyncio.open_connection(host, port), 15)
        cw.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        await cw.drain()
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    except Exception as e:
        log(f"ERR {peer}: {type(e).__name__} {e}")
        try:
            cw.close()
        except Exception:
            pass


async def main():
    if not LISTEN_HOST or not ALLOWED_CLIENTS:
        sys.exit("Set RELAY_LISTEN_HOST and RELAY_ALLOWED_CLIENTS (see the docstring).")
    while True:  # the VPN address may not exist yet right after boot
        try:
            server = await asyncio.start_server(handle, LISTEN_HOST, LISTEN_PORT)
            break
        except OSError as e:
            log(f"bind failed ({e}), retrying in 10s")
            await asyncio.sleep(10)
    log(f"listening on {LISTEN_HOST}:{LISTEN_PORT}, hosts={','.join(ALLOWED_HOSTS)}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
