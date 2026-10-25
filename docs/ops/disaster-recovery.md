# Disaster recovery

The copy that rebuilds a lost server is the database dump. This page says
what is dumped and where it goes, which keys a restore needs, how to restore
onto a new server, and how the procedure is tested.

## What is backed up, and where

| Copy                    | When                                                                        | Where                                                               | Kept                            |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------- |
| Nightly dump            | 01:30 Europe/Berlin, the zone every schedule runs in (`DB_BACKUP_SCHEDULE`) | `DB_BACKUP_DIR`, the `backups` volume of the bundled compose file   | the newest 7 (`DB_BACKUP_KEEP`) |
| Pre-migration dump      | on start, when the new image brings migrations, before them                 | the same directory                                                  | the newest 2                    |
| Off-host copy of a dump | right after each nightly dump, if the bucket is configured                  | your bucket, under `database/`, sealed with `BACKUP_ENCRYPTION_KEY` | your bucket's lifecycle rule    |

A dump is `pg_dump --format=custom` of the whole database: every account,
sign-ins, passkeys, sharing grants and managed profiles, documents, the job
queue and the instance settings. It is two files:

- `healthlog-<UTC time>-<daily|pre-migration>.dump`, the archive;
- `healthlog-<UTC time>-<daily|pre-migration>.manifest.json` beside it: the
  app version and build, the newest applied migration, the Postgres version,
  the archive's size and SHA-256, the row count of every table, and the
  fingerprints (never the values) of the keys the database needs.

A dump counts as good only when both files exist under their final names. The
archive is written as `.partial`, read back with `pg_restore --list`, and
renamed after its manifest; a run that fails leaves nothing that looks good.
The admin backups page shows the newest good dump, where it is, and the
newest failed run. The start log says on every boot where dumps go, or that
none can be kept.

Local dumps are not encrypted. They sit beside the database volume, in the
same trust zone: whoever can read one volume can read the other. The columns
HealthLog encrypts stay encrypted inside the dump, under `ENCRYPTION_KEYS`.
Keep a copy of the dumps off the host; the off-host bucket does that for you,
and it seals each copy with `BACKUP_ENCRYPTION_KEY` in the envelope the
per-account copies use.

A dump holds every account that existed when it was taken, including one
deleted since. Deleted accounts leave the dumps as they age out: after
`DB_BACKUP_KEEP` nights on the server, and after your lifecycle rule in the
bucket. Give that rule a prefix that covers `database/` too; the admin
backups page reads the bucket's rules and says when none does. This is the
retention period to state where you tell people that deleting their account
deletes their data.

A dump is kept on the server only when `DB_BACKUP_DIR` survives the container
being replaced: a mounted volume or bind mount, or any writable directory when
HealthLog does not run in a container. The image creates the default
directory, so an install that runs it without the `backups` volume can write
there, but the directory sits in the container's own layer and the next update
throws it away. HealthLog reads the container's mount table to tell the two
apart and treats such a directory, or one on a tmpfs, like one it cannot
write: the nightly dump is uploaded off-host and nothing is kept on the
server, and no dump is taken before migrations; with no bucket either, no
dump is taken at all. The start log, the admin backups page and the recovery
readiness card say so.

The per-account copies (the weekly in-database copy, the nightly per-account
objects) roll one account back on the same server. They cannot rebuild a
server; see [`backup-restore.md`](backup-restore.md).

## The keys a restore needs

