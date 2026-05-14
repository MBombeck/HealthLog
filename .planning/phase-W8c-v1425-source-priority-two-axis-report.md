# Phase W8c — Source-Priority Two-Axis Report

Branch: `develop` · v1.4.25 W8c · 2026-05-14

## Scope

Implement the two-axis source-priority research recommendation
(`.planning/research/source-priority-two-axis.md`). Five sub-tasks
with atomic commits. NO new Prisma migration for the priority
column itself — additive Zod keys on `User.sourcePriorityJson`.
One small Measurement column add (`device_type`) lives in
Migration 0051 so iOS can ship the tag from launch.

## Commits

| sha       | title |
|-----------|-------|
| `f05c55f` | feat(sources): two-axis priority — additive metricPriority + deviceTypePriority Zod keys |
| `42d88fa` | feat(sources): pickCanonicalSource — two-axis lookup with single-axis fallback |
| `27f06c1` | feat(settings): per-metric + per-device override UI for Source Priority |
| `024845e` | feat(api): nullable deviceType on Measurement for two-axis source priority |
| `53278cc` | test(sources): integration tests for two-axis canonical-source resolution |

## Files changed

### 8c.1 — Zod schema extension
- `src/lib/validations/source-priority.ts` — `metricPriority` (nested),
  `deviceTypePriority` (default + per-MeasurementType catchall),
  `DEFAULT_DEVICE_TYPE_PRIORITY` constant, `normalizeDeviceType()`,
  `getSourceLadder()`, `getDeviceTypeLadder()`. Backward-compat: W5e
  flat shape stays valid, `parseSourcePriority` merges W8c nested >
  W5e flat > defaults.
- `src/lib/validations/__tests__/source-priority.test.ts` —
  19 → 30 unit tests.

### 8c.2 — `pickCanonicalSourceRows()` two-axis
- `src/lib/analytics/source-priority.ts` — after picking canonical
  source, walks the device-type ladder and keeps ONLY rows from the
  top-ranked device-type present in the bucket. Caches ladder per
  MeasurementType. Legacy-NULL fallback preserved (the picker keeps
  every row when no row has a known device-type or when no ranked
  device-type coexists in the bucket).
- `src/lib/analytics/__tests__/source-priority.test.ts` —
  7 → 18 unit tests covering source-only legacy, device-type axis,
  per-metric override, user-default override, custom-ladder fallback.

### 8c.3 — Settings UI
- `src/components/settings/sources-section.tsx` — global ladder
  (existing) + two collapsed-by-default expanders below: per-metric
  reset, device-type ladder. Marc no-split directive honoured.
- `messages/en.json`, `messages/de.json` — 11 new keys under
  `settings.sections.sources.*` (perMetricToggle, perMetricHelp,
  perMetricEmpty, resetMetric, deviceTypeToggle, deviceTypeHelp,
  deviceTypeDefault, resetDeviceTypes, deviceLabels × 7).

### 8c.4 — iOS contract: nullable `deviceType`
- `prisma/schema.prisma` — `Measurement.deviceType String?` column.
- `prisma/migrations/0051_measurement_device_type/migration.sql` —
  additive `ALTER TABLE "measurements" ADD COLUMN "device_type" TEXT;`.
- `src/app/api/measurements/batch/route.ts` — payload schema gains
  optional `deviceType` (Zod-validated via `deviceTypeEnum.nullable()`);
  prepared row writes it through.
- `src/lib/openapi/routes.ts` — `AppleHealthBatchEntry` schema gains
  `deviceType` with `HKDevice.model` guidance; batch endpoint
  description gains a W8c note for the iOS team.

### 8c.5 — Analytics wire-up + integration tests
- `src/app/api/analytics/route.ts` — `ChunkedRow` gains `deviceType`
  and `type`; `fetchMeasurementSeriesChunked` selects both columns.
  The existing `pickCanonicalSourceRows` call site (SLEEP_DURATION
  aggregation) now feeds the picker both axes.
- `tests/integration/source-priority-two-axis.test.ts` — 4 scenarios
  end-to-end against the testcontainer + real handler: plain default
  (single-source pass-through), per-metric override, default
  device-type ladder, user-flipped device-type ladder.

## Tests delta

- Unit tests: 26 → 48 across the two source-priority files (+22).
- Integration: 0 → 4 W8c integration tests.
- Full validation suite: 293/293 unit pass.
- Settings + analytics integration suites: 6/6 pass after wiring.

## Quality gates

- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- `pnpm vitest run src/lib/validations src/lib/analytics` — 293/293.
- `pnpm test:integration tests/integration/source-priority-two-axis.test.ts` — 4/4.

## Code-review pass (self-audit)

The brief calls for dispatching `superpowers:code-reviewer`; that
sub-agent skill isn't available in this thread, so the review was
done in-band against the diff. No High/Critical findings; minor
observations addressed during implementation:

- `normalizeDeviceType("unknown")` returns `"unknown"`, so explicit
  `"unknown"`-tagged rows behave identically to NULL — picker keeps
  them as a tiebreaker fallback. Documented in the source-priority
  helper.
- Picker `hasAnyKnownDeviceType` guard prevents a bucket of all-NULL
  rows from triggering empty-output behaviour; matches the
  source-axis fallback semantics so we never silently drop data.
- Settings UI `moveSource` writes both the flat key and the nested
  `metricPriority` so the in-memory shape stays consistent with the
  server's resolved output, but only the W8c canonical shape ships
  on Save (flat keys are dropped from the wire payload).
- `parseSourcePriority` returns an empty `deviceTypePriority: {}`
  rather than seeding it with `DEFAULT_DEVICE_TYPE_PRIORITY` — this
  keeps the persisted Json blob narrow and lets future schema
  additions slot in without backfill.

## TODO for v1.5 iOS-Claude

Locked contract additions in OpenAPI:

1. `AppleHealthBatchEntry.deviceType` — optional `string | null`.
   Canonical values `watch | band | ring | phone | scale | other |
   unknown`. Map from `HKDevice.model` ranges:
   - watchOS sample → `watch`
   - iPhone / iPad sample → `phone`
   - Withings/Oura ring forwarded into HealthKit → `ring`
   - third-party band → `band`
   - HealthKit-connected scale → `scale`
   - manual entry / unknown writer → `unknown` (or omit).
2. No GET-side contract change. The Settings → Sources screen is
   server-rendered (Next.js); iOS app doesn't expose the priority
   editor in v1.5.

## Pre-existing flags (carried over, NOT introduced by W8c)

- `src/components/i18n/maintainership-banner.tsx` — untracked, hits
  a `react-hooks/set-state-in-effect` ESLint warning when included
  in lint scope; outside W8c scope. eslint passed at commit time
  (the file is currently ignored by ESLint's default include set).
- A handful of i18n locale-union TS errors (`'fr' not assignable to
  'de' | 'en'`) showed up briefly during the run; cleared themselves
  after the local i18n/* edits landed in the same working tree.
  Final `pnpm typecheck` = exit 0.
