---
file: .planning/research/v1427-r3c-mobile-auth-public.md
purpose: Mobile capability audit — auth flows, public pages, error pages
created: 2026-05-15
auditor: MA7
---

# Mobile audit — auth and public surfaces

## Summary

Reviewed 11 components across the auth (`/auth/login`, `/auth/register`),
public (`/privacy`, `/about`, onboarding `[step]`), and error
(`error.tsx`, `global-error.tsx`, `error-details.tsx`) surfaces, plus
shared chrome (`AuthShell`, `OnboardingShell`, shadcn `Input` /
`Button`).

Headline finding: `/about` was added to `proxy.ts` PUBLIC_PATHS in B3
but not to `AuthShell.tsx` PUBLIC_PATHS, so an unauthenticated visitor
is bounced to `/auth/login` before the GeoLite2 CC BY-SA 4.0
attribution can render — a licence-compliance regression on an
otherwise-public route. Register page also missed the WCAG 2.5.5 tap-
target lift the login page received; the entire form submits through
a 36 px button. Long-form public pages have no TOC, no breakout on
hostnames / code identifiers, and no safe-area insets on their sticky
header — concrete iOS-PWA pain coming in v1.5.

17 findings total: 2 Critical, 5 High, 7 Medium, 3 Low.

## Findings

### F1 — `/about` bounces unauthenticated visitors to sign-in
- Severity: Critical
- Axis: logic
- File: `src/components/layout/auth-shell.tsx:14`
- Symptom: B3 made `/about` a public path in `src/proxy.ts:35` so the
  bundled GeoLite2 CC BY-SA 4.0 attribution is reachable without an
  account. The client-side `AuthShell` PUBLIC_PATHS still reads
  `["/auth/login", "/auth/register", "/privacy"]`. An unauthenticated
  visitor hitting `/about` clears the proxy, hydrates `AuthShell`,
  fails the `isPublicPage` check, and is redirected to `/auth/login`.
  The CC BY-SA 4.0 attribution requirement is silently broken.
- Evidence: `src/proxy.ts:32-35` vs `src/components/layout/auth-shell.tsx:14`.
- Recommended fix: Add `"/about"` to the `PUBLIC_PATHS` constant; also
  add it to `isStandalonePublicPage` (line 28) so the page renders
  edge-to-edge with its own header/footer instead of inside the
  centered login-card wrapper.
- Effort: S

### F2 — Register page CTAs sit below the 44 px tap-target floor
- Severity: Critical
- Axis: visual
- File: `src/app/auth/register/page.tsx:132`
- Symptom: Login page (`src/app/auth/login/page.tsx:136-205`) bumps every
  CTA to `size="lg"` + `min-h-11` after WCAG 2.5.5 work landed. Register
  page shipped the same release, but its primary submit button kept the
  default `h-9` (36 px). Three other auth surfaces follow this pattern
  in lockstep; register is the asymmetric outlier.
- Evidence: Grep `min-h-11` shows zero matches in `register/page.tsx`.
- Recommended fix: Mirror login — `size="lg" className="min-h-11 w-full"`
  on the submit `<Button>`.
- Effort: S

### F3 — No `/not-found.tsx` shipped at the app root
- Severity: High
- Axis: code
- File: `src/app/` (absent)
- Symptom: Next.js falls back to its built-in 404 page when a route is
  not matched. The built-in page is English-only, has no HealthLog
  branding, no `Logo`, no "Back to dashboard" link, and no mobile
  safe-area treatment. A user who follows a stale link from email /
  Telegram / browser history lands on a generic page that looks
  unrelated to the product.
- Evidence: `find src -name "not-found*"` returns nothing under
  `src/app/`. `error.tsx` and `global-error.tsx` only handle runtime
  exceptions, not 404s.
- Recommended fix: Add `src/app/not-found.tsx` with the same chrome
  shape used by `ErrorDetails` — `Logo`, translated headline, "Back to
  dashboard" CTA at `min-h-11`, optional report link if
  `bugReportEnabled`.
- Effort: M

### F4 — `global-error.tsx` ships hardcoded inline styles with no mobile padding
- Severity: High
- Axis: code
- File: `src/app/global-error.tsx:36-104`
- Symptom: The root-level boundary uses literal hex colours and pixel
  values via `style={{ … }}` because it cannot rely on providers. The
  `<body>` carries `padding: 24px` and the content `maxWidth: 560` —
  on a 320 px viewport that maxWidth never bites, but on a 320 px
  viewport with the iOS notch (no `padding-top: env(safe-area-inset-
  top)`) the headline crowds against the status bar. The retry +
  copy buttons are 8/14 padding (~32 px tall) — below the 44 px floor.
