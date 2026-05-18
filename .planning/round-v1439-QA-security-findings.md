# v1.4.39 QA — Security Review

Scope: `git diff v1.4.38.8..develop` — migrations 0070/0071/0072, mood +
medication-compliance rollup helpers, per-write hooks on every mood and
medication-intake mutation site, `sum_value` column on the measurement
rollup tier, three new pg-boss queues. No new HTTP routes were added.

## Findings

### Critical

_None._

### High

_None._

### Medium

- **F-SEC-M-01 — `enqueueBootTimeMedicationComplianceBackfill` runs a
  cluster-wide discovery query on every authenticated coverage-miss
  request, opening a soft DoS amplification surface.**
  Path: `src/app/api/medications/intake/route.ts:181` →
  `src/lib/medications/compliance-rollups.ts:490-551`.
  On every cache-miss + coverage-miss hit of
  `/api/medications/intake?scope=compliance`, the live-fallback fires a
  fire-and-forget `enqueueBootTimeMedicationComplianceBackfill()`. That
  helper does NOT scope to the caller's user — it issues a single
  `LEFT JOIN medication_intake_events × medication_compliance_rollups`
  scan across **every tenant in the database**. pg-boss `singletonKey`
  collapses the resulting enqueues, so worker load is bounded, but the
  discovery SQL itself runs unguarded on the request path. An
  authenticated user iterating coverage-miss requests across many
  sessions can drive that scan on each hit; on a multi-tenant cluster
  with millions of intake events the planner walks all of them per
  request. Containment: gate the enqueue behind an in-process throttle
  or only fire it when the **caller's** user is uncovered (cheap
  single-row probe before kicking the cluster-wide discovery). Mood-
  rollup's analog (`ensureUserMoodRollupsFresh`) already does this — it
  scopes to a single user.

- **F-SEC-M-02 — `mood_entry_rollups` and
  `medication_compliance_rollups` carry no per-user RLS or query
  enforcement; every read relies on application-layer `userId` filters.**
  Path: migrations 0070 / 0071, plus every `findMany / findFirst /
  upsert` in `src/lib/mood/rollups.ts` and
  `src/lib/medications/compliance-rollups.ts`.
  Inspected: 100 % of new Prisma reads include `where: { userId }` (or
  the composite key includes userId). Inspected: 100 % of new `upsert`
  / `deleteMany` calls include `userId` in the where clause. No leak
  found. The pattern matches the existing `measurement_rollups` tier,
  so this is consistent — but it remains the only tenant-isolation
  layer for the two new tables. Suggest considering Postgres RLS as a
  defense-in-depth step before v1.5 multi-org work lands; not blocking
  for v1.4.39 since the contract matches the pre-existing tier.

### Low

- **F-SEC-L-01 — `recomputeMedicationComplianceForEvent` swallows
  errors silently in best-effort mode; one failure mode (the rollup
  row drifts permanently out of sync with the source intake table)
  has no observability past the `annotate({ medication_compliance_
  rollup_failed: true })` flag.**
  Path: `src/lib/medications/compliance-rollups.ts:277-289`.
  No PII is logged (only `error.message`, no medication name, no
  scheduledFor timestamp). The boot-time backfill plus the per-write
  hook's idempotency mean a single failed recompute self-corrects on
  the next mutation that touches the same `(user, medication, day)`
  tuple. Recommend: a follow-up metric / alert on the annotate flag
  so silent populator drift surfaces in ops dashboards.

- **F-SEC-L-02 — `recomputeUserMedicationCompliance` uses
  `prisma.$queryRaw` (tagged template) with `${safeTz}` interpolated
  into `to_char(... AT TIME ZONE ${safeTz}, 'YYYY-MM-DD')`.**
  Path: `src/lib/medications/compliance-rollups.ts:421-430`.
  Verified: tagged-template form parameterises `${safeTz}` as a bind
  variable (not string interpolation). `safeTz` is run through
  `isValidTimezone()` which whitelists against the IANA zone list, so
  even a "%' OR 1=1" attempt is rejected at the gate. Both belt-and-
  braces — note for the record but no vulnerability.

- **F-SEC-L-03 — `runMoodRollupAggregate` uses `$queryRawUnsafe` with
  an inlined `date_trunc('<unit>', ...)`.**
  Path: `src/lib/mood/rollups.ts:475-510`.
  `truncUnit` is sourced from the closed `DATE_TRUNC_UNIT` enum
  (DAY/WEEK/MONTH/YEAR → `day/week/month/year`) AND validated against
  a hard-coded whitelist (line 485) before splicing. `userId`, `from`,
  `to` are passed as `$1`/`$2`/`$3` parameters. No injection surface;
  mirrors the proven `measurement-rollups` pattern. Logged for the
  record only.

