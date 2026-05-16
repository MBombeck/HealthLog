# Mobile-Deep Audit — 2026-05-16

## Executive summary

The mobile contract is largely solid where attention has been paid —
bottom-nav respects safe-area insets, dashboard tiles wrap correctly
at every breakpoint, and the `<ResponsiveSheet>` primitive flips
between Sheet and Dialog by viewport. Five structural gaps remain.
The sticky `<TopBar>` ignores the iOS top safe-area inset, so PWA
installs on notched devices get the logo clipped under the status
bar. Five raw `<DialogContent>` mounts (intake import, doctor report,
password change, app-log preview, side-effects) never went through
the v1.4.27 Sheet branch, so phone users land on a centred desktop
dialog instead of a bottom sheet. The Coach FAB at `bottom-20`
overlaps the bottom-nav once iPhone safe-area adds 34 px. Coach,
bug-report, and feedback textareas ship `text-sm` (14 px), which
triggers iOS Safari's zoom-on-focus quirk. Sonner is hardcoded
`theme="dark"` while the rest of the app supports light mode, and
its `bottom-right` position sits under the bottom-nav on phones.

## Findings — prioritized

### F-1: `<TopBar>` ignores the iOS top safe-area inset

**Severity**: high
**Surface**: global
**Viewport**: `<sm` (PWA install on notched iPhone)
**File(s)**: `src/components/layout/top-bar.tsx:47`, `src/app/layout.tsx:44-48`
**What's wrong**: `appleWebApp.statusBarStyle = "black-translucent"` makes
the iOS status bar overlay the app, but the sticky header only sets
`top-0 z-40 h-16` — no `pt-[env(safe-area-inset-top)]`. Once the app
runs in standalone mode on iPhone X+ the 64 px header pulls under the
status bar / notch; the logo and the mobile user-menu trigger get
clipped. The bottom-nav handles `env(safe-area-inset-bottom)`
correctly, so the asymmetry is the bar that needs the same treatment.
The standalone public pages (`/about`, `/privacy`) already render
their own header with the inset; the main shell missed it.
**Fix shape**: Add `pt-[env(safe-area-inset-top)] h-[calc(4rem+env(safe-area-inset-top))]`
to the `<header>` and raise the inner row to `h-16` separately, OR
switch the page-shell `<main>` to a top padding that mirrors the
bottom-nav contract. Verify the maintainership banner above the bar
respects the same inset.
**Effort**: small `[hotfix-ready]`

### F-2: Static `themeColor` doesn't track light mode

**Severity**: high
**Surface**: global
**Viewport**: all (iOS Safari + Android Chrome)
**File(s)**: `src/app/layout.tsx:70`, `public/manifest.json:7-8`
**What's wrong**: Both surfaces hardcode `#282a36` (Dracula dark
background) as the theme-color. Light-mode users (Alucard palette,
`#f5f5f5` background) get a near-black Android address bar and an
iOS PWA status-bar background that doesn't match the page. The
theme toggle ships three modes (system / dark / light); the
chrome-colour signal never follows.
**Fix shape**: Replace the static `themeColor` with the Next 13+
array form: `themeColor: [{ media: "(prefers-color-scheme: light)",
color: "#f5f5f5" }, { media: "(prefers-color-scheme: dark)", color:
"#282a36" }]`. Manifest can carry only one — keep the dark one as
the default but document the trade-off. Optionally write a tiny
client effect that updates `<meta name="theme-color">` when the user
flips themes manually.
**Effort**: trivial `[hotfix-ready]`

### F-3: Five raw `<DialogContent>` mounts skip the Sheet branch

