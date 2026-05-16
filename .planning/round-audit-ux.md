# UX + Accessibility Audit — 2026-05-16

## Executive summary

HealthLog's UX is in good shape on the surfaces that received recent
attention — the bottom nav meets WCAG 2.5.5, the responsive sheet
primitive is sound, the dashboard tile-strip's `auto-fit` grid is
elegant, and the v1.4.33/.34 follow-ups closed most of the rough
mobile edges. The strongest wins available are downstream of three
generic primitives leaking English (dialog/sheet "Close", chart
skeleton "Loading chart…") and one structural bug: the `?add=` deep
link the Insights empty states ship into `/measurements` uses tokens
the form's allow-list silently drops, so the CTA opens an unrelated
form (Blutdruck instead of Körpertemperatur). The worst latent pain
is on keyboard navigation: the bottom-nav strip and the mobile
top-bar user menu have no visible focus indicator at all, and four
non-German locales still ship 12+ English plural strings as
top-level surfaces.

## Findings — prioritized

### F-1: Insights empty-state CTA opens the wrong measurement form

**Severity**: high
**Scope**: insights, measurements
**File(s) / Surface**: `src/app/measurements/page.tsx:19-28`, `src/app/insights/koerpertemperatur/page.tsx:26`, `src/components/insights/healthkit-metric-page.tsx:105`
**What's wrong**: `ALLOWED_ADD_TYPES` on the measurements page accepts `"GLUCOSE"`, `"TEMPERATURE"`, `"HEART_RATE"`, `"BMI"` — none of which exist as `MEASUREMENT_TYPES` values in `measurement-form.tsx` (the canonical names are `BLOOD_GLUCOSE`, no temperature entry, `PULSE`, no BMI entry). At the same time `/insights/koerpertemperatur` emits `/measurements?add=BODY_TEMPERATURE`, also missing from the allow-list. Net effect: the link opens the page but `ALLOWED_ADD_TYPES.has(addParam)` returns false, `defaultType` stays undefined, the dialog still opens (because the surrounding branch sets `dialogOpen` only inside the `has()` block) — actually, the dialog stays closed for unknown types and the user lands on `/measurements` with no dialog at all. The empty-state CTA looks broken.
**Fix shape**: Replace `ALLOWED_ADD_TYPES` with a single source of truth derived from `MEASUREMENT_TYPES` (`MEASUREMENT_TYPES.map(t => t.value)`), plus a normalisation map that translates the legacy/Insights tokens (`GLUCOSE → BLOOD_GLUCOSE`, `TEMPERATURE → BODY_TEMPERATURE` and add a body-temperature row to the form, `HEART_RATE → PULSE`, `BMI → WEIGHT`). Add a unit test that walks every `emptyStateCtaType` referenced under `src/app/insights/**` and asserts it resolves to a real form type.
**Effort**: small `[hotfix-ready]`

### F-2: Dialog/Sheet close-X labels are English-only

**Severity**: high
**Scope**: global
**File(s) / Surface**: `src/components/ui/dialog.tsx:87`, `src/components/ui/sheet.tsx:89`
**What's wrong**: Both primitives ship `<span className="sr-only">Close</span>` as the only accessible name on the icon-only close button. A screen-reader user on the German app hears "Close, button" on every modal and every quick-entry sheet. The i18n key `common.close` already exists in every locale (`messages/de.json:9 → "Schließen"`).
**Fix shape**: Inject the label as a prop or read it from the i18n context at the call site (the primitives are client components already, so `useTranslations()` is a one-line lift). Same fix in both files. Add an ESLint rule or test that forbids literal English inside `<span className="sr-only">` outside locale files.
**Effort**: trivial `[hotfix-ready]`

### F-3: Bottom-nav primary links have no visible focus indicator

**Severity**: high
**Scope**: global (mobile)
**File(s) / Surface**: `src/components/layout/bottom-nav.tsx:102-107`, `src/components/layout/top-bar.tsx:67`
**What's wrong**: The five primary bottom-nav links and the "More" overflow button rely on a `transition-colors` between `text-muted-foreground` and `text-primary` — no `focus-visible:ring-*` and no underline. Keyboard / switch-control users tabbing through the bar see no focus at all. Same problem on the mobile top-bar user menu: it explicitly carries `focus:outline-none` without a `focus-visible:` replacement. The sidebar got `focus-visible:ring-[3px]` in v1.4.33; the mobile navs missed it.
**Fix shape**: Append `focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-offset-2` to the bottom-nav `<Link>` / overflow-button className and the top-bar trigger. The ring radius matches the sidebar treatment; no design-token change needed.
**Effort**: trivial `[hotfix-ready]`

### F-4: Five locales ship English plural strings as surface copy

