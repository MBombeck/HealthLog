---
file: .planning/research/v1427-r3c-mobile-coach.md
purpose: Mobile capability audit — Coach panel and sub-components
created: 2026-05-15
auditor: MA3
---

# Mobile audit — Coach panel surface

## Summary

Reviewed 9 components under `src/components/insights/coach-panel/` (drawer
shell, drawer-body, composer, message thread, settings sheet, history rail,
sources rail, source chips, use-coach hook) plus the four launch surfaces
that feed the drawer (`hero-strip.tsx`, `suggested-prompts.tsx`,
`health-score-card.tsx`, `target-coach-button.tsx`).

17 findings: 1 Critical, 5 High, 8 Medium, 3 Low. The drawer's structural
choices are sound for mobile (full-width Sheet, `100dvh`, rail-tray
chevrons, persistent thread disclaimer, `max-w-[80%]` bubbles, `aria-live`
on the streaming bubble). The mobile hostility lives in three clusters:
(a) the Coach is unreachable from any insight sub-page (`/insights/blutdruck`
and siblings never mount the drawer), (b) several controls sit below the
44 pt touch-target minimum (window pill, thumbs feedback, history-rail
delete, settings-sheet default close X, info-icon hint), and (c) two
hover-only affordances (history-rail delete `opacity-0 group-hover:opacity-100`,
Radix Tooltip without a tap toggle) silently degrade on touch.

## Findings

### F1 — Coach drawer not mounted on insight sub-pages
- Severity: Critical
- Axis: logic
- File: `src/app/insights/blutdruck/page.tsx`, `gewicht/page.tsx`, `puls/page.tsx`, `stimmung/page.tsx`, `medikamente/page.tsx`, `bmi/page.tsx`, `schlaf/page.tsx` (none import `CoachDrawer`); only `src/app/insights/page.tsx:221` and `src/app/targets/page.tsx:285` mount it.
- Symptom: From any insights sub-page a user has no path to the Coach. The CTA Marc designed into the hero strip (B1 retirement of the HSC button moved the affordance to the action row) only exists on `/insights` itself, and the seven sub-pages render their own status-card surfaces with no equivalent. On a phone where the user lands on `/insights/blutdruck` from a deep-link push, there is literally no Coach entry point.
- Evidence: `grep -rn "CoachDrawer" src/app/insights/` returns only `page.tsx` and `layout.tsx` (the latter comments that the drawer is "NOT mounted in this layout"). The launcher prop chain in the hero is also unique to `/insights/page.tsx`.
- Recommended fix: Move the drawer mount to `src/app/insights/layout.tsx` with a layout-level `useState` + a context provider (`CoachLaunchProvider`) that exposes `askCoach(prefill, scope)` to every child page. Sub-pages render a `<CoachLaunchButton>` (sticky FAB on `<lg`, inline action on `lg+`) wired to the context. Same pattern fixes the `/targets` duplication.
- Effort: M

### F2 — Suggested-prompt chip below 44 pt touch minimum
- Severity: High
- Axis: visual
- File: `src/components/insights/suggested-prompts.tsx:73` — `inline-flex min-h-9 ... px-3.5 py-2 text-[13px]`.
- Symptom: The 5-chip launch row is the primary entry to the Coach from the hero. `min-h-9` resolves to 36 px (Tailwind v4 `9*0.25rem`). WCAG 2.2 AA + Apple HIG floor is 44 × 44 pt. Adjacent chips wrap to the same row with `gap-2` (8 px) — on a 375 px iPhone the first row tap zones are too narrow to hit reliably.
- Evidence: Class string `min-h-9`. Computed height = 36 px; padding `py-2` adds ~16 px to inner — Tailwind `min-h` is a floor, not a fixed height, so chips with single-line labels (`"Why was Monday rough?"`) come in at 36 px.
- Recommended fix: Bump to `min-h-11` (44 px) plus the existing `py-2`. Drop one chip from the default set on `<sm` if the row still wraps into more than two lines (the visual budget is tight enough that 4 chips on a 320 px viewport already crowds out the section heading).
- Effort: S

