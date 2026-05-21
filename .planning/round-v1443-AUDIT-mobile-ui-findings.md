# v1.4.43 Mobile UI / responsive audit findings

## Verdict
APPROVE_WITH_FIXES

Mobile-UI hygiene is in good shape overall — v1.4.27/33/34 mobile passes have closed the major touch-target / iOS-zoom / safe-area gaps. The user-reported "Erfasse mindestens 3 Einträge" finding is a real semantic bug (not a slow-data artifact), and there are a few residual sub-44 px tap targets and motion-handling inconsistencies worth addressing before the tag. None block the release on their own.

---

## Critical (must fix before tag)

### C1 — Chart empty-state fires on the 7-day tab even when the user has lots of data
- **File**: `/Users/marc/Projects/HealthLog/src/components/charts/health-chart.tsx:1251` (gate) + `:672-770` (chartData derivation) + `:675` (slice)
- **What's wrong**: The empty state `t("charts.emptyStateTitle")` = "Erfasse mehr Messungen, um Trends zu sehen" + `t("charts.emptyStateDescription")` = "Erfasse mindestens 3 Einträge, um die Trendlinie freizuschalten." paints when `chartData.length >= 1 && chartData.length < 3`. `chartData` is the *daily-aggregated* slice over the active range tab. A user with 50 BP readings in the last 30 days but only 2 distinct days inside the 7-day tab still sees this message even though raw count is ≥ 50. The message is factually wrong in that case (they have many entries; what they don't have is points across distinct days). The same condition holds in `mood-chart.tsx:679` and `medication-compliance-chart.tsx:391`.
- **Recommended fix**: Gate the message on raw measurement count (or `summary.count`), not aggregated `chartData.length`. Two options:
  1. When `chartData.length < 3 && rawCount >= 3`, render a different copy: "Mehr Messtage erforderlich" / "Erfasse an mehreren Tagen für eine Trendlinie" (the underlying constraint is *day diversity*, not entry count).
  2. Render the chart line anyway with the 1-2 points and skip only the regression overlay — the empty-state was added in v1.4.16 B1a for genuinely brand-new accounts; an established user just doesn't need it.
- **Severity rationale**: Marc explicitly flagged this as confusing under "even when data exists". It misleads experienced users into thinking the app forgot their data.

---

## High (should fix before tag)

### H1 — Switch tap area is 18×32 px, well below WCAG 2.5.5
- **File**: `/Users/marc/Projects/HealthLog/src/components/ui/switch.tsx:20`
- **What's wrong**: `data-[size=default]:h-[1.15rem] data-[size=default]:w-8` = 18.4×32 px. 24 instances across the app (settings sections, sources-section, dashboard-layout-section, coach-settings-sheet, notification toggles). On a touch device a 18 px tall target is one finger-pad's height — the Radix-Switch root *is* the hit area; the label next to it is not part of the tappable region. v1.4.34 IW-G floored Inputs at 44 px but Switches were missed.
- **Recommended fix**: Wrap the Switch root in a 44×44 padded `<label>` or extend the Switch component itself with `before:absolute before:inset-[-12px] before:content-['']` to enlarge the hit zone without changing the visual. Alternatively expose a `tapSize="lg"` variant that pads via `relative` + `::after` pseudo-element.
- **Severity rationale**: WCAG 2.5.5 violation across the most-used setting toggles. Discovered now while everyone walks Settings on phones.

### H2 — Comparison-baseline buttons in chart overlay popover are 36 px
- **File**: `/Users/marc/Projects/HealthLog/src/components/charts/chart-overlay-controls.tsx:251`
- **What's wrong**: `className="h-9 px-1 text-[11px]"` = 36×~36 px buttons inside the per-chart cog popover (3-column grid: `none` / `lastMonth` / `lastYear`). On a mobile chart the popover already lives inside a flyout the user tapped a 44 px cog to open, so undersized targets compound a precision problem.
- **Recommended fix**: Bump to `min-h-11 sm:min-h-9 px-2 text-[11px]` so mobile gets 44 px and desktop keeps the dense 36 px row.
- **Severity rationale**: Affects every dashboard chart's comparison-toggle, which Marc surfaced for v1.4.21 + v1.4.22 specifically as a recurring mobile irritation.

### H3 — Mood-form "more options" dropdown trigger is 36 px on mobile
- **File**: `/Users/marc/Projects/HealthLog/src/components/mood/mood-form.tsx:143`
- **What's wrong**: `<Button size="icon" className="h-9 w-9">` = 36×36 px. Lives inside the bottom-sheet footer where the user has to thumb between Cancel / Save / kebab — same mobile sheet shipped to every quick-add. The medication-form analogue at `medication-form.tsx:781,994` uses `h-11 w-11` correctly; the mood-form lagged behind, and the same legacy size sits on `mood-list.tsx:616` (the *edit*-mode footer mounted on mobile).
- **Recommended fix**: Swap both to `className="h-11 w-11"` to match the medication-form pattern.
- **Severity rationale**: Bottom-sheet finger ergonomics — exactly the surface mobile users hit most frequently.

