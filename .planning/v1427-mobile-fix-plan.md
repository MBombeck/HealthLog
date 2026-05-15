---
file: .planning/v1427-mobile-fix-plan.md
purpose: v1.4.27 R3c consolidator output — consolidated mobile find-list, fix-surface buckets, file-touch collision matrix, dispatch sequence for R3d
created: 2026-05-15
predecessor: .planning/v1427-mobile-plan.md + 7 R3c mobile audit reports (MA1 dashboard, MA2 insights, MA3 coach, MA4 measurements-workouts, MA5 medications, MA6 settings-admin, MA7 auth-public)
target_tag: v1.4.27
sequenced_after: R3b (B6 + B7)
sequenced_before: R4 (QA pass)
mode: read-only (planning artifact)
---

# v1.4.27 R3c — Mobile Fix Plan

## Headline

Seven mobile audits surfaced **120 raw findings** (8 Critical, 38 High, 50 Medium, 24 Low). De-duplication folds them into **74 consolidated findings**. They group cleanly into **7 touch-disjoint fix-surface buckets** (MB1–MB7) with **zero same-line collisions** and **6 documented sequenced edits** where two buckets share a file but not the same lines. Dispatch lands as **2 sequenced primitive buckets (MB1 + MB2 + MB3)** that must close before **4 parallel surface buckets (MB4 / MB5 / MB6 / MB7)** can build on the new primitive contracts. Severity policy: Critical + High applied unconditionally, Medium applied if effort ≤ M, Low applied only when the file is already being touched.

## Convention

Marc-Voice English. Forbidden vocabulary: AI, Claude, agent, marathon, wave, phase, session, subagent, Anthropic. Use round, pass, contributor, slot, automation, release work. No personal data. No co-authored-by trailers. Single commit on `develop` at the end of this plan.

---

## Section 1 — Consolidated find-list (de-duplicated)

Sorted by severity tier (max of contributor tiers). Cross-audit overlap explicitly noted in the **Source** column.

### Tier — Critical

| CF | Title | Severity | Source | Root cause | Recommended fix | Effort |
|---|---|---|---|---|---|---|
| CF-1 | Forms render in centred `<Dialog>` on mobile with no max-height, no internal scroll, no bottom-sheet branch | Critical | MA1-F1 + MA4-F4 + MA5-F13 | Shared `DialogContent` primitive has no height cap; every form-on-mobile flow inherits the desktop centred-card shape | Land a `<ResponsiveSheet>` primitive (Sheet bottom on `<md`, Dialog on `≥md`); cap `DialogContent` to `max-h-[calc(100dvh-2rem)] overflow-y-auto`; migrate Measurement form, Mood form, Medication form, intake create/edit, side-effect log, inventory add to the new primitive | L |
| CF-2 | Numeric / form inputs ship with no `inputMode`, no `enterKeyHint`, no `aria-invalid` / `aria-describedby` wiring | Critical | MA4-F1 + MA1-F1 + MA3-F8 + MA5-F15 + MA6-F6 + MA7-F7 | Repo-wide convention never set; primitive `<Input>` does not derive defaults from `type`; ~40 call sites diverge | Add `inputMode` / `enterKeyHint` to every numeric, email, URL, text input across forms; lift sensible defaults into the shared `<Input>` primitive (numeric `type` → `inputMode="decimal"`); wire `aria-invalid` + `aria-describedby` on validation failure | M |
| CF-3 | Coach drawer not reachable from any insight sub-page | Critical | MA3-F1 | Drawer mount lives on `/insights/page.tsx` and `/targets/page.tsx` only; the seven sub-pages have no Coach entry point | Move drawer mount to `src/app/insights/layout.tsx` with a `CoachLaunchProvider` context exposing `askCoach(prefill, scope)`; sub-pages render a `<CoachLaunchButton>` (sticky FAB on `<lg`, inline action on `lg+`) wired to the context | M |
| CF-4 | Schedule day-of-week row overflows / squishes at 320 px | Critical | MA5-F1 + MA5-F2 | Daily + 7 weekday buttons render in a single `flex w-full gap-1` row; minimum width math fails on Galaxy Fold; same pattern repeats in two places in `medication-form.tsx` | Switch to `grid grid-cols-7` for the weekday buttons on mobile; daily/cadence button moves to its own row above via `grid grid-cols-1 sm:grid-cols-[6rem_1fr]` | S |
| CF-5 | `/about` bounces unauthenticated visitors to sign-in — CC BY-SA 4.0 licence-compliance regression | Critical | MA7-F1 | `AuthShell.PUBLIC_PATHS` was not updated when B3 added `/about` to `proxy.ts` | Add `"/about"` to `PUBLIC_PATHS` and `isStandalonePublicPage` in `src/components/layout/auth-shell.tsx` | S |
| CF-6 | Register page submit CTA below the 44 pt tap-target floor | Critical | MA7-F2 | Login page got the WCAG 2.5.5 lift; register page is the asymmetric outlier | Mirror login — `size="lg" className="min-h-11 w-full"` on the register submit `<Button>` | S |

### Tier — High

| CF | Title | Severity | Source | Root cause | Recommended fix | Effort |
|---|---|---|---|---|---|---|
| CF-7 | Sub-44 pt tap targets — primitive-level lift across `<DialogContent>` close-X, `<DropdownMenuItem>`, `<SelectTrigger>`, `<Input>`, `<Button>` defaults | High | MA1-F3 + MA1-F2 + MA4-F12 + MA5-F8 + MA6-F17 | Primitive defaults sit at 24-36 px; per-callsite overrides have proliferated to 50+ sites | Lift `<Button>` / `<Input>` / `<SelectTrigger>` default to `h-10` (40 px) with `data-[size=lg]` to `h-11`; patch `DialogContent` close-X to `min-h-9 min-w-9` (or wrap in `inline-flex` 44 px target); add `min-h-11` to `DropdownMenuItem`; document via inline comment | M |
| CF-8 | Hero strip + advisor card + Coach drawer header + suggested-prompt chips + Coach window-pill all sub-44 pt | High | MA2-F1 + MA2-F2 + MA2-F4 + MA2-F9 + MA3-F2 + MA3-F3 + MA3-F4 + MA3-F12 | `size="sm"` / `size-9` / `h-7` cluster across Insights and Coach surfaces | Sweep all `size="sm"` / `size-9` / `h-7` instances under `src/components/insights/` to `min-h-11` (or `size-11` for icon-buttons); same lift for the suggested-prompt chips and the Coach window-pill | S (per surface, ~6 spots) |
| CF-9 | Coach drawer mounts right-edge sheet on every viewport — mobile UX convention is bottom-sheet | High | MA2-F3 | Sheet hardcoded `side="right"`; never branches on viewport width | Conditional `side` — `side="bottom"` on `<sm`, `side="right"` on `≥sm` via the new `<ResponsiveSheet>` primitive (or a `useIsMobile()` hook duplicating the `<SheetContent>`) | M |
| CF-10 | Compliance heatmap hover-only on touch + cells shrink below 8 px in stretch mode | High | MA2-F6 + MA2-F7 | Tooltip wired via `onMouseEnter`/`onMouseLeave`; cell-size floor at 8 px allows illegible cells | Parallel `onPointerEnter` / `onPointerLeave`; tap-to-pin pattern (first tap pins, second tap moves, tap outside closes); lift cell floor to 14 px and let the heatmap scroll-x on `<sm` instead of compressing | M |
| CF-11 | History-rail delete uses `opacity-0 group-hover:opacity-100` + 24 px tap target | High | MA3-F5 | Hover-only reveal + sub-floor size — touch users cannot delete conversations | Drop `opacity-0`; bump to `size-9` (44 px wrapper); defer swipe-to-delete to v1.4.28 | M |
| CF-12 | Settings sheet (Coach) default close-X is 16 px target | High | MA3-F6 | Settings sheet inherits default `<SheetContent>` close-X; drawer header explicitly retired this | Pass `showCloseButton={false}` and render in-header `<SheetClose asChild>` with `Button variant="ghost" size="icon"` shape; drop the `pr-12` reservation | S |
| CF-13 | Coach rail-tray triggers are `h-7` (28 px) + occlude message thread | High | MA2-F5 + MA3-F10 | Two absolutely-positioned 28 px chips at `top-2 left-2` and `top-2 right-2` overlay first message; cannot be tapped reliably | Lift chevron triggers out of the thread overlay into a real sub-header strip on `<lg`; bump to `min-h-11`; reserve vertical space instead of overlaying | M |
| CF-14 | Mobile list row edit/delete buttons + pagination chevrons sit at 32-40 px | High | MA4-F2 + MA4-F3 | Measurements mobile-row icons override to `h-8 w-8` or `h-10 w-10`; pagination `<Button size="sm">` | Pump mobile-row pencil + DeleteButton to `h-11 w-11`; switch pagination to `size="icon" className="h-11 w-11"` on `<sm`, or single "Load more" CTA | S |
| CF-15 | No `/measurements/new` route exists; four insights empty-state CTAs 404 | High | MA4-F5 | B4 added empty-state CTAs but the route was never created | Re-route the four empty-state CTAs to `/measurements?add=<TYPE>` query-param trigger; the measurements page already exposes `defaultType` via the dialog mount and can open the dialog on mount when the param is present | S |
| CF-16 | DrugLevelChart YAxis label rendered in `width={1}` column — never visible (dead SVG) | High | MA5-F3 | Recharts paints label into a 1-px gutter | Drop the `label={…}` prop from `<YAxis>`; keep the visible axis-caption `<p>` only; drop the empty `<text>` child of `<XAxis>` too | S |
| CF-17 | Medication dialogs miss `sm:max-w-md` cap; some lack `max-h-[90vh]` | High | MA5-F4 + MA5-F9 | Inconsistent width cap across 8 medication dialog mounts; IntakeImport + ApiEndpoint dialogs have no max-h | Add `className="sm:max-w-md max-h-[90vh] overflow-y-auto"` to every medication `<DialogContent>` lacking it; folds into MB1's primitive lift if `DialogContent` defaults are bumped | S |
| CF-18 | Intake history mobile cards + SideEffects delete + Inventory pen actions all 24-32 pt | High | MA5-F5 + MA5-F6 + MA5-F7 | Per-row icon buttons `h-8 w-8` / `h-7 w-7` / `h-6 w-6` across three medication sub-surfaces | Bump every per-row action button to `min-h-11 min-w-11`; pass `size` prop into `<DeleteButton>` so desktop table stays compact; inner icon stays `h-3.5 w-3.5` | S |
| CF-19 | `/settings/api` tables force horizontal scroll on mobile (no card-list fallback) | High | MA6-F1 | Three tables with hard `min-w-[760px]` / `min-w-[860px]` widths; the user-facing surface skipped the dual-table pattern admin sections adopted | Mirror `admin/api-token-overview-section.tsx` — keep `hidden md:block` desktop table, add `md:hidden` card list per table (3 cards) | M |
| CF-20 | Six admin tables miss card-list fallback for mobile | High | MA6-F2 | `login-overview`, `feedback`, `backups`, `app-logs`, `ai-quality`, `coach-feedback` never received the dual-table treatment | Per-table mobile card list following the existing pattern from `users`, `api-tokens`, `account/passkeys`. Card shape: primary identifier + status badge + secondary metadata + action(s) | L → see severity policy; **defer to v1.4.28** |
| CF-21 | CSV-export and pagination buttons hidden behind table horizontal scroll on `login-overview` and `app-log-preview` | High | MA6-F4 | Pagination row lives inside the `overflow-x-auto` wrapper; pushed off-screen | Move the `mt-3 flex flex-wrap` pagination row out of the `overflow-x-auto` wrapper so it always renders at viewport width | S |
| CF-22 | Password-input toggle button is a 16 × 16 raw `<button>` (every settings/admin password / token field) | High | MA6-F7 + MA7-F8 | `password-input.tsx` toggle has no height/width; consumed by 8+ surfaces; auth pages have no toggle at all | Wrap toggle icon in `inline-flex h-11 w-11 items-center justify-center` with `right-1` to keep visual anchor; add toggle to auth login + register password fields via shared `<PasswordInput>` primitive; `aria-pressed` + translated `aria-label` | M |
| CF-23 | No `src/app/not-found.tsx` shipped at app root | High | MA7-F3 | Next.js falls back to its built-in English 404 with no branding | Add `src/app/not-found.tsx` matching the auth-card geometry — `Logo`, translated headline, "Back to dashboard" CTA at `min-h-11`; lighter than `ErrorDetails` shape | M |
| CF-24 | `global-error.tsx` has hardcoded inline styles, sub-44 buttons, no safe-area inset | High | MA7-F4 | Root boundary cannot rely on providers; uses literal hex + pixel; never lifted to dvh / safe-area | Switch `<body>` to `min-height: 100dvh` + `padding-top: max(24px, env(safe-area-inset-top))`; bump button padding to `12px 18px`; document the provider-free constraint inline | S |
| CF-25 | Sticky header on `/privacy` and `/about` ignores safe-area insets | High | MA7-F5 | Both pages use `sticky top-0 z-10` with no `pt-[env(safe-area-inset-top)]` | Add `pt-[env(safe-area-inset-top)]` to the outer `<header>` of both pages; same on `<main>` left/right via `pl-[max(1rem,env(safe-area-inset-left))]` | S |
| CF-26 | `/privacy` ships no table of contents on mobile (11 sections, ~3000 words) | High | MA7-F6 | TOC scaffolding via `scroll-mt-20` ids was prepared but never consumed | Add a collapsible `<details>` TOC block right under the H1, default-closed on `<md`, default-open on `md:`; each anchor is `<a href="#${id}">`; zero JS | M |
| CF-27 | GLP-1 tile range-strip + tab-buttons sub-44 pt | High | MA1-F6 | Range pills carry `rounded px-1.5 py-0.5` → height ~18 px; TabButtons `text-xs` → ~28 px | Add `min-h-11 min-w-11` to TabButton and range-strip buttons (mirror the chart range tabs convention) | S |
| CF-28 | Dashboard reorder arrows + onboarding-checklist dismiss + GLP-1 strip all sub-44 pt (cluster) | High | MA1-F7 + MA1-F8 | Per-row up/down icons stacked at 20 × 20 px; checklist dismiss raw `<button p-1>` at 24 px | Per F7: replace per-row arrows with a single "Move to position…" listbox OR keep both but bump to `size="icon-sm"` (32 px) + 44 px padding wrapper. Per F8: bump dismiss to `min-h-11 min-w-11`; hide CTA label below `sm:` via icon-only; flex-wrap the row | S |
| CF-29 | Health-chart Y-axis hard-coded at 76 px steals 24% of 320 px viewport + inline pixel style for band overlay | High | MA1-F4 + MA1-F5 | Default `yAxisWidth = 76` + inline-style band-overlay positioning | Reduce default to `48`; switch overlay to Tailwind `inset-x-12 inset-y-3 sm:inset-x-16` utilities | S |

