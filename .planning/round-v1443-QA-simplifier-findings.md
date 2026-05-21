# Round v1.4.43 — W10-QA-SIMPLIFIER findings

**Reviewer:** W10-QA-SIMPLIFIER (read-only)
**Scope:** `git diff 2c68a48d..develop` (74 commits, 197 files, +12,301 / −460)
**Date:** 2026-05-21

## Verdict

CHANGES REQUESTED — one Critical regression (relative-time i18n keys reverted across all six locales) and one High dead-code branch (IntegrationStatusPill `warning` state never emitted) must land before tag. Five Medium and four Low items are cleanup polish.

## Counts

| Severity | Count |
|----------|-------|
| Critical | 1 |
| High     | 2 |
| Medium   | 5 |
| Low      | 4 |

---

## Critical — must fix before tag

### C-1. Relative-time i18n keys silently swept out by W12 tighten — every Insights surface now renders raw key strings

**Symptom:** `formatRelativeTime()` reads pluralised keys (`insights.relativeMinutesAgoOne` / `…Other`, `…HoursAgoOne` / `…Other`, `…DaysAgoOne` / `…Other`) — none of those keys exist in any of `messages/{de,en,es,fr,it,pl}.json`. The translator returns the raw key on a miss (see `src/lib/i18n/context.tsx:104-107`), so every relative-time render now displays the literal string `insights.relativeMinutesAgoOther` (or its variants) to users.

**Root cause:** commit `b8ca1c74` (W4 — `i18n(relative-time): branch on count === 1 to render singular forms`) correctly added the pluralised keys to all six locales and switched `formatRelativeTime` to read them. Commit `2390438e` (W4 — `i18n: tighten 404 + global-error copy across all locales`) then reverted the locale-file half of that change — the relative-* diff in `2390438e` shows `-relativeMinutesAgoOne / -relativeMinutesAgoOther / -relativeHoursAgoOne / -relativeHoursAgoOther / -relativeDaysAgoOne / -relativeDaysAgoOther` deleted and the legacy `relativeMinutesAgo / relativeHoursAgo / relativeDaysAgo` keys re-added. The code in `relative-time.ts` was not reverted, so it now reads non-existent keys.

**Confirmed missing:**
```
grep -c "relativeMinutesAgoOne\|relativeMinutesAgoOther\|…" messages/*.json
de.json:0  en.json:0  es.json:0  fr.json:0  it.json:0  pl.json:0
```

**Visible call sites (all three are user-facing):**
- `src/components/insights/coach-panel/history-rail.tsx:146` — Coach conversation history rail
- `src/components/insights/daily-briefing.tsx:323` — Daily Briefing "generated X ago" caption
- `src/components/insights/hero-strip.tsx:135` — Insights hero "Generated {time}" caption

**Files involved:**
- `src/lib/i18n/relative-time.ts:26-31, 35-40, 43-48` — code reads the missing keys
- `messages/{de,en,es,fr,it,pl}.json:1153-1156` — legacy keys present, pluralised keys absent

**Suggested fix:** restore the six pluralised keys per locale and keep the legacy keys as a transient compatibility shim, OR revert `relative-time.ts` to the legacy (non-pluralised) key reads + accept the "vor 1 Minuten" grammar drift the W4 plural commit was trying to fix. Decision is Marc's; either way the deploy cannot ship with `formatRelativeTime` reading keys that the i18n bundle does not contain. Add a guard test that asserts `t("insights.relativeMinutesAgoOne") !== "insights.relativeMinutesAgoOne"` so a future locale-file sweep cannot regress this silently.

---

## High — fix before tag if possible

### H-1. `IntegrationStatusPill` `warning` state defined and rendered but never selected — dead branch

**Symptom:** `IntegrationStatusPill` was widened in v1.4.43 W14 from three pill states to five (`connected`, `warning`, `error`, `parked`, `disconnected`). The `warning` branch carries its own copy (`warningServerError` i18n key, all six locales), its own chip class (`warningChipClass`), and its own switch case (`integration-status-pill.tsx:125-128`). No production code path ever passes `state="warning"`.

**Files involved:**
- `src/components/settings/integration-status-pill.tsx:47-52` — `IntegrationPillState` union includes `"warning"`
- `src/components/settings/integration-status-pill.tsx:108, 125-128, 157, 167` — render branches for `"warning"`
- `src/components/settings/integrations-section.tsx:127-142` — `pillStateFor()` switches over `IntegrationState` and maps to `connected | error | parked | disconnected`; never returns `"warning"`

**Evidence (grep across the tree):**
```
grep "state=\"warning\"\|state: \"warning\"\|return \"warning\"" src/
# only hits inside integration-status-pill.tsx (the dead branch itself)
```