### H4 — Bottom-sheet close-X is 36 px (intentional but inconsistent with other tap-target hardening)
- **File**: `/Users/marc/Projects/HealthLog/src/components/ui/sheet.tsx:88` + `dialog.tsx:86`
- **What's wrong**: `min-h-9 min-w-9` = 36×36 px. The inline comment notes "intentional exception per dialog primitive's rationale: 44 px would crowd the sheet header out of proportion". Acceptable in isolation, but Marc reported this collision with the settings cog in v1.4.20 post-deploy ("settings cog vs Sheet close-X collision"), and the surrounding chrome (form submit / cancel buttons) is already 44+ px. The argument that 44 px would crowd the header doesn't hold when the header is `p-4 pr-12` — there's room.
- **Recommended fix**: Bump to `min-h-11 min-w-11`. The icon stays `size-4`; only the hit zone grows. If the visual crowding really is a problem on a 320 px viewport, gate on `min-h-9 sm:min-h-11`-style breakpoint so phones get the safer target.
- **Severity rationale**: 36 px is below WCAG 2.5.5; comment acknowledges the tension but lands on the wrong side for mobile users.

### H5 — Smooth-scroll calls ignore prefers-reduced-motion (3 sites)
- **Files**:
  - `/Users/marc/Projects/HealthLog/src/components/settings/settings-shell.tsx:172`
  - `/Users/marc/Projects/HealthLog/src/components/admin/admin-shell.tsx:186`
  - `/Users/marc/Projects/HealthLog/src/components/insights/coach-panel/message-thread.tsx:197,216`
- **What's wrong**: `el.scrollIntoView({ behavior: "smooth" })` / `el.scrollTo({ behavior: "smooth" })` fires unconditionally. `WelcomeCarousel.tsx:126` already shows the right pattern: `behavior: reduceMotion ? "auto" : "smooth"` driven by a media-query hook.
- **Recommended fix**: Add a shared helper (`scrollBehaviorForUser()` in `src/lib/motion.ts` or similar) that reads `window.matchMedia('(prefers-reduced-motion: reduce)').matches` and returns `"auto"` when true. Wire all four sites to it.
- **Severity rationale**: Motion sensitivity is an accessibility class HealthLog already supports elsewhere (CSS keyframes are gated; Lottie/Framer is `motion-reduce`-aware) — JS-driven scrolling is the lone gap.

---

## Medium (recommended for tag)

### M1 — `Loader2 animate-spin` missing `motion-reduce:animate-none` (21 sites)
- **Files**: `health-chart.tsx:1249` (chart loading spinner), `settings/account-section.tsx:362,620,711`, `settings/about-section.tsx:214`, `settings/sources-section.tsx:595`, `settings/ai-section.tsx:642,685,706`, `medications/DrugLevelChart.tsx:235`, `admin/backups-section.tsx:365,421,432,462,521`, `admin/api-token-overview-section.tsx:169`, `admin/system-status-section.tsx:231,240`, `doctor-report/doctor-report-dialog.tsx:486,575`.
- **What's wrong**: ~16 % of `animate-spin` call sites lack the motion-reduce modifier (107 honor it, 21 don't). The chart's own loading spinner inside the dashboard's tile-strip area is the most visible offender (`health-chart.tsx:1249`).
- **Recommended fix**: Sweep all `animate-spin` occurrences to append `motion-reduce:animate-none`. A `<Spinner />` primitive that bakes the class in (similar to ChartSkeleton) would close the gap permanently.
- **Severity rationale**: Continuous rotation is the canonical "trigger" animation for motion-sensitive users; missing the modifier on a chart loading-state defeats the rest of the motion-reduce defence.

### M2 — `phase-config-dialog.tsx` Input + Button are 32 px tall with `text-sm`
- **File**: `/Users/marc/Projects/HealthLog/src/components/medications/phase-config-dialog.tsx:237,243`
- **What's wrong**: `<Input className="h-8 w-20 text-sm" />` and `<Button className="h-8 w-12 px-0 text-xs" />`. The Input's `text-sm` override defeats the default `text-base md:text-sm` iOS-zoom defence — 14 px input will zoom the viewport on iOS Safari focus. The 32 px height for both is well below 44 px.
- **Recommended fix**: Drop the `text-sm` from the Input (let the default win on mobile) and bump heights: `h-11 sm:h-9`.
- **Severity rationale**: Phase-config-dialog is medication-tracker P0 surface; iOS zoom-on-focus + tiny buttons compound.

