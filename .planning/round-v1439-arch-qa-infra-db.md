# Architecture QA — Infra + DB

Scope: independent senior-level review of HealthLog v1.4.39.3
infrastructure + database layer. Read targets: `prisma/schema.prisma`
(1 910 lines, 44 models), migrations `0067 / 0070 / 0071 / 0072`
(rollup foundation), `src/lib/db.ts`, `src/lib/cache/`,
`src/lib/jobs/reminder-worker.ts`, `src/lib/measurements/rollups.ts`,
`src/lib/mood/rollups.ts`, and the five hottest API routes
(`analytics`, `dashboard/summary`, `measurements`, `mood/analytics`,
`medications/intake`). Spot-checks across `src/app/api/insights/*`,
`src/app/api/sync/*`, and `.planning/round-v1438-perf-analysis.md`.

## Verdict

**sound-with-debt** — the rollup tier architecture (v1.4.34.4 → v1.4.39)
is well-designed and correct (composite PKs, idempotent upserts,
boot-time auto-converge, per-write inline DAY hooks + async WEEK+
worker). Production caching layout, queue topology, FK cascades, and
SQL-injection hygiene are clean. The structural issues are (a) the
rollup tier is **half-consumed** — WEEK/MONTH/YEAR buckets are written
and never read, and the dashboard's progressive-load complaint traces
to several unbounded reads that still live alongside the rollup
fast-paths; (b) a handful of v1.4.30 iOS-future columns
(`syncVersion`, full `deletedAt` consumption across reads) are
write-only ghosts; (c) Insights / aggregator routes have not received
the rollup retrofit and still scan raw `MoodEntry`/`Measurement` per
mount. None of this is a data-risk problem; it is "the architecture
landed correctly but only half the read surface migrated to it."

## Strengths

- **Rollup tier composite PK + descending index is correct.**
  `measurement_rollups @@id([userId, type, granularity, bucketStart])`
  + `@@index([..., bucketStart(sort: Desc)])` guarantees idempotent
  upserts and serves "last N buckets" cheaply. Mirrors hold for
  `mood_entry_rollups` and `medication_compliance_rollups`.
- **FK + onDelete cascades are uniform.** Every per-user child table
  (`Measurement`, `MoodEntry`, `MedicationIntakeEvent`, `Workout`,
  `MedicationInventoryItem`, `MeasurementRollup`, `MoodEntryRollup`,
  `MedicationComplianceRollup`, `Device`, `Passkey`, `Session`,
  `RefreshToken`, `CoachConversation`, `IdempotencyKey`, …) cascades
  on user deletion. `Feedback.user` and `AuditLog.user` use
  `SetNull` to keep the audit trail past account deletion — correct
  GDPR-balanced choice. `PersonalRecord.sourceMeasurementId` is a
  loose pointer (no FK) which is intentional and documented.
- **Boot-time backfill is auto-converging and idempotent.** The
  v1.4.39.1 widening to per-`(user, type, day)` discovery
  (`rollups.ts:769-791`) plus the v1.4.39 W-SUM null-row discovery
  branch is the correct shape — discovery query only matches users
  with gaps; once filled they drop off. Idempotency guaranteed by
  `singletonKey: boot-backfill|${id}` inside pg-boss.
- **SQL injection hygiene is clean.** Every `$queryRawUnsafe` call
  inlines only whitelisted enum values (`measurement_type` cast,
  `date_trunc('day', …)` unit literal validated against a closed
  set) or feeds user data through bound parameters. The grain
  injection at `measurements/route.ts:464` uses `Prisma.raw` with
  a typed lookup map. No interpolated user input found.
- **Cache invalidation fans out correctly per write surface.**
  `invalidateUserMeasurements / Mood / Medications` evict every
  cache that reflects the user's set (analytics, mood-analytics,
  achievements, workouts, insightsTargets, medicationsIntake).
  v1.4.38 W-F added analytics eviction on medication writes for
  the dashboard streak/compliance feed — that fix shows the model
  works.
- **Single-flight in-process LRU is sound.** `ServerCache.wrap`
  registers the in-flight promise on `pending` and removes it on
  reject so a transient failure never poisons the key — the same
  pattern `ensureUserRollupsFreshInFlight` reuses one layer up.

## Issues

### Critical

- *(none observed)* — no data-risk findings.

### High

