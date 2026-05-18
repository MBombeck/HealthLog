# v1.4.39 QA — Product-Lead Review

Reviewer: Product Lead (read-only, strategic).
Inputs: 5 wave reports (W-MOOD, W-MED, W-SUM, W-WMY, W-SINCE),
`.planning/round-v1438-perf-analysis.md`, `git log v1.4.38.8..develop`,
`prisma/schema.prisma` diff, `.planning/round-v1439-backlog.md`.

## Strategic posture

v1.4.39 lands the v1.4.38 perf audit's §5 P2 + P3 + P4 + P6 in a single
release — three new persistence tiers (`mood_entry_rollups`,
`medication_compliance_rollups`, `measurement_rollups.sum_value`) plus
the read-side helpers that finally consume the WEEK/MONTH/YEAR write
amplification the audit called out as "dead weight." The five-wave
decomposition tracks the audit cleanly: every wave anchors to a numbered
P-item and every wave ships a writer + reader + boot-backfill + tests in
the well-trodden pattern v1.4.35 / v1.4.38.5 established. This is the
release where the rollup architecture stops being a measurement-only
tier and becomes the canonical second layer for mood + medication +
cumulative sums.

The release deliberately stays inside the read-path optimisation lane.
No API contract changes, no UI changes, no iOS contract surface. The
deferred items (W-SUM A2 swap, W-MED health-score-fast-path hookup,
W-WMY slope90, W-WMY slim-slice all-time aggregate) are all internal
helper swaps that wire newly-shipped tiers into not-yet-converted
consumers — they sit in the v1.4.40 column and don't gate iOS work.
Marc's strategic ask ("blazing-fast queries, never throw away raw data")
is preserved on both axes: raw tables are untouched, every new tier is
a derived second layer with a documented live fallback.

v1.5 readiness is **green from this release's perspective**. The
release ships zero new iOS-facing contracts, the medication-compliance
tier already uses a per-user-tz string `day` column (sidestepping the
`isNearUtc` blocker that gates the measurement-rollup fast-paths), and
W-WMY's `computeLongWindowSummary` is the helper a v1.5 "year in mood"
or multi-year trend card can call without any further backend work.
The cross-tz proper-fix + per-source rollup + slope90 hookup remain the
v1.5 architectural backlog — unchanged from the v1.4.38 closure.

## Perf claim audit

| Endpoint | Claim | Evidence in report | Confidence |
|---|---|---|---|
| `/api/mood/analytics` cold | 12.7 s → ~200 ms | Audit §5 P2 estimate + writer + 21 unit/route tests + bounded 1 800-row read assertion | **Medium** — unit tests prove the read shape, not prod wall-clock. Verify in post-deploy `round-v1439-perf-verify.md`. |
| `/api/medications/intake?scope=compliance` cold | 3.2 s → ~200 ms | Audit §5 P4 estimate + 16 unit + 2 route tests + bounded indexed read pattern | **Medium** — audit attributed the 3.2 s mostly to pool stall on cold, not row count. Rollup elides the stall but won't help if pool stall is the dominant residual. Verify in prod. |
| `/api/dashboard/summary` cumulative tiles | sparkline now shows true SUM not MEAN | Asymmetric test (SUM=8120 ≠ MEAN×COUNT=8000) pins the column path is wired | **High** — semantic-correctness fix, not a wall-clock claim. |
| `/api/measurements?groupBy=day` cumulative path | reads `sum_value` directly, no algebraic re-derivation | Test pin + legacy NULL fallback test | **High** — pure read-shape change, low-risk swap. |
| `/api/analytics` live-fallback A2 loop | row bound 347 114 → ~5 000 | `since: liveSince` threaded into every `fetchMeasurementSeriesChunked` call + 3 route tests + integration-test reseed | **High** for row-count bound; **Medium** for the 20-40 s wall-clock estimate (was audit-derived, not measured). |
| `/api/analytics` full-slice cold | not directly addressed in v1.4.39 | A2 cumulative-skip (P3 follow-on) deferred to v1.4.40 per W-SUM | **N/A** — the 74.6 s claim from the audit was the v1.4.38.8 fast-path-gate fix's domain; W-SINCE only defends the residual live-fallback path. |
| `summaries-slice` long-window | new `computeLongWindowSummary` entry point ready for v1.5 trend card | 5 unit tests + auto-router + fall-through chain | **High** for helper correctness; **No consumer wired in v1.4.39** so zero user-visible win this release. |

The pattern is consistent across all five waves: rollup-tier
correctness is proven by unit + route tests, but **wall-clock win on
Marc's tenant is not proven until the post-deploy perf-verify**. This
is the standard for the rollup-tier releases (v1.4.35, v1.4.38.5,
v1.4.38.7) and the post-deploy verify has caught soft claims twice
before (`round-v1436-perf-verify.md`, `round-v1437-perf-verify.md`).
The release notes should phrase the wins as "expected" until verified.

## Release-readiness verdict

- **Ship as v1.4.39: YES.** All five waves landed, quality gates green
  per each report, tests delta +80 (4 551 → 4 631), no new API
  contract, no migration risk (all three migrations additive — new
  tables + nullable column with legacy-NULL fallback documented in
  every consumer). The only outstanding concern is the cross-agent
  commit-attribution drift (see Risk register) which is a process bug,
  not a release blocker.

