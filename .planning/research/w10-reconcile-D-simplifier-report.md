# W10 Reconcile D — Simplifier apply-now wins

Applied all 7 "apply-now" simplifications from
`.planning/research/w10-simplifier-findings.md`. Atomic commits on
`develop`, professional Marc-Voice, no Co-Authored-By trailer, no
`--no-verify`. Every commit passed `pnpm typecheck`, `pnpm lint`, and
the relevant test subset; the full vitest suite (296 files / 2,652
tests / 1 skipped) was green at the end of the wave.

## Applied items

| ID | File:line | Commit | LOC saved (net) |
| --- | --- | --- | --- |
| **S2** | `src/lib/analytics/source-priority.ts:139–156` | `38023ee` | 8 |
| **S13** | `src/lib/insights/sub-page-metric.ts:22–51` | `d4796ee` | 10 |
| **S7 + S8** (bundled) | `src/components/insights/health-score-card.tsx:150–187` | `4ec6705` | 7 (S7 +3, S8 +4) |
| **S5** | `src/lib/measurements/apple-health-mapping.ts:299–304` + test block | `7851341` | 31 (constant + redundant test block) |
| **S6** | `src/lib/measurements/apple-health-mapping.ts:446–476` | `8c929fc` | 4 |
| **S4** | `src/components/settings/sources-section.tsx:194–216` (+ 2 callsites) | `ec484e0` | 2 |

**Total: 6 commits, ~62 LOC net removed.**

## Notes per item

- **S2** — `pickCanonicalSourceRows` now calls `getDeviceTypeLadder()`
  inside its per-bucket cache wrapper. The override → default → constant
  resolution lives in one place. Behaviour parity verified: passing
  `"default"` to `getDeviceTypeLadder()` when `rowType` is null hits the
  same `deviceTypePriority.default` path the inline code took.
- **S13** — `SUB_PAGE_METRIC` is now the single source of truth (typed
  via `as const satisfies Record<string, readonly string[]>`).
  `SubPageSlug` derives via `keyof typeof`; `SUB_PAGE_SLUGS` derives via
  `Object.keys(...)`.
- **S7 + S8** — `COMPONENT_ORDER` hoisted to module scope; the redundant
  `[...COMPONENT_ORDER]` spread dropped (the chained `.map()` is
  non-mutating). `Intl.DateTimeFormat` is now memoised on `locale` via
  `useMemo`. The dead `try/catch` around `new Date(asOf)` dropped — the
  constructor doesn't throw on bad ISO; the `Number.isNaN(getTime())`
  guard already covers every failure mode.
- **S5** — `HK_QUANTITY_TYPE_TO_MEASUREMENT` deleted along with its
  mirror-check `describe` block in the test file. The grep confirmed no
  caller outside that test; consumers can read
  `APPLE_HEALTH_TYPE_MAP[id]?.measurementType` directly.
- **S6** — `mapAppleHealthEntry` builds the base output object once and
  appends `sleepStage` only when the mapping carries `sleepStageMap`.
  One return path instead of two; null semantics for unmapped /
  invalid-date / missing-stage / unknown-stage unchanged (verified by
  the existing 20-test block).
- **S4** — `moveDeviceType` takes `bucket: string | null` (null = global
  ladder). The magic string `"__default__"` and the two equal-shape
  branches collapse to a single read / write of `key = bucket ?? "default"`.
  Both callsites in the JSX swapped to `null`.

## Items deferred

None. No file-conflict with concurrent agents — none of the apply-now
items touched the forbidden surface (`messages/**.json`,
`src/components/insights/sleep-stage-stacked-bar.tsx`,
`src/components/insights/sleep-overview.tsx`).

## Apply-with-care / discuss-first items NOT applied (per scope)

Deferred per prompt instruction:

- S1 (Zod schema dedup), S3 (`reorderLadder` extraction),
  S9 (`ContributingSource` shared union), S10 (i18n shared
  `allMessages`), S12 (`useInsightStatus` hook) — apply-with-care.
- S11 (`useSyncExternalStore` swap), S14 (drop pickRows fast-path),
  S15 (drop `prisma.medication` defensive guard) — discuss-first.

Each remains queued in `w10-simplifier-findings.md` for a follow-up
wave.
