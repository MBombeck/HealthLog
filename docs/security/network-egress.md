# Network egress

Every outbound connection a HealthLog server makes, why, when, and how to turn
it off; the floor that keeps user-entered addresses off the private network;
and how an operator can enforce an allowlist of their own.

Inbound traffic is the reverse proxy's business
([`self-hosting/reverse-proxy.md`](../self-hosting/reverse-proxy.md)). The
browser's own connections are limited by the Content-Security-Policy, whose
`connect-src` is `'self'` everywhere except the settings pages that talk to a
provider directly (`src/proxy.ts`).

"Web" below is an API route, "worker" a pg-boss job or the notification
dispatcher. With `HEALTHLOG_PROCESS_TYPE=all` (the default) both run in one
process.

## The floor for user-entered addresses

Outbound HTTP from `src/lib` and `src/app` goes through `safeFetch`
(`src/lib/safe-fetch.ts`); the ESLint rule `healthlog/safe-fetch-required`
refuses a bare `fetch(` there. Its defaults: no redirects followed, a 15-second
timeout.

- **`requirePublicHost: true`**, used for every address a user, an admin or a
  remote client supplies: `isPublicUrl` (`src/lib/validations/notifications.ts`)
  refuses anything but http and https, `localhost` and the `.local`,
  `.internal` and `.localhost` names, and every private, loopback, link-local,
  CGNAT, unique-local and metadata address in any notation (octal, hex and
  single-number IPv4, IPv4-mapped IPv6). The connection then goes through a
  dispatcher that resolves the name and connects only to a public address
  (`src/lib/safe-fetch-dispatcher.ts`), which closes DNS rebinding. A redirect
  is followed only when the caller asks, re-checked on every hop, at most five.
- **An operator-approved private origin**: the `*_PRIVATE_ORIGINS` variables
  below let an operator name exact LAN origins (a local model server, a
  Nightscout on the home network). Such a request must match the named origin,
  may not redirect, and still never reaches link-local or metadata addresses.
- **Fixed vendor hosts** written in the code are called without the public-host
  pin; the host is not attacker-controlled.

Things that do not use `safeFetch`: Postgres, APNs (HTTP/2 through
`@parse/node-apn`), SMTP (nodemailer), S3 (AWS SDK), the OIDC JWKS
(`jose`), and the TLS pin probe (`tls.connect`).

## Destinations

### AI providers

Off until a user or an admin configures a provider; the AI capability gate
re-checks consent and capability immediately before anything leaves
(`src/lib/ai/capabilities/egress.ts`). See
[`integrations/ai-providers.md`](../integrations/ai-providers.md).

| Destination                            | Trigger                                                    | Address entered by                                                                                          | Off                                                             |
| -------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `api.anthropic.com`                    | Insights, Coach, document and lab reading (web, worker)    | fixed; key from the user                                                                                    | not configured                                                  |
| `api.openai.com`                       | same                                                       | fixed; key from the user                                                                                    | not configured                                                  |
| Admin AI base URL                      | same, plus the provider health probe                       | admin, `adminAiBaseUrl` (Admin, AI); https and a host on the built-in list or `ADMIN_AI_BASE_URL_ALLOWLIST` | not configured                                                  |
| Local model server (Ollama, LM Studio) | same                                                       | user, `aiLocalBaseUrl`                                                                                      | not configured; private hosts only through `AI_PRIVATE_ORIGINS` |
| OpenAI-compatible gateway              | same                                                       | user, `aiCompatBaseUrl`                                                                                     | not configured; private hosts only through `AI_PRIVATE_ORIGINS` |
| `chatgpt.com`, `auth.openai.com`       | ChatGPT subscription (Codex) sign-in, token refresh, calls | fixed                                                                                                       | not connected                                                   |

### Health-data integrations

Each runs on its own worker schedule after a user connects it, and on the
connect, test and disconnect routes. The OAuth authorize step runs in the
browser; the token exchange and refresh run on the server against the
provider's own token endpoint.

