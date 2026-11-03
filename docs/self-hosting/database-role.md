# The app's database role

The container connects to Postgres under two names. The user in
`DATABASE_URL` (on the bundled compose file, `healthlog`, which the official
Postgres image makes a superuser) owns the schema: the entrypoint uses it for
the dump before an update, the migrations, the job queue's own install and
migrations, and the restore. The app itself, web and worker, connects as a
role the entrypoint sets up for this database after the migrations on every
start. Nothing to configure: the first start of a release with this change
creates it.

The point is the blast radius of a bug. If a dependency of the app were ever
made to run code inside the container, the database connection it found would
be one that can read and write rows, not one that can drop tables, rewrite the
schema, plant code for the owner to run, or reach the server's files.

## Its name

`healthlog_app_<database>_<hash>`: the database's name, cut to letters,
digits and underscores, and eight hex digits of a hash of it. On the bundled
compose file that is `healthlog_app_healthlog_` and the hash. The start log
names it, and so does `pg_stat_activity`.

Postgres roles belong to the whole server, not to one database. One role per
database keeps two HealthLog instances on one server (production and staging
on a shared Postgres) apart: each has its own role and password, neither
locks the other out, and neither role has any grant in the other database. A
role that holds an explicit `CONNECT` grant on another database is not used
(the start says so). Postgres lets every role connect to a database whose
`CONNECT` is granted to `PUBLIC`, the default; the role finds nothing to read
there. To shut the door as well, revoke it on each HealthLog database:
`REVOKE CONNECT ON DATABASE <name> FROM PUBLIC;` (and grant it back to any
monitoring user that relied on it).

## What the role may and may not do

| May                                                                     | May not                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| read, insert, update and delete rows in every table of the app's schema | create, alter or drop tables, indexes, types or functions anywhere  |
| use and advance its sequences                                           | write `_prisma_migrations` (it may read it)                         |
| `VACUUM`, `ANALYZE` and `REINDEX` the `measurements` table (`MAINTAIN`) | create triggers or rules, own anything                              |
| read and write the job queue's rows in `pgboss`                         | write `pgboss.bam` or the version in `pgboss.version` (it may read) |
| create temporary tables                                                 | create roles, schemas or databases; become the owner (`SET ROLE`)   |
|                                                                         | act as a superuser: no `COPY … PROGRAM`, no `pg_read_file`          |

The start also takes `CREATE` on the app's schema away from `PUBLIC`, which
Postgres 15 and newer already do for a new database but a database first
created on an older major still allows.

## The job queue's schema

`pgboss` belongs to the owner. pg-boss changes its schema when it installs,
when it migrates (and in the index builds a migration leaves in
`pgboss.bam`), and for queues created with `partition: true`, which HealthLog
does not use. So the start installs and migrates the queue schema as the
owner, with pg-boss's own plans, before the app runs, and the worker starts
pg-boss with `migrate: false`: it only reads and writes rows, and refuses to
run on a schema that is not at its version rather than change it. A new queue
is a row.

The role may not write the two tables whose contents decide what runs as the
owner: `pgboss.bam` holds SQL that pg-boss's migration runner executes, and
the version in `pgboss.version` decides which migrations run. Owning nothing
in the schema, the role cannot plant a trigger, a rule or a function body
that a later session as the owner would run with the owner's rights: a
rollback to 1.46 (which runs as the owner throughout), `DB_APP_ROLE=off`, a
container that fell back to the owner, or the old container during a deploy.
For the same reason a container that falls back to the owner and one that
runs as the role can share the schema: the owner creates every object in it
either way, and the next start grants the role what is new.

Every start, on every path (the role, `DB_APP_ROLE=off`, a fallback), also
takes back anything in `pgboss` that a HealthLog-made role owns and drops any
trigger or rule there (pg-boss defines none). A pre-release build handed the
schema to a server-wide `healthlog_app` role; when the start finds that, it
also compares every queue function with pg-boss's own definition and puts
back the ones that differ, retires that role's grants in this database, and
drops it once no database refers to it. The log names each.

