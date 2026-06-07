# Reverse proxy configuration

The bundled `docker-compose.yml` exposes HealthLog on plain HTTP at
`localhost:3000`. Production deployments front the container with a
reverse proxy that terminates TLS, sets the forwarded headers the
rate-limiter trusts, and preserves the WebSocket upgrade path the
streaming Coach surface depends on.

This guide gives copy-paste blocks for five common fronts. Pick one;
the env-var pairing is identical across them.

## Pre-flight — env vars the proxy interacts with

| Variable | Required for | Notes |
| -------- | ------------ | ----- |
| `NEXT_PUBLIC_APP_URL` | Every public-facing absolute URL the UI emits | Must match the hostname the proxy serves |
| `APP_URL` | Server-side absolute URLs from background jobs | Mirror of the above; both must match |
| `TRUST_PROXY_HOPS` | `X-Forwarded-For` chain trust | Defaults to `1` — one trusted hop |

Set the URL pair to the public origin (`https://your-instance.example.com`)
and restart the `app` container. The image reads both at startup; no
rebuild needed.

### `TRUST_PROXY_HOPS` — what to set it to

`src/lib/api-response.ts` (`getClientIp`) reads the `X-Forwarded-For`
chain from the **right**, counting back `TRUST_PROXY_HOPS` entries.
This guards against a client rotating `X-Forwarded-For` per request
to defeat IP-based rate limits.

| Topology | `TRUST_PROXY_HOPS` |
| -------- | ------------------ |
| App is internet-facing with no proxy | `0` (XFF ignored entirely) |
| Single proxy in front (Caddy / Traefik / Nginx / Coolify) | `1` (default) |
| Cloudflare → your proxy → app | `2` |
| Cloudflare → Coolify-Tunnel → Coolify → app | `3` |

A misconfigured count logs a one-shot warning to stderr and collapses
every anonymous caller into one shared rate-limit bucket. Match the
value to the actual hop count or set it to `0` and let `x-real-ip`
drive the IP resolution.

## Caddy

`Caddyfile`:

```
your-instance.example.com {
    encode zstd gzip
    reverse_proxy localhost:3000 {
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
        header_up Host {host}
        flush_interval -1
    }
}
```

Caddy handles the WebSocket upgrade automatically. `flush_interval -1`
disables response buffering so the streaming insight events surface
without batching delays. With Caddy as the only hop, leave
`TRUST_PROXY_HOPS=1`.

## Traefik

`docker-compose.override.yml` snippet:

```yaml
services:
  app:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.healthlog.rule=Host(`your-instance.example.com`)"
      - "traefik.http.routers.healthlog.entrypoints=websecure"
      - "traefik.http.routers.healthlog.tls.certresolver=letsencrypt"
      - "traefik.http.services.healthlog.loadbalancer.server.port=3000"
      - "traefik.http.middlewares.healthlog-headers.headers.customrequestheaders.X-Forwarded-Proto=https"
      - "traefik.http.routers.healthlog.middlewares=healthlog-headers"
```

Traefik forwards `X-Forwarded-For` by default and respects the WebSocket
upgrade. Pair with `TRUST_PROXY_HOPS=1`. If Traefik sits behind
Cloudflare, set it to `2` so the rate-limiter reads the real client IP
that Cloudflare placed in the chain.

## Nginx Proxy Manager

In the NPM UI:

1. **Proxy Hosts → Add Proxy Host.**
2. **Domain Names:** `your-instance.example.com`.
3. **Scheme:** `http`; **Forward Hostname / IP:** the Docker host or
   internal hostname; **Forward Port:** `3000`.
4. Enable **Websockets Support** (required for streaming Coach
   responses).
5. **SSL tab:** request a Let's Encrypt certificate, force SSL.
6. **Advanced tab — Custom Nginx Configuration:**

   ```nginx
   proxy_read_timeout 300s;
   ```

   Nginx Proxy Manager configures the standard forwarded headers
   automatically and adds the WebSocket upgrade directives when
   Websockets Support is enabled.

   The 300-second read timeout matters for long-running insight
   generations — anything shorter will cut streamed responses mid-flight.

Pair with `TRUST_PROXY_HOPS=1`.

## Coolify

Coolify's bundled Traefik handles most of this. The pieces that need
operator attention:

1. **Application → Domains:** set `https://your-instance.example.com`.
   Coolify provisions the certificate and adds the Traefik labels.
2. **Application → Environment Variables:** set
   `NEXT_PUBLIC_APP_URL`, `APP_URL`, and any optional secrets
   (`WITHINGS_*`, `APNS_*`, `LOKI_*`).
