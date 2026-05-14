# W16b Workout Ingest Endpoint — Research

**Scope.** Lock the server-side ingest contract for the W8d `Workout`
+ `WorkoutRoute` tables (Migration 0053). Consumers: (1) the v1.5
iOS-Swift app draining its HealthKit observer queue and (2) the
Withings activity sync routine following v1.4.25 W5d's `user.activity`
scope upgrade. No web UI calls the endpoint in v1.4.25 — manual
workout entry is a v1.5+ scope. Output: endpoint shape, Zod schema,
size cap, dedup contract, deferred-write to the W16c PR-detection
worker. **Read-only — no code committed.**

**Date.** 2026-05-14.
**Author.** Research agent (v1.4.25 W16b planning), for Marc Bombeck.
**Prior work this builds on.**
- W8d implementation outline — `.planning/research/w8d-implementation-outline.md` §4 (Workout / WorkoutRoute shape rationale).
- Withings API coverage — `.planning/research/withings-api-coverage.md` §2.4 (Activity / Workouts API).
- Existing batch route — `src/app/api/measurements/batch/route.ts` (the v1.4.23 + v1.4.25 W10-hardened reference implementation).
- W8c source-priority — `src/lib/analytics/source-priority.ts` (two-axis cross-source picker the workout READ path will mirror).

---

## Section 1: Schema recap (W8d Migration 0053)

Migration 0053 (`prisma/migrations/0053_workout_and_route/migration.sql`)
created two tables:

**`workouts`** — HKWorkout-aligned typed columns + a free-form
`metadata JSONB` tail. Schema lives in `prisma/schema.prisma:380-440`.
Hot-path columns: `sportType` (TEXT, free-text — see W8d §4.3 rationale
on avoiding a Postgres enum for 70+ HKWorkoutActivityType values),
`startedAt`, `endedAt`, `durationSec` (denormalised seconds), the energy
/ distance / heart-rate / step / elevation / pause-duration optionals,
`source` (the shared `MeasurementSource` enum — `MANUAL | WITHINGS |
IMPORT | APPLE_HEALTH`, `prisma/schema.prisma:296-303`), `externalId`
(HK `HKWorkout.uuid` or Withings `workout.id`; NULL-distinct for manual
entries), `externalSourceVersion`, and `metadata JSONB` for the
source-specific long tail.

**Indexes.** `@@unique([userId, source, externalId])` — ingest dedup
key (Postgres NULL-distinct semantics keep manual entries from
colliding). Read indexes `(userId, startedAt)` and
`(userId, sportType, startedAt)` cover the dashboard "recent workouts"
and "last 10 runs" queries.

**`workout_routes`** — 1:1 with `workouts` via
`workoutId String @unique`. `geometry JSONB` stores a GeoJSON
LineString per RFC 7946 §3.1.4 [1]; `sampleTimestamps JSONB` stores a
parallel array of ISO timestamps + optional per-sample `speedMs` / `hr`.
JSONB rather than PostGIS — same precedent the correlations table set
in v1.4.20 (Coolify Postgres template stays extension-free, per W8d
§4.4 commentary in `schema.prisma`).

**Known TODO documented in the schema** (`schema.prisma:425-433`):
cross-source workout dedup at the READ layer. The same workout
ingested from Apple Watch via the iOS passthrough AND a Withings
ScanWatch arrives twice (different `source`, so the unique key permits
both). The fix mirrors `pickCanonicalSourceRows()`
(`src/lib/analytics/source-priority.ts`), tracked for v1.5 P1. The
ingest endpoint does NOT attempt cross-source dedup — it stores both
rows; the read path picks canonical.

---

## Section 2: iOS contract (HKWorkout + HKWorkoutRoute → POST shape)