### F3 — Window-pill in drawer header below touch minimum
- Severity: High
- Axis: visual
- File: `src/components/insights/coach-panel/coach-drawer.tsx:320-330` — `<SelectTrigger size="sm" className="... h-7 ...">`.
- Symptom: The per-conversation window override (`Last 7 / 30 / 90 days / All time`) is a 28 px tall pill (`h-7`) tucked between the title and the three header icon-buttons. On a 320 px viewport it sits ≈ 60 px from the right edge, with a tap zone smaller than the user's fingertip.
- Evidence: Class `h-7 ... rounded-full px-2.5 text-[11px]`. The Radix `<SelectTrigger>` does not internally expand its hit target — the rendered button stays exactly 28 × ~70 px.
- Recommended fix: Raise the pill to `h-9` (36 px) and accept the slightly taller header — the surrounding icon-buttons are already `size-9`, so the row baselines remain aligned. The pill text stays `text-[11px]`; only the chrome grows.
- Effort: S

### F4 — Per-message thumbs feedback row well below touch minimum
- Severity: High
- Axis: visual
- File: `src/components/insights/coach-panel/message-thread.tsx:544-563` — both `<button>`s use `inline-flex ... px-1.5 py-0.5 text-[11px]`.
- Symptom: The 👍 / 👎 row sits under every persisted assistant bubble. Rendered hit target is ≈ 22 × 60 px each. On mobile the user mis-taps onto the bubble (`max-w-[80%]` block above) or the disclaimer (`pt-2` below) more often than the rating button. The feedback loop is the only mechanism the v1.4.23 aggregator uses to bucket prompt-version quality — undersized targets corrupt the signal.
- Evidence: Class `px-1.5 py-0.5 text-[11px]`. No `min-h-*` floor; the `text-[11px]` line height alone determines the row.
- Recommended fix: Add `min-h-9 px-2` (36 × ≥ 60 px); the two buttons still sit on one row inside the `max-w-[80%]` bubble column. The icon stays `size-3`.
- Effort: S

### F5 — History-rail delete uses hover-only affordance + 24 px hit target
- Severity: High
- Axis: logic + visual
- File: `src/components/insights/coach-panel/history-rail.tsx:141-160` — `Button size="icon"` with `className="size-6 ... opacity-0 transition-opacity group-hover:opacity-100"`.
- Symptom: Two compounding mobile-hostile patterns. (a) `opacity-0 group-hover:opacity-100` — touch has no hover, so the trash icon is permanently invisible to a finger user; the only way to delete a conversation on mobile is via the desktop pointer. (b) `size-6` resolves to 24 × 24 px, half the 44 pt minimum even when revealed. Confirmed inside the history side-tray (`<lg`) so it is reachable on mobile, just not actionable.
- Evidence: `opacity-0 group-hover:opacity-100` class + `size-6` class on the icon-button.
- Recommended fix: Promote the delete to a permanent visible action on `<lg` (drop `opacity-0`), and bump to `size-9`. Better: replace with a swipe-to-delete gesture on the row inside the tray; the desktop hover-reveal stays on `lg+`. Reuse the medications swipe pattern landing in v1.4.27 R3d if MA4 surfaces one.
- Effort: M

### F6 — Settings-sheet default close X is a 16 px target
- Severity: High
- Axis: visual + code
- File: `src/components/insights/coach-panel/coach-settings-sheet.tsx:140-145` (uses default `showCloseButton`); `src/components/ui/sheet.tsx:78-83` — `absolute top-4 right-4 rounded-xs opacity-70 ... <XIcon className="size-4" />`.
- Symptom: The settings sheet opens stacked over the Coach drawer. The only way to dismiss without saving is the absolutely-positioned close X — a 16 × 16 px icon with no padding, `opacity-70`. Marc explicitly retired this default in the drawer header (`coach-drawer.tsx:266` `showCloseButton={false}` + replaced with `size-9` ghost button), but the settings sheet still inherits the default. The cluster the drawer fixed (settings cog vs close X collision flagged in `feedback_v1421_post_deploy_polish`) is back inside the nested sheet.
- Evidence: `coach-settings-sheet.tsx` does not pass `showCloseButton={false}`; the `<SheetContent>` default is `true`. The default Close primitive has no `size-*` class — only the `XIcon` sets `size-4`.
- Recommended fix: Mirror the drawer's H4 pattern — pass `showCloseButton={false}` and render an in-header `<SheetClose asChild>` with the `Button variant="ghost" size="icon"` shape. Drop the `pr-12` reservation in the header at the same time (no longer needed).
- Effort: S

