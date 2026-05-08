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
   `ENCRYPTION_KEY` (or `ENCRYPTION_KEYS`), `API_TOKEN_HMAC_KEY`,
   and `SESSION_SECRET`.
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