**HKWorkout source-of-truth.** Apple's `HKWorkout` initialiser [2]
exposes: `activityType: HKWorkoutActivityType` (numeric enum, 76+
values [3]), `start: Date`, `end: Date`, `workoutEvents:
[HKWorkoutEvent]?` (pause/resume markers), `totalEnergyBurned:
HKQuantity?` (kcal), `totalDistance: HKQuantity?` (metres),
`device: HKDevice?`, `metadata: [String: Any]?`. Every sample inherits
`HKSample.uuid` (UUID v4) — the natural `externalId`.

**HKWorkoutRoute.** `HKWorkoutRoute` [4] is an `HKSeriesSample` whose
samples are streamed via `HKWorkoutRouteQuery` [5] as `[CLLocation]`.
Each `CLLocation` carries lat/lon/altitude/timestamp/speed(m/s)/
course/`horizontalAccuracy` — the iOS client should filter samples
with `horizontalAccuracy > 50 m` before upload (defensive practice
across every OSS HK route exporter — e.g. `BRO3886/healthsync`).

**Recommended POST body shape** for the iOS client (mirrors the
`POST /api/measurements/batch` envelope shape so the iOS sync engine
re-uses the same retry plumbing):

```jsonc
{
  "workouts": [
    {
      "sportType": "running",                            // mapped from HKWorkoutActivityType numeric — see workout-type registry in src/lib/measurements/apple-health-mapping.ts (W8d §2.2)
      "startedAt": "2026-05-14T07:12:33+02:00",
      "endedAt":   "2026-05-14T07:58:01+02:00",
      "totalEnergyKcal": 421.3,                          // HKWorkout.totalEnergyBurned in kcal
      "totalDistanceM":  6240.0,                         // HKWorkout.totalDistance in metres
      "avgHeartRate": 152,                               // post-hoc computed from HKQuantityTypeIdentifierHeartRate samples in the workout window
      "maxHeartRate": 178,
      "minHeartRate": 96,
      "stepCount": 6820,
      "elevationM": 84.5,
      "pauseDurationSec": 0,                             // derived from HKWorkoutEvent pause/resume markers
      "source": "APPLE_HEALTH",                          // optional; server defaults from auth context
      "externalId": "AB3E1F2C-9D44-4EAA-9F00-6D7C13F5E2B0",  // HKWorkout.uuid
      "externalSourceVersion": "iOS-18.4.1+app-1.5.0",   // opaque marker — see Measurement.externalSourceVersion pattern
      "metadata": {                                       // HKMetadata key/value tail — kept opaque
        "HKWorkoutEventTypes": [{ "type": "pause", "date": "..." }, ...],
        "HKAverageMETs": 6.2,
        "HKWeatherCondition": 11,
        "deviceBundleId": "com.apple.health"
      },
      "route": {                                          // optional — included only when HKWorkoutRoute exists
        "geometry": {
          "type": "LineString",
          "coordinates": [
            [11.0767, 49.4521],
            [11.0769, 49.4523],
            // ... up to ~3000 points for a typical 1-Hz hour-long run
          ]
        },
        "sampleTimestamps": [
          { "t": "2026-05-14T07:12:33+02:00", "speedMs": 3.1, "hr": 142 },
          { "t": "2026-05-14T07:12:34+02:00", "speedMs": 3.2, "hr": 143 },
          // ... parallel array, same length as coordinates
        ]
      }
    }
  ]
}
```

This matches the existing Zod schema `createWorkoutSchema` already
authored in `src/lib/validations/workout.ts:86-108` (W8d-locked
contract). The endpoint accepts an array of those — i.e. `z.object({
workouts: z.array(createWorkoutSchema).min(1) })`. Routes are nested
inside each workout rather than a sibling array because the 1:1
relationship is enforced at the DB layer (`@unique` on
`WorkoutRoute.workoutId`) — a sibling array invites the client to
forget to pair them.

---

## Section 3: Withings contract (Activity API → POST shape; no route geometry)

**Withings has two relevant endpoints** [6] (also catalogued in
`.planning/research/withings-api-coverage.md:140-148`):

