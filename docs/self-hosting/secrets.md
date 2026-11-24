# Secrets from files

Every secret HealthLog reads from the environment can come from a file
instead: set `<NAME>_FILE` to the file's path inside the container, and leave
`<NAME>` unset. That is the form Docker secrets, Kubernetes secret volumes and
a Vault agent hand secrets over in, and it keeps the values out of `.env`,
out of `docker inspect` and out of the platform's environment editor.

## The rules

- The file holds the bare value. One trailing newline (`\n` or `\r\n`) is
  ignored, so `echo "$value" > file` works; nothing else is trimmed.
- The container's entrypoint reads the files before anything else, so the
  migrations, the server and the worker see ordinary variables.
- A file that cannot be read, or that holds only whitespace, stops the start
  with the variable and the reason named. The value is never printed.
- `<NAME>` and `<NAME>_FILE` both set: the same value is accepted, different
  values stop the start. Set one of them.
- A `_FILE` variable for a name not in the list below does nothing. The start
  goes on and logs a warning naming it.

## Which variables

| Variable                          | What it is                                       |
| --------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`                    | Connection string, password included             |
| `POSTGRES_PASSWORD`               | Password of the bundled `db` service             |
| `ENCRYPTION_KEY`                  | Encryption key for data at rest                  |
| `ENCRYPTION_KEYS`                 | The key map, when rotating keys                  |
| `API_TOKEN_HMAC_KEY`              | Key for API tokens and session cookies           |
| `BACKUP_ENCRYPTION_KEY`           | Key for off-host backups                         |
| `BACKUP_ENCRYPTION_PREVIOUS_KEYS` | Older backup keys, kept for restores             |
| `BACKUP_S3_ACCESS_KEY`            | Bucket access key                                |
| `BACKUP_S3_SECRET_KEY`            | Bucket secret key                                |
| `WITHINGS_WEBHOOK_SECRET`         | Withings webhook secret                          |
| `WHOOP_WEBHOOK_SECRET`            | WHOOP webhook secret                             |
| `TELEGRAM_WEBHOOK_SECRET`         | Telegram webhook secret                          |
| `DEPLOY_WEBHOOK_SECRET`           | Deploy webhook secret                            |
| `POLAR_CLIENT_SECRET`             | Polar OAuth client secret                        |
| `OURA_CLIENT_SECRET`              | Oura OAuth client secret                         |
| `STRAVA_CLIENT_SECRET`            | Strava OAuth client secret                       |
| `OIDC_CLIENT_SECRET`              | Single sign-on client secret                     |
| `SMTP_PASS`                       | Mail server password                             |
| `VAPID_PRIVATE_KEY`               | Web Push private key                             |
| `APNS_KEY_B64`                    | APNs key, base64 (see below for `APNS_KEY_FILE`) |
| `WALLET_APPLE_KEY_B64`            | Apple Wallet signing key                         |
| `WALLET_APPLE_KEY_PASSPHRASE`     | Passphrase of that key                           |
| `MAXMIND_LICENSE_KEY`             | MaxMind licence key for the GeoLite2 download    |
| `LOKI_PASSWORD`                   | Loki log shipping password                       |

URLs, ids and public keys (`VAPID_PUBLIC_KEY`, `PUSH_RELAY_KEYS`,
`WALLET_APPLE_CERT_B64`) are not secrets and have no `_FILE` form.

`APNS_KEY_FILE` is older than this scheme and works as before: the APNs sender
reads the `.p8` file at that path itself, `APNS_KEY_B64` and `APNS_KEY` win
over it, and a bad file turns iOS push off rather than stopping the start
([notifications](notifications.md)).

## Docker Compose

`docker-compose.yml` passes every `<NAME>_FILE` through to the container, and
ends with a commented example. Put the services and secrets you need into a
`docker-compose.override.yml` next to it, which compose merges in and an
update of `docker-compose.yml` leaves alone:

```yaml
services:
  app:
    environment:
      DATABASE_URL: ""
      DATABASE_URL_FILE: /run/secrets/database_url
      ENCRYPTION_KEY_FILE: /run/secrets/encryption_key
      API_TOKEN_HMAC_KEY_FILE: /run/secrets/api_token_hmac_key
    secrets: [database_url, encryption_key, api_token_hmac_key]
  db:
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets: [postgres_password]
  db-upgrade:
    environment:
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets: [postgres_password]

secrets:
  database_url:
    file: ./secrets/database_url
  encryption_key:
    file: ./secrets/encryption_key
  api_token_hmac_key:
    file: ./secrets/api_token_hmac_key
  postgres_password:
    file: ./secrets/postgres_password
```

Then remove the same variables from `.env`. Give `db-restore` and, when you
run one, `app-worker` the same lines as `app`.

Two things particular to the bundled file:

- It builds `DATABASE_URL` from `POSTGRES_PASSWORD`. With the password in a
  file that no longer works, so the whole URL goes into a file
  (`postgresql://healthlog:<password>@db:5432/healthlog?schema=public`) and
  `DATABASE_URL: ""` empties the built one. An empty variable counts as unset.
- The `db` service runs the official Postgres image, which reads
  `POSTGRES_PASSWORD_FILE` itself.

Compose without Swarm mounts each file as it is on the host, owner and mode
included. On Linux the app reads its files as uid 1001 and the Postgres image
as uid 70, so give each file to its reader and keep it private:

```bash
sudo chown 1001 secrets/database_url secrets/encryption_key secrets/api_token_hmac_key
sudo chown 70 secrets/postgres_password
sudo chmod 400 secrets/*
```

## Commands run inside the container

`docker compose exec` starts a new process with the container's configured
environment, not the one the entrypoint prepared. The maintenance scripts the
runbooks name (`reset-password.mjs`, the `db-restore` service) read the
`_FILE` variables themselves, so they work unchanged.

## Without Docker

A server started directly (`node server.js`, `next start`) reads the files
the same way when it starts, with the same rules.

## Checking a configuration

`pnpm check-env` (see [env-check](../ops/env-check.md)) counts a required
secret as set when either `<NAME>` or `<NAME>_FILE` is, and reports both set
as an error.
