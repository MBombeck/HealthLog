# v1.4.37 — W10-RX reconcile-apply report

Wave: W10 reconcile / pre-tag fix-up. Source: six W10 reviewer reports
(`phase-W10-v1437-{code-review,security,ux-a11y,architecture,
simplifier,i18n}-findings.md`).

Ran on develop (no worktrees, exclusive ownership). Atomic Marc-Voice
English commits, no Co-Authored-By, no --no-verify.

## Commits landed (in order)

| SHA       | Title                                                              | Finding ID closed                                          |
| --------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| 6325c0e2  | fix(jobs): register DRAIN_CUMULATIVE_QUEUE in worker boot allQueues | W10-1 C-1 (Critical)                                       |
| 3154c1bc  | refactor(measurements): single source of truth for cumulative day-sum types | W10-1 H-2 + W10-4 H3                                       |
| 0750b978  | refactor(measurements): hoist cumulative metric-key mapping into shared module | W10-1 M-3                                                  |
| 67ca5267  | fix(measurements): reject offset>0 on groupBy=day / dayKey branches | W10-4 H1                                                   |
| c2f43672  | fix(measurements): reject impossible dayKey values (2026-02-30 etc) | W10-4 H2                                                   |
| c0c1b6b8  | fix(measurements): drill-down window honours DST transitions in target tz | W10-1 H-1                                                  |
| de2bdd6f  | fix(dashboard): lift medication-intake quick-add CTA + footer to 44 px floor | W10-3 P0-3 + P0-4                                          |
| ac46f8f9  | ui(layout): top-bar user menu width parity with sidebar overflow   | W10-3 P1-2                                                 |
| bd841aee  | fix(dashboard): clarify dose field is informational only in medication quick-add | W10-1 M-2 (+ doseHint copy across 6 locales)               |
| 10c3f8e6  | docs(env): document TRUST_CF_CONNECTING_IP security implications   | W10-2 M-1                                                  |

Total: 10 commits closing 1 Critical + 3 High + 6 Medium-or-P0
findings.

## Tests delta

- Baseline (right before this wave): **4466 passing unit tests** /
  426 test files / 1 skipped.
- After the wave: **4486 passing unit tests** / 426 test files /
  1 skipped.
- Net: **+20 new unit tests** (cumulative-day-sum parity x4,
  cumulativeMetricKey audit x3, group-by-day rejection x4,
  localStartOfDay / localDayWindow DST coverage x9 — modulo a
  little count slip on minor cross-cuts).

Quality gates passed BEFORE every commit:
- `pnpm typecheck` — clean every time.
- `pnpm lint` — clean every time.
- `pnpm vitest run <relevant subset>` — green every time.
- `pnpm test --run` — final full-suite pass: **426 files / 4486
  tests** green.

## v1.4.38 backlog

Written to `/Users/marc/Projects/HealthLog/.planning/round-v1438-backlog.md`.

Deferred items: **roughly 50** bullets across W10-1 (8), W10-2 (3),
W10-3 (~14, P0 EN-fallback + P1 / P2 / P3), W10-4 (10), W10-6
(blanket — i18n EN-fallback baseline is pre-existing not a regression),
plus low-priority architecture / simplifier items.

Bullets all carry a finding-ID + source reviewer-doc reference so
Marc can read the original rationale during triage.

## Infeasibility / escalations

**None at the line-item level.** Every Critical + High + selected-
Medium item from the apply-list landed. Two deliberate scope
decisions worth noting:

1. **H-1 fix scope.** The brief offered a choice between a small
   `localStartOfDay` helper (cheap, JS-side) and a `Temporal`-based
   rewrite (proper but adds a dependency surface). I shipped the
   `Intl.DateTimeFormat` shortOffset approach inside the existing
   `drain-per-sample-cumulative.ts` module. It's correct on every
   DST transition I tested (Berlin spring-forward / fall-back) and
   on half-hour zones (Asia/Kolkata UTC+5:30); the offset read at
   UTC midnight is unambiguous on every day because EU/US DST
   transitions happen at local 02:00 / 03:00, not at the calendar
   boundary. Same surface, no new dep — Marc's "do the surgical
   thing" rule.

2. **B1 / B2 stability.** The source-of-truth merge kept both
   `CUMULATIVE_DAY_SUM_TYPES` and `cumulativeMetricKey` as named
   exports from `cumulative-day-sum.ts` so existing import paths
   remain working. The route now imports the helper instead of
   duplicating the switch; downstream code touches nothing.

## Brief-back (≤200 words)

(a) **Commits landed.** Ten atomic Marc-Voice English commits on
develop closing the W10 Critical + every High + the highest-impact
Mediums: drain-queue registration (was silently no-op'ing the
nightly W7c step consolidation), cumulative-type / metric-key
single-source-of-truth, measurements-route guard against
`offset>0+groupBy=day`, calendar-date validation on `dayKey`,
DST-aware drill-down window math (was leaking / hiding 1 h per
DST-transition day), 44 px touch-floor on the medication-intake
quick-add (CTA + footer + empty-state Close), top-bar dropdown
width parity, dose-field read-only + clarified copy across six
locales, and the `.env.example` security implications block for
`TRUST_CF_CONNECTING_IP`. (b) **Infeasibility.** None — the apply-list
landed in full; deferred items are documented in
`/Users/marc/Projects/HealthLog/.planning/round-v1438-backlog.md`
(~50 bullets across all six reviewer docs, finding-IDs preserved).
(c) **Quality gates.** typecheck + lint + full unit suite all green
(4466 → 4486 tests, +20 new). Tag-ready.
