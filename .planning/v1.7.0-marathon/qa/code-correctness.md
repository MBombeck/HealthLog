# v1.7.0 Code-Correctness Review

Reviewer: senior code-correctness (read-only). Diff: `main..release/v1.7.0` (~36 commits).
Scope: correctness bugs / logic errors / edge cases / races. Style ignored.

Severity counts: Critical 0 · High 2 · Medium 5 · Low 4

---

## High

### H1 — Snapshot-flag dashboard shows EmptyState during first-paint instead of a skeleton
File: `src/app/page.tsx:1380-1383` (and the empty-state gate at `:1399-1420`)

Bug: the tile-strip skeleton gate is
```
const showTileStripSkeleton =
  trendCards.length === 0 &&
  analyticsSlimQuery.isLoading &&
  configuredTileCount > 0;
```
When `NEXT_PUBLIC_DASHBOARD_SNAPSHOT=true`, `analyticsSlimQuery` is created with `enabled: !snapshotEnabled && isAuthenticated` → `false`. A disabled TanStack Query (v5) has `fetchStatus: "idle"`, so `isLoading` is **always `false`**. While `useDashboardSnapshot` is still in-flight, `snapshotQuery.data` is `undefined` → `data` is `undefined` → `trendCards`/`charts` are empty → `showTileStripSkeleton` is `false` → the empty-state branch at `:1399` fires. The user sees the "no data, log a measurement" EmptyState for the entire snapshot fetch, then it snaps to the populated strip. That is exactly the "blocked-then-burst"/flash the snapshot work set out to remove.

Fix: gate the skeleton (and suppress the empty state) on the active data source's loading flag. In snapshot mode use `snapshotQuery.isLoading` (or `snapshotEnabled && snapshotQuery.data === undefined`):
```
const primaryLoading = snapshotEnabled
  ? snapshotQuery.isLoading
  : analyticsSlimQuery.isLoading;
const showTileStripSkeleton =
  trendCards.length === 0 && primaryLoading && configuredTileCount > 0;
```
and add `&& !primaryLoading` to the empty-state guard at `:1399`.

### H2 — Multi-time-of-day Telegram reminders re-fire because the ledger is wiped per medication
File: `src/lib/notifications/senders/telegram.ts:27-52, 79-81` interacting with `src/lib/jobs/reminder-worker.ts:617-676`

Bug: SB-SCHED-4 added per-slot dedup keyed `(medicationId, scheduleId, date, phase, timeOfDay)`. But `sendViaTelegram` still calls `deleteExistingReminders(botToken, medicationId)` which `deleteMany({ where: { medicationId } })` — it deletes **every** ledger row for the medication (all dates, all phases, all times-of-day) before sending the new message. For a schedule with `timesOfDay = ["08:00","20:00"]`, when the 20:00 slot dispatches it deletes the 08:00 ledger row. The worker's dedup check (`telegramReminderMessage.findUnique` at `reminder-worker.ts:659`) then finds nothing for the 08:00 slot on the next tick whose 08:00 window is still in the same phase, and re-sends the morning reminder. Net effect: duplicate/repeated morning reminders whenever two time-of-day windows for the same medication overlap a phase within a day. The pre-v1.7 single-slot model never hit this because there was only ever one live row per medication.

Fix: scope the pre-send delete to the slot being replaced, not the whole medication, e.g. `deleteExistingReminders(botToken, medicationId, scheduleId, date, phase, timeOfDay)` deleting only `{ medicationId, scheduleId, date, phase, timeOfDay }` (the same composite the upsert keys on). If the "max one active Telegram message per medication" UX is intentional, then the worker dedup must not rely on a row that the sender will delete — move the dedup ledger to a separate non-deleted table, or guard the delete to only remove messages whose slot has advanced past its phase.

---

## Medium

### M1 — `due` / `expectedCount` cross-timezone off-by-one in the daily compliance heatmap
File: `src/app/api/medications/[id]/compliance/route.ts:77-83, 148-153` + `src/lib/analytics/compliance.ts:260-303`

Bug: the 90-day loop builds `dayStart`/`dayEnd` as UTC-midnight-aligned slices (`now - (d+1)*DAY` … `now - d*DAY`) and the `dateKey` is the UTC slice (`dayStart.toISOString().slice(0,10)`). `expectedSlotCountForDay` then calls `occurrencesBetween(canonical, dayStart, dayEnd-1ms)`, and the engine applies `timesOfDay` in the **user timezone**. For users far from UTC (e.g. Pacific/Auckland +13, America/Los_Angeles -8), the user-tz dose instant can land in the adjacent UTC slice from the one the `dateKey` labels. The `due`/`expectedCount` flag then attaches to the wrong calendar day in the heatmap (a "due" mark one cell off). `compliance7`/`compliance30` are unaffected (they group by local day inside `calculateCompliance`).

Fix: compute `dayStart`/`dayEnd` as user-tz local-day boundaries (reuse `startOfLocalDay` / the tz helpers in `cadence.ts`) and key `dateKey` off the user-tz day, matching the engine's frame of reference.

