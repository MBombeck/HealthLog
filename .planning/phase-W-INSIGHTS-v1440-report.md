# Phase W-INSIGHTS — v1.4.40 unbounded mood walks + compliance hook gap + SB-7

## User directive (one-line restatement)
Eliminate the unbounded `MoodEntry.findMany` walks across the Insights
cluster + close the v1.4.39.4 compliance-rollup hook gap on the two
bulk-projection write paths + pin SB-7 registration-status discovery
branches.

## Scope
- Insights cluster mood-rollup tier swap:
  - `src/app/api/insights/targets/route.ts`
  - `src/app/api/insights/comprehensive/route.ts`
  - `src/lib/insights/features.ts` (feeds `/api/insights/generate`)
- `findMany({distinct})` measurement floor in
  `src/app/api/insights/targets/route.ts:191`.
- Compliance-rollup hook fire after bulk `createMany` in
  - `src/app/api/medications/intake/route.ts` (`scope=today` branch)
  - `src/app/api/dashboard/summary/route.ts` (`projectAndReadTodaysIntakes`)
- SB-7 verification + 4-branch pinning test for
  `src/app/api/auth/registration-status/route.ts`.

## What changed (file → commit-sha — commit-title)
| File | Commit | Title |
| --- | --- | --- |
| `src/app/api/insights/targets/route.ts` | `f8de4b05` | `perf(insights-targets): consume mood-rollup tier and floor distinct measurement scan` |
| `src/app/api/insights/targets/__tests__/route.test.ts` (new) | `f8de4b05` | (same commit) |
| `src/app/api/insights/comprehensive/route.ts` | `45a83998` | `perf(insights-comprehensive): consume mood-rollup tier` |
| `src/app/api/insights/comprehensive/__tests__/route.test.ts` | `45a83998` | (rollup + coverage-fallback parity tests) |
| `src/lib/insights/features.ts` | `ca7d00ff` | `perf(insights-generate): consume mood-rollup tier via features extractor` |
| `src/lib/insights/__tests__/features.test.ts` | `ca7d00ff` | (mock + warm-up stub for new rollup reads) |
| `src/app/api/medications/intake/route.ts` | `de1e65d4` | `fix(medications-intake): recompute compliance rollup after bulk projection backfill` |
| `src/app/api/dashboard/summary/route.ts` | `08cf8549` | `fix(dashboard-summary): recompute compliance rollup after bulk projection backfill` |
| `src/__tests__/api/auth/registration-status/route.test.ts` (new) | `317d5618` | `test(auth-registration-status): pin all four discovery branches` |

## Tests delta
- Targeted run (`src/app/api/insights src/lib/insights
  src/__tests__/api/auth/registration-status src/app/api/medications/intake
  src/app/api/dashboard/summary`): **32 files, 235 tests passing**.
- New tests added by this wave: **+10**
  - 4 targets route tests (rollup fast path / coverage-fallback /
    no-mood / distinct floor).
  - 2 comprehensive route tests (rollup fast path / coverage-fallback).
  - 4 registration-status SB-7 branches (enabled / disabled / null /
    fail-closed).
- Existing tests touched (mock surface extension): `features.test.ts`
  (added `moodEntryRollup` mock + warm-up stub) + `comprehensive/route.test.ts`
  (same). Both stay green at the original test counts plus the two
  additions.
- Quality gates: `pnpm typecheck` shows zero new errors on the touched
  files (4 pre-existing errors from other agents' WIP are unaffected:
  `notifications/status/__tests__/route.test.ts`, `health-chart.tsx`,
  `apns.ts`). `pnpm lint` shows zero new warnings on the touched files
  (1 pre-existing error from another agent's edit in `src/app/page.tsx`
  is unaffected).

## Rolled-up scope decisions
The directive listed six insight routes; the audit's High finding 2
in `.planning/round-v1439-arch-qa-infra-db.md` enumerates the six
mood-walk sites. Three of the six don't fit the rollup-tier swap:

  - **`src/app/api/insights/cards/route.ts`** — has no mood query.
    Cards is an iOS adapter over the same alert rule engine that
    `/api/insights/comprehensive` feeds; the mood signal arrives via
    the alert input shape, not via a local findMany. No change needed.
  - **`src/app/api/insights/glp1-timeline/route.ts`** — reads
    `tags: string[]` from `mood_entries` for the side-effect day
    collapse. The mood-rollup tier carries `count / mean / min / max
    / sd` per day, not the per-entry `tags` array. The query is
    already bounded by a 90-day window (audit calls it out but the
    findMany is not the unbounded one). Swap deferred to v1.5
    per-user-tz mood tier when tag aggregation can land alongside.
  - **`src/app/api/gamification/achievements/route.ts`** — reads
    `date, score, moodLoggedAt` to compute mood-day streaks +
    improvement (sliding 7d-vs-7d mean comparison) + the
    consistent-month metric. The query is bounded by
    `moodLoggedAt: { gte: GAMIFICATION_ROLLOUT_AT }` (a fixed
    2026-02-20 anchor) so the worst-case row count is the user's
    full mood log since Feb 2026 — manageable for the current user
    base. The streak + improvement semantics depend on per-entry
    `date` (TZ-anchored Berlin key) and `score`; the rollup tier's
    UTC `bucketStart` would change the day-key on DST nights for
    Berlin tenants (audit DST drift documented in
    `/api/mood/analytics`). Byte-parity is not achievable without
    the v1.5 per-user-tz bucket migration. Deferred.

