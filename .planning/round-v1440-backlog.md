# v1.4.40 backlog

Seeded during the v1.4.39 QA reconcile. Items the six QA reviewers
surfaced that the reconcile deliberately deferred — either too costly
for the v1.4.39 release window, or naturally paired with a v1.5
architectural step. Source-doc references in parentheses so the next
session can re-read the original rationale.

---

## High — strategic follow-up

### F-SEC-M-02 — Postgres RLS for the two new rollup tables
(`.planning/round-v1439-QA-security-findings.md` MEDIUM-F-SEC-M-02)
- `prisma/migrations/0070_v1439_mood_rollups`,
  `prisma/migrations/0071_v1439_medication_compliance_rollups` —
  `mood_entry_rollups` and `medication_compliance_rollups` carry no
  per-user RLS or query enforcement; every read relies on
  application-layer `userId` filters.
- Inspected: 100% of new Prisma reads include `where: { userId }` and
  100% of new upsert/deleteMany calls scope to userId. No leak found.
- Background: this is consistent with the pre-existing
  `measurement_rollups` posture, but it remains the only
  tenant-isolation layer for the two new tables. Worth defense-in-depth
  RLS before v1.5 multi-org work lands.

### F-M-01 — `computeLongWindowSummary` consumer wiring (v1.5)
(`.planning/round-v1439-QA-senior-findings.md` MEDIUM-F-M-01)
- `src/lib/analytics/summaries-slice.ts:615` — exported + tested but no
  production caller. W-WMY shipped the helper for a v1.5 multi-year
  trend card / Coach drawer that doesn't exist yet.
- Action: wire into the v1.5 "year-in-mood" tile or Coach long-window
  prompt; until then this is dead-but-tested code in the production
  bundle.

---

## Medium — correctness + perf polish

### F-M-02 — Drop unused `tx` parameter from rollup writers
(`.planning/round-v1439-QA-senior-findings.md` MEDIUM-F-M-02)
- `src/lib/mood/rollups.ts:173-178`,
  `src/lib/medications/compliance-rollups.ts:177-183` — both writers
  accept a `tx` parameter but no call site passes one. The
  atomic-with-parent story in the wave reports is therefore
  unrealised; every rollup write happens AFTER the parent commits.
- Action: drop the `tx` parameter or wire it through the existing
  `prisma.$transaction` blocks (e.g. the Telegram skip webhook). The
  v1.4.39 atomic-upsert hotfix (QA F-H-02) replaced the JS aggregate
  with `$executeRaw`, so the cross-Prisma-client typing matters less
  now, but the parameter is still dead.

### F-M-03 — Add partial index `sum_value IS NULL` post-convergence
(`.planning/round-v1439-QA-senior-findings.md` MEDIUM-F-M-03,
`.planning/round-v1439-QA-specialist-findings.md` MEDIUM-M1)
- `src/lib/measurements/rollups.ts:762-780` — boot-backfill discovery
  UNION arm `WHERE r2."granularity" = 'DAY' AND r2."sum_value" IS NULL`
  does a seq scan over `measurement_rollups`. Negligible at single-
  tenant scale (~few thousand rows). For v1.5 multi-tenant scale this
  should either gain a partial index
  `CREATE INDEX CONCURRENTLY ON measurement_rollups(user_id)
  WHERE granularity = 'DAY' AND sum_value IS NULL` once the legacy
  NULL backfill finishes the first sweep, or the UNION arm should be
  dropped (see Specialist-M01 below).

### F-M-05 — Consolidate `RollupBucketRow` shape
(`.planning/round-v1439-QA-senior-findings.md` MEDIUM-F-M-05)
- `src/lib/measurements/rollup-read.ts` exports `DailyMeanRow`,
  `src/lib/measurements/rollup-read-wmy.ts` exports `RollupBucketRow`.
  The latter is a strict superset (adds `sd/slope/r2/sumValue`). Two
  coexisting bucket-row types invite drift.
- Action: consolidate into one shape in `rollup-read.ts` and re-export
  from `rollup-read-wmy.ts`. Cheap.

### F-M-06 — Per-agent worktree for next marathon (process note)
(`.planning/round-v1439-QA-senior-findings.md` MEDIUM-F-M-06,
`.planning/round-v1439-QA-product-lead-findings.md` Risk register)
- W-SUM's tests landed inside W-WMY's commit `8763b3aa`; W-MOOD's
  `d15850d5` overwrote W-MED's reminder-worker.ts edits. Third
  recurring occurrence of cross-agent commit-attribution drift.
- Action: per-agent `git worktree` in the next marathon — add
  worktree-per-wave to the `release-marathon` skill's standard flow.

### UX-M1 — Compliance reader DST `days+1` slice
(`.planning/round-v1439-QA-ux-findings.md` MEDIUM-M1)
- `src/lib/medications/compliance-rollups.ts:330-332` — defensive
  "always include today" insert runs after the trailing-window loop.
  On a normal day it's a no-op; on a DST fall-back when the loop dedups
  two probes onto the same day-key, this branch may push a fresh entry
  outside the trailing window, returning `days + 1` buckets.
- Action: add a DST-fall-back pin and either drop the defensive insert
  or cap the final array at `.slice(0, days)`.

### UX-M2 — Mood entry-score rounding pin
(`.planning/round-v1439-QA-ux-findings.md` MEDIUM-M2)
- `src/app/api/mood/analytics/route.ts:86` — rollup path uses
  `Math.round(r.mean * 100) / 100` over PG `AVG`; legacy live uses
  `Math.round((stats.sum / stats.count) * 100) / 100`. JS-AVG vs PG-AVG
  intermediate float math is not provably identical.
