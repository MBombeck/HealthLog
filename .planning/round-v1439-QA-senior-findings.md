# v1.4.39 QA — Senior-Dev Review

Independent code-review pass on the full diff `v1.4.38.8..develop`
(commits `0d33f91d` → `bbcb09e8`, 50 files, +6 404 / −26). Read-only.

Anchors:
- Audit: `.planning/round-v1438-perf-analysis.md`
- Wave reports: `phase-W-{MOOD,MED,SUM,WMY,SINCE}-v1439-report.md`

`pnpm typecheck` passes clean on HEAD.

## Severity bands

- **Critical** — release-blocking (data loss, crash, perf regression > 50 %).
- **High** — must-fix before tag (parity break, edge case that wedges power users, hidden lint/type errors).
- **Medium** — should-fix in v1.4.39 if cheap, otherwise v1.4.40 backlog.
- **Low** — cosmetic, naming, dead code.

## Findings

### Critical

(none)

The four migrations are additive, write hooks fall back to a working
legacy path on miss, and `typecheck` is clean. No release-blocking
issue surfaced. Recommend ship after the High items below are
triaged (the two parity / race concerns can be deferred with a
documented v1.4.40 backlog entry).

### High

- **F-H-01** — `hasMedicationComplianceCoverage` returns `true` on
  partial coverage and serves zero-filled buckets for un-rolled
  days — `src/lib/medications/compliance-rollups.ts:373-389`.
  The probe finds ANY rollup row inside the trailing window and
  flips to the rollup path. If the boot backfill has minted only
  the first few days (long-running fold on a multi-medication
  legacy account) the probe returns `true` while days N..days-1
  are still zero-filled. The user sees a "compliance dropped to 0
  %" tile for the un-rolled days until the backfill finishes. The
  legacy `buildComplianceBuckets` would have returned the correct
  values because it reads `medication_intake_events` directly.
  **Fix**: tighten the probe to compare the count of rolled days
  vs. expected days, or persist a per-user `compliance_backfilled_at`
  watermark and gate the swap on it.

- **F-H-02** — Read-after-write race in mood + compliance DAY
  recompute — `src/lib/mood/rollups.ts:173-212`,
  `src/lib/medications/compliance-rollups.ts:177-252`. The DAY
  recompute issues `SELECT … aggregate` followed by an `UPSERT`
  without serialisation. Two concurrent writes for the same
  `(user, day)` interleave as: A SELECT → B SELECT → B UPSERT
  (correct N) → A UPSERT (stale N-1). The stale row stays until
  the next write or boot backfill. Low probability on mood
  (1/day human writes) but realistic on medication compliance
  where the reminder worker mints fresh `scheduledFor` rows while
  a user is acking via Telegram/web. The compliance rollup row
  serves the dashboard tile so the wrong "scheduled / taken"
  count is user-visible. **Fix**: wrap the recompute body in a
  `SELECT … FOR UPDATE` against a sentinel row, or convert the
  fold into a single SQL upsert that re-aggregates inside the
  upsert subquery (`INSERT INTO … SELECT … FROM … ON CONFLICT …`).
  Doable as v1.4.39 hotfix (~2 h) or deferred to v1.4.40 with a
  documented "best-effort tier" caveat.

- **F-H-03** — `enqueueMoodRollupRecompute` fans out 3 enqueues
  per mood write but the queue's `singletonKey` includes
  `from.toISOString()`, which differs per granularity bucket —
  fine. But the helper is `await`-fanned inside
  `recomputeMoodBucketsForEntry`, so a slow pg-boss send adds
  latency to the user's mood-write response.
  `src/lib/mood/rollups.ts:206-211`. The audit's `Promise.all`
  intent is preserved, but the enclosing `await` still serialises
  the route on pg-boss latency. The measurement-rollups path has
  the same pattern (already shipped). **Fix**: drop the outer
  `await` on the Promise.all and fire-and-forget the enqueue —
  the queue is a hint, not a write-path invariant, and the DAY
  pass that the read path actually depends on already committed
  synchronously above.

### Medium

- **F-M-01** — `computeLongWindowSummary` is exported but never
  consumed — `src/lib/analytics/summaries-slice.ts:615`. W-WMY
  shipped the helper + 5 tests for a v1.5 multi-year card that
  doesn't exist yet. Dead-but-tested code. Confirmed deferred in
  the W-WMY report; flag so the v1.5 plan keeps the consumer on
  the radar.

- **F-M-02** — `MoodEntryRollup` writer accepts a `tx` parameter
  (`src/lib/mood/rollups.ts:173-178`) but no call site passes one.
  Same for `MedicationComplianceRollup`. The atomic-with-parent
  story documented in the wave reports is therefore unrealised —
  every rollup write happens AFTER the parent commits. Acceptable
  for a cache tier, but the comments overstate the safety.
  **Fix**: drop the `tx` parameter or wire it through the
  `prisma.$transaction` blocks that exist (e.g. the Telegram skip
  webhook).

- **F-M-03** — `sum_value IS NULL` boot-backfill discovery branch
  has no supporting index — `src/lib/measurements/rollups.ts:762-780`
  + `prisma/migrations/0072_v1439_rollup_sum_value/migration.sql`.
  The UNION branch `WHERE r2."granularity" = 'DAY' AND
  r2."sum_value" IS NULL` does a sequential scan of
  `measurement_rollups`. For Marc's single-tenant install it's
  cheap (~few thousand rows). For multi-tenant scaling it
  becomes a problem. **Fix**: add a partial index `CREATE INDEX
  CONCURRENTLY ON measurement_rollups(user_id) WHERE granularity
  = 'DAY' AND sum_value IS NULL` once the legacy NULL backfill
  finishes the first sweep (the index is only useful while there
  are still NULL rows).

