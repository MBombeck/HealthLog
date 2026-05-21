# v1.4.39 — Post-deploy perf verification

Live deploy: 2026-05-21T05:46:56Z — Coolify deploy uuid
`ujgsxpa46esyzybjldgxjeox`, commit hash
`d84922cdc3bfd118b10b74e6b8664a784837fe58`.

Migrations applied at boot:

```
Applying migration `0070_v1439_mood_rollups`
Applying migration `0071_v1439_medication_compliance_rollups`
Applying migration `0072_v1439_rollup_sum_value`
All migrations have been successfully applied.
```

## Unauthenticated probes (from this orchestrator)

| Endpoint | n | Median | Max |
| --- | --- | --- | --- |
| `GET /api/version` | 10 | **86 ms** | 104 ms |
| `GET /api/health` (Uptime-Kuma) | per-log | 18–78 ms | — |

The 60 s response cache wrap is not yet warm for the authenticated
heavy endpoints — perf-verify on `/api/mood/analytics`,
`/api/medications/intake?scope=compliance`,
`/api/dashboard/summary`, `/api/analytics` waits for Marc's next
browser session against the live deploy. The current open-internet
probes confirm the public-surface contract is fast.

## Coolify production log excerpt (boot)

- App container boots in ~1.5 s after migrations.
- Reminder worker registered.
- `host_metric_sample` background job running every 30 s without
  pressure.
- No 4xx / 5xx in the first ~2 min of logs.

## What gets verified by Marc's first authenticated session

For each of the four read-path swaps, the wide-event annotates
`meta.<surface>.path = "rollup"` on the rollup-fast-path or
`path = "live"` on the fall-through. Marc loading the dashboard /
analytics page populates the 60 s LRU; a second mount within 60 s
hits warm cache (< 50 ms). The audit-predicted cold targets:

| Endpoint | Pre-v1.4.39 cold | Expected v1.4.39 cold |
| --- | --- | --- |
| `/api/mood/analytics` | 12.7 s (live) | ~200 ms (rollup) |
| `/api/medications/intake?scope=compliance` | 3.2 s (live) | ~200 ms (rollup) |
| `/api/dashboard/summary` cumulative sparkline | ~500 ms | ~300 ms |
| `/api/analytics` full slice live-fallback row cap | 347 k rows | ~5 k rows (425 d) |

## Self-heal verification

`/api/version` returns `1.4.39` end-to-end (curl + 10× burst). The
`VersionPoller` from v1.4.38.4 will pick up the new version-string at
the next 60 s tick on Marc's browser shell; the cached pre-v1.4.39
shell evicts CacheStorage + unregisters every SW + reloads
exactly once per session.

## Next perf-verify checkpoint

After Marc's first authenticated session, capture the wide-event
`path` annotates on each of the four endpoints from Coolify logs
and update this file with the live cold-mount numbers. v1.4.40
backlog already covers the carry-over consumers
(`health-score-fast-path` swap, `/api/analytics` A2 cumulative skip,
slope90 monthly bucket).
