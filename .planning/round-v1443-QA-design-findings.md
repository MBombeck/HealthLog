# W10-QA-DESIGN findings — v1.4.43 (read-only)

**Diff base:** `2c68a48d..develop` (74 commits, 197 files, +12 301 / −460 LOC)
**Reviewer:** W10-QA-DESIGN
**Scope:** design / UX / a11y of v1.4.43 UI surface (W5, W11, W12, W4, W2-CHART-GATE, W14 pill, W7)

---

## Verdict

**RED — one Critical i18n regression blocks ship.**

A single self-inflicted regression on the `relativeMinutes/Hours/DaysAgoOne/Other` plural keys silently leaks raw i18n placeholder strings ("insights.relativeMinutesAgoOther") into three live Insights surfaces (Daily Briefing, Hero strip, Coach history rail) in all 6 locales. Discovered via cross-reference of the `b8ca1c74` (H6 plural-split) ↔ `2390438e` (404/global-error tighten) ↔ `32ca196e` (chart-keys restore) sequence — the second commit deleted the `*One/*Other` keys as collateral damage on top of the chart keys, and the third only restored chart keys.

Everything else in the W5 / W11 / W12 / W4 / W2 / W14 scope landed in good shape. Empty-state coverage, motion-reduce sweep, skeleton heights, 44 px tap targets, and i18n parity on the *new* keys all check out. Fix the plural-keys regression and ship.

---

## Critical (1)

### C1 — `insights.relativeMinutes/Hours/DaysAgo{One,Other}` keys missing in all 6 locales → raw placeholder strings rendered live

**Severity:** Critical — user-facing visible regression in 3 production surfaces.
**Surfaces affected:** Daily Briefing "Generated {time}", Hero Strip "Generated {time}", Coach History Rail relative-time labels.
**Locales affected:** de, en, es, fr, it, pl (all six).

**Trace:**
- Commit `b8ca1c74` (W4 H6, "i18n(relative-time): branch on count === 1 to render singular forms") rewrote `src/lib/i18n/relative-time.ts:25-48` to call `t("insights.relativeMinutesAgoOne")` / `Other` etc., and added the matching keys across every locale.
- Commit `2390438e` ("i18n: tighten 404 + global-error copy across all locales") **deleted the new `*AgoOne/*AgoOther` key pairs** as well as several chart keys, replacing them with the legacy singular forms (`relativeMinutesAgo`).
- Commit `32ca196e` ("fix(i18n): restore chart keys W11 + W2 added across all locales") restored only the chart keys (`needMoreDistinctDaysTitle/Description`, `noDataInRangeTitle/Description`). The relative-time plural keys were missed.

**Verification:**
```
$ grep -c "relativeMinutesAgoOne\|relativeMinutesAgoOther" messages/*.json
de:0  en:0  es:0  fr:0  it:0  pl:0
```

`src/lib/i18n/context.tsx:104-107` falls back to **the raw key string** when no locale (including English) carries the key:

```ts
// Fallback to key itself
if (value === undefined) {
  return key;
}
```

So every German user reading the Insights Hero strip currently sees `"insights.relativeMinutesAgoOther"` instead of `"vor 5 Minuten"` (and the same on five other locales). No tests catch this — no `formatRelativeTime` callers are exercised in the test suite.

**Repro:**
1. Open `/insights` after a fresh Daily Briefing generation (or wait ~5 min after one).
2. Look at "Generated {time}" — should read "Generated 5 minutes ago" / "Generated 5 Minuten her" depending on locale.
3. Instead the literal `"insights.relativeMinutesAgoOther"` appears.

**Fix sketch (read-only, do NOT apply):** Either
1. Re-add the 6 plural-form pairs across every locale (`relativeMinutesAgoOne/Other`, `relativeHoursAgoOne/Other`, `relativeDaysAgoOne/Other`), OR
2. Revert `relative-time.ts` to read the legacy singular keys (loses the H6 grammatical fix).

The former is the right call — H6's "vor 1 Minuten" bug is a real grammar issue.

