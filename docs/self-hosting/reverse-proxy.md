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
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   proxy_set_header Host $host;
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_read_timeout 300s;
   ```

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