### F7 — Info-icon hint tooltip not touch-toggleable
- Severity: Medium
- Axis: logic + code
- File: `src/components/insights/coach-panel/coach-input.tsx:191-212` — Radix `<Tooltip>` wraps a `<button>` with no `onClick`.
- Symptom: B4 just landed this tooltip to replace the verbose "Enter to send, Shift+Enter for new line" prose footer. Radix Tooltip opens on `pointerdown`/long-press on touch but the user's mental model is tap → toggle. With no `onClick` and no `onPress` toggle, a single tap opens the tooltip and then immediately dismisses it (or never opens it at all on browsers that suppress synthetic hover events). The translated string is the only place where the keyboard shortcut hint lives — losing it on touch removes the affordance entirely.
- Evidence: `<TooltipTrigger asChild><button type="button" aria-label={t(...)} ... ><Info /></button></TooltipTrigger>` with no `onClick`/`onPointerDown`. Radix `Tooltip.Root` doesn't expose a `triggerEvent="click"` mode; the upstream guidance is `<Popover>` for tap-toggle.
- Recommended fix: Swap `<Tooltip>` → `<Popover>` (shadcn already ships `popover.tsx`). The `<Info />` button stays the trigger; the popover content is the same translation string. Add `aria-haspopup="dialog"` to the trigger. Keeps the tooltip-style appearance with proper tap behaviour on mobile.
- Effort: S

### F8 — No `enterKeyHint` on the composer textarea
- Severity: Medium
- Axis: code
- File: `src/components/insights/coach-panel/coach-input.tsx:162-182`.
- Symptom: The Coach composer is the only multi-line text-entry surface where Enter actually submits (vs. Shift+Enter for newline). On iOS Safari + Android Chrome the on-screen keyboard's return key reads "return" / "↵" with no indication that it sends — the user pulls up the keyboard, types a question, then hunts for the send button instead of using the return key. WCAG-adjacent UX gap.
- Evidence: `<textarea ... rows={1} className="..." />` — no `enterKeyHint`, no `autoComplete`, no `inputMode`.
- Recommended fix: Add `enterKeyHint="send"` to the textarea. Optional: `autoComplete="off"` + `autoCapitalize="sentences"` (sentence-case the first word of a question is sane). No `inputMode` needed — text is the right default.
- Effort: S

### F9 — Evidence disclosure missing `aria-expanded`
- Severity: Medium
- Axis: code
- File: `src/components/insights/coach-panel/message-thread.tsx:426-484` — `<details>` + `<summary>` with `aria-controls={evidencePanelId}` only.
- Symptom: B4 collapsed the evidence disclosure to closed-by-default and the disclosure now relies on the native `<details>` toggle. The summary has `aria-controls` but no `aria-expanded`, so VoiceOver / TalkBack announce "button, collapsed" only on browsers that synthesise the state from the `<details open>` attribute — which Safari does correctly but older Android WebView builds do not. Screen-reader users on the affected platforms hear no state change after tapping the disclosure.
- Evidence: `<summary aria-controls={evidencePanelId} ...>` with no `aria-expanded={isOpen}` and no React state mirror — the summary is a native `<details>` summary so we'd need to track the `onToggle` event to drive a stateful `aria-expanded`.
- Recommended fix: Either (a) keep `<details>` and trust the platform — but document the Android WebView gap as known, or (b) replace with a controlled `<button aria-expanded={open}>` + sibling panel, which is the shadcn `<Collapsible>` pattern. Option (b) is preferable for clinical-adjacent UI where SR consistency matters; effort is small because the state already exists implicitly.
- Effort: S

### F10 — Mobile rail-tray triggers float over the message thread without keyboard accommodation
- Severity: Medium
- Axis: visual + logic
- File: `src/components/insights/coach-panel/coach-drawer-body.tsx:65-91` — two absolutely-positioned `Button` chips at `top-2 left-2` and `top-2 right-2` with `z-10`.
- Symptom: On mobile the two chevron buttons overlay the message thread's first message. With a long first user message + the disclaimer pinned at the bottom, the user's bubble starts behind the chevron buttons (which use `bg-background/80 backdrop-blur` but still occlude the first ~28 px of text). On viewports `<sm` (320 px) the right-edge "Sources" chevron sometimes overlaps the close button of a recently-opened sheet because both are positioned absolutely without checking each other.
- Evidence: Classes `absolute top-2 left-2 z-10 h-7` and `absolute top-2 right-2 z-10 h-7`. The thread scroller starts at `min-h-0 flex-1` with no top-padding reservation.
- Recommended fix: Lift the chevron triggers out of the thread overlay and into a real sub-header strip beneath the main `SheetHeader` (`<lg` only). The strip is `flex items-center justify-between px-3 py-2 border-b` and reserves vertical space rather than overlaying content. Keeps the same affordance; drops the occlusion.
- Effort: M