- **`measurement_rollups` WEEK / MONTH / YEAR rows are write-only.**
  Every measurement write enqueues all three (`rollups.ts:200-221`),
  the worker folds them, and the boot backfill writes them with
  default opts. **No read path consults them** — per the v1.4.38
  perf audit the dashboard's "All / 1 yr" tab still falls through
  to live SQL. Net effect: ~3× write amplification per measurement
  for zero read-side win, plus storage for buckets nothing reads.
  Either wire the WMY reader (`rollup-read-wmy.ts` exists but is
  not the hot-path default) or stop populating WMY until a reader
  ships. The fix is local — gate the async enqueue on a feature
  flag, or remove the WMY granularities from `ALL_GRANULARITIES`.
  This is the single biggest "growth introduced coupling, then we
  didn't finish the harvest" finding.

- **Unbounded `prisma.moodEntry.findMany({ where: { userId } })` in
  six routes.** Pre-rollup-tier shape persisted in:
  - `src/app/api/insights/targets/route.ts:983` (no window)
  - `src/app/api/insights/comprehensive/route.ts:88`
  - `src/app/api/insights/glp1-timeline/route.ts:95`
  - `src/app/api/gamification/achievements/route.ts:607`
  - `src/app/api/mood-entries/route.ts:57` (has `take` so OK)
  - `src/app/api/mood/analytics/route.ts:126` (live fallback only)

  The W-MOOD rollup tier (v1.4.39) exists; only `mood/analytics`
  consumes it. The Insights cluster still scans every mood the
  user ever wrote on every mount. The progressive-load complaint
  on mobile fits this exactly: dashboard tiles backed by analytics
  / mood-analytics paint fast (≤ 500 ms), Insights / Health-Score
  surfaces wait on cold mood scans.

- **Unbounded `prisma.measurement.findMany({ where: { userId,
  type:{in:types} } })` for "latest ever per type".**
  `src/app/api/insights/targets/route.ts:191` runs
  `findMany({ orderBy: measuredAt: desc, distinct: ["type"] })`
  WITHOUT a `measuredAt >=` floor. On Marc's 347 k-row tenant
  Postgres still has to sort the full set before applying
  `DISTINCT ON`. `DISTINCT ON (type) … ORDER BY type, measuredAt
  DESC` with the existing `(userId, type, measuredAt)` index is
  the targeted fix — Prisma's `distinct` does not compile to
  PG's `DISTINCT ON`; it dedups in the driver after pulling the
  rows. Same anti-pattern in `gamification/achievements/route.ts`.

- **Cumulative rollup write-amplification under `Promise.all` is
  fine but the batch ingest hook in `measurements/route.ts:599-608`
  awaits `recomputeBucketsForMeasurement` sequentially.** A 500-row
  Apple-Health batch hitting 10 distinct (type, day) keys serialises
  10 DAY recomputes + 30 pg-boss sends. Either wrap in `Promise.all`
  (cheap — the DAY upsert is a single bounded aggregate) or hand
  off the whole batch to `recomputeUserRollups` once at the end the
  way `apple-health-import-worker.ts:218` already does for imports.

- **`Measurement.deletedAt` is set by the iOS soft-delete path
  (`by-external-ids` route) but no analytics / dashboard read filters
  on it.** `src/app/api/sync/state/route.ts` is the only consumer
  that distinguishes live vs tombstoned. Every other read path
  (`/api/analytics`, `/api/dashboard/summary`, the rollup populator
  aggregate at `rollups.ts:383-414`) includes tombstoned rows in
  the count / mean / sum. This is a latent correctness bug the
  moment iOS soft-deletes the first row: the deleted reading still
  appears in dashboard sparklines and pulls down the average.

### Medium

- **`MeasurementRollup.sumValue` reader coverage is partial.**
  `readRollupBuckets` (`rollups.ts:283-303`) DOES NOT select
  `sumValue`. The two consumers that need the sum
  (`dashboard/summary` and the `measurements?source=rollup` branch)
  select it directly via Prisma. Every other rollup reader silently
  drops the column. Either expose it through `readRollupBuckets`
  or document that it is not part of the canonical reader shape.

- **`MeasurementRollup.r2 / slope` set by `runRollupAggregate` but
  no reader currently consumes them off the rollup table** — the
  comprehensive aggregator + summaries-slice still compute slope/r2
  via the live `$queryRaw` (slope/r2 don't compose linearly across
  buckets). The columns are precomputed dead weight. Two options:
  (a) drop them and accept the live compute, (b) document that the
  rollup's slope/r2 is "per-bucket internal stat" and explicitly
  not the trailing-window slope the readers want.