**Severity**: high
**Surface**: medications, settings, admin, global (doctor report)
**Viewport**: `<sm`
**File(s)**: `src/app/medications/page.tsx:430` (intake import), `src/app/medications/page.tsx:687` (also intake variant), `src/components/settings/account-section.tsx:612` (password change), `src/components/admin/app-log-preview-section.tsx:279`, `src/components/doctor-report/doctor-report-dialog.tsx:371`
**What's wrong**: The `<ResponsiveSheet>` primitive was added in
v1.4.27 MB1 precisely so these surfaces would slide up from the
bottom on phones. Five mount sites still call `<Dialog>` +
`<DialogContent>` directly, so on a 375 px viewport the user gets a
centred modal capped at `calc(100% - 2rem)` with the close-X pushed
into the corner. Doctor-report is the worst offender — it carries a
multi-row date-range form + a comment textarea, and the body
overflows the dialog's `max-h-[calc(100dvh-2rem)]` so the form
scrolls inside a desktop card instead of feeling like a sheet.
**Fix shape**: Migrate every site to `<ResponsiveSheet>`. The body
markup stays identical; replace the `<Dialog>` + `<DialogContent>` +
`<DialogHeader>` + `<DialogFooter>` pairs with the sheet primitive's
`title` / `description` / `footer` slots. The Sheet branch already
takes the `90dvh` cap and sticky footer for free.
**Effort**: small (each site) / medium (all five) `[hotfix-ready]`

### F-4: Coach FAB overlaps the bottom-nav on notched iPhones

**Severity**: high
**Surface**: insights
**Viewport**: `<sm` (iPhone X+ PWA)
**File(s)**: `src/components/insights/layout-coach-fab.tsx:64`
**What's wrong**: The FAB sits at `bottom-20` (80 px) and the
bottom-nav reports `min-h-16 pb-[env(safe-area-inset-bottom)]` =
64 + 34 = 98 px on iPhone 13+. The FAB lands 18 px inside the bar,
visually colliding with the More icon. Tap target is technically
fine because the FAB sits at `z-40` under the nav's `z-50`, but the
bottom rim of the gradient pill clips behind the nav strip — looks
broken on a Dracula-dark bar against a Dracula-pink pill.
**Fix shape**: Promote `bottom-20` to
`bottom-[calc(5rem+env(safe-area-inset-bottom))]` so the FAB
reserves the same inset the nav does. Verify on landscape Android
where the safe-area is zero — the calc collapses to the original
80 px.
**Effort**: trivial `[hotfix-ready]`

### F-5: Three textareas trigger iOS Safari zoom-on-focus

**Severity**: high
**Surface**: insights (Coach), bug report, admin (feedback inbox), medications, side-effects
**Viewport**: `<sm` (iOS Safari only)
**File(s)**: `src/components/insights/coach-panel/coach-input.tsx:211`, `src/app/bugreport/page.tsx:210`, `src/components/admin/feedback-inbox-section.tsx:497-510`, `src/app/medications/page.tsx:462-475`, `src/components/medications/SideEffectsSection.tsx:467-480`
**What's wrong**: iOS Safari auto-zooms to 16 px whenever a focused
`<input>` or `<textarea>` carries a font-size below 16 px. The
`<Input>` primitive (`text-base md:text-sm`) avoids the zoom; every
raw `<textarea>` in the app ships `text-sm` (14 px). The Coach
input is the worst case — the drawer takes 90 dvh, the keyboard
opens, the textarea zooms, and the user has to pinch back out before
they can keep typing. There is no `<Textarea>` primitive that
solves this once for everyone.
**Fix shape**: Introduce `src/components/ui/textarea.tsx` mirroring
`<Input>`'s `text-base md:text-sm` font policy + the same focus
ring / aria-invalid contract. Replace the five raw `<textarea>` call
sites. While there: verify Coach drawer doesn't shrink behind the
visualViewport when the iOS keyboard opens — `message-thread.tsx`
already wires `visualViewport.resize`, the input row should follow.
**Effort**: small `[hotfix-ready]`

### F-6: Sonner toast hardcoded dark + bottom-right collides with bottom-nav

**Severity**: high
**Surface**: global
**Viewport**: `<sm` (mobile)
**File(s)**: `src/components/ui/sonner.tsx:15`, `src/components/providers.tsx:132`
**What's wrong**: The Toaster wrapper sets `theme="dark"` regardless
of the user's theme preference — light-mode users see a black toast
with white text against a white card, which reads inverted. The
provider mounts it at `position="bottom-right"`, which on a 375 px
viewport overlaps the bottom-nav (`z-50`). Sonner's default
`z-index` is high enough that the toast can paint on top of the nav
strip, but the visual layout still looks broken because the toast
covers the Medications icon.
**Fix shape**: Read the live theme from the existing `useTheme()`
context and feed it as `theme={theme === "system" ? "system" :
theme}` (sonner accepts `"system"`). Lift position to
`top-center` on `<md` (using a `useIsMobile()` switch) and keep
`bottom-right` on desktop; or hold `bottom-center` everywhere and
add `mb-[calc(4rem+env(safe-area-inset-bottom))]` via `toastOptions`
so it sits above the bar. Mark the toaster region with
`aria-live="polite"` if sonner's default does not already.
**Effort**: small `[hotfix-ready]`

