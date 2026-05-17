# v1.4.38 Marathon — full backlog sweep + perf hotspots

**Started:** 2026-05-17 (immediately after v1.4.37.2 deploy verify)
**Mandate:** Marc directive — "Ich möchte jetzt echt den Deckel drauf kriegen und nichts jetzt auf ein v1.4.39 Release mehr ausschieben, sondern ich möchte, dass das jetzt alles da drinnen ist."
**Versioning:** **v1.4.38** (patch — additive + fixes + perf, no breaking change).

## Scope

Everything in `.planning/round-v1438-backlog.md` PLUS the two perf hotspots
surfaced during v1.4.37.x verification:

1. `/api/insights/comprehensive` cold-mount ~3.4 s — likely same shape
   as the v1.4.37.2 slim-summaries bug (over-fetch then JS-aggregate)
2. `/api/dashboard/summary` cold-mount ~4.6 s — iOS aggregator, big
   parallel queries on `measurements` without rollup-side aggregation

## Default Picks (autonomous — no Marc-approval wait)

- **i18n volle Lokalisierung:** Option A (T1 mandatory + T2 high-value
  medical/health domain copy). Settings/Admin/Dev strings stay
  EN-fallback for now.
- **Coach cascade tests:** both H4 + M-5 fixes applied. Grep-based gate
  inventory test + SSR spy/CSR render replacement.
- **Cross-tz fragility:** Cheap path now (runtime fallback to live for
  non-near-UTC zones). Proper iOS-sprint deliverable (per-user-tz
  bucket minting) explicitly deferred to v1.5.
- **Drill-down 1000-cap surfacing:** Option (a) — Zod refine for the
  422 path. Pagination still deferred per W7c original choice.
- **Drain queue cutoff const lift:** done (per backlog).
- **Geo-backfill chunking:** drop cap to 500. Singleton-guard via pg-boss
  `singletonKey` with advisory-lock fallback.

## Waves

### W-A — Cross-tz fast-path runtime guard (2 H items)
- Correlations fast-path: runtime guard that falls back to live for
  non-near-UTC (>4 h) zones; same shape for bp-in-target.
- Touch: `src/lib/analytics/correlations-fast-path.ts`,
  `src/lib/analytics/bp-in-target-fast-path.ts`, related tests.

### W-B — Robustness sweep (~13 M items)
Bundle:
- Geo-backfill chunking + singleton-guard
- `DRAIN_CUMULATIVE_CUTOFF_HOURS` lift to shared module
- Drill-down `take` cap via Zod refine
- Analytics cached `daysAgo` derive
- `ensureUserRollupsFresh` per-key in-flight dedup (back-stop for the
  v1.4.37.1 fire-and-forget — if a request DOES catch a sync recompute,
  it shouldn't fan out N times)
- `recomputeBucketsForMeasurement` `Promise.all` parallel
- `looksLikeIp` strict via `net.isIP`
- Medication-card category-label drift-guard test
- MedicationIntakeQuickAdd refetch dedup
- Drain per-user complete-log
- BP fast-path leap year
- `degraded` sentinel removal until load-shedding lands
- `CORRELATION_WINDOW_DAYS` in OpenAPI
- Private `dayKey` helper rename to `bucketDayKey`
- Health-score `bpInTargetPct` shared across windows

### W-C — Coach cascade test invariants (3 items)
- H4: COACH_SURFACES fixture absorbs cross-cut gates OR grep-based test
- M-5: SSR proof spy/CSR render replacement
- M6: Coach API route gate inventory test (discovery-style)

### W-D — UX polish (P1+P2+P3 ~17 items)
- P1-1 drill-down chevron aria-controls
- P1-3 Hinzufügen menu max-w + label shortening
- P1-4 quick-add-labels collision-guard 6 locales
- P1-5 target-card gap measure (no-op confirm)
- P1-6 select chevron Safari `pr-2` bump
- P2-1 medication-intake empty-state footer promote
- P2-2 BMI structured-skeleton aria-live
- P2-3 GLP-1 take-now pill colour-blind icon
- P2-5 Dashboard items-center preference confirmation
- P3-1 through P3-7 — minor polish

### W-E — i18n full localization (Option A — T1 + T2)
- T1 mandatory: W7b medication-intake-quick-add (13 keys) + W7c step
  consolidation (3 keys) translated to es/fr/it/pl.
- T2 high-value: scan all patient-facing medical/health domain copy
  (Insights cards, measurement labels, mood scale, medication intake,
  Coach UI, Arztbericht hero, doctor-report PDF strings) for EN
  fallback; translate to es/fr/it/pl.
- T3 deferred: Settings/Admin/Dev strings.

### W-F — Two new perf hotspots (carry from v1.4.37.x verification)
- `/api/insights/comprehensive` (3.4s cold) — investigate over-fetch
  pattern, likely same fix shape as v1.4.37.2 (SQL aggregation at the
  DB level instead of row transfer)
- `/api/dashboard/summary` (4.6s cold) — iOS aggregator, parallel
  queries on `measurements`. Likely candidates: per-metric latest read
  combined with sparkline read; consider SQL aggregation or rollup-
  based read

### W-QA — Six-axis review pass (parallel)
Same dispatch as v1.4.37 W10. Six reviewer agents, findings docs,
single reconcile-apply for Critical/High.

### W-RX — Reconcile-apply
Critical + High + selected-Medium fixes from W-QA before tag.

### W-Release — Tag + deploy + verify + closure
Standard release flow.

## Quality gates (per release contract)

- typecheck clean
- lint 0 errors / 0 warnings on touched files
- unit suite green; integration stable (known flakes documented)
- no PII in CHANGELOG / GH release / docs / landing
- Marc-Voice English commits + user-facing copy
- No `Co-Authored-By: Claude`, no `--no-verify`, no `--no-gpg-sign`
- Touch-disjoint between parallel agents

## Operating notes

- Marc is not available — fully autonomous mode
- Verification: anonymous HTTP probes + Coolify application_logs +
  Playwright headless (for unauthenticated surfaces)
- Cannot run authenticated UAT — log inspection takes that role
- All Marc-decisions defaulted per the Default Picks section above