- Action: property test pinning a fixture where the paths could
  disagree at the fifth decimal. Cosmetic risk only (Recharts axis
  ticks).

### UX-M3 — `entryCount` shape decision (info-only)
(`.planning/round-v1439-QA-ux-findings.md` MEDIUM-M3)
- `src/app/api/mood/analytics/route.ts:102, 139` — `entryCount`
  semantics consistent across both branches (total raw entries) but
  the field only lands in `annotate({ meta })`, not `apiSuccess()`.
  No client-facing shape impact; flagging for audit completeness only.

### Specialist-M01 — Drop `sum_value IS NULL` UNION arm after convergence
(`.planning/round-v1439-QA-specialist-findings.md` MEDIUM-M1)
- `src/lib/measurements/rollups.ts:762-779` — once Marc's tenant has
  converged, the legacy-NULL branch becomes a permanent no-op walk over
  the full rollup table. Schedule for removal in v1.4.40 + add a TODO
  with the cut-off date. Keeps the discovery query single-table after
  convergence.

### Simplifier dead-exports + duplicate tz helpers
(`.planning/round-v1439-QA-simplifier-findings.md` Suggested removals +
Suggested dedups)
- `src/lib/measurements/rollup-read-cumulative.ts:54,83,121,164` —
  `isCumulativeType`, `readCumulativeDaySums`, `readCumulativeDaySumsBatch`,
  `resolveBucketSum` exported + tested but no production caller. ~360
  lines if file + tests collapse. Once a consumer exists, this becomes
  the single source of truth.
- `src/lib/measurements/rollup-read-wmy.ts:125,137,149` —
  `readWeekRollups` / `readMonthRollups` / `readYearRollups` only used
  by their own tests; downgrade to non-exported or inline.
- `src/lib/medications/compliance-rollups.ts:453` —
  `ensureUserMedicationComplianceFresh` only referenced in its own
  JSDoc; the v1.4.39 QA F-SEC-M-01 split shipped
  `enqueueUserMedicationComplianceBackfill` so the original `ensure-
  fresh` symmetry helper is dead. Drop or wire.
- Duplicate tz helpers (`wallClockInTz`, `tzOffsetMinutes`,
  `startOfUtcDay`, `bucketSpan`, `startOfDayUtcInTz`) — three to four
  copies across `src/lib/measurements/rollups.ts`, `src/lib/mood/
  rollups.ts`, `src/lib/medications/compliance-rollups.ts`,
  `src/lib/medications/scheduling/cadence.ts`. Consolidate into
  `src/lib/tz/format.ts` (Marc-Voice: "one tz helper, one bug fix
  radius").

### UX-M4 — Front-end `vs last year` degradation hint
(`.planning/round-v1439-QA-ux-findings.md` MEDIUM-M4)
- Now **obsolete** after the v1.4.39 QA Specialist-H2 widen
  (`/api/analytics` live cap 90d → 425d). The "vs last year" tile no
  longer silently nulls on cold mounts. Flagged here so a future
  reviewer doesn't reopen.

---

## Low — observability polish

### F-L-01 — Compliance double-window-derivation cleanup
(`.planning/round-v1439-QA-senior-findings.md` LOW-F-L-01)
- `src/lib/medications/compliance-rollups.ts:186-199` —
  `recomputeMedicationComplianceForDay` computes the day window twice
  (`start + 86_400_000` and `startOfDayUtcInTz(nextDayKey)`) then
  picks the larger. Simpler invariant: "always use `startOfDayUtcInTz`
  for both bounds". Cosmetic.

### F-L-03 — Mood-rollup chunked upsert serialisation
(`.planning/round-v1439-QA-senior-findings.md` LOW-F-L-03)
- `src/lib/mood/rollups.ts:526-560` — `persistMoodRollupRows` chunks
  at 500 but issues a sequential `for…of` upsert loop inside each
  chunk. Measurement-rollups equivalent uses
  `prisma.$transaction([…])` for parallel upsert. Mood DAY hot-path
  writes 1 row so it doesn't matter; a 5-year boot-fold pays N
  round-trips instead of N/500 transactions.

### F-L-04 — Mood boot-backfill discovery query clarification
(`.planning/round-v1439-QA-senior-findings.md` LOW-F-L-04)
- `src/lib/mood/rollups.ts:417-427` — discovery query doesn't restrict
  `granularity='DAY'` on the LEFT JOIN. Inconsequential because the
  read path only consults DAY anyway. Comment clarification would help.

### F-SEC-L-01 — Compliance recompute silent-error observability
(`.planning/round-v1439-QA-security-findings.md` LOW-F-SEC-L-01)
- `src/lib/medications/compliance-rollups.ts:277-289` —
  `recomputeMedicationComplianceForEvent` swallows errors with an
  `annotate({ medication_compliance_rollup_failed: true })` flag.
  Self-corrects on the next mutation; no PII logged. Worth a follow-up
  metric / alert on the annotate flag.

---

## Strategic note (carry into v1.5)

- iOS Health-app integration remains v1.5 P1; the v1.4.39 backlog
  items above are all internal correctness/perf polish that doesn't
  gate iOS work.
- Cross-tz proper fix (per-user-tz rollup bucket minting) remains
  v1.5 — the v1.4.38 cheap path (runtime guard with live fallback for
  non-near-UTC) is in place; v1.4.39 mood + compliance rollups inherit
  the UTC-anchor trade-off pinned by Specialist-H1's DST test.
- Per-source rollup (audit P5) + slope-window SQL move (audit P8)
  remain v1.5 architectural backlog — unchanged from the v1.4.38
  closure.
