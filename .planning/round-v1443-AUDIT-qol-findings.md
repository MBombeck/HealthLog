# v1.4.43 Quality-of-life audit findings

## Verdict
APPROVE_WITH_FIXES

Net assessment: the product has a strong empty-state + onboarding spine, layout-stable Suspense boundaries, and consistent shadcn primitives. The paper cuts that compound — Provider-jargon leaks into German UI, ungrammatical singular/plural strings, an unstyled English-only 404, the new v1.4.42 `persistent` integration state has no user surface, and a global-error chunk-load shows a sub-card error rather than the user-friendly "we'll reload" copy — are 1–4-line edits each. No regressions block v1.4.43, but six items would significantly cheapen the product's "feels rough" tax.

## Critical (must fix before tag)

None. No findings rise to release-blocker severity.

## High (should fix before tag)

### H1 — DayDrillDown error renders `measurements.saveError`, copy mismatch
- `src/components/measurements/measurement-list.tsx:1056-1060` — the per-day drill-down query's error branch surfaces `t("measurements.saveError")` ("Fehler beim Speichern" / "Save error") but the failing operation is a `GET`, not a save. Users see "Save error" when their step-history drill-down fails.
- Recommended: introduce `measurements.loadError` ("Fehler beim Laden" / "Could not load measurements") and route the catch-block through it. Affects EN + DE.
- Severity rationale: visible on every Apple-Health-heavy account that touches the cumulative-type chevron when the network falters. Cheap fix; copy bug, not architecture.

### H2 — "Provider" + "rate-limited" leak through German UI
- `messages/de.json:1136-1137`: `providerRateLimitTitle: "Provider rate-limited"`, `providerRateLimitBody: "Provider ist temporär überlastet; Reset in ~5 min."`. Both terms are English jargon in a German string.
- `messages/de.json:1062`: `errorProvider: "Der Coach konnte gerade keinen Auswertungs-Anbieter erreichen…"` — already migrated to "Anbieter"; the v1.4.25 rate-limit copy missed the same migration.
- `messages/de.json:1619`: settings AI section description `"Provider, Modell, API-Key."` — same.
- `messages/de.json:1757-1759`: `rawDataOnDescription`/`rawDataOffDescription`/`rawDataWarning` reference "Provider".
- Recommended: rename "Provider" → "Anbieter", "rate-limited" → "gedrosselt" or "temporär überlastet", "Reset" → "wieder verfügbar". Per the [Marc voice memo](feedback_marc_voice_english.md), no English jargon in German UI.
- Severity rationale: violates the Umlaute-required / German-UI-purity rule already pinned in user memory. Six-line copy edit.

### H3 — v1.4.42 `persistent` state has no user surface
- `src/lib/withings/response-classifier.ts:59` introduces a fourth `FailureKind`: `persistent` (for Withings rate-limit `601` / contract-mismatch `293/294`).
- `src/lib/integrations/status.ts:218-222` maps it to `state="error_transient"` in the DB — the user-facing column.
- `src/components/settings/integration-status-pill.tsx:117-136` collapses both `error_transient` and `error_reauth` to the same `"error"` pill label "Fehler — neu verbinden". A `persistent` failure (operator misconfig, contract mismatch) reads identically to a transient one.
- Recommended: either (a) plumb a third pill state `"warning"` for `persistent` so the user can see "Verbunden, aber Server liefert ungültige Daten" without telling them to reconnect — that's misleading because the access token still works, or (b) extend `IntegrationErrorMessage` to display `viewModel.failureKind` so a user can read "Withings antwortet mit Fehlercode 293 — bitte den Hosting-Operator kontaktieren". (a) is the v1.4.42-promised behaviour; the wave landed the classifier without the surface.
- Severity rationale: the whole point of the v1.4.42 classifier change was operator visibility; right now the operator gets the audit-log trail but the user still sees "reconnect" copy that won't fix the problem. A user clicking the reconnect link 10 times learns nothing.

