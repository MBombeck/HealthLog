# Moving the database to a newer Postgres major

The compose file ships Postgres 16 and stays there for now, because a major
version change is the one database update that cannot happen by itself on
`docker compose pull`. HealthLog runs on Postgres 18 as well: the full
integration suite runs against 18 (`INTEGRATION_PG_IMAGE=postgres:18-alpine
pnpm test:integration`), and the TrueNAS app starts new installs on 18.

## Why changing the image line is not enough

Minor releases (16.14 to 16.15) share the on-disk format. Majors do not, and
the official image refuses to start a data directory written by an older
major. From 18 on, the image also keeps its data one level deeper, under
`/var/lib/postgresql/18/docker`, and expects the volume mounted at
`/var/lib/postgresql` instead of `/var/lib/postgresql/data`. With the old
volume and only the image line changed, the `db` container exits at once with
"there appears to be PostgreSQL data in: /var/lib/postgresql/data". Nothing is
lost, but the stack stays down until the image line goes back to 16.

So the move is a dump from 16 and a restore into a fresh 18 volume.

## Steps

Take the encryption key's copy out of its safe place first: the dump is
unreadable without it, and this is the moment you would find out.

```bash
# 1. Stop the app so nothing writes while the dump runs. If you run the
#    worker role in its own container, stop it too: docker compose stop app app-worker
docker compose stop app

# 2. Dump the database in Postgres' custom format.
docker compose exec -T db pg_dump -U healthlog -Fc healthlog \
  > healthlog-pg16-$(date +%F).dump

# 3. Stop the old database. Its volume stays untouched.
docker compose stop db
```

4. In `docker-compose.yml`, change the `db` service:

   ```yaml
   image: postgres:18.6-alpine # or the current 18 minor
   volumes:
     - pgdata18:/var/lib/postgresql
   ```

   and add the new volume next to `pgdata` in the top-level `volumes:` block:

   ```yaml
   volumes:
     pgdata:
     pgdata18:
   ```

```bash
# 5. Start the new database and wait until it reports healthy.
docker compose up -d db
docker compose ps db

# 6. Restore the dump into it.
docker compose exec -T db pg_restore -U healthlog -d healthlog --no-owner \
  < healthlog-pg16-<date>.dump

# 7. Start the app (and app-worker, if you run it) and confirm it.
docker compose up -d app
curl -s http://localhost:3000/api/version
```

The start log should say there are no pending migrations: the dump carried the
migration history with it. Sign in and open a few pages before you go on.

## Afterwards

Keep the old `pgdata` volume and the dump until the new database has run for a
few days. Going back means restoring the old `image:` and `volumes:` lines;
the old volume still holds the database as it was before step 2. When you are
sure, remove it (`docker volume ls` shows its full name, prefixed with the
compose project):

```bash
docker volume rm <project>_pgdata
```

If you had run `CREATE EXTENSION pg_stat_statements;` for
[query statistics](query-statistics.md), the dump carries it and the compose
`command:` still loads the library, so nothing needs doing there.

`pg_upgrade --link` is faster on a very large database, but it needs both
majors' binaries in one container; for a personal health record the dump is
seconds to minutes and has nothing to set up.
