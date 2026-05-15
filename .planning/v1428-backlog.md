---
file: .planning/v1428-backlog.md
purpose: v1.4.28 backlog seeded from v1.4.27 deferrals
created: 2026-05-15
---

# v1.4.28 backlog

Items deferred from v1.4.27 with a clear rationale. Sorted by source bucket.

## From bucket B1 — Dashboard rebuild (v1.4.27)

- **F7 weekly-report dead click — needs maintainer screenshot.** Scan budget (30 min) across `src/` and `messages/` returned no dead affordance. Every weekly-report click target on `/insights` routes correctly to `/insights/report/[week]`. The retired `<InsightsCardPreview>` was the only dashboard-anchored insight CTA in v1.4.27 — its removal in B1 commit 3 is the most likely reason the maintainer perceived a dead click. Ask the maintainer to point at the dead element with a screenshot. If they confirm the dashboard side, add a slim "Wochenreport für KW {N}" banner on `/` mirroring the `<WeeklyReportBanner>` from the hero, gated on a fresh advisor payload.