- **F-M-04** — Integration test `analytics-bp-aggregate-paged.test.ts`
  is now wall-clock-anchored at `Date.now()` and seeds 6 000 rows
  at 15-min intervals (~62.5 days). 90-day cap leaves 27.5 days
  of headroom; once CI runs ≥ 28 days after the seed timestamp
  reaches the floor the test fails. **Fix**: re-anchor the seed
  to `nowMs - 30 * 86_400_000` so the youngest row is always 30 d
  old, keeping the test stable across time.

- **F-M-05** — `RollupBucketRow` shape divergence between
  `rollup-read.ts` (`DailyMeanRow`) and `rollup-read-wmy.ts`
  (`RollupBucketRow`). The latter carries `sd/slope/r2/sumValue`
  the former does not. Two coexisting bucket-row types invite
  drift. **Fix**: consolidate into one shape in
  `rollup-read.ts` and re-export from `rollup-read-wmy.ts`. Cheap
  in v1.4.40.

- **F-M-06** — Cross-agent commit attribution drift visibly hit
  this marathon (W-SUM's tests landed inside W-WMY's commit
  `8763b3aa`; see W-SUM report "Surprises"). No broken state, but
  it makes `git bisect` and `git log -p src/lib/measurements/`
  harder to follow. Same pattern as v1.4.37. **Fix**: per-agent
  `git worktree` in the next marathon (the marathon kickoff
  guidance already nods at this).

### Low

- **F-L-01** — `recomputeMedicationComplianceForDay` computes the
  day window twice via `start + 86_400_000` then via
  `startOfDayUtcInTz(nextDayKey)` and picks the larger — both
  helpers run unconditionally — `src/lib/medications/compliance-rollups.ts:186-199`.
  The simpler invariant is "always use `startOfDayUtcInTz` for
  both bounds". Cosmetic cleanup.

- **F-L-02** — `readMedicationCompliance` adds the special-case
  `if (!dedup.has(todayKey)) orderedKeys.push(todayKey)`
  (`src/lib/medications/compliance-rollups.ts:330-332`). The
  DST-edge-case it guards against (`days===1` on a DST boundary)
  is unreachable from production callers (route minimum is
  `days≥7`). Dead defensive code — fine to keep, worth a
  one-line comment that it's a belt-and-braces guard.

- **F-L-03** — Mood-rollup `persistMoodRollupRows` chunks at 500
  but issues a sequential `for…of` upsert loop inside each
  chunk — `src/lib/mood/rollups.ts:526-560`. The
  measurement-rollups equivalent uses `prisma.$transaction([…])`
  for parallel upsert. The mood DAY-hot-path writes 1 row so it
  doesn't matter, but a 5-year boot-fold pays N round-trips
  instead of N/500 transactions.

- **F-L-04** — `MOOD_ROLLUP_FULL_BACKFILL_QUEUE` discovery
  query (`src/lib/mood/rollups.ts:417-427`) doesn't restrict
  `granularity='DAY'` on the LEFT JOIN — same shape as the
  measurement-rollups query, which intentionally bridges all
  granularities. Inconsequential because the read path only
  consults DAY anyway. Comment clarification would help future
  reviewers.

- **F-L-05** — `mood/rollups.ts` typo: `MoodRollupRow.sd` is
  typed `number | null` but the SQL aggregator returns
  `STDDEV_POP` which is `0` (not `NaN`) for a single-row bucket.
  The downstream consumer never asserts SD on single-entry days
  so this is invisible. Worth a doc-comment.

- **F-L-06** — Marc-voice + no-PII check on the new diff: commit
  messages are English, lowercase scope, no Co-Authored-By, no
  emojis. Source comments mention "Marc" exactly once
  (`src/lib/measurements/rollup-read-cumulative.ts:28-30`) which
  is the in-code planning anchor, not user-facing copy. Compliant.

## Brief-back (≤200 words)

**Top 3 findings**:

1. **F-H-01 (High)** — `hasMedicationComplianceCoverage` can
   short-circuit to the rollup path while only some days are
   backfilled, exposing zero-filled tiles for the un-rolled days
   until the boot fold completes. Realistic on legacy accounts
   restoring v1.4.39 mid-deploy. Either tighten the probe or gate
   the swap on a per-user backfill watermark.

2. **F-H-02 (High)** — Read-aggregate-then-upsert race in the
   mood + compliance DAY recomputes. Concurrent writes for the
   same `(user, day)` can leave a stale row until the next write.
   Mood is human-paced so low risk; medication compliance under
   reminder-worker + Telegram contention is the realistic blast
   radius. Convert to a single SQL upsert or `FOR UPDATE` sentinel.

3. **F-H-03 (High)** — `recomputeMoodBucketsForEntry` awaits the
   WEEK/MONTH/YEAR pg-boss enqueue inside the write-path response
   cycle. Drop the outer `await` and fire-and-forget; the DAY
   pass the read path actually depends on already committed.

**Overall posture**: clean architecture, additive migrations,
test coverage proportional to scope, typecheck green. Two
real-world races + one perf-probe gap on partial backfill are
the only correctness concerns. Cache-tier "best-effort" framing
in the wave reports is defensible.

**Ship-readiness**: ship as v1.4.39.0 with F-H-01 + F-H-02 +
F-H-03 documented in `.planning/round-v1439-backlog.md` for
v1.4.39.1 hotfix or v1.4.40. None block the release.