### M2 — Pre-generation cron does nothing in the 20–24 h cache window (20h discovery vs 24h generate TTL)
File: `src/lib/jobs/insight-pregenerate.ts:58, 95-109` + `src/lib/insights/comprehensive-generate.ts:51, 196-201`

Bug: discovery selects users with `insightsCachedAt < now-20h`, and the per-user budget bucket is 20h. But `generateComprehensiveInsight` re-checks the cache and returns `{status:"cached"}` (no LLM) when `now - insightsCachedAt < 24h` (CACHE_TTL_MS). So a user whose cache is 20–24h old is discovered, consumes the budget bucket, then short-circuits to `cached` — no pre-generation occurs. Pre-generation only actually fires once the cache is fully expired (>24h), which is precisely the lazy-on-mount path the cron was meant to pre-empt. The "warm the cache before the user's morning visit" intent is defeated for the common case.

Fix: pass a `force` flag from the cron into `generateComprehensiveInsight` (regenerate regardless of the 24h TTL) OR align the generate-side staleness check to the cron's 20h threshold. The budget bucket already prevents runaway cost.

### M3 — Soft-deleted measurement still returned by `GET /api/measurements/[id]`
File: `src/app/api/measurements/[id]/route.ts:27-43`

Bug: v1.7.0 converted DELETE to soft-delete (`deletedAt` set). The CLAUDE.md/PR contract is "every list / analytics / rollup read filters `deletedAt: null`." The single-resource `GET` still does `findUnique({ where: { id } })` with no `deletedAt` filter, so a tombstoned row is returned with full data on a direct GET (and PUT at `:53` can resurrect-edit it — `update` on a soft-deleted row succeeds and does not clear `deletedAt`, leaving an edited-but-still-tombstoned row). Inconsistent with the read-path invariant.

Fix: add `deletedAt: null` to the GET (return 404 for tombstoned) and to the PUT existence check, or have PUT explicitly refuse to edit a tombstoned row.

### M4 — Per-slot intake-count suppression depends on `timesOfDay` array order
File: `src/lib/jobs/reminder-worker.ts:617-631`

Bug: the multi-slot loop iterates `schedule.timesOfDay` in stored order and uses `if (eventCount > schedulesProcessed) { schedulesProcessed++; continue; }` to suppress reminders once "enough" intakes are logged. `eventCount` is the medication's total intake events today, undifferentiated by slot. If `timesOfDay` is stored unsorted (e.g. `["20:00","08:00"]`), the suppression attributes a logged morning dose to whichever slot iterates first (the 20:00 slot), so the evening reminder can be suppressed while the morning reminder still fires. The count→slot mapping is positional, not time-matched.

Fix: sort `slotTimes` chronologically before the loop, and ideally match logged intakes to slots by time-of-day proximity rather than a positional running counter, so a partially-dosed day reminds for the correct missing slot.

### M5 — `expandScheduleSlots` engine path is inclusive of `to`; legacy path is half-open `[from,to)`
File: `src/lib/medications/scheduling/cadence.ts:277-287` vs `:332` (`if (wStart >= to) continue;`)

Bug: the legacy walker excludes a slot at exactly `to` (`wStart >= to → continue`). The v1.7.0 engine path calls `occurrencesBetween(canonical, from, to, …)` which is inclusive of both ends (per the engine doc and `recurrence.ts:133`). So a dose landing exactly at the window boundary `to` is counted by the engine path but not the legacy path. In `buildCadenceTimeline`/compliance this can shift a boundary slot's inclusion between the canonical and legacy branches, producing a one-slot denominator difference at the exact window edge for canonical-shape schedules. Low-frequency (requires a dose instant exactly equal to `asOf`/`to`), but it is a behavioural divergence between the two branches the release explicitly claims are equivalent.

Fix: pass `new Date(to.getTime() - 1)` to `occurrencesBetween` in the engine branch (as `expectedSlotCountForDay` already does at `compliance.ts:296-298`) to make both branches half-open `[from, to)`.

---

## Low

### L1 — `consolidate-daily-mean` resolves the unit via a query that can return a soft-deleted row's unit
File: `src/lib/measurements/consolidate-daily-mean.ts:222-223, 304-313`

`resolveCanonicalUnit` does `findFirst({ where: { userId, type, source } })` with no `deletedAt: null` filter, and is called inside the day loop after earlier days in the same run may have soft-deleted per-sample rows. The unit is read from the in-hand `dayRows` conceptually but actually re-queried; it can pick up a soft-deleted row's unit. Units are homogeneous per type so this is harmless today, but it is an unnecessary extra query per day and reads from tombstoned rows. Use `dayRows[0]`'s unit (carry `unit` in the `PerSampleRow` select) instead of a separate query.

### L2 — Cyclic on/off-week gate uses UTC week start while inner cadence uses user-tz days
File: `src/lib/medications/scheduling/recurrence.ts:183-202`