### M3 — Insights dynamic skeletons don't match loaded content height exactly
- **File**: `/Users/marc/Projects/HealthLog/src/app/insights/page.tsx:43,55,67`
- **What's wrong**:
  - `DailyBriefing` skeleton `h-48` (192 px) vs loaded content varies (~220-360 px depending on briefing content).
  - `CorrelationRow` skeleton `h-32` (128 px); loaded grid is 1-col (mobile) or 2-col (md+) of cards each ~250-300 px including disclaimer.
  - `TrendsRow` skeleton `h-64` (256 px); loaded row is a 3-up grid each ~300+ px with annotation.
- **Recommended fix**: Either reserve the larger height (`h-[24rem]` for DailyBriefing, `h-[20rem]` for the others) or use a content-mirror approach like `<ChartSkeleton>` does. The shift is small (skeleton is short, paint is taller — content pushes down, not up) but it does CLS the page on slow networks.
- **Severity rationale**: User-facing only on cold mounts with slow networks; ranks as Medium because the v1.4.42 W5 placeholder polish already nailed the chart-tile case.

### M4 — `correlation-card.tsx` scatter skeleton mismatches loaded aspect ratio on `sm+`
- **File**: `/Users/marc/Projects/HealthLog/src/components/insights/correlation-card.tsx:34` + `scatter-correlation-chart.tsx:100`
- **What's wrong**: Skeleton is fixed `h-[180px]`; the loaded chart is `aspect-square min-h-[180px] sm:aspect-[3/2] sm:h-auto`. On `sm+` the loaded chart becomes a 3:2 aspect rectangle — typically 240+ px tall on a 360 px-wide card — so the skeleton is ~60 px shorter than the painted chart. CLS on insights cold mount.
- **Recommended fix**: Mirror the chart's class on the skeleton: `aspect-square sm:aspect-[3/2] min-h-[180px] sm:h-auto`.
- **Severity rationale**: Single below-the-fold spec; corrects a known CLS hot spot.

