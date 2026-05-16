---
file: .planning/round-v1430-closure-report.md
purpose: v1.4.30 release closure — iOS-coordinated foundation (Daily-Stats + SyncMode)
created: 2026-05-16
tag: v1.4.30
---

# v1.4.30 — release closure

Shipped 2026-05-16 mid-day. Server-side prep for the next iOS
TestFlight build. Five surfaces land together so the iOS engineer
can pick them up in one cut-over: a locked `externalId` shape for
daily-aggregated cumulative HealthKit rows, the SyncMode foundation
columns + handshake + bulk-backfill endpoints, a first-class
`MoodEntry.note` column that replaces the legacy tag-based
workaround, a cross-source workout dedup helper, and two new
`MeasurementType` enums (`WALKING_STEADINESS`, `AUDIO_EXPOSURE_EVENT`)
plus the shared `MEASUREMENT_CATEGORIES` overlay that drives the
iOS permission picker and the future Insights nav.

## Outcome

- `healthlog.bombeck.io/api/version` → `1.4.30`, `/privacy` → 200.
- `demo.healthlog.dev/api/version` → `1.4.30`, `/privacy` → 200.
- GitHub Release: <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.30>.
- Sister-repos: `healthlog-docs@dcbc49b`, `healthlog-landing@de620bf`.
- PR #174 squashed on `main` at `3ece95f1`; tag `v1.4.30` points
  to annotated tag commit `e2062300`.

## Commits on develop since v1.4.29.1

| Commit | Subject |
|---|---|
| `6e6bc618` | feat(api): lock the daily-stats externalId shape for cumulative HealthKit types |
| `0e92f96e` | feat(scripts): drain per-sample cumulative HealthKit rows into daily-aggregated rows |
| `0ccc00b7` | feat(api): SyncMode foundation — syncVersion column, sync-state endpoint, bulk backfill routes |
| `11325e31` | feat(mood): add a first-class note column replacing the tag-based workaround |
| `57abfbfb` | feat(workouts): pick canonical rows across Apple Watch and Withings sources |
| `479e0aed` | feat(measurements): shared category map for the iOS picker and the web Insights nav |
| `dd487cfd` | feat(measurements): add walking-steadiness and audio-exposure-event types |
| `a3b00f49` | test(db): expand the real-Postgres integration coverage |
| `0522652a` | feat(measurements): wire walking-steadiness + audio-exposure-event through every registry |
| `e1e628da` | chore(release): v1.4.30 |
| `5206ae60` | chore(merge): reconcile main into develop for v1.4.30 release |
| `8d153146` | chore(openapi): regenerate the public spec after the v1.4.30 enum additions |

Squashed on `main` at `3ece95f1`; tag `v1.4.30` points there.

## Findings closed

- **R-A Option A server-side**. `dailyStatsExternalId()` helper +
  handoff-doc lock for the canonical
  `"stats:<HKQuantityTypeIdentifier>:<YYYY-MM-DD>"` shape. The
  v1.4.29 `CUMULATIVE_HK_TYPES` set already documents the five
  cumulative types; the new helper closes the iOS side so the next
  TestFlight build can adopt `HealthKitStatisticsService.swift`
  without a server release.
- **R-A drain script**. `scripts/drain-per-sample-cumulative.ts` +
  `POST /api/admin/drain-per-sample-cumulative` collapse pre-Option-A
  per-sample APPLE_HEALTH cumulative rows into one row per day per
  type. Idempotent; dry-run by default. Operator runs once after
  the iOS cut-over.
- **R-E C-2 SyncMode foundation**. Migration 0062 adds
  `Measurement.sync_version` (Int, default 1),
  `Measurement.deleted_at` (Timestamp, nullable),
  `User.last_synced_at` (Timestamp, nullable). New endpoints:
  `GET /api/sync/state`, `POST /api/mood-entries/bulk`,
  `POST /api/medications/intake/bulk` — all rate-limited at
  60/min/user, all carry a 500-entry cap.
- **R-E H-5 mood-entry note column**. Migration 0063 +
  `scripts/backfill-mood-note-column.ts` lifts the legacy
  `tags: ["note:<text>"]` workaround into a first-class
  `MoodEntry.note` (TEXT, nullable, max 500 chars in Zod).