### H4 — `not-found.tsx` is English-only
- `src/app/not-found.tsx:32-44`: hard-coded English strings ("Page not found", "The page you were looking for doesn't exist…", "Back to dashboard"). No `useTranslations()` call.
- Recommended: lift the four strings into `messages/{de,en,…}.json` under `errors.notFound.{title,body,backToDashboard}` and import `useTranslations` in the page. Page is now a client component anyway? — it's currently a server component, so the translation has to come via `getServerTranslations()` (the helper exists for the doctor-report PDF path; reuse it).
- Severity rationale: a logged-in German user landing on a typo'd URL sees only English. Self-evidently inconsistent.

### H5 — `global-error.tsx` is English-only
- `src/app/global-error.tsx:36-117`: by contract this fires when even the root layout fails (no i18n provider yet). The English-only design is intentional, but the copy "Something went wrong" / "A critical error occurred" reads cold to a German user already in a bad state.
- Recommended: bilingual lockup ("Etwas ist schiefgegangen / Something went wrong", "Ein kritischer Fehler ist aufgetreten / A critical error occurred"). 6 lines of static text, no runtime cost.
- Severity rationale: matches the same fix landed for the legacy 404 in v1.4.27 MB6. The boundary itself can't read context; the static fallback should be bilingual.

### H6 — `relativeMinutesAgo` / `relativeHoursAgo` / `relativeDaysAgo` have no singular form
- `messages/de.json:1140-1142` + `messages/en.json:1140-1142`: each "ago" key carries only the plural form. `formatRelativeTime` (`src/lib/i18n/relative-time.ts:20-24`) passes `count: 1` and the user reads "vor 1 Minuten" / "1 minutes ago" / "1 days ago".
- The same project did get this right for the stale-hint where the code threads `count === 1 ? "...One" : "...Other"` (`dashboard.staleHintWeeksOne` vs `staleHintWeeksOther`). The pattern needs to extend to the three remaining keys.
- The integration-status pill (`integrationPill.{minutes,hours,days}Ago`) lives separately and uses abbreviated units ("vor 1 min" / "vor 1 Std.") — abbreviated forms read OK at count=1, so the pill itself is fine.
- Recommended: split each into `…One` / `…Other`, update `formatRelativeTime` to branch on `count === 1`. Mirror across all six locales.
- Severity rationale: visible everywhere — hero strip "last update", daily briefing time-since-load, conversation history rail timestamps. Tiny grammar paper-cut, but pervasive.

## Medium (recommended for tag)

### M1 — Dashboard widget reorder via arrow buttons, not drag-and-drop
- `src/components/settings/dashboard-layout-section.tsx:320-343`: each widget row exposes ↑ / ↓ buttons to reorder. Modern UX expectation (Apple Health, Withings web) is drag-to-reorder.
- The current implementation is keyboard-accessible — which drag-and-drop libraries famously aren't without extra work — so the arrow-button approach has a legitimate a11y story.
- Recommended (defer-worthy but worth noting): if drag-to-reorder lands later, keep the arrow buttons as the accessible fallback. For v1.4.43 the only edit is a tooltip on each button explaining "Verschieben Sie diese Kachel nach oben/unten" instead of just the aria-label. The current aria-label "Nach oben" is short to the point of cryptic for first-time users.
- Severity rationale: not broken, just non-modern. Defer to v1.4.44 with intent.

### M2 — No user-facing AI Coach disable toggle
- `src/lib/feature-flags/index.ts:25,115`: `flags.coach` is server/admin-only via `getAssistantFlags()`. A user cannot disable the Coach for themselves; if the operator has enabled it globally, the FAB and drawer are everywhere.
- `messages/de.json:1539`: settings copy mentions a research-mode disable but no AI-coach disable.
- Recommended: add a per-user `disableCoach` toggle to `Settings → AI` with copy "Coach ausblenden". Defaults to off. The CoachFab + drawer mount guards on `flags.coach && !user.disableCoach`.
- Severity rationale: privacy-leaning users want this; it's also the answer to "I never use the Coach, why is it taking space on every screen?" The audit-scope brief explicitly listed this as a Settings-findability item.