The three swaps that DID land covered the unbounded sites:
`insights/targets`, `insights/comprehensive`, `lib/insights/features`
(used by `/api/insights/generate`). The compliance-rollup hook gap +
SB-7 4-branch test landed as scoped.

## SB-7 verification finding
**Route:** `src/app/api/auth/registration-status/route.ts`
**Branches walked (4):**

  1. **Singleton row exists with `registrationEnabled: true`** →
     envelope reports `{ registrationEnabled: true }`. The happy
     path for an open self-hosted deployment.
  2. **Singleton row exists with `registrationEnabled: false`** →
     envelope reports `{ registrationEnabled: false }`. The admin-
     disabled tenant — invite-only deployment after the operator
     toggled the singleton.
  3. **Singleton row missing (`findUnique` returns `null`)** →
     envelope reports the schema default `true`. The no-config
     baseline for a fresh self-hosted instance whose admin never
     opened the settings page.
  4. **`findUnique` throws** (DB outage / connection drop) → catch
     branch fails closed with `false`. Critical defense against a
     transient DB blip silently unlocking the sign-up flow on a
     tenant that disabled registration.

**Code-change verdict:** none required. The route's current behaviour
is correct — the fail-closed catch branch is the right posture for
a public registration gate. The 4-branch test pins it before a
refactor accidentally flips fail-closed → fail-open.

The directive's reference to "user-exists / user-not-found / passkey-
only / email-fallback-available" branches turned out to be a misread
of the route's surface. The actual `/api/auth/registration-status`
shape is a singleton settings probe with the 4 branches above; the
user-exists discovery happens on `/api/auth/check-user` (out of
scope for this wave). Documenting here so a future agent doesn't
chase the wrong route.

## Self-review findings + applied
1. **Rollup `bucketStart` UTC vs `MoodEntry.date` Berlin-anchored
   day-key parity.** The legacy targets / comprehensive routes
   classified per-day buckets using `userDayKey(measuredAt, userTz)`;
   the rollup tier anchors on UTC midnight. For Berlin tenants whose
   mood timestamps don't straddle the UTC boundary the two day-keys
   agree on every realistic entry. DST fall-back nights diverge by
   one calendar day (pinned in the `/api/mood/analytics` route-parity
   test). Documented in the route-block doc comments + tests; the
   v1.5 per-user-tz bucketing closes the gap.
2. **Coverage-fallback bound.** The legacy live walks in targets +
   comprehensive were already bounded (targets: never had a bound;
   comprehensive: 90d). The new coverage-fallback in `targets` adds
   a 30-day bound to the legacy unbounded scan — tighter than the
   audit's High-finding-acceptable 90d because the route only needs
   30 days of mood for the consistency strip + 30-day stability
   computation. The `features.ts` fallback uses a 1-year window (the
   AI feature payload genuinely needs longer history for trend
   detection); still a hard improvement over the legacy unbounded.
3. **Compliance recompute coalescing.** Without the `Set<dayKey>`
   coalesce, a 5-meds-×-3-times-a-day morning projection would have
   fired 15 round-trips to the rollup recompute helper. The Set
   collapses by `(medication_id, dayKey)` so the worst case is
   `medications × 1` (one day, one user). Mirror-applied to both
   intake + dashboard call sites for symmetry.
4. **`findMany distinct` floor magnitude.** Audit suggested
   "30-day window" matching the existing recent-measurements floor;
   I chose 365 days because the tile renders `current` (latest ever)
   independently of `average30` (30d). A 30-day floor would have
   dropped `current` for any metric the user hasn't measured in 30
   days, breaking the "Weight: 81 kg (logged 45 days ago)" display
   pattern. 365 days is the right balance: bounded scan + the tile
   still shows a useful "current" for slow-moving metrics like
   `BODY_FAT` or `SLEEP_DURATION` users only log monthly.

## Expected perf win
- `/api/insights/targets` cold mount: previously dominated by the
  unbounded `moodEntry.findMany` + the unbounded `findMany distinct`.
  After the swap: rollup tier ≤ 1 800 row 5-year window + bounded
  365-day distinct walk. Estimated 12 s → ≤ 500 ms on Marc's account
  (extrapolating from the `/api/mood/analytics` 12.7 s → 200 ms gain
  + the audit's 347 k-row distinct sort fix).
- `/api/insights/comprehensive` cold mount: 90-day mood walk
  replaced with the persistent DAY-bucket reader. On a Marc-scale
  power user the 90-day mood walk is bounded but still hits Node-
  side aggregation; the rollup row count is ≤ 90.
- `/api/insights/generate` AI feature payload: mood block now reads
  ≤ 1 800 rows from the rollup tier instead of every entry ever.
  Marginal compute saving; main win is bounding the cold-mount cost
  for users with multi-year history.

## Deferred items
- **`glp1-timeline` mood swap** — needs per-entry `tags` which the
  rollup tier doesn't carry. v1.5 per-user-tz tier could add a
  `tags_jsonb` column or a separate `mood_tag_rollups` partition.
- **`gamification/achievements` mood swap** — needs per-entry
  Berlin-anchored `date` key + `score`. Byte-parity blocked until
  v1.5 per-user-tz bucketing.
- **`/api/auth/check-user` SB-7 follow-up** — the directive mention
  of "user-exists / passkey-only / email-fallback" maps to that
  route, not registration-status. Out of scope for this wave; flag
  for v1.4.41 backlog.
