# HTTPS for browser-direct mode

The **Radio source → this browser** options (WebSerial / WebBluetooth) are Chromium-only
and require a *secure context*. MeshKeep itself is happy over plain HTTP; it's the browser
that refuses to expose `navigator.serial` / `navigator.bluetooth` otherwise.

You are already in a secure context when the page is served from:

- `https://…` with a certificate the browser trusts, or
- `http://localhost` / `http://127.0.0.1` (the localhost exception)

## Option 1 — localhost (zero setup)

If the radio is plugged into the same machine you're browsing from, just open
`http://localhost:8080` (or an SSH tunnel: `ssh -L 8080:server:8080 you@server`).
That's a secure context; the browser buttons light up.

## Option 2 — Caddy reverse proxy with an internal CA (recommended for LAN)

Caddy mints and renews certificates from its own local CA. One-time trust install per device.

`Caddyfile`:

```caddy
meshkeep.lan {
    tls internal
    reverse_proxy meshkeep:8080
}
```

Compose service alongside MeshKeep:

```yaml
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
```

Notes:

- WebSocket proxying (`/api/v1/ws`) works out of the box — `reverse_proxy` upgrades automatically.
- Make `meshkeep.lan` resolve on your network (Pi-hole/router DNS entry, or `/etc/hosts`).
- Trust the CA on each browsing device once: fetch the root from the caddy container at
  `/data/caddy/pki/authorities/local/root.crt` and install it
  (Android: Settings → Security → Install certificate; desktop: browser/OS trust store).

If you already run a reverse proxy with real certificates (Let's Encrypt via a
home-lab-launcher, Traefik, nginx proxy manager…), just put MeshKeep behind it — nothing
MeshKeep-specific is needed beyond WebSocket upgrade support.

## Option 3 — Chromium escape hatch (last resort)

For quick tests only, Chromium can be told to treat a plain-HTTP origin as secure:

1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
2. Add `http://your-server:8080`, enable, relaunch.

This weakens the browser's security model for that origin — prefer options 1–2.

## After HTTPS is in place

Open MeshKeep → **Radio → Radio source** → *USB (WebSerial)* or *Bluetooth (WebBLE)*.
The server's claim on a same-host radio is released automatically; hand it back with
*Disconnect & hand back to server*. Tick *Private session* to keep traffic in the
browser only (no sync-back to server history).