- **Carry-overs to v1.4.40:**
  - W-SUM `/api/analytics` A2 cumulative-skip — single-route swap to
    `readCumulativeDaySumsBatch`; audit estimates 20-40 s saved on the
    full-slice cold path. Highest-impact carry-over.
  - W-MED `health-score-fast-path.ts:267-303` swap onto
    `readMedicationCompliance` — estimated 1-2 s on the analytics
    full-slice cold path.
  - W-WMY slope90 hookup in `health-score-fast-path.ts` — slope is
    non-linearly composable across DAY buckets; needs a slope
    re-derivation research step first.
  - W-WMY slim-slice all-time aggregate swap — currently reads
    `granularity = 'DAY'` for the all-time path; could move to YEAR
    once a sync watermark for WEEK/MONTH/YEAR lands (today they're
    async via pg-boss, so the swap would risk staleness).
  - W-MOOD WEEK/MONTH/YEAR reader consumer — tier ships writer-only;
    a Coach long-window prompt or "year in mood" tile is the v1.4.40
    consumer.
  - v1.4.38 backlog items (analytics envelope split, `ensureUserRollupsFresh`
    retry safety, RX-3, RX-7, RX-8 sparkline polish, QA-4 / QA-6
    medium items) — none gated on iOS work.

- **v1.5 readiness:** unblocked.
  - No new iOS contracts introduced (read-path optimisations only).
  - Medication-compliance tier uses per-user-tz `day` strings —
    `isNearUtc` non-Berlin-tenant gating doesn't apply to this tier,
    which is a small architectural step toward the v1.5 per-user-tz
    bucketing for the measurement tier (P7).
  - Cross-tz proper fix, per-source rollup (P5), and slope-window
    SQL-move (P8) remain the v1.5 architectural backlog — unchanged.
  - `computeLongWindowSummary` is ready for any v1.5 multi-year UI
    consumer to call without further backend work.

## Risk register

- **Wall-clock perf wins are audit estimates, not measurements** —
  mitigation: post-deploy `round-v1439-perf-verify.md` against Marc's
  tenant; release-notes phrase wins as "expected" until verified;
  rollback to v1.4.38.8 is clean (rollup reads have live fallback).

- **Cumulative `sum_value` legacy-NULL coverage on Marc's tenant** —
  the boot-backfill discovery UNION branch handles uncovered rows but
  every existing row has `sum_value = NULL` until the worker re-folds.
  Consumers (dashboard sparkline, measurements groupBy=day) carry a
  documented `mean × count` fallback so the chart never holes; risk is
  cosmetic delta on tenants where source-priority resolves to a single
  source (Marc's case via the iOS `dailyStatsExternalId` path → exact)
  but could over-count on multi-source days until per-source rollup
  (P5, v1.5) lands. Mitigation: documented in W-SUM report; verify in
  post-deploy.

- **Mood rollup UTC-anchored bucketing for non-Berlin tenants** —
  W-MOOD anchors on UTC midnight (mirroring the measurement-rollup
  convention). Same `isNearUtc` ±3 h guard applies. Marc's tenant is
  fine; a future non-near-UTC mood-logger would see day-key drift at
  the UTC boundary. Mitigation: documented in W-MOOD §"UTC vs
  TZ-anchored" + pinned in route parity test; v1.5 per-user-tz
  migration unblocks both tiers together.

- **Cross-agent commit-attribution drift (recurring process bug)** —
  W-WMY's `8763b3aa` absorbed W-SUM's test files; W-MOOD's
  `d15850d5` overwrote W-MED's reminder-worker.ts edits per the
  Marc-briefing pre-marathon note. This is the **third recurring
  occurrence** (also flagged in `project_v1437_final_web_release.md`).
  Test content is intact across both incidents (grep-verified per
  W-SUM and W-WMY reports), so no functional regression. **Mitigation
  for the next marathon: per-agent `git worktree` isolation** — this
  is now a hard requirement, not a nice-to-have. Recommend adding
  worktree-per-wave to the `release-marathon` skill's standard flow.

- **`ensureUserRollupsFresh` write storm on first post-deploy cold
  mounts** — three new tiers means three new boot-backfill discovery
  queries plus three new per-write hook fan-outs. Per the audit §4
  this is fire-and-forget so the request itself stays fast, but the
  worker queue depth will spike for the first hour post-deploy on
  Marc's tenant (347 k rows × 3 new tiers). Mitigation: existing
  pg-boss back-pressure handles this; monitor Coolify logs for
  `rollup-full-backfill` queue depth in the first hour.

- **Marc's strategic ask preservation — confirmed** — raw
  `measurements`, `mood_entries`, `medication_intake_events` tables
  are byte-unchanged in the schema diff. Every new tier is purely
  derived (`*_rollups` tables) and additive (one nullable column on
  `measurement_rollups`). Boot backfill is idempotent; rollup wipe on
  account-delete is in-transaction with the source-row wipe per
  W-MOOD §self-review item 4-5.

- **Semver call — minor bump (1.4.39) confirmed** — features added:
  3 new tables (`mood_entry_rollups`, `medication_compliance_rollups`,
  `measurement_rollups.sum_value` column), 8 new internal helpers
  (rollups + reader fns), 1 new analytics row-cap, ~80 new tests.
  Zero API contract breaks, zero new iOS surface, zero user-visible
  UI changes. Per Marc's conservative-semver doctrine
  (`feedback_semver_conservative.md`) this is squarely additive-only
  features inside an existing minor cycle → **v1.4.39 patch bump is
  the correct call** (v1.5 stays reserved for the iOS Swift sprint).

- **Release-marathon retrospective items** — beyond the worktree
  isolation fix above, no other process bugs surfaced in this
  marathon. Coolify auto-deploy fix from v1.4.38.4 is still in
  effect. The five-wave decomposition was clean — each wave was
  scoped to a single P-item and a small file set with documented
  "did NOT touch" sections to prevent collisions.
