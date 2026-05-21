# v1.4.41 Senior-dev architectural findings

Branch under review: `develop` vs live `main` (v1.4.40). 23 commits.
Read-only review. No files modified.

## Verdict

**APPROVE_WITH_FIXES**

The release is architecturally sound. The five W-DELETED-2 + W-ORG + W-FRONTEND-FACTORY + W-SIMPLIFIER waves landed with clean discipline and good test coverage. The W-INSIGHTS-HOT timeout-stub fix (commit `27f3bec1`) is correct but only partial — four sibling status routes still ship the bare-fallback shape that drove the very paper-cut Marc reported. None of the findings below are release-blockers, but the partial parity and one misleading code comment should land before the tag.

## Critical

(none)

## High

### H1. Timeout-stub parity is partial — four siblings still on bare-fallback shape

**Files:** `src/lib/insights/general-status.ts:392-399`, `src/lib/insights/pulse-status.ts:337-344`, `src/lib/insights/mood-status.ts:449-456`, `src/lib/insights/medication-compliance-status.ts:334-342`

**Root cause:** commit `27f3bec1` ported the v1.4.37 bmi-status persisted-sentinel pattern to `blood-pressure-status.ts` and `weight-status.ts` only. The other four status libraries that race the same 20 s provider call with the same `withTimeout(…, STATUS_PROVIDER_TIMEOUT_MS, null)` shape still return the deterministic fallback text **without** writing the auditLog cache row keyed to today. So a single provider stall on any of these four leaves the next mount paying the full 20 s race again — exactly the regression the v1.4.41 fix targeted.

The four loci are byte-identical:

```ts
if (raced.timedOut || raced.value === null) {
  return {
    hasProvider: true,
    text: getNoKey<...>StatusText(locale),
    cached: true,
    updatedAt: null,
  };
}
```

**Recommended fix:** apply the same `prisma.auditLog.create({ data: { ..., timeout: true } })` block from `blood-pressure-status.ts:557-583` to the four siblings. Each carries its own `cacheAction = "insights.<name>.<locale>"`, `todayKey`, and `getNoKey<...>Text(locale)` already — the lift is a straight copy-edit. `medication-compliance-status.ts` returns a richer shape (`summary`, `medications: []`) so the stub there should write `summary` into `details.text` (mirroring its non-timeout path at line 374 and onwards) while still returning `medications: []` to the caller.

**Why High not Critical:** the user-facing UI is identical on the first hit (deterministic fallback text either way). The hit hurts only the *second* mount within the day, after a one-off provider hiccup. v1.4.41 explicitly framed this as the only user-visible release item Marc would feel (`.planning/v1441-handoff.md` line 22). Shipping with only 2/6 routes patched leaves four routes still bleeding.

## Medium

### M1. `/api/auth/check-user` is unrate-limited; comment justifies omission with a non-existent middleware

**File:** `src/app/api/auth/check-user/route.ts:28-32`

**Root cause:** the route header says "No rate-limit middleware added here; the higher-level edge limit on `/api/auth/*` covers brute-force enumeration concerns". I grepped for that edge limit (`middleware.ts` at repo root, `src/middleware.ts`, any `/api/auth` allowlist in `src/lib/rate-limit.ts`, `next.config.*`) and could not find it. The comparable `/api/auth/passkey/login-options` (cited in the same header) does carry its own `checkRateLimit('auth:passkey-login-options:<ip>', 10, 15 * 60 * 1000)` block — that's a per-route limit, not an edge one.

The functional outcome is acceptable per the W-IOS-COORD decision: the new endpoint discloses no more than `/api/auth/passkey/login-options` already does. But the rationale in the code is wrong, which means a future contributor reading this comment might confidently mirror the no-limit pattern in a route that *doesn't* have a comparable enumeration baseline.

**Recommended fix:** either (a) add a per-route `checkRateLimit('auth:check-user:<ip>', 30, 15 * 60 * 1000)` block matching the passkey-login-options shape, or (b) rewrite the comment to cite the actual enumeration-equivalent (`/api/auth/passkey/login-options`) rather than a non-existent edge limit. (a) is the safer call given iOS onboarding is the only caller and 30 / 15 min is generous.

### M2. ESLint `queryKey-factory` rule whitelist has drifted from the test-guard substitute

**File:** `eslint-plugins/healthlog/queryKey-factory.js:48-57` (GUARDED_DIRECTORIES + GUARDED_FILES)

**Root cause:** `eslint-plugins/healthlog/queryKey-factory.js` lists the ESLint rule's enforcement scope as `src/components/charts`, `src/components/comparison`, `src/app/page.tsx`, `src/hooks/use-auth.ts`. The companion test-guard substitute at `src/lib/__tests__/query-keys.test.ts:192-203` covers a wider scope — it also includes `src/app/auth`, `src/app/notifications`, and `src/components/settings/about-section.tsx` (the three surfaces W-FRONTEND-FACTORY migrated in `0bf07abd`). The ESLint rule's header comment claims "Extend in lockstep with the test-guard substitute's `guardedRoots`" but the two lists are already out of sync at landing.