### M3 — Account-section danger zone has no separate "Delete account" CTA
- `src/components/settings/advanced-section.tsx:240-321`: the danger zone "DELETE" button deletes all data (`/api/settings/data` DELETE) but leaves the account row alive (passkeys, profile, audit log). A user reading "Gefahrenzone" / "Danger Zone" expects "delete my account entirely" — what the button does is half that.
- Recommended: split into two destructive actions — "Alle Gesundheitsdaten löschen" (current behaviour) and "Konto vollständig löschen" (cascade-delete user). The copy currently says "deine Daten" without disambiguating; users have asked for the full-account-delete via the bug-report channel.
- Severity rationale: ambiguous destructive UX is a known compliance flag (GDPR Article 17 right to erasure). The current button is GDPR-compliant only if you read the copy carefully.

### M4 — Doctor-report unavailable sections vanish rather than show "no data"
- `src/components/doctor-report/doctor-report-dialog.tsx:305-307,549-563`: when a section has no data in the selected range, the toggle row is filtered out entirely. The user has no signal that "Compliance" was an option but is empty for this date range.
- Recommended: render the missing sections as a disabled toggle with strike-through copy + tooltip "Keine Daten in diesem Zeitraum". The user immediately understands why their report has 5 sections instead of 7 and what range to pick to get the 7th.
- Severity rationale: the doctor-report PDF is the flagship export. Silent omission is worse than explicit absence.

### M5 — No offline / network-error banner
- The PWA service worker (`public/sw.js:1-50`) caches the shell but there's no `navigator.onLine`-based "you're offline" banner. A user toggling airplane mode mid-form-fill sees blank tiles and no explanation.
- Recommended: a slim `<OfflineBanner>` mounted in `auth-shell.tsx` that listens for `online`/`offline` window events and renders "Keine Verbindung — Änderungen werden gespeichert, sobald du wieder online bist". The service worker can already serve the read paths; the banner closes the explanation gap.
- Severity rationale: progressive enhancement deferred; the PWA promises offline-friendly but the UX doesn't acknowledge offline. Low-cost to ship, high-comfort signal.

### M6 — Coach error copy "Provider rate-limited" not user-friendly
- `errorCodeToI18nKey` in `src/components/insights/coach-panel/message-thread.tsx:78-95` maps multiple distinct provider failures (`coach.provider.unavailable`, `coach.network`, `coach.stream`, `coach.provider.empty`) to one bucket (`insights.coach.errorProvider`). A user sees "Der Coach konnte gerade keinen Auswertungs-Anbieter erreichen" whether the network is dead, the provider is down, or their own connection is flaky.
- Recommended: split into `coach.network` → "Keine Internetverbindung — versuche es erneut, sobald du online bist" vs the others. Network errors are the user's problem and they need a different next action.
- Severity rationale: paper cut; a sophisticated user already infers from context, but a new user sees the same copy in three different failure modes.