| Key                                                                 | Without it                                                                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEYS` + `ENCRYPTION_ACTIVE_KEY_ID`, or `ENCRYPTION_KEY` | Nothing encrypted can be read. The restore refuses when the active key is missing or different. Keep every retired id still in the map. |
| `API_TOKEN_HMAC_KEY`                                                | No data is lost, but every session, app token and share link stops working; people sign in again and re-create tokens.                  |
| `BACKUP_ENCRYPTION_KEY` (and `BACKUP_ENCRYPTION_PREVIOUS_KEYS`)     | Off-host copies do not open.                                                                                                            |
| `POSTGRES_PASSWORD`                                                 | Not needed: a new server can use a new one.                                                                                             |

The restore compares the keys in its environment with the fingerprints in the
manifest before it writes anything, and names each key that is missing or
different.

## Restore onto a new server

1. Install Docker and take the `docker-compose.yml` of the version that wrote
   the dump or a newer one. The manifest's `appVersion` names it; to run that
   exact version set `HEALTHLOG_IMAGE_REF=:v<version>` in `.env`.
2. Write `.env` with the keys from your records (see above) and a new
   `POSTGRES_PASSWORD`.
3. Do not run `docker compose up` yet. The app would create an empty schema,
   and the restore only writes into a database with no tables. Start only the
   database:

   ```bash
   docker compose up -d db
   ```

4. Restore. When the host is lost, its local dumps went with it, and the
   copy is the one in your bucket: put the `BACKUP_S3_*` variables and
   `BACKUP_ENCRYPTION_KEY` (with any `BACKUP_ENCRYPTION_PREVIOUS_KEYS`) in
   `.env` as on the old server, then

   ```bash
   docker compose run --rm db-restore list --from-bucket
   docker compose run --rm db-restore latest --from-bucket
   ```

   `latest --from-bucket` downloads the newest `database/…dump.enc` whose
   manifest is in the bucket too, opens both with `BACKUP_ENCRYPTION_KEY`
   and restores. Name a dump instead of `latest` to take an older one.

   With the files in hand instead (copied off the host, or downloaded from
   the bucket with your own tools: both `<name>.dump.enc` and
   `<name>.manifest.json.enc`, or a `.dump` with its `.manifest.json`), put
   them in a directory such as `./restore`, make them readable for the
   container (`chmod a+r restore/*`) and name the dump:

   ```bash
   docker compose run --rm -v "$PWD/restore:/restore:ro" db-restore list /restore
   docker compose run --rm -v "$PWD/restore:/restore:ro" db-restore \
     /restore/healthlog-20261024T233000Z-daily.dump
   ```

   Either way it checks the archive against the manifest's SHA-256, the keys
   against the manifest's fingerprints, and that the database is empty. Then
   it restores in one transaction, gathers planner statistics and counts
   every table against the manifest. A count that differs empties the
   database again and fails. Wait for the line that starts with `Restored`.

5. Start the stack and check it:

   ```bash
   docker compose up -d
   curl -s http://localhost:3000/api/health
   ```

   Sign in. The app's own key check runs at start and refuses to serve on a
   key that does not open the data.

When the dumps are still in the server's `backups` volume (the database
volume was lost, the backups volume was not), step 4 is
`docker compose run --rm db-restore latest`.

`--ignore-key-mismatch` restores although the active encryption key differs.
Use it only when that key is lost for good: everything encrypted stays
unreadable.

## Going back to before a migration

The entrypoint dumps the database before it applies migrations. To return to
that state (the previous image, the data as it was before the update):

```bash
docker compose stop app
# Keep the current state too, in case it is wanted later.
docker compose exec -T db pg_dump -U healthlog -Fc healthlog > healthlog-current.dump
docker compose exec db dropdb -U healthlog healthlog
docker compose exec db createdb -U healthlog healthlog
docker compose run --rm db-restore list
docker compose run --rm db-restore healthlog-<time>-pre-migration.dump
# Set HEALTHLOG_IMAGE_REF in .env to the version you ran before the update.
docker compose up -d
```

The dump before a migration is taken while the new image starts. If it fails
on a writable directory (a full disk, most often), the start stops before
anything is migrated and the log names the switch: `DB_BACKUP_BEFORE_MIGRATE=false`
starts without it, once.

## How this is tested

`scripts/compose-dr-drill.sh` plays this page against real containers: it
builds the image, seeds several accounts (the demo account with documents
and encrypted notes, a Guardian with a managed profile), lets the scheduled
job take the dump and upload it to an S3-compatible bucket, destroys every
volume of the stack (the local dumps included), and restores on a new stack
given only the bucket and the keys
(`docker compose run --rm db-restore latest --from-bucket`). A second run
restores from the dump files instead (`DRILL_SOURCE=local`). Both then count
every table against the manifest and boot the app: health, sign-in, an
encrypted note read back, a document opened, the Guardian still seeing the
profile. It runs in CI nightly and on every change to the
compose file, the image or the dump and restore code
(`.github/workflows/compose-dr-drill.yml`), and it is checked to fail on a
wrong encryption key, a wrong off-host key, a dump that lost a table's rows
and a target that is not empty.

Test your own copies too: once, and after any change to how the server is
run, restore last night's dump on a spare machine with the steps above.

## Settings

| Variable                   | Default                      | What it does                                                                     |
| -------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `DB_BACKUP_ENABLED`        | on                           | `false` stops the nightly dump.                                                  |
| `DB_BACKUP_DIR`            | `/var/lib/healthlog/backups` | Where dumps are written and read. Change it only together with the volume mount. |
| `DB_BACKUP_SCHEDULE`       | `30 1 * * *`                 | Five-field cron, Europe/Berlin time like every HealthLog schedule.               |
| `DB_BACKUP_KEEP`           | `7`                          | Nightly dumps kept (at least 1). Two pre-migration dumps are kept besides.       |
| `DB_BACKUP_BEFORE_MIGRATE` | on                           | `false` starts an update without the dump before its migrations.                 |