### Tier — Medium (apply if effort ≤ M)

| CF | Title | Severity | Source | Root cause | Recommended fix | Effort |
|---|---|---|---|---|---|---|
| CF-30 | Composer textarea does not autofocus on Coach drawer open | Medium | MA3-F11 | No `autoFocus`, no `useEffect` focus on open transition | Expose `inputRef`; focus inside `useEffect(() => { if (open) requestAnimationFrame(() => ref.current?.focus()) }, [open])` | S |
| CF-31 | Composer info-icon hint uses Radix Tooltip; not tap-toggleable on touch | Medium | MA3-F7 | Radix Tooltip emits on `pointerdown`/long-press; users expect tap-toggle | Swap `<Tooltip>` → `<Popover>` (shadcn already ships `popover.tsx`); add `aria-haspopup="dialog"` to trigger | S |
| CF-32 | Evidence disclosure missing `aria-expanded` | Medium | MA3-F9 | `<details>` + `<summary>` with `aria-controls` only | Track `onToggle` event to drive a stateful `aria-expanded`, or replace with `<Collapsible>` shadcn primitive | S |
| CF-33 | Composer hint button 28 × 28 px below touch minimum | Medium | MA3-F12 | `h-7 w-7` next to send button | Bump to `h-9 w-9`; folds with CF-31 popover swap | S |
| CF-34 | Health-Score provenance toggle below 44 pt + fixed-pixel HSC width brittle on tablet | Medium | MA2-F10 + MA1-F9 + MA2-F19 | `text-[11px]` button with no `min-h-*`; `lg:w-[360px] xl:w-[400px]` hard widths; split breakpoint at `lg:` strands HSC below the fold on iPad portrait | Add `min-h-11 px-2 py-2` to provenance toggle; replace fixed-width with `lg:basis-[360px] lg:shrink-0 lg:grow-0 xl:basis-[400px]`; move hero strip split to `md:flex-row` with `md:w-[280px] lg:w-[360px]` HSC | S |
| CF-35 | Sub-page-shell programmatic focus + scroll-reset fires on every nav | Medium | MA2-F11 | `useEffect` runs `scrollTo({top:0})` + `focus()` on every sub-page mount, regardless of input modality | Gate the `focus()` call on a keyboard-navigation detection (body-level data attribute set on first Tab); honour `prefers-reduced-motion` for scroll | M |
| CF-36 | Empty-state CTAs render as `size="sm"` (h-8) buttons across 8 insights sub-pages | Medium | MA2-F12 | Every `<EmptyState>` consumer passes `<Button size="sm">`; primitive does not flip to mobile-primary CTA | Add a `block` / `ctaSize` prop into `src/components/ui/empty-state.tsx`; default to full-width on `<sm`; lift the 8 consumer call sites; folds into MB7 | M |
| CF-37 | Scatter correlation chart fixed at 180 px height | Medium | MA2-F13 | `height={180}` pixel constant on outer wrapper | Switch to `aspect-[16/9]` with `min-h-[180px]` so container reflows | M |
| CF-38 | VO2-max stat strip 4-col on `sm:` may crowd at 640 px | Medium | MA2-F14 | `sm:grid-cols-4` engages at 640 px; avg30 delta caption wraps and breaks row baseline | Switch to `grid-cols-2 lg:grid-cols-4`; add `min-h-[X]` to all four tiles | S |
| CF-39 | Insight status card has no "show more" collapse for long text | Medium | MA2-F16 | Single paragraph rendered uncapped | `line-clamp-3` with "Show more" toggle on `<sm`; full text on `sm:+` | M |
| CF-40 | Sources rail uses native `<input type="checkbox">`; iOS Safari label-tap unreliable | Medium | MA3-F14 | Bypasses shadcn `<Checkbox>` primitive | Swap to `import { Checkbox } from "@/components/ui/checkbox"`; bump row to `min-h-11` | S |
| CF-41 | Trend-card avgAllTime mobile-secondary row stacks separately, inflates strip height contract | Medium | MA1-F11 | BD-Zielbereich tile renders a second row; parent grid `auto-rows-fr` propagates the inflated height to every tile | Below `sm:`, render avgAllTime + compareDelta as a single inline span inside the existing main row using `flex-wrap`; drop the separate `mt-1` `<div>` | M |
| CF-42 | Tile strip collapses to single-column at 320 px (9-tile vertical stack) | Medium | MA1-F10 | `grid auto-fit minmax(min(100%, 9rem), 1fr)` collapses; the comment in the file acknowledges the tension | At `<sm` switch to `flex overflow-x-auto snap-x snap-mandatory` with `min-w-[10rem]` tiles; above `sm:` keep current grid; document the deliberate split | M |
| CF-43 | Recharts `ResponsiveContainer` with fixed `h-[240px]` parent layout-shifts on first paint | Medium | MA1-F12 | Fixed pixel height clashes with `<ResponsiveContainer>` measure-then-render cycle and rotation | Move height to a CSS custom property (`--chart-h: 200px` mobile / `240px` sm+) or `aspect-[16/9] max-h-[260px]`; add `motion-reduce:transition-none` | M |
| CF-44 | Onboarding card title row has no `flex-wrap` + missing `min-w-0` | Medium | MA1-F13 | Title + dismiss buttons collide on 320 px German subtitle | Add `min-w-0 flex-1` to inner div; `line-clamp-2` on subtitle; icon-only dismiss below `sm:` | S |
| CF-45 | Measurement form action row + edit-dialog kebab trigger 36 px | Medium | MA4-F9 | `<Button size="icon" className="h-9 w-9">` with a single hidden entry behind the kebab | Lift kebabs to `h-11 w-11`; or promote the single hidden entry to a visible secondary text button at the same row | S |
| CF-46 | Type-filter `<Select>` fixed `w-48` + missing `aria-label`; 2-column header layout has no `gap` / `min-w-0` | Medium | MA4-F11 | Filter trigger 192 px hard-coded; trailing count badge competes for narrow row | Switch trigger to `w-full max-w-[12rem]` + `min-w-0` on parent; add `aria-label`; hide count badge below `sm:` | S |
| CF-47 | Schedule input height-pinning fights iOS auto-zoom on focus | Medium | MA5-F8 | Per-schedule inputs `text-xs` (12 px) trigger iOS Safari viewport zoom on focus (< 16 px rule); also doseAmount at `text-sm` (14 px) | Lift focusable dialog inputs to `text-base` (16 px) on `<sm`; pair with primitive lift in MB2 | M |
| CF-48 | Therapy timeline ladder wraps awkwardly between 640-768 px | Medium | MA5-F10 | `sm:min-w-[7rem]` engages at 640 px; 4-step ladder wraps to rows of 3 at iPad portrait | Keep `flex-col` until `md:` (768 px); iPad portrait gets the vertical ladder same as mobile | M |
| CF-49 | SchedulingSection cadence grid wraps 30 × 44 px cells across 6 rows on 320 px | Medium | MA5-F11 | 30-cell grid eats ~280 vertical pixels; visual density mismatch | Drop 44 × 44 wrapper for informational-only cells; render compact 5 × 6 grid of 28 × 28 dots without tap-target wrapper (parent has `role="img"`) | M |
| CF-50 | PhaseConfig dialog row overflows at 320 px with German caption | Medium | MA5-F12 | Hard `w-14` / `w-20` / `w-12` widths + unconstrained caption | Stack vertically on mobile: `flex flex-col sm:flex-row sm:items-center sm:gap-2`; pin caption under input row at narrow widths | S |
| CF-51 | Medication time inputs use `type="text"` + pattern instead of `type="time"` | Medium | MA5-F14 | `type="text"` with `inputMode="numeric"` and a literal `pattern`; no native picker | `type="time"` with `step="60"`; same pattern as fallback | S |
| CF-52 | Native `<select>` styling diverges (3 copies of NATIVE_SELECT_CLASS) | Medium | MA6-F5 | Three near-identical class-string constants; settings vs admin focus-ring spec differs | Extract `<NativeSelect>` primitive into `src/components/ui/native-select.tsx`; three call sites import it instead of pasting | M |
| CF-53 | Withings 3-column credentials grid has invisible-label spacer hack | Medium | MA6-F8 | Save button column relies on `<Label className="invisible">` to align with input rows | Move Save out of the grid; render below as `<div className="flex justify-end"><Button>…</Button></div>` | S |
| CF-54 | Sources card up/down buttons consume 88 px control column on every row | Medium | MA6-F10 | Two `h-11 w-11` buttons side-by-side at row's right edge | Stack the two buttons vertically inside a 44 × 44 column (mirror `DashboardLayoutSection` pattern at line 278-303) | S |
| CF-55 | Feedback `<TabsList>` overflows at 320 px with badges | Medium | MA6-F11 | Four tabs + count badges natural width exceeds 320 px viewport | Wrap `<TabsList>` in `<div className="no-scrollbar -mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">` (same pattern the shells use) | S |
| CF-56 | `<SettingsToggle>` doesn't stack on mobile when description is long | Medium | MA6-F12 | `flex items-center justify-between` with no breakpoint flip | Refactor to `flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3`; apply same fix to the inline duplicate in `general-settings-section.tsx` | S |
| CF-57 | Action-button rows wrap to 4 stacked lines on Withings + moodLog cards at 320 px | Medium | MA6-F14 | 4-button rows in `flex flex-wrap items-start gap-2`; German Disconnect copy is long | Group: primary (Sync) and danger (Disconnect) stay visible; Full sync + Test connection move under a `<DropdownMenu>` "More actions" trigger on `<sm`; render inline on `≥sm` | M |
| CF-58 | Notifications page anchor targets lack `scroll-mt-28`, breaks deep-link landing | Medium | MA6-F19 | Three `<div id="telegram|ntfy|web-push">` have no `scroll-mt-*`; chip strip + AuthShell header occlude the anchor | Add `scroll-mt-28` (or `scroll-mt-24` matching thresholds page) to the three anchor wrappers | S |
| CF-59 | Login + register form-level error has no `aria-invalid` link to field | Medium | MA7-F9 | Both forms collapse API errors into single `role="alert"` block; no link back to offending input | Carry API error shape as `{ field?, message }`; spread `aria-invalid="true" aria-describedby={errorId}` on the matching `<Input>`; render alert above submit with stable `id` | M |
| CF-60 | "Back to passkey" button is a raw `<button text-xs>` with ~16 px tap height | Medium | MA7-F10 | No `min-h-11`, no padding | Switch to `<Button variant="link" size="sm">` with `min-h-11`; or wrap in `min-h-11 inline-flex items-center justify-center px-2` | S |
| CF-61 | Login + register card padding is `p-8` at every breakpoint | Medium | MA7-F11 | No mobile reduction | `p-6 sm:p-8` on both card wrappers | S |
| CF-62 | `/privacy` HealthKit identifier list missing `break-all` on `<code>` tags | Medium | MA7-F12 | 20+ `<code>` usages with no `overflow-wrap`; future long identifier would horizontal-scroll the page | Add `break-all` to the HK list `<code>` className; consider extracting `<InlineCode>` primitive (defer the extraction) | S |
| CF-63 | Privacy / about header "Sign in" link sub-44 px hit target | Medium | MA7-F13 | Two `<Link>` elements `text-sm` with `py-3` inherited; link carries no padding | Wrap both links in `inline-flex items-center h-11 px-2 -mx-2` (negative margin neutralises shift); or shadcn `<Button variant="ghost" size="sm">` asChild | S |
| CF-64 | `ErrorDetails` action row uses `size="sm"` (32 px) buttons | Medium | MA7-F14 | Retry / Copy / Report all `size="sm"` | Drop `size="sm"`; let buttons default to `h-9`; row already has `flex-wrap gap-2` | S |
| CF-65 | `ErrorDetails` + `global-error.tsx` carry no safe-area / dvh | Medium | MA7-F15 | Outer wrapper `max-w-xl space-y-4 p-6` has no `min-h-dvh`; `global-error.tsx` uses pre-dvh `minHeight: "100vh"` | `ErrorDetails` outer → `min-h-dvh flex flex-col items-center justify-center`; `global-error.tsx` body → `minHeight: "100dvh"` | S |
| CF-66 | DrugLevelChart standalone wrapper `md:p-6` collides with route's `space-y-4` | Medium | MA5-F16 | Asymmetric padding on tablet/desktop only | Drop responsive `md:p-6`; pad uniformly at 16 px | S |