### M7 — German integration pill uses "T." for "Tage" — confusing
- `messages/de.json:1896`: `daysAgo: "vor {count} T."`. The "T." abbreviation is non-standard and reads as a typo. Compare with the existing "Std." (Stunden) which is at least recognised shorthand.
- Recommended: either spell out "Tage" / "Tag" (with the singular fix from H6) or use the more conventional `d` (matches the rest of the app's `staleHint` `vor Xd` pattern).
- Severity rationale: minor copy inconsistency; nobody is confused for long but it reads cheap.

### M8 — Sub-locale users (fr/es/it/pl) get English number formats
- `src/lib/format.ts:21-32`: `activeLocale()` returns `'de' | 'en'` only. A French user reading the dashboard sees French strings but `formatDateTime` produces "12/24/2025, 2:30 PM" via the `en` fallback.
- The codebase has a parallel `useFormatters()` hook in `src/lib/i18n/context` that handles all locales correctly — `src/lib/format.ts` is the legacy path used by ~25 call sites (server-rendered SSR strings, audit-log helpers).
- Recommended: migrate `format.ts`'s `activeLocale` to read the full `Locale` union, with `Intl.DateTimeFormat` doing the heavy lifting. Fallback to `en` only when the cookie is unrecognised.
- Severity rationale: known fallback per the [Marathon docs](v1.4.38 multi-locale ship); v1.4.43 should close this since the non-maintained locales are growing.

## Low (defer to v1.4.44)

### L1 — `not-found.tsx` and `global-error.tsx` use static raw text instead of i18n keys
- Already covered as H4/H5 but parallel issue: even when localised, the messages are wordy ("The page you were looking for doesn't exist or has been moved.") Marc's voice memo says copy should be tight + professional; the current shape is consumer-app-marketing. Recommended: "Diese Seite existiert nicht." / "This page doesn't exist." period.

### L2 — Getting-started checklist measurement threshold = 1
- `src/lib/onboarding/checklist.ts` (referenced from `getting-started-checklist.tsx`) defines the measurement-completion threshold as `count >= 1`. The trend tile needs ≥5 measurements to draw, so a user clears the checklist's "first measurement" before they get visual reward on the dashboard. The "Eine Messung reicht, um deine erste Trend-Kachel zu zeichnen" copy in `messages/de.json:1510` is technically false — a single point can't draw a trend slope.
- Recommended: raise the bar to 3 or rewrite the description to "Ein Messpunkt reicht, um die Kachel zu aktivieren — der Trend zeichnet sich ab dem 5. Eintrag." Pick truth.

### L3 — `CACHE_VERSION = "v1.4.38.4"` literal stale in `public/sw.js:16`
- The literal hasn't bumped for the v1.4.39 → v1.4.42 chain. The `<VersionPoller>` self-heal still fires correctly because it reads `NEXT_PUBLIC_APP_VERSION` from the build env (line 38), but the SW cache key is now 4 releases stale, meaning the activate-step's old-cache eviction has been a no-op for four deploys.
- Recommended: replace with `const CACHE_VERSION = (self as any).__APP_VERSION__ || "v1.4.42";` and inject `__APP_VERSION__` via the SW build step. Documented self-heal pattern from v1.4.38.4 implies this was the intent.

### L4 — `/api/analytics` 9-second perf — user-visible UX impact
- Per the W-AUDIT-analytics-9s sibling finding: the thick `/api/analytics` query blocks the dashboard for ~9 s when the rollup-coverage probe misses. The dashboard does paint slim-slice tiles first (good!) but the BD-Zielbereich tile, glucose-by-context tile, and the correlations panel under `/insights` sit on a `ChartSkeleton` for 9 s with no progress signal.
- Recommended (UX-only, defer perf to W-AUDIT-analytics-9s): drop a "Auswertungen werden berechnet — das kann einen Moment dauern" caption inside the `ChartSkeleton` after 3 s. Today the skeleton just shimmers indefinitely. Sets user expectation.

### L5 — "Gefahrenzone" / "Danger Zone" branding is louder than the action warrants
- Current copy: red `AlertTriangle` + red title + red button. Twice as scary as the actual destructive action (which is already double-gated by a confirmation dialog). Compare with GitHub's danger-zone shaping, which uses neutral icon + red CTA only.
- Recommended: drop the AlertTriangle icon, render the title in neutral grey, keep the button red. Same protective gate, less visual hostility.

### L6 — Onboarding wizard "Welcome" carousel and tour both auto-launch
- `src/components/onboarding/WelcomeCarousel.tsx` + `src/components/onboarding/tour-launcher.tsx` both gate on different fields (`onboardingCompletedAt` for the carousel, `onboardingTourCompleted` for the tour). A user can finish the carousel and immediately get the tour. Both are valuable, but the chained flow takes ~90 seconds before the user gets to actually use the app.
- Recommended: gate the tour on `onboardingCompletedAt + 24h` so a new user gets the dashboard between the two onboarding flows. The tour becomes "the second-visit thing."

### L7 — `cancel`/`save` button order in `responsive-sheet` footer is not platform-conventional
- `src/components/measurements/measurement-list.tsx:940-965`: in the edit-measurement sheet, the visual order is `[…] Cancel  Save`. On iOS that's correct (Save is the rightmost confirmation); on Android the convention is the inverse. Since iOS is the primary mobile target, the current ordering is correct. Worth pinning in a comment so a future refactor doesn't "fix" it.

### L8 — `formatDateTime` everywhere; `formatRelativeTime` only inside Insights/Coach
- The measurement list (line 572, 717) renders absolute "21.05.2026, 14:32" timestamps; the daily-briefing renders "vor 12 min". Two formats for "when". The list-view absolute style is appropriate for accurate referencing, but the heading "Erfasst am 21.05.2026, 14:32" sits awkwardly next to "vor 3 min" on the same screen.
- Recommended: introduce a `formatDateOrRelative(iso)` helper — within 24h → relative, older → absolute. Defer to v1.4.44; not broken, just inconsistent.

## Strengths

S1. **Empty-state primitive (`empty-state.tsx`) is excellent.** Variants (`card` / `plain`), sizes (`default` / `compact`), CTA-floor enforcement at 44 px on mobile, `aria-live="polite"`, dashed-border affordance. The pattern is used consistently across 25+ call sites.

S2. **Empty-state copy is filter-aware.** `measurement-list.tsx:447-480` distinguishes "no measurements yet" from "no measurements match this filter" with a separate CTA to clear the filter. Few apps do this; HealthLog does.

S3. **Doctor-report dialog availability probe.** `doctor-report-dialog.tsx:165-250` re-probes `/api/doctor-report/availability` on every range change, paints a quiet skeleton-row loading state first, then either the toggle list or a "no data in range" empty-state. Genuinely well-designed.

S4. **Chart empty-state matches chart card height** (`chart-empty-state.tsx:46-49`) so the dashboard layout doesn't reflow when a chart enters/leaves the empty branch. This is the layout-stability paper-cut other apps trip over.

S5. **TrendCard's headline-arrow + 7-day-delta + comparison-caption all share one `getTrendSentiment` helper** (`trend-card.tsx:67-78`). Three signals route through one source of truth — no risk of green-arrow-next-to-orange-value desyncs.

S6. **Getting-started checklist is opt-out, collapsed by default, progress-meter-visible even when collapsed** (`getting-started-checklist.tsx:114-128, 380-408`). Marc's brief in v1.4.15 phase-A3 fix #3 explicitly noted the previous always-expanded layout as the dominant complaint; the current shape addresses it.

S7. **Integration status pill collapses meaningfully** — one chip with state-conditional colour + relative timestamp, mobile-safe with `whitespace-nowrap` and abbreviated time units. Replaces the v1.4.18 four-fold redundant status surface cleanly.

S8. **`<ResponsiveSheet>` primitive** (`responsive-sheet.tsx:64-90`) flips between bottom-Sheet on mobile and centred Dialog on desktop via the existing `useIsMobile()` hook. Footer sticky-pinning solves the "Save button hidden under iOS keyboard" paper-cut directly.

S9. **Stale-hint bucketing** (`trend-card.tsx:338-365`) — days under a week stay silent, 8–30 → "vor Xd", 31–60 → "vor X Wochen", >60 → "vor X Monaten", with proper one/other plural pairs. The pattern this audit wishes `relativeMinutesAgo` would adopt.

S10. **Coach `errorCodeToI18nKey`** centralises the server-emitted error-code → user-copy mapping in one helper (`message-thread.tsx:78-95`), exported for unit-test pinning. Distinct keys for daily-budget vs provider-rate-limit so users know whether resetting is on their side or the provider's.

S11. **AppError chunk-load auto-reload** (`src/app/error.tsx:35-52`) — sessionStorage-gated so a recoverable stale-shell error self-heals with one hidden reload instead of showing the user a scary error page. Marc's v1.4.38.3 paper-cut closed cleanly.

S12. **Skip-to-main-content link + ARIA-live error regions in forms** (e.g. `measurement-list.tsx:899-908`). The form's error banner is bound to the inputs via `aria-describedby` so screen readers announce the validation failure paired with the field. Most apps half-implement this; HealthLog gets it right.