**Effect:** the ESLint rule won't catch a future bare-literal `queryKey: [...]` regression in the three v1.4.41-migrated dirs at IDE / `pnpm lint` time. The test-guard substitute will catch it (via `pnpm test`), but the whole point of promoting to ESLint per `.planning/phase-W-PROCESS-DOCS-v1441-report.md` was to fail fast.

**Recommended fix:** add the three entries to `GUARDED_DIRECTORIES` / `GUARDED_FILES` in `queryKey-factory.js`:

```js
const GUARDED_DIRECTORIES = [
  "src/components/charts",
  "src/components/comparison",
  "src/app/auth",
  "src/app/notifications",
];
const GUARDED_FILES = [
  "src/app/page.tsx",
  "src/hooks/use-auth.ts",
  "src/components/settings/about-section.tsx",
];
```

## Low

### L1. `pr-detection-worker.ts` doesn't filter soft-deleted measurements

**File:** `src/lib/personal-records/pr-detection-worker.ts:219-221`, `:402-407`

**Root cause:** the W-DELETED-2 sweep covered export, gamification, and doctor-report but did not touch the personal-records worker. `prisma.measurement.count({ where: { userId, type: metricType } })` (line 219) and `findBestMeasurement` (lines 402-407) both omit `deletedAt: null`. So a soft-deleted measurement can:
1. count toward the 30-row warm-up threshold (line 222);
2. be returned by `findBestMeasurement` as the user's best-ever value (line 402), which then writes a `PersonalRecord` row keyed to a tombstoned measurement.

The worker is best-effort and the surfaces that read PR rows (`personal-record-badge.tsx`) just render the value — they don't re-validate against the measurement table — so the user sees a "best weight" that no longer exists on their list.

**Recommended fix:** add `deletedAt: null` to both `where` clauses. Defer to v1.4.42 unless an iOS undo or admin delete is observed creating a stale PR in production.

### L2. `offhost-backup.ts` includes soft-deleted measurements

**File:** `src/lib/jobs/offhost-backup.ts:219`

**Root cause:** `prisma.measurement.findMany({ where: { userId: user.id } })` omits `deletedAt: null`. This is the S3 nightly disaster-recovery dump, NOT a user-facing export. Per the W-DELETED-2 design intent (round-trip exports must not resurrect deletes) the user-initiated `/api/export/full-backup` correctly excludes them. The DR worker likely *should* keep them — restoring a tombstone is the safer DR semantic. But there's no documenting comment either way.

**Recommended fix:** add an inline comment to `offhost-backup.ts:219` documenting the intent ("includes soft-deleted rows because this is the DR snapshot, not a user-facing export — see `/api/export/full-backup/route.ts` for the symmetric exclusion"). No behavioral change.

### L3. Duplicate `DataSummary` import in `src/types/analytics.ts`

**File:** `src/types/analytics.ts:37-38`

**Root cause:**

```ts
import type { DataSummary } from "@/lib/analytics/trends";
import type { DataSummary as DataSummaryType } from "@/lib/analytics/trends";
```

Same named import declared twice — once bare, once aliased. The aliased one is referenced exactly once at line 80 (`glucoseByContext?: Record<string, DataSummaryType>`). The bare import is the canonical one used everywhere else in the file.

**Recommended fix:** drop the aliased import and change line 80 to `Record<string, DataSummary>`. Cosmetic / consistency.

### L4. No dedicated unit test for `projectTodayIntakesAndRecompute`

**File:** `src/lib/medications/scheduling/project-today-intakes.ts`

**Root cause:** the helper is exercised only through the two route tests (`intake/route.test.ts`, `dashboard/summary/route.test.ts`). The W-SIMPLIFIER report at `.planning/phase-W-SIMPLIFIER-report.md` line 24-40 names the extraction as the main deliverable but doesn't add a `__tests__/project-today-intakes.test.ts` directly. The route tests do cover the happy path and the missing-row backfill, so coverage is structurally present, just not isolated.

**Recommended fix:** v1.4.42 add a focused helper test (idempotent backfill, `Promise.allSettled` recompute-failure swallow, `skipDuplicates` no-op on duplicates).

### L5. Helper `recomputeMedicationComplianceForEvent` swallows-on-failure but the helper now `await Promise.allSettled`s — explicit-redundant

**File:** `src/lib/medications/scheduling/project-today-intakes.ts:127-142`