- **`ensureUserRollupsFresh` warms only DAY for 90 days.** Anything
  the user opens for the "1y" tab on a metric whose DAY buckets are
  stale beyond the 90-day window falls through to live SQL even
  though the WMY buckets sit there fresh from the worker. Same
  half-coupling pattern as the High finding above.

- **`Workout` unique key dedups on `(userId, source, externalId)`
  which means the same workout from MANUAL + iOS HealthKit lands
  twice.** Documented as a TODO at `schema.prisma:605-613`. Real-
  world impact lands the moment iOS Health passthrough ships in
  v1.5. The fix needs to mirror the measurement cross-source
  picker — schedule it now, not after v1.5 ships.

- **`prisma.$transaction([…upserts])` chunk size in
  `persistRollupRows` (`rollups.ts:469`) wraps 500 upserts in a
  single interactive transaction.** This holds a Postgres
  connection for the duration of 500 round-trips. On the Apple
  Health import worker (which then runs a full multi-year fold)
  this can be measured in seconds. Replace with a single multi-
  row `INSERT ... ON CONFLICT DO UPDATE` via `$executeRaw` for
  the bulk-import path; the per-write inline DAY recompute (one
  row) is already fine without `$transaction`.

- **`User.lastSyncedAt` (v1.4.30 column) has exactly one consumer
  (`/api/sync/state`).** It's defended as iOS-foundation. Not a
  bug, but worth flagging: iOS v0.5.4 connected; if the column
  still sees no writer post-iOS-launch, mark it for cleanup.

- **`User.syncVersion` on `Measurement` (v1.4.30, defaults to 1)
  has zero readers or writers in `src/` that increment it.** The
  column was added so iOS can do last-writer-wins; no route bumps
  it on update. Ghosting risk — either wire the increment in the
  PATCH path or drop the column.

- **`caches.moodAnalytics` is keyed `user.id`** (`mood/analytics/
  route.ts:166`) while every other cache is keyed
  `${user.id}|<discriminator>`. `invalidateUserMood` does
  `deleteByPrefix(userId)` which works for both — but `userA` and
  `userAB` (substring) would collide if cuids ever shared a prefix.
  cuids are 25 char fixed and the substring case is theoretical;
  still, standardise the key shape across the eight caches.

- **`caches.bugreportStatus.deleteByPrefix("")` evicts every entry
  on any admin-settings write** (`invalidate.ts:96-98`). That's
  fine for a singleton cache, but with the comment "the cache is
  keyed on the singleton" the empty-prefix call is opaque. Rename
  to `caches.bugreportStatus.clear()` (add the method) or pass
  `"singleton"` explicitly.

### Low

- **Migration `0061_audit_log_carrier` adds `asn` + `carrier` as
  nullable WITHOUT a backfill of the geo-backfill cron's first
  run.** Acceptable (the cron auto-converges) but worth noting:
  the v1.4.27 release announced the columns are populated, but
  every audit row pre-cron is null until the hourly job catches
  up. The hourly cap of 5 000 rows means a tenant with > 5 k
  legacy audit rows takes hours to converge.

- **`Measurement.deviceType` is `String?` rather than an enum** —
  documented decision, but the v1.4.25 W8c enum lives in TypeScript
  (`deviceTypeEnum`). DB-side check constraint would catch a
  client that ships a typo like `"Watch"` (capitalised).

- **`MedicationComplianceRollup.day` is `String` (YYYY-MM-DD) not
  `DATE`.** Documented as multi-instance-safe, fine for the read
  path. Cost: range queries can't use a `DATERANGE` operator and
  bytewise lex compare relies on the fixed 10-char shape. Add a
  CHECK constraint that day matches `^\d{4}-\d{2}-\d{2}$` so a
  bad writer can't slip a non-conforming string in.

- **`HostMetric` table has no TTL trigger.** Documented as "7-day
  retention enforced inside the sampler" — that's an application-
  layer DELETE that runs per sample. Lightweight, but a forgotten
  worker turns this into an unbounded table. Add a Postgres
  partition or row-level expire trigger for defence-in-depth.