**Recommended regression guard:** A new `__tests__/relative-time.test.ts` that asserts each of the 6 keys resolves in each of the 6 locales, plus an integration assertion that `formatRelativeTime(…)` never returns a string that starts with "insights." prefix.

---

## High (1)

### H1 — `IntegrationStatusPill` warning state added but never produced by the live status mapper

**Severity:** High — feature shipped without end-to-end wiring (dead code paths).
**Surface:** Settings → Integrations → Withings card.

`src/components/settings/integration-status-pill.tsx:121-128` accepts `state: "warning"` and the W4 phase report (commit `d1428650`) added the amber `warningServerError` translation in all 6 locales. But `pillStateFor()` in `src/components/settings/integrations-section.tsx:127-142` only emits `connected`, `error`, `parked`, `disconnected` — the underlying `IntegrationState` union never produces `warning`, so the chip is unreachable from the live card.

The W4 phase report explicitly defers wiring (file-allow-list scope), so this is a known partial. Recommend either:
- Wire `failureKind === "persistent"` → `warning` in pillStateFor() (matches the W4-H3 acceptance criteria), OR
- Document the warning state as "iOS app reserve" so the test surface doesn't drift.

Either way the state should not stay dead-code on the web shell.

---

## Medium (4)

### M1 — Switch tap target falls 1.6 px short of WCAG 2.5.5 in vertical axis

**Severity:** Medium — within compliance grey-zone but spec-strict failure.

`src/components/ui/switch.tsx:26` uses `data-[size=default]:h-[1.15rem]` = 18.4 px track + `before:inset-[-12px]` pseudo-element padding = 12 × 2 = 24 px → **42.4 px total vertical hit area**. WCAG 2.5.5 requires ≥ 44 × 44 px.

Horizontal axis is fine (32 px track + 24 px = 56 px). Recommend bumping `before:inset-[-12px]` to `before:inset-y-[-13px] before:inset-x-[-12px]` (or just `-13px`) to clear the 44 px floor.

The component comment explicitly cites WCAG 2.5.5 as the rationale, so this looks like an oversight, not a deliberate design choice.

### M2 — `animate-pulse` ad-hoc skeletons missing `motion-reduce:animate-none` (10 sites in 3 files)

**Severity:** Medium — motion-reduce sweep was scoped to `animate-spin` only (W11 sweep + regression test at `src/components/__tests__/motion-reduce-spin-coverage.test.ts`). The shared `<Skeleton>` primitive (`src/components/ui/skeleton.tsx:24`) handles `motion-reduce`, but three files still hand-roll `animate-pulse` divs:

- `src/components/insights/daily-briefing.tsx:230-233, 241` (5 sites)
- `src/components/insights/trend-annotation.tsx:100-102` (3 sites)
- `src/components/doctor-report/doctor-report-dialog.tsx:574-575` (2 sites)

Recommend either:
- Extend the `motion-reduce-spin-coverage.test.ts` guard to cover `animate-pulse` as well, OR
- Migrate the inline skeletons to `<Skeleton>` so they inherit `motion-reduce`.

The motion-reduce coverage spec already passes for `animate-spin` (W11-L1) so the only gap is `animate-pulse`.

### M3 — Coach `errorNetwork` copy split is good, but does not branch on the **client's** `navigator.onLine` first

**Severity:** Medium — UX gap, not a bug.

`message-thread.tsx:82-90` maps server error code `coach.network` to the `errorNetwork` copy. Good. But the client never pre-checks `navigator.onLine` before issuing the fetch, so a user who toggled airplane mode mid-form-fill sees:
- The new `<OfflineBanner>` at the top (good — separate W12-M5 fix).
- The Coach Send button still active.
- A generic 0/network error after the request times out.

Recommend disabling Send when `navigator.onLine === false` so the user gets the actionable copy instantly instead of after a request timeout. This is additive to W12-M6 and could ride into v1.4.44 backlog.

### M4 — Doctor-report disabled-not-hidden: strike-through styling reads as "deleted", not "unavailable"

