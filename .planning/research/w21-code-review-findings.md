# W21 Code Review Findings — v1.4.25 release-candidate

**Reviewer**: code-reviewer
**Scope**: full diff `v1.4.24..HEAD` (~266 commits)
**Date**: 2026-05-14

## Summary

- One real correctness bug in the inventory PATCH endpoint: `markAsFirstUseAt` mechanically forces `IN_USE` without re-running the state machine, so a back-dated first-use can land in `IN_USE` when it should be `EXPIRED`.
- Cadence + compliance pure modules ignore the per-user timezone resolver added in W17b — they fall through to host TZ. Single-region deploy (Europe/Berlin) masks this today; locked-in regression once iOS users cross zones.
- Side-effect taxonomy has three parallel sources of truth (Prisma enum, taxonomy map, validator string literal array) with no drift-guard test linking them.
- PR detection workflow is sound but `expireStaleInUseItems` loops `prisma.update` one row at a time — fine at current scale, awkward at fleet scale.
- New surfaces (W14b onboarding, W19c–f medications, W16b workouts, W16c PR detection) carry strong pure-helper test coverage; the integration tests have a gap on the PATCH state-machine edge.

## Critical

_None._ No data-loss path, no deploy-blocker. v1.4.25 is shippable on the code-review axis pending the High items below.

## High

### H1. Inventory PATCH leaves pen in `IN_USE` after back-dated first-use that should be `EXPIRED`

- **Issue**: `PATCH /api/medications/[id]/inventory/[itemId]` accepts `markAsFirstUseAt` (any ISO datetime within Zod range). The handler sets `nextState = "IN_USE"` whenever the prior state was `ACTIVE`, without calling `computeInventoryState` against the new `expiresAt`. If the user back-dates first-use to >30 days ago, the row should land in `EXPIRED`; it lands in `IN_USE` and stays there until the daily cron picks it up.
- **Where**: `src/app/api/medications/[id]/inventory/[itemId]/route.ts:73–101` (commit `34ec6d3b` / `15a72bb3`)
- **Why it matters**: contradicts the state-machine contract documented in `src/lib/medications/inventory/state-machine.ts:7–22`. The cron eventually corrects it (worst case ~24h drift), but the API response and the immediate UI render are wrong. Daily `expireStaleInUseItems` scan also re-touches the row unnecessarily.
- **Fix pattern**: after computing `nextExpiresAt`, run the same view through `computeInventoryState({ state, dosesTotal, dosesRemaining: nextDosesRemaining, firstUseAt: nextFirstUseAt, printedExpiry: nextPrintedExpiry }, Date.now())` and persist that result. Add a test in `src/app/api/medications/[id]/inventory/__tests__/route.test.ts` with `markAsFirstUseAt` set to `now - 35d` asserting the response state is `EXPIRED`.

### H2. Cadence + compliance helpers ignore per-user timezone

- **Issue**: `applyTime`, `startOfLocalDay`, `startOfLocalWeek`, and `localDayKey` in `src/lib/medications/scheduling/cadence.ts:72–91` and `src/lib/medications/scheduling/compliance.ts:43–48` use the host's `Date` API (`setHours(0,0,0,0)`, `getDay()`). On the server this runs in `process.env.TZ=Europe/Berlin` (Dockerfile). The `User.timeZone` column shipped in migration `0043_per_user_timezone` and the `resolveUserTimeZone` helper added in W17b are never consulted.
- **Where**: `src/lib/medications/scheduling/cadence.ts:72–91`, `src/lib/medications/scheduling/compliance.ts:43–48` (commits `4af09170`, `3ef49679`)
- **Why it matters**: a user in `America/Los_Angeles` calling `GET /api/medications/[id]/cadence` gets a Berlin-day timeline. Schedule windows like `08:00–10:00` apply against Berlin midnight, not LA midnight. With only Marc on the box today this is invisible; with v1.5 iOS sync landing real-world users on other zones, the cadence chart and compliance chips will mis-bucket on every cross-day query. The `anchor` plumbing exists but the day-boundary math doesn't.
- **Fix pattern**: thread `timeZone: string` into `expandScheduleSlots`, `pairDoses`, `buildCadenceTimeline`, `complianceChips`. Use `Intl.DateTimeFormat` parts (or `date-fns-tz`) to compute local day boundaries. Cadence route resolves `timeZone` via `resolveUserTimeZone(user)` and forwards. Mirror the pattern the `tz/resolver.ts` work already established.

