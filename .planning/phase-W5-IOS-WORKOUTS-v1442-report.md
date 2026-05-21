# W5-IOS-WORKOUTS-DEDUP + DESIGN-POLISH — v1.4.42 phase report

Worktree: `worktree-agent-a078968e699ec5621`
Branched from `develop` tip `d3d60104` (v1.4.41 QA closure)
Two atomic commits: `9af4bbb6` (workouts), `db9c6296` (dashboard).

## Scope landed

### 1. `pickCanonicalWorkoutRows()` — write-time cross-source dedup
- `src/lib/workouts/canonical-rows.ts` — new pure helper, no Prisma /
  no IO. Groups by `(userId, activityType, startedAt ± 90 s)`; prefers
  the canonical source ladder `APPLE_HEALTH > WITHINGS > MANUAL >
  IMPORT`; breaks ties on calories > earliest createdAt > input
  order. Re-uses `DEFAULT_WORKOUT_SOURCE_PRIORITY` from
  `src/lib/sources/pick-canonical-workout.ts` so both write-time and
  read-time pickers consult a single ladder constant. (Scope memo
  mentioned `STRAVA_IMPORT`; the actual enum has only `IMPORT` — the
  scope wording maps to that bucket, documented in the helper header.)
- `src/lib/workouts/__tests__/canonical-rows.test.ts` — twelve cases
  pinning: empty input, exact same-source dup, cross-source overlap
  inside window, no-overlap pass-through, multi-user isolation,
  multi-activityType isolation, calories tie-breaker, createdAt tie-
  breaker, input-order determinism, ±90 s boundary inclusivity,
  full-ladder walk, no-caller-mutation invariant.
- `src/app/api/workouts/batch/route.ts` — wired pre-`createMany`.
  Survivors carry through to the existing dedup-by-externalId pass;
  dropped twins surface as `duplicate` in the per-entry envelope so
  the iOS sync cursor advances past them identically.
- `src/app/api/workouts/__tests__/batch-create.test.ts` — three
  pre-existing tests updated to space their two-row payloads outside
  the 90 s window (they exercised per-entry envelope semantics, not
  cross-source dedup; collision with the new W5 pass would have
  masked the intended pin).

### 2. Dashboard tile-strip placeholder polish
- `src/app/page.tsx` ~line 1428 — fallback className extended:
  `flex h-full min-h-[6rem] w-full min-w-0 flex-col` added to the
  existing `bg-card border-border rounded-xl border p-4 md:p-6`.
  Matches the live `TrendCard` chrome (`src/components/charts/
  trend-card.tsx:241`) byte-for-byte. `min-h-[6rem]` holds the row
  open during an all-suspend transition; the chrome utilities keep
  the placeholder visually identical to a settled tile.
- Structural test pin keys on `aria-hidden="true"`, not the
  className → stays green without modification.

## Quality gates (all green)

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- `pnpm test --run` (full suite) — **4744 passed | 1 skipped**.
- Scoped `pnpm test --run src/lib/workouts
  src/app/__tests__/dashboard-suspense-boundaries.test.ts
  src/app/api/workouts` — 44 passed.

## Strict rules honoured

- Stayed in worktree throughout.
- Did not touch: knip config, dashboard widget routes, api-response,
  settings/medications/admin/integrations components, hook files, tz
  resolver, insights status modules, doctor-report-data.
- Only touched the placeholder className lines in `src/app/page.tsx`
  — no other comments / Suspense / RSC code modified (W4 owns those).
- No `Co-Authored-By: Claude`. No `--no-verify`. No `--no-gpg-sign`.
  No "Marc" in commit messages. Conventional-commit prefixes:
  `feat(workouts):` and `style(dashboard):`.
