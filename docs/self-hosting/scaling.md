# Scaling: web/worker container split

The default `docker compose up` launches a single container that runs
both the Next.js HTTP server AND the pg-boss worker. That works fine
for a personal deployment but is hard to scale horizontally because
every replica also runs the full reminder/insight cron schedule.

v1.4 introduces an environment-variable gate so the same image can be
deployed in three modes:

| `HEALTHLOG_PROCESS_TYPE` | Web | Worker | Use when                  |
| ------------------------ | --- | ------ | ------------------------- |
| `all` (default)          | ✅  | ✅     | single-host self-hosting  |
| `web`                    | ✅  | ❌     | scaling HTTP horizontally |
| `worker`                 | ❌  | ✅     | dedicated job worker      |

## How to split

1. Edit `docker-compose.yml`: set `HEALTHLOG_PROCESS_TYPE=web` on the
   `app` service and uncomment the `app-worker` service block at the
   bottom (it ships with `HEALTHLOG_PROCESS_TYPE=worker` baked in).
2. Make sure both containers see the same `DATABASE_URL`,
   `ENCRYPTION_KEY` (or `ENCRYPTION_KEYS`), and `API_TOKEN_HMAC_KEY`.
3. `docker compose up -d --build`.

Both containers connect to the same Postgres. pg-boss claims jobs
atomically via row-level locking (`FOR UPDATE SKIP LOCKED`), so
running multiple worker replicas is **safe** — no job runs twice —
but it doubles the DB load and muddies telemetry without adding
throughput a personal instance needs (`src/lib/process-type.ts`).
Run **one** worker container and scale the `web` containers instead.

## Apple Health import staging (shared volume required for a split)