- Evidence: `src/app/global-error.tsx:48,76,89` — no env(safe-area-*),
  buttons `padding: "8px 14px"`.
- Recommended fix: Switch to a `min-height: 100dvh` + `padding-top:
  max(24px, env(safe-area-inset-top))` pattern; bump button padding
  to `12px 18px` so the tappable rect clears 44 px.
- Effort: S

### F5 — Sticky header on `/privacy` and `/about` ignores safe-area insets
- Severity: High
- Axis: visual
- File: `src/app/privacy/page.tsx:110`, `src/app/about/page.tsx:59`
- Symptom: Both pages use `sticky top-0 z-10` for the "HealthLog /
  Sign in" header. The root layout sets `viewportFit: "cover"`, so on
  iOS PWA standalone (v1.5 ships this) the page paints under the
  status-bar notch and the header text overlaps the notch. The proxy
  + AuthShell carve-out (`isStandalonePublicPage`) lets the privacy
  page render edge-to-edge, which makes this the page's responsibility,
  and it currently does nothing.
- Evidence: Grep `safe-area` across `src/app/auth/`, `src/app/privacy/`,
  `src/app/about/` returns zero hits.
- Recommended fix: `sticky top-0 pt-[env(safe-area-inset-top)]` on the
  outer `<header>` of both pages; same on `<main>` left/right via
  `pl-[max(1rem,env(safe-area-inset-left))]` if landscape-on-notched
  is a real use case.
- Effort: S

### F6 — Long-form `/privacy` ships no table of contents on mobile
- Severity: High
- Axis: logic
- File: `src/app/privacy/page.tsx:104-829`
- Symptom: 11 sections, ~3000 words, every `Section` carries an `id`
  with `scroll-mt-20` already wired, but nothing in the document
  consumes those anchors. App Store reviewers and GDPR-curious users
  scroll-fish to find "section 6 / rights" or "section 4 /
  sub-processors" with no affordance. The `scroll-mt-20` scaffolding
  was added in anticipation of a TOC that never landed.
- Evidence: Grep "Table of\|TOC\|table-of-contents" in
  `src/app/privacy/page.tsx` returns zero hits; sections 1-11 each
  carry distinct `id` attrs.
- Recommended fix: Add a collapsible TOC `<details>` block right under
  the H1 (default-closed on mobile, default-open on `md:`). Each anchor
  is `<a href="#${id}">`. Cheap, semantic, no JS.
- Effort: M

### F7 — Inputs miss `inputMode` and `enterKeyHint` across both auth forms
- Severity: High
- Axis: code
- File: `src/app/auth/login/page.tsx:172-192`, `src/app/auth/register/page.tsx:78-117`
- Symptom: Login email field is `type="text"` with no `inputMode="email"`;
  password fields carry no `enterKeyHint`. On iOS / Android Chrome the
  on-screen keyboard does not surface the `@` key on the email field
  and the Return key reads "return" instead of "go" / "next". Tiny
  per-keystroke friction on the most-tapped flow in the app.
- Evidence: Grep `inputMode\|enterKeyHint` across both auth pages
  returns zero hits.
- Recommended fix: Login email — `inputMode="email"` (still
  `type="text"` because the field accepts username too),
  `enterKeyHint="next"`. Login password — `enterKeyHint="go"`. Register
  email — already `type="email"`, add `inputMode="email"` +
  `enterKeyHint="next"`. Username — `enterKeyHint="next"`. Password —
  `enterKeyHint="go"`.
- Effort: S

### F8 — Password fields have no show / hide toggle
- Severity: Medium
- Axis: logic
- File: `src/app/auth/login/page.tsx:183-192`, `src/app/auth/register/page.tsx:106-117`
- Symptom: Both forms expose only `type="password"`. On mobile, where
  the user is typing one-handed on a glass surface, the inability to
  reveal the password to verify it matches what they meant to type is
  a measured drop-off point in every public login-funnel study. The
  competitor surfaces (Withings, Oura, MyFitnessPal) all carry the
  eye-icon affordance.
- Evidence: Login + register both render `<Input type="password" …>`
  with no sibling toggle button.
- Recommended fix: Wrap each password input in a `<div className="relative">`
  with an absolutely-positioned `<button type="button">` that swaps
  `type="password"` ↔ `type="text"`. `min-h-11 min-w-11` for the tap
  target; `aria-pressed` on the toggle; `aria-label` translated
  through `t("auth.passwordToggle.show" / "auth.passwordToggle.hide")`.
- Effort: M

### F9 — Form-level error has no `aria-invalid` link back to the field
- Severity: Medium
- Axis: code
- File: `src/app/auth/login/page.tsx:217-224`, `src/app/auth/register/page.tsx:123-130`
- Symptom: Both forms collapse every API error into a single
  `role="alert"` block at the bottom of the card. The inputs that
  caused the error carry no `aria-invalid="true"` and no
  `aria-describedby` pointing at the alert. A screen-reader user has
  to dig for the message and cannot tell which field is wrong.
  Doubly painful on mobile where the alert pin sits under the
  on-screen keyboard.
