# v1.4.37 post-deploy perf verification

**Release:** v1.4.37 (`88028fa0` on main, live 2026-05-17 13:42 UTC)
**Live host:** https://healthlog.bombeck.io
**Account under test:** Marc's production account (311,779+ measurements)

## TL;DR

- Live tag is **1.4.37**; build hash `88028fa082085f595e5ee423839c4561c21a11c9`.
- Boot clean: reminder worker up in 772 ms; no pending migrations (the v1.4.36 `0068_v1436_insights_exclude_metrics` was already applied).
- No boot errors → the W10-1 C-1 fix landed correctly: `DRAIN_CUMULATIVE_QUEUE` registration in `allQueues` succeeded; the worker boot would have aborted on the `boss.schedule(DRAIN_CUMULATIVE_QUEUE, …)` call otherwise.
- Anonymous 401 baseline 77–130 ms on `/api/insights/comprehensive` + `/api/analytics` — identical to v1.4.36 (no auth-layer regression).
- The W2 perf carry-over (full `/api/analytics` 111 s cold worst-case → ~1.5–3 s) needs a real authenticated web load to confirm — pending Marc's next dashboard / insights mount. Framework captured below; live numbers fill in as they surface in the logs.

## Boot trace (verified)

```
HealthLog: Waiting for database...
HealthLog: Database is reachable.
HealthLog: Running database migrations...
[...]
No pending migrations to apply.
HealthLog: Migrations complete.
HealthLog: Starting application...
▲ Next.js 16.2.6
✓ Ready in 0ms
{ background.task_name: "startup", reminder_worker: "started", duration_ms: 772 }
```

No `boss.createQueue` errors, no schedule-registration warnings. C-1 fix verified by absence of failure.

## Anonymous latency (auth-layer baseline)

| Surface | Cold | Notes |
|---|---|---|
| `/api/version` | 80 ms | sanity ping, public |
| `/api/insights/comprehensive` (anon) | 77–108 ms | 401 reject |
| `/api/analytics` (anon) | 84–131 ms | 401 reject |
| `/api/health` (Uptime-Kuma) | 73 ms | health check |

Identical envelope to v1.4.36 → no auth/middleware regression.

## Expected authenticated wins (pending Marc's web session)

| Surface | v1.4.36 baseline | v1.4.37 expected | Mechanism |
|---|---|---|---|
| `/api/insights/comprehensive` (cold) | 4566 ms | comparable (no changes this release) | already on rollup probe |
| `/api/analytics` slim slice | 4153 ms | comparable | already on rollup probe |
| `/api/analytics` FULL slice (correlations + healthScore + bp_in_target) | **111,092 ms** worst-case cold | **1500–3000 ms** | W2 — three branches on the rollup-coverage probe with per-branch `path` annotate |
| `/api/insights/targets` | 1609 ms cold / < 50 ms cached | unchanged | LRU same |
| `GET /api/measurements?groupBy=day&type=ACTIVITY_STEPS` (new) | n/a | < 200 ms | rollup DAY buckets, no per-sample scan |
| `GET /api/measurements?aggregate=daily&source=rollup` (existing v1.4.36) | < 100 ms | unchanged | rollup-direct |

## Headline perf bet — full `/api/analytics` cold-path

The W2 wave lifted correlations + healthScore + bp_in_target onto the v1.4.36 `probeRollupCoverage` probe. Each branch now:

- consults the probe once per request
- reads from `measurement_rollups` when DAY-bucket coverage is full
- falls back to live SQL chunks when partial
- emits `meta.<branch>.path: "rollup"|"live"` for prod observability

The correlations branch additionally tightened its scan from 30 to 28 days with a `CORRELATION_WINDOW_DAYS` constant + sentinel annotate.

**Verification path** (run once Marc loads the dashboard / insights):

```bash
# Capture the most recent FULL /api/analytics call on Marc's account
ssh apps-01 'docker logs $(docker ps --format "{{.Names}}" | grep "^app-pg8wggwogo8c4gc4ks0kk4ss") 2>&1 | jq -c "select(.http.path == \"/api/analytics\" and (.meta?.analytics?.slim_summaries | not))" | tail -3'

# Look for: meta.correlations.path, meta.healthScore.path, meta.bp_in_target.path
# Each should be "rollup" on Marc's account (every type has DAY coverage from the v1.4.35.1 auto-converging backfill).
```

If the first cold hit is < 5 s and per-branch paths are all "rollup": shipped. If any branch still says "live": the probe didn't cover — check the rollup table for that type.

## Apple Health step consolidation (W7c)

The new `groupBy=day` + `dayKey` modes don't run automatically — they kick in only when the UI requests them. Marc's iOS app does not yet pass these params (a v1.5 iOS sprint item), so the feature lives on the web measurement-list page for now.

The nightly drain at 03:45 Europe/Berlin (36 h grace) will run for the first time tonight. Tomorrow the table should be ~50× smaller for cumulative HK types on Marc's account.

## Carry-over to v1.4.38 if a number lands materially worse than estimate

If the full `/api/analytics` cold hit stays above 5 s on Marc's account after the deploy: file v1.4.37.1 hotfix issue, investigate why the probe missed (per-type coverage gap? cache miss cascade? something downstream of the W2 work).

If the nightly drain produces no row-count compression: the singleton-key on the pg-boss schedule may be coalescing with no-op runs; investigate the W10-2 M-2 finding (per-process singleton-guard) earlier than planned.

## Verdict (interim — pending Marc-authenticated traffic)

Deploy is **healthy and live**. The W10-1 Critical fix (drain queue registration) is verified by clean boot. The W2 perf claim is **framework-ready, awaiting first authenticated mount on Marc's account** to confirm cold worst-case in the 1.5–3 s range.
