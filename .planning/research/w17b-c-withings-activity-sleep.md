# W17b + W17c — Withings Activity sync + Sleep v2 sync — Research

Author: research agent (read-only)
Date: 2026-05-14
Scope: v1.4.25 wave W17b (Activity routine) + W17c (Sleep v2 routine). W5d
already shipped the scope upgrade (`user.activity`) and reconnect banner; this
research nails down the sync mechanics that ride on top of it.

References:

- Withings API reference root — [developer.withings.com/api-reference](https://developer.withings.com/api-reference/) ([1])
- Withings notification categories (appli table) — [developer-guide/v3/data-api/notifications/notification-content](https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-content/) ([2])
- Withings notification overview + rate limit — [developer-guide/v3/data-api/notifications/notification-overview](https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-overview/) ([3])
- WithingsFlutter community guide — Measure v2 GetActivity field reference ([4])
- Hubitat-Withings issue #2 — `getsummary` `data_fields` enumeration ([5])
- withings-go SDK — sleep state enum literals ([6])
- Wearipedia notebook — Sleep getsummary field catalogue ([7])
- HealthLog code consulted (read-only): `src/lib/withings/client.ts`,
  `src/lib/withings/sync.ts`, `src/lib/withings/mapping.md`,
  `src/lib/jobs/reminder-worker.ts`, `src/lib/analytics/source-priority.ts`,
  `src/lib/validations/source-priority.ts`,
  `src/components/settings/integrations-section.tsx`,
  `src/app/api/withings/{sync,webhook,status}/route.ts`,
  `src/lib/integrations/status.ts`, `prisma/schema.prisma`.

---

## Section 1 — Withings Activity API surface

Endpoint: `POST https://wbsapi.withings.net/v2/measure?action=getactivity` ([4]).

Authentication: `Authorization: Bearer <access_token>` — same OAuth bearer the
existing `fetchMeasurements` call already wields. Requires the `user.activity`
scope; without it Withings returns status `503` / `293` (insufficient scope).
The scope was added in v1.4.25 W5d, so this is wired (`WITHINGS_OAUTH_SCOPE =
"user.metrics,user.activity"` in `src/lib/withings/client.ts:42`).

**Two query modes** ([4]):

1. Date range — `startdateymd=YYYY-MM-DD` + `enddateymd=YYYY-MM-DD`.
2. Update-cursor — `lastupdate=<unix_seconds>` returns every aggregate
   modified after that watermark. **This is the right primitive for
   incremental syncs** because Withings re-aggregates a day when late samples
   arrive (e.g. the watch syncs at noon with the previous day's overnight
   steps) — calendar-day re-fetches would miss these.

**Response fields per day** ([4]):

| Withings field   | HealthLog `MeasurementType`              | Unit       | Notes                                                        |
| ---------------- | ---------------------------------------- | ---------- | ------------------------------------------------------------ |
| `steps`          | `ACTIVITY_STEPS`                         | count      | Daily aggregate                                              |
| `distance`       | `WALKING_RUNNING_DISTANCE`               | metres     | Canonical SI; HealthLog already stores metres                |
| `calories`       | `ACTIVE_ENERGY_BURNED`                   | kcal       | "Active" calories only — matches HealthKit `activeEnergyBurned` |
| `elevation`      | `FLIGHTS_CLIMBED`                        | floors     | Withings reports floors directly per [4]; no 3 m conversion needed |
| `totalcalories`  | — (skip)                                 | kcal       | BMR + active; HealthLog ingests active only                  |
| `soft/moderate/intense`/`active` | — (defer)                | seconds    | No DB enum; reconsider in v1.5 with HealthKit workouts       |
| `hrAverage/hrMin/hrMax`          | — (defer)                | bpm        | Daily HR aggregates; redundant with intraday HR streams       |
| `hrZone0..hrZone3`               | — (defer)                | seconds    | Niche analytics; defer to a later workout-centric wave        |

**Pagination**: response carries `more` boolean + `offset` cursor — same
shape `fetchMeasurements` already handles (see `client.ts:296-303`).

**Sister endpoint** `POST /v2/measure?action=getworkouts` ([1]) returns
per-workout records (start/end, distance, calories, HR). HealthLog has no
`Workout` model today (`mapping.md:75` defers to v1.5); W17b does NOT
ingest workouts. The activity totals above already include workout-time
movement, so excluding `getworkouts` only loses the per-session breakdown.

## Section 2 — Withings Sleep v2 API surface

Two endpoints, both `POST https://wbsapi.withings.net/v2/sleep`:

### `action=getsummary` — per-night aggregate ([5], [7])

Query params: `startdateymd` + `enddateymd` OR `lastupdate=<unix>`,
identical pattern to Activity. Required `data_fields` (comma-separated)
controls which response fields populate; production set per Hubitat-Withings
([5]) is:

`breathing_disturbances_intensity, deepsleepduration, durationtosleep,
durationtowakeup, hr_average, hr_max, hr_min, lightsleepduration,
remsleepduration, rr_average, rr_max, rr_min, sleep_score, snoring,
snoringepisodecount, wakeupcount, wakeupduration`

Wearipedia ([7]) lists 25 documented fields including Sleep Efficiency,
Latency, WASO, REM phase count, out-of-bed count.

**HealthLog mapping (W17c)**:

| Withings summary field | HealthLog row                                      | Notes                                                                  |
| --- | --- | --- |
| `total sleep time` (asleepduration) | `SLEEP_DURATION` row with `sleepStage = null` | Canonical minutes per `prisma/schema.prisma:309`; matches HealthKit semantics |
| `lightsleepduration`   | `SLEEP_DURATION` row, `sleepStage = CORE`         | Withings "light" maps to HealthKit/HealthLog `CORE` (NREM 1+2)         |
| `deepsleepduration`    | `SLEEP_DURATION` row, `sleepStage = DEEP`         | NREM 3 — direct match                                                  |
| `remsleepduration`     | `SLEEP_DURATION` row, `sleepStage = REM`          | Sleep Analyzer mat only; nightly REM nullable on ScanWatch ([6])       |
| `wakeupduration`       | `SLEEP_DURATION` row, `sleepStage = AWAKE`        | Time awake after sleep onset (WASO)                                    |
| `sleep_score`          | — (defer to v1.4.26)                              | Withings-proprietary 0–100; no DB enum; could land as derived metric   |
| `hr_average / hr_min / hr_max` | — (skip)                                  | Per-night HR aggregates redundant with intraday PULSE stream           |

Per-stage seconds → divide by 60 → store as minutes (`SLEEP_DURATION` is
already canonical minutes per `prisma/schema.prisma:309`).

### `action=get` — per-segment series ([6])

Query params: `startdate` + `enddate` (unix seconds — different from
`getsummary`!), `data_fields` selects: `hr, rr, snoring, sdnn_1, mvt_score,
mvt_active_so`, etc.

**Response shape**: `series[]` of `{ startdate, enddate, state, hr?, rr?,
snoring? }`. The `state` integer follows the withings-go enum literals ([6]):

| `state` | meaning      | HealthLog `SleepStage` enum value      |
| ------- | ------------ | -------------------------------------- |
| 0       | Awake        | `AWAKE`                                |
| 1       | Light sleep  | `CORE`                                 |
| 2       | Deep sleep   | `DEEP`                                 |
| 3       | REM          | `REM`                                  |

The `IN_BED` and legacy `ASLEEP` slots in the HealthLog enum stay reserved
for HealthKit ingest (`prisma/schema.prisma:309-318`).

**Granularity**: per ([7]), per-stage segments (variable length) rather than
fixed per-minute samples. A typical 8 h night = ~30–60 series rows. HealthLog
`SLEEP_DURATION` already supports this — the v1.4.23 schema note
(`prisma/schema.prisma:309`) explicitly cites "HealthKit category samples
(per-stage rows)" as the reason for the minutes shift.

**Device caveat**: ScanWatch reports light/deep but **not** REM ([6]
Reddit thread cross-referenced with Withings support); `getsummary` returns
`remsleepduration: null` for ScanWatch nights. The mapping table above
already tolerates this (the row simply isn't created).

## Section 3 — Sync-trigger architecture (cron + webhook)

Recommendation: **Option C — webhook-primary + cron-safety-net** (matches the
existing measurement sync pattern: `WITHINGS_NOTIFY_APPLIS = [1, 2, 4]` already
runs both, see `sync.ts:272`).

**Webhook side (low-latency)**:

- Subscribe to `appli=16` (Activity) — payload `{userid, appli, date}` ([2]).
- Subscribe to `appli=44` (Sleep) — payload `{userid, appli, startdate, enddate}` ([2]).
- Both registered in `setupWebhook()` by extending `WITHINGS_NOTIFY_APPLIS`
  from `[1, 2, 4]` to `[1, 2, 4, 16, 44]`. The W5d code comment at
  `sync.ts:269-271` already foreshadows this: _"Sleep (appli=44) and activity
  (appli=16) ship alongside the corresponding sync routines in v1.4.26"_ —
  this work is exactly that.
- The existing `/api/withings/webhook` route fires `syncUserMeasurements`
  unconditionally; W17b/c either (a) branches on the `appli` form field and
  dispatches the right sync (cleaner) or (b) makes a single sync entry point
  fan out internally (less invasive).
- **Sleep events `appli=50/51/52`** (Sleep Analyzer mat bed-in / bed-out /
  inflate) — defer per `mapping.md:85`. Niche, not on Marc's device list.

**Cron side (safety-net)**:

- Add two pg-boss schedules to `reminder-worker.ts`:
  - `withings-activity-sync` cron `0 * * * *` (hourly, matches existing
    `WITHINGS_SYNC_CRON` cadence at `reminder-worker.ts:79`).
  - `withings-sleep-sync` cron `15 * * * *` (offset 15 min to avoid bunching).
- Both iterate `prisma.withingsConnection.findMany()`, call the respective
  sync helper per user, record success/failure via the existing
  `recordSyncSuccess` / `recordSyncFailure` plumbing
  (`src/lib/integrations/status.ts`).

## Section 4 — Measurement-type mapping (concrete enum dispatch)

Activity rows (W17b, all `measuredAt = day-end UTC` to match HealthKit
"daily summary" pattern):

```
{ type: ACTIVITY_STEPS,          value: steps,     unit: "count",  source: WITHINGS }
{ type: WALKING_RUNNING_DISTANCE, value: distance, unit: "m",      source: WITHINGS }
{ type: ACTIVE_ENERGY_BURNED,    value: calories, unit: "kcal",   source: WITHINGS }
{ type: FLIGHTS_CLIMBED,         value: elevation, unit: "count", source: WITHINGS }
```

Sleep rows (W17c, one row per stage segment from `action=get`, plus a
nightly `sleepStage = null` summary row from `action=getsummary` for the
trend chart consumers):

```
{ type: SLEEP_DURATION, sleepStage: AWAKE|CORE|DEEP|REM, value: minutes,
  unit: "min", measuredAt: segment.startdate, source: WITHINGS }
{ type: SLEEP_DURATION, sleepStage: null,                value: minutes,
  unit: "min", measuredAt: night-end, source: WITHINGS }
```

Idempotency: the existing composite unique
`userId_type_measuredAt_source` on `Measurement` (used in `sync.ts:186`)
already prevents duplicates — `upsert` on activity rows is safe. For sleep
the index does NOT include `sleepStage`, so an `(userId, SLEEP_DURATION,
2026-05-13 22:00 UTC, WITHINGS)` AWAKE row and a same-timestamp CORE row
would collide. **Open question for Marc / migration**: extend the composite
to include `sleepStage`, OR shift per-stage `measuredAt` by `+ index ms` so
each segment is unique. The latter is a zero-migration workaround; the
former is the right long-term shape.

## Section 5 — User-impact + reconnect-flow integration

The reconnect banner from W5d (`integrations-section.tsx:365-369`) renders
when `status.connected && status.hasActivityScope === false`. The
`/api/withings/status` route at `src/app/api/withings/status/route.ts:100-105`
already exposes `hasActivityScope`.

**Failure path when sync hits a connection without `user.activity`**:

1. Withings returns status code in the 200–299 band (per `client.ts` family
   of error responses; activity-specific code is documented as "insufficient
   scope").
2. `isWithingsRefreshReauthFailure()` in `sync.ts:240-248` already maps
   200–299 to `reauth_required`. **But** that helper is wired to the refresh
   token flow, not to a regular getactivity call. W17b must add a sibling
   check: if `getactivity` returns 293 / 503, call
   `recordSyncFailure({ kind: "reauth_required" })` so the IntegrationStatus
   row parks at `error_reauth` and `isReauthRequired()` short-circuits the
   next cron.
3. The reconnect banner already prompts (W5d). User clicks → OAuth roundtrip
   → `markReconnected` (per `status.ts:135`) flips the state → next cron
   picks up cleanly.

**Backfill window** (Marc directive, handoff document):

- Initial sync after reconnect: 30 days back (matches
  `sync.ts:159 — `new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)`).
- Incremental after that: `lastupdate` watermark stored on
  `WithingsConnection.lastSyncedAt`. The existing 60 s overlap window
  (`sync.ts:158`) is unnecessary for `lastupdate` syncs — Withings re-emits
  changed rows automatically.

## Section 6 — Race conditions + idempotency

1. **Webhook arrives mid-cron**: both call the same upsert path, both keyed
   on `(userId, type, measuredAt, source)`. Postgres serializes via the
   unique index — duplicates impossible, the later write wins on `value`.
2. **Concurrent webhooks (Activity + Sleep at the same instant)**: distinct
   row keys (different `type`), zero contention.
3. **User disconnects during sync**: `prisma.withingsConnection.findUnique`
   returns null → existing guard at `sync.ts:152-154` returns 0. No panic.
4. **Rate limit**: Withings caps at **120 requests/min/app** ([3], [8]).
   Worst case: 100 users × 3 paginated activity pages × every-hour cron =
   300 req / min if perfectly aligned. Mitigation: pg-boss
   `localConcurrency: 1` (already in `reminder-worker.ts:1259`) serializes
   the per-user loop; add a 500 ms `await` between user iterations once we
   reach >50 connections (low priority for v1.4.25).
5. **Token refresh racing the sync**: handled by `getValidToken` (5 min
   buffer at `sync.ts:49`) — already battle-tested.

## Section 7 — Source-priority interaction

Per `src/lib/validations/source-priority.ts:188-196` (W8c defaults):

- **Cumulative** (`steps`, `activeEnergy`, `walkingRunningDistance`,
  `flightsClimbed`): `APPLE_HEALTH > WITHINGS > MANUAL`.
- **Sleep + HRV + RHR**: `APPLE_HEALTH > WITHINGS`.

So Withings activity / sleep data lands in the DB as a complete shadow
stream; until v1.5 ships the iOS passthrough, Withings is effectively the
top-ranked source (because Apple Health has no rows). Once iOS lands,
Withings rows demote to fallback, but **stay in the DB** as an audit trail
(see `source-priority.ts:14-16` — "dropping a row from the aggregation set
does NOT delete it from the DB").

Two-axis device check (W8c): Withings ingest must set `Measurement.deviceType`
appropriately. Activity rows from a scale → `scale`. Activity rows from a
ScanWatch → `watch`. Sleep rows from Sleep Analyzer mat → `other` (no
"mat" slot in the enum at `source-priority.ts:53-61`; closest is `other`).
Per Withings API there is no per-row device tag in the activity / sleep
response — the `User v2 - Getdevice` endpoint (`mapping.md:75-78`, deferred)
is the only way to resolve it. **Open question**: tag activity rows
`deviceType = null` (resolves to `unknown`) for v1.4.25 and revisit when
the device endpoint lands.

## Section 8 — Sleep v2 UI integration

Existing UI (W4c):

- `/insights/schlaf` (`src/app/insights/schlaf/page.tsx`) → renders
  `<SleepOverview>` (`src/components/insights/sleep-overview.tsx`) which
  composes `<SleepDurationChart>` + `<SleepStageStackedBar>`.
- `SleepStageBreakdown` interface (`sleep-stage-stacked-bar.tsx:46`) already
  carries per-stage minutes keyed by the Prisma `SleepStage` enum (AWAKE,
  CORE, DEEP, REM, IN_BED, ASLEEP). No UI changes needed for stage-level
  Withings data — the chart consumes the exact shape the new ingest writes.
- `<SleepDurationChart>` already filters by `types={["SLEEP_DURATION"]}`
  (`sleep-duration-chart.tsx:45`) and inherits from the analytics aggregator,
  which means it will reflect the W5e source-priority pick automatically.

**One verification gap**: the sleep summary aggregator (wherever
`SleepAnalyticsSummary` is computed) must consume the canonical-source
picker. If it currently sums raw rows it will double-count once Withings
sleep arrives alongside future HealthKit rows. Worth a follow-up smoke test
during W17c integration but no code change in this research scope.

## Section 9 — Cron infrastructure recommendation

HealthLog runs **pg-boss** (v12, Postgres-backed) inside the
`HEALTHLOG_PROCESS_TYPE=worker|all` container (`reminder-worker.ts:1130`,
`docker-compose.yml:28`). All scheduled work — Telegram reminders, existing
Withings fallback, six insights generators, MoodLog sync, backups,
host-metric sampling — already lives there. **Use the same mechanism for
W17b/c** ([9]).

Concrete plan:

1. Two new queues + crons in `reminder-worker.ts`:
   ```ts
   const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";
   const WITHINGS_ACTIVITY_CRON = "0 * * * *"; // hourly :00
   const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";
   const WITHINGS_SLEEP_CRON = "15 * * * *"; // hourly :15
   ```
2. Two handlers (`handleWithingsActivityFallbackSync`,
   `handleWithingsSleepFallbackSync`) that mirror the existing
   `handleWithingsFallbackSync` pattern (`reminder-worker.ts:508-551`).
3. Webhook route (`src/app/api/withings/webhook/route.ts`) reads the `appli`
   form field and dispatches:
   - `appli=1|2|4` → existing `syncUserMeasurements` (Measure rows).
   - `appli=16`    → new `syncUserActivity`.
   - `appli=44`    → new `syncUserSleep`.

**Coolify auto-deploy reminder**: per Marc's session memos (v1.4.23 release
outcome), Coolify auto-deploy has been gated on missing secrets for three
releases. The cron lands in the worker container; if Coolify still requires
host-side retag, the cron starts on the next manual redeploy. No special
handling needed — pg-boss recovers gracefully on boot.

## Section 10 — Tests strategy

Unit tests (Vitest, follows existing patterns in
`src/lib/withings/__tests__/`):

- `fetchActivity()` — mock 200 OK + paginated response; assert correct
  page advance, correct DB field mapping, correct unit (metres for distance,
  not km).
- `fetchActivity()` — mock 293 / 503 (insufficient scope); assert
  `recordSyncFailure({ kind: "reauth_required" })` is called.
- `fetchSleepSummary()` — mock both `getsummary` and `get` responses with
  realistic field counts; assert per-stage rows with correct `sleepStage`
  enum values and minutes (not seconds) — easy regression trap.
- `fetchSleep()` — ScanWatch path: `remsleepduration: null`; assert the
  REM row is NOT created (vs. all-zeros being created erroneously).
- Idempotency — run the same `getactivity` response twice, assert the row
  count doesn't double.
- Activity sleepStage collision test — confirms the `+ index ms`
  workaround OR the schema migration succeeds for per-stage rows.

Integration test (mirrors existing `webhook` test directory):

- POST `/api/withings/webhook` with `appli=16` form data, assert the
  activity sync was dispatched and rows landed.
- Same with `appli=44`.

Manual smoke (post-deploy):

1. Reconnect Marc's account through the W5d banner (one-time).
2. Confirm webhook subscribed: `boss.job` table shows new
   `withings-activity-sync` schedule.
3. Trigger a manual cron: `POST /api/withings/sync` (extend the route to
   accept `kind: "activity" | "sleep" | "all"`).
4. Verify `Measurement` row count change for the 30-day window.

## Section 11 — Open questions for Marc

1. **Sleep stage row uniqueness** — extend the composite unique to include
   `sleepStage`, or rely on `+ index ms` measuredAt offset? Schema migration
   is the clean answer; `index ms` ships faster.
2. **Per-segment vs per-night sleep rows** — write both (nightly summary +
   per-stage segments)? Or only per-stage segments and aggregate at read
   time? The UI components consume both shapes, so both is safest, but
   "both" means roughly 30+1 rows per night per user.
3. **`elevation` semantics** — per the WithingsFlutter community guide ([4])
   elevation is "floors climbed". HealthLog `FLIGHTS_CLIMBED` is also floors.
   Confirm Withings does NOT report metres or feet under that field — if it
   does, a unit conversion belongs in the mapping table.
4. **Sleep score** — surface or defer? Withings ships a 0–100 score; no DB
   enum today. A new `SLEEP_SCORE` MeasurementType is small but adds a
   schema migration to v1.4.25; punt to v1.4.26 if the wave is already heavy?
5. **Activity backfill window** — 30 days matches the measure sync default.
   Marc directive earlier in the handoff. Confirm or extend to 90 days?
6. **`getworkouts` for v1.4.25** — Marc's directive lists only Activity +
   Sleep v2, not workouts. Confirm `getworkouts` stays deferred to v1.5
   (per `mapping.md:75`).
7. **Device-type tagging** — leave activity / sleep rows with
   `deviceType = null` until `User v2-Getdevice` ingest lands? That preserves
   the two-axis source-priority semantics but loses watch-vs-scale resolution.

---

[1]: https://developer.withings.com/api-reference/
[2]: https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-content/
[3]: https://developer.withings.com/developer-guide/v3/data-api/notifications/notification-overview/
[4]: https://fraca98.github.io/WithingsFlutter/guide/measure/measurev2getactivity.html
[5]: https://github.com/dcmeglio/hubitat-withings/issues/2
[6]: https://github.com/zono-dev/withings-go/tree/main
[7]: https://wearipedia.readthedocs.io/en/latest/notebooks/withings_sleep.html
[8]: https://gist.github.com/katemonkeys/e17580777b57915f5068 ("Everything Wrong With The Withings API" — corroborates the 120/min/app cap)
[9]: pg-boss reference — https://github.com/timgit/pg-boss