| Destination                                                    | Address entered by             | Off                                                                                |
| -------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| Withings (`wbsapi.withings.net`, `account.withings.com`)       | fixed                          | not connected                                                                      |
| Polar (`www.polaraccesslink.com`)                              | fixed                          | `POLAR_CLIENT_ID` / `POLAR_CLIENT_SECRET` unset                                    |
| Oura (`api.ouraring.com`, `moi.ouraring.com`)                  | fixed                          | `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET` unset                                      |
| WHOOP (`api.prod.whoop.com`)                                   | fixed                          | not connected                                                                      |
| Strava (`www.strava.com`)                                      | fixed                          | `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET` unset                                  |
| Google Health (`health.googleapis.com`, `accounts.google.com`) | fixed                          | not connected                                                                      |
| Garmin (`personal.connectapi.garmin.com` or `.cn`)             | fixed; the user picks a region | not connected                                                                      |
| Nightscout                                                     | user, instance URL             | not connected; private hosts only through `NIGHTSCOUT_PRIVATE_ORIGINS`             |
| Dawarich                                                       | user, instance URL             | not connected; private hosts only through `DAWARICH_PRIVATE_ORIGINS`               |
| Health Connect export folder (WebDAV, Nextcloud)               | user, folder URL               | not configured; private hosts only through `HEALTH_CONNECT_WEBDAV_PRIVATE_ORIGINS` |
| Paperless-ngx, Papra (document picker)                         | user, base address             | `DOCUMENT_SOURCE_ORIGINS` unset; when set, it is an exact allowlist                |

### Notifications

See [`self-hosting/notifications.md`](../self-hosting/notifications.md) and
[`integrations/push-relay.md`](../integrations/push-relay.md).

| Destination                                       | Trigger                                                        | Address entered by                  | Off                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `api.push.apple.com` (APNs)                       | notification dispatch, wallet pass updates                     | fixed                               | `APNS_*` and `WALLET_APPLE_*` unset                                       |
| `push.healthlog.dev` (push relay, wallet signing) | dispatch, relay maintenance, device registration, pass signing | default, `PUSH_RELAY_URL`           | `PUSH_RELAY_MODE=off`; the default stays off until an admin enables it    |
| Browser push service endpoints                    | dispatch                                                       | the browser's push subscription     | no VAPID key                                                              |
| `api.telegram.org`                                | dispatch, webhook registration                                 | fixed; bot token from the user      | not configured                                                            |
| ntfy (default `ntfy.sh`)                          | dispatch, test                                                 | user, server URL                    | not configured; private hosts only through `NOTIFICATION_PRIVATE_ORIGINS` |
| Generic webhook (Gotify, Home Assistant, n8n, …)  | dispatch, test                                                 | user, webhook URL                   | not configured; private hosts only through `NOTIFICATION_PRIVATE_ORIGINS` |
| SMTP server                                       | dispatch, test                                                 | operator, `SMTP_HOST` / `SMTP_PORT` | unset                                                                     |

### Identity and security

| Destination                                     | Trigger                                                                                              | Address entered by                                                    | Off                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `api.pwnedpasswords.com` (k-anonymity prefix)   | registration, password change, admin reset                                                           | fixed                                                                 | `PASSWORD_BREACH_CHECK_DISABLED`                                                                             |
| OIDC issuer: discovery, token, userinfo, JWKS   | SSO sign-in                                                                                          | operator, `OIDC_ISSUER_URL`; the JWKS host must equal the issuer host | the three `OIDC_*` provider variables unset                                                                  |
| `ipwho.is` or `IP_GEO_LOOKUP_URL`               | sign-in, new-device alert, hourly backfill; only for addresses the local GeoLite2 files cannot place | operator                                                              | `IP_GEO_LOOKUP_DISABLED`, or mount the databases ([`self-hosting/geolite2.md`](../self-hosting/geolite2.md)) |
| `download.maxmind.com`                          | boot and monthly, when a licence key is set                                                          | fixed                                                                 | `MAXMIND_LICENSE_KEY` unset                                                                                  |
| MCP client metadata document (CIMD `client_id`) | MCP OAuth authorize                                                                                  | the remote MCP client                                                 | the MCP module off ([`self-hosting/mcp.md`](../self-hosting/mcp.md))                                         |

### Operations