### F-7: SheetHeader has no `pr-` reservation for the close-X

**Severity**: medium
**Surface**: global
**Viewport**: `<sm` (long localised titles)
**File(s)**: `src/components/ui/sheet.tsx:97-104`
**What's wrong**: `<DialogHeader>` carries `pr-9` so the title never
runs under the close-X. `<SheetHeader>` only carries `p-4`. With a
long German / Polish title (e.g. settings sub-flows), the title runs
right up to — or under — the absolutely-positioned close button
sitting at `top-3 right-4 min-h-9 min-w-9`. The bottom-sheet variant
`<ResponsiveSheet>` patches over this with its own `p-4 pr-12`
override (`src/components/ui/responsive-sheet.tsx:123`), but every
direct `<Sheet>` consumer skips that fix.
**Fix shape**: Add `pr-12` (matches the close-X 36 px footprint +
breathing room) to the `<SheetHeader>` className. Audit direct
consumers — bottom-nav More sheet, Coach drawer, Coach settings
sheet — to make sure the override doesn't clip an intentional
header layout.
**Effort**: trivial `[hotfix-ready]`

### F-8: `useIsMobile` returns `false` for one frame on phone-class SSR

**Severity**: medium
**Surface**: global (ResponsiveSheet, Coach drawer)
**Viewport**: `<md`
**File(s)**: `src/hooks/use-is-mobile.ts:58-60`
**What's wrong**: `getServerSnapshot()` is pinned to `false` (already
documented at the top of the file). That's fine for the documented
"sheet only opens on user gesture" case, but the deep-link / `?add=`
flows on `/measurements`, `/mood`, `/medications` open the form
modal during the first paint via a `useEffect` triggered by the
search param. On a phone viewport, the desktop Dialog branch
flickers for the first commit before flipping to the bottom Sheet —
input focus is lost and the cancel button repaints. The flash is
brief but visible on Pixel-5-class hardware.
**Fix shape**: Pass the viewport hint down via a server-rendered
cookie set by the proxy / middleware (matching the locale cookie
strategy), and read it in the hook to seed the initial value. OR
gate the auto-open behind an extra paint tick so the second render
already has the correct branch.
**Effort**: medium

### F-9: `max-h-[80vh]` instead of `dvh` on two surfaces

**Severity**: medium
**Surface**: admin (app log preview), onboarding (tour tooltip)
**Viewport**: `<sm` (iOS Safari)
**File(s)**: `src/components/admin/app-log-preview-section.tsx:279`, `src/components/onboarding/tour.tsx:485`
**What's wrong**: Both surfaces cap at `80vh`. iOS Safari's `vh` is
the *expanded* viewport height (no chrome subtracted), so 80 vh on a
390 × 844 iPhone equals ~675 px while the actually-visible viewport
when the address bar is shown is closer to 720 px. The dialog
contents (especially the tour tooltip, which is then `absolute`
positioned and meant to point at a UI element) can overflow under
the address bar. Every other modal in the app already uses `dvh`
(coach drawer, ResponsiveSheet, DialogContent default).
**Fix shape**: Replace both with `max-h-[80dvh]` (or `max-h-[90dvh]`
to match the bottom-sheet convention). One-character change.
**Effort**: trivial `[hotfix-ready]`

### F-10: No "Add to Home Screen" prompt or affordance

