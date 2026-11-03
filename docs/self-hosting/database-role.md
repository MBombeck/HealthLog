# The app's database role

The container connects to Postgres under two names. The user in
`DATABASE_URL` (on the bundled compose file, `healthlog`, which the official
Postgres image makes a superuser) owns the schema: the entrypoint uses it for
the dump before an update, the migrations and the restore. The app itself,
web and worker, connects as `healthlog_app`, a role the entrypoint sets up
after the migrations on every start. Nothing to configure: the first start of
a release with this change creates it.

The point is the blast radius of a bug. If a dependency of the app were ever
made to run code inside the container, the database connection it found would
be one that can read and write rows, not one that can drop tables, rewrite the
schema or reach the server's files.

## What the role may and may not do

| May                                                                       | May not                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| read, insert, update and delete rows in every table of the app's schema   | create, alter or drop tables, indexes, types or functions there |
| use and advance its sequences                                             | write `_prisma_migrations` (it may read it)                     |
| `VACUUM`, `ANALYZE` and `REINDEX` the `measurements` table (`MAINTAIN`)   | create roles, schemas or databases                              |
| own the `pgboss` schema, where the job queue keeps and changes its tables | act as a superuser: no `COPY … PROGRAM`, no `pg_read_file`      |
| create temporary tables                                                   | become the owner (`SET ROLE`)                                   |

The queue schema is the role's because pg-boss creates and migrates its own
tables, functions and per-queue partitions while the app runs. Nothing of the
app's data lives there. The start also takes `CREATE` on the app's schema
away from `PUBLIC`, which Postgres 15 and newer already do for a new database
but a database first created on an older major still allows.

Its password is derived from `API_TOKEN_HMAC_KEY`, so a separate worker
container ([scaling.md](scaling.md)) arrives at the same one without a new
variable, and it is stored as a SCRAM hash. The owner's URL is replaced, not
kept beside the role's, so it is not in the app's environment.
`docker compose exec app …` still starts with the container's configured
environment, so the operator scripts (`reset-password.mjs` and the others)
run as the owner as before.

Each start re-applies the grants, so a table the new migrations created is
covered before the app starts, and a restored database is put right on the
start after the restore.

## What the start log says

When it is in place:

```text
HealthLog: the app connects as healthlog_app: rows and the queue, no schema changes (DB_APP_ROLE=off turns this off)
```

When it is not, one notice names the reason, and the app runs as the
`DATABASE_URL` user, exactly as every earlier release did:

```text
HealthLog: notice: the app connects as healthlog, the user DATABASE_URL names, not as the restricted role healthlog_app: <reason>. …
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
  line for `healthlog_app` beside the one for the owner.
- **A role named `healthlog_app` exists that HealthLog did not create.** The
  start leaves a role it does not recognise alone.
- **Setting it up failed**, most often a lock it waited 15 seconds for: the
  first start hands the existing queue tables to the role, and another
  container still using them holds it up. The next start tries again.

None of these stops the start.

## Turning it off

Set `DB_APP_ROLE=off` in `.env` and recreate the container. The app then
connects as the `DATABASE_URL` user. Use it when you manage database roles
yourself, including when `DATABASE_URL` already names a restricted role of
your own; then that role needs what the table above lists, and the
migrations need a user that owns the schema.

The role stays in the database when you turn it off and does no harm. To
remove it, as the owner:

```sql
REASSIGN OWNED BY healthlog_app TO healthlog;
DROP OWNED BY healthlog_app;
DROP ROLE healthlog_app;
```

## Index drops at start

`DROP INDEX` belongs to a table's owner; `MAINTAIN` does not include it. The
measurement maintenance therefore no longer drops a retired index or the
invalid copy a failed rebuild leaves; it names them on its run and the next
start drops them as the owner, waiting at most five seconds for each
([measurement-maintenance.md](../ops/measurement-maintenance.md)).

## Dumps and restores

The nightly dump runs as the role and reads everything: the app's schema
through its grants, the queue schema as its owner. A dump carries the grants
to `healthlog_app`; `db-restore` leaves them and the ownership out
(`--no-owner --no-privileges`), restores as the owner, and the next start
grants again. A restore of your own with `pg_restore` should do the same, or
it fails on a database without the role.