3. **Application → General → Pull policy:** `always`. The bundled
   `docker-compose.yml` declares this explicitly (v1.4.34.2 fix) so
   Coolify re-checks the GHCR digest on every redeploy instead of
   reusing the cached `:latest` layer.
4. **Notifications → Webhook:** point at `/api/internal/deploy-webhook`
   with the `X-Deploy-Webhook-Secret` header set to
   `DEPLOY_WEBHOOK_SECRET`. The app gates the endpoint with a
   timing-safe compare against that env var.

### DO NOT set as runtime env vars

The following variables are **build-time only** — they are injected
via `--build-arg` by the `docker-publish` workflow and baked into the
shipped image. Setting them under Coolify's *Environment Variables*
panel has zero effect on the running container, and the stale value
becomes a misleading artefact next time someone audits the deploy
config:

- `NEXT_PUBLIC_APP_VERSION` — sourced from the GHCR tag at build
  time. Next.js inlines the value into both the client bundle (so
  the `<VersionPoller>` self-healing reload compares against the
  shipped shell) and the `/api/version` server route (so the public
  endpoint returns the same string). The `env: {…}` block in
  `next.config.ts` short-circuits the runtime `process.env` read.
- `NEXT_PUBLIC_APP_BUILD_SHA`, `NEXT_PUBLIC_APP_BUILT_AT` — same
  pattern. The CI workflow stamps the short SHA and build timestamp
  into the image during `pnpm build`.

If you spot any of these in the Coolify panel, delete the entry. The
image already carries the correct value.

Coolify-Tunnel adds one hop to the chain; pair with
`TRUST_PROXY_HOPS=2`. If you front Coolify itself with Cloudflare,
bump to `3`.

## Bare Nginx

`/etc/nginx/sites-available/healthlog`:

```nginx
upstream healthlog {
    server 127.0.0.1:3000;
    keepalive 16;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name your-instance.example.com;

    ssl_certificate     /etc/letsencrypt/live/your-instance.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-instance.example.com/privkey.pem;

    client_max_body_size 1600M;  # Apple Health export.zip cap is 1.5 GB

    location / {
        proxy_pass http://healthlog;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_buffering off;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name your-instance.example.com;
    return 301 https://$host$request_uri;
}
```

`client_max_body_size 1600M` is the load-bearing setting if you plan
to support Apple Health `export.zip` uploads — the app caps the
upload at 1.5 GB and Nginx will reject the body before the app sees
it otherwise. `proxy_buffering off` keeps streamed insight events
flowing without buffer pauses. Pair with `TRUST_PROXY_HOPS=1`.

## Verifying the proxy chain

Once the proxy is in front, hit `https://your-instance.example.com/api/version`
from outside the host and check `docker compose logs app` for the
request. The wide-event log line should carry a non-null client IP
that matches your real source address. A `null` IP or a single
`unknown` rate-limit bucket means `TRUST_PROXY_HOPS` is set higher
than the actual proxy hop count, or the proxy is dropping the
`X-Forwarded-For` header entirely.

The one-shot stderr warning `[getClientIp] TRUST_PROXY_HOPS=N but
X-Forwarded-For carried M entries` confirms a mismatch. Adjust the
env var down to the actual chain length and restart.

## Running over plain HTTP on a LAN (no reverse proxy)

The session cookie carries the `Secure` flag by default under
`NODE_ENV=production`, which is what the bundled Docker image runs.
On a plain-HTTP origin that is not `localhost` / `127.0.0.1` / `::1`,
modern browsers silently drop a `Secure` cookie before sending the
next request — the login round-trip looks like it succeeds (the
server returns 200 + `Set-Cookie`) but the very next page load
401s and bounces back to `/auth/login`.

If you genuinely want to serve HealthLog on `http://10.0.0.42:3000`
or `http://healthlog.lan:3000` (NAS, homelab, Tailscale-only
surface) and trust the network the traffic crosses, set:

```
SESSION_COOKIE_SECURE=false
```

in your `.env`. The session, onboarding-hint, Withings OAuth state,
and Codex device-OAuth state cookies all stop emitting `Secure` and
login works over HTTP. The trade-off is explicit: the session
cookie crosses the wire unencrypted, so the network it traverses
needs to be one you control.

**Do not set this on a deployment that ever serves plain HTTP to the
open internet.** Anyone with passive network access can capture the
session cookie and impersonate the user. The right answer for any
public-facing host is the reverse proxy + Let's Encrypt path
documented above.

The default behaviour is unchanged when this variable is unset —
deployments behind an HTTPS-terminating proxy keep setting `Secure`
exactly as before.