- `POST /v2/measure?action=getactivity` — per-day aggregates (steps,
  distance, calories, hr_average, hr_zone_0..3). NOT a workout — lands
  as `Measurement` rows via the v1.4.26 sync routine.
- `POST /v2/measure?action=getworkouts` — per-workout records:
  `{id, category, startdate, enddate, date, timezone, deviceid,
  model, model_id, hr_average, hr_min, hr_max, hr_zone_0..3,
  calories, distance, steps, elevation, pause_duration}` (per W8d
  §4.1 + API ref [6] + the zono-dev/withings-go bindings [7]).

**GPS coverage.** ScanWatch does NOT record route geometry in the
`getworkouts` payload — aggregates only (confirmed against the API
ref [6] and the Reddit thread on Withings vs mobile-app distance
discrepancy [8]). **Decision.** Withings ingest populates `workouts`
only; `workout_routes` stays empty for `source = WITHINGS` rows.

**Withings idempotency.** `workout.id` is an integer unique within a
Withings user but NOT globally; the server-side mapper builds
`externalId` as `"${withings.id}:${withings.model_id ?? "0"}:${
withings.startdate}"`. The `startdate` epoch guards against rare
re-issued IDs after delete + re-sync; `model_id` partitions by device
class.

**Withings ingest is server-to-server.** The cron-driven sync job
(W17b, deferred) fetches `getworkouts`, maps each record to
`createWorkoutSchema` (`source: "WITHINGS"`), and POSTs to the same
`/api/workouts/batch` endpoint with a system bearer token —
funnelling Withings + iOS through one endpoint single-sources the
mapping/audit/rate-limit pipeline.

---

## Section 4: Endpoint Zod schema + idempotency + rate-limit

**Route.** `POST /api/workouts/batch`. Mirrors
`/api/measurements/batch` (`src/app/api/measurements/batch/route.ts`)
in every cross-cutting concern — auth, idempotency, rate-limit, audit,
Wide-Event logging.

**Top-level payload schema:**

```ts
const batchPayloadSchema = z.object({
  workouts: z.array(createWorkoutSchema).min(1).max(MAX_WORKOUTS),
});
```

with `createWorkoutSchema` re-used as-is from
`src/lib/validations/workout.ts` (locked at W8d).

**Auth.** `requireAuth()` (the W10-hardened helper at
`src/lib/api-handler.ts:176-211`). Wildcard iOS tokens pass; narrow-
scope tokens must hold a `workouts:ingest` permission. **Critical** —
the v1.4.25 W10 fix-C (`narrow-scope-token-safe`) rate-limit + scope
contract applies unchanged: a leaked iOS wildcard token must hit the
60/min/user ceiling before it can saturate the write pipeline.

**Idempotency.** Wrap with `withIdempotency<[NextRequest]>` from
`src/lib/idempotency.ts` so an `Idempotency-Key` header replays the
exact response on retry. Per-entry dedup uses the
`@@unique([userId, source, externalId])` composite — Prisma
`createMany({ skipDuplicates: true })`. Mirror the pre-flight
`findMany()` pattern from the measurements batch route
(`src/app/api/measurements/batch/route.ts:215-246`) so the response
distinguishes `inserted` vs `duplicate` per entry — the iOS client
checkpoints its sync cursor past both statuses identically.

**Rate-limit.** `checkRateLimit("workouts:batch:${user.id}", 60,
60_000)` — same window as measurements batch (60 batches/min/user). At
500 workouts × 60 batches/min that's 30 000 workouts/min headroom,
which is multiple orders of magnitude past any healthy iOS sync.

**Prompt-injection surface.** `Workout.metadata` is opaque — the
Coach pipeline reads typed columns only (`sportType`, `durationSec`,
distance, HR). Document this in the route header so a future
"include metadata in Coach prompt" change requires deliberate
escaping. No ingest-path sanitisation.

---

## Section 5: Storage decisions (GeoJSON + sample-timestamps + size caps)

