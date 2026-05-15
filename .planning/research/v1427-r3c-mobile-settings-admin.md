---
file: .planning/research/v1427-r3c-mobile-settings-admin.md
purpose: Mobile capability audit — Settings + Admin surface
created: 2026-05-15
auditor: MA6
---

# Mobile audit — Settings and Admin

## Summary

Reviewed 23 settings components and 23 admin components across `/settings/[section]` and `/admin/[section]`. The two shells (`settings-shell.tsx`, `admin-shell.tsx`) already carry the mobile chip strip with 44px tap floors, and several wide tables (`account` passkeys, `admin/users`, `admin/api-tokens`) already ship `md:hidden` mobile card-list fallbacks. The remaining mobile-hostile patterns are concentrated in (a) the user-facing `/settings/api` token tables, which still force horizontal scroll, (b) the admin tables that never received the card-list treatment (`login-overview`, `feedback`, `backups`, `app-logs`, `ai-quality`, `coach-feedback`), and (c) input fields that universally lack `inputMode` / `enterKeyHint` mobile-keyboard hints. 19 findings; 0 Critical, 7 High, 7 Medium, 5 Low.

## Findings

### F1 — `/settings/api` tables force horizontal scroll on mobile
- Severity: High
- Axis: visual
- File: `src/components/settings/api-section.tsx:73-104,239-345,362-403`
- Symptom: Three tables (endpoint docs, active tokens, revoked tokens) carry hard `min-w-[760px]` / `min-w-[860px]` widths with no `md:hidden` card-list fallback. At 320-414 px the user has to swipe horizontally to see the "Last used", "Created", and "Revoke" cells; the Trash2 revoke button sits in the rightmost column and is invisible on first paint.
- Evidence: grep — `api-section.tsx:74 className="w-full min-w-[760px] text-xs md:min-w-0"`; `:240 min-w-[860px]`; `:363 min-w-[760px]`. No `md:hidden` mobile list, unlike the admin `api-token-overview` and `user-management` sections which already adopted the dual-table pattern.
- Recommended fix: Mirror `admin/api-token-overview-section.tsx`'s pattern — keep the `hidden md:block` desktop table, add a `md:hidden` card list (name + permissions + status badge + last-used line + revoke icon button per card).
- Effort: M

### F2 — Admin tables without card-list fallback
- Severity: High
- Axis: visual
- File: `src/components/admin/login-overview-section.tsx:371`, `feedback-inbox-section.tsx:123`, `backups-section.tsx:471`, `app-log-preview-section.tsx:207`, `ai-quality-section.tsx:134`, `coach-feedback-section.tsx:119`
- Symptom: Six admin tables sit inside `overflow-x-auto` with no mobile card-list. `login-overview` has 7 columns (status / user / action / provider / IP / location / timestamp), `feedback` 5, `backups` 5, `app-logs` 5, `ai-quality` 7, `coach-feedback` 7. At 393 px the user must horizontally scroll to see anything past the second column. The pattern was already adopted in three other admin tables (`users`, `api-tokens`, `account/passkeys`) — it's a symmetry gap.
- Evidence: grep `overflow-x-auto`+`<table>` finds 6 admin sections without the matching `md:hidden <ul>` block. `login-overview-section.tsx:371-477` renders the full table verbatim with no breakpoint switch. `ai-quality` and `coach-feedback` were just added in v1.4.23+ — newer tables, same mobile-hostile shape.
- Recommended fix: Per-table mobile card list. For `login-overview`: per-entry card with status icon + user + action + timestamp; collapsed IP/provider/location under an expander. For `feedback`: subject + category badge + user + date; click opens the existing detail dialog. For `backups`: per-row card with user + size + age + Download/Restore buttons. `app-logs`, `ai-quality`, `coach-feedback` can share the same skeleton.
- Effort: L

