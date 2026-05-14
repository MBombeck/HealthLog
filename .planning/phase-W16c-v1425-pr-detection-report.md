# W16c — PR Detection worker — phase report

**Version:** v1.4.25
**Branch:** develop
**Date:** 2026-05-14
**Touched files:** new worker, new pg-boss queue, hooks on two batch routes, dispatcher policy, settings + matrix UI, insights badge, six locales, two unit-suite extensions, one integration suite.

## Commits

1. `05c20c9` — feat(personal-records): detection worker — MAX/MIN per metric, workout slots, warmup gate
2. `4600c23` — feat(jobs): pr-detection pg-boss queue (concurrency=5, 30min fallback cron)
3. `7b7a896` — feat(api): batch routes enqueue pr-detection (silent on >50 batch)
4. `15a72bb` — feat(notifications): personal-records push opt-in toggle (default OFF)
5. `e51a4f5` — feat(insights): PR badge on metric trend tiles when achieved in last 30 days
6. `223b8a9` — test(personal-records): detection worker + queue + UI badge coverage

## Functional coverage

- **Worker** at `src/lib/personal-records/pr-detection-worker.ts`. Scans every PR-trackable Measurement type via `getPRDirection` and writes the all-time best per metric. Workout slots: longest_run_duration / longest_distance_run / fastest_5km_time + cycling parallels. 7-sample warm-up gate per metric. Ties write a row but flag as push-suppressed.
- **pg-boss queue** `pr-detection` registered alongside existing 12+ queues in `reminder-worker.ts`; concurrency=5; 30-minute fallback cron iterates every user as safety net. `enqueuePrDetection()` helper in `src/lib/jobs/pr-detection.ts` is a silent no-op when no boss instance is attached (test contexts).
- **Batch ingest hooks**: both `/api/measurements/batch` and `/api/workouts/batch` enqueue after a successful insert; batches > 50 entries set `silent: true` so multi-year Apple Health / HKWorkout backfills don't fire hundreds of pushes. Audit-logged either way; enqueue failures are swallowed + annotated so a flaky queue cannot 500 an ingest request.
- **Push opt-in**: `PERSONAL_RECORD` event type added. `EVENT_DEFAULT_ENABLED[PERSONAL_RECORD] = false` flips the dispatcher's default for this event from opt-out to opt-in. `/notifications` matrix renders the toggle automatically (iterates `EVENT_TYPES`). All six locales carry `notifications.eventPersonalRecord*`.
- **Insights badge** at `src/components/insights/personal-record-badge.tsx`. Reads `GET /api/personal-records?metricType=X`, renders a small text-only "PR" pill when the most recent record's `achievedAt` is within 30 days. Locale-aware tooltip (`{value} {unit} on {date}`). `withTooltip={false}` for standalone uses.
- **Integration** at `tests/integration/pr-detection-end-to-end.test.ts`. Real Postgres testcontainer; covers steps PR, RHR PR, VO2 max with silent flag, idempotency on re-run, drift guard against every PR-trackable metric.

## Key finding — schema gap, application-level fix

The `(userId, metricType, metricSlot, achievedAt)` unique index on `personal_records` (Migration 0054) is NULLS-DISTINCT in Postgres. Measurement-driven rows always have `metricSlot = NULL`, so the index does not dedup them — a naive re-run of the worker writes a second row at the same `achievedAt`. **Fix shipped in this phase:** application-level pre-flight `findFirst` on the same composite key before each insert. Workout-side rows (slot non-null) keep using the DB index; measurement-side rows now have a redundant but correct application guard. A future Migration 0055 (post-v1.4.25 freeze) can re-add the `NULLS NOT DISTINCT` clause to the index, at which point the application guard becomes a no-op.

## Tests

- Worker unit suite — 20 tests (warm-up gate, MAX/MIN direction, null-direction suppression, tie behaviour, idempotency, multi-source ties, workout slots × 3, silent flag propagation, drift guard, pure compare helper).
- `enqueuePrDetection` unit suite — 3 tests (no-boss no-op, payload shape, silent default).
- Dispatcher unit suite extension — 3 tests (PR default OFF, opt-in respected, legacy events stay opt-out).
- Batch route unit suites — 5 new tests across measurements + workouts (silent on >50, silent off on <=50, still enqueues for all-duplicate batches).
- Badge component unit suite — 5 tests (renders / absent / stale / workout-slot ignored / locale parity).
- Integration suite — 4 tests against real Postgres.

Total: **+40 unit tests, +4 integration tests** across the 6 commits.

## Quality gates

- `pnpm typecheck` — clean across all commits
- `pnpm lint` — clean across all commits
- `pnpm test` — 481 tests in touched directories all pass
- `pnpm openapi:check` — in sync
- `pnpm test:integration tests/integration/pr-detection-end-to-end.test.ts` — 4/4 pass

## Coexistence with parallel W19b agent

W19b shipped Migration 0056 (`medication_inventory_item`) and added a parallel pg-boss queue (`medication-inventory-expire`). Their `reminder-worker.ts` edits land alongside mine — no merge conflicts; both queues registered separately. W19b's i18n additions are in the `medications.inventory.*` namespace; mine are in `insights.personalRecord.*` and `notifications.eventPersonalRecord*` — disjoint.

## Deferred to v1.4.26

- **Migration 0055 (post-v1.4.25)**: `NULLS NOT DISTINCT` on the `personal_records_dedup_key` index would let the worker drop the application-level findFirst pre-flight. Tracked separately — application guard is fine for now.
- **Workout PR detection wider slot vocabulary**: current scope ships running/cycling slots (longest duration, longest distance, fastest 5 km). Swim, strength, pace-band, elevation-gain slots wait for the v1.5 workout dashboards.
- **User-triggered "Reset PRs" button** in `/settings/data` — research §5.5 design lives in the W16c research doc; worker can rescan from scratch via the existing handler, button + confirmation modal pending UX.
- **Doctor report `recentRecords` slice** (research §4.3) — separate phase; the badge + matrix toggle are the front-end consumers shipped in W16c.
- **Coach grounding evidence chips** (research §4.4) — Coach snapshot extension separate from W16c scope.