**GeoJSON LineString — already locked in the Zod schema at
`workout.ts:52-61`.** RFC 7946 §3.1.4 mandates `coordinates: [[lon,
lat], [lon, lat, alt?], ...]` with longitude first; the schema enforces
this with `z.tuple([z.number().min(-180).max(180),
z.number().min(-90).max(90)]).rest(z.number())`. Minimum two points
(`.min(2)`) — a single GPS fix isn't a route.

**Sample-timestamps as parallel array.** Stored as a Zod-validated
array of `{ t, speedMs?, hr? }` objects (`workout.ts:70-78`), same
length as `geometry.coordinates`. NULL at the column level when the
source ships a static GPX without per-sample HR/speed (i.e. Withings
when/if they ever surface a route — currently moot).

**Payload-size caps.** Two orthogonal caps:

- **Per-batch workout count.** `MAX_WORKOUTS = 100` (suggested,
  vs 500 for measurements — workouts are heavier). A typical iOS sync
  backfill is "one workout, maybe two" per drain; 100 covers a cold-
  start "import every workout I've ever recorded".
- **Per-route point count.** `MAX_ROUTE_POINTS = 20_000`. Sanity check
  on the LineString — a 24-hour race recorded at 1 Hz is 86 400
  points; 20 000 covers any normal run / ride and rejects pathological
  payloads. Combined with `MAX_WORKOUTS = 100`, the worst-case batch
  is ~2 M points which at ~30 bytes/point JSON-encoded is ~60 MB —
  enforce a global request-body cap at the HTTP layer too.
- **Request body cap.** `5 MB` total (the conservative ceiling cited
  in the task brief). Next.js + Coolify both default to higher
  limits; we enforce via an explicit `Content-Length` check at the
  top of the handler before parsing. Anything above → `413 Payload
  Too Large` with a structured error code so the iOS client can
  resubmit one workout at a time.

**Compression note.** GeoJSON LineStrings JSONB-encode well in
Postgres (lz4 toast compression brings a 5 km route from ~10 KB raw
to ~3-4 KB on disk) — no application-level compression needed.

---

## Section 6: Integration with W16c PR detection (deferred-write pattern)

**PR detection MUST NOT run synchronously in the ingest path.**

1. **Latency.** A cold-start Apple Watch backfill ships dozens of
   workouts per batch; inline PR detection turns a sub-second insert
   into a multi-second rank cycle and risks the handler timeout.
2. **Retry correctness.** If a second-pass PR write fails mid-flight,
   the cached `Idempotency-Key` response replays the original counts
   while DB state diverges. Splitting the write decouples: ingest is
   idempotent; PR detection re-runs safely against the
   `@@unique([userId, metricType, metricSlot, achievedAt])` guard
   (`schema.prisma:500`).

**Mechanism.** After the `createMany` resolves, enqueue a per-user
PR-detection job (deduplicated on `userId` — the worker scans recent
workouts itself, so co-arriving batches coalesce). The
`PersonalRecord.metricSlot` column (W8d, `schema.prisma:483`) is the
per-sport-type bucket — e.g. `"running_5km_time"`,
`"cycling_longest_distance"`. Slot naming is W16c's deliverable, not
W16b's.

The ingest response does NOT need a "PR computed" flag. The iOS UI
polls `/api/personal-records` (the W16c read endpoint, deferred) on
foregrounding — no synchronous coupling.

---

## Section 7: Tests strategy (unit + integration + concurrent-write)

**Unit (Vitest, in-process).**
- `createWorkoutSchema` Zod parsing — happy path, every range bound
  (min HR 20, max HR 300, lat ±90, lon ±180, route ≥2 points,
  duration ≤86 400 s pause, distance ≤1 000 000 m). Already partially
  covered in `src/lib/validations/__tests__/workout.test.ts` if it
  exists; W16b extends it for the batch envelope.