### H3. `expireStaleInUseItems` is N+1 — one `prisma.update` per stale row

- **Issue**: `src/lib/medications/inventory/service.ts:113–139` `findMany`'s the candidate rows then loops `prisma.medicationInventoryItem.update({ where: { id }, data: { state } })` per row.
- **Where**: `src/lib/medications/inventory/service.ts:113–139` (commit `15a72bb3`)
- **Why it matters**: at Marc's scale (one user, <10 active pens) this is a no-op. At fleet scale the daily 03:30 cron can fan out to N user × ~5 pens worth of round-trips per night — a thousand sequential SQL writes for what is a single `UPDATE … WHERE state='IN_USE' AND expires_at < $now`. The pure state-machine returns only the single deterministic transition `IN_USE → EXPIRED` for this branch, so the bulk write is safe.
- **Fix pattern**: replace the loop with `prisma.medicationInventoryItem.updateMany({ where: { state: 'IN_USE', expiresAt: { lt: now }, ...(userId ? { userId } : {}) }, data: { state: 'EXPIRED' } })`. Keep the row-loop only behind a feature flag if you ever want to surface per-row audit logs (none today).

## Medium

### M1. Side-effect taxonomy has three drift-prone sources of truth

- **Issue**: the entry vocabulary lives in (a) `prisma.schema.prisma` enum `MedicationSideEffectEntry`, (b) `SIDE_EFFECT_CATEGORIES` / `SIDE_EFFECT_ENTRIES_BY_CATEGORY` in `src/lib/medications/side-effects/taxonomy.ts`, and (c) the string-literal array `SIDE_EFFECT_ENTRY_VALUES` in `src/lib/medications/side-effects/validators.ts:26–48`. The validator array is hand-typed from the same EMA list, not derived. There is no drift-guard test asserting the three stay in sync.
- **Where**: `src/lib/medications/side-effects/taxonomy.ts:36–116`, `src/lib/medications/side-effects/validators.ts:18–48` (commit `4e2b7be4`)
- **Why it matters**: adding a 22nd entry on the EMA list requires three coordinated edits; missing the validator means the new entry returns 422 forever even though it's in the schema. `SIDE_EFFECT_ENTRY_COUNT = 21` is hard-coded too.
- **Fix pattern**: derive `SIDE_EFFECT_ENTRY_VALUES` from `Object.keys(SIDE_EFFECT_CATEGORIES)` and `SIDE_EFFECT_ENTRY_COUNT` from its length. Add a drift-guard test that imports the Prisma `MedicationSideEffectEntry` runtime object and asserts `Object.values(...).sort()` equals the validator array sorted.

### M2. Workout schema accepts `endedAt < startedAt`

