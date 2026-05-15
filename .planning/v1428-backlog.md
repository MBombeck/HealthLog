---
file: .planning/v1428-backlog.md
purpose: v1.4.28 backlog seeded from v1.4.27 deferrals
created: 2026-05-15
---

# v1.4.28 backlog

Items deferred from v1.4.27 with a clear rationale. Sorted by source bucket.

## From bucket B1 — Dashboard rebuild (v1.4.27)

- **F7 weekly-report dead click — needs maintainer screenshot.** Scan budget (30 min) across `src/` and `messages/` returned no dead affordance. Every weekly-report click target on `/insights` routes correctly to `/insights/report/[week]`. The retired `<InsightsCardPreview>` was the only dashboard-anchored insight CTA in v1.4.27 — its removal in B1 commit 3 is the most likely reason the maintainer perceived a dead click. Ask the maintainer to point at the dead element with a screenshot. If they confirm the dashboard side, add a slim "Wochenreport für KW {N}" banner on `/` mirroring the `<WeeklyReportBanner>` from the hero, gated on a fresh advisor payload.

## From bucket B7 — Symmetry sweep + dead-code cleanup (v1.4.27)

- **README-referenced admin / monitoring orphan endpoints.** Five endpoints flagged by R1.6 as candidate-orphan have no runtime caller in `src/` but are documented as part of the API surface in `README.md` lines 362–382 + `CHANGELOG.md` 752–753. Per the v1.4.27 fix-plan scope-maximization directive ("if a consumer surfaces e.g. CI script, uptime probe, README reference, defer that single endpoint to v1.4.28"), each of the five defers:
  - `/api/admin/ai-settings` (GET + PUT) — README line 362–363 + CHANGELOG 752 + 3261.
  - `/api/admin/backup/test` (POST) — README line 368 + CHANGELOG 752.
  - `/api/admin/status-overview` (GET) — README line 367 + CHANGELOG 753 + AGENTS.md 194.
  - `/api/monitoring/glitchtip/test` (POST) — README line 381.
  - `/api/monitoring/umami/test` (POST) — README line 382.
  - **Decision needed:** either wire each endpoint to a real consumer (admin Settings UI, ops dashboard, uptime probe) or drop both the route and the README mention in the same commit. The README mention alone is not load-bearing if no operator reads it; a 30-second `gh search code` over the public mirrors of HealthLog deployments would tell us whether a downstream operator scripts against any of them.
- **i18n key `insights.coach.window.lastYear` missing across six locales.** B7 commit 6 added the `lastYear` snapshot-window enum value and wired the source-chip resolver to look up `insights.coach.window.lastYear`. The key resolves through the i18n fallback chain to the raw key string today; B6 (the i18n bucket) owns messages/*.json and should add the key to all six locales in v1.4.28. EN copy: "year so far"; DE: "Jahresrückblick"; FR/ES/IT/PL: respective locale-native translations.