### Tier — Low (apply only if same-file fix already touches the spot)

| CF | Title | Severity | Source | Root cause | Recommended fix | Effort |
|---|---|---|---|---|---|---|
| CF-67 | Trend-card label-row wrapper is a vestigial `<div className="flex min-w-0">` | Low | MA1-F14 | Wrapper holds one child with no flex-direction and no w-full | Drop wrapper or replace with `<div className="block min-w-0">` | S |
| CF-68 | Daily briefing key-finding row has no per-row action | Low | MA1-F15 | Static `<div>`, not a `<button>` or `<Link>` | Wrap each row in `<Link href={metricInsightsHref(finding.sourceMetric)}>`; swipe-to-dismiss deferred | M |
| CF-69 | Hero strip weekly-report banner stacks 4 rows on 320 px | Low | MA1-F16 | `flex-wrap items-center gap-3` with 3 buttons + icon + label | Collapse Share + Export PDF into a `<DropdownMenu>` on `<sm`; keep Read as primary action | S |
| CF-70 | Sleep-stage window toggle row uses `gap-1` (4 px) — crowded | Low | MA2-F15 | Cosmetic spacing | Bump gap to `gap-1.5` (6 px) | S |
| CF-71 | Trends row min-h-[300px] locks even when chart is mini loading | Low | MA2-F17 | Fixed min-h on all three trend cards regardless of viewport | Drop to `md:min-h-[300px]` so mobile cards size to content | S |
| CF-72 | Insights tab strip overflow-x has no scroll-snap or right-edge fade | Low | MA2-F18 | `[scrollbar-width:none]` hides scrollbar with no replacement affordance | Add right-edge gradient mask; or scroll active pill into view on mount | M |
| CF-73 | Coach drawer SheetTitle truncated on `<sm` when long | Low | MA3-F16 | Header math: icons + pill + avatar leave ~96 px for title | On `<sm`, hide window-pill from header (surface inside sources tray); saves ~28 px | S |
| CF-74 | No keyboard-aware scroll on Coach composer when soft keyboard opens | Low | MA3-F17 | `message-thread` scroll runs only on content change, not on resize | Add `visualViewport.addEventListener("resize", …)` to re-pin to bottom if `wasPinnedRef.current` | S |
| CF-75 | Account passkey mobile cards lose device-type badge (asymmetric with desktop) | Low | MA6-F18 | Mobile inlines `credentialDeviceType` as plain text; desktop uses `<Badge>` | Render device-type as a badge in the mobile card too; same chip vocabulary across both viewports | S |
| CF-76 | Mobile-row source / note metadata at 10-12 px below legibility floor | Low | MA4-F8 | `text-[10px]` / `text-xs` on date + source rows | Lift BP-side + source badges to `text-[11px]`; lift date/note paragraphs to `text-[13px]` | S |

### Deferred to v1.4.28 (effort > M or strategic scope)

