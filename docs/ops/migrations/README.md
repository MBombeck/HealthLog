# How a migration runs

Every boot runs `prisma migrate deploy` through `scripts/migrate-deploy.mjs`
before the server starts. This page is for anyone writing a migration under
`prisma/migrations/`, and for an operator reading a failed boot.

## One file, one of two ways

Prisma sends a migration file to Postgres one of two ways, and which one
depends on what the file contains:

- **A file with a dollar-quoted body anywhere** (a `DO $m$ … $m$` block, a
  function) is sent as one query. Postgres runs that as one implicit
  transaction: the file applies whole or not at all, and every lock any of its
  statements takes is held until the last statement has run.
- **A file without one** is split and sent statement by statement, each
  committing on its own. A failure leaves the statements before it applied,
  and a top-level `SET LOCAL` has no transaction to be local to.

`tests/integration/migration-file-transaction.test.ts` proves both against the
real CLI. The repository's migrations almost all use `DO` blocks, so almost all
of them are the first kind.

## Rules that follow

`src/__tests__/migration-lock-timeout-guard.test.ts` enforces these.

- **Bound the lock wait** inside a `DO` block with
  `PERFORM set_config('lock_timeout', '10s', true);`. Without a bound, an
  `ALTER TABLE` queues behind the longest open transaction on the table, and
  every write to the table queues behind the `ALTER`.
- **Mark the file `-- @retry-on-lock-timeout`** when it bounds its lock wait.
  The boot then retries a lock timeout or a deadlock (55P03, 40P01) up to five
  times. A one-transaction file is safe to retry by construction; a file split
  by statement may carry the marker only when every statement is harmless to
  run twice.
- **A `CONCURRENTLY` statement stands alone in its file.** It refuses to run
  inside a transaction (SQLSTATE 25001). Such a file needs no marker: a failed
  build leaves only an INVALID index, which the boot drops before the attempt
  that builds it again.
- **Long work stands apart from table locks** (from 0517 on). A constraint
  `VALIDATE`, a backfill on a large table, or a plain index build on one runs
  in a file that takes no other table lock, and bounds its run time with
  `SET LOCAL statement_timeout = '…';` as a statement of its own, before the
  block that does the work. Postgres arms the timeout when a statement starts,
  so `set_config('statement_timeout', …, true)` inside the block bounds only
  the statements after that block, never the block itself; the integration
  test above proves both through the real CLI. The top-level `SET LOCAL` holds
  because the file is one transaction, and ends with it. `lock_timeout` is
  different: it is read when a lock wait begins, so setting it inside the
  block works. `lock_timeout` only bounds the wait for a lock, never the time
  spent holding it. Adding a constraint
  `NOT VALID` and validating it in the same file buys nothing, because the
  scan then runs while the `ADD` still holds ACCESS EXCLUSIVE on the table. The
  pattern is three files: the column and the `NOT VALID` constraint; the
  backfill in batches (or a job); the `VALIDATE` alone.
- **Never `DROP INDEX CONCURRENTLY` at boot.** It waits without bound for every
  transaction on the table. Retire an index with a bounded `DROP INDEX` that
  tolerates the timeout, as 0416 does.

## Schema and migrations agree

`prisma/schema.prisma` must describe what the migrations build.
`tests/integration/prisma-schema-migration-drift.test.ts` migrates a fresh
database and asks `prisma migrate diff` for the difference to the schema; it
fails on any statement outside a short list of objects Prisma cannot express
(expression indexes, for one). Without it, `prisma migrate dev` writes the
drift into the next generated migration, and a contributor who does not prune
it by hand drops an index or converts a column.

When you add something Prisma cannot model, such as a partial or expression
index, a trigger, or a `CHECK`, write it in the migration, name it in a
comment on the model, and, only if `migrate diff` reports it, add it to the
test's allowlist with the reason.