### F3 — Carrier chip stacks under provider in narrow column, no truncation
- Severity: Medium
- Axis: visual
- File: `src/components/admin/login-overview-section.tsx:437-463`
- Symptom: B3 just landed the carrier chip as a `block` element underneath the provider icon+label. The wrapper `<td>` has no `min-w-0`, so on a 320 px viewport (which forces horizontal scroll anyway per F2) the carrier label `Telekom`/`Vodafone` adds a second line to the row, increasing row height by ~14 px and pushing the table taller than expected. When the eventual mobile card-list lands per F2, the carrier chip needs to be planned as a sibling chip, not a second line, so the card stays compact.
- Evidence: `login-overview-section.tsx:455-462`: `<span className="text-muted-foreground/80 mt-0.5 block text-[10px] leading-tight">{carrierShortLabel(entry.carrier)}</span>`. The provider cell already has 3-4 lines worth of content; adding a fourth pushes row height past the 44 px tap-comfort floor.
- Recommended fix: When implementing the F2 card-list, render carrier as an inline secondary chip next to the provider chip (gap-1, both `text-[10px]`) instead of a stacked block. On desktop, the existing block layout is fine because the row already has 7 columns of horizontal real estate.
- Effort: S (folds into F2 patch)

### F4 — CSV-export and pagination buttons hidden behind table scroll on mobile
- Severity: High
- Axis: logic
- File: `src/components/admin/login-overview-section.tsx:330-339,478-509`
- Symptom: The Export-CSV button sits inside the same `overflow-x-auto` wrapper as the table, but the toolbar row (`mt-3 flex flex-wrap items-center justify-between`) only renders after the empty-state check — so on a mobile viewport the user scrolls horizontally through 7 columns to reach the prev/next pagination at the table's right edge. The CSV download itself works (it's above the table), but the per-page selector and pagination disappear off-screen.
- Evidence: `login-overview-section.tsx:478-509`: pagination lives inside the same `overflow-x-auto` wrapper as the 7-column table. At 393 px the wrapper paints a scrollbar; the pagination row is pushed to the wrapper's intrinsic width.
- Recommended fix: Move the `mt-3 flex flex-wrap` pagination row out of the `overflow-x-auto` wrapper so it always renders at viewport width. Same fix applies to `app-log-preview-section.tsx:254-261`.
- Effort: S

### F5 — Native `<select>` styling diverges from shadcn `<Select>` height
- Severity: Medium
- Axis: code
- File: `src/components/settings/account-section.tsx:63-64`, `timezone-picker.tsx:30-31`, `admin/general-settings-section.tsx:9-10`
- Symptom: Three sections rely on a hand-rolled `NATIVE_SELECT_CLASS` string (`h-9` + custom border tokens) for the native `<select>` rendering of gender, language, timezone, default-locale, and default-tz. The strings diverge slightly: account uses `placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-offset-2`, while the admin general-settings copy uses `shadow-xs transition-[color,box-shadow] focus-visible:ring-[3px]`. On mobile the native `<select>` falls back to the system picker (good UX), but the visual contract drifts between two cards on the same Account page.
- Evidence: Three near-identical `NATIVE_SELECT_CLASS` constants — `account-section.tsx:63`, `timezone-picker.tsx:30`, `general-settings-section.tsx:9`. The two settings strings differ from the admin string at the focus-ring spec (`ring-2` vs `ring-[3px]`).
- Recommended fix: Single source of truth — extract a `<NativeSelect>` primitive into `src/components/ui/native-select.tsx`. Three call sites import it instead of pasting class strings. Same focus token across all surfaces.
- Effort: M