`isInCyclicOnWeek` snaps anchor + instant to `startOfUtcWeek` (Sunday, UTC) while RRULE/legacy day emission applies time-of-day in the user timezone. A slot late on a Sunday-local night (already Monday UTC, or vice versa) can be assigned to the adjacent UTC week, flipping its on/off classification at the cycle boundary. Same UTC-week convention as the legacy `intervalWeeks` stride (`:488-498`), so internally consistent, but both share the cross-tz week-boundary edge. Consider anchoring the cyclic phase to the user-tz week to match day emission.

### L3 — Snapshot `extras: null` and `briefingState` cached together for 60 s can lag a mid-window convergence/regeneration
File: `src/app/api/dashboard/snapshot/route.ts:73-78` + `src/lib/dashboard/snapshot.ts:421-431`

The full snapshot (including `extras: null` on a coverage miss and `briefingState: "preparing"`) is cached 60 s keyed `${userId}|dashboard-snapshot`. If the boot rollup-backfill converges or the pre-generate cron writes a fresh briefing within that 60 s, the user keeps seeing the stale `null`/`preparing` until expiry. The pre-generate path does call `invalidateUserInsights` so a regenerate evicts it; the rollup-coverage convergence has no such eviction hook, so the BD/glucose tiles stay shimmering up to 60 s after coverage warms. Acceptable per the two-phase design; documented here as the known staleness window. No fix required unless faster convergence is desired (add a coverage-warm eviction).

### L4 — Sync feed `cursorExpired` horizon keys on `updatedAt`, but a re-deleted tombstone bumps `updatedAt` forward
File: `src/app/api/sync/changes/route.ts:111-123` + `src/app/api/measurements/[id]/route.ts:194-200`

A replayed soft-delete re-bumps `syncVersion` and `updatedAt` (idempotent at data level), pushing the tombstone's `updatedAt` forward past the retention horizon. That is benign (the row simply re-surfaces as a tombstone on the next delta, which the client re-applies idempotently). But it means a re-deleted row's effective retention extends indefinitely on each replay; the tombstone-cleanup job keys on `deletedAt`/`updatedAt` — confirm the cleanup horizon and the feed's `cursorExpired` horizon use the same column so a row can't be pruned while still inside a client's reachable cursor window. Verify `measurement-tombstone-cleanup` prunes on the same field the feed's `retentionHorizon` compares against (`cursor.updatedAtMs < now - RETENTION`). If cleanup prunes on `deletedAt` but the feed gates on `updatedAt`, a row deleted long ago but with a recent `updatedAt` replay is safe, but a row with old `updatedAt` and recent `deletedAt` mismatch could theoretically be pruned inside a live window. Low risk; worth a one-line assertion in the integration test.

---

## Areas verified clean

- Display-transform (`display-transform.ts`, `valueScale`): applied at render layer only; `health-chart.tsx:654` scales the in-memory series, never written back. FHIR (`build-bundle.ts`) and the doctor PDF consume `DoctorReportData` (canonical SI) directly — no km/h or km leak into stored/FHIR values. `valueScale` correctly participates in the `queryKeys.chartData` factory tuple so scaled series don't poison the raw cache.
- PRN: `occurrencesBetween` returns `[]` (recurrence.ts:148) and `nextOccurrenceAfter` returns null (`:221`) — PRN excluded from projection, reminders, compliance-expected; still loggable. Correct.
- `HIGH_FREQUENCY_MEAN_TYPES` is disjoint from `CUMULATIVE_HK_TYPES`; PULSE deliberately excluded from both. Mean drain scopes to `source='APPLE_HEALTH'`, excludes `stats:%` rows and `deletedAt`-set rows → idempotent re-run converges to zero. Upsert + soft-delete run in one `$transaction`.
- Coach snapshot soft-cap (`degradeToBudget`): walks reverse cluster priority, degrades lowest-signal clusters first across drop-recent → drop-weekly → drop-block passes; core clinical clusters (medication/cardio/glucose) degrade last. Measures against the pretty-printed form that actually ships. Multi-cluster window cap correctly spares core clusters.
- RRULE expansion: guards against user COUNT/UNTIL colliding with the engine UNTIL suffix (`:398`), pads the day-anchor window ±2 days for tz-shifted times-of-day, caps the walk at MAX_CHUNKS + 10-year hardCap. Parse failure returns `[]` with annotation, never throws.
- Sync keyset cursor: `(updatedAt, id)` total ordering with `take: limit+1` hasMore detection; tombstones-vs-upserts correctly split by `deletedAt`; `decodeCursor` returns null on garbage → treated as clean initial sync. Pagination is correct at same-millisecond page boundaries.
- Cache invalidation: dashboard-snapshot key lives under the analytics bucket so the `${userId}|` prefix sweep covers measurement/mood/medication writes; widget + insight invalidators (which don't touch analytics) call `invalidateUserDashboardSnapshot` explicitly. No stale-snapshot gap on mutation.
- Compliance denominator: skipped doses excluded from denominator, empty window returns rate 100, streak advances on no-expected-dose days, `medicationCreatedAt` floors the window. Legacy fallback (no medicationContext) is byte-stable.
