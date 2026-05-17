# W-QA4 — v1.4.38 architecture / data-integrity findings

Diff: `v1.4.37.2..HEAD` on `develop`, READ-ONLY architectural audit.
Lane: data integrity, runtime correctness, cache / dedup semantics — no
copy / UX / i18n review.

Severity legend:

- **CRITICAL** — would corrupt user data, leak the surface, or break the
  release on the canonical Berlin tenant.
- **HIGH** — would mis-compute a number on a non-canonical tenant or
  silently regress under a realistic workload.
- **MEDIUM** — edge case behind the current product, but worth a follow-up.
- **LOW** — cosmetic / documentation / future-proofing.

---

## Severity counts

| Severity   | Count |
| ---------- | ----- |
| CRITICAL   | 0     |
| HIGH       | 0     |
| MEDIUM     | 3     |
| LOW        | 4     |

The diff is tight and the test coverage on the new helpers
(`isNearUtc`, `ensureUserRollupsFresh` dedup, the validator refine on
`dayKey + limit`, the `bp-in-target` priorYear cushion, the gate
inventory) is genuinely good. No pre-tag blockers found.

---

## MEDIUM-1 — Coach gate inventory walker only matches `route.ts`

**File:** `src/app/api/insights/__tests__/coach-route-gate-inventory.test.ts:112`

The walker decides whether to inspect a file with
`if (entry !== "route.ts") continue;`. Next.js App Router accepts
`route.ts`, `route.tsx`, `route.js`, `route.jsx`, `route.mjs`, and
`route.mts`. The directive in the user brief explicitly asked whether
the walker handles `tsx / jsx / mts` variants — it does not.

In the current repo every insights route is `route.ts`, so this is not
a live miss. But a future contributor landing
`src/app/api/insights/<foo>/route.tsx` whose handler invokes the Coach
stack would be invisible to the discovery test, defeating the whole
point of the inventory. The matching `__tests__/` skip on
line 107 IS correct.

Fix shape (no patch — READ-ONLY): match `entry.startsWith("route.")` +
a closed-set extension check, or use a glob with the four valid
extensions.

---

## MEDIUM-2 — `ensureUserRollupsFresh` per-userId Map is per-process

**File:** `src/lib/measurements/rollups.ts:582-624`

The dedup map (`ensureUserRollupsFreshInFlight: Map<string, Promise>`)
correctly:

- shares the in-flight promise across concurrent same-userId callers,
- deletes the slot in `finally` so a rejection does not poison the
  cache (covered by tests at `rollups.test.ts:350-367`),
- short-circuits the SQL fan-out down to one round-trip per probe
  (covered at `rollups.test.ts:302-331`).

Memory growth is **not** a concern — the map is bounded by the count of
distinct userIds currently mid-recompute, and entries delete in
`finally`. A stuck Promise would leak one entry per stuck user, but
the inner work has its own try/catch that always resolves.

The multi-process caveat: HealthLog runs as a single Next.js server +
a single pg-boss worker, so per-process dedup is sufficient today.
If v1.5 horizontally scales the Next layer (multiple containers behind
the load balancer), each container would have its own Map and a cold
fan-out could still queue N parallel recomputes (N = container count,
not request count). At the canonical 1-tenant scale this is academic;
worth flagging in the v1.5 capacity plan if Marc ever scales out.

---

## MEDIUM-3 — Dashboard sparkline has no rollup fallback

**File:** `src/app/api/dashboard/summary/route.ts:323-335`

The sparkline sub-query reads `measurement_rollups` directly with no
live-fallback branch:

```sql
SELECT r."type", r."bucket_start", r."mean"
FROM measurement_rollups r
WHERE r."user_id" = $userId
  AND r."granularity" = 'DAY'
  AND r."bucket_start" >= $sevenDaysAgo
```

For a brand-new account or a freshly-restarted instance where the boot
backfill (`enqueueBootTimeRollupBackfill`) has not yet folded the
user's DAY buckets, this query returns `[]`, `sparkByType` is empty,
and every emitted card has `sparkline: []`. The route still returns
200 (no 500 risk — the brief asked about this), but the iOS tile
paints a flat / missing sparkline until the worker catches up.

`latestIn7d` still reads `measurements` directly, so the headline
`latestValue` is correct on cold mount. Only the sparkline trend is
empty. That is degraded UX, not data corruption. v1.4.35.1's boot
backfill closes the gap within minutes of first boot.

Acceptable for v1.4.38 release; document in the v1.5 plan that the
sparkline sub-query could fall through to a single
`date_trunc('day', measured_at) GROUP BY` against `measurements` when
the rollup result is empty for a covered user.

---

## LOW-1 — `isNearUtc` ±3h boundary is inclusive

**File:** `src/lib/tz/format.ts:96-100`

`return Math.abs(offsetMinutes) <= 3 * 60` — inclusive of ±180 min.
Behaviour:

- `Europe/Berlin` summer +120 min, winter +60 min → near-UTC year-round (correct).
- `Europe/Moscow` +180 min year-round → near-UTC (boundary inclusive, intentional per test on line 281-286).
- `Pacific/Honolulu` -600 min → NOT near-UTC → live fallback (correct).
- `Asia/Tokyo` +540 min → NOT near-UTC (correct).
- `Pacific/Auckland` +720/+780 min → NOT near-UTC (correct).
- `Pacific/Kiritimati` +840 min (Kiribati, +14) → NOT near-UTC (correct, falls through to live path).

