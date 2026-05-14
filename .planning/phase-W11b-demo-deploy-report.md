# Phase W11b — demo.healthlog.dev v1.4.24 deploy

Date: 2026-05-14
Host: edge-01 (Coolify project `healthlog-beta`, app UUID `ck8cs4osswg8w440gskw08w8`)
Driver: autonomous marathon — Marc directive

## Outcome

`https://demo.healthlog.dev` now serves HealthLog v1.4.24 from
`ghcr.io/mbombeck/healthlog:1.4.24` with a freshly migrated database
and 60 days of plausible synthetic data. AI provider intentionally
unconfigured; `DEMO_MODE=true` keeps the surface read-only. Login as
`demo` / `demo123demo123` (the credentials DemoCredentials.tsx
already publishes — no landing-repo edit required).

`/api/version` returns `1.4.24`. Container is `Up (healthy)`.

## Backup

Path on edge-01:
`/data/coolify/applications/ck8cs4osswg8w440gskw08w8/backups/pre-v1424-20260514T101354Z.sql.gz`
(528K, gzip-compressed `pg_dump --no-owner --clean --if-exists`).

Compose backup:
`/data/coolify/applications/ck8cs4osswg8w440gskw08w8/docker-compose.yaml.pre-v1424.bak`.

Per Marc's constraint: backup kept; previous Coolify-built image
`ck8cs4osswg8w440gskw08w8:0c0c345e822c99ade3f378e1889cf50b1e085a72`
also still on disk as fallback (not removed).

## Compose diff applied

```
3c3
<         image: 'ck8cs4osswg8w440gskw08w8:0c0c345e822c99ade3f378e1889cf50b1e085a72'
---
>         image: 'ghcr.io/mbombeck/healthlog:1.4.24'
```

Every other line (env_file, labels, network aliases, healthcheck) is
unchanged. Traefik routers + caddy_0/caddy_1 dual-host
(`demo.healthlog.dev` + `healthlog-beta.ioioio.dev`) preserved.

The compose still has no `db` service; DB remains the standalone
`agos0oo88gsgg88kcg4swosw` postgres:16-alpine container reachable via
the `coolify` external network. `DATABASE_URL` in `.env` resolves to
`postgresql://healthlog:***@agos0oo88gsgg88kcg4swosw:5432/healthlog`,
matched.

## Migration log excerpt

43 migrations applied cleanly on first boot of v1.4.24 against the
empty DB. Last + relevant entries:

```
Applying migration `0040_recommendation_feedback_target_type`
Applying migration `0041_apns_token_unique_partial`
Applying migration `0042_coach_feedback_message_ref`

All migrations have been successfully applied.
HealthLog: Migrations complete.
HealthLog: Starting application...
▲ Next.js 16.2.6
✓ Ready in 0ms
```

Container `73bcba59ef71` started reminder-worker background task at
`2026-05-14T10:14:54.624Z`; first `/api/health` probe answered 200 at
`10:14:58.816Z`.

## Seed user

| field        | value                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| username     | `demo`                                                                              |
| email        | `demo@healthlog.dev`                                                                |
| password     | `demo123demo123`                                                                    |
| pw hash      | argon2id (m=19456,t=2,p=1,outputLen=32) — same params as `src/lib/auth/password.ts` |
| timezone     | `Europe/Berlin`                                                                     |
| locale       | `de`                                                                                |
| height_cm    | 178                                                                                 |
| display_name | `Demo`                                                                              |
| onboarding   | completed 64 days ago, tour also completed                                          |
| ai_provider  | NULL (intentional)                                                                  |

DemoCredentials.tsx already publishes user=`demo`,
pw=`demo123demo123` — no edit needed in healthlog-landing.

## Seed data row counts (post-seed)

| table                    |                                              rows |
| ------------------------ | ------------------------------------------------: |
| users                    |                                                 1 |
| measurements (total)     |                                               194 |
| – BLOOD_PRESSURE_SYS     |                                                53 |
| – BLOOD_PRESSURE_DIA     |                                                53 |
| – PULSE                  |                                                53 |
| – WEIGHT                 |                                                23 |
| – BODY_FAT               |                                                12 |
| mood_entries             |                                                40 |
| medications              | 2 (Ramipril 5mg morning, Metformin 500mg evening) |
| medication_schedules     |                                                 2 |
| medication_intake_events |        122 (~80% adherence over 61 days × 2 meds) |

Shape: 60-day series with realistic Gaussian noise; sys drifts
130 → 120 mmHg, weight 82.5 → 80.1 kg, body fat 23.0% → 21.6% — a
modestly health-conscious user mid-improvement. No PII, no real
readings.