pg-boss rebuilds bloated queue indexes only on tables it owns; under the role
it reports them. The start rebuilds them as the owner, one at a time with a
five-second lock wait.

## The password

Derived from `API_TOKEN_HMAC_KEY` and the database's name, so a separate
worker container ([scaling.md](scaling.md)) arrives at the same one without a
new variable, and stored as a SCRAM hash. Rotating `API_TOKEN_HMAC_KEY` with a
web/worker split means restarting all containers together: the first one to
start sets the new password, and a container still on the old key cannot
open new connections until it restarts with the new one.

The owner's URL is replaced, not kept beside the role's, so it is not in the
app's environment. `docker compose exec app …` still starts with the
container's configured environment, so the operator scripts
(`reset-password.mjs` and the others) run as the owner as before.

Each start re-applies the grants, so a table the new migrations created is
covered before the app starts, and a restored database is put right on the
start after the restore.

## What the start log says

When it is in place:

```text
HealthLog: the app connects as healthlog_app_healthlog_1a2b3c4d: rows and the queue, no schema changes (DB_APP_ROLE=off turns this off)
```

When it is not, one notice names the reason, and the app runs as the
`DATABASE_URL` user, exactly as every earlier release did:

```text
HealthLog: notice: the app connects as healthlog, the user DATABASE_URL names, not as a restricted role: <reason>. …
```

The reasons:

- **The user may not create roles.** A managed database (RDS, Cloud SQL,
  Supabase and the like) or a database server where you gave HealthLog an
  account without `CREATEROLE`. Either leave it, or create the split yourself
  (below) and set `DB_APP_ROLE=off`.
- **Postgres older than 17.** The maintenance job's `VACUUM` and index rebuild
  need the `MAINTAIN` privilege, which Postgres 17 introduced; before it only
  the table's owner may run them. The bundled database is Postgres 18; see
  [postgres-major-upgrade.md](../ops/postgres-major-upgrade.md) for one you
  run yourself.
- **The role cannot log in.** A `pg_hba.conf` that lists users by name needs a
  line for the role beside the one for the owner.
- **The role holds `CONNECT` on another database.** Revoke it there.
- **A role of that name exists that HealthLog did not create** for this
  database. The start leaves a role it does not recognise alone.
- **The queue schema is newer than this image's pg-boss**, after going back
  to an older image: only the owner runs on it.
- **Setting it up failed**, most often a lock it waited 15 seconds for while
  another container held it. The next start tries again.

None of these stops the start.

## Turning it off

Set `DB_APP_ROLE=off` in `.env` and recreate the container. The app then
connects as the `DATABASE_URL` user. Use it when you manage database roles
yourself, including when `DATABASE_URL` already names a restricted role of
your own; then that role needs what the table above lists, and the
migrations and the queue's install need a user that owns the schema.

The role stays in the database when you turn it off and owns nothing. To
remove it, as the owner, with the name from the start log:

```sql
DROP OWNED BY healthlog_app_healthlog_1a2b3c4d;
DROP ROLE healthlog_app_healthlog_1a2b3c4d;
```

## Going back to 1.46

1.46 knows nothing of the role and runs as the owner, as it always did. The
queue schema is the owner's, so it finds nothing it did not create. The role
stays, unused, until you drop it as above.

## Index drops at start

`DROP INDEX` belongs to a table's owner; `MAINTAIN` does not include it. The
measurement maintenance therefore no longer drops a retired index or the
invalid copy a failed rebuild leaves; it names them on its run and the next
start drops them as the owner, waiting at most five seconds for each
([measurement-maintenance.md](../ops/measurement-maintenance.md)).

## Dumps and restores

The nightly dump runs as the role and reads everything through its grants. A
dump carries those grants; `db-restore` leaves them and the ownership out
(`--no-owner --no-privileges`), restores as the owner, and the next start
grants again. A restore of your own with `pg_restore` should do the same, or
it fails on a database without the role.