**Root cause:** the doc-comment on line 122-126 says "the helper swallows internally today, but a future refactor that lets a throw escape would otherwise turn the parent POST into a 5xx". That is correct defense-in-depth, but the call site is also wrapped in `Promise.allSettled`. The intent is right; just flag that one of the two layers should remain documented as the explicit contract, otherwise a future contributor will simplify one assuming the other holds.

Not a bug today.

## Strengths

- **W-DELETED-2 sweep is thorough.** All three new fixes (`a62b9498`, `cb8f74e4`, `5296a612`) land with the matching `deletedAt: null` filter in the right `where` clause, and every supporting raw SQL in `comprehensive-aggregator.ts`, `summaries-slice.ts`, `dashboard/summary/route.ts`, `measurements/route.ts`, `analytics/route.ts`, `bp-in-target-fast-path.ts`, `correlations-fast-path.ts`, `health-score-fast-path.ts`, `glp1-plateau.ts`, `features.ts`, `sync/state/route.ts`, `insights/cards/route.ts`, `insights/targets/route.ts`, `insights/generate/route.ts`, `ai/coach/snapshot.ts` carries the same `AND m."deleted_at" IS NULL` predicate. Eleven reader tiers covered.

- **UNION arm retirement is safe.** The `mean * count` fallback in `dashboard/summary/route.ts:498-500` is intact and the legacy-NULL test pin at `summary/__tests__/route.test.ts:278-314` still asserts the fallback path. The Marc-tenant convergence is the right gate; the per-day discovery LEFT JOIN still surfaces any future legacy row on a self-hosted instance, even if its boot-time backfill needs to re-mint a row.

- **Helper extraction is read-shape-neutral.** Both call sites consume the returned `{ projected, backfilled }` tuple correctly. The dashboard discards the values; the intake route forwards them onto `annotate(...)` for prod observability. The helper's `IntakeSource: "REMINDER"` literal preserves the doctor-report + analytics filter byte-stability. The `skipDuplicates: true` + the `@@unique([userId, medicationId, scheduledFor, source])` composite key give two layers of race protection.

- **Type consolidation is clean.** `AnalyticsData` and `BackupRow` lifts kept the call-site contract via the `as AnalyticsData` aliases (`page.tsx:28`, `insights/page.tsx:100`, `getting-started-checklist.tsx:75`) so no consumer pays for the type relocation. The four-shape (`SubPage`/`Dashboard`/`Insights`/`Checklist`) split is the right design call — collapsing into one optional-everywhere shape would have lost the per-surface contract. No circular imports: both type modules consume `@/lib/analytics/trends` and `@/lib/insights/correlations`, neither of which import back from `@/types/*`.

- **queryKey factory expansion has matching test pins.** The walker test at `src/lib/__tests__/query-keys.test.ts:55-69` covers all three new migrations (`authRegistrationStatus`, `notificationsPreferences`, `notificationsStatus`, plus the previously-unverified `apiVersion`). The bare-literal lint guard at lines 192-203 extends to the three new surfaces. No bare-literal `queryKey: [...]` survives in `src/app/auth`, `src/app/notifications`, or `src/components/settings/about-section.tsx`.

- **`/api/auth/check-user` branching is correct.** All four documented branches (`not_found`, `passkey_only`, `email_fallback`, `exists`) are reachable from the `hasPasskey` / `hasPassword` truth table, the test pin at `src/__tests__/api/auth/check-user/route.test.ts` covers all four plus the 422 input-validation path, the response envelope matches the `apiSuccess({ branch, hasPasskey, hasPassword })` shape iOS expects, and the route never echoes the identifier (PII-safe). The OR-match on `username | email` mirrors the canonical login-credential resolver.

- **Prompt-dir unification (`8a56f482`) is a pure move.** Every import path (`@/lib/ai/prompts/compact-sections`, `@/lib/ai/prompts/insight-system-prompt`) is consistent across the two consumers (`api/insights/generate/route.ts`, `ai/coach/snapshot.ts`) and the test file (`__tests__/prompt-comparison.test.ts`). No dangling `@/lib/insights/prompt*` references remain.

- **W-SIMPLIFIER cleanup is conservative.** The `tx?` param drop on three rollup helpers (`mood-rollups`, `medication-compliance-rollups`) doesn't break any call site because no call site ever passed a tx. The 13 dead-export trims are the narrowing kind (drop `export`, keep the symbol), and the four reverted candidates (`CHART_RANGE_PRESETS`, `CHANNEL_TYPES`, `CHECKLIST_ITEM_IDS`, `moodLogSyncResponseSchema`) keep their export because they back `typeof X[number]` aliases — the right call.

---

**Summary:** verdict APPROVE_WITH_FIXES, 0 Critical, 1 High, 2 Medium, 5 Low, 7 strengths. The only finding that should land before the v1.4.41 tag is H1 (port the persisted timeout-stub pattern to the four remaining status routes). Everything else is safe to defer to v1.4.42.
