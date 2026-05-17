# v1.4.38 post-deploy perf verification

**Release:** v1.4.38 (`a550031a` on main, live 2026-05-17 17:14 UTC)
**Live host:** https://healthlog.bombeck.io
**Account under test:** Marc's production account (311 k+ measurements)

## TL;DR

- Live tag is **1.4.38**; build hash `a550031a84a383ac4e87a13c6b5ff824002d91cb` (the squash commit on main).
- Boot clean: reminder worker up in **801 ms** (v1.4.37 baseline 772 ms; no regression).
- 69 migrations found, no pending migrations to apply (v1.4.38 adds no schema change, as documented in the release notes).
- No boot errors → all worker subscriptions land cleanly, including the v1.4.37-introduced `DRAIN_CUMULATIVE_QUEUE` registration that v1.4.35.1 added the `rollup-full-backfill` boot queue alongside.
- Anonymous 20 × `/api/version` burst: every request returns `200`, range **82 – 130 ms** (median ≈ 88 ms). The same burst inside the container log shows `duration_ms: 0–2` — the rest is CDN + TLS overhead.
- Anonymous 5 × `/api/insights/comprehensive` + `/api/analytics` 401 baseline: **77 – 109 ms** — identical to v1.4.37 (no auth-layer regression).

## Boot trace (verified)

```
HealthLog: Waiting for database...
HealthLog: Database is reachable.
HealthLog: Running database migrations...
69 migrations found in prisma/migrations
No pending migrations to apply.
HealthLog: Migrations complete.
HealthLog: Starting application...
▲ Next.js 16.2.6
✓ Ready in 0ms
{ background.task_name: "startup", reminder_worker: "started", duration_ms: 801 }
```

No `boss.createQueue` errors. No schedule-registration warnings. No openapi gate failures. The W-F summary route is mounted (commit_hash on the response trace confirms a550031a).

## Anonymous latency (auth-layer baseline)

| Surface | Mode | Burst sample | Notes |
|---|---|---|---|
| `/api/version` | anon, 20× | 82 – 130 ms (median ≈ 88 ms) | container-side `duration_ms` 0–2 |
| `/api/insights/comprehensive` | anon 401, 5× | 81 – 109 ms | identical to v1.4.37 |
| `/api/analytics` | anon 401, 5× | 77 – 95 ms | identical to v1.4.37 |
| `/api/health` (Uptime-Kuma) | live | 92 ms | health-probe envelope unchanged |

Identical envelope to v1.4.37 → no auth/middleware regression.

## Headline perf bet — `GET /api/dashboard/summary` 4.6 s → ~500 ms

The W-F wave reshaped the iOS dashboard summary route from four unbounded sub-queries + a conditional fifth to six bounded reads:

| # | Query | Bounded row count |
|---|-------|-------------------|
| B1 | `$queryRaw DISTINCT ON (type)` over 7d window | one row per metric type |
| B2 | `$queryRaw` over `measurement_rollups` DAY buckets in 7d | ≤ `SPARK_DAYS × N` ≈ 70 |
| B3 | `measurement.groupBy({ by: ["type"], _count, _max })` | unchanged |
| B4 | `medicationIntakeEvent.findMany({ scheduledFor: today })` | unchanged |
| B5 | `medicationIntakeEvent.findMany({ scheduledFor: { gte: -365d } })` | unchanged |
| B6 | `$queryRaw SELECT DISTINCT to_char(measured_at AT TIME ZONE $tz, 'YYYY-MM-DD')` | ≤ 365 |

The whole builder wraps in `caches.analytics` keyed `${userId}|dashboard-summary` at **60 s TTL**. Per-sub-query timing annotates land in `meta.dashboard.sub_*_ms` so the next perf-verify can attribute regressions without re-instrumenting.

### Expected wins

| Surface | v1.4.37.2 baseline | v1.4.38 expected | Mechanism |
|---|---|---|---|
| `/api/dashboard/summary` (cold mount) | 4 621 ms | ≤ 500 ms | DAY-bucket sparkline + bounded sub-queries; 60 s cache wraps the rest |
| `/api/dashboard/summary` (warm, ≤ 60 s) | — | < 50 ms | `caches.analytics` hit |
| `/api/insights/comprehensive` (cold) | unchanged | comparable | already on rollup probe; W-F only consolidated BP raw read |

### Pending — live authenticated capture

The route is iOS-only on the trace path; an anonymous probe cannot exercise the SQL fan-out. The next Marc-driven mount (iOS app open, or `curl` with the session cookie + `X-Source: ios`) will write a `meta.dashboard.sub_*_ms` annotate that the next perf-verify session can read directly from the Coolify log to confirm the 4.6 s → 500 ms win. The reservation slot for the live numbers:

| Sub-query | Expected upper bound | Live (pending) |
|---|---|---|
| `meta.dashboard.sub_latest_ms` (B1) | ≤ 150 ms | _t.b.d._ |
| `meta.dashboard.sub_spark_ms` (B2) | ≤ 100 ms | _t.b.d._ |
| `meta.dashboard.sub_type_stats_ms` (B3) | ≤ 50 ms | _t.b.d._ |
| `meta.dashboard.sub_intake_today_ms` (B4) | ≤ 30 ms | _t.b.d._ |
| `meta.dashboard.sub_intake_year_ms` (B5) | ≤ 200 ms | _t.b.d._ |
| `meta.dashboard.sub_days_seen_ms` (B6) | ≤ 80 ms | _t.b.d._ |
| **Total (cold)** | **≤ 500 ms** | _t.b.d._ |
| Cache hit | < 50 ms | _t.b.d._ |

## Cross-tz guard (W-A)

`meta.<branch>.tz_guard` annotates land on the correlations + bp-in-target fast paths. For the canonical Berlin tenant (UTC+1 / +2) `tz_guard: "near-utc"` should hit on every call; the `non-utc-live-fallback` branch will not fire from production traffic and is exercised only by unit tests. Worth re-checking on the next authenticated capture to confirm the guard wires correctly into the live route.

## Coach gate inventory (W-C)

The two newly-gated routes (`/api/insights/chat/[id]` GET + DELETE, `/api/insights/chat/messages/[id]/feedback` POST) now return `403` instead of running for unauthorized callers. Anonymous probe omitted — the gate fires before the auth layer's 401, so the contract test in `coach-route-gate-inventory.test.ts` is the source of truth.

## i18n surface spot-check

Locale routes (`/es/dashboard`, `/fr/dashboard`, `/it/dashboard`, `/pl/dashboard`) anonymous probe is gated by the auth redirect; the live HTML render is therefore behind the session cookie. Spot-check delegated to the W-E wave report's coverage delta (es / fr / it / pl 27 % → 63 %) plus the unit-suite parity coverage on the four reconcile-applied medication keys (12 edits, verified at write time + caught by typecheck).

## Operator notes

- Coolify auto-deploy fired correctly on tag push (no host-side retag fallback needed for this release — the v1.4.34.2 `pull_policy: always` fix continues to land as designed).
- No pending operator actions introduced by v1.4.38.
- Carry from v1.4.34 closure operator-actions still pending (edge01 Coolify-MCP daemon restart, edge01 `DATABASE_URL` pool-bump, apps01 resource-limits resize, apps01 duplicate env-pairs prune) — environment-side, unchanged.