### F11 — Composer textarea does not autofocus on drawer open
- Severity: Medium
- Axis: logic
- File: `src/components/insights/coach-panel/coach-drawer.tsx:218-245` (handleSubmit + handleOpenChange); `coach-input.tsx:90-126` (no `autoFocus`, no exposed focus method).
- Symptom: User taps "Ask the coach", drawer slides in, composer is empty (or pre-filled by a suggested-prompt chip), but the on-screen keyboard is not summoned. The user must tap the textarea to bring up the keyboard — an extra step on every Coach session. The pattern Apple Messages, Telegram, ChatGPT mobile all share is: open chat → keyboard up automatically.
- Evidence: No `autoFocus`, no `useEffect(() => textarea.focus(), [open])`, no `inputRef.current?.focus()` call inside `CoachDrawer` on open transition. The Sheet's default focus management lands on the first focusable element — which is the close X / new-chat / window-pill (depending on header tab order), not the textarea.
- Recommended fix: Expose `useRef<HTMLTextAreaElement>` via `CoachInputProps.inputRef`, and have the drawer focus it inside a `useEffect(() => { if (open) requestAnimationFrame(() => ref.current?.focus()) }, [open])`. The `requestAnimationFrame` waits for the Sheet animation to finish so iOS Safari doesn't suppress the focus().
- Effort: S

### F12 — Composer hint button is 28 px square, below touch minimum
- Severity: Medium
- Axis: visual
- File: `src/components/insights/coach-panel/coach-input.tsx:194-206` — `<button className="... inline-flex h-7 w-7 ...">`.
- Symptom: The new info-icon trigger sits next to the send button. `h-7 w-7` = 28 × 28 px. Even after fixing F7 (tap-toggle), the trigger is below the 44 pt floor. Adjacent to the send button (`<Button size="sm">` ≈ 36 px tall) — mis-tap risk is real.
- Evidence: Class `h-7 w-7 ... rounded`.
- Recommended fix: Bump to `h-9 w-9` and add `-mr-1` if the row needs visual rebalancing relative to the send button. Same change pairs naturally with the F7 popover swap.
- Effort: S

### F13 — Source-chip provenance row hard to tap (sub-20 px)
- Severity: Medium
- Axis: visual
- File: `src/components/insights/coach-panel/source-chips.tsx:97-116` — `<span className="... px-2 py-0.5 text-[11px] leading-none">`.
- Symptom: Source chips are styled as static `<span>`s with `py-0.5` (~2 px) and `leading-none` — rendered at ≈ 18 px tall. They are decorative today (the chip-click is a no-op per the B3 deferral comment), but if the chart-deeplink feature lands in v1.5 the same chips need real touch targets. Flagged here so the swap doesn't reintroduce a sub-44 pt regression.
- Evidence: Class `px-2 py-0.5 text-[11px] leading-none`. No interaction handler in v1.4.27.
- Recommended fix: When the chip becomes interactive, bump to `min-h-7` + `py-1` and wrap in a `<button>`. Defer the visual change until the deeplink lands; flag in `v1428-backlog.md`.
- Effort: S (when interactive)

### F14 — Sources rail checkbox uses native input without `min-h-11`
- Severity: Low
- Axis: visual
- File: `src/components/insights/coach-panel/sources-rail.tsx:236-251` — `<input type="checkbox" className="size-4 ..." />` inside a row with `min-h-9 py-1.5`.
- Symptom: The row is 36 px tall (`min-h-9`) and the checkbox itself is 16 px (`size-4`). The accompanying `<label>` extends the hit target across the row, but native browser checkbox behaviour on iOS Safari sometimes restricts tap to the checkbox glyph itself — labels work most of the time, but Safari has historic bugs with label-driven checkbox toggle on touch.
- Evidence: Native `<input type="checkbox">` rather than the shadcn `<Checkbox>` component (which wraps Radix `Checkbox.Root` with a built-in 16 × 16 visual + tap surface that delegates to the parent).
- Recommended fix: Swap to `import { Checkbox } from "@/components/ui/checkbox"`. Same row size, same visual, but Radix handles the click delegation reliably. The row already has `min-h-9` — bump to `min-h-11` while you're there.
- Effort: S