### Audit notes (no finding, recorded for completeness)

- **Migrations 0070 / 0071 / 0072 are additive-only.** No `ALTER` on
  existing tables beyond the additive `ADD COLUMN IF NOT EXISTS
  sum_value` on `measurement_rollups`. FKs on
  `mood_entry_rollups.user_id`, `medication_compliance_rollups.user_id`,
  `medication_compliance_rollups.medication_id` all carry
  `ON DELETE CASCADE` to the parent (correct — owner deletion sweeps
  the cache rows). No `SET NULL` paths that could orphan rows. The
  `IF NOT EXISTS` + `EXCEPTION WHEN duplicate_object` guards mirror
  the established 0067/0068/0069 pattern → replay-safe.

- **Worker queue idempotency:** `MOOD_ROLLUP_RECOMPUTE_QUEUE`,
  `MOOD_ROLLUP_FULL_BACKFILL_QUEUE`,
  `MEDICATION_COMPLIANCE_BACKFILL_QUEUE` all coalesce duplicate sends
  via per-user `singletonKey`. `retryLimit:3 / retryBackoff:true`
  prevent infinite-loop replay. A poisoned job throws once → pg-boss
  records the error and dead-letters after 3 retries. The discovery
  helpers are the only callers that enqueue these; one of them
  (`enqueueBootTimeMedicationComplianceBackfill`) is reachable from a
  request path → see F-SEC-M-01.

- **CSRF / idempotency-key reach intact:** `POST /api/medications/[id]/
  intake` (line 24-26) wraps `postIntake` in `withIdempotency`. The new
  `recomputeMedicationComplianceForEvent` hook (line 166-171) fires
  **after** the idempotency-key short-circuit (line 50-75) and after
  the `assertMedicationOwnership` privacy gate. The hook also fires
  after the `$transaction` create, so a duplicate request reuses the
  existing event without enqueuing a second rollup hit. Verified.

- **Cross-tenant leakage probes:** I searched every new `findFirst` /
  `findMany` / `upsert` / `deleteMany` / `$queryRaw` for missing
  `userId` clauses. All 23 new query sites scope to the authenticated
  user, either via explicit `where: { userId }`, via the composite
  primary key, or via a tagged-template `$queryRaw` parameter. No
  leak found.

- **Per-write hook PII surface:** The new `annotate` calls log only
  `mood_rollup_*_failed: true` / `medication_compliance_rollup_*_failed:
  true` boolean flags plus the JS `Error.message`. No mood text, no
  medication name, no `moodLoggedAt` / `scheduledFor` timestamp ever
  reaches the log payload from the v1.4.39-added sites. (Pre-existing
  backup-creation payload at `reminder-worker.ts:1517-1530` does log
  `medication.name` + `mood`, but that's untouched here and out of
  scope for this review.)

- **Telegram + moodlog + ingest auth paths:** The Telegram webhook
  hook fires only after `findTelegramUser` resolves a user with a
  valid `telegramBotToken`. The moodlog webhook hook fires after the
  X-Webhook-Secret timing-safe compare succeeds. The ingest hook
  fires after `hashToken` validates the bearer + the scope check
  passes. None of the new hooks bypass auth.

- **No new HTTP endpoints.** `git diff --diff-filter=A -- 'src/app/api/
  **/route.ts'` returned zero new route files. All route changes are
  modifications adding hooks to existing endpoints, every one of which
  is auth-gated by the pre-existing `requireAuth` / `withIdempotency`
  / `apiHandler` chain.

## Brief-back (≤200 words)

No Critical or High findings. The v1.4.39 surface is tenant-scoped end
to end: every new Prisma query carries an explicit `userId` clause,
every new raw-SQL fragment is parameterised, the IANA-zone gate added
in v1.4.38 protects the new `to_char(... AT TIME ZONE)` splice, and
the three new migrations are additive with correct CASCADE FK
behaviour. Per-write hooks fire AFTER idempotency / auth / privacy
gates on every site I inspected (medications intake POST is the canary
— hook lands at line 166, well after the auth + ownership + dedup
short-circuits). Worker queues coalesce via `singletonKey` and retry
with backoff.

One Medium worth fixing before ship: F-SEC-M-01 —
`enqueueBootTimeMedicationComplianceBackfill` runs a cluster-wide
discovery `LEFT JOIN` on every coverage-miss request. Mood's analog
already scopes to a single user; the medication path should mirror
that. Cheap one-line fix: probe the caller's `userId` first, only
enqueue boot-backfill when they specifically lack coverage.

Two Lows are observability-only (silent rollup-drift annotate +
follow-up RLS consideration). Three audit-notes captured for the
record. Cleared to ship after F-SEC-M-01 is decided (mitigate or
accept).