**Severity:** Medium — visual semantic mismatch.

`doctor-report-dialog.tsx:638-642` applies `line-through` to the label of unavailable section toggles. Strike-through carries a strong "removed / deleted" connotation; for "no data in this period" the convention is the opacity dim + caption line (which the dialog already paints below). Recommend dropping the strike-through and relying on `opacity-60 cursor-not-allowed` + the existing italic hint line.

The hint line copy is good ("Keine Daten in diesem Zeitraum") and covers all 6 locales.

---

## Low (5)

### L1 — `comparison-baseline` pill DE copy "Dein Mittel" reads as personal-baseline noun, not toggle action verb

**Severity:** Low — DE polish.

`charts.personalBaseline` in `messages/de.json:858` reads "Dein Mittel" (noun phrase). On the comparison-baseline pill row in `chart-overlay-controls.tsx:251-260` the buttons are toggle actions; the noun form reads slightly odd next to the active label. Not a blocker, just a stylistic choice that may be worth tightening in a later QoL pass.

### L2 — Sheet close-X mobile target uses `min-h-11 min-w-11 sm:min-h-9 sm:min-w-9`, fine — but the icon stays `size-4`

**Severity:** Low — visual centering.

`src/components/ui/sheet.tsx:88` and `src/components/ui/dialog.tsx:86` bump the tap target from 9 → 11 on mobile, leaving the 16 px X icon. The result is a 44 × 44 px target with a tiny dot in the middle — functionally correct, visually thin. Recommend `[&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-4` stays but mobile gets `size-5`, OR keep as-is and rely on the larger tap zone being self-explanatory.

This is the iOS / Apple HIG convention so not strictly wrong. Calling out for awareness only.

### L3 — Chart-skeleton `loadingSlowHint` caption fires after 3 s — good copy, but no `aria-live`

**Severity:** Low — a11y minor.

`chart-skeleton.tsx:125-132` paints the caption inside the parent `role="status" aria-live="polite"` skeleton container. The transition from skeleton-without-hint to skeleton-with-hint should announce; with `aria-live="polite"` on the outer it likely will, but the caption itself is wrapped in `<p>` rather than an explicit live region. Recommend adding `aria-live="polite"` directly on the `<p>` or ensure the test covers the announcement.

### L4 — `OfflineBanner` paints below `<MaintainershipBanner>` even though comment says "first chrome line"

**Severity:** Low — comment / behaviour mismatch.

`auth-shell.tsx:164-169` puts `<OfflineBanner>` immediately above `<MaintainershipBanner>` (correct per code order). But the inline comment claims it sits "above the maintainership banner + top bar so the connection-status hint is always the first chrome line a user sees in the offline branch." Verified — the order is OfflineBanner → MaintainershipBanner → TopBar, so the comment is accurate. (This was a false alarm during my review — code matches the claim. Listing here for note-keeping only.)

### L5 — `formatDateOrRelative` in `src/lib/format.ts:96-121` reads `relativeMinutesAgo` (legacy key — exists) while `formatRelativeTime` reads `*One/*Other` (missing keys — broken)

**Severity:** Low — code-quality / consistency.

Two helpers, two different key sets. `formatDateOrRelative` (`src/lib/format.ts`) reads the original `relativeMinutesAgo` keys (which still exist) and works correctly. `formatRelativeTime` (`src/lib/i18n/relative-time.ts`) reads the new `*One/*Other` plural-aware keys (which are missing — see Critical C1).

Even after the C1 fix, having two helpers with two different key contracts is fragile. Recommend consolidating both call-sites onto one helper in a v1.4.44 simplification pass.

---

## Strengths