| Destination                                  | Trigger                                             | Address entered by             | Off                                                                                                                          |
| -------------------------------------------- | --------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Postgres                                     | always                                              | operator, `DATABASE_URL`       | required                                                                                                                     |
| S3-compatible bucket                         | nightly off-host copies, purge, restore, admin test | operator, `BACKUP_S3_ENDPOINT` | `BACKUP_S3_*` unset                                                                                                          |
| Loki                                         | every log batch                                     | operator, `LOKI_ENDPOINT`      | unset                                                                                                                        |
| GlitchTip                                    | server errors, the browser error relay              | admin, GlitchTip DSN           | not configured                                                                                                               |
| Umami                                        | tracker script and event proxy                      | admin, Umami script URL        | not configured                                                                                                               |
| `api.github.com` (latest release)            | About page and admin version tile, at most daily    | fixed                          | `UPDATE_CHECK_DISABLED`                                                                                                      |
| The instance's own host (TLS handshake only) | every six hours                                     | operator, `APP_URL`            | runs whenever `APP_URL` is https; `TLS_LEAF_SPKI_PINS` only arms the alarm ([`ops/tls-cert-pin.md`](../ops/tls-cert-pin.md)) |

### Weather and air quality

`archive-api.open-meteo.com`, `geocoding-api.open-meteo.com` and
`air-quality-api.open-meteo.com` (overridable with the `OPENMETEO_*`
variables), nightly and when a user looks up a place, only for accounts that
turned the environment module on. `ENVIRONMENT_AIR_QUALITY_DISABLED` turns off
the air-quality half. Details: [`self-hosting/environment.md`](../self-hosting/environment.md).

Not egress: medication leaflet links are opened by the browser, and there is
no avatar service.

## Fields that take an address

These are the only places where somebody other than the operator chooses a
destination. Each passes the floor above at save time and again at send time.

| Field                                  | Set by                          | Route                               |
| -------------------------------------- | ------------------------------- | ----------------------------------- |
| Local model base URL, gateway base URL | user                            | `/api/user/ai-provider`             |
| Admin AI base URL                      | admin                           | `/api/admin/ai-settings`            |
| ntfy server URL                        | user                            | `/api/settings/ntfy`                |
| Webhook URL                            | user                            | `/api/settings/webhook`             |
| Nightscout URL                         | user                            | `/api/nightscout/connect`           |
| Dawarich URL                           | user                            | `/api/dawarich/connect`             |
| Health Connect folder URL              | user                            | `/api/import/health-connect-remote` |
| Document source base address           | user                            | `/api/documents/sources/[system]`   |
| Web Push endpoint                      | the user's browser              | `/api/notifications/web-push`       |
| GlitchTip DSN, Umami script URL        | admin                           | `/api/admin/settings`               |
| MCP client metadata URL                | a remote client, before sign-in | `/api/mcp/oauth/authorize`          |

## An operator allowlist

The app has no instance-wide outbound allowlist: by default any public host is
reachable from the fields above. An operator who wants one enforces it below
the app.

**Docker network without a route out, plus a forward proxy.** Put the app on an
internal network and give it a proxy that allows only the hosts you use. With
Squid as the proxy:

```yaml
# docker-compose.override.yml
networks:
  internal:
    internal: true
services:
  app:
    networks: [default, internal] # default only if the proxy publishes the port
    environment:
      HTTPS_PROXY: http://egress:3128
      HTTP_PROXY: http://egress:3128
      NO_PROXY: db,localhost,127.0.0.1
  egress:
    image: ubuntu/squid:6.10-24.10_beta
    networks: [default, internal]
    volumes:
      - ./squid.conf:/etc/squid/squid.conf:ro
```

```text
# squid.conf: one line per host you actually use
acl allowed dstdomain api.pwnedpasswords.com push.healthlog.dev api.push.apple.com
acl allowed dstdomain .withings.net .withings.com api.anthropic.com
http_access allow CONNECT allowed
http_access deny all
http_port 3128
```

Check first that every client honours the proxy variables in your release
(Node's `fetch` reads them only when started with `NODE_USE_ENV_PROXY=1` on
recent Node versions); where one does not, the host firewall below is the
reliable layer.

**Host firewall.** With nftables or iptables on the host, drop the container
network's forwarded traffic except to the addresses of the hosts you allow.
Vendor addresses change, so resolve them on a schedule or allow by the
provider's published ranges.

Either way, keep Postgres, your SMTP server, your bucket and your log
collector on the list, and decide per integration rather than per release:
the tables above are the complete set of hosts a release can ask for.