**Severity**: high
**Scope**: global (i18n)
**File(s) / Surface**: `messages/es.json`, `messages/fr.json`, `messages/it.json`, `messages/pl.json` (lines 345, 379, 428–429, 437, 1106–1108, 1216, 1492, 953, 1194)
**What's wrong**: 12+ count-bearing strings carry the English source text in es / fr / it / pl. The user-visible offenders include `measurementCount`, `entryCount`, `importDuplicatesSkipped`, `importInvalidSkipped`, `apiTokenCount`, `relativeMinutesAgo`, `relativeHoursAgo`, `relativeDaysAgo`, `dayStreak`, `remainingMany`, `headlineCaption`, `provisional`. Polish additionally folds `_few` / `_many` / `_one` plural buckets into a single `_other` key — Polish "1 tydzień / 2 tygodnie / 5 tygodni" cannot be expressed by a single string. Today the app renders "5 tygodni temu" via a single hardcoded fallback regardless of count.
**Fix shape**: (a) translate the 12 leaked strings in each locale (machine-pre-fill is acceptable for the first pass), (b) extend the i18n primitive to read CLDR plural categories via `Intl.PluralRules(locale).select(n)` and add per-locale `_one` / `_few` / `_many` / `_other` keys for the four count strings that appear in long form. Add a CI grep that fails the build if any non-English locale file contains the literal " skipped" / " ago" / " more" / " readings" / " measurements" / " entries" substring.
**Effort**: medium

### F-5: Chart skeleton ships an English-only sr-only loading announcement

**Severity**: medium
**Scope**: global (charts)
**File(s) / Surface**: `src/components/charts/chart-skeleton.tsx:41`
**What's wrong**: Every chart (dashboard, /insights, every sub-page, mood, BD compliance) mounts behind this skeleton during the lazy chunk fetch. The sr-only announcement reads "Loading chart…" in every locale. Same root cause as F-2 — locale-aware primitives that fall back to literal English.
**Fix shape**: Lift `useTranslations()` into `<ChartSkeleton>` and read `charts.loadingLabel` (add the key to each locale). The component is already `"use client"` so the lift is free. The `aria-live="polite"` + `aria-busy="true"` machinery stays as-is.
**Effort**: trivial `[hotfix-ready]`

### F-6: Recharts charts have no accessible name or text alternative

**Severity**: medium
**Scope**: global (charts)
**File(s) / Surface**: `src/components/charts/health-chart.tsx:1278-1280`, every `<MoodChart>` / `<MedicationComplianceChart>` mount
**What's wrong**: The chart container is a bare `<div>` wrapping a Recharts `<ResponsiveContainer>`. There is no `role="img"`, no `aria-label`, no `aria-describedby` pointing at the chart title above it, and no fallback `<figcaption>` summarising the trend. A screen-reader user lands on the chart and hears nothing — the title above the chart and the SVG are unrelated for AT purposes. WCAG 1.1.1 (non-text content) requires either a text alternative or a sibling description.
**Fix shape**: Wrap the `<ResponsiveContainer>` in `<figure role="group" aria-labelledby={titleId} aria-describedby={summaryId}>`, hoist the existing title `<h3>` to own the `id={titleId}`, and synthesise an sr-only `<figcaption id={summaryId}>` from the existing `DataSummary` (latest, avg30, slope direction, target-band hit / miss) — the data is already in scope. The visual chart stays byte-identical. Same shape on `<MoodChart>` and `<MedicationComplianceChart>`.
**Effort**: medium

### F-7: Inputs sit at 40 px, below the WCAG 2.5.5 44 px floor on mobile

**Severity**: medium
**Scope**: forms (global)
**File(s) / Surface**: `src/components/ui/input.tsx:70`, `src/components/ui/native-select.tsx:39`, `src/components/ui/select.tsx:40`
**What's wrong**: The `Input` and both `Select` primitives lock `h-10` (40 CSS px) across every breakpoint. The button primitive grew a responsive `min-h-11 sm:min-h-9` pattern in v1.4.33 to hit the floor on mobile and shrink on desktop; the inputs never received the same treatment. The measurement form on a Pixel-5 viewport (375 px) puts the numeric value field, the datetime field, the glucose-context select, and the notes field at 40 px each — every one is a Lighthouse target-size failure.
**Fix shape**: Switch the base to `h-11 sm:h-10` (or `min-h-11 sm:min-h-10`) on `Input`, `Select` trigger, and `NativeSelect`. Audit `<DateTimeInput>` (`src/components/ui/date-input.tsx`) for the same fix. Optionally introduce a `size="sm"` variant for filter chips that explicitly opts out.
**Effort**: small `[hotfix-ready]`

### F-8: Admin mobile chip strip skips the auto-scroll-into-view treatment