**Suggested fix:** either (a) decide what `warning` is supposed to surface (one transient failure? one persistent without the 24h park?) and wire `pillStateFor()` to return it, OR (b) drop the `warning` branch from the union + remove the chip class + delete the `warningServerError` keys across all six locales. As-is the branch ships dead — knip won't catch this because the type is referenced through the union — and the locale-file `warningServerError` key is dead in every bundle.

### H-2. `chart-overlay-prefs` 422 audit row has no dedup — sibling of `widgets` (B2) but the dedup was not applied here

**Symptom:** v1.4.43 B2 added an in-process 60 s `(userId, action)` dedup memo to `src/app/api/dashboard/widgets/route.ts` so a misbehaving client looping on a 422 cannot flood the audit ledger. The sibling route `src/app/api/dashboard/chart-overlay-prefs/route.ts` was migrated to `returnAllZodIssues` in the same release (W6) and now writes the same kind of breadcrumb on every validation failure — without dedup. A retry loop against `/api/dashboard/chart-overlay-prefs` pumps every 422 into `AuditLog`.

**Files involved:**
- `src/app/api/dashboard/chart-overlay-prefs/route.ts:57-77` — audit row write, no dedup gate
- `src/app/api/dashboard/widgets/route.ts:45-79` — dedup gate that should be applied here too

**Suggested fix:** lift the `auditDedupMemo` + `shouldEmitAuditRow` helpers into a shared module (e.g. `src/lib/audit-dedup.ts`) keyed by `(userId, action)` and have both routes call it. Drop the `__resetAuditDedupMemoForTests` from the widgets route, export the reset helper from the shared module instead.

---

## Medium

### M-1. `formatDateOrRelative` and `formatRelativeTime` are 90 % duplicate logic with subtly divergent i18n keys

**Symptom:** v1.4.43 added `formatDateOrRelative` to `src/lib/format.ts:73-122` while leaving `formatRelativeTime` in `src/lib/i18n/relative-time.ts:16-49` intact. Both compute relative phrases for "just now / N min ago / N h ago", branch on the same time buckets, and live behind a `t()` translator. The only differences:
- `formatRelativeTime` also handles the ≥ 24 h "N days ago" bucket
- `formatDateOrRelative` falls back to `formatDateTime(iso)` after 24 h instead of "N days ago"
- `formatRelativeTime` reads the pluralised `…One` / `…Other` keys (Critical C-1)
- `formatDateOrRelative` reads the non-pluralised legacy keys (`relativeMinutesAgo` / `relativeHoursAgo`)

The two helpers ship together in the same release with deliberately different i18n contracts, and the doc comment on `formatDateOrRelative` (`src/lib/format.ts:90`) even claims it "reuses the `insights.relative*` i18n keys (same keys `formatRelativeTime()` reads)" — which is no longer true after the W4 plural commit.

**Files involved:**
- `src/lib/format.ts:73-122` — `formatDateOrRelative`
- `src/lib/i18n/relative-time.ts:16-49` — `formatRelativeTime`

**Suggested fix:** collapse into one helper that takes a `{ daysAsRelative: boolean }` option (or two thin wrappers around a shared core). Whichever pluralisation contract wins from C-1 should be the only one in the codebase.

### M-2. `WMY_FANOUT_CONCURRENCY` + `computeAvg30LastYearMap` exports exist only for tests

**Symptom:** v1.4.43 widened these two from module-private to `export` so a new concurrency test could pin the 4-cap (`src/lib/analytics/__tests__/summaries-slice.wmy-cap.test.ts`). Neither is consumed by production code outside `summaries-slice.ts` itself.

**Files involved:**
- `src/lib/analytics/summaries-slice.ts:744, 747` — `export const WMY_FANOUT_CONCURRENCY = 4;` + `export async function computeAvg30LastYearMap`
- `src/lib/analytics/__tests__/summaries-slice.wmy-cap.test.ts:26-27` — sole consumer

**Suggested fix:** if `knip` is set to enforcing mode (it is in v1.4.42 W-KNIP), `knip` may not flag test-only exports — verify CI doesn't break, then add an `// @internal — exported for the WMY-cap unit test only` comment so a future contributor doesn't reuse them by accident. Alternatively use `vi.spyOn(module, "computeAvg30LastYearMap")` against the private symbol via `vi.importActual` — same outcome, no public-surface widening.

### M-3. `__test_SECTION_ORDER` duplicates the private `SECTION_ORDER` instead of exporting it