- **`prisma/migrations/0067_v1434_measurement_rollups/migration.sql`
  uses `IF NOT EXISTS` everywhere** — good for replay safety. But
  the FK `ALTER TABLE` is not guarded by an `EXCEPTION WHEN
  duplicate_object` block (0070 / 0071 do guard it). Inconsistent.
  If the migration is replayed on an instance that already
  carries the FK, 0067 throws. Make the three rollup migrations
  identical in guard shape.

- **`AuditLog @@index([userId, createdAt])` covers the per-user
  view, but `@@index([action, createdAt])` lets the admin "all
  recent logins" view scan only one action. The admin audit
  endpoint at `src/app/api/admin/audit-log/route.ts` should be
  verified to actually use both branches — confirm via `EXPLAIN`.

## Ghosting / dead code

- **`User.syncVersion` on `Measurement`** — column added in v1.4.30
  to support last-writer-wins reconciliation; zero readers, zero
  writers that bump it on update.
- **`MeasurementRollup.slope` and `MeasurementRollup.r2`** —
  populated by `runRollupAggregate`, no current reader.
- **`MeasurementRollup` WEEK / MONTH / YEAR rows** — written by
  worker + boot backfill, no read path consumes them.
- **`MedicationCategory.GLP1`-related side-effect logging coverage**
  — surface is wired and the schema is sound, but the side-effect
  read in the Coach snapshot path is not yet on the rollup tier.
  Low priority (cardinality is small).
- **`RateLimit @@index([resetAt])`** — used by a hypothetical
  cleanup query; the actual rate-limit code (`src/lib/rate-limit.ts`)
  upserts by `key` and never queries by `resetAt`. The cleanup
  cron (`RATE_LIMIT_CLEANUP_QUEUE`) does use it, so the index is
  paid-for. Keep, but verify the cleanup cron is actually
  registered (it is — `reminder-worker.ts:1675`).
- **`AppSettings.adminAiInsightsFeedbackSummary`** — written by the
  feedback aggregator; the admin dashboard reads it. Not dead, but
  the column type is a free-form `Json?` with the shape documented
  only in a comment. Worth a Zod parse at read time.

## Top 3 recommendations

1. **Read-swap the Insights cluster onto the rollup tier**
   (`/api/insights/targets`, `/api/insights/comprehensive`,
   `/api/insights/cards`, `/api/insights/glp1-timeline`,
   `/api/insights/generate`, plus the gamification mood read). The
   pattern is documented and proven (W-MOOD + dashboard/summary).
   Replace the unbounded mood / measurement `findMany` calls with
   `readRollupBuckets / readMoodDayRollups` + per-type fast-paths.
   Impact: 5-10× wall-clock improvement on Insights cold mount,
   removes the "burst all at once vs progressive" UX complaint.
   Effort: 1-2 days, mechanical pattern.

2. **Either harvest or stop populating WEEK / MONTH / YEAR
   buckets.** Either (a) wire `rollup-read-wmy.ts` into the
   `aggregate=weekly|monthly` branch of `/api/measurements` and the
   "All / 1y" dashboard tabs and reap the read-side win, or (b)
   shrink `ALL_GRANULARITIES` to `["DAY"]` until the reader ships.
   Today is the worst of both worlds — write cost, no read win.
   Impact: 3× reduction in per-measurement-write work *or* unlocks
   the long-range-tab perf. Effort: 0.5 day either direction.

3. **Wire `Measurement.deletedAt` filtering into every analytics
   read path or drop the column.** Either add
   `deletedAt: null` to every `where: { userId, … }` on
   `Measurement` (and the SQL aggregates), or remove the soft-
   delete flag from the iOS sync endpoint and use hard deletes.
   The current state — column exists, one route filters, every
   other reader returns tombstoned rows — is a correctness bug
   that lands the moment iOS soft-deletes its first reading.
   Impact: correctness, prerequisite to v1.5 iOS launch. Effort:
   0.5 day grep-and-patch.

---

Reviewer's broader read: the v1.4 cycle's rapid sub-release cadence
shipped a structurally sound rollup architecture, but the read-side
migration is half-done. Marc's "burst on mobile" intuition is correct
— it traces to (a) Insights/aggregator routes not yet on rollup, (b)
WMY tier write-cost without read benefit, (c) batch ingest hooks
serialising recomputes. None of this is a "wrong architecture"
problem; it's a "finish migrating the read surface to the tier you
already built" problem. The strangler-fig pattern is correctly used
where it has been applied (`source=rollup` opt-in, coverage probe
gate, live fallback on miss). Apply it to the remaining routes.