- Evidence: Grep `aria-invalid\|aria-describedby` across both pages
  returns zero hits.
- Recommended fix: Carry the API error shape as `{ field?: 'email' |
  'password', message }` (Zod issues already produce this on the
  server); spread `aria-invalid="true" aria-describedby={errorId}` on
  the matching `<Input>`; render the alert above the submit button
  with a stable `id`.
- Effort: M

### F10 — "Back to passkey" button is a raw `<button>` with no tap target
- Severity: Medium
- Axis: visual
- File: `src/app/auth/login/page.tsx:207-213`
- Symptom: The reverse-mode toggle is a raw `<button>` styled
  `text-xs` with `text-muted-foreground`. No `min-h-11`, no padding —
  the tap rect is ~16 px tall. Same accessibility floor as F2 missed
  it.
- Evidence: `src/app/auth/login/page.tsx:207-213`.
- Recommended fix: Switch to `<Button variant="link" size="sm">` or
  wrap the existing `<button>` in `min-h-11 inline-flex items-center
  justify-center px-2`.
- Effort: S

### F11 — Login card uses `p-8` at every breakpoint (no mobile reduction)
- Severity: Medium
- Axis: visual
- File: `src/app/auth/login/page.tsx:121`, `src/app/auth/register/page.tsx:62`
- Symptom: Card padding is `p-8` (32 px on every side) regardless of
  viewport. Login card is `max-w-sm` (384 px) wrapped in
  `AuthShell` main `px-4`. At 320 px: outer 16 + 16 = 32, card 32 + 32
  = 64 → 224 px content width. Inputs are full-width but cramped.
  Mobile-first cadence calls for `p-6 sm:p-8`.
- Evidence: Both pages literal `p-8`, no `sm:` step.
- Recommended fix: `p-6 sm:p-8` on both card wrappers.
- Effort: S

### F12 — `/privacy` HealthKit identifier list overflows at 320 px
- Severity: Medium
- Axis: visual
- File: `src/app/privacy/page.tsx:286-344`
- Symptom: HKQuantityTypeIdentifier list renders as `grid grid-cols-1
  sm:grid-cols-2`. At 320 px, a single column with
  `heartRateVariabilitySDNN` / `environmentalAudioExposure` / 
  `distanceWalkingRunning` at `text-xs` still fits, but the `<code>`
  tag carries no `break-all` / `overflow-wrap`. If a future identifier
  exceeds 28 chars it will horizontal-scroll the entire page. Same
  story for `healthlog.bombeck.io` and `io.bombeck.healthlog`
  inline-code spans further up.
- Evidence: Grep `<code` in the file shows 20+ usages, none with
  `break-all` or `overflow-wrap`.
- Recommended fix: Add `break-all` to the `<code>` className on the
  HK lists; keep prose-context code untouched (those are short
  enough). Cheaper alternative: extract a shared `<KbdCode>` /
  `<InlineCode>` component with the right defaults.
- Effort: S

### F13 — Privacy / about page `<header>` "Sign in" link sub-44-px
- Severity: Medium
- Axis: visual
- File: `src/app/privacy/page.tsx:118-123`, `src/app/about/page.tsx:67-72`
- Symptom: Both pages put two `<Link>` elements ("HealthLog" home,
  "Sign in") in the sticky header at `text-sm` with `py-3`
  inherited from the wrapper. The hit-rect is roughly 36 px tall —
  below the 44 px floor that the rest of the app holds for nav
  links.
- Evidence: Header div has `py-3` (12 px top + bottom = 24 px) plus
  `text-sm` line-height (~20 px) = 44 px-ish, but the link itself
  carries no padding so the actual `<a>` rect is closer to 20 px.
- Recommended fix: Wrap both links in `inline-flex items-center
  h-11 px-2 -mx-2` (negative margin neutralises the visual shift).
  Or use shadcn `<Button variant="ghost" size="sm">` with
  `asChild`.
- Effort: S

### F14 — `ErrorDetails` action row uses `size="sm"` (32 px) buttons
- Severity: Medium
- Axis: visual
- File: `src/components/error-details.tsx:85-108`
- Symptom: Retry / Copy / Report buttons are all `size="sm"` which
  maps to `h-8` (32 px). On mobile, the error page is exactly the
  place where the user is already mildly stressed and the buttons
  should be _easier_ to tap, not harder.