**Symptom:** `src/components/doctor-report/doctor-report-dialog.tsx:513-521` exports a hand-duplicated array `__test_SECTION_ORDER` for an SSR component test, while `SECTION_ORDER` at line 65 is private. Two arrays that must stay in lockstep with no compile-time link.

**Files involved:**
- `src/components/doctor-report/doctor-report-dialog.tsx:65-73` — private `SECTION_ORDER`
- `src/components/doctor-report/doctor-report-dialog.tsx:513-521` — exported duplicate `__test_SECTION_ORDER`

**Suggested fix:** export `SECTION_ORDER` directly and have the test import it. The `__test_` prefix is fine documentation that it is also test-touched, but the duplicate value is regression bait.

### M-4. `withings/resume/route.ts` POST handler takes `request` then `void request;`s it

**Symptom:** `src/app/api/integrations/withings/resume/route.ts:35-58` accepts `request: NextRequest` and immediately calls `void request;`. The handler does not read the body, headers, IP, or URL — `requireAuth()` does its own request-scoping. The parameter exists only because `apiHandler` types it; rather than wrapping with a no-arg arrow + casting, the cleaner shape is to drop the parameter or rename it `_request`.

**Files involved:**
- `src/app/api/integrations/withings/resume/route.ts:35` — `void request;`

**Suggested fix:** rename to `_request` (TS / lint-allowed unused-prefix) or check whether `apiHandler` accepts a 0-arg handler. Either drops the `void` magic incantation.

### M-5. `health-chart.tsx` stashes raw count on the data array via `Object.defineProperty` — unusual carrier

**Symptom:** `src/components/charts/health-chart.tsx:691-697` writes a non-enumerable `rawCount` property onto the returned data array, then `src/components/charts/health-chart.tsx:704-708` reads it back via a type-coerced cast. The data array is the value the `useQuery` cache stores, so the property has to survive React-Query's structural sharing pass (it does — non-enumerable properties aren't seen by the cloner — but the test surface for this is silent). Easier: return `{ data: ChartDataPoint[]; rawCount: number }` and adjust the one consumer.

**Files involved:**
- `src/components/charts/health-chart.tsx:691-708` — `Object.defineProperty(allData, "rawCount", …)` + `useMemo` re-read

**Suggested fix:** switch the query function to return `{ data, rawCount }`; rename the `useQuery` destructure to `{ data: queryResult }` then read `queryResult?.data` and `queryResult?.rawCount`. Drops the non-enumerable trick and removes the `(data as ChartDataPoint[] & { rawCount?: number })` cast.

---

## Low

### L-1. `scrollBehaviorForUser` not wired into the fourth caller it advertises

**Symptom:** `src/lib/motion.ts:1-3` claims to be the source of truth for "the four programmatic `scrollIntoView` / `scrollTo` call-sites in the app", but `src/components/onboarding/WelcomeCarousel.tsx:122-126` still inlines its own `window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth"` check. Three of the advertised four call-sites use the helper; one was missed.

**Files involved:**
- `src/lib/motion.ts:1-3` — comment promises "the four call-sites"
- `src/components/onboarding/WelcomeCarousel.tsx:122-126` — inline copy not switched over

**Suggested fix:** wire `WelcomeCarousel.tsx` through `scrollBehaviorForUser()`, or amend the motion.ts header comment to "three call-sites".

### L-2. `audit.coach.replay-injection` audit action name is anomalous (no other audit action uses the `audit.` prefix)

**Symptom:** Every other audit action name in the codebase reads `<surface>.<verb>` (e.g. `admin.backups.run`, `auth.login.failed`, `integrations.parked`, `integrations.resumed`). The new replay-injection guard writes `audit.coach.replay-injection` (with a `.` separator on `replay-injection` to boot), which both leaks the storage layer's name and breaks the dot-separator convention.

**Files involved:**
- `src/app/api/insights/chat/route.ts:217` — `await auditLog("audit.coach.replay-injection", { … });`

**Suggested fix:** rename to `coach.replay.detected` (matches `auth.login.failed` shape) or `insights.coach.replay_injection` (matches the `annotate()` action name two lines above it). Either drops the `audit.` prefix duplication.

### L-3. `OfflineBanner` uses `queueMicrotask` as an escape hatch for a strict lint rule — `useSyncExternalStore` is the documented pattern

**Symptom:** `src/components/layout/offline-banner.tsx:52-56` wraps the initial `navigator.onLine` read inside a `queueMicrotask` "because the legacy in-effect setState path tripped the strict lint rule". This works but `useSyncExternalStore` is the idiomatic shape for "subscribe to an external boolean signal during render" — no microtask defer, no hydration mismatch, no comment needed.

**Files involved:**
- `src/components/layout/offline-banner.tsx:25-61` — useState + useEffect + queueMicrotask shape