- `mapAppleHealthWorkout()` — HK numeric `activityType` → sport-type
  string union mapping for ≥30 representative codes (running, walking,
  cycling, swimming, hiking, yoga, strength, hiit, rowing, plus an
  "unknown HK code → 'other'" fallback). Lives in
  `src/lib/measurements/__tests__/apple-health-mapping.test.ts` per
  the W8d outline.
- Withings sport-category → sport-type mapping (separate fixture per
  W8d §4.3 — `src/lib/withings/__tests__/workout-categories.test.ts`).

**Integration (real Postgres via the existing test harness in
`src/app/api/measurements/batch/__tests__/`).**
- Happy-path single-workout insert with route. Asserts `Workout` row +
  `WorkoutRoute` row + 1:1 FK.
- Batch of 50 workouts, 10 with routes — verifies per-entry inserted /
  duplicate counts.
- Duplicate replay (same `externalId`) returns `duplicate` status, no
  second row.
- `Idempotency-Key` replay returns the exact cached response body.
- Rate-limit kicks in at 61st request inside 60 s.
- Oversize request body (5 MB + 1 byte) → 413.
- Oversize route (`MAX_ROUTE_POINTS + 1` coordinates) → 422 with the
  structured error code surfaced per-entry, batch survives.
- Schema rejection of an out-of-range coordinate (lat = 91) → 422.

**Concurrent-write (DB-level race).** Mirror the measurements batch
race tests (`src/app/api/measurements/batch/__tests__/route.test.ts`):
two simultaneous batches with overlapping `externalId` resolve to
exactly one DB row each; the per-entry status downgrade from
`inserted` to `duplicate` matches the actual `createMany.count`
(the v1.4.25 W10 fix for the senior-dev H-1 finding —
`measurements/batch/route.ts:270-303`).

**Cross-source dedup (READ-side).** This is W8d's documented v1.5 P1
TODO and is OUT of W16b scope. Note the gap in the test plan so the
reader knows the absence of a cross-source dedup test is deliberate.

---

## Section 8: Open questions for Marc

1. **Endpoint path.** Brief proposed `POST /api/workouts/batch`. The
   v1.4.23 contract is `POST /api/measurements/batch`. Two options:
   (a) standalone `/api/workouts/batch` (cleaner separation, two
   sync endpoints in the iOS client); (b) the W8d outline §4.5
   shorthand `POST /api/measurements/batch?kind=workout` (single
   ingest endpoint with a discriminator). **Recommendation: (a)**
   — workouts have a fundamentally different payload shape (nested
   route geometry, ~200x larger per entry, different rate-limit
   ceiling); a separate route keeps the OpenAPI spec readable for
   the iOS DTO generator and lets the rate-limit / size-cap
   constants live alongside the workout-specific code.

2. **`workouts:ingest` permission scope or wildcard-only?** The
   v1.4.25 W10 narrow-scope-token hardening allows per-route
   permission gates. Wildcard iOS tokens already pass everywhere;
   the question is whether to define a narrow `workouts:ingest`
   scope for future single-purpose server-to-server bridges (n8n
   workout import, Strava webhook, etc.). **Recommendation: define
   the scope string now**, gate the route on it, but keep the iOS
   wildcard token passing (which it does, by W10 contract). Zero
   cost today, future-proofs the route.

3. **HKWorkoutEvent pause/resume markers — preserve as-is in
   `metadata` or distil to `pauseDurationSec`?** Apple ships an
   array of timestamped event markers; the schema has a single
   `pauseDurationSec` Int. The iOS mapper computes the sum before
   upload AND ships the raw event array in `metadata` so doctor-PDF
   can render a pause timeline if a future release wants it.
   **Recommendation: do both** (sum to the Int column, store the
   raw array in `metadata.workoutEvents`). Zero schema cost,
   forward-compatible. Confirm with Marc.

