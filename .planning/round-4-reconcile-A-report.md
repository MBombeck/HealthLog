---
file: .planning/round-4-reconcile-A-report.md
purpose: R4-reconcile-A close-out — five atomic commits resolving the backend correctness / security / i18n findings
created: 2026-05-16
contributor: R4 reconcile-A
---

# v1.4.28 R4 reconcile-A — close-out report

Five atomic commits land on `develop` between `5570971f` and `cf8e7022`,
disjoint from R4-reconcile-B's UI / a11y commits that interleaved on the
same branch. Every commit cleared the per-commit gate (`pnpm typecheck`
+ `pnpm lint` + the relevant Vitest pattern).

## Commits

| # | SHA | Subject |
|---|---|---|
| 1 | `0d256230` | `fix(api): aggregate measurements before applying the take limit` |
| 2 | `8144281d` | `fix(charts): keep all-time charts full-history via monthly aggregation` |
| 3 | `1920a763` | `fix(api): rate-limit and validate the web-vitals beacon` |
| 4 | `f91b4732` | `test(api): cover workout-edit duplicate-timestamp via measurements` |
| 5 | `cf8e7022` | `i18n: translate duplicate-timestamp and sleep description in fr/es/it/pl` |

## Findings closed

- **R4-CODE-C1** — `/api/measurements` aggregation branch now runs as a
  Postgres `date_trunc` GROUP BY query, so the `take` cap applies AFTER
  bucketising. A 1-year `aggregate=daily` window on a minute-by-minute
  pulse account returns up to 365 daily buckets (per the new
  `BUCKET_CAP`) instead of silently truncating to the first N raw rows.
- **R4-CODE-C2** — the aggregation branch is gated on `aggregate &&
  aggregate !== "raw"`. iOS callers that pass `from`/`to` without
  `aggregate` keep the raw `MeasurementWireDTO` shape. The v1.5 locked
  contract is byte-stable.
- **R4-CODE-C3 / Security H-1 / SD-C2** — web-vitals beacon hardened:
  same-origin Referer check (when `NEXT_PUBLIC_APP_URL` is set), per-IP
  `checkRateLimit(60/min)`, Zod schema with the six documented metric
  names and a 50-char id cap. Only validated fields enter the wide-event
  log — the raw payload is never observed.
- **SD-H1** — "All time" range now resolves to monthly aggregation
  (24-bucket ceiling) or weekly (when full history < 2 years) so the
  chart paints the user's true full history. New `monthly` grain added
  to the `aggregate` enum.
- **SD-C1 / FB-B1** — audit confirmed there is no `/api/workouts/[id]`
  PUT or PATCH route. Workouts are ingested via `POST
  /api/workouts/batch` only, and the maintainer's "Sport edit" flow
  routes through `/api/measurements/[id]` for sport-typed samples
  (ACTIVE_ENERGY_BURNED, FLIGHTS_CLIMBED, WALKING_RUNNING_DISTANCE).
  The existing 409 fix already covers the surface; a new test pins it.
- **HI-01** — `measurements.duplicateTimestamp` translated in fr / es /
  it / pl.
- **HI-02** — `insights.sleep.description` translated in fr / es / it / pl.

## Tests

17 new Vitest cases land across the five commits:

- `src/app/api/measurements/__tests__/range-aggregation-route.test.ts` —
  5 cases (iOS gate, daily 365-bucket assertion, monthly cap,
  all-time monthly, all-time weekly).
- `src/lib/measurements/__tests__/range-aggregation.test.ts` — 3 new
  cases (monthly threshold, monthly grain, BUCKET_CAP).
- `src/app/api/internal/web-vitals/__tests__/route.test.ts` — 8 cases
  (happy 204, schema rejects × 3, malformed JSON, 429, cross-origin
  drop, same-origin accept).
- `src/app/api/measurements/__tests__/put-duplicate-timestamp.test.ts`
  — 1 new case (sport-typed `ACTIVE_ENERGY_BURNED` row).

Owned-surface test count: 192 / 192 green.
Full suite delta: 3953 → 3974 passing (1 skip retained). The six
`DrugLevelChart.test.tsx` failures live in R4-reconcile-B's touch
surface (`src/components/medications/DrugLevelChart.tsx`) and are not
addressed here per the touch-disjoint working agreement.

## iOS contract verification

- `GET /api/measurements` raw branch byte-stable for any caller that
  omits the new `aggregate` query parameter — iOS read path
  (`MeasurementsRepository.recent`) calls with `limit` only, never
  reaches the aggregation branch. Confirmed against the R4 iOS-contract
  reviewer's per-endpoint table.
- New `aggregate=monthly` value is additive in the Zod enum;
  pre-existing locked-contract sample uses `"raw"|"daily"|"weekly"` —
  the new monthly token simply unlocks the longer-window path. Logged
  as an additive contract evolution; iOS-side `Mirror` decoder is
  permissive on the enum (string-backed).
- `PUT /api/measurements/[id]` — no shape change; the 409 path was
  already additive in v1.4.28 baseline.
- `POST /api/internal/web-vitals` — internal-only; iOS does not consume.

## Blockers carried forward

- **chart-data client wiring** — `src/components/charts/health-chart.tsx`
  (R4-reconcile-B's territory under the UI/a11y split) still defaults
  the "All time" tab to a 365-day client window with no `aggregate`
  param. The server-side machinery is in place; flipping the client to
  pass `aggregate=monthly` (or `weekly` when history < 2 years) plus the
  user's earliest measurement as `from` is the last 4-line edit needed
  to make SD-H1 a closed-loop user fix. Surfacing here so R4-reconcile-B
  or the next pass picks it up.
- **DrugLevelChart.test.tsx (6 failing)** — outside touch surface; flag
  for R4-reconcile-B.

## Forbidden-vocab check

`git log --since=5570971f --pretty=%s%n%b` over the five
reconcile-A commit messages: zero matches on `AI`, `Claude`, `agent`,
`marathon`, `wave`, `phase`, `session`, `subagent`, `Anthropic`, or
maintainer first-name. Messages read as Marc-Voice professional English.