**Suggested fix:** rewrite as `useSyncExternalStore` with subscribe = add/remove online/offline listeners, getSnapshot = `navigator.onLine`, getServerSnapshot = `true`. Drops both the `queueMicrotask` ceremony and the SSR-stability comment.

### L-4. `Object.defineProperty(allData, "rawCount", {writable: false})` + `mood-chart.tsx` per-day reduction are inconsistent — one chart smuggles count via the array, the other computes from raw data

**Symptom:** v1.4.43 W2-CHART-GATE applied the "split copy on raw count vs distinct days" fix across three charts:
- `health-chart.tsx` smuggles `rawCount` via `Object.defineProperty` (M-5 above)
- `medication-compliance-chart.tsx:255-269` computes from `data.reduce((acc, p) => acc + p.scheduled, 0)` (clean)
- `mood-chart.tsx` (verify) likely matches the compliance pattern

The three implementations should share one shape. The compliance shape is cleaner; the health-chart shape is the outlier.

**Files involved:**
- `src/components/charts/health-chart.tsx:691-708`
- `src/components/charts/medication-compliance-chart.tsx:255-269`
- `src/components/charts/mood-chart.tsx` (verify same)

**Suggested fix:** rework `health-chart.tsx` to compute `rawCount` from the same `.reduce` shape (sum across daily aggregates' `count` field) after the query resolves, instead of stashing it on the array during the fetch.

---

## Out of scope / not flagged

- `formatActiveLocale` widening in `src/lib/format.ts:9-19` (legitimate v1.4.43 QoL — sub-locale users now see proper locale formatters)
- `recordWithingsSyncFailure` export change (`src/lib/withings/sync.ts:290`) — needed to let `sync-activity.ts` + `sync-sleep.ts` route through the typed classifier (W7-B3); not over-engineering
- `WithingsApiError` 1024-char message cap (`src/lib/withings/response-classifier.ts:248-254`) — defence-in-depth, appropriate
- `checkAuthSurfaceRateLimit` (`src/lib/rate-limit.ts:104-127`) — clean abstraction over a real attack surface (trust-violation bucket exhaustion)
- `IntegrationStatus.consecutiveFailuresByKind` JSONB column + 24 h park flip — appropriate complexity for the contract-mismatch sustain problem
- `scripts/generate-sw-version.mjs` + `prebuild` — closes the v1.4.38.4 → v1.4.42 stale-CACHE_VERSION drift; correct shape
- Dockerfile `NEXT_PUBLIC_APP_VERSION` build-arg — closes the v1.4.42 stale `package.json` cache regression; correct shape
- W6 `returnAllZodIssues` rollout — straight-line API consistency
- Chart skeleton + dashboard tile-strip skeleton additions — appropriate UX polish
- All `motion-reduce:animate-none` additions + the textual-scan coverage test — appropriate accessibility floor
- All test additions are appropriate scaffolding; none pin temporary scaffolding instead of release-quality contracts

---

## Relevant files

- `/Users/marc/Projects/HealthLog/src/lib/i18n/relative-time.ts` (C-1)
- `/Users/marc/Projects/HealthLog/messages/{de,en,es,fr,it,pl}.json` (C-1)
- `/Users/marc/Projects/HealthLog/src/components/settings/integration-status-pill.tsx` (H-1)
- `/Users/marc/Projects/HealthLog/src/components/settings/integrations-section.tsx` (H-1)
- `/Users/marc/Projects/HealthLog/src/app/api/dashboard/chart-overlay-prefs/route.ts` (H-2)
- `/Users/marc/Projects/HealthLog/src/app/api/dashboard/widgets/route.ts` (H-2 reference)
- `/Users/marc/Projects/HealthLog/src/lib/format.ts` (M-1)
- `/Users/marc/Projects/HealthLog/src/lib/analytics/summaries-slice.ts` (M-2)
- `/Users/marc/Projects/HealthLog/src/components/doctor-report/doctor-report-dialog.tsx` (M-3)
- `/Users/marc/Projects/HealthLog/src/app/api/integrations/withings/resume/route.ts` (M-4)
- `/Users/marc/Projects/HealthLog/src/components/charts/health-chart.tsx` (M-5, L-4)
- `/Users/marc/Projects/HealthLog/src/lib/motion.ts` (L-1)
- `/Users/marc/Projects/HealthLog/src/components/onboarding/WelcomeCarousel.tsx` (L-1)
- `/Users/marc/Projects/HealthLog/src/app/api/insights/chat/route.ts` (L-2)
- `/Users/marc/Projects/HealthLog/src/components/layout/offline-banner.tsx` (L-3)
