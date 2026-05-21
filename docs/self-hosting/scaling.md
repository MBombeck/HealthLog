# Scaling: web/worker container split (v1.4 G3)

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
atomically via row-level locking, so it is safe to run multiple worker
replicas — they will share the load.

## Healthchecks

- `app` (web) healthcheck: `wget /api/version` every 30s.
- `app-worker` does not expose a port; its liveness is reported into
  the `worker_status` table on every reminder pass and surfaced through
  `/api/admin/worker-status`.

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

## Postgres connection-pool sizing (v1.4.40 W-POOL)

Every container that boots the HealthLog image opens its own
`pg.Pool` against the configured `DATABASE_URL`. The pool ceiling is
**20 connections per container by default** (raised from the library
default of 10 in v1.4.40 to keep the dashboard's analytics fan-out
from starving every other query during a cold mount).

Plan total Postgres slots as **container_count × `DATABASE_POOL_MAX`**.
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

### Overriding the per-container pool ceiling

Set `DATABASE_POOL_MAX` to a positive integer on every container that
needs a non-default ceiling — both web and worker pick up the same
env var:

```yaml
# docker-compose.yml — example for a 6-container deployment
services:
  app:
    image: ghcr.io/mbombeck/healthlog:latest
    environment:
      DATABASE_POOL_MAX: "12"     # 6 containers × 12 = 72 < 100
      HEALTHLOG_PROCESS_TYPE: web
```

Rules of thumb:

- Each web replica's hottest path (`/api/analytics` fan-out, capped at
  `p-limit(4)` per v1.4.40 W-POOL) consumes 4 concurrent slots. Keep
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

The implementation lives in `src/lib/db.ts → getPoolMax()`; the
rationale and the audit trail live in
`.planning/round-v1439-empirical-trace.md § B2` and the v1.4.40
W-POOL phase report.