4. **Withings `hr_zone_0..3` storage.** Withings reports time-in-
   each-HR-zone per workout. The W8d outline §4.4 routes this into
   `metadata.hr_zones`. Should the schema gain typed columns
   instead? **Recommendation: stay in `metadata`** — HR zones are
   provider-specific (Apple does NOT compute them server-side;
   they're an iOS-app surface), and a typed column on every workout
   that's NULL for Apple sources adds noise. Confirm.

5. **`sampleTimestamps` validation length.** The Zod schema does
   not currently assert `samples.length === geometry.coordinates.length`.
   Should the ingest endpoint enforce this cross-field invariant
   (Zod `.refine()` at the batch level)? **Recommendation: yes** —
   a desynced pair silently degrades analytics. Trivial to add.

---

## References

[1] RFC 7946 — The GeoJSON Format. IETF Datatracker.
    `https://datatracker.ietf.org/doc/html/rfc7946` (LineString
    geometry: §3.1.4; coordinate order longitude-first: §3.1.1).
[2] Apple Developer — `HKWorkout.init(activityType:start:end:
    workoutEvents:totalEnergyBurned:totalDistance:device:metadata:)`.
    `https://developer.apple.com/documentation/healthkit/hkworkout/init(activitytype:start:end:workoutevents:totalenergyburned:totaldistance:device:metadata:)`.
[3] Apple Developer — `HKWorkoutActivityType` enumeration. 76+ values,
    growing per iOS release.
    `https://developer.apple.com/documentation/healthkit/hkworkoutactivitytype`.
[4] Apple Developer — `HKWorkoutRoute`. Series sample carrying
    CLLocation points captured by `HKWorkoutRouteBuilder`.
    `https://developer.apple.com/documentation/healthkit/hkworkoutroute`.
[5] Apple Developer — `HKWorkoutRouteQuery`. Streams `[CLLocation]`
    samples for a given `HKWorkoutRoute`.
    `https://developer.apple.com/documentation/healthkit/hkworkoutroutequery`.
[6] Withings Developer Documentation v2.0 — Measure-v2 endpoints
    (`getworkouts`, `getactivity`, `getintradayactivity`). Auth scope
    `user.activity` per W5d.
    `https://developer.withings.com/api-reference/`.
[7] `github.com/zono-dev/withings-go/withings` — Go bindings;
    `GetWorkouts` doc cross-references the official endpoint with
    `startdate / enddate / lastupdate` parameters.
    `https://pkg.go.dev/github.com/zono-dev/withings-go/withings`.
[8] Inconsistent workout distance in Withings API vs mobile app —
    Reddit thread confirming ScanWatch workouts ship aggregates only,
    no route geometry, in the public API response (2025-07-06).
    `https://www.reddit.com/r/withings/comments/1lsweep/`.

**Internal references** (HealthLog repo, paths are absolute relative
to repo root):

- `prisma/schema.prisma:380-460` — Workout + WorkoutRoute models.
- `prisma/migrations/0053_workout_and_route/migration.sql` — landed
  migration.
- `src/lib/validations/workout.ts` — `createWorkoutSchema` (W8d-locked).
- `src/app/api/measurements/batch/route.ts` — reference batch ingest
  endpoint (the W10-hardened, narrow-scope-safe template).
- `src/lib/api-handler.ts:176-211` — `requireAuth` contract.
- `src/lib/idempotency.ts:176-230` — `withIdempotency` wrapper.
- `src/lib/rate-limit.ts` — `checkRateLimit` helper.
- `src/lib/analytics/source-priority.ts` — `pickCanonicalSourceRows`,
  the read-time canonical-source picker the future workout
  cross-source dedup helper will mirror.
- `src/lib/personal-records/pr-direction.ts` — PR direction lookup
  (W16c worker consumes this; W16b only enqueues).
- `src/lib/withings/mapping.md` — Withings meastype mapping table
  (workouts row appears in the "Deferred — v1.5" section,
  referencing this research).
- `.planning/research/w8d-implementation-outline.md` §4 — original
  Workout / WorkoutRoute schema rationale.
- `.planning/research/withings-api-coverage.md` §2.4 — Activity /
  Workouts API surface, scope upgrade, deferral notes.