**Severity**: medium
**Surface**: global (PWA install)
**Viewport**: all
**File(s)**: `src/components/providers.tsx` (handler absent), `public/manifest.json` (Android-only), `src/app/layout.tsx` (no apple-touch-icon link)
**What's wrong**: The app ships a manifest + service worker, but
nothing in the code listens for `beforeinstallprompt` on Android /
Edge, and there is no in-app "Add to Home Screen" affordance for
iOS Safari (which doesn't fire the event at all — the user has to
discover the share-sheet flow themselves). For a self-hosted health
PWA the install rate without a prompt is near-zero. The metadata
sets `appleWebApp.capable = true` and `apple-touch-icon` is exposed
via `metadata.icons.apple = "/logo-192.png"`, but PWA discoverability
is otherwise zero.
**Fix shape**: Add `usePwaInstallPrompt()` hook that captures the
`BeforeInstallPromptEvent` once and exposes a `install()` method.
Surface a small "Install app" entry inside the top-bar user-menu on
mobile (only when the deferred prompt is captured). For iOS Safari,
detect `standalone === false` + `userAgent` Mobile Safari and show a
once-per-week toast with the share-sheet diagram. Both gated on the
"Add to Home Screen" cookie so the user can dismiss permanently.
**Effort**: medium

### F-11: Default button size (h-10 = 40 px) misses WCAG 2.5.5 on mobile

**Severity**: medium
**Surface**: forms, settings, admin (148 small-size button usages)
**Viewport**: `<sm`
**File(s)**: `src/components/ui/button.tsx:49`, `src/components/ui/button.tsx:53` (icon variant), 148 call sites for `size="sm"` / `size="icon-sm"`
**What's wrong**: The button primitive defines `default = h-10`
(40 px) and `icon = size-10`, both 4 px below WCAG 2.5.5 (44 × 44).
F-7 in the prior UX audit calls out Input / Select; the same
problem lives on the Button primitive that those forms use for their
Save / Cancel rows. The dashboard quick-add CTA uses an explicit
`min-h-11 sm:min-h-9` override because its own audit caught the gap;
nothing else does. `size="sm"` (32 px) and `size="icon-sm"` (32 px)
are below the floor by 12 px — they appear 148 times in source.
**Fix shape**: Either bump the base `default` and `icon` to
`h-11 sm:h-10` / `size-11 sm:size-10` so every consumer inherits the
mobile floor, or formalise the `min-h-11 sm:min-h-9` pattern as a
`mobile-floor` size variant and migrate the high-traffic call sites
(form footers, list-row delete-confirm, settings primary CTAs).
**Effort**: medium

### F-12: Mood radio buttons can collapse below 44 px on narrow phones

**Severity**: medium
**Surface**: mood
**Viewport**: `<sm` (320 px Galaxy Fold first screen)
**File(s)**: `src/components/mood/mood-form.tsx:192-209`
**What's wrong**: The five mood radio buttons render in a 5-column
grid with `p-2` (8 px each side) and no `min-h` floor. The visible
height is `text-lg` (28 px) + label + padding ≈ 56 px on default
font scaling, but on a 320 px viewport with Dynamic Type bumped one
notch the buttons can flatten under 44 px tall. The grid is also
the primary action of the entire form — getting it wrong feels
worse than a peripheral control.
**Fix shape**: Add `min-h-16` (or `min-h-[3.75rem]`) and a
`grid-cols-5 sm:grid-cols-5` (or fall to two rows of 3 + 2 on
`<sm`) to guarantee the tap target. The radio role / aria-checked
semantics stay.
**Effort**: trivial `[hotfix-ready]`

### F-13: Compliance heatmap cells fall to 14 px (below tap target)

**Severity**: low
**Surface**: medications (compliance heatmap)
**Viewport**: `<sm`
**File(s)**: `src/components/charts/compliance-heatmap.tsx:230-237`
**What's wrong**: `stretch=true` heatmaps clamp to `CELL_FLOOR_PX`
(14 px) on narrow viewports — far below the 44 px floor. Each cell
is a tappable surface (tap-to-pin tooltip) per the `onPointerDown`
handler. WCAG 2.5.5 has an explicit exception for "inline content"
which arguably applies to a calendar heatmap cell, but the
tap-to-pin behaviour makes the heatmap an interactive primary
control on mobile. Users have to thumb-zoom to read a single day.
**Fix shape**: Either drop the tap-to-pin affordance on `<sm` and
hand the heatmap to a tap-to-open detail sheet (one tap anywhere on
the row → bottom-sheet listing every day in the row), OR enlarge
the floor to 24 px on `<sm` and accept the horizontal scroll. The
detail-sheet route is the iOS-native pattern.
**Effort**: medium