The Apple Health `export.zip` import streams the upload to a staging
file on local disk (under the container's temp dir) and hands the
worker only the file **path**. In single-container mode
(`HEALTHLOG_PROCESS_TYPE=all`, the default) the web handler and the
worker share the same filesystem, so the handoff just works.

In a web/worker split — or any topology where the container that
accepts the upload is not the one that runs the job (a `web` +
`worker` split, extra `all` replicas, or old+new containers coexisting
during a rolling deploy) — the worker cannot see the web container's
staging file. The import then fails with a staging-file-missing error
("the import staging file is not visible to the worker"). Two things to
know:

- A pure `web` container opens a send-only pg-boss connection at boot
  (`src/instrumentation.ts`, `startGlobalBossProducer`), so an import
  kicked off there is accepted and queued for the worker like any other
  job. It answers `503 Background worker is not running` only when that
  producer connection could not be opened (the boot log then shows
  `Failed to start pg-boss producer`).
- If you run web and worker as separate containers, they **must share
  the import staging directory** — mount the same named volume at the
  temp path on both — or run imports in single-container (`all`) mode.
  Without a shared staging volume, imports in split mode cannot
  complete.

## Apple Health import memory

The import parses `export.xml` as a stream: the archive is never
buffered whole, records flush to the database in fixed-size batches,
and what stays resident scales with the data's calendar span, not its
record count. Multi-year exports with millions of records parse within
the default Node.js heap.

Before parsing starts, the worker compares the archive's declared
uncompressed size against the runtime heap limit. If the limit is too
low to carry the export — realistically only when
`--max-old-space-size` was pinned far below the default — the import
fails immediately with a `failureReason` starting with
`insufficient_memory`, naming the required and available amounts.
Raise the limit on the container that runs the worker and re-upload:

```yaml
# docker-compose.yml
services:
  app:
    environment:
      NODE_OPTIONS: --max-old-space-size=1024
```

An import interrupted by a container restart or an out-of-memory kill
does not stay stuck: the worker reconciles non-terminal import jobs at
boot and every 15 minutes, flipping orphaned rows to `failed`
(`interrupted_by_restart`) so the UI offers a retry instead of an
endless spinner.

## Document and lab-scan reads run on the worker (v1.40)

Since v1.40, every AI read of a document or a lab report runs as a
background job on the worker, not inside the HTTP request:

- reading a document for search (the content index),
- a document summary, stored or shown once,
- filing suggestions (title, type, date),
- extracting facts from a stored document for review,
- a lab scan (photo or PDF of a lab report).

The request only queues the read and answers `202`; the client then
polls the run until it ends. That is what keeps a
slow model from being cut off by a proxy timeout in front of the
server. When the enqueue itself fails (no pg-boss connection at all),
the request answers `503` straight away, and nothing is charged.

**"Waiting for the background worker"** is the line the app shows when
a read has sat in the queue for more than 30 seconds without a worker
picking it up. On a single `all` container that is rare and short
(the worker is busy with another job). If it does not go away, no
worker process is consuming the queue: the worker container is
stopped, crashing on boot, or pointed at another database. A run that
no worker picks up within 15 minutes fails as
`aiRuns.workerUnavailable` and its AI budget reservation is handed
back. That sweep is itself a worker job, so with no worker running at
all the run simply stays queued until one starts.

**In a web/worker split, the worker must run the same version as the
web containers.** The web container queues the read; only a worker
that knows the `document-ai-run` queue can execute it. A worker left
on a pre-v1.40 image never takes these jobs, so every document read
and lab scan waits and then fails as above, while everything else
looks healthy. Deploy both from the same image tag
(`HEALTHLOG_IMAGE_REF` is shared by `app` and the `app-worker` block)
and restart the worker together with the web containers.

## Healthchecks

- `app` (web) healthcheck: `wget /api/health` every 30s.
- `app-worker` does not expose a port; its liveness is tracked
  in-memory inside the process (`src/lib/jobs/worker-status.ts`) and
  read back by `/api/admin/status`. In a web/worker split this means
  the web container cannot see the separate worker container's
  liveness: `/api/admin/status` only reports the worker embedded in
  the container that serves the request. Watch the worker container's
  own logs and restart policy instead.

The web container does NOT depend on the worker, and vice versa, so
neither container's startup can deadlock the other. The shared
dependency is Postgres; both wait on `db: condition: service_healthy`.

## Caveats

- Background tasks that touch user-scoped Wide Events (e.g. reminder
  notifications) emit telemetry from the worker; configure `LOKI_*`
  env vars on the worker if you want them.
- The off-host backup job runs in the worker only. The admin
  `POST /api/admin/backup/test` endpoint runs in the web container and
  exercises the same S3 credentials — set `BACKUP_*` env vars on BOTH.
- The startup gate (`assertSubsystemEnabled`) refuses to boot the
  reminder worker when `HEALTHLOG_PROCESS_TYPE=web`, so an accidental
  cross-mode invocation aborts immediately instead of silently doubling
  cron load.

## Postgres connection-pool sizing

Every container that boots the HealthLog image owns a connection
budget against the configured `DATABASE_URL`. The budget is
**20 connections per container by default** and is split between the
Prisma pool and pg-boss (2 connections). The bundled compose exposes
the knob as `DB_CONNECTION_LIMIT`, baked into `DATABASE_URL` as
`connection_limit`; `DATABASE_POOL_MAX` remains a working explicit
override. Resolution order: `DB_CONNECTION_LIMIT`, then
`DATABASE_POOL_MAX`, then the `connection_limit` URL parameter, then
the default of 20. In the bundled single-container setup
(`HEALTHLOG_PROCESS_TYPE=all`) the web requests and the background
worker run in one process and share that one Prisma pool, so a budget
sized for the web traffic alone leaves the worker's jobs queueing for
the same connections.

Plan total Postgres slots as **container_count × budget**.
A stock Postgres 16 container ships with `max_connections = 100`, so
the safe envelope is:

| Web replicas | Worker replicas | Total containers | Pool slots used | Headroom under 100 |
| ------------ | --------------- | ---------------- | --------------- | ------------------ |
| 1            | 0               | 1                | 20              | 80                 |
| 1            | 1               | 2                | 40              | 60                 |
| 2            | 1               | 3                | 60              | 40                 |
| 3            | 1               | 4                | 80              | 20                 |
| 4            | 1               | 5                | 100             | 0 (do not exceed)  |

Once the table tips into the "0 headroom" row, every other client of
the same Postgres — `psql` sessions, ad-hoc backups, the Prisma CLI
during a migration deploy — will get `FATAL: sorry, too many clients
already`. Either raise `max_connections` on the Postgres side, lower
`DATABASE_POOL_MAX`, or front the database with PgBouncer in
transaction-pooling mode.

The app sets its statement timeout and `work_mem` on every connection
through the libpq `options` startup parameter. PgBouncer refuses that
parameter (`unsupported startup parameter: options`) unless it is listed
in `ignore_startup_parameters`. Either list it there, or set
`DATABASE_SESSION_OPTIONS_DISABLED=1` so the app sends no session
settings; set the timeout and `work_mem` on the database role instead
(`ALTER ROLE healthlog SET work_mem = '16MB'`) if you still want them.
The measurement maintenance job (Admin, System status) then applies its own
settings with `SET` after connecting. Its concurrent index rebuild needs a
session, so run it through a session-mode pool or a direct connection.

### Overriding the per-container pool ceiling

With the bundled compose, set `DB_CONNECTION_LIMIT` in `.env`; it
flows into `DATABASE_URL`'s `connection_limit`. On a hand-rolled
setup, `DATABASE_POOL_MAX` as a plain env var works the same way on
every container, web and worker alike:

```yaml
# docker-compose.yml — example for a 6-container deployment
services:
  app:
    image: ghcr.io/mbombeck/healthlog:latest
    environment:
      DATABASE_POOL_MAX: "12" # 6 containers × 12 = 72 < 100
      HEALTHLOG_PROCESS_TYPE: web
```

Rules of thumb:

- Each web replica's hottest path (`/api/analytics` fan-out, capped at
  `p-limit(4)`) consumes 4 concurrent slots. Keep
  `DATABASE_POOL_MAX ≥ 8` so a single power-user request never
  exhausts the pool of one container.
- Worker replicas mostly use 1 connection per active pg-boss job;
  `DATABASE_POOL_MAX = 8` is plenty unless you raised the pg-boss
  `teamConcurrency`.
- If you raise Postgres `max_connections` past 100, prefer raising
  `DATABASE_POOL_MAX` over adding more containers — fewer, fatter
  Node processes amortise the V8 footprint better than many thin
  ones.

### Why the default is 20

The v1.4.39 empirical cold-mount trace showed thick `/api/analytics`
holding ≥ 8 of the 10 default pool slots for 6.5 s on a 347 k-row
tenant, starving every other dashboard query for the duration. The
20-slot default — paired with the `p-limit(4)` cap on the analytics
fan-out — keeps 16 slots free for the rest of the dashboard while
still sitting well under Postgres's 100-slot stock ceiling.

The implementation lives in `src/lib/db.ts → getConnectionBudget()`
(split into `getPrismaPoolMax()` and `getPgBossPoolMax()`); the
20-slot default was chosen after measuring on a 4-CPU production
container — see the inline rationale in `src/lib/db.ts`.