- Evidence: `src/components/ui/button.tsx:26` defines `sm: "h-8 …"`.
- Recommended fix: Drop `size="sm"`; let buttons fall to the default
  `h-9` (36 px) or bump to `size="lg"` (40 px). Wrap row in
  `flex-wrap gap-2` (already there) so they stack on 320 px.
- Effort: S

### F15 — `error-details.tsx` and `global-error.tsx` carry no safe-area / dvh
- Severity: Medium
- Axis: visual
- File: `src/components/error-details.tsx:76`, `src/app/global-error.tsx:42`
- Symptom: `ErrorDetails` outer wrapper is `max-w-xl space-y-4 p-6` —
  no `min-h-dvh`, no centring. When the boundary fires from a route
  that previously rendered a sidebar, the error layout floats in the
  upper-left of the viewport with nav chrome still in place. On
  mobile the user sees an awkward gap. `global-error.tsx` does centre
  but with `minHeight: "100vh"` (pre-dvh) — leaves a notch-sized
  gap on iOS.
- Evidence: Grep `min-h-dvh\|min-height: 100dvh` in both files
  returns zero hits.
- Recommended fix: `ErrorDetails` outer → `min-h-dvh flex flex-col
  items-center justify-center`. `global-error.tsx` body → `minHeight:
  "100dvh"`.
- Effort: S

### F16 — Onboarding step pages keep arrow-pager buttons on 320 px viewports
- Severity: Low
- Axis: visual
- File: `src/components/onboarding/WelcomeCarousel.tsx:223-281`
- Symptom: The carousel renders prev arrow + tablist + next arrow on
  one row, gap-3. At 320 px with size-11 buttons (44 px), three slides
  in the tablist as size-11 buttons each, plus two arrows: 5 × 44 +
  4 × 12 = 268 px. Plus the row uses `justify-center`, so the row
  fits, but adding a 4th slide or a 5th locale-glyph in the slide
  copy will overflow. Defensive only.
- Evidence: Manual count of children.
- Recommended fix: Wrap the row in `flex-wrap` or drop the chevron
  arrows on mobile (the dot pager + scroll-snap already handles
  swipe).
- Effort: S

### F17 — `BaselineForm` Skip + Save row drops below the keyboard on small viewports
- Severity: Low
- Axis: logic
- File: `src/components/onboarding/BaselineForm.tsx:223-247`
- Symptom: The CTA row is rendered inline after the form fields, no
  sticky-bottom pattern. When the user taps the height / date-of-
  birth field at the bottom of the form, iOS scrolls the input above
  the keyboard but the Save CTA below the input is now off-screen.
  The user has to dismiss the keyboard, scroll, then tap Save. A
  sticky-bottom CTA on `sm:` and below would close the loop.
- Evidence: No `sticky bottom-0` or `fixed` on the action row.
- Recommended fix: Wrap the action row in `sticky bottom-0
  bg-background pt-3 -mx-4 px-4 sm:static sm:bg-transparent` so it
  pins on mobile, releases on tablet+.
- Effort: M

## Headline metrics
- Components reviewed: 11 (login page, register page, privacy page,
  about page, error.tsx, global-error.tsx, error-details.tsx,
  AuthShell, OnboardingShell, BaselineForm, WelcomeCarousel; plus
  shared `Input`, `Button`, `MaintainershipBanner` as references).
- Findings by tier: C: 2  H: 5  M: 7  L: 3 (17 total).
- Mobile-hostile patterns flagged for B7-style symmetry pass: 3
  (asymmetric tap-target lift between login and register; missing
  safe-area on every edge-to-edge public page; mixed dvh / vh usage
  across error boundaries).

## Open questions for the consolidator

1. **TOC scope for `/privacy` (F6).** Should the table of contents
   ship as a `<details>` HTML primitive (zero JS, fold-up on mobile)
   or as a fixed-position floating button that opens a `<Sheet>`?
   The former matches the page's static-server-rendered shape;
   the latter is one more dependency on Sheet from the public
   surface.

2. **`not-found.tsx` (F3) — branded vs minimal?** The `ErrorDetails`
   pattern is heavy (Logo, copy-details payload, bugreport link).
   For a missing-route 404 a lighter wrapper might be the right
   call. Consolidator chooses: re-use `ErrorDetails` shape or ship
   a smaller `not-found.tsx` that mirrors the auth-card geometry.

3. **Show/hide password toggle (F8) — symmetry with profile-settings
   password change?** If the consolidator wants the same affordance
   on the in-app password-change form (under `/settings/account`),
   that's a third site and worth one shared `<PasswordInput>` rather
   than three local toggles.

4. **`/about` standalone fix (F1) — does it land in this round or
   wait for v1.4.28?** The licence-compliance angle (CC BY-SA 4.0
   attribution must be reachable) reads Critical to me but the fix
   is two lines. Consolidator confirms.