| CF | Title | Severity | Source | Why deferred |
|---|---|---|---|---|
| CF-77 | Six admin tables miss card-list fallback (CF-20 above) | High | MA6-F2 | L effort; per-table contributor work load; mechanical pattern but ~6 tables × non-trivial card design |
| CF-78 | `<DateTimeInput>` rewrite (shadcn DatePicker + TimePicker) | Medium | MA4-F7 | L effort; introduces new dependency or component family |
| CF-79 | RHF + Zod migration for measurement-form + measurement-list edit | Medium | MA4-F10 | M-bordering-L effort; broad scope; touches API integration shape |
| CF-80 | Bottom-sheet primitive across all medication entry-points (settings-style flows stay centred) | Medium | MA5-F13 | L effort if applied repo-wide; CF-1 + MB1 handle the core form flows for v1.4.27 |
| CF-81 | InjectionSitePicker SVG tap-target spec documentation | Low | MA5-F17 | M effort; deliberate trade-off, not a true regression |
| CF-82 | `medication-form.tsx` refactor into `<ScheduleEditor>` + `<ScheduleList>` | Low | MA5-F18 | L effort; pure code hygiene |
| CF-83 | Swipe-to-delete on measurements + history-rail rows | Low | MA4-F13 + MA3-F5 partial | L effort; new gesture-library dependency |
| CF-84 | Web workouts list + detail UI | Low | MA4-F14 | L effort; strategic v1.5 work aligned with iOS workouts views |
| CF-85 | Coach drawer `!max-w-*` important fight | Low | MA3-F15 | Defer to v1.4.28+ until upstream Sheet exposes a width prop |
| CF-86 | Thresholds skeleton-to-actual layout jump for users with overrides | Low | MA6-F9 | S effort but skeleton heuristic complexity; defer to backlog |
| CF-87 | Login overview filter row progressive disclosure | Low | MA6-F16 | M effort; UX preference, not a regression |
| CF-88 | Coach source-chip provenance row sub-20 px (deferred — chips are static today) | Low | MA3-F13 | Deferred until chips become interactive (v1.5 deep-link feature) |
| CF-89 | Onboarding step-pages arrow-pager defensive flex-wrap | Low | MA7-F16 | S effort; defensive only, not currently broken |
| CF-90 | BaselineForm sticky-bottom Save row on `<sm` | Low | MA7-F17 | M effort; one-time onboarding flow |

---

## Section 2 — Fix-surface buckets

Seven touch-disjoint buckets. Each is sized to land in a single R3d contributor slot with multiple atomic commits per bucket.

### MB1 — `<ResponsiveSheet>` primitive + mobile sheet branch for every primary form

**Owns:** CF-1 (root), CF-9 (Coach bottom-sheet), CF-17 (medication dialog caps), CF-12 (Coach settings sheet close-X retire), CF-47 (iOS auto-zoom on dialog inputs — pair with MB2).