- **R-F T1.1 workout API verification**. The existing
  `POST /api/workouts/batch` route (v1.4.25 W8d) passes verification —
  rate-limit + idempotency + 5 MB body cap + 100-workout cap all
  intact. `pickCanonicalWorkoutRows()` helper buckets workouts by
  5-minute startedAt slot + sportType and walks the existing
  measurement source ladder.
- **R-F §4 categorisation overlay**. `src/lib/measurements/categories.ts`
  exposes `MEASUREMENT_CATEGORIES: ReadonlyMap<MeasurementType,
  MeasurementCategory>` over eight categories (vitals / body /
  activity / sleep / hearing / environment / cardiovascular /
  metabolic). Completeness wall in the test suite catches a new
  MeasurementType lacking a category assignment.
- **R-F T1.4 + T1.5 enum additions**. `WALKING_STEADINESS` +
  `AUDIO_EXPOSURE_EVENT` land via migration 0064. The wiring
  registries (`apple-health-mapping`, `categories`, `pr-direction`,
  `chart-tokens`, six locale files) pick them up in the same release.

## Deploy mechanics note

Coolify auto-deploy fired against apps01 ("deployment finished" at
10:46:09) but did NOT pull the new `:latest` digest — fourth release
in a row matching the v1.4.27 / v1.4.28 / v1.4.29 / v1.4.29.1 gap.
Host-side SSH fallback finished the rollout (`docker pull
ghcr.io/mbombeck/healthlog:latest` + `docker compose up -d
--force-recreate --no-deps app`). The runbook for the toggle lives
at `.planning/coolify-auto-deploy-howto.md`; the v1.4.31 backlog
already carries the "investigate auto-deploy gap" item.

edge-01 deploy: the docker-compose pins the explicit `1.4.29.1` tag
rather than `:latest`. Precise sed
(`s|healthlog:1.4.29.1|healthlog:1.4.30|g`) plus a
`.pre-v1430.bak` snapshot bumped the file in place; clean execution
the first pass.

## iOS-contract notes

Every change in v1.4.30 is **additive** on the wire:

- The `dailyStatsExternalId` helper is server-side only; iOS
  generates its own externalIds. The locked shape in handoff doc §12
  is the contract iOS reads before implementing
  `HealthKitStatisticsService.swift`.
- The SyncMode columns carry defaults (`sync_version = 1`,
  `deleted_at = null`, `last_synced_at = null`) so existing iOS
  POSTs round-trip unchanged.
- The new endpoints (`/api/sync/state`,
  `/api/mood-entries/bulk`,
  `/api/medications/intake/bulk`,
  `/api/admin/drain-per-sample-cumulative`) are net-new — no iOS
  consumer yet.
- `MoodEntry.note` is optional Zod-side; old iOS payloads keep
  round-tripping via `tags`. The bulk endpoint and the
  POST/PUT routes accept the new field when supplied.
- The two new `MeasurementType` enums are net-new values; iOS
  clients that predate the codegen pass (R-E H-8) will not
  encounter them in read paths because no source writes them yet.

**Cutover sequence**: v1.4.30 ships with the helper + drain script
+ server tolerance for both shapes (per-sample uuid AND daily
`stats:...` externalIds). The next iOS TestFlight build adopts
`HealthKitStatisticsService.swift` and starts posting daily-
aggregated rows for the five cumulative types. Operator runs the
drain script once after the new TestFlight cuts over; per-sample
row pressure on `Measurement` drops 50-200× for cumulative types.

## v1.4.31 scope seed

Carried into v1.4.31 from the strategic plan §2 plus the v1.4.30
window:

- **Assistant-optional operator toggles** (R-E §"assistant-optional",
  research at `.planning/research/v15-assistant-optional.md`).
- **Insights tab-strip blocking on mobile**
  (`.planning/research/v15-insights-blocking-bug.md`).
- **Coolify auto-deploy investigation** — fourth release in a row
  the webhook reported "finished" but didn't pull the new `:latest`
  digest. Document the root cause in
  `.planning/round-coolify-auto-deploy-fix.md`.

## Closure complete

v1.4.30 lives on both production hosts (apps01 + edge-01) and the
GitHub Release reads it as the latest. The full integration suite
runs 47 files / 190 specs against the real-Postgres container; the
unit suite passes 4035 specs. The next patch is v1.4.31 (operator
toggles + insights blocking + Coolify auto-deploy fix).
