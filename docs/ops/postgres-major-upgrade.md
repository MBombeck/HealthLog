# Moving the database to a newer Postgres major

From v1.46 the compose file runs Postgres 18. Installs from v1.45 or earlier
ran 16, and a major version cannot open the data directory of an older one,
so the compose file carries a one-time step that moves the database across
on the first start after the update. Nothing needs doing by hand on a stack
that runs the project's `docker-compose.yml`.

Installs that bring their own Postgres (Unraid, an existing database server)
are not touched: HealthLog runs on 16 and 18 alike, and the move there is
yours to schedule with the steps under [By hand](#by-hand).

## What happens on the first start

`db-upgrade` is a short-lived container next to `db`. It starts after the new
Postgres 18 database is up and before the app, and it exits in a second when
there is nothing to move. When the old `pgdata` volume holds a Postgres 16
database and the new one is empty, it:

1. checks there is room on the disk for a second copy;
2. starts Postgres 16 inside its own container on the old volume, reachable
   only from inside that container;
3. streams a dump into Postgres 18 in a single transaction;
4. compares the row count of every table between the two;
5. gathers the planner statistics, which a restore does not carry;
6. stops Postgres 16 and leaves a marker file on the old volume.

The app starts once that succeeded, applies the release's migrations and
serves as before. On a typical personal record the whole move takes seconds;
a database of a few gigabytes takes a few minutes. Watch it with
`docker compose logs -f db-upgrade`.

If any step fails, the new database stays empty, the app does not start, and
the log says what happened. A move cut short by a restart or a full disk is
run again from scratch on the next `docker compose up -d`.

The old `pgdata` volume is read and never changed, apart from the marker
file. That is the way back.

## Going back

Stop the stack, put the two lines of the `db` service back the way v1.45 had
them, and start it with the v1.45 image:

```yaml
db:
  image: postgres:16.15-alpine
  volumes:
    - pgdata:/var/lib/postgresql/data
```

```bash
docker compose down
HEALTHLOG_IMAGE_REF=:v1.45.0 docker compose up -d
```

Anything written after the move lives only in the Postgres 18 volume.

## Afterwards

Keep the old volume until the new database has run for a while. When you are
sure, remove it (`docker volume ls` shows its full name, prefixed with the
compose project):

```bash
docker volume rm <project>_pgdata
```

`db-upgrade` then finds nothing to move. A later release drops the service
and the `pgdata` line.

## Starting over

When the move has run and the Postgres 18 volume is empty again (deleted by
hand, say), `db-upgrade` refuses to import the old state a second time, since
that would quietly bring back the database as it was on the day of the move.
To do exactly that on purpose, remove the marker and start again:

```bash
docker compose run --rm --entrypoint rm db-upgrade \
  /var/lib/postgresql/data/HEALTHLOG_MOVED_TO_POSTGRES_18
docker compose up -d
```

## By hand

For a Postgres you run yourself, or a compose file you have changed so much
that the step does not fit, the move is a dump and a restore. Take the
encryption key's copy out of its safe place first: the dump is unreadable
without it, and this is the moment you would find out.

```bash
# 1. Stop the app so nothing writes while the dump runs (and app-worker, if
#    you run the worker role in its own container).
docker compose stop app

# 2. Dump the database in Postgres' custom format.
docker compose exec -T db pg_dump -U healthlog -Fc healthlog \
  > healthlog-pg16-$(date +%F).dump

# 3. Stop the old database. Its volume stays untouched.
docker compose stop db
```

4. Point the `db` service at Postgres 18 and a fresh volume. From 18 on, the
   image keeps its data under `/var/lib/postgresql/18/docker` and expects the
   volume mounted one level up, at `/var/lib/postgresql`; mounted at
   `.../data` it refuses to start with "there appears to be PostgreSQL data
   in: /var/lib/postgresql/data".

```bash
# 5. Start the new database and restore the dump into it.
docker compose up -d db
docker compose exec -T db pg_restore -U healthlog -d healthlog --no-owner \
  < healthlog-pg16-<date>.dump

# 6. Gather the planner statistics. A restore brings the rows but not the
#    statistics, and until autovacuum gets round to every table the planner
#    guesses at their sizes, which can turn a sub-second page into one that
#    takes many seconds.
docker compose exec -T db vacuumdb -U healthlog -d healthlog --analyze-in-stages

# 7. Start the app and confirm it.
docker compose up -d app
curl -s http://localhost:3000/api/version
```

The start log should say there are no pending migrations beyond the release's
own: the dump carried the migration history with it.

If you had run `CREATE EXTENSION pg_stat_statements;` for
[query statistics](query-statistics.md), the dump carries it and the compose
`command:` still loads the library, so nothing needs doing there.

`pg_upgrade --link` is faster on a very large database, but it needs both
majors' binaries in one container; for a personal health record the dump is
seconds to minutes and has nothing to set up.