**Severity**: medium
**Scope**: admin
**File(s) / Surface**: `src/components/admin/admin-shell.tsx:173-219`
**What's wrong**: The settings shell received `snap-x snap-mandatory` + a `scrollIntoView({inline: "center"})` effect in v1.4.33 IW4/IW7 so the active chip stays in view on route change. The admin shell shipped 13 chips and got neither — admins who tap a chip past the right edge land on the new page with the strip still scrolled to the left, and the active chip lives off-screen. Same UX-broken-feeling regression the settings shell had before v1.4.33.
**Fix shape**: Copy the settings-shell pattern verbatim — `ref` + `useEffect` selecting `[aria-current="page"]` + `scrollIntoView({block: "nearest", inline: "center", behavior: "smooth"})`, plus `snap-x snap-mandatory` on the `<nav>` and `snap-start` on each `<li>`.
**Effort**: trivial `[hotfix-ready]`

### F-9: List page subtitles hidden on `<sm` give mobile users no orientation

**Severity**: low
**Scope**: measurements, mood, medications
**File(s) / Surface**: `src/app/measurements/page.tsx:85`, `src/app/mood/page.tsx:45`, `src/app/medications/page.tsx:157`
**What's wrong**: Every list page hides its descriptive subtitle on `<sm` (`hidden text-sm sm:block`). Mobile users see only the H1 — "Messungen", "Stimmung", "Medikamente" — with no explanatory frame. The descriptions exist in every locale and the row above already gives the H1 plenty of horizontal slack. Comparison apps (Apple Health, Withings) keep the subtitle on mobile because the description doubles as the page's contextual help.
**Fix shape**: Drop the `hidden sm:block` and let the subtitle wrap. Optionally shrink to `text-xs` on `<sm` so the H1 still anchors the visual.
**Effort**: trivial `[hotfix-ready]`

### F-10: Hardcoded "Breadcrumb" aria-label in the notifications-settings section

**Severity**: low
**Scope**: settings
**File(s) / Surface**: `src/components/settings/notifications-section.tsx:49`
**What's wrong**: `<nav aria-label="Breadcrumb">` is announced verbatim — a German screen-reader user hears "Breadcrumb, navigation". Every other breadcrumb in the app routes the label through `t(…)`.
**Fix shape**: Replace with `aria-label={t("nav.breadcrumb")}` and add the key (`"Brotkrumen-Navigation"` / `"Breadcrumb navigation"`).
**Effort**: trivial `[hotfix-ready]`

### F-11: Dashboard Coach surface — drawer still reachable but discoverability degraded

**Severity**: informational
**Scope**: dashboard, insights
**File(s) / Surface**: `src/app/page.tsx` (Coach CTA removed v1.4.34.3), `src/app/insights/layout.tsx:39`
**What's wrong**: The dashboard CTA was removed for valid reasons (visually loud, wrong placement). The Coach is still reachable: hero-strip "Ask the coach" button on `/insights`, `<LayoutCoachFab>` on `<lg` viewports across `/insights/**`, per-page `<CoachLaunchButton>` instances, and the `<CoachLaunchProvider>` stays mounted at the auth-shell level. On `lg+` (desktop) the FAB is hidden by `lg:hidden`, so a desktop user who isn't on `/insights` has no entry point at all (the dashboard has none, the sidebar has none). The hero strip is the only desktop discovery surface.
**Fix shape**: Either accept the constraint (Coach is a per-feature affordance, not a global one — current state) or surface a single sidebar entry under "Coach" so the desktop user can launch the drawer without a route hop. I'd leave it alone for v1.4.34.x and re-evaluate when the Coach feature flag stabilises.
**Effort**: small (if pursued); no action needed right now

## Out of scope / accepted constraints

- **Recharts stays.** No replacement library considered; the audit
  treats the existing chart visual identity as a fixed contract per
  the memory directive `feedback_charts_visual_identity.md`.
- **Settings shelf depth.** The 9-section list with the mobile
  horizontal-scroll chip strip + the v1.4.33 auto-scroll-into-view
  effect lands in a good place; the per-provider AI-section is
  already dropdown-driven per the memory directive.
- **Comparison-overlay caption on tiles.** `<TrendCard>` already
  paints `Δ {value} {unit} vs. last month/year` with `aria-label`
  parity and the slot has the v1.4.33 `min-h-[18px]` reservation.
  No issue found.
- **Stale-data caption on tiles.** v1.4.34 IW-B's bucket-aware
  copy reads naturally in DE and the integration test asserts the
  forwarding contract; deferred unless a real user reports a bucket
  bug.

## What you didn't get to

- A keyboard-only run through the `/insights/medikamente` sub-page
  + therapy timeline (the timeline uses an `sr-only h2` per
  `therapy-timeline.tsx:121` — that's the right pattern but the
  surrounding focus order wasn't traced).
- An RTL / Arabic dry run; the i18n stack is six locales LTR only,
  so RTL is genuinely deferred until the locale set grows.
- The bug-report and notifications inbox surfaces beyond their
  shells; the bug-report form was not traced for validation /
  empty-state quality.
- A real Lighthouse run against `healthlog.bombeck.io` — the
  audit is grep-driven against the source tree; the live CWV
  numbers (especially CLS during chart hydration) would
  cross-check whether the F-6 + F-7 fixes shift Lighthouse score.
