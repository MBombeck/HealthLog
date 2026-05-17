# v1.4.36 post-deploy perf verification

**Release:** v1.4.36 (`0e2a99f8` on main, live 2026-05-17 11:28 UTC)
**Live host:** https://healthlog.bombeck.io
**Account under test:** Marc's production account (311,779 measurements, 8 metric types)

Marc directive verbatim: *"muss jetzt deutlich schneller sein, sowohl
Coach als auch Dashboards — wir dürfen nicht mehr mit Millionen von
Daten umgehen."*

## TL;DR

- **Page-blocking critical path: 10.88 s → 4.57 s cold (−58 %).**
  `/api/insights/comprehensive` no longer holds the Insights shell;
  each section now renders its own skeleton in parallel.
- **AI prompt payload: ~25.9 MB → 30,096 tokens (~120 KB)** —
  confirmed via the `tokensUsed:30096` annotate on a real
  `insights.generate` codex run. The "Millionen von Daten"
  framing is now false.
- **Rollup-fast-path is firing.** The slim summaries slice emitted
  `"path":"rollup"` on the live cold hit. Cold 4.15 s, warm 756 ms,
  cached 11–28 ms.
- iOS surfaces stable: paginated `measurement.list` (311k-row table)
  88–114 ms, `measurements.series` 11–52 ms, batch ingest 254 ms,
  dashboard widgets miss 8 ms.
- Migration `0068_v1436_insights_exclude_metrics` applied cleanly on
  boot; reminder worker up in 702 ms.

## Page-blocking critical path

| Surface | Cold | Warm DB | Cache HIT | Notes |
|---|---|---|---|---|
| `/api/insights/comprehensive` | **4566 ms** | 190 ms | **28–36 ms** | down from 10.88 s baseline (−58 %). 3478 measurements / 170 mood entries in 90-day window |
| `/api/insights/targets` | 1609 ms | — | < 50 ms (LRU) | analytics LRU eviction wired |
| `/api/analytics?slice=summaries` | 4153 ms (rollup) | 756 ms | **11–28 ms** | `"path":"rollup"`, 306,368 row_count |

## Per-section fill-in (does NOT block page render in v1.4.36)

| Surface | Cold | Payload | Notes |
|---|---|---|---|
| `/api/insights/weight-status` | 20057 ms | 40,757 B | LLM latency (codex/GPT-5.3) |
| `/api/insights/blood-pressure-status` | 20050 ms | 32,198 B | LLM latency |
| `/api/insights/mood-status` | 22243 ms | 5,553 B | LLM latency |
| `/api/insights/generate` (full) | 142,264 ms | **30,096 tokens** | codex/GPT-5.3, cached false. Prompt size confirms the rollup-bucket swap landed: 30,096 tokens (~120 KB) vs the 25.9 MB raw baseline. |

The wall-clock on each `insights/*-status` call is the LLM
provider round-trip, not anything v1.4.36 changes. The win is that
they now run in parallel under the new shell instead of one
blocking the other.

## iOS surface sanity

| Surface | Cold | Notes |
|---|---|---|
| `POST /api/measurements/batch` | 254 ms | 1 inserted, 0 duplicates |
| `GET /api/measurements` (paginated) | 88–114 ms | total 311,779 rows |
| `GET /api/measurements/series?days=30` | 11–52 ms | per-kind series |
| `GET /api/dashboard/widgets` | 8 ms | cache miss |
| `GET /api/feature-flags` | 6–122 ms | first request cold, then warm |
| `GET /api/auth/me` | 32 ms | session lookup |
| `GET /api/auth/passkeys` | 75 ms | — |
| `GET /api/medications/.../intake` | 41 ms | total 150 |
| `GET /api/medications/.../glp1` | 27–53 ms | per-medication |

## Code-path confirmations

- **Rollup read-swap firing**: slim-summaries meta carries
  `"analytics":{"slim_summaries":{"row_count":306368,"type_count":8,"path":"rollup"}}`.
  The `"path":"rollup"` value is the breadcrumb emitted only when
  `summaries-slice.ts` took the rollup-fast-path on the
  fully-covered branch.
- **Migration 0068 applied at boot**: docker log shows
  `Applying migration 0068_v1436_insights_exclude_metrics` then
  "All migrations have been successfully applied" before
  Next.js came up. No reader-path stall.
- **Per-section early-skeleton paint**: Marc's first cold load
  fired `/api/insights/comprehensive`, `/api/analytics`,
  `/api/insights/targets`, `/api/mood/analytics`,
  `/api/gamification/achievements`, `/api/auth/passkeys`,
  `/api/bugreport/status`, `/api/insights/generate`,
  `/api/insights/{weight,blood-pressure,mood}-status` all within
  ~6 s, in parallel. Pre-v1.4.36 the page held the entire shell
  on `/api/insights/comprehensive` (10.88 s) before any section
  could render.
- **AI prompt payload trim**: `tokensUsed:30096` confirms the
  rollup-bucket swap in `extractFeatures` landed. 30,096 tokens
  is ~120 KB — well inside the < 1 MB target and ~99.5 % below
  the 25.9 MB raw-measurements baseline.

## Open issues (deferred to v1.4.37)

- **`/api/analytics` (FULL, not slim)**: first cold hit was
  **111,092 ms** (correlations + healthScore + bp_in_target,
  three concurrent queries on a cold-pool DB). On the next
  navigation 2 minutes later it dropped to 756 ms (slim again),
  and cache HITs settled at 11–28 ms. The full aggregator's
  correlations and healthScore branches still run live SQL and
  did not get touched by v1.4.36. This matches the explicit
  deferred-list item from the handover: *"narrow-aggregate query
  still scans 90 days of measurements; the column-pruning won is
  real but NOT the headline 'sub-second' claim."* File a v1.4.37
  P1 to collapse the correlations / healthScore branches onto the
  rollup-coverage probe.
- **`/api/mood/analytics`** (out of v1.4.36 scope): 3.5 s cold for
  359 mood entries — separate codepath, not touched this release.
- **HAR capture not yet collected**: Chrome devtools HAR for the
  cold mount is the authoritative source for FCP/TTI/CLS. The
  pinned `trends-row-chart-slot` height should drop CLS toward
  zero; capture and attach when convenient.

## Verdict

The release lands the Marc directive. The page-blocking
critical-path call is materially faster (10.88 s → 4.57 s cold, ~28 ms
warm cache), the AI prompt payload trim is confirmed by a real
codex run (30,096 tokens vs 25.9 MB baseline → **99.5 % reduction**),
and the rollup-fast-path is wired and firing on the slim
summaries slice. Per-section AI status calls each take ~20 s but
they no longer block the page — exactly the deferral pattern
v1.4.36 was designed to deliver.

**Action**: ship as v1.4.36, file the full-`analytics`-route window
tightening as v1.4.37 P1.