DST behaviour confirmed in tests at `resolver.test.ts:265-308` — the
helper re-derives the offset per call via `tzOffsetMinutes(now, tz)` so
a Berlin user crossing the March DST boundary sees +60 → +120 inside
the same logical day and stays near-UTC on both sides. **No behavioural
issue** — flagged LOW only because the inclusive boundary at exactly
±180 means the Atlantic/Cape_Verde (-1h) and Atlantic/Azores (-1h
winter / 0h summer) zones sit comfortably inside, but a future zone
that drifts to ±181 would jump branches without warning. Not a fix —
just a property to be aware of.

---

## LOW-2 — `recomputeBucketsForMeasurement` parallel enqueue is safe

**File:** `src/lib/measurements/rollups.ts:209-220`

The three `enqueueRollupRecompute` calls are independent — each carries
a distinct `singletonKey` (`${userId}|${type}|${granularity}|${from}`)
and `boss.send` has no shared state between calls. Fanning them out
via `Promise.all` is correct.

The internal pg-boss connection pool handles concurrent sends fine;
there's no shared-state contention. **No issue.** Test coverage at
`rollups.test.ts:188-196` proves the three queue sends fire.

---

## LOW-3 — drill-down 1000-cap validator fires before route handler

**File:** `src/lib/validations/measurement.ts:336-340`, route at
`src/app/api/measurements/route.ts:45-49`.

Confirmed: the route's first action after auth is

```
const parsed = listMeasurementsSchema.safeParse(params);
if (!parsed.success) return apiError(parsed.error.issues[0].message, 422);
```

The refine is on the schema itself (top-level `.refine(({ limit, dayKey }) => …)`),
so an oversized request returns 422 before any DB read. **Correctly
gated.** The hard cap inside the route is gone (the old
`Math.min(limit, 1000)` was removed).

---

## LOW-4 — Health-Score prior-week BP definition matches current week

**File:** `src/app/api/analytics/route.ts:387-415`,
`src/lib/analytics/health-score-fast-path.ts:140-143`.

Confirmed: both `computeBpInTargetFastPath` invocations use the same
`targets`, `coverage`, and `userTz` — only `now` differs (one at
`now`, one at `now - 7d`). The `bp_in_target` predicate, the per-day
mean pairing logic, and the rollup-vs-live branch decision are
identical. The delta in the Health-Score helper is therefore a true
week-over-week BP movement, not an apples-to-oranges comparison.

`bpInTargetPctPriorWeek` falls back to `bpInTargetPct` when undefined
(legacy callers), preserving pre-v1.4.38 behaviour exactly (BP cancels
out of the delta). **Correctly threaded.**

---

## Cache invalidation match — verified, no collision

**Files:** `src/app/api/dashboard/summary/route.ts:240`,
`src/lib/cache/invalidate.ts:30-75`.

Route cache key: `${user.id}|dashboard-summary` on `caches.analytics`.

- `invalidateUserMeasurements` calls `caches.analytics.deleteByPrefix(\`${userId}|\`)` (line 31).
- `invalidateUserMedications` calls the same (line 74, the v1.4.38 W-F addition).
- `invalidateUserMood` calls the same (line 51).

The `${userId}|` prefix is unique per user; no collision risk between
users (the pipe character guarantees a tenant boundary because Prisma
cuid2 ids cannot contain `|`). **Both write hooks correctly evict the
dashboard summary bucket.**

---

## Most-important pre-tag concern

**None.** All three MEDIUM findings are post-release follow-ups, not
blockers. The Coach route inventory works for every file in the repo
today; the in-flight dedup map is single-process-correct for the
current deploy shape; and the sparkline empty-on-cold-rollup degrades
to a flat line, not a 500.

The release is architecturally clean.

---

## Cross-cutting recommendation for v1.5

The repeated "rollup-fast-path + isNearUtc guard + live fallback"
shape now exists in three places — `bp-in-target-fast-path.ts`,
`correlations-fast-path.ts`, and (implicitly via the sparkline empty
case) `dashboard/summary/route.ts`. A fourth instance is one
follow-up away (Health-Score weight pillar already has an
`isFullyCovered` branch but no `isNearUtc` guard because the
underlying weight series is sampled, not bucketed).

v1.5 should extract the branch decision into a single helper:

```ts
type RollupReadMode = "rollup" | "live-near-utc-fallback" | "live-coverage-fallback";
function decideRollupReadMode(args: {
  coverage: RollupCoverageMap;
  requiredTypes: MeasurementType[];
  userTz: string;
  now: Date;
}): RollupReadMode;
```

— so every consumer dispatches through the same gate and a future
v1.5 enhancement (per-user-TZ rollup buckets, removing the ±3h
guard) flips behaviour in one place. Today each helper duplicates
~6 lines of branch logic and the `meta.*.path` annotate is
copy-pasted three times.

The same refactor should thread `userTz` into `readRollupBuckets`
itself so the rollup table can address local-day buckets — that is
the v1.5 follow-up the bp-in-target comment at line 142 explicitly
calls out.