- **Issue**: `createWorkoutSchema` in `src/lib/validations/workout.ts:105–140` validates each timestamp individually but does not enforce `endedAt > startedAt`. The route handler `Math.max(0, …)` clamps `durationSec` to 0, but the row still lands with a backwards interval that downstream analytics (PR detection's `fastest_5km_time` MIN-direction filter) treats as "valid" because the schema gate did not catch it.
- **Where**: `src/lib/validations/workout.ts:105–140` (commit `7d56f6f5` / surrounding W16b)
- **Why it matters**: PR detector's `fastest_5km_time` slot has `{ field: 'durationSec', minDistanceM: 5000, direction: MIN }`. A bogus 0-second 5km workout (durationSec=0 from the clamp, totalDistanceM=5001) would become an unbeatable "fastest 5km PR". The warm-up gate softens this (need 7 samples), but the gate is metric-wide, not per-slot.
- **Fix pattern**: add `.superRefine` branch: `if (value.endedAt <= value.startedAt) ctx.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt must be after startedAt' })`. PR detector should also guard `durationSec > 0` before considering a MIN-direction slot.

### M3. Manual-workout route attachment uses serial `findFirst` in a transaction

- **Issue**: `src/app/api/workouts/batch/route.ts:359–373` runs `Promise.all(withoutExternal.map(p => tx.workout.findFirst({...})))` inside the write transaction. Each row probes by `(userId, source, startedAt, sportType, route: null)`. Two manual workouts inside the same batch with identical `(source, startedAt, sportType)` would both match each other's row, and the route attachment becomes non-deterministic.
- **Where**: `src/app/api/workouts/batch/route.ts:359–373` (commit `7b7a896c` parent)
- **Why it matters**: the comment at line 320–321 admits this path is exercised only by future surface (no manual workout entry yet). Today it's dead. Once a manual entry UI lands in v1.5, the contract is wrong.
- **Fix pattern**: defer the route-attach branch behind a feature flag, or change manual-workout writes to use individual `prisma.workout.create` calls returning the id so the route attach is deterministic.

### M4. Onboarding `GoalsChipPicker` never persists selection server-side

- **Issue**: `src/components/onboarding/GoalsChipPicker.tsx:154–164` writes the goals set to `localStorage` only. `POST /api/onboarding/step` body is `{ step: 2 }` — no `goals` field. The component's comment line 30 admits "we hold the selection in client state and bundle it into the final-step submit", but the final-step submit (`/api/onboarding/step` with `{ step: 4 }`) never reads it.
- **Where**: `src/components/onboarding/GoalsChipPicker.tsx:166–184`, `src/app/api/onboarding/step/route.ts:43–46` (commit `c7b1fdb0`)
- **Why it matters**: a user who clears storage or switches devices mid-onboarding loses their selection silently. No downstream code reads the goals yet (chip-picker is informational in v1.4.25), so impact today is low — but it sets up a v1.4.26 surprise when the `User.onboardingGoals` column lands and existing users have no value persisted.
- **Fix pattern**: either drop the storage layer until v1.4.26 ships the column, or extend the step-body schema with `goals: z.array(z.enum(...)).optional()` and forward into a transient session field that v1.4.26 migrates.

### M5. Research-mode staleness helper exists but is never wired

- **Issue**: `src/lib/medications/research-mode-staleness.ts:64` exports `isAcknowledgmentStale` and the file's own header line 28–32 admits it is not wired into the `DrugLevelChart` gating today.
- **Where**: `src/lib/medications/research-mode-staleness.ts:64` (commit `bfd129fc`)
- **Why it matters**: dead helper code in a regulated path looks like an oversight to a future maintainer. The 90-day re-acknowledgment gate is the second of two consent gates research §11 calls for — shipping only the version-bump gate is a partial implementation.
- **Fix pattern**: either wire into the DrugLevelChart's gating decision and remove the deferral note, or move the helper to `.planning/` with a v1.4.26 wire-up ticket and drop the live module.

### M6. `categoryForEntry` defence-in-depth bypassed by Prisma enum

- **Issue**: `src/app/api/medications/[id]/side-effects/route.ts:140–146` recomputes `expectedCategory` from `categoryForEntry(entry)` and returns 422 on mismatch. Defensive. But then the write at line 152 uses `category: expectedCategory` — so the client-supplied category is *never* persisted regardless. The 422 check is the only point of failure; if a client supplies a NAUSEA + INJECTION_SITE pair, the server returns 422 instead of silently rewriting.
- **Where**: `src/app/api/medications/[id]/side-effects/route.ts:140–157`
- **Why it matters**: the comment explains the rationale, but it's worth asking whether the 422 is the right shape — the route could simply ignore the client `category` and write the derived one. The current shape forces the iOS DTO to keep the two fields in sync forever. Either drop `category` from the schema (derive on the server) or keep the 422 and add a test that asserts the response code matches.
- **Fix pattern**: drop `category` from `createSideEffectSchema`; derive from `entry` on the server only. Backwards-compatible since the iOS app hasn't shipped.

### M7. Onboarding wizard race window between fresh fetch and update

- **Issue**: `src/app/api/onboarding/step/route.ts:80–122` fetches the user row, validates `step === current + 1`, then issues `prisma.user.update`. Two parallel tabs both pass the check then both write — last-write-wins. The window is small but the unique constraint is only "increment by one", not "increment-atomically".
- **Where**: `src/app/api/onboarding/step/route.ts:80–122`
- **Why it matters**: low practical impact (a duplicate write to the same step is a no-op), but the comment at line 77–79 advertises race-safety and the code doesn't deliver. A user can land in step=4 twice and the `onboardingCompletedAt` audit log fires twice.
- **Fix pattern**: condition the update on the current value: `prisma.user.update({ where: { id: user.id, onboardingStep: current, onboardingCompletedAt: null }, … })` and treat `RecordNotFound` as the concurrent-write signal (return 409).

### M8. Migration 0057 comment misstates PostgreSQL default-backfill behaviour

- **Issue**: `prisma/migrations/0057_user_onboarding_step/migration.sql` comment lines 23–28 claim "`DEFAULT 0` only applies to *new* inserts on PostgreSQL — existing rows are not backfilled." This was true pre-PG11; since PG11 (2018) `ADD COLUMN ... DEFAULT <constant>` backfills via the fast metadata-only path. The migration's actual behaviour (every existing row gets `0`) is fine; the comment will mislead the next maintainer.
- **Where**: `prisma/migrations/0057_user_onboarding_step/migration.sql:23–28`
- **Why it matters**: low impact, but the schema declares `onboardingStep Int?` (nullable) when it never actually will be null after this migration runs. Drop either the nullable in schema or the misleading comment.
- **Fix pattern**: rewrite the comment to "Existing rows are backfilled to 0 by PostgreSQL's fast-path ADD COLUMN DEFAULT (PG11+)."

## Low (defer to v1.4.27)

1. `src/app/api/medications/[id]/cadence/route.ts:18` uses `from "zod"` (vs the codebase-wide `from "zod/v4"`). Style inconsistency only — both resolve to v4 at runtime.
2. `src/app/onboarding/[step]/page.tsx:77–83` lets a not-yet-complete user view `/onboarding/4` (done screen) by URL — `requested > current` is the only forward-block, and `4 > current` is `false` for `current=4`, but the user can fetch `current=2, requested=4 → 4 > 2 true → redirects`. Spot check: actually the redirect works on forward. The dead code path is `completed=false, current=4, requested=4` — but `current` is only 4 once the step-4 POST landed, which sets `completed=true`. OK; leave as-is.
3. `pr-direction.ts:46–83` switch has no `default` arm. TypeScript exhaustiveness check covers it today, but a future enum addition without the matching switch arm produces an `undefined` return value implicitly. Add `default: return null;` for runtime safety even with `noImplicitReturns`.
4. `src/lib/medications/glp1-pk.ts:154–187` `resolveKa` falls back to a `3/tmax` heuristic when the catalog has no published `Ka`. Comment line 168 says "30% error in Ka does not change the rising/peak/fading classification" — true for the chip, less true for the AreaChart sample width. Acceptable for W19c qualitative scope; flag for v1.5 PK upgrade.
5. `src/app/api/auth/me/research-mode/route.ts:186–218` DELETE has no rate-limit. Idempotent, harmless, low-priority surface, but inconsistent with POST's 5/min.
6. `src/lib/jobs/pr-detection.ts:31` declares `PR_DETECTION_FALLBACK_CRON = "*/30 * * * *"` — every 30 minutes, fleet-wide. At Marc's scale fine; at fleet scale the cron will run `detectPersonalRecordsForUser` for every user every 30 min, with no claim semantics. Future enhancement: scope the cron to users whose last detection ran >24h ago.
7. `src/lib/personal-records/pr-detection-worker.ts:209–284` measurement scan loops over every `measurementTypeEnum.options` per user — fourteen typed counts + fourteen findFirsts + fourteen findFirsts (current PR) + insert. About 42 round-trips per user per detection. Acceptable today; consider a single windowed query with `GROUP BY type ORDER BY value` for the v1.5 fleet scale.
8. The `enqueuePrDetection` `try/catch` in both batch routes swallows the error after `annotate`. The `await` outside the try (line 469 / 339) ensures the failure path is reached, but the audit log line 470 is conditioned on success. If the enqueue succeeds and the audit log throws, the catch fires with the audit error, not the enqueue error. Minor.

## Files reviewed (or skimmed)

- `prisma/migrations/0056_medication_inventory_item/migration.sql`
- `prisma/migrations/0057_user_onboarding_step/migration.sql`
- `prisma/migrations/0058_user_research_mode/migration.sql`
- `prisma/migrations/0059_medication_side_effect/migration.sql`
- `prisma/schema.prisma` (W14b / W19b–f additions)
- `src/lib/medications/side-effects/{taxonomy,validators}.ts`
- `src/lib/medications/inventory/{state-machine,service}.ts`
- `src/lib/medications/scheduling/{cadence,compliance}.ts`
- `src/lib/medications/titration/ladder.ts`
- `src/lib/medications/glp1-pk.ts`
- `src/lib/medications/research-mode-staleness.ts`
- `src/lib/personal-records/{pr-direction,pr-detection-worker}.ts`
- `src/lib/jobs/{pr-detection,medication-inventory-expire,reminder-worker}.ts` (handler glue only)
- `src/lib/validations/{workout,medication}.ts`
- `src/lib/sources/pick-canonical-workout.ts`
- `src/lib/api-handler.ts:73–104` (safeRequestProp hot-fix)
- `src/app/api/medications/[id]/{side-effects,inventory,cadence,titration}/route.ts`
- `src/app/api/medications/[id]/side-effects/[logId]/route.ts`
- `src/app/api/medications/[id]/inventory/[itemId]/route.ts`
- `src/app/api/medications/[id]/intake/route.ts:95–121` (inventory hook)
- `src/app/api/workouts/batch/route.ts`
- `src/app/api/measurements/batch/route.ts:320–360` (PR enqueue)
- `src/app/api/onboarding/step/route.ts`
- `src/app/api/auth/me/research-mode/route.ts`
- `src/app/onboarding/[step]/page.tsx`
- `src/components/onboarding/GoalsChipPicker.tsx`
- `src/components/insights/personal-record-badge.tsx`
- `src/app/api/medications/[id]/inventory/__tests__/route.test.ts` (test gap on PATCH-stale state)

## Closing

Code quality on the v1.4.25 surface is high. Pure modules (`state-machine`, `taxonomy`, `cadence`, `compliance`, `ladder`, `glp1-pk`, `pr-direction`, `research-mode-staleness`) carry strong unit-test coverage and clean separation from I/O. The integration-route layer reads tight. The two High items I'd want addressed before tagging are H1 (inventory PATCH bypasses the state machine) and H3 (replace the inventory expire-loop with `updateMany`); H2 (timezone) is a real regression but its blast radius is bounded by the single-region deploy until v1.5 iOS sync ships real cross-zone users. M1 (taxonomy drift) is the one maintainability item most likely to bite a future maintainer; cheap to add a drift-guard test. Ship after H1 + H3 are patched; H2 + M1 are acceptable as W22-prep follow-ups.