### M5 — Dashboard "blocked-then-burst" tile-strip when slim-analytics also lags
- **File**: `/Users/marc/Projects/HealthLog/src/app/page.tsx:1360-1424` (tile-strip render gate)
- **What's wrong**: The grid wrapper only renders when `trendCards.length > 0`. Every tile is gated on `has*` flags read from `data?.summaries?.*?.count`. If both `slim` and `thick` `/api/analytics` are slow (the HAR shows 9 s; slim is normally <1 s but during cache eviction it can be slower too), the user sees the page header + 0 tiles + then 9 s later 7 tiles appear at once. The per-tile `<Suspense>` placeholder at `:1412` only paints if the tile body itself suspends (which the synchronous tile bodies never do today). v1.4.39.2 split the analytics query specifically to fix this; the fix works only when slim is fast.
- **Recommended fix**: Two options:
  1. Render a "tile-strip skeleton" (N greyed-out cards keyed off the layout's visible-tile count) when `trendCards.length === 0 && analyticsSlimQuery.isLoading && layout.widgets.some(w => w.tileVisible)`. The user sees the strip silhouette during the slow window.
  2. Treat the 9 s thick fetch as a perf bug to chase separately (v1.4.43 audit-data scope) and rely on slim being fast.
  Either way: when only thick is slow, partial-paint the strip from slim and avoid waiting on thick.
- **Severity rationale**: Marc reported the "etwas nervig" feel in v1.4.39 already; the slim/thick split was supposed to close it, but a thick-slow scenario still re-creates the impression on cold mounts.

### M6 — Chart's `aria-busy` reuses `isLoading` flag but the empty-state branch silently swallows announcements
- **File**: `/Users/marc/Projects/HealthLog/src/components/charts/health-chart.tsx:1095,1247`
- **What's wrong**: `if (!isLoading && !data?.length) return null;` (line 1095) returns NO DOM when data is empty after load. The chart's containing widget shows nothing at all — no empty card, no skeleton, no message. Combined with the empty-state-on-1-2-points branch at line 1251, the chart's user-visible states are: skeleton (loading), 1-2 points → "Erfasse 3 Einträge", 3+ points → chart line, 0 points → nothing-at-all. The 0-points branch is unexpected ergonomically (other Recharts wrappers paint a "Keine Daten" message).
- **Recommended fix**: Replace `return null` with a "no data in this window" state that mirrors `<ChartEmptyState>` styling. Different copy than the < 3-points branch to avoid the C1 confusion.
- **Severity rationale**: User reads "the dashboard is broken" instead of "this range has no data for me".

---

## Low (defer to v1.4.44)

### L1 — Insights tab-strip group-popover items at 40 px instead of 44 px
- **File**: `/Users/marc/Projects/HealthLog/src/components/insights/insights-tab-strip.tsx:380`
- **What's wrong**: `className="flex min-h-10 items-center …"` = 40 px sub-page links inside the group popover. Outer tab pills meet the 44 px floor; inner popover items are 4 px short.
- **Fix**: Bump to `min-h-11`.

### L2 — `chart-overlay-controls.tsx` dropdown trigger uses `size="sm"` + `min-h-11 min-w-11 px-0` mix
- **File**: `/Users/marc/Projects/HealthLog/src/components/charts/chart-overlay-controls.tsx:101-102`
- **What's wrong**: `size="sm"` (32 px default) stretched to 44 px via `min-h-11 min-w-11 px-0`. Same v1.4.27 fix pattern Marc later called klobig in dashboard-layout-section. Visually correct but the height stretch is the wrong fix shape now; v1.4.33 maintainer-item-7 settled on `size="default" min-h-11 sm:min-h-9`.
- **Fix**: Adopt the responsive `min-h-11 sm:min-h-9` pattern consistently.

### L3 — `bugreport/page.tsx` and `medication-form` JSON import textarea inline-styled
- **Files**: `/Users/marc/Projects/HealthLog/src/app/bugreport/page.tsx:212`, `medications/page.tsx:475`, etc.
- **What's wrong**: Each textarea has its own copy-pasted className with the `text-base sm:text-sm` iOS-zoom defence. Maintained six places (audit grep shows three more inside form components). Drift risk.
- **Fix**: Introduce a `<Textarea>` primitive in `src/components/ui/textarea.tsx` (parallel to `<Input>`) that bakes in the defence + autocomplete defaults.

### L4 — `next/dynamic` loading skeletons miss `motion-reduce:animate-none` on insights page
- **File**: `/Users/marc/Projects/HealthLog/src/app/insights/page.tsx:43,55,67`
- **What's wrong**: `animate-pulse` without `motion-reduce:animate-none`. The chart skeleton primitives have it; the insights mother-page skeletons skipped it.
- **Fix**: Append `motion-reduce:animate-none` to all three.

### L5 — `tabIndex={0}` on `injection-site-picker.tsx:178`
- **File**: `/Users/marc/Projects/HealthLog/src/components/medications/injection-site-picker.tsx:178`
- **What's wrong**: Explicit `tabIndex={0}` on a `<div role="button">` is fine, but the element should be a `<button>` to inherit native semantics — easier than maintaining the keyboard handler manually.
- **Fix**: Use `<button type="button">` instead of `<div tabIndex={0} role="button">`.

### L6 — Recent-workouts tile placeholder + drug-level loading don't pre-reserve height
- **Files**: `RecentWorkoutsTile` (no reserved height during initial fetch), `medications/DrugLevelChart.tsx:235`
- **What's wrong**: Both render `<Loader2 spinner />` centered inside a `Card` without a reserved minimum height — content pops into place once data lands.
- **Fix**: Add `min-h-[X]` to the loading branch matching the loaded card's typical height.

---

## Strengths

- **Touch-target hygiene mostly green** — `Input.tsx` floors at 44 px on mobile (`h-11 sm:h-10`); `Button` icon variants documented and most call sites override correctly (settings drag-handles `size-11 sm:size-9`, medication-card `min-h-11 min-w-11`, coach-drawer header buttons `size-11`); bottom-nav primary + overflow pills correctly at 44 px each with safe-area-inset awareness.
- **iOS zoom defence** — `Input.tsx` defaults to `text-base md:text-sm`; coach-input textarea + bugreport textarea + side-effects textarea + admin-feedback textarea all explicitly pin `text-base` on mobile.
- **Safe area + viewport-fit** — `layout.tsx` sets `viewportFit: "cover"`; bottom-nav uses `pb-[env(safe-area-inset-bottom)]`; FAB sits at `bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)]`.
- **prefers-reduced-motion** — globals.css guards `.animate-insight-in` + `.pulse-dot`; ChartSkeleton notes the `motion-reduce` modifier; the `WelcomeCarousel` pattern is the gold standard for JS-driven scroll.
- **Per-tile Suspense fallbacks** — v1.4.41 W-FRONTEND-FACTORY layout-stable `min-h-[6rem]` placeholders are correct; ChartSkeleton mirrors loaded `<HealthChart>` height to within a pixel (`h-[var(--chart-height,…)]`).
- **Responsive grid track** — dashboard tile strip's `repeat(auto-fit, minmax(min(100%,11rem),1fr))` scales cleanly from 280 px (Galaxy Fold, 1 col) up to 1920 px (8 cols) without breakpoints.
- **Bottom-nav 5+More pattern** — well-thought-out compromise (4 core + Insights pill + overflow sheet); WCAG 2.5.5 floor honoured per-pill.
- **iOS-specific footgun coverage** — `inputMode` derivation in `Input.tsx`, `enterKeyHint` on coach-input, `autoCapitalize="sentences"` on free-text textareas, status-bar styling for PWA standalone.