### F6 — `<Input type="number">` and email/URL fields lack `inputMode` / `enterKeyHint`
- Severity: High
- Axis: code
- File: every settings/admin section
- Symptom: Across every input we audited (height in `account`, telegram chat ID, telegram bot token, ntfy server URL/topic, moodLog URL/API key, withings client-id, threshold min/max, dashboard widget reorder labels, admin reminder minutes, search filters in `login-overview`, password fields) there is zero `inputMode` or `enterKeyHint` attribute. iOS / Android keyboards fall back to the default text keyboard for `type="number"` (Android Chrome partially uses the numeric keypad, iOS Safari sometimes doesn't) and the Enter key shows "go" instead of "next"/"send". Touch typing flow on every form is slower than it should be.
- Evidence: `grep -n "inputMode\|enterKeyHint"` over both component directories returns zero matches. `grep -n "autoComplete"` shows ~13 hits, so the attribute style is camelCase React — the team knows the pattern, just hasn't applied it to keyboard-hint attributes.
- Recommended fix: Add `inputMode="numeric"` to every `type="number"` Input (height, chat ID if numeric, reminder minutes, threshold min/max). Add `inputMode="email"` to email inputs. Add `inputMode="url"` to URL inputs. Add `enterKeyHint="next"` to fields followed by another input in the same form, `enterKeyHint="done"` to the last field. The shared `Input` primitive could grow a `type`-derived default and let callers override.
- Effort: M

### F7 — Password-input toggle button is 16×16, below 44px tap floor
- Severity: High
- Axis: visual
- File: `src/components/settings/password-input.tsx:21-33`
- Symptom: The eye/eye-off show-password toggle is an absolutely-positioned `<button>` with no width or height — its hit-target is the bare icon at `h-4 w-4` (16 px). The button is reused on `account` (password-change dialog), `telegram` (bot token), `ntfy` (auth token), `integrations` (Withings + moodLog secrets), `admin/web-push-vapid`, `admin/umami`, `admin/glitchtip`, `admin/users` (reset-password). On every one of those surfaces a thumb tap to reveal a secret is unreliable on mobile.
- Evidence: `password-input.tsx:21-33`: `<button … className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2">`. No `h-11 w-11`, no `p-2` padding to grow the hit-target.
- Recommended fix: Wrap the icon in an `inline-flex h-11 w-11 items-center justify-center` button so the tap target meets WCAG 2.5.5 even though the icon stays visually 4×4. The current absolute positioning needs `right-1` to keep the icon visually anchored to the input's right edge.
- Effort: S

### F8 — Withings card 3-column credentials grid stays 3-up on tiny viewports
- Severity: Medium
- Axis: visual
- File: `src/components/settings/integrations-section.tsx:392-444`
- Symptom: The Withings credentials form uses `grid gap-3 sm:grid-cols-3` for client-id, client-secret, and the Save button. On `<sm` (<640 px) it stacks 1-up correctly, but the Save button column carries `<Label className="invisible">` purely as a height-spacer to align the button with the inputs above. At `<sm` the invisible label still renders an empty 18-px row of whitespace above the Save button.
- Evidence: `integrations-section.tsx:425-444`: `<div className="space-y-1.5"> <Label className="invisible">{t("common.save")}</Label> <Button className="h-9 w-full">…`. The "spacer label" pattern only works at `sm:grid-cols-3` width.
- Recommended fix: Move the Save button out of the grid (it's already 3-column tightly coupled to the credential inputs). Render it below the inputs as `<div className="flex justify-end"><Button>…`. At `<sm` it becomes a natural "save below the fields" pattern; at `>=sm` it stays right-aligned. Drops the invisible-label hack entirely.
- Effort: S

### F9 — Skeleton row height mismatch in Thresholds expand-mode
- Severity: Low
- Axis: visual
- File: `src/components/settings/thresholds-editor-section.tsx:173-199`
- Symptom: B2 added the skeleton list — one row per `METRIC_ORDER` entry at ~76 px height. The actual `<MetricRow>` collapsed state is ~76 px (matches!), but a user with override-mode persisted server-side will see the rows expand to ~210 px with min/max inputs + buttons + warning banner. The skeleton-to-actual layout jump for users with overrides remains real.
- Evidence: `thresholds-editor-section.tsx:181-196` skeleton renders one card per metric with 4 lines of skeleton bars. `MetricRow` at `:242-348` adds a `{overrideMode && ...}` block with 80-130 px of additional content per overridden metric.
- Recommended fix: Skeleton renders 2-3 lines of extra `<Skeleton>` bars per row to reserve average-case height (assume ~30% of metrics carry overrides). Alternative: ship the actual fetched overrides count in a tiny prefetch query so the skeleton can render the right number of expanded rows; this is over-engineering for the win.
- Effort: S

### F10 — Sources card up/down buttons render 44×44 each = 88 px control column
- Severity: Medium
- Axis: visual
- File: `src/components/settings/sources-section.tsx:349-370,506-530`
- Symptom: The per-source reorder buttons (move up + move down) are each `h-11 w-11` — correct for tap targets. But the two buttons sit side-by-side at the row's right edge, so the control column eats 88 px. On a 320 px viewport that leaves ~210 px for the source label + index number + padding; long source labels like `APPLE_HEALTH` ("Apple Health") still fit but the visual balance is heavy-right.
- Evidence: `sources-section.tsx:339-371` per-source row: `<li className="flex items-center gap-2 …">` with `flex-1` label and two `h-11 w-11` buttons. Same pattern at device-type axis `:497-530`.
- Recommended fix: Stack the two buttons vertically inside a 44×44 column (like `<DashboardLayoutSection>` already does at line 278-303 with `flex flex-col gap-1 …`). Saves 44 px of horizontal space per row; the up/down semantic stays glanceable. Net win at 320 px.
- Effort: S

### F11 — Feedback `<TabsList>` overflows at 320 px with badges
- Severity: Medium
- Axis: visual
- File: `src/components/admin/feedback-inbox-section.tsx:88-101`
- Symptom: The four feedback tabs (Open, Acknowledged, Resolved, Archived) each carry a count `<Badge>` inside the trigger. At 320 px the natural-width row exceeds the viewport; shadcn `<TabsList>` has no built-in horizontal-scroll handling. The trigger labels collide with the close-X area of the page edge.
- Evidence: `feedback-inbox-section.tsx:88-101`. Four `<TabsTrigger>` with labels like "Acknowledged" (de: "Bestätigt") + numeric badge. German label is the worst case at ~12 chars per tab.
- Recommended fix: Wrap the `<TabsList>` in `<div className="no-scrollbar -mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">` — same pattern the settings/admin shells use for their chip strips. Alternative: drop the count badge on mobile (`<Badge className="hidden sm:inline-flex">`).
- Effort: S

### F12 — Admin `<SettingsToggle>` doesn't stack on mobile when description is long
- Severity: Medium
- Axis: visual
- File: `src/components/admin/_shared.tsx:198-216`, plus call sites in `services-section.tsx`, `general-settings-section.tsx`
- Symptom: `<SettingsToggle>` uses `flex items-center justify-between` with the label/description left and the switch right. When the description carries a long sentence (e.g. `admin.servicesGlobalDescription`) on a 320 px viewport, the label column gets squeezed to 2-3 lines while the switch stays at the right edge. The first toggle row of `general-settings-section.tsx:39-57` for "Default language" doesn't even use the shared component — it duplicates the pattern with `<select>` instead of `<Switch>`, and likewise doesn't stack.
- Evidence: `_shared.tsx:198-216`: `<div className="flex items-center justify-between">`. No `sm:` breakpoint; no flex direction change. `general-settings-section.tsx:39-57` repeats the same flex pattern with a `<select>`.
- Recommended fix: Refactor `<SettingsToggle>` to use `flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3`. Same pattern the `<TimezonePicker>` (line 91) already uses. Apply the same change to the inline duplicate in `general-settings-section.tsx`.
- Effort: S

### F13 — Telegram bot-token field carries no `autoComplete="off"` / `inputMode="text"`
- Severity: Low
- Axis: code
- File: `src/components/settings/telegram-card.tsx:140-151`
- Symptom: The Telegram bot-token input (rendered via shared `<PasswordInput>`) doesn't carry `autoComplete="off"` or `inputMode="text"`. The bot token is a structured string like `123456:ABC-DEF...` — neither a username nor a real password from the browser's perspective. Mobile keyboards may suggest password-manager autofill on a value that shouldn't be saved, and at minimum the field shouldn't show the keyboard's autocorrect strip. The chat-ID `<Input>` (`:155-161`) has the same problem.
- Evidence: `telegram-card.tsx:141-151`: bare `<PasswordInput>` props. The `<PasswordInput>` primitive (`password-input.tsx:15`) spreads props through to the inner `<Input>`, so adding `autoComplete="off"` at the call site works.
- Recommended fix: Add `autoComplete="off"`, `inputMode="text"`, `spellCheck={false}` to the Telegram bot-token and chat-ID inputs. Same applies to the Withings client-id (`integrations-section.tsx:397-407`) which currently has no `autoComplete` attribute either.
- Effort: S

### F14 — Action-button rows wrap to 2-3 lines on Withings + moodLog cards at 320 px
- Severity: Medium
- Axis: visual
- File: `src/components/settings/integrations-section.tsx:458-535,788-858`
- Symptom: The connected-Withings action row has 4 buttons (Sync, Full sync, Test, Disconnect) inside `flex flex-wrap items-start gap-2`. At 320 px each button wraps onto its own line — that's 4 rows of ~36 px = 144 px of stacked controls before the user reaches the next card. The moodLog card's action row has the same 4-button pattern. Wrapping is correct (no horizontal overflow), but the visual density is heavy.
- Evidence: `integrations-section.tsx:458-535`: `<div className="flex flex-wrap items-start gap-2">` with 4 `<Button size="sm">` children. Button copy in German is long (`Verbindung trennen` for Disconnect is ~17 chars).
- Recommended fix: Group the actions: primary (Sync) and danger (Disconnect) stay visible; Full sync + Test connection move under a `<DropdownMenu>` "More actions" trigger at `<sm`. At `>=sm` all four render inline. Alternatively, use `<details>` for the secondary actions.
- Effort: M

### F15 — Forbidden words inside in-app `<p>` copy
- Severity: Low
- Axis: code
- File: `src/components/settings/ai-section.tsx`, `coach-feedback-section.tsx`
- Symptom: The audit's forbidden-word list flags "AI", "agent", "phase". The settings/admin surfaces still ship multiple `t("admin.ai*")` and `t("settings.ai*")` translation keys, plus header copy like "AI Quality" (`admin.aiQuality.title`) and Coach prompt-version comments. The keys themselves aren't user-visible (they go through `t()`), but the rendered labels are. Out of scope for this audit to police (translation keys), but worth noting for B6.
- Evidence: `grep -n "ai\\." admin/_shared.tsx ai-quality-section.tsx coach-feedback-section.tsx` returns 20+ matches. The translation values may or may not say "KI" / "Künstliche Intelligenz" — that's B6's call.
- Recommended fix: Defer to B6 i18n sweep. No code change in this audit.
- Effort: S (B6-owned)

### F16 — Filter row in `login-overview` has 4 columns at `lg:` but no progressive disclosure
- Severity: Low
- Axis: logic
- File: `src/components/admin/login-overview-section.tsx:230-303`
- Symptom: The filter row uses `grid gap-2 md:grid-cols-2 lg:grid-cols-4`. At `<md` the 4 filters (actor, action select, target, date range) stack to 4 rows of full-width controls. A typical first-look use case is "I just want to see today's failed logins" — the quick-filter pills above the row already cover that. The detailed filter expansion could be folded behind a "Show filters" toggle to save ~150 px of vertical space on mobile.
- Evidence: `login-overview-section.tsx:230-303`. Four filter controls + the per-page selector + export button = 6 controls before the table starts. At 393 px the user scrolls past ~250 px of controls.
- Recommended fix: Collapse the detailed filters behind a `<details>` or `<DropdownMenu>` "More filters" toggle, default-closed on `<md` and default-open on `>=md`. Quick-filter pills + Export stay visible; advanced filters hidden until needed.
- Effort: M

### F17 — `<DialogContent>` close-X button is 24×24 below tap floor
- Severity: Medium
- Axis: visual
- File: `src/components/ui/dialog.tsx:71-77`
- Symptom: The shadcn dialog primitive's auto-rendered close-X is `h-6 w-6` (24 px). Every settings/admin dialog inherits this — password-change, Withings full-sync confirm, moodLog disconnect, force-logout, feedback detail, restore-backup, danger-zone wipe. WCAG 2.5.5 minimum is 44×44. The close-X has the same tap-floor problem the settings-cog reportedly had in the v1.4.20 post-deploy report.
- Evidence: `dialog.tsx:73`: `className="… inline-flex h-6 w-6 …"`. No `min-h-11` or `min-w-11`.
- Recommended fix: Patch the local shadcn copy — `min-h-9 min-w-9 sm:h-6 sm:w-6` keeps the icon visually small at `>=sm` while growing the hit-target on mobile. Alternative: `p-2` to grow padding while keeping the visible icon at 4×4.
- Effort: S

### F18 — Account passkey-list mobile cards lose the delete `<Badge>` for credential-device-type
- Severity: Low
- Axis: visual
- File: `src/components/settings/account-section.tsx:837-849`
- Symptom: The mobile passkey card already exists (good!) but it inlines the `credentialDeviceType` as plain text under the name (`text-muted-foreground text-xs`) while the desktop table renders the device type as a `<Badge variant="outline">`. The two surfaces tell a different story for the same data — desktop shows backup-state as a badge + device as text, mobile shows device as text + backup-state as a badge.
- Evidence: `account-section.tsx:758-770` (desktop) vs `:830-849` (mobile). The "Single device" / "Multi device" label is glanceable as a badge on desktop, becomes plain muted text on mobile.
- Recommended fix: Render the device-type as a badge in the mobile card too — same chip vocabulary across both viewports. Either two small badges (device + backup) or one combined badge ("Single device · Backed up").
- Effort: S

### F19 — Mobile chip strip wraps under "scroll-mt-28" anchor offset, breaks deep-link to `/settings/notifications#telegram`
- Severity: Medium
- Axis: logic
- File: `src/components/settings/notifications-section.tsx:58,63,68`
- Symptom: The notifications page uses `<div id="telegram">`, `<div id="ntfy">`, `<div id="web-push">` for fragment navigation. Sticky chip strip at the top is `mb-4 overflow-x-auto` with no `scroll-mt-*` on the anchor targets. A deep-link to `/settings/notifications#telegram` from an external chat reminder lands the user with the Telegram card flush at the viewport top, underneath the chip strip. (Compare `thresholds-editor-section.tsx:120` which has `scroll-mt-28`.)
- Evidence: `notifications-section.tsx:58-71`: three plain `<div id="…">` wrappers. No `scroll-mt` class. The chip strip + AuthShell header eats ~100 px at the viewport top.
- Recommended fix: Add `scroll-mt-28` (or `scroll-mt-24` matching the existing thresholds page) to the three `<div>` wrappers. Same fix recommended for any future intra-page anchor.
- Effort: S

## Headline metrics
- Components reviewed: 46 (23 settings + 23 admin)
- Findings by tier: C: 0 H: 7 M: 7 L: 5
- Mobile-hostile patterns flagged for B7-style symmetry pass: 4 (F2: 6 tables miss the card-list pattern that 3 others already adopted; F5: three NATIVE_SELECT_CLASS copies; F6: zero `inputMode` hints across both surfaces; F12: `SettingsToggle` non-stacking pattern duplicated inline in general-settings)

## Open questions for the consolidator

1. **F2 scope**: Six admin tables need mobile card-list. This is the single largest fix in the surface — does the consolidator want a per-table contributor (6 buckets) or a single contributor owning all six? The existing `user-management`, `api-token-overview`, and `account/passkeys` cards already prove the pattern, so the work is mechanical.
2. **F6 default**: Should the shared `<Input>` primitive grow `inputMode` defaults derived from `type`, or should every call site supply its own attribute? Touch-disjoint if we patch `ui/input.tsx` once vs. touching ~40 call sites — but call sites still need `enterKeyHint`.
3. **F17 (dialog close-X)**: The shadcn primitive lives in `src/components/ui/dialog.tsx` and is consumed across the entire codebase (not just settings/admin). Patching the primitive is the right fix — but it touches every Coach / Dashboard / Measurements dialog too. Does R3d-MA6 own that patch, or does MA1-MA5 also flag it and the consolidator picks one owner?
4. **F15 forbidden-words**: The audit conventions list "AI" as forbidden, but the entire `admin/ai-quality` route + `settings/ai` section translation keys are named `admin.aiQuality.*`. Out of scope for R3d mobile fixes, but the maintainer may want a separate bucket to rename the routes + translation keys (probably v1.4.28 if it lands).
5. **F4 vs F2**: Should F4 (pagination outside `overflow-x-auto`) be a one-off fix or fold into the F2 card-list rewrite? Card-list replaces the table; pagination still applies to both.
