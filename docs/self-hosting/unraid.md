# HealthLog on Unraid

HealthLog runs on Unraid in two ways. The **Compose Manager** path is the clean,
self-contained install (app + database as one unit) and is recommended. The
**Community Applications (CA)** template gives you the familiar one-app-at-a-time
Unraid UI, but because CA templates describe a single container you install
PostgreSQL separately and wire the two together.

HealthLog stores all persistent state in PostgreSQL. The app container keeps one
more thing, its database dumps: every night, and before each update that brings
migrations, it writes a whole-database dump to `/var/lib/healthlog/backups`
(the offline geo-IP databases are either baked in at build time or mounted
read-only; replaceable either way, not state). A backup of the database is a
backup of everything, and those dumps are that backup, so that path needs a
share of its own.

## What you need

- Unraid 6.12 or newer.
- The image: `ghcr.io/mbombeck/healthlog:latest` (multi-arch, amd64 + arm64).
- Three secrets, each generated with `openssl rand -hex 32` (a 64-character hex
  string). On Unraid open the terminal (the `>_` icon, top-right) and run the
  command three times:
  - `POSTGRES_PASSWORD` — the database password
  - `ENCRYPTION_KEY` — AES-256-GCM key for data at rest
  - `API_TOKEN_HMAC_KEY` — API token hashing key

Keep `ENCRYPTION_KEY` safe and backed up. If you lose it, the encrypted columns
become unrecoverable.

---

## Recommended: Compose Manager

This installs the app and its database together, exactly as the project's
`docker-compose.yml` describes.

1. Install **Compose Manager** from Community Applications (search "Compose
   Manager", by dcflachs).
2. **Settings → Docker → Compose Manager → Add New Stack**, name it `healthlog`.
3. Paste the project
   [`docker-compose.yml`](https://github.com/MBombeck/HealthLog/blob/main/docker-compose.yml)
   into the stack's compose file.
4. Edit the stack's `.env` (the "Edit Stack → env" field) and set:

   ```env
   POSTGRES_PASSWORD=<your openssl rand -hex 32>
   ENCRYPTION_KEY=<your openssl rand -hex 32>
   API_TOKEN_HMAC_KEY=<your openssl rand -hex 32>
   SESSION_COOKIE_SECURE=false
   NEXT_PUBLIC_APP_URL=http://tower:3000
   APP_URL=http://tower:3000
   ```

   Replace `tower` with your server's hostname or IP. `SESSION_COOKIE_SECURE=false`
   is required for plain-HTTP LAN access — see the note below.

5. **Compose Up**. The app waits for PostgreSQL, runs database migrations on
   first boot, then starts serving.
6. Open `http://tower:3000`. The first account you register becomes the admin.

Verify the running version:

```bash
curl -s http://tower:3000/api/version
```

---

## Alternative: Community Applications template

Use this if you prefer the per-app Unraid UI. You install PostgreSQL yourself,
then add HealthLog pointed at it.

### Step 1 — install PostgreSQL

1. In **Apps** (Community Applications), search for a **PostgreSQL** container
   (for example jj9987's `postgresql`). Install version 18; an existing 16
   works too. Moving a 16 to 18 later is a dump and restore, see
   [Moving to a newer Postgres major](../ops/postgres-major-upgrade.md#by-hand).
2. Set:
   - `POSTGRES_USER` = `healthlog`
   - `POSTGRES_PASSWORD` = your generated password
   - `POSTGRES_DB` = `healthlog`
3. Map the Postgres data path to a share on the array (e.g.
   `/mnt/user/appdata/healthlog-db`) so the database survives container updates.
4. Note the container's IP (or container name if both run on the same custom
   Docker network).

### Step 2 — add the HealthLog template

The template lives at
[`docs/self-hosting/unraid/healthlog.xml`](unraid/healthlog.xml). Add it via
**Docker → Add Container → Template** and paste the raw URL, or copy it into
`/boot/config/plugins/dockerMan/templates-user/` and pick it from the template
dropdown.

Fill in the fields:

| Field                   | Value                                                                            |
| ----------------------- | -------------------------------------------------------------------------------- |
| WebUI Port              | `3000`                                                                           |
| `DATABASE_URL`          | `postgresql://healthlog:<password>@<postgres-host>:5432/healthlog?schema=public` |
| `ENCRYPTION_KEY`        | your generated key                                                               |
| `API_TOKEN_HMAC_KEY`    | your generated key                                                               |
| `SESSION_COOKIE_SECURE` | `false` for plain-HTTP LAN access                                                |
| `NEXT_PUBLIC_APP_URL`   | `http://tower:3000` (or your domain)                                             |
| `APP_URL`               | same as `NEXT_PUBLIC_APP_URL`                                                    |
| Database dumps          | `/mnt/user/appdata/healthlog/backups` (the default)                              |

Replace `<password>` and `<postgres-host>` with the values from Step 1. The
dumps folder must be writable by the app's user, uid `1001`; create it once
from the terminal with
`mkdir -p /mnt/user/appdata/healthlog/backups && chown 1001:1001 /mnt/user/appdata/healthlog/backups`.
Apply, then open `http://tower:3000` — the first registered user becomes the
admin.

All account data is in the PostgreSQL container you installed in Step 1, and
the nightly dumps of it land in the dumps folder. Without that path the dumps
would sit inside the HealthLog container, which every update replaces, so
HealthLog keeps none: the start log, the admin backups page and the recovery
readiness card say so. Back up both.

---

## The one setting that trips people up

`SESSION_COOKIE_SECURE=false` is required for plain-HTTP LAN installs
(`http://tower:3000`). Left at its default, the session cookie carries the
`Secure` flag, which the browser would drop over HTTP. The login page says so
before anything is sent: "Signing in cannot complete on this page".

Set `SESSION_COOKIE_SECURE=true` (or leave it unset) only when a TLS reverse
proxy serves HealthLog over HTTPS. In that case also point `NEXT_PUBLIC_APP_URL`
and `APP_URL` at the public `https://` URL.

## Save the recovery kit

Copy `ENCRYPTION_KEY`, `API_TOKEN_HMAC_KEY` and, with off-host copies,
`BACKUP_ENCRYPTION_KEY` from the template into your password manager, then
confirm the recovery kit under Admin, Encryption (set
`HEALTHLOG_PLATFORM=unraid` so the kit opens on the Unraid instructions). A
reinstall with a new key over the old database makes the data unreadable;
HealthLog then refuses to serve and says so. See
[Getting started](getting-started.md#save-the-recovery-kit).

## Updates

Pin a release tag (`ghcr.io/mbombeck/healthlog:vX.Y.Z`) and bump deliberately,
or track `:latest` and let Unraid's update check re-pull. Skim the
[CHANGELOG](https://github.com/MBombeck/HealthLog/blob/main/CHANGELOG.md) before
upgrading, and back up the database first. Migrations are forward-only and run
automatically on container start.

## Health check

Both `/api/health` and `/api/version` respond without authentication.
`/api/health` returns `200` when the database and background worker are up
(`503` otherwise) and is the container health probe baked into the image.
`/api/version` returns the version, build SHA, and build timestamp for deploy
verification.
