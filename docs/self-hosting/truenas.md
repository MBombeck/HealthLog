# HealthLog on TrueNAS

HealthLog runs on TrueNAS Community Edition (formerly SCALE) as a Docker app:
one container from `ghcr.io/mbombeck/healthlog` and one PostgreSQL database.
The app container is stateless. Everything you care about lives in the
database dataset and in one value you must keep yourself: the encryption key.

> **Status: pending catalog review.** A HealthLog app for the TrueNAS
> Community train has been prepared but is not listed yet. Until it is, use
> [Install via YAML](#before-the-listing-install-via-yaml) at the end of this
> page. This note goes away once the app appears under Apps, Discover Apps.

## Install from the Community train

1. Generate two secrets. Open the TrueNAS shell (System, Shell) and run the
   command twice, once for each field:

   ```bash
   openssl rand -hex 32
   ```

   Each run prints 64 hex characters. Put both in your password manager
   before you continue; see [Back up your encryption key](#back-up-your-encryption-key).

2. Open Apps, Discover Apps, search for **HealthLog** and choose Install.
3. Fill in the form:

   | Field                 | What to enter                                                                                                  |
   | --------------------- | -------------------------------------------------------------------------------------------------------------- |
   | Timezone              | your timezone                                                                                                  |
   | Database Password     | any strong password; only the two containers use it                                                            |
   | Encryption Key        | the first `openssl rand -hex 32` output                                                                        |
   | Token Signing Key     | the second output. Changing it later signs everyone out                                                        |
   | App URL               | the address you open HealthLog at, with scheme and port, for example `http://192.168.1.10:30536`               |
   | Secure Cookies        | leave off when you open HealthLog over `http://` on the LAN; turn on behind an HTTPS reverse proxy (see below) |
   | WebUI Port            | `30536` unless that port is taken                                                                              |
   | Postgres Data Storage | the default ixVolume, or a host path on a dataset you snapshot                                                 |
   | Resources             | keep memory at 1536 MB or more; the default of 4096 MB is fine                                                 |

4. Install. The first start applies the database migrations before the web
   server listens, so give it a minute. The app shows as running once
   `/api/health` answers.
5. Open the App URL. The first account you register becomes the admin.

The App URL has to match the address in the browser: passkeys, sign-in
redirects and the links in notifications are built from it. If you later put
HealthLog behind a reverse proxy with its own domain, change App URL to that
`https://` address.

Settings the form does not show go under Additional Environment Variables, for
example `UPDATE_CHECK_DISABLED=1`. The full list is in
[environment.md](environment.md). To use your own GeoLite2 databases, add the
directory under Additional Storage and point `GEOLITE2_DIR` at its mount path
([geolite2.md](geolite2.md)).

## Plain HTTP on the LAN

Most NAS installs are reached over `http://`. Leave **Secure Cookies** off for
that. With it on, the browser drops the sign-in cookie on a plain-HTTP page,
and the login page says so before you type a password: "Signing in cannot
complete on this page". Turn it on only when HealthLog is served over
`https://`, and set App URL to that `https://` address.

## Back up your encryption key

HealthLog encrypts tokens, notes, documents and in-database backups with the
Encryption Key. The key is not stored in the database. If the app is deleted
and installed again with a new key over the old database dataset, the data is
still there but cannot be read.

TrueNAS keeps the values you typed into the form with the app's configuration
on the apps pool. Treat that as a convenience, not as your copy: deleting the
app removes it, and a reinstall starts with empty fields. Keep the key in a
password manager or another place outside the NAS.

1. Open Apps, select HealthLog and choose Edit. The key is the Encryption Key
   field under HealthLog Configuration.
2. Sign in as the admin and open Admin, Encryption. The **Back up your
   encryption key** step shows the active key id and a fingerprint, the first
   12 hex characters of SHA-256 over the key. Compare it with your copy:

   ```bash
   echo -n "<your key>" | xxd -r -p | sha256sum | cut -c1-12
   ```

   or paste the copy into **Check my copy**. It is compared and dropped, never
   stored or logged.

3. Press **I have backed up this key**. Until you do, admins see a reminder on
   the dashboard. After a key rotation the step comes back for the new key.

The catalog app sets `HEALTHLOG_PLATFORM=truenas`, so the step opens on these
instructions.

## Backups and restore

A restore needs two things: a backup of the database **and** the Encryption
Key that was active when it was taken. One without the other gets you nothing
back.

- **Snapshots.** Snapshot the Postgres Data Storage dataset (the ixVolume
  lives under the apps pool, a host path wherever you put it). Stop the app
  first, or the snapshot holds a database that was mid-write.
- **A dump.** Open a shell on the `postgres` container (Apps, HealthLog,
  the container's Shell) and run:

  ```bash
  pg_dump -U healthlog healthlog > /var/lib/postgresql/healthlog-$(date +%F).sql
  ```

  The file lands in the Postgres Data Storage dataset, next to the database
  files, so copy it off the NAS as well.

- **Off-host.** HealthLog can push encrypted nightly backups to any
  S3-compatible bucket; see [backup-restore.md](../ops/backup-restore.md).

To restore a dump, run the app with the Encryption Key the dump was taken
under, put the dump file in the Postgres Data Storage dataset, and from the
`postgres` container shell replace the database with it:

```bash
psql -U healthlog -d postgres \
  -c "DROP DATABASE healthlog WITH (FORCE);" \
  -c "CREATE DATABASE healthlog OWNER healthlog;"
psql -v ON_ERROR_STOP=1 -U healthlog healthlog < /var/lib/postgresql/healthlog-YYYY-MM-DD.sql
```

Then restart the app. Restoring over the existing database without dropping
it first does not work: the tables the background queue creates on its own
refuse a plain overwrite.

## When the key does not match the database

At every start HealthLog checks that its key opens the data already in the
database. A missing or malformed key stops the container at once with
`HealthLog: ERROR — encryption configuration is invalid.` in its log. A
well-formed key that does not open the stored data is different: HealthLog
refuses to serve instead of failing on every encrypted value. Pages show
"HealthLog cannot open its data", API requests answer `503` with
`meta.errorCode` `encryption.key_mismatch`, `/api/health` answers `503` with
`reason: "encryption_key_mismatch"`, and no background jobs run. TrueNAS
shows the app as unhealthy rather than crashed, so the reason stays visible in
the app's logs.

Fix it one of three ways, then restart the app:

1. Put the original Encryption Key back (Apps, HealthLog, Edit).
2. Point the app at the database that belongs to this key, for example by
   restoring that dataset.
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
remove that record and restart. Open a shell on the `postgres` container and
run, with the key id the log names (`v1` unless you use `ENCRYPTION_KEYS`):

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
Additional Environment Variables as a last resort. The check still runs and
logs, `/api/health` reports `warning: "encryption_key_mismatch"` without
failing, the app serves, and no key is recorded until the check passes. This
switches off a safety check: with a wrong key every encrypted value fails and
new data is written under that key. Remove the setting once the key is
confirmed.

## Updates

The catalog follows HealthLog releases on its own: when a new image is
published, the TrueNAS catalog picks it up and the app shows an update. Take a
snapshot or a dump first, then update.

Database migrations run at every start, before the web server listens, and
only go forward. The start log says how many are pending. Going back to an
older version with Roll Back does not undo them, and an older version may not
start against a database a newer one has migrated. The way back is the
database backup you took before the update, restored together with the older
version.

The Postgres Image field offers the Postgres major versions the catalog
supports. Changing it runs a one-way upgrade of the database files, so back up
before you touch it.

## Before the listing: install via YAML

Until the catalog app is listed, install HealthLog with Apps, Discover Apps,
the menu next to Custom App, Install via YAML, using these values:

| Setting      | Value                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------- |
| Image        | `ghcr.io/mbombeck/healthlog`, tag `X.Y.Z` (amd64 and arm64)                              |
| Port         | `3000` (HTTP)                                                                            |
| User         | runs as uid `1001` by default; no extra capabilities, `no-new-privileges` is fine        |
| Health check | `GET /api/health`, `200` when ready                                                      |
| Start period | at least 60 s, with more retries than the image's 5 × 30 s: migrations run at every boot |
| Database     | PostgreSQL 16 or 18, no extensions, in its own container with its own dataset            |
| Volumes      | none for the app; the database gets its own dataset                                      |

| Variable                | Required | Notes                                                                                    |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | yes      | `postgresql://<user>:<password>@<host>:5432/<db>`                                        |
| `ENCRYPTION_KEY`        | yes      | 64 hex characters: `openssl rand -hex 32`. Keep a copy outside the NAS.                  |
| `API_TOKEN_HMAC_KEY`    | yes      | 64 hex characters, generated the same way. Changing it signs everyone out.               |
| `NEXT_PUBLIC_APP_URL`   | yes      | the address people open, for example `http://truenas.local:30180`                        |
| `APP_URL`               | yes      | the same address                                                                         |
| `SESSION_COOKIE_SECURE` | no       | `false` for a LAN install served over plain `http://`; leave unset behind an HTTPS proxy |
| `HEALTHLOG_PLATFORM`    | no       | `truenas`: the admin's key backup step opens on the TrueNAS instructions                 |

`HEALTHLOG_PROCESS_TYPE` stays unset (`all`): one container serves the web app
and runs the background jobs. In a YAML install the key sits in the
environment block, so the place to copy it from is `ENCRYPTION_KEY` there.
To move from a YAML install to the catalog app later, take a dump, install the
catalog app with the same key, and restore the dump as described under
[Backups and restore](#backups-and-restore).