- **i18n parity on most new keys is rock-solid.** `noDataInRangeTitle/Description`, `needMoreDistinctDaysTitle/Description`, `loadingSlowHint`, `errorNetwork`, `offlineBanner.message`, `notFound.title/backToDashboard`, `unavailableHint`, `resumeCta/Success/Error`, `warningServerError/parkedReconnect` — all 6 locales present, tight Marc-voice copy across the board.
- **Empty-state coverage closes the silent-null gap.** `health-chart.tsx:1141-1334` swaps the legacy `return null` on empty `chartData` for an explicit `<ChartEmptyState>` with distinct copy from the < 3 raw and < 3 distinct days variants. The three-way gate is the right call — every "no data" path now paints something meaningful.
- **W2-CHART-GATE rawCount logic is correct.** The `rawMeasurementCount` accumulator + non-enumerable `rawCount` property on the returned array is a clean way to thread the metric through without disturbing downstream array consumers. Mood + medication mirror the pattern correctly.
- **Motion-reduce sweep + regression guard.** `motion-reduce-spin-coverage.test.ts` is the right kind of guard — textual, fast, catches drift. The 21-site sweep landed cleanly. (Gap: animate-pulse — see M2.)
- **Skeleton heights match loaded content.** Insights mother-page skeleton heights bumped from `h-48/h-32/h-64` → `h-[24rem]/h-[20rem]/h-[20rem]` with a pinning regression test (`page-skeletons.test.ts`). Scatter-correlation skeleton mirrors `aspect-square` / `sm:aspect-[3/2]` responsive contract. Recent-workouts-tile and DrugLevelChart now reserve `min-h-[10rem]` / `min-h-[240px]` respectively.
- **Reduced-motion scroll helper is the right shape.** `src/lib/motion.ts:scrollBehaviorForUser()` consolidates the four `scrollIntoView` / `scrollTo` smooth-behavior sites onto one helper that respects `prefers-reduced-motion`. Settings shell, admin shell, message thread, and the new W5-H5 sites all migrated; only WelcomeCarousel still does its own check (justified — separate context).
- **Danger-zone visual quieting (`AlertTriangle` icon dropped, neutral title colour, red CTA only).** GitHub-style. Account-delete CTA card mirrors the data-reset shaping so the two surfaces read as siblings on the same page.
- **Doctor-report disabled-not-hidden is the right architecture.** The submission payload still force-clears unavailable toggles (server never renders an empty section), so the user-facing change is purely visual — no behavioural regression risk.
- **OfflineBanner architecture is clean.** SSR-safe (initial state `true`, paints nothing during SSR), microtask-deferred initial read of `navigator.onLine`, proper add/removeEventListener cleanup, `role="status" aria-live="polite"`, and i18n-aware copy.
- **W14 parked-integration UX.** Distinct visual treatment (orange `dracula-orange/15`) from warning (yellow) and error (red destructive), proper aria, manual reconnect CTA with 44 px tap target on mobile (`min-h-[44px] sm:min-h-0`), success / error feedback as separate `role="status"` / `role="alert"` paragraphs.
- **404 page server-resolves locale.** No more English-only `not-found` for German users; the implementation uses the existing `resolveServerLocale()` + `getServerTranslator()` infrastructure correctly. global-error is bilingual lockup because it cannot reach the i18n provider — also the right call.
- **Apple Health / Withings visual coherence preserved.** The Apple Health pink badge accent on measurement source badges (`measurement-list.tsx:144-149`) survives unchanged, Withings parked banner uses dracula-orange (different tone from connected green / warning yellow), and the integration-pill remains the single source of truth for sync status (no v1.4.18-era redundancy resurfaced).

---

## Recommendation

**Fix C1 (relative-time plural keys), then ship.** H1 (warning state wiring) is a documentation-only fix or a 6-line `pillStateFor` extension — either is fine. M-tier items are not blockers; L-tier items are pure polish for v1.4.44.

**Suggested follow-up backlog for v1.4.44:**
- C1 fix + regression test (5 min, 1 commit).
- H1 warning-state wiring or doc-only deferral (10 min).
- M1 Switch vertical inset (1 line).
- M2 animate-pulse motion-reduce sweep + extend the guard (15 min).
- L5 consolidate `formatDateOrRelative` + `formatRelativeTime` onto one helper.
