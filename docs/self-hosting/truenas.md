# HealthLog on TrueNAS SCALE

HealthLog runs on TrueNAS SCALE as a Docker app: one `app` container from
`ghcr.io/mbombeck/healthlog` and one PostgreSQL 16 database. The app container
is stateless; everything you care about lives in the database dataset and in
one value you must keep yourself: the encryption key.

## What the app needs

| Setting      | Value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| Image        | `ghcr.io/mbombeck/healthlog`, tag `X.Y.Z` (amd64 and arm64)                              |
| Port         | `3000` (HTTP)                                                                            |
| User         | runs as uid `1001`; no extra capabilities, `no-new-privileges` is fine                   |
| Health check | `GET /api/health`, `200` when ready                                                      |
| Start period | at least 60 s, with more retries than the image's 3 × 30 s: migrations run at every boot |
| Database     | PostgreSQL 16 (17 and later are not a drop-in), no extensions                            |
| Volumes      | none for the app; the database gets its own dataset                                      |

## Environment

| Variable                | Required | Notes                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | yes      | `postgresql://<user>:<password>@<host>:5432/<db>`                                           |
| `ENCRYPTION_KEY`        | yes      | 64 hex characters: `openssl rand -hex 32`. Keep a copy outside the NAS (see below).         |
| `API_TOKEN_HMAC_KEY`    | yes      | 64 hex characters, generated the same way. Changing it signs everyone out.                  |
| `NEXT_PUBLIC_APP_URL`   | yes      | the address people open, for example `http://truenas.local:30180`                           |
| `APP_URL`               | yes      | the same address                                                                            |
| `SESSION_COOKIE_SECURE` | no       | `false` for a LAN install served over plain `http://`; leave unset behind an HTTPS proxy    |
| `HEALTHLOG_PLATFORM`    | no       | `truenas`: the admin's key backup step opens on the TrueNAS instructions                    |
| `GEOLITE2_DIR`          | no       | a mounted directory of GeoLite2 `.mmdb` files, so sign-in locations are resolved on the NAS |

`HEALTHLOG_PROCESS_TYPE` stays unset (`all`): one container serves the web app
and runs the background jobs.

## Plain HTTP on the LAN

Most NAS installs are reached over `http://`. Set `SESSION_COOKIE_SECURE=false`
for that. If it is left at its default, the browser drops the sign-in cookie
and the login page says so before you type a password: "This server only sets
its sign-in cookie over https://".

## Back up your encryption key

HealthLog encrypts tokens, notes, documents and in-database backups with
`ENCRYPTION_KEY`. The key is not stored in the database. If the app is deleted
and reinstalled with a new key over the old database dataset, the data is
still there but cannot be read.

1. Copy `ENCRYPTION_KEY` from the app's settings (Apps, HealthLog, Edit,
   Environment) into your password manager.
2. Sign in as the admin and open Admin, Encryption. The step shows the key id
   and a fingerprint, the first 12 hex characters of SHA-256 over the key.
   Compare it with your copy:

   ```bash
   echo -n "<your key>" | xxd -r -p | sha256sum | cut -c1-12
   ```

   or paste the copy into "Check my copy" (it is compared and dropped, never
   stored or logged).

3. Confirm the backup. Until you do, admins see a reminder on the dashboard.
   After a key rotation the step comes back for the new key.

## When the key does not match the database

At every start HealthLog checks that its key opens the data already in the
database. If it does not, it refuses to serve instead of failing on every
encrypted value: pages show "HealthLog cannot open its data", API requests
answer `503` with `meta.errorCode` `encryption.key_mismatch`, `/api/health`
answers `503` with `reason: "encryption_key_mismatch"`, and no background jobs
run. TrueNAS shows the app as unhealthy rather than crashed, so the reason
stays visible.

Fix it one of three ways, then restart the app:

1. Put the original `ENCRYPTION_KEY` back.
2. Point `DATABASE_URL` at the database that belongs to this key.
3. Start fresh with an empty database. The old data and its backups need the
   old key.

Before it records a key as the right one, the check reads the oldest
encrypted values in the database and records the key only if they open (or if
the database holds no encrypted value under that key id yet). When the data
proves neither, the app keeps serving, records nothing, writes a warning
starting with `[boot] Encryption key check inconclusive` to the log, and
checks again at the next start.

### Resetting the check

If you are certain the configured key is the one the data was written with,
and the app still refuses because the check recorded a different key earlier,
remove that record and restart. Open a shell on the database container (Apps,
HealthLog, the database container's Shell) and run, with the key id the log
names (`v1` unless you use `ENCRYPTION_KEYS`):

```bash
psql -U healthlog healthlog \
  -c "DELETE FROM encryption_key_canaries WHERE key_id = 'v1';"
```

Then restart the app. It probes the stored data again and records the key
only if that data opens with it. If the key is in fact wrong, the app then
fails on every encrypted value instead of refusing clearly, so only do this
when you are sure. After a key rotation you never need this for the old key
id: the rotation script removes its record once no values remain under it.

On a first start there is no record to remove. If the check refuses there and
you are certain the key is right, add `ENCRYPTION_KEY_CHECK` = `warn` under
Apps, HealthLog, Edit, Environment as a last resort. The check still runs and
logs, `/api/health` reports `warning: "encryption_key_mismatch"` without
failing, the app serves, and no key is recorded until the check passes. This
switches off a safety check: with a wrong key every encrypted value fails and
new data is written under that key. Remove the setting once the key is
confirmed.

## Updates

Pick the new tag, take a snapshot of the database dataset first, and update.
Migrations run on start; the first start of a new install applies all of them,
which is why the start period above is generous.
