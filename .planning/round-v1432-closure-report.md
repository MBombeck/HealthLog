---
file: .planning/round-v1432-closure-report.md
purpose: v1.4.32 release closure — HealthKit Tier 1 wave A
created: 2026-05-17
tag: v1.4.32
---

# v1.4.32 — release closure

Shipped 2026-05-17. First public surface wave for the HealthKit
Tier 1 metrics that the iOS contributor brief locked in for
v1.5: an end-to-end workouts flow on the web (API + list page +
detail page + dashboard tile), five new metric sub-pages riding
a shared scaffold, the HRV/RESTING_HR realignment to the
cardiovascular bucket, and a latent Prisma-field-name bug on the
workouts list endpoint cleared out before any real client saw
the 500.

## Outcome

- GitHub Release:
  <https://github.com/MBombeck/HealthLog/releases/tag/v1.4.32>.
- Tag `v1.4.32` → `c7a0ff214bba9e239c65e4b2c3c1952652f1ff28` on
  `main` (PR #177 squash).
- Sister-repos:
  - `healthlog-docs@28d64e3`
  - `healthlog-landing@ec7eccf`
- GHCR build conclusion: SUCCESS — `1.4.32` plus the rolling
  `1.4` / `1` / `latest` / `sha-<short>` tags pushed cleanly
  on both `linux/amd64` and `linux/arm64`. The 90 s
  CDN-propagation sleep from v1.4.31 stayed in place and behaved
  fine for the tag-build path.

## Commits on develop since v1.4.31

| SHA | Subject |
|---|---|
| `8d514ed1` | feat(api): expose workouts list + detail endpoints |
| `beaee579` | feat(insights): workouts list page at /insights/workouts |
| `61969fb0` | feat(insights): workout detail page with HR + route + stats |
| `3f581611` | feat(dashboard): recent workouts tile |
| `1f01b941` | feat(insights): chart cards for HRV, resting HR, SpO2, body temperature, active energy |
| `3da0b38e` | fix(i18n): drop placeholder cta keys on the wave-A empty-state blocks |
| `15077482` | chore(release): v1.4.32 (CHANGELOG + package.json) |
| `ebe4d508` | Merge remote-tracking branch 'origin/main' into develop (resolve squash-divergence on CHANGELOG/package.json/insights-layout-shell) |

## Verification

- `healthlog.bombeck.io/api/version` → `1.4.32`; `/privacy` → 200.
- `demo.healthlog.dev/api/version` → `1.4.32`; `/privacy` → 200.
- PR #177 CI green: lint+typecheck+test, integration, e2e,
  security & quality, dependency audit, secret scanning, Docker
  build (amd64 + arm64).
- Full unit suite green at 4108 passed / 1 skipped / 0 failed
  before the release commit (handoff measurement preserved).

## Iceberg notes for the next round

- The apps-01 compose file had reverted to `:latest` between
  releases, so the briefing's precise sed `:1.4.31` → `:1.4.32`
  produced a no-op on the first pass; the running container
  stayed on the stale `:latest` digest (which was still pointing
  at v1.4.30.1 on apps-01 because the prior v1.4.31 deploy went
  through the explicit-tag path on edge-01 only). Recovered by
  sed-replacing `:latest` → `:1.4.32` on apps-01 and
  force-recreating. edge-01 stayed on the documented explicit-tag
  path. Future release pipelines should grep the compose for
  both `:latest` and `:<previous-tag>` before sed, or normalise
  both hosts to the explicit-tag convention permanently.
- PR #177 came up `mergeStateStatus: DIRTY` immediately after
  open because the squash-merge of v1.4.31 had created divergent
  history on `main` that develop never absorbed. Resolved by
  `git merge origin/main` on develop, `--ours` on the three
  conflicting files (CHANGELOG / package.json /
  insights-layout-shell), and re-push. The release-marathon
  briefing should add a `git merge origin/main --no-edit` step
  before opening any develop → main PR.

## Backlog seeded for v1.4.33

- Wire the per-second HR chart on the workout detail page once
  the Measurement-side HR series consumer lands.
- Pull in MapLibre / Leaflet for the route preview replacement;
  inline-SVG polyline is the v1.4.32 zero-dependency stand-in.
- Add a sixth HealthKit metric sub-page through the
  `<HealthKitMetricPage>` scaffold to validate the four-line
  add-a-metric claim.
- Permanently pin both apps-01 and edge-01 compose to explicit
  tags; remove the `:latest` fallback from the apps-01 path.

## Blocked items

None — the entire pipeline cleared the same session. Sister-repos,
GHCR, both hosts, GH Release, and closure all landed.