**Files:**
- `src/components/ui/responsive-sheet.tsx` (new)
- `src/components/ui/dialog.tsx` (add `max-h-[calc(100dvh-2rem)] overflow-y-auto` defaults; do NOT touch close-X size — that's MB2)
- `src/components/ui/sheet.tsx` (no edits — only the consumer side changes)
- `src/components/measurements/measurement-form.tsx` (mount via `<ResponsiveSheet>`; sticky-pin Save / Cancel row)
- `src/components/mood/mood-form.tsx` (mount via `<ResponsiveSheet>`)
- `src/components/medications/medication-form.tsx` (mount via `<ResponsiveSheet>`)
- `src/components/medications/intake-history-list.tsx` (intake create/edit dialogs)
- `src/components/medications/SideEffectsSection.tsx` (side-effect log dialog)
- `src/components/medications/inventory-section.tsx` (inventory add dialog)
- `src/app/medications/page.tsx` (medication create/edit + IntakeImport + ApiEndpoint dialog mounts — add missing `sm:max-w-md` / `max-h-[90vh]`)
- `src/components/insights/coach-panel/coach-drawer.tsx` (branch `side="bottom"` on `<sm`; conditional via `useIsMobile()` hook or by inlining the `<ResponsiveSheet>`)
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` (pass `showCloseButton={false}`; in-header `<SheetClose>`)

**Commit count estimate:** 5-6
1. Primitive `<ResponsiveSheet>` + dialog default cap
2. Measurement / mood form migration
3. Medication form + advanced surfaces migration + dialog cap sweep
4. Coach drawer bottom-sheet branch on `<sm`
5. Coach settings sheet close-X retire
6. Sticky bottom-CTA pattern on long forms (paired with each migrated form)

### MB2 — Sub-44 pt tap-target primitive lift

**Owns:** CF-7 (root primitive lift), CF-8 (insights surface sweep), CF-13 (Coach rail-tray triggers), CF-14 (measurements list buttons), CF-18 (medications icon-button cluster), CF-22 (password-input toggle), CF-27 (GLP-1 strip), CF-28 (reorder + checklist), CF-29 (chart Y-axis + band overlay), CF-45 (form kebab), CF-54 (sources card stacking), CF-60 (back-to-passkey link), CF-63 (privacy/about header links), CF-64 (ErrorDetails action row).

**Files:**
- `src/components/ui/button.tsx` (primitive default lift to `h-10` with `data-[size=lg]` to `h-11`)
- `src/components/ui/input.tsx` (primitive default lift to `h-10`)
- `src/components/ui/select.tsx` (primitive default lift to `h-10` for trigger)
- `src/components/ui/dialog.tsx` (close-X to `min-h-9 min-w-9` wrapper)
- `src/components/ui/dropdown-menu.tsx` (`DropdownMenuItem` to `min-h-11`)
- `src/components/settings/password-input.tsx` (toggle wrapper to `inline-flex h-11 w-11`)
- `src/components/insights/hero-strip.tsx` (action-button sweep)
- `src/components/insights/suggested-prompts.tsx` (chip lift)
- `src/components/insights/insight-advisor-card.tsx` (regenerate icon buttons)
- `src/components/insights/coach-panel/coach-drawer.tsx` (header icons + window-pill)
- `src/components/insights/coach-panel/coach-drawer-body.tsx` (rail-tray chevrons — lift out of overlay into sub-header strip)
- `src/components/insights/coach-panel/message-thread.tsx` (thumbs feedback row)
- `src/components/insights/coach-panel/history-rail.tsx` (drop opacity-0; bump size-9)
- `src/components/insights/coach-panel/coach-input.tsx` (composer hint icon)
- `src/components/measurements/measurement-list.tsx` (mobile-row icons + pagination + edit kebab)
- `src/components/measurements/measurement-form.tsx` (reset kebab)
- `src/components/medications/intake-history-list.tsx` (mobile-card actions)
- `src/components/medications/SideEffectsSection.tsx` (per-entry delete)
- `src/components/medications/inventory-section.tsx` (live + past-pen actions)
- `src/components/medications/medication-card.tsx` (only if existing overrides regress — likely unchanged)
- `src/components/dashboard/glp1-tile.tsx` (range strip + TabButtons)
- `src/components/onboarding/getting-started-checklist.tsx` (dismiss button)
- `src/components/settings/dashboard-layout-section.tsx` (reorder arrows)
- `src/components/settings/sources-section.tsx` (stack up/down buttons vertically)
- `src/components/charts/health-chart.tsx` (Y-axis width + band overlay)
- `src/components/error-details.tsx` (action-row sizes)
- `src/app/auth/login/page.tsx` (back-to-passkey link)
- `src/app/privacy/page.tsx` (header links)
- `src/app/about/page.tsx` (header links)

**Commit count estimate:** 7-8
1. Button + Input + Select + DropdownMenu primitive lifts (one commit; verify no regression in snapshot tests)
2. DialogContent close-X + PasswordInput toggle wrapper (one commit — both touch primitive infrastructure)
3. Insights surface sweep (hero / advisor / drawer / suggested-prompts / coach-input / message-thread)
4. Coach rail-tray chevrons lifted out of overlay
5. Measurements + medications surface sweep
6. Dashboard tile + onboarding + settings reorder + sources stacking
7. Chart Y-axis + auth links + ErrorDetails

### MB3 — `inputMode` / `enterKeyHint` / `autoComplete` / `aria-invalid` / `aria-describedby` sweep

**Owns:** CF-2 (root), CF-22 partial (auth password toggles arr-pressed/aria-label live here), CF-30 (Coach composer autofocus), CF-31 (Tooltip → Popover for tap-toggle), CF-32 (`aria-expanded`), CF-46 (Select aria-label + filter), CF-51 (medication time inputs), CF-59 (form error aria wiring).

**Files:**
- `src/components/ui/input.tsx` (derive `inputMode` defaults from `type` — e.g. `type="number"` → `inputMode="decimal"`; consumers can override)
- `src/components/measurements/measurement-form.tsx` (every numeric `<Input>` gets explicit `inputMode`, `enterKeyHint`, `aria-invalid`, `aria-describedby` wiring; error banner linked via `id`)
- `src/components/measurements/measurement-list.tsx` (edit dialog inputs + filter Select `aria-label`)
- `src/components/medications/medication-form.tsx` (`type="time"` swap on window-start / window-end; `autoComplete="off"` + `enterKeyHint` chain on name → dose → dosesPerUnit; iOS-zoom fix via `text-base` on `<sm`)
- `src/components/medications/intake-history-list.tsx` (DateTimeInput fields autoComplete + enterKeyHint)
- `src/components/medications/inventory-section.tsx` (dosesTotal, expiry, purchased inputs)
- `src/components/medications/SideEffectsSection.tsx` (notes textarea)
- `src/components/insights/coach-panel/coach-input.tsx` (`enterKeyHint="send"` + `autoCapitalize="sentences"` + autoFocus wiring + Tooltip → Popover swap + composer hint size)
- `src/components/insights/coach-panel/message-thread.tsx` (`<details>` controlled stateful `aria-expanded` OR `<Collapsible>` swap)
- `src/components/settings/account-section.tsx` (height field inputMode; profile fields autoComplete)
- `src/components/settings/telegram-card.tsx` (bot token + chat ID `autoComplete="off"`, `inputMode="text"`, `spellCheck={false}`)
- `src/components/settings/integrations-section.tsx` (Withings client-id + secret; moodLog URL + API key — `inputMode="url"` / `autoComplete="off"`)
- `src/components/settings/notifications-section.tsx` (anchor `scroll-mt-28`)
- `src/components/settings/thresholds-editor-section.tsx` (min/max number inputs)
- `src/components/admin/general-settings-section.tsx` (reminder minutes etc.)
- `src/app/auth/login/page.tsx` (email + password keyboard hints; `aria-invalid` + `aria-describedby` wiring)
- `src/app/auth/register/page.tsx` (same)

**Commit count estimate:** 4-5
1. `<Input>` primitive `inputMode` derivation
2. Forms sweep: measurements + medications + mood
3. Forms sweep: settings + admin + Coach composer + notifications anchors
4. Auth forms aria-invalid + error wiring
5. Coach evidence `aria-expanded` swap; Coach composer Tooltip → Popover

### MB4 — Coach reachability + mobile chrome

**Owns:** CF-3 (drawer mount move + provider), CF-9 (bottom-sheet — depends on MB1 ResponsiveSheet primitive), CF-11 (history-rail delete reveal), CF-31 partial (info-icon popover — pair with MB3), CF-40 (sources-rail Checkbox swap), CF-73 (SheetTitle truncate), CF-74 (visual viewport scroll re-pin).

**Files:**
- `src/app/insights/layout.tsx` (mount `<CoachDrawer>` + `<CoachLaunchProvider>`)
- `src/lib/insights/coach-launch-context.tsx` (new — exposes `askCoach(prefill, scope)` hook)
- `src/app/insights/blutdruck/page.tsx` (mount `<CoachLaunchButton>`)
- `src/app/insights/gewicht/page.tsx` (same)
- `src/app/insights/puls/page.tsx` (same)
- `src/app/insights/stimmung/page.tsx` (same)
- `src/app/insights/medikamente/page.tsx` (same)
- `src/app/insights/bmi/page.tsx` (same)
- `src/app/insights/schlaf/page.tsx` (same)
- `src/app/insights/page.tsx` (refactor existing inline drawer mount to consume context)
- `src/components/insights/coach-launch-button.tsx` (new — sticky FAB on `<lg`, inline action on `lg+`)
- `src/components/insights/coach-panel/history-rail.tsx` (delete reveal — already in MB2; this bucket only touches if MB2 work overlaps line ranges; see Section 3 sequenced edits)
- `src/components/insights/coach-panel/sources-rail.tsx` (Checkbox swap)
- `src/components/insights/coach-panel/coach-drawer.tsx` (`<sm` hide window-pill; bottom-sheet branch)
- `src/components/insights/coach-panel/message-thread.tsx` (visual viewport listener — paired with CF-32 work in MB3)

**Commit count estimate:** 3-4
1. `CoachLaunchProvider` + layout mount + 7 sub-page CTAs
2. Coach drawer bottom-sheet branch (`<sm`) + SheetTitle hide window-pill
3. Coach sources-rail Checkbox swap
4. visual viewport scroll re-pin

### MB5 — Tables → mobile card-list parity (in-scope subset)

**Owns:** CF-19 (`/settings/api` token tables — 3 tables × card-list), CF-21 (CSV-export and pagination buttons out of `overflow-x-auto`), CF-3 (carrier chip plan — folds into MB7 since the F2 admin tables defer to v1.4.28).

**Note:** CF-20 (six admin tables card-list) is **deferred to v1.4.28** per severity policy — L effort, six surfaces, mechanical pattern. The carrier-chip layout improvement (MA6-F3) is preserved in this plan as future-mobile prep for when the admin card-list lands.

**Files:**
- `src/components/settings/api-section.tsx` (3 tables → dual-table pattern; new `md:hidden` card lists)
- `src/components/admin/login-overview-section.tsx` (pagination + CSV export move out of `overflow-x-auto` wrapper)
- `src/components/admin/app-log-preview-section.tsx` (pagination move out of `overflow-x-auto` wrapper)

**Commit count estimate:** 2
1. `/settings/api` 3-table card-list parity
2. Pagination + CSV move-out for login-overview + app-log-preview

### MB6 — v1.4.27 mobile regression fixes + small auth/public polish

**Owns:** CF-4 (schedule day-of-week grid), CF-5 (/about public-path), CF-6 (register submit lift), CF-15 (insights empty-state CTA route), CF-16 (DrugLevelChart dead YAxis label), CF-23 (not-found.tsx), CF-24 (global-error.tsx), CF-25 (safe-area headers), CF-26 (privacy TOC), CF-62 (HK code `break-all`), CF-65 (dvh on error pages).

**Files:**
- `src/components/medications/medication-form.tsx` (schedule grid swap — CF-4; lines distinct from CF-47 iOS-zoom work in MB3 and CF-50 `phase-config-dialog.tsx` work in MB7; see Section 3)
- `src/components/layout/auth-shell.tsx` (PUBLIC_PATHS add `/about` to both constants)
- `src/app/auth/register/page.tsx` (submit `min-h-11 w-full` + `size="lg"` — distinct lines from MB3 aria-invalid wiring; see Section 3)
- `src/app/insights/blutdruck/page.tsx` (empty-state CTA href → `/measurements?add=BLOOD_PRESSURE`)
- `src/app/insights/gewicht/page.tsx` (same → `?add=WEIGHT`)
- `src/app/insights/puls/page.tsx` (same → `?add=PULSE`)
- `src/app/insights/bmi/page.tsx` (same → `?add=BMI` or appropriate route)
- `src/app/measurements/page.tsx` (consume `?add=<TYPE>` query param to auto-open the dialog with `defaultType`)
- `src/components/medications/DrugLevelChart.tsx` (drop dead YAxis label + dead XAxis text)
- `src/app/not-found.tsx` (new file)
- `src/app/global-error.tsx` (safe-area-inset-top, dvh, button padding)
- `src/components/error-details.tsx` (min-h-dvh — distinct from CF-64 action-row in MB2; see Section 3)
- `src/app/privacy/page.tsx` (safe-area + TOC `<details>` + `<code break-all>`)
- `src/app/about/page.tsx` (safe-area on header)

**Commit count estimate:** 5
1. Auth shell `/about` public path + about/privacy safe-area + privacy TOC
2. Register submit lift + `not-found.tsx` + ErrorDetails min-h-dvh + global-error safe-area/dvh
3. Schedule day-of-week grid swap (CF-4) + DrugLevelChart dead label drop (CF-16)
4. Insights empty-state CTAs route swap + measurements page `?add=` consumer
5. Privacy `<code break-all>` on HK identifier list

### MB7 — Surface-specific polish residue

**Owns:** CF-10 (compliance heatmap touch + cell-floor), CF-26 partial (TOC if maintainer prefers separate), CF-33 (composer hint button size — folds into MB2; listed for reference), CF-34 (HSC width + provenance + tablet split), CF-35 (sub-page-shell focus gating), CF-36 (EmptyState primitive ctaSize), CF-37 (scatter aspect-ratio), CF-38 (VO2 stat strip), CF-39 (status-card show-more), CF-41 (trend-card mobile-secondary row inline), CF-42 (tile strip horizontal scroll on `<sm`), CF-43 (chart height as CSS var), CF-44 (onboarding card title flex-wrap + min-w-0), CF-46 (filter Select narrow-viewport + aria-label), CF-48 (titration ladder keep flex-col until `md:`), CF-49 (cadence grid density), CF-50 (PhaseConfig row stack), CF-52 (NativeSelect primitive), CF-53 (Withings credentials grid Save move), CF-55 (Feedback TabsList overflow-x), CF-56 (SettingsToggle stacking), CF-57 (action-button row More-actions dropdown), CF-58 (notifications anchor scroll-mt — folds into MB3; listed for ref), CF-61 (auth card padding), CF-66 (DrugLevelChart md:p-6 drop), CF-67-76 (Low-tier where same-file fix already touches).

**Files:** Distributed across ~25 files; each touches an isolated concern not covered by MB1-MB6. The full list is the union of every file referenced by the CF-IDs above minus those already owned by MB1-MB6.

Notable groupings inside MB7:
- `src/components/charts/compliance-heatmap.tsx` — CF-10 (pointer events + cell-floor 14 px + scroll-x on `<sm`)
- `src/components/insights/health-score-card.tsx` — CF-34 (basis-based width + provenance toggle + hero strip split breakpoint)
- `src/components/insights/hero-strip.tsx` — CF-34 (md:flex-row split for HSC) + CF-69 (banner dropdown)
- `src/components/insights/sub-page-shell.tsx` — CF-35 (focus gate)
- `src/components/ui/empty-state.tsx` — CF-36 (ctaSize prop / w-full sm:w-auto)
- `src/components/charts/scatter-correlation-chart.tsx` — CF-37 (aspect-ratio)
- `src/components/insights/vo2-max-chart-row.tsx` — CF-38 (grid-cols-2 lg:grid-cols-4 + min-h)
- `src/components/insights/insight-status-card.tsx` — CF-39 (line-clamp-3 + Show more)
- `src/components/charts/trend-card.tsx` — CF-41 (inline avgAllTime + drop separate row) + CF-67 (vestigial wrapper)
- `src/app/page.tsx` — CF-42 (tile strip flex overflow-x on `<sm`) + CF-44 (header)
- `src/components/charts/health-chart.tsx` — CF-43 (CSS var) (note: CF-29 is in MB2; CF-43 touches different concern — chart height var, not Y-axis. Different lines; see Section 3)
- `src/components/charts/mood-chart.tsx` + `src/components/charts/medication-compliance-chart.tsx` — CF-43 (same)
- `src/components/onboarding/getting-started-checklist.tsx` — CF-44 (note: CF-28 dismiss button is in MB2; CF-44 touches title wrapper — different lines; see Section 3)
- `src/components/medications/TitrationSection.tsx` — CF-48
- `src/components/medications/SchedulingSection.tsx` — CF-49
- `src/components/medications/phase-config-dialog.tsx` — CF-50
- `src/components/ui/native-select.tsx` (new) + `src/components/settings/account-section.tsx` + `src/components/settings/timezone-picker.tsx` + `src/components/admin/general-settings-section.tsx` — CF-52
- `src/components/settings/integrations-section.tsx` — CF-53 (Withings grid) + CF-57 (More-actions dropdown)
- `src/components/admin/feedback-inbox-section.tsx` — CF-55 (TabsList overflow-x)
- `src/components/admin/_shared.tsx` — CF-56 (SettingsToggle stacking) + `src/components/admin/general-settings-section.tsx` inline duplicate
- `src/app/auth/login/page.tsx` + `src/app/auth/register/page.tsx` — CF-61 (`p-6 sm:p-8`)
- `src/components/medications/DrugLevelChart.tsx` — CF-66 (drop `md:p-6`) (different lines from CF-16; see Section 3)
- `src/components/measurements/measurement-list.tsx` — CF-76 (mobile-row metadata text-sizes) + CF-46 (filter)
- `src/app/insights/medikamente/page.tsx` — MA2-F8 medication card header `min-w-0` + `truncate`
- `src/components/insights/daily-briefing.tsx` — CF-68 (wrap each row in `<Link>`)
- `src/components/insights/insights-tab-strip.tsx` — CF-72 (right-edge fade)
- `src/components/insights/trends-row.tsx` — CF-71 (md:min-h-[300px])
- `src/components/insights/sleep-stage-stacked-bar.tsx` — CF-70 (gap-1.5)
- `src/components/settings/account-section.tsx` — CF-75 (passkey mobile card device-type badge)

**Commit count estimate:** 8-10 (one per coherent surface cluster)

---

## Section 3 — File-touch collision matrix

Columns are buckets MB1–MB7. Rows are files touched by two or more buckets. `X` = bucket edits the file; `seq` = sequenced edit (documented below). Cells left blank = no touch.

| File | MB1 | MB2 | MB3 | MB4 | MB5 | MB6 | MB7 |
|---|---|---|---|---|---|---|---|
| `src/components/ui/dialog.tsx` | X (max-h cap) | seq (close-X size — distinct line range) | | | | | |
| `src/components/ui/input.tsx` | | X (h-10 lift) | seq (inputMode derivation — distinct line range) | | | | |
| `src/components/ui/sheet.tsx` | reads only | | | reads only | | | |
| `src/components/measurements/measurement-form.tsx` | X (mount via ResponsiveSheet + sticky CTA) | seq (reset kebab — different lines) | seq (inputMode/enterKeyHint/aria — different lines) | | | | |
| `src/components/measurements/measurement-list.tsx` | | X (mobile-row icons + pagination + edit kebab) | seq (edit dialog inputs + filter aria — different lines) | | | | seq (mobile-row metadata text-sizes + filter narrow + count badge — different lines) |
| `src/components/medications/medication-form.tsx` | X (mount via ResponsiveSheet) | seq (any sub-44 inside form — different lines) | seq (autoComplete/enterKeyHint/iOS-zoom text-base + type="time" — different lines) | | | seq (schedule day-of-week grid swap — different lines from MB1 mount + MB3 input attrs) | |
| `src/components/medications/intake-history-list.tsx` | X (intake create/edit dialogs via ResponsiveSheet) | seq (mobile-card actions — different lines) | seq (DateTimeInput autoComplete — different lines) | | | | |
| `src/components/medications/SideEffectsSection.tsx` | X (dialog via ResponsiveSheet) | seq (per-entry delete — different lines) | seq (notes textarea attrs — different lines) | | | | |
| `src/components/medications/inventory-section.tsx` | X (add dialog via ResponsiveSheet) | seq (live + past-pen actions — different lines) | seq (input attrs — different lines) | | | | |
| `src/components/medications/DrugLevelChart.tsx` | | | | | | X (dead YAxis label + XAxis text) | seq (`md:p-6` standalone — different lines) |
| `src/components/insights/coach-panel/coach-drawer.tsx` | X (settings sheet close-X retire via pattern) | seq (header icons + window-pill — different lines from MB1) | | seq (bottom-sheet branch + `<sm` window-pill hide — different lines) | | | |
| `src/components/insights/coach-panel/coach-drawer-body.tsx` | | X (rail-tray chevrons out of overlay into sub-header) | | reads only | | | |
| `src/components/insights/coach-panel/coach-settings-sheet.tsx` | X (showCloseButton=false + in-header SheetClose) | seq (header button sizes — different lines) | | | | | |
| `src/components/insights/coach-panel/coach-input.tsx` | | seq (composer hint size — different lines from MB3 swap) | X (Tooltip → Popover + enterKeyHint + autoFocus + composer hint size) | | | | |
| `src/components/insights/coach-panel/message-thread.tsx` | | seq (thumbs feedback — different lines) | X (aria-expanded swap) | seq (visualViewport listener — different lines from MB3 aria work) | | | |
| `src/components/insights/coach-panel/history-rail.tsx` | | X (drop opacity-0 + size-9) | | seq (any context-provider integration — none expected) | | | |
| `src/components/insights/coach-panel/sources-rail.tsx` | | | | X (Checkbox swap) | | | |
| `src/components/insights/coach-panel/suggested-prompts.tsx` | | X (chip min-h-11) | | | | | |
| `src/components/insights/hero-strip.tsx` | | X (action button sweep) | | | | | seq (md:flex-row HSC split + banner dropdown — different lines) |
| `src/components/insights/health-score-card.tsx` | | | | | | | X (basis-based width + provenance toggle + tablet split) |
| `src/components/insights/insight-advisor-card.tsx` | | X (regenerate icons) | | | | | |
| `src/components/insights/sub-page-shell.tsx` | | | | | | | X (focus gate) |
| `src/components/insights/insight-status-card.tsx` | | | | | | | X (line-clamp + Show more) |
| `src/components/insights/insights-tab-strip.tsx` | | | | | | | X (right-edge fade) |
| `src/components/insights/trends-row.tsx` | | | | | | | X (md:min-h-[300px]) |
| `src/components/insights/sleep-stage-stacked-bar.tsx` | | | | | | | X (gap-1.5) |
| `src/components/insights/vo2-max-chart-row.tsx` | | | | | | | X (grid-cols + min-h) |
| `src/components/insights/daily-briefing.tsx` | | | | | | | X (row Link wrap) |
| `src/components/charts/compliance-heatmap.tsx` | | | | | | | X (pointer events + cell-floor + scroll-x) |
| `src/components/charts/scatter-correlation-chart.tsx` | | | | | | | X (aspect-ratio) |
| `src/components/charts/health-chart.tsx` | | X (Y-axis 48 + band overlay utilities) | | | | | seq (chart height CSS var — different lines from Y-axis work) |
| `src/components/charts/mood-chart.tsx` | | | | | | | X (chart height var) |
| `src/components/charts/medication-compliance-chart.tsx` | | | | | | | X (chart height var) |
| `src/components/charts/trend-card.tsx` | | | | | | | X (inline avgAllTime row + vestigial wrapper drop) |
| `src/components/dashboard/glp1-tile.tsx` | | X (range-strip + TabButtons min-h-11) | | | | | |
| `src/components/onboarding/getting-started-checklist.tsx` | | X (dismiss button) | | | | | seq (title row flex-wrap + min-w-0 — different lines) |
| `src/components/measurements/measurement-form.tsx` (duplicate row removed; already above) | | | | | | | |
| `src/components/medications/TitrationSection.tsx` | | | | | | | X (flex-col until md) |
| `src/components/medications/SchedulingSection.tsx` | | | | | | | X (cadence grid density) |
| `src/components/medications/phase-config-dialog.tsx` | | | | | | | X (row stack on mobile) |
| `src/components/settings/dashboard-layout-section.tsx` | | X (reorder arrows) | | | | | |
| `src/components/settings/sources-section.tsx` | | X (stack up/down vertically) | | | | | |
| `src/components/settings/password-input.tsx` | | X (toggle wrapper) | | | | | |
| `src/components/settings/account-section.tsx` | | | seq (height inputMode + profile autoComplete — different lines) | | | | X (NativeSelect import + passkey card device-type badge) |
| `src/components/settings/timezone-picker.tsx` | | | | | | | X (NativeSelect import) |
| `src/components/settings/telegram-card.tsx` | | | X (bot token + chat ID attrs) | | | | |
| `src/components/settings/integrations-section.tsx` | | | seq (Withings client-id + secret attrs — different lines) | | | | X (Save out of grid + More-actions dropdown) |
| `src/components/settings/notifications-section.tsx` | | | X (scroll-mt-28 on anchors) | | | | |
| `src/components/settings/thresholds-editor-section.tsx` | | | X (min/max attrs) | | | | |
| `src/components/settings/api-section.tsx` | | | | | X (3-table card-list parity) | | |
| `src/components/admin/_shared.tsx` | | | | | | | X (SettingsToggle stacking) |
| `src/components/admin/general-settings-section.tsx` | | | seq (reminder minutes attrs — different lines) | | | | X (NativeSelect import + inline SettingsToggle stacking) |
| `src/components/admin/login-overview-section.tsx` | | | | | X (pagination + CSV move-out) | | |
| `src/components/admin/app-log-preview-section.tsx` | | | | | X (pagination move-out) | | |
| `src/components/admin/feedback-inbox-section.tsx` | | | | | | | X (TabsList overflow-x) |
| `src/components/ui/dropdown-menu.tsx` | | X (DropdownMenuItem min-h-11) | | | | | |
| `src/components/ui/button.tsx` | | X (h-10 default) | | | | | |
| `src/components/ui/select.tsx` | | X (h-10 trigger default) | | | | | |
| `src/components/ui/empty-state.tsx` | | | | | | | X (ctaSize / w-full prop) |
| `src/components/ui/native-select.tsx` (new) | | | | | | | X (new primitive) |
| `src/components/ui/responsive-sheet.tsx` (new) | X (new primitive) | | | | | | |
| `src/components/error-details.tsx` | | X (action-row sizes) | | | | seq (min-h-dvh wrapper — different lines) | |
| `src/lib/insights/coach-launch-context.tsx` (new) | | | | X (new provider) | | | |
| `src/components/insights/coach-launch-button.tsx` (new) | | | | X (new component) | | | |
| `src/app/insights/layout.tsx` | | | | X (drawer mount + provider) | | | |
| `src/app/insights/page.tsx` | | | | X (consume context instead of inline mount) | | | |
| `src/app/insights/blutdruck/page.tsx` | | | | X (CoachLaunchButton + reuse layout) | | seq (empty-state CTA href — different lines from MB4) | |
| `src/app/insights/gewicht/page.tsx` | | | | X | | seq (empty-state CTA href) | |
| `src/app/insights/puls/page.tsx` | | | | X | | seq (empty-state CTA href) | |
| `src/app/insights/stimmung/page.tsx` | | | | X | | | |
| `src/app/insights/medikamente/page.tsx` | | | | X | | | seq (medication card header min-w-0 + truncate — different lines) |
| `src/app/insights/bmi/page.tsx` | | | | X | | seq (empty-state CTA href) | |
| `src/app/insights/schlaf/page.tsx` | | | | X | | | |
| `src/app/page.tsx` | | | | | | | X (tile strip flex overflow-x on `<sm`) |
| `src/app/measurements/page.tsx` | | | | | | X (consume `?add=` query param + open dialog) | |
| `src/app/auth/login/page.tsx` | | X (back-to-passkey link min-h-11) | seq (email/password inputMode + aria-invalid — different lines) | | | | seq (p-6 sm:p-8 card padding — different lines) |
| `src/app/auth/register/page.tsx` | | | seq (form inputMode + aria-invalid — different lines) | | | X (submit min-h-11 + size lg) | seq (p-6 sm:p-8 card padding — different lines) |
| `src/app/privacy/page.tsx` | | X (header links min-h-11) | | | | X (safe-area + TOC + `break-all` HK list) | |
| `src/app/about/page.tsx` | | X (header links min-h-11) | | | | X (safe-area on header) | |
| `src/app/global-error.tsx` | | | | | | X (safe-area + dvh + button padding) | |
| `src/app/not-found.tsx` (new) | | | | | | X (new file) | |
| `src/components/layout/auth-shell.tsx` | | | | | | X (PUBLIC_PATHS add /about) | |

### Same-line collisions

**Zero.** Every shared file row above either:
1. Both buckets edit different line ranges (e.g. `measurement-form.tsx` — MB1 wraps the entire form in `<ResponsiveSheet>` at the mount site, MB2 edits the reset kebab inside the form body, MB3 edits the individual `<Input>` props throughout — three disjoint touch zones).
2. One bucket folds the other's touch into a single commit so only one bucket actually edits the file (e.g. `dropdown-menu.tsx` — only MB2 touches).
3. The bucket dependency is sequenced via the dispatch plan (e.g. MB1's `<ResponsiveSheet>` primitive must land before MB4 can branch the Coach drawer; the same `coach-drawer.tsx` line range is owned by exactly one of those buckets per the sequence below).

### Sequenced edits documented

1. **`src/components/ui/dialog.tsx`** — MB1 adds `max-h-[calc(100dvh-2rem)] overflow-y-auto` to the `DialogContent` className (line 64 area). MB2 patches the close-X `<DialogClose>` element (line ~71-77) to grow the tap target via wrapper utility. Different element / different lines. MB1 lands first; MB2 dispatcher prompt names the close-X line range explicitly.

2. **`src/components/ui/input.tsx`** — MB2 lifts the default `h-9` → `h-10`. MB3 derives `inputMode` defaults from the `type` prop. Different concerns, different parts of the same file. MB2 lands first (no schema impact); MB3 layers the `inputMode` logic on top.

3. **`src/components/insights/coach-panel/coach-drawer.tsx`** — MB1 retires the Coach settings sheet close-X via the consumer-side pattern (lines 140-145 reference). MB2 touches the drawer header icons + window-pill sizing (lines 320-393). MB4 adds the `<sm` bottom-sheet branch on `<SheetContent>` (lines 257-279). Three disjoint zones; dispatch order MB1 → MB2 → MB4.

4. **`src/components/medications/medication-form.tsx`** — MB1 wraps the entire form mount in `<ResponsiveSheet>` (caller-side, outside the form file). MB3 adds `inputMode` / `enterKeyHint` / `type="time"` / iOS-zoom `text-base` on the individual `<Input>` calls throughout. MB6 swaps the day-of-week row to `grid grid-cols-7` (lines 869-903 + 653-674). MB2 lifts any sub-44 spot inside the form (e.g. reset kebab at lines 402-414). Four disjoint zones; dispatch order MB1 → MB2 → MB3 → MB6 (MB6 last because it depends on no other bucket but cannot conflict with the others).

5. **`src/components/error-details.tsx`** — MB2 lifts action-row button sizes (lines 85-108). MB6 adds `min-h-dvh flex flex-col items-center justify-center` to the outer wrapper (line 76 area). Different lines; either order works; MB2 first per dispatch sequence.

6. **`src/app/auth/register/page.tsx`** — MB6 lifts the submit `<Button>` to `min-h-11 size="lg" w-full` (line 132). MB3 adds aria-invalid / aria-describedby + inputMode + enterKeyHint to the form inputs (lines 78-117) and to the form-level error block (lines 123-130). MB7 adjusts card padding to `p-6 sm:p-8` (line 62). Three disjoint zones; dispatch order MB3 → MB6 → MB7.

7. **`src/components/insights/coach-panel/message-thread.tsx`** — MB2 lifts the thumbs feedback row (lines 544-563). MB3 swaps `<details>` → controlled `aria-expanded` (lines 426-484). MB4 adds the `visualViewport` resize listener (lines 193-199 area). Three disjoint zones; dispatch order MB2 → MB3 → MB4.

8. **`src/app/insights/blutdruck/page.tsx` and siblings** — MB4 mounts `<CoachLaunchButton>` near the page header. MB6 changes the empty-state CTA `href`. Different lines; either order works.

---

## Section 4 — Decisions

Every "open question for the consolidator" raised in the seven audits, with a default decision so R3d does not stall.

### Decision A — `<ResponsiveSheet>` primitive shape

**Default-decided: Branch on viewport via shared primitive, `<md` sheet bottom, `≥md` Dialog.**

Shape:
```tsx
// src/components/ui/responsive-sheet.tsx
export function ResponsiveSheet({ children, ...props }: ResponsiveSheetProps) {
  const isMobile = useIsMobile(); // (max-width: 767px)
  if (isMobile) return <Sheet {...props}><SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto rounded-t-2xl">{children}</SheetContent></Sheet>;
  return <Dialog {...props}><DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">{children}</DialogContent></Dialog>;
}
```

`useIsMobile()` already exists (or is trivially added with `matchMedia` SSR-safe wrapping). Breakpoint `md` (768 px) matches the existing dashboard `md:hidden` / `md:block` switches. Composition mirrors shadcn upstream pattern.

Consumers swap `<Dialog>` → `<ResponsiveSheet>` and the rest of the form markup is preserved. Sticky bottom-CTA pattern works the same on both branches because the form chrome is unchanged.

### Decision B — `<TouchTarget>` primitive vs primitive defaults

**Default-decided: Lift primitive defaults directly; no `<TouchTarget>` wrapper.**

Rationale: A `<TouchTarget>` wrapper adds an extra component to every interactive element across the entire app — fights React composition rather than embraces it. The cleaner pattern is to lift `<Button>` / `<Input>` / `<Select>` / `<DropdownMenuItem>` defaults to 40-44 px and add a `data-[size=lg]` opt-in for primary form controls that need explicit 44 px. The per-callsite `min-h-11` overrides we already have can drop once the primitive ships the lift.

### Decision C — Compliance heatmap touch parallel

**Default-decided: Tap-to-pin tooltip, not bottom-sheet, not long-press.**

Rationale: Bottom-sheet for a per-cell detail is heavy; long-press is invisible affordance. Tap-to-pin matches Apple Health's heatmap UX:
- First tap on cell: pins the tooltip near the cell with the taken/expected/on-time breakdown.
- Second tap on a different cell: moves the tooltip.
- Tap outside: closes the tooltip.
- `onPointerEnter` / `onPointerLeave` run in parallel for mouse + pen users.

### Decision D — TOC on `/privacy`

**Default-decided: Collapsible `<details>` block, default-closed on `<md`, default-open on `md:`.**

Rationale: Zero JS, semantic, no new dependency, no Sheet from public surface. Each anchor is `<a href="#${id}">`. Matches the page's static-server-rendered shape. The HTML `<details open={isAboveMd}>` attribute can be driven by Tailwind's `[&:not([open])>summary>svg]:rotate-0` pattern, or simpler: render two `<details>` elements with `hidden md:block` vs `md:hidden` and let the user pick.

### Decision E — Empty-state CTA route regression (`/measurements/new`)

**Default-decided: Re-route via `?add=<TYPE>` query param on `/measurements`, do not build `/measurements/new` route.**

Rationale (matches MA4 open-question (a) recommendation): Option (b) is the smaller change and reuses existing dialog plumbing. `/measurements?add=BLOOD_PRESSURE` lands on the existing list page; a `useEffect` reads `searchParams.get("add")` and opens the dialog with the matching `defaultType`. Four CTA call sites get a one-line href swap. A full `/measurements/new` route is the right answer when v1.5 wants a deep-linkable / share-friendly form, and lands as a v1.5 mobile-web fallback to the iOS native sheet.

### Decision F — Coach mount strategy

**Default-decided: `insights/layout.tsx` + `CoachLaunchProvider` context.**

Rationale (matches MA3 open-question recommendation): The cleanest fix is layout-level mounting + context provider. MA3 owns the layout + provider mount; MB4 carries every sub-page's `<CoachLaunchButton>` placement in lock-step (one commit, seven files). The existing `/insights/page.tsx` inline mount refactors to consume the same context. Same pattern eventually fixes the `/targets/page.tsx` duplication (out of scope for v1.4.27 — keep `/targets` as-is until v1.4.28).

### Decision G — Bottom-sheet primitive scope across medication entry-points

**Default-decided: Primary "log this thing" flows (medication form, intake create/edit, side-effect log, inventory add) flip to `<ResponsiveSheet>`. Settings-style flows (PhaseConfig, ApiEndpoint, IntakeImport) stay centred `<Dialog>`.**

Rationale (matches MA5 open-question response): The user-mental-model distinction is "log a measurement-like event" (bottom-sheet) vs "configure a parameter" (centred dialog). PhaseConfig and ApiEndpoint are configuration; IntakeImport is one-off bulk paste. Bottom-sheet would be wrong for those. Centred dialog with `max-h-[90vh] overflow-y-auto` is the right shape and already-correct elsewhere.

### Decision H — `inputMode` repo-wide sweep scope

**Default-decided: Sweep every form input in the app, derive sensible defaults from the `<Input>` primitive.**

Rationale (matches MA3 open-question (F8) + MA6 open-question (F6)): The cost is one attribute per input. The benefit is keyboard-quality across every flow. The `<Input>` primitive grows `type`-derived defaults:
- `type="number"` → `inputMode="decimal"` (or `numeric` for integer-only call sites; consumer can override)
- `type="email"` → `inputMode="email"`
- `type="url"` → `inputMode="url"`
- `type="tel"` → `inputMode="tel"`
- default → no `inputMode`

Consumers add `enterKeyHint` explicitly because it depends on form position (next vs done vs send vs go), not type.

### Decision I — Dialog close-X owner

**Default-decided: MB2 owns the `<DialogClose>` size lift inside `dialog.tsx`.**

Rationale (matches MA6 open-question (F17) escalation): The primitive lives in `src/components/ui/dialog.tsx`. MB1 grows the `DialogContent` max-height cap; MB2 grows the close-X tap target. Distinct edits in the same file; no same-line collision (lines 64 vs 71-77). MB2 dispatcher prompt explicitly names the close-X.

### Decision J — Show / hide password toggle symmetry

**Default-decided: Single shared `<PasswordInput>` primitive consumed by auth + settings.**

Rationale (matches MA7 open-question (F8) recommendation): The `<PasswordInput>` primitive already exists in `src/components/settings/password-input.tsx`. Move it to `src/components/ui/password-input.tsx` (UI primitive); both auth pages import from there. MB2 grows the toggle wrapper to `inline-flex h-11 w-11`; MB3 adds `aria-pressed` + translated `aria-label`. Auth pages and settings consume one primitive.

### Decision K — `/about` standalone in v1.4.27 vs v1.4.28

**Default-decided: Lands in v1.4.27 (MB6).** Two-line fix, licence-compliance angle, reads Critical per CC BY-SA 4.0 attribution requirement.

### Decision L — `not-found.tsx` shape — branded vs minimal

**Default-decided: Lighter wrapper, mirrors auth-card geometry.**

Rationale (matches MA7 open-question (F3)): `ErrorDetails` is heavy (Logo, copy-details payload, bugreport link, retry button). For a missing-route 404 the user does not need retry — they need "you took a wrong turn, here's the way back". Light shell: `<Logo />` + translated H1 + translated paragraph + "Back to dashboard" `<Button asChild className="min-h-11">`. Optional report-link slot reserved for if v1.4.28 wants it.

### Decision M — F11 sub-page-shell focus + scroll behaviour

**Default-decided: Gate the `focus()` call on a keyboard-navigation detection.**

Rationale (matches MA2 open-question): The scroll-reset is intentional (matches Apple Health and similar surfaces). The programmatic focus is for screen-reader users. Detection pattern: set a `data-input-modality="keyboard"` attribute on `<body>` when the user presses Tab; clear on `pointerdown`. Gate the `focus()` call inside `useEffect` on `document.body.dataset.inputModality === "keyboard"`. Honour `prefers-reduced-motion` for the scroll itself.

### Decision N — Carrier chip layout when admin card-list lands

**Default-decided: Inline secondary chip next to provider chip; never stacked block.**

Rationale (matches MA6 open-question via F3): When MB5 lands the admin card-list (deferred to v1.4.28 per severity policy), carrier renders as an inline secondary chip next to the provider chip (`gap-1`, both `text-[10px]`). The current desktop block layout stays as-is until then.

### Decision O — F2 admin tables card-list — single contributor vs per-table

**Default-decided: Deferred to v1.4.28; when it lands, single contributor, one bucket.**

Rationale: L effort × 6 surfaces. v1.4.27 cannot absorb the budget; v1.4.28 takes it as one focused contributor bucket. The skeleton is mechanical (3 admin sections already prove the pattern) so a single contributor can land all six in one ladder.

---

## Section 5 — Severity application policy

Per the round-plan brief:

- **Critical (6 findings):** Apply unconditionally in v1.4.27. All six landed in MB1, MB6, or split across MB1 + MB2 + MB3.
- **High (23 consolidated findings after dedup):** Apply unconditionally in v1.4.27. One exception: CF-20 (six admin tables miss card-list) is L effort × 6 surfaces and **deferred to v1.4.28**. Every other High lands in MB1-MB7.
- **Medium (37 consolidated findings):** Apply if effort ≤ M. Items at effort M land in their owning bucket; items at effort L (CF-78 DatePicker, CF-79 RHF migration, CF-80 bottom-sheet repo-wide expansion beyond MB1's primary forms, CF-87 login overview filter progressive disclosure) defer to `.planning/v1428-backlog.md`.
- **Low (8 consolidated findings):** Apply only if a same-file fix already touches the spot (zero-cost pile-on). The Low items that land are listed inline in MB7's grouping (CF-67, CF-69, CF-70, CF-71, CF-73, CF-74, CF-75, CF-76). Low items where the same-file fix does not exist defer to v1.4.28 (CF-72 right-edge fade is borderline — keep in MB7 since it touches `insights-tab-strip.tsx` which is not otherwise touched, but the work is M-effort; demote to v1.4.28 if MB7 budget overflows).
- **Strategic defers (CF-77 through CF-90):** Catalogued for v1.4.28 backlog; the consolidator commit appends to `.planning/v1428-backlog.md` as a separate task — out of scope for this consolidator commit (this file is read-only planning).

---

## Section 6 — Dispatch sequence for R3d

R3d runs in two ordered passes with one parallel cluster each. The reason: primitive-level changes (MB1, MB2, MB3) cross every surface and must be locked in before the surface-bucket contributors build on them.

```
R3d Pass 1 — primitive-level work (3 parallel slots)
    ├── MB1: ResponsiveSheet primitive + dialog cap + form mounts
    ├── MB2: Sub-44 pt tap-target primitive lift + surface sweep
    └── MB3: inputMode / enterKeyHint / aria sweep + Coach composer Popover + Coach evidence Collapsible

R3d Pass 2 — surface buckets (4 parallel slots) — runs after Pass 1 closes
    ├── MB4: Coach reachability layout-mount + Checkbox swap + visualViewport listener
    ├── MB5: /settings/api card-list parity + admin pagination/CSV move-out
    ├── MB6: Schedule grid swap + /about public path + empty-state CTA route + not-found.tsx + safe-area + TOC + DrugLevelChart dead label
    └── MB7: Surface-specific polish residue (chart heights, heatmap, HSC, EmptyState, NativeSelect, titration, scheduling, integrations, etc.)
```

### Pass 1 commit gates

- MB1 must merge before MB4's Coach drawer bottom-sheet branch (CF-9 depends on `<ResponsiveSheet>`). MB4 can start the layout / provider work in parallel; only the bottom-sheet branch commit needs to wait.
- MB2 must merge before MB6's register submit lift (no conflict, but contributor reads from the primitive). Trivially independent in practice — MB6 can start immediately.
- MB3 must merge before MB4's Coach composer Tooltip → Popover work overlaps with MB3's same edit. **Note:** MB3 owns the Tooltip → Popover swap; MB4 does not touch `coach-input.tsx`. No conflict.

### Pass 2 commit gates

- MB4 can rebase its bottom-sheet branch commit on top of MB1 cleanly; the rest of MB4 (provider + per-sub-page CTA + Checkbox swap) is independent of MB1/MB2/MB3.
- MB7 touches the most files; its commits should land last in the pass to minimize merge conflicts with the surface-specific commits.

### Contributor count

- Pass 1: 3 contributors.
- Pass 2: 4 contributors.
- Wall-clock peak: 4 parallel slots in Pass 2 (matches the 4-6 R3d slot count specified in the round plan).

### Per-bucket gate compliance

Every R3d contributor follows:
- Branch model: commit to `develop`. Never `main`. No PR.
- Forbidden words: AI, Claude, agent, marathon, wave, phase, session, subagent, Anthropic. Use round, pass, contributor, slot, automation, release work.
- Per-commit gate: `pnpm typecheck` + `pnpm lint` + relevant `pnpm test`. Hook failure → fix + new commit (never `--amend`, never `--no-verify`).
- Atomic commits per logical sub-task.
- No `Co-Authored-By: Claude` trailer. No `--no-gpg-sign`.
- Each writes a short report at `.planning/round-3d-<bucket>-report.md`.

---

## Section 7 — Headline metrics

| Metric | Value |
|---|---|
| Raw findings across all seven audits | 120 |
| Consolidated findings after de-dup | 74 (CF-1 through CF-74 in tiers; 16 additional CF-77 through CF-90 catalogued for v1.4.28) |
| Severity distribution (post-dedup) | Critical 6 · High 23 · Medium 37 · Low 8 |
| Fix-surface buckets | 7 (MB1 through MB7) |
| Items applied in v1.4.27 | ~66 (every Critical + every High except CF-20 + every Medium ≤ M + every same-file Low) |
| Items deferred to v1.4.28 | ~14 (CF-20 admin card-list + CF-77 through CF-90 strategic defers) |
| File-touch same-line collisions | 0 |
| Sequenced edits documented | 8 (in Section 3) |
| New primitives shipped | 3 (`<ResponsiveSheet>`, `<NativeSelect>`, `<CoachLaunchProvider>`) |
| New routes shipped | 1 (`/not-found`) |
| Repo-wide sweeps | 2 (`inputMode` derivation in `<Input>`; sub-44 lift across `<Button>`/`<Input>`/`<Select>`/`<DropdownMenuItem>`/`<DialogClose>`) |

---

## Anti-goals (carried from `.planning/v1427-mobile-plan.md`)

- No new framework migrations.
- No new component-library swaps. Patch local shadcn copies to match upstream where divergent.
- No mobile-only routes or PWA scope expansion.
- No iOS-side code (lives in `healthlog-iOS` repo).

## Done when

- Every Critical + High consolidated finding has landed via R3d commits on `develop`.
- Every effort-≤-M Medium consolidated finding has landed.
- Every same-file Low consolidated finding has landed.
- Every R3d contributor has written a `.planning/round-3d-<bucket>-report.md`.
- The release CHANGELOG entry for v1.4.27 carries a "Mobile capability" section under the headline groups.
- Deferred items appended to `.planning/v1428-backlog.md` in a separate commit (not part of this consolidator commit).
