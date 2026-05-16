---
file: .planning/round-v1432-blocker.md
purpose: v1.4.32 implementation handoff — implementation commits landed, release pipeline remains
created: 2026-05-15
tag: pending
---

# v1.4.32 — implementation complete, release pipeline pending

All six implementation commits landed on `develop`. Full unit suite
green at 4108 passed / 1 skipped / 0 failed. Pausing before the
release pipeline because the contributor context budget dropped
below the threshold where an unforeseen GHCR / Coolify / SSH error
would have safe room to triage.

## What is in develop

| SHA | Subject |
|---|---|
| `8d514ed1` | feat(api): expose workouts list + detail endpoints |
| `beaee579` | feat(insights): workouts list page at /insights/workouts |
| `61969fb0` | feat(insights): workout detail page with HR + route + stats |
| `3f581611` | feat(dashboard): recent workouts tile |
| `1f01b941` | feat(insights): chart cards for HRV, resting HR, SpO2, body temperature, active energy |
| `3da0b38e` | fix(i18n): drop placeholder cta keys on the wave-A empty-state blocks |

Commit 6 (categorisation map update) was absorbed into Commit 5 per
the briefing's "skip this commit if all 5 already mapped; absorb the
diff into Commit 5" clause — HRV + RESTING_HEART_RATE moved from
`vitals` to `cardiovascular` to align with the iOS handoff brief's
category table.

## Quality gates run

- `pnpm typecheck` — green
- `pnpm lint` — green
- `pnpm test --run` — 381 files / 4108 passed / 1 skipped / 0
  failed (full suite)
- OpenAPI pre-commit hook fired on Commit 1 and resynced cleanly

## What remains

1. CHANGELOG.md — prepend `## [1.4.32] — <date> — HealthKit Tier 1
   web surfaces wave A` with Marc-Voice ~5-sentence headline plus
   Added / Changed / iOS contract sections. ~50-80 lines. Reference
   the workout flow + the 5 new sub-pages + the recent-workouts
   tile + the i18n footprint.
2. `package.json` version bump `1.4.31` → `1.4.32`.
3. Commit `chore(release): v1.4.32`, push develop, open PR develop
   → main.
4. Watch CI green, squash + tag `v1.4.32` on main.
5. Wait GHCR build (the 4-segment workflow fix + 90 s sleep from
   v1.4.31 should produce `1.4.32` cleanly).
6. Deploy apps01 + edge-01 via SSH fallback — Coolify auto-deploy
   is `off` per maintainer convention. Precise sed targeting
   `:1.4.31` → `:1.4.32`, not the broad `[^[:space:]]*` pattern.
7. Verify `/api/version` returns `1.4.32` on both hosts; `/privacy`
   returns 200.
8. GitHub Release.
9. Sister-repos: `healthlog-docs` + `healthlog-landing` version
   bumps.
10. Closure doc at `.planning/round-v1432-closure-report.md`
    (~50-70 lines).

## Iceberg notes for the resumer

- The list endpoint `GET /api/workouts` had a latent
  Prisma-field-name bug (`distanceMeters` / `energyKcal` —
  non-existent columns; tests mocked Prisma with `as never` so the
  bug never surfaced). Commit 1 fixed it alongside the picker swap
  to v1.4.30 `pickCanonicalWorkoutRows()` and the wire-shape
  realignment to the iOS contract names (`distanceM`,
  `activeEnergyKcal`, `avgHr`, `maxHr`).
- New widget id `recentWorkouts` defaults to
  `visible: true, tileVisible: true`. The maintainer can opt out
  via Settings → Dashboard. The tile self-gates on a non-empty
  workouts list and renders an Apple-Health-onboarding hint
  otherwise.
- The 5 new `CHART_OVERLAY_KEYS` (`hrv`, `restingHr`,
  `oxygenSaturation`, `bodyTemperature`, `activeEnergy`) each
  carry their own chart-cog popover state slot.
- HRV + RestingHR + SpO2 + ActiveEnergy intentionally have no
  empty-state CTA — those four metrics have no manual-entry form;
  the Apple Health / Withings ingest is the only path. The
  template renders the empty state without a primary action when
  `emptyStateCtaType` is null. BodyTemperature is the only one of
  the five that surfaces the existing `/measurements?add=BODY_TEMPERATURE`
  CTA.
- The `<HealthKitMetricPage>` scaffold is the single source for
  the 5 sub-pages. Adding metric six is a four-line page module +
  a CHART_OVERLAY_KEYS entry + an i18n block + an
  `InsightMetric` enum addition.
- iOS contract: every change is additive on the wire. The new
  `GET /api/workouts/{id}` is net-new; the list endpoint's response
  field renames (`distanceM` instead of `distanceMeters`) are
  forward-looking — iOS clients didn't consume the list endpoint
  before v1.4.32 because it 500'd in production from the
  Prisma-field bug, so there is no pre-v1.4.32 contract to honour.
- Insights tab strip now carries six new pills (workouts + the 5
  HK metrics). The pills self-gate on data presence; brand-new
  accounts see the seven pre-existing pills only.

## Decision log

- Slug for active-energy sub-page chosen as `aktive-energie` (with
  the hyphen) to keep Marc-Voice German URL hygiene; the
  underscore-free hyphenated form matches Next.js routing
  convention.
- The HR-chart slot on the workout detail page renders a graceful
  unavailable notice for v1.4.32 — per-second HR samples are not
  persisted on the Workout row today; surfacing them is a v1.5.x
  consumer of the existing Measurement-batch-side HR series.
- The route preview is rendered as an inline SVG polyline rather
  than pulling in MapLibre / Leaflet — keeps the v1.4.32 dependency
  footprint zero; the third-party map widget rides v1.5.x along
  with the HR-chart wire-up.