### F15 — `lg:!max-w-[min(960px,75vw)]` uses Tailwind `!` important modifier
- Severity: Low
- Axis: code
- File: `src/components/insights/coach-panel/coach-drawer.tsx:277`.
- Symptom: Tailwind v4 keeps the `!` important modifier but the shadcn upstream Sheet now exposes a width slot via CVA variants instead of `!important` overrides. Using `!max-w-*` flags the component as fighting against the underlying primitive's class authority — fine for v1.4.27 but worth refactoring once the upstream Sheet exposes a width prop.
- Evidence: Two `!max-w-*` classes on `<SheetContent>`.
- Recommended fix: Defer to v1.4.28+ — wrap a local `<CoachSheetContent>` variant with proper `cva` if the !important fights become a maintenance burden. No action in v1.4.27.
- Effort: M

### F16 — Drawer SheetTitle truncated on `<sm` when conversation title is long
- Severity: Low
- Axis: visual
- File: `src/components/insights/coach-panel/coach-drawer.tsx:289-306` — header with avatar + title-block + window-pill + 3 icon-buttons.
- Symptom: At 320 px viewport, header padding (`p-3` = 24 px horizontal) leaves 296 px. Icons (3 × 36 + 28 pill + 32 avatar = 168 px) + gaps (4 × 8 = 32 px) consume ~ 200 px. Title block gets ≈ 96 px — enough for ~12 characters of a conversation title (`SheetTitle text-sm font-semibold`) before truncation. Server-generated titles routinely exceed this.
- Evidence: Header math + `<SheetTitle className="truncate text-sm font-semibold">`. The truncate works as designed but in practice the user sees three dots immediately for most titles.
- Recommended fix: On `<sm`, hide the window-pill from the header and surface it inside the rail / sources tray. The pill is already mirrored on the sources rail's window selector (line 312-348 mirrors line 192-213 in sources-rail.tsx). Saves ~28 px of header width and lets the title breathe.
- Effort: S

### F17 — No keyboard-aware composer scroll when soft-keyboard opens
- Severity: Low
- Axis: logic
- File: `src/components/insights/coach-panel/coach-drawer.tsx:278` (`h-[100dvh]`) + `coach-drawer-body.tsx:48` (`grid min-h-0 flex-1`).
- Symptom: `100dvh` correctly tracks the dynamic viewport so the composer doesn't go under the keyboard on iOS, but the message thread does not re-scroll-to-bottom when the keyboard summons. The user types in the composer, the keyboard pushes the layout up, and the in-flight assistant bubble (or the last user message) may shift off-screen because `useEffect([messages.length, streaming?.content])` only runs on content change, not on resize.
- Evidence: `message-thread.tsx:193-199` — scroll runs on `[messages.length, streaming?.content, optimisticUser?.localId]`. No `window.visualViewport` listener.
- Recommended fix: Add a `useEffect` in `<MessageThread>` listening on `window.visualViewport?.addEventListener("resize", ...)` that re-pins to bottom if `wasPinnedRef.current` was true. Same code path as the existing auto-scroll; the listener just triggers the same scroll-to-bottom logic.
- Effort: S

## Headline metrics

- Components reviewed: 9 (coach-panel) + 4 launch surfaces = 13
- Findings by tier: C: 1  H: 5  M: 8  L: 3
- Mobile-hostile patterns flagged for B7-style symmetry pass: 4 (sub-44 pt targets, hover-only affordances, hover/focus-only opacity reveals, undersized close X)

## Open questions for the consolidator

- F1 — Coach reachability from sub-pages: the cleanest fix is layout-level mounting + context, but that crosses into MA2's surface (insights sub-pages). Decision needed on whether MA3 owns the drawer-mount move (touches `insights/layout.tsx` + every sub-page CTA) or MA2 picks up the per-sub-page CTA wiring. Recommend MA3 owns the layout + provider, MA2 owns the per-page launcher placement.
- F5 — Swipe-to-delete on history rail: align with whatever MA4 lands for the measurements list. Don't dispatch two divergent swipe-gesture implementations into v1.4.27.
- F7 + F12 stack — if F7 fix swaps Tooltip → Popover, F12 (size) becomes a single edit. Keep them in the same MB-bucket.
- F8 (`enterKeyHint`) — should it be added to every textarea/input in the repo as a B6-style sweep, or only to the Coach composer? Recommend a small repo-wide sweep in v1.4.27 since the cost is one line per surface.
- F14 (checkbox swap) — touches the shared sources-rail; if MA2 also touches sources-rail (e.g. for /insights status cards) the work should be merged in the consolidator dispatch matrix.