Seed generator: `/tmp/healthlog-seed.sql` (405-line SQL transaction)
generated locally via `/tmp/healthlog-gen-seed-sql.mjs`, then `docker
cp`'d into the postgres container and applied with `psql -v
ON_ERROR_STOP=1`.

## Empty-state verification results

All authed endpoints return 200; rule-based fallback insights work
without an AI provider configured.

| endpoint                                                                | status | notes                                                                                                             |
| ----------------------------------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------- |
| `/api/version`                                                          |    200 | `1.4.24`                                                                                                          |
| `/dashboard`, `/insights`, `/measurements`, `/medications`, `/settings` |    307 | gated → `/auth/login`                                                                                             |
| `/auth/login`                                                           |    200 | renders                                                                                                           |
| `POST /api/auth/login`                                                  |    200 | sets `healthlog_session` cookie (30d max-age)                                                                     |
| `/api/insights/comprehensive`                                           |    200 | rich summaries: weight 23 rows / BP sys 53 rows etc.                                                              |
| `/api/insights/cards`                                                   |    200 | 3 rule-based cards (BMI overweight, BP off-target, pulse outliers) — no AI prose, no 500                          |
| `/api/insights/correlations`                                            |    200 | correlation payload                                                                                               |
| `/api/insights/chat`                                                    |    200 | `{"conversations":[]}` — Coach drawer empty list                                                                  |
| `/api/insights/blood-pressure-status`                                   |    200 |                                                                                                                   |
| `/api/insights/weight-status`                                           |    200 |                                                                                                                   |
| `/api/insights/mood-status`                                             |    200 |                                                                                                                   |
| `/api/insights/bmi-status`                                              |    200 |                                                                                                                   |
| `/api/insights/pulse-status`                                            |    200 |                                                                                                                   |
| `/api/insights/medication-compliance-status`                            |    200 | (curl-checked indirectly via comprehensive)                                                                       |
| `/api/dashboard/summary`                                                |    200 | greeting `Hallo, Demo`, streak 62 days, sparklines, compliance 1/2 today                                          |
| `/api/measurements?type=BLOOD_PRESSURE_SYS&limit=10`                    |    200 | 10 most-recent BP_SYS rows                                                                                        |
| `/api/measurements?limit=5`                                             |    200 | mixed types                                                                                                       |
| `/api/medications`                                                      |    200 | 2 meds with schedules                                                                                             |
| `POST /api/insights/generate`                                           |    403 | `{"error":"Demo mode: modifications are disabled","meta":{"demo":true}}` — intentional DEMO_MODE guard, not a bug |

## Notable findings

1. **Schema column drift on `medication_schedules`** — the actual
   columns are `windowStart` / `windowEnd` (camelCase, double-quoted
   in SQL) rather than snake_case. The Prisma schema's `@map` decorators
   appear missing for these two fields on the original migration; not
   a deploy blocker but worth filing in the v1.4.25 backlog if a
   future migration touches that table.
2. **No dedicated `/api/coach/snapshot` or `/api/dashboard/data`
   route exists in v1.4.24** — these were hypothetical paths in the
   directive. The actual surfaces are `/api/insights/chat` (Coach
   drawer) and `/api/dashboard/summary` (dashboard hydration). Both
   exercised and clean.
3. **`DEMO_MODE=true` env was already set** on edge-01 from the prior
   deploy. It causes write endpoints (insights generate, measurement
   POST, etc.) to return 403 with `meta:{demo:true}` — exactly what
   we want for a public demo. Reads remain functional and the
   dashboard/insights surfaces are populated from the seeded data.
4. **`SOURCE_COMMIT` env still references the old git SHA**
   (`0c0c345…`). This is purely informational (it flows into
   `deploy.commit_hash` in structured logs), but it now misrepresents
   the running image. Suggest updating it to e.g. `v1.4.24` on the
   next compose touch (W12).

## Open items (W12 / future)

- After v1.4.25 tags + publishes to GHCR, re-deploy the demo by
  bumping the compose `image:` line to `ghcr.io/mbombeck/healthlog:1.4.25`
  and running `docker compose pull && docker compose up -d`. No DB
  reset needed on minor-patch bumps (migrations apply forward).
- Optional polish: seed 2-3 unlocked `UserAchievement` rows and 1-2
  `DataBackup` history entries so the achievements + backups pages
  have content. Skipped this round — not blocking the demo.
- Optional: stop publishing `healthlog-beta.ioioio.dev` if it's no
  longer needed (compose still serves both hosts).
- The `medication_schedules.windowStart`/`windowEnd` camelCase column
  drift (see findings #1) should be tracked in v1.4.25 backlog.
- Update `SOURCE_COMMIT` env on edge-01 next time the compose is
  edited (informational only — `/api/version` correctly reports the
  package.json version).

## Constraints honored

- All commands executed on edge-01 only; apps-01 untouched.
- HealthLog repo source not modified.
- healthlog-landing repo not modified (DemoCredentials already
  matched).
- Previous image kept on disk as fallback.
- Backup tarball preserved.
- No `pnpm dev` / `pnpm build` on edge-01.
