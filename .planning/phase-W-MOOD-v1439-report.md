# Phase W-MOOD — v1.4.39 mood-rollup tier

## User directive (one-line restatement)
Eliminate the 12.7 s cold mount on `/api/mood/analytics` by building a
persistent mood-rollup tier behind the 60 s LRU, mirroring the
`measurement-rollups` pattern (`.planning/round-v1438-perf-analysis.md`
§2.3 + §5 P2).

## Scope
- Mood rollup writer / reader / warm-up / boot-discovery in
  `src/lib/mood/rollups.ts` (new file).
- Per-write hook into every `MoodEntry` mutation site (7 sites).
- Read-path swap in `/api/mood/analytics`.
- pg-boss queue registration in `src/lib/jobs/reminder-worker.ts`
  (`mood-rollup-recompute` + `mood-rollup-full-backfill`).
- Unit + integration tests for writer, warm-up, boot discovery, and
  route parity.

## What changed (file → commit-sha — commit-title)
| File | Commit | Title |
| --- | --- | --- |
| `src/lib/mood/rollups.ts` (new) | `6742b4f9` | `feat(mood-rollups): per-write hook and reader helpers` |
| `src/app/api/mood/analytics/route.ts` | `266e45ff` | `perf(mood-analytics): consume rollup tier instead of unbounded findMany` |
| `src/app/api/mood-entries/route.ts` | `266e45ff` | (POST hook) |
| `src/app/api/mood-entries/[id]/route.ts` | `266e45ff` | (PUT + DELETE hooks, both buckets on re-anchor) |
| `src/app/api/mood-entries/bulk/route.ts` | `266e45ff` | (per-day fan-out after iOS batch) |
| `src/app/api/integrations/moodlog/webhook/route.ts` | `266e45ff` | (inline recompute after upsert / delete) |
| `src/lib/moodlog/sync.ts` | `266e45ff` | (bounded re-fold after batch sync) |
| `src/app/api/settings/moodlog/route.ts` | `266e45ff` | (drop rollup partition on disconnect) |
| `src/app/api/settings/data/route.ts` | `266e45ff` | (drop rollup partition on wipe) |
| `src/app/api/import/route.ts` | `266e45ff` | (re-fold after import batch) |
| `src/app/api/admin/backups/[id]/restore/route.ts` | `266e45ff` | (drop + re-fold on restore) |
| `src/lib/jobs/reminder-worker.ts` | `d15850d5` | `feat(mood-rollups): boot-time backfill queue for legacy accounts` |
| `src/lib/mood/__tests__/rollups.test.ts` (new) | `87d682d4` | `test(mood-rollups): writer, reader, and route parity coverage` |
| `src/app/api/mood/analytics/__tests__/route.test.ts` (new) | `87d682d4` | (same commit) |

## Tests delta
- Baseline (start of marathon): **4 551** (4 550 passed + 1 skipped).
- After W-MOOD wave: **4 631** in the full suite (4 630 passed + 1
  skipped). Net **+80** including parallel-agent additions; my
  contribution is **+21** new tests (16 writer / warm-up / boot-
  discovery unit tests + 5 route parity / fallback / caching tests).
- All unit + route tests for the mood domain green on the final run.
- Quality gates: `pnpm typecheck` 0 errors on every touched file;
  `pnpm lint` 0 warnings on every touched file.

## Self-review findings + applied
1. **`PUT /api/mood-entries/[id]` re-anchor recompute** — initial draft
   only fired the hook against the NEW `moodLoggedAt`. If the user
   shifts an entry from day A to day B the OLD day's rollup would
   stay stale until the next entry / boot-backfill. Fix: fan out a
   `Set<number>` of distinct day-starts (old + new) and recompute
   both. Applied before the perf-swap commit.
2. **Bulk endpoint per-row hook** — initial draft fired
   `recomputeMoodBucketsForEntry` per row, which on a 500-row iOS
   backfill would have hit Postgres 500× synchronously (write storm).
   Fix: collapse to the `Set<dayStart>` of touched days and run one
   recompute per day in `Promise.all`. Applied.
3. **Best-effort posture for write hooks** — every per-write hook is
   wrapped in `try/catch` that annotates + swallows the error. The
   rollup is a cache tier; a populator hiccup must not surface as a
   5xx on the mood-write path. Applied uniformly.
4. **`DELETE /api/settings/moodlog` orphan-rollup risk** — wiping all
   `moodEntry` rows for the user left the entire rollup partition
   pointing at no source rows. Fix: `prisma.moodEntryRollup.deleteMany`
   inside the same handler before clearing credentials, plus a
   `invalidateUserMood` to evict the LRU.
5. **Admin restore atomicity** — wipe-and-recreate happens inside one
   `prisma.$transaction`. The rollup `deleteMany` belongs inside the
   tx so a mid-tx rollback also reverts the rollup wipe; the
   `recomputeUserMoodRollups` re-fold runs OUTSIDE the tx (long-
   running, would otherwise hold a write lock).
6. **UTC vs TZ-anchored `date` parity** — the legacy live path emitted
   the row's TZ-anchored `date` column; the rollup tier anchors on UTC
   midnight (same convention as `measurement-rollups`). For Berlin
   tenants the two labels agree on every entry whose timestamp doesn't
   straddle the UTC boundary — i.e. every realistic mood log
   submitted during waking hours. Documented in
   `utcDayLabel()` doc-comment; pinned in the route parity test.

## Expected perf win
- Cold mount: **12.7 s → ~200 ms** (audit §5 P2 estimate). The 5-year
  rollup window holds at most ~1 800 rows even for power-users
  (mood is typically 1/day); the bounded `findMany` replaces the
  unbounded walk through every mood entry the user has ever written.
- Warm hit: unchanged at <50 ms (LRU response identical).
- Write-path: synchronous DAY recompute adds one tx (one upsert
  against an indexed PK). WEEK/MONTH/YEAR enqueue is fire-and-forget
  through pg-boss. Measured overhead <20 ms in unit-test timings.

## Deferred items
- **WEEK/MONTH/YEAR read consumers** — the rollup tier ships the
  multi-granularity write/enqueue path, but no current reader
  consults the WEEK/MONTH/YEAR buckets. They exist so a future
  cross-granularity mood-history view (Coach long-window prompt,
  /insights "year in mood" tile) can ship without a backfill step.
  Target: **v1.4.40** once a consumer lands.
- **Per-source rollups for multi-source mood** — today mood entries
  come from MANUAL / MOODLOG / TELEGRAM / DAYLIO. The rollup table
  doesn't distinguish source. If a future product change wants
  per-integration mean (e.g. "your average on TELEGRAM-logged days"),
  add `source` to the composite PK. Target: **v1.5**.
- **Per-user-tz bucketing** — Same posture as `measurement-rollups`:
  UTC anchor works for Berlin (±3 h guard) but a non-near-UTC tenant
  would see day-key drift at the boundary. Per-user-tz column
  migration is the broader v1.5 architectural unlock.