### F-14: No pull-to-refresh, swipe-to-delete, or long-press menu

**Severity**: low (informational)
**Surface**: measurements, mood, medications (lists), dashboard
**Viewport**: `<sm`
**File(s)**: every list component (none implements these)
**What's wrong**: HealthLog mobile lists are static — no
`pull-to-refresh` to re-fetch the latest measurement, no
swipe-left-to-delete on rows, no long-press to context-menu. Users
arriving from Apple Health / Withings expect at least pull-to-refresh
(the tab is data-heavy, refresh is implicit elsewhere through
TanStack Query but the gesture builds trust). Swipe-to-delete is
optional but the iOS-native list contract; the explicit per-row trash
button covers the same functional need. Long-press is the
established way to expose secondary actions ("Edit", "Copy value",
"Share screenshot") without overlaying icons.
**Fix shape**: At minimum, wire `react-use-gesture` (already in the
dep tree if not, light add) to give the dashboard + measurement
lists a pull-to-refresh that calls `queryClient.invalidateQueries({
queryKey: [...] })`. Swipe-to-delete can wait until users ask;
long-press menus open the door to a context-menu primitive (not
currently in the design system).
**Effort**: medium (pull-to-refresh) / large (gesture suite)

### F-15: No persistent-login affordance

**Severity**: low
**Surface**: auth
**Viewport**: all
**File(s)**: `src/app/auth/login/page.tsx:178-235`, `src/lib/auth/session.ts:8`
**What's wrong**: Session cookie is hardcoded to 30 days
(`SESSION_MAX_AGE_MS`). There is no "Stay signed in" checkbox or
toggle, so a security-conscious user who'd want a short 24-hour
session can't reduce it, and a power user who wants a 90-day session
can't extend it. The PWA shell expects users to live in the app —
30 days is a reasonable default but the UX contract isn't surfaced.
**Fix shape**: Add a `Stay signed in` checkbox under the password
fields that flips the cookie maxAge between 24 h (unchecked) and 30
days (checked, default). Or surface the current expiry in
`/settings/account` so the user understands the contract. Either is
small; the value is in the explicit signal, not the mechanic.
**Effort**: small

### F-16: Native sharing absent for doctor reports / screenshots

**Severity**: low (informational)
**Surface**: doctor report, insights
**Viewport**: all
**File(s)**: `src/components/doctor-report/doctor-report-dialog.tsx` (download only)
**What's wrong**: The doctor-report flow downloads a PDF. On
mobile, the native pattern is `navigator.share({ files: [...] })` —
the user sends the report straight to their doctor's WhatsApp /
email without going through Files. The Web Share Level 2 API ships
on iOS 15+ and Android Chrome. Skipping it makes the export feel
desktop-first.
**Fix shape**: Detect `navigator.canShare?.({ files: [...] })` and
expose a "Share" button alongside "Download" in the dialog footer.
Falls through to a `<a download>` when unsupported.
**Effort**: small

## Out of scope / accepted constraints

- **Recharts stays.** Following `feedback_charts_visual_identity.md`
  — no library replacement, only the tooltip / touch-mode hardening
  the existing code already does (cursor, filterNull, RichChartTooltip).
- **Sidebar nav.** Desktop-only; this audit focuses on the mobile
  contract.
- **Onboarding tour overlay.** Functional on `<sm` (`pointer-events`
  + portal flow); only the `80vh` cap is called out (F-9). The
  tooltip's WCAG 2.5.5 footer buttons are already at `min-h-11`.

## What was not checked

- Live Lighthouse / WebPageTest run against the production app on a
  throttled iPhone 12 — the audit is grep-driven.
- Real-device VoiceOver / TalkBack pass on the sheet branches —
  the primitives carry the right ARIA semantics on paper.
- Landscape orientation for the Coach drawer specifically (it
  occupies `90dvh` portrait — landscape with the keyboard open is
  worth a real-device check).
- The `/admin/**` deep links on `<sm` (this audit treats admin as
  best-effort; Marc is the only admin).
