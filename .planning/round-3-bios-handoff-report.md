---
file: .planning/round-3-bios-handoff-report.md
purpose: Contributor report for the doc-only iOS handoff addendum landed in v1.4.27
created: 2026-05-15
---

## File written

`.planning/v15-ios-handoff/22-standalone-and-server-pairing.md`

- Word count: 3101
- Sibling of the existing `22-offline-first-architecture.md`; same research source (R1.5 `.planning/research/v1427-r1-ios-offline.md`), neutral framing per maintainer directive

## Sections

1. The three patterns (A standalone-first + optional pairing, B HealthKit-canonical, C status-quo + banner) — with the Pattern A recommendation and rationale
2. What "works without an internet connection" means here — frames standalone as a first-class operating mode, not an outage fallback
3. Pattern A — full specification (canonical SwiftData store, `SyncMode` enum, pairing flow, unpair flow, sync triggers, what does NOT change)
4. Conflict resolution policy (`syncIdentifier` + `syncVersion`, the six rules, what we explicitly do not do)
5. Feature parity matrix — every iOS surface marked works-standalone / needs-server / graceful-degradation
6. Server-side preparations — none in v1.4.27; `syncVersion`, `deletedAt`, `GET /api/sync/state`, ETag deferred to v1.4.28; HealthKit write-back / local PR / local Coach / conflict-UI deferred indefinitely
7. Cross-references
8. Sequencing recommendation

## Framing-language traps flagged for maintainer awareness

The maintainer asked me not to retro-rename other files. These are the spots where the older "offline-first" framing still lives in the handoff pack — flagged here only:

- `.planning/v15-ios-handoff/22-offline-first-architecture.md` — the sibling reference doc. Filename, frontmatter `purpose`, TL;DR, and several body headings all use "offline-first architecture" framing. The new doc supersedes it on framing only; content is parallel.
- `.planning/v15-ios-handoff/README.md` — the inventory table currently lists 21 files and does not yet mention either `22-*` file. No "offline-first" framing in the README itself, but the inventory + question-map + reading-orders-by-goal will need a refresh once the maintainer decides which of the two 22-* files is the canonical reference.
- `.planning/v15-ios-handoff/06-ios-responsibilities.md` lines 14, 19, 213, 215, 241, 243, 253, 316, 366 — use "offline-first" / "offline cache" / "offline mode" framing throughout Domain 4. These are descriptive (cache + queue, not architecture), so the framing is less load-bearing than in the 22 file, but the section title "Domain 4 — Offline cache + sync queue" is the one a future iOS reader will hit first when looking for the cache contract.
- `.planning/v15-ios-handoff/16-health-score-logic.md` lines 224, 228, 247 — talks about "render a score offline" + "showing last synced score" banner. Old framing; if the new framing sticks, the Health Score docs eventually want a "renders only when paired" rewrite, but per the v1.4.28 plan Health Score is server-derived and never renders offline anyway, so the practical risk is low.
- `.planning/v1427-fix-plan.md` Section 4 Decision C + Section 6 — both reference `22-offline-first-architecture.md` by filename as the artifact this round was supposed to write. The fix-plan does not need a retro-edit since it documents what was decided at planning time, but a future v1.4.28 plan should reference the new filename.

No fixes applied. All five spots stay as-is per the directive.

## Commit

Single atomic commit on `develop`: `docs(planning): iOS handoff addendum for standalone usage and server pairing`.
