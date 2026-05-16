---
file: .planning/round-v1429-closure-report.md
purpose: v1.4.29 release closure — dashboard performance + chart polish patch
created: 2026-05-16
tag: v1.4.29
---

# v1.4.29 — release closure

Shipped 2026-05-16 mid-day. Targeted performance + polish patch closing the dashboard slowness the maintainer surfaced after v1.4.28.1, plus the chart-axis + mobile-tile-symmetry findings from the v1.5 research wave.

## Outcome

- `healthlog.bombeck.io/api/version` → `1.4.29`, `/privacy` → 200.
- `demo.healthlog.dev/api/version` → `1.4.29`, `/privacy` → 200.
- GitHub Release: <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.29>.
- Sister-repos: `healthlog-docs@939e26c`, `healthlog-landing@a646c6c`.

## Commits on develop since v1.4.28.1

| Commit | Subject |
|---|---|
| `6e75463f` | fix(api): pass aggregate grain as a SQL literal to date_trunc |
| `642e78a6` | fix(api): aggregate cumulative measurement types as a sum |
| `cdc9c5f2` | perf(charts): wire aggregate=daily for windows beyond a week |
| `5662fbec` | fix(dashboard): unify chart-overlay-prefs cache key with dashboardWidgets |
| `f463ca81` | fix(charts): use explicit tick positions on numeric x-axes |
| `d381f23e` | fix(dashboard): equal-height tile contract on mobile |
| `b0126418` | fix(settings): tighten the dashboard-layout drag-list rows on mobile |
| `c1a52c32` | perf(dashboard): bound glucose + bp-in-target windows and stale-time the inline queries |
| `59968eb1` | chore(release): v1.4.29 |
| `bb6a56dc` | chore(merge): reconcile main into develop for v1.4.29 release |

Squashed on `main` at `d76c0b56`; tag `v1.4.29` points there.

## Findings closed

- **C2 P0** — `/api/measurements?aggregate=daily|weekly|monthly` returned 500 in production for every grain because `${truncUnit}` was passed as a bound parameter to `date_trunc`, which requires a literal. Tests passed because `prisma.$queryRaw` was mocked. Fix injects the grain via `Prisma.raw` after validating against the enum set. Latent since v1.4.28 commit `0d256230`; no consumer wired the path yet so production was unaffected user-side.
- **AVG/SUM** — Same aggregation branch averaged step counts instead of summing for cumulative HealthKit types (`ACTIVITY_STEPS`, `ACTIVE_ENERGY_BURNED`, `FLIGHTS_CLIMBED`, `WALKING_RUNNING_DISTANCE`, `TIME_IN_DAYLIGHT`). New `CUMULATIVE_HK_TYPES` set drives the grain choice.
- **C3** — Pulse chart wires `aggregate=daily` for windows beyond a week. Cap on the client payload drops from ~5 000 raw rows to ~365 daily rows for pulse-rich accounts. Combined with C2 + AVG/SUM, this is the perceived-slowness fix the maintainer asked for.
- **C4** — `useChartOverlayPrefs` cache-key collision. Hook read `/api/dashboard/widgets` under `["dashboard-layout"]` while the rest of the codebase used `queryKeys.dashboardWidgets()`. Same endpoint, two cache slots, duplicate fetch on every dashboard mount.
- **X-axis tick positions** — Charts using `<XAxis type="number">` ignored Recharts' `interval` prop (numeric-axis semantic). New `computeTickPositions()` helper returns explicit tick indices that Recharts honours.
- **Mobile tile equal-height** — `--tile-h:140px` CSS custom property at `<sm`, `auto` from `sm:` upwards. `line-clamp-1 min-h-[18px]` on the comparison-delta callout. `flex-nowrap overflow-hidden` on the sub-row pair at `<sm`.
- **Settings drag-list compactness** — Vertical 44+44 px arrow stack collapses to a horizontal pair (`size-11 sm:size-9`). Row drops 116 px → 48 px. `truncate` on the label.
- **Perf mid-tier** — `glucoseRows` findMany bound to last 30 days for the dashboard tile path. BP-in-target chunked walk bound to last 365 days. Three inline dashboard `useQuery` blocks gain `staleTime: 60_000` + `refetchOnWindowFocus: false`.
- **Real-Postgres integration test** — New container fixture covers the aggregation path that mocks could not.

## Deploy mechanics note

apps01 + edge-01 both deployed via explicit `1.4.29` image tag rather than `:latest`. Coolify's auto-deploy on apps01 fired but the pulled `:latest` was stale (the prior v1.4.28.1 main-branch build was the last to update it; v1.4.28.1's tag-build only emitted `sha-232ea43` per the four-segment workflow gap). The corrected workflow at `3a920661` produces `1.4.29` on the tag-build cleanly; the explicit tag override on the host docker-compose was a one-time correction. Subsequent releases on three-segment versions land via the standard `:latest` path.

Edge-01 first SSH pass left a malformed `image:` line because the sed pattern matched the closing quote on the prior `sha-232ea43` reference; the .pre-v1429.bak restore + a tightened regex (matching the bare image suffix) finished the rollout.

## v1.4.30 scope seed

Two new items surfaced during the v1.4.29 window:

- **Insights tab-strip blocking on mobile** (root-causing at `.planning/research/v15-insights-blocking-bug.md`) — main-thread blockade during initial load on `/insights`. Three small client fixes ride v1.4.30: AbortController + 8 s timeout on `fetchAdvisor`, `React.memo` + `useMemo` on the tab strip, `next/dynamic` on `<CoachDrawer>`.
- **Assistant-optional operator toggles** (architecture at `.planning/research/v15-assistant-optional.md`) — 6 boolean feature flags on `AppSettings` for the 7 assistant-driven surfaces, plus an admin panel + iOS `GET /api/feature-flags` endpoint. Single v1.4.30 wave (~14 hours).

v1.4.30 scope grows from the original iOS-server-prep menu to that menu plus these two add-ons. Strategic plan update lands alongside.

## Closure complete

v1.4.29 lives on both production hosts and the GitHub Release reads it as the latest. The next patch is v1.4.30 (iOS-server-prep menu + insights-blocking + assistant-optional toggles).
