# v1.4.35 handover — finish Layer B + ship

**Current state:** Foundation committed on `develop` as `9872081d`. Reads still on live-SQL. Read-swap NOT done yet.

## What's already in (commit `9872081d`):

- `prisma/migrations/0067_v1434_measurement_rollups/` — additive
- `MeasurementRollup` model + `RollupGranularity` enum (`prisma/schema.prisma`)
- `db-compat.ts` schema-bootstrap path
- `src/lib/measurements/rollups.ts` — `recomputeBucketsForMeasurement` (sync DAY, pg-boss WEEK/MONTH/YEAR), `recomputeUserRollups` (full range), `ensureUserRollupsFresh` (stale-detect + bounded recompute)
- `src/lib/measurements/rollup-read.ts` — read helpers
- Write hooks on all 6 measurement-mutation endpoints (try/catch wrapped)
- Apple-Health-import worker post-completion `recomputeUserRollups` call
- `scripts/backfill-rollups.ts` (CLI, idempotent, single-user serial)
- pg-boss `rollup-recompute` worker subscription (concurrency=2, singleton-keyed)
- +14 unit + 3 integration tests. tsc + lint clean.
- `ensureUserRollupsFresh` is called as a side effect from `comprehensive-aggregator`, `summaries-slice`, `/api/analytics`. Response still served by live-SQL.

## What's STILL TO DO for v1.4.35:

### 1. Parity-safe read-swap

Modify `src/lib/insights/comprehensive-aggregator.ts` so the per-type aggregate query reads `count/min/max/mean` from `measurement_rollups` (granularity=DAY, 90-day window) and composes them:
- `count` = `sum(bucket.count)` across DAY buckets
- `min` = `min(bucket.minValue)`
- `max` = `max(bucket.maxValue)`
- `mean` = `sum(bucket.mean * bucket.count) / sum(bucket.count)` (weighted mean)
- `slope7/30/90`, `r2_7/30/90`, `stddev`, `anomalyCount` — **stay on the existing live-SQL aggregation** (the `CTE` block in the current `$queryRawUnsafe`). These don't compose linearly across buckets.
- `latest` + `latestMeasuredAt` — also stay on raw rows (`DISTINCT ON (type)` query already in the file).

For `dailyByType` (the correlation pairing input, currently `date_trunc('day', measured_at)` aggregate): **read directly from `measurement_rollups`** filtered to `(userId, type, granularity=DAY, bucketStart in 90d)` and map `bucket.bucketStart → day, bucket.mean → value`. Byte-identical to the current daily-mean computation.

Same pattern in `src/lib/analytics/summaries-slice.ts` (the slim slice).

### 2. Stale-handling on read

If `ensureUserRollupsFresh` fires a recompute, the bucket data MIGHT be momentarily stale relative to the freshly-written measurement (the recompute is async-ish for non-DAY grain). For the DAY-grain read paths above, this is fine because `recomputeBucketsForMeasurement` ran SYNC on the most recent write. But add a fallback: if bucket-derived count/min/max disagrees with a fresh `findFirst({ orderBy: { measuredAt: 'desc' } })` (i.e. there's a measurement after the newest bucket's `bucketStart + 1d`), fall back to live-SQL for that type.

### 3. Tests

Add to `tests/integration/measurement-rollups.test.ts`:
- Seed 50 measurements across 30 days → `comprehensive` response's `summaries[type].count/min/max/mean` matches a parallel live-SQL aggregation byte-for-byte.
- Same for `dailyByType`.
- Write a new measurement after warm cache → next read reflects it correctly.

### 4. Release flow

1. Bump `package.json`: `1.4.34.5 → 1.4.35`
2. CHANGELOG entry under `## [1.4.35] — 2026-05-17 — Persistent measurement rollups + partial read-swap`. Cover: schema migration, write hooks, Apple-Health-import backfill, partial read-swap (count/min/max/mean + dailyByType from buckets; slope/r2/sd stay on live), backfill script. Mention this is the foundation for v1.5.1's full read-swap.
3. Commit the read-swap + version bump + changelog on develop.
4. `git checkout main && git merge --squash develop && git checkout --theirs CHANGELOG.md package.json && git add CHANGELOG.md package.json && git commit -m "v1.4.35 — persistent measurement rollups + partial read-swap"` (let auto-merge handle the route files).
5. `git tag -a v1.4.35 -m "v1.4.35 — persistent measurement rollups + partial read-swap"`
6. `git push origin main && git push origin v1.4.35`
7. `gh release create v1.4.35 --title "v1.4.35 — Persistent measurement rollups + partial read-swap" --notes "..."` (full notes from CHANGELOG).
8. Coolify will auto-pull via the v1.4.34.2 `pull_policy: always` fix.
9. Wait for live: `until curl -s https://healthlog.bombeck.io/api/version | jq -e '.data.version == "1.4.35"' > /dev/null; do sleep 30; done`.
10. **Run backfill against Marc's account post-deploy.** Marc's userId is in the Coolify Postgres — either run via `coolify-apps01` MCP exec (preferred) or instruct Marc to SSH and run `docker exec <container> pnpm tsx scripts/backfill-rollups.ts --user <marcs-userId>`. Expected runtime: single-digit minutes.

### 5. Closure

- Update `.planning/round-audit-marathon-closure.md` to note Layer B / v1.4.35 landed.
- Write/update `~/.claude/projects/-Users-marc-Projects-HealthLog/memory/project_v14345_audit_marathon.md` to flip Layer B from "deferred to v1.5.x" to "shipped as v1.4.35".

## Caveats / gotchas

- The byte-shape parity check is the load-bearing concern. Run the comprehensive integration test BEFORE squash-merge to main — if it fails byte-shape parity, the read-swap is wrong (most likely a weighted-mean rounding mismatch).
- `setup.ts.truncateAllTables` already includes `measurement_rollups` — no need to touch.
- pg-boss worker subscription is in `src/lib/jobs/reminder-worker.ts` under the `rollup-recompute` job name. Existing pattern — copy how `reminder-fan-out` is wired if a second subscription needs adding.
- The agent's `$queryRawUnsafe` + enum-whitelist pattern for `date_trunc` unit is intentional (Postgres 42803). Don't try to bind the unit literal.

## How Marc resumes

The exact prompt to fire in a fresh session:

> Mache v1.4.35 fertig. Lies `.planning/round-v1435-handover.md` — Foundation steckt schon im commit `9872081d` auf develop. Du musst nur noch den parity-safe Read-Swap landen (count/min/max/mean + dailyByType aus DAY-Buckets, slope/r2/sd bleiben auf live-SQL), Tests grün, dann komplett shippen: version bump, CHANGELOG, squash zu main, tag v1.4.35, GH release, live verify, backfill für meinen Account post-deploy. Closure + Memory-Update zum Schluss.
