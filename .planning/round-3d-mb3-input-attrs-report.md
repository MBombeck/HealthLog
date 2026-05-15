# v1.4.27 R3d Pass 1 — MB3 input attributes + Coach composer report

Bucket: MB3 — `inputMode` / `enterKeyHint` / `autoComplete` /
`aria-invalid` / `aria-describedby` repo-wide sweep + Coach composer
keyboard / Popover refinements + Coach evidence `aria-expanded`.

Branch: `develop`.

## Commits landed

| SHA | Message |
|---|---|
| `9036e715` | feat(ui): derive Input inputMode default from the type prop |
| `2d8c5e90` | feat(forms): wire keyboard hints and aria error wiring across measurement, medication, and mood forms |
| `192170ee` | feat(forms): wire keyboard hints and aria attributes across settings and admin forms |
| `95bc87f5` | feat(auth): wire keyboard hints and aria error wiring on login and register |
| `bfb5ba72` | feat(coach): tap-friendly composer hint and accurate evidence aria-expanded |
| `1ca70225` | chore(i18n): fan filterByType across the remaining locale files |

Six commits total. The locale-parity fan-out is a small follow-on
chore that the `measurements.filterByType` key needed; otherwise the
five planned commits map 1:1 to the brief.

## Per-commit gates

Every commit passed `pnpm typecheck`, `pnpm lint`, and the relevant
`pnpm vitest run …` scope on the way in. The final post-commit run
covers all 3989 unit tests + 1 skipped — full suite green; the
locale-integrity test that flagged the missing key is now back to
26/26 passing.

## Input primitive `inputMode` derivation rules

`src/components/ui/input.tsx` learned a `deriveInputMode(type)` step
that fires only when the consumer does not pass `inputMode` itself.

| `type` | Derived `inputMode` |
|---|---|
| `number` | `decimal` (most numeric inputs in HealthLog accept decimals — kg, mmol/L, sleep hours) |
| `tel` | `tel` |
| `email` | `email` |
| `url` | `url` |
| `search` | `search` |
| anything else | none (omits the attribute) |

Integer-only call sites (steps, doses per pen, schedule recurrence
weeks, reminder minutes) still pass `inputMode="numeric"` explicitly
and the override wins. Seven new unit tests on top of the three
existing autoComplete contracts pin both the derivation and override
paths.

## Forms touched — measurement / medication / mood

| File | Wiring |
|---|---|
| `src/components/measurements/measurement-form.tsx` | `useId` error-banner id; sys/dia/pulse + value gain `inputMode="numeric"` + `enterKeyHint="next"` + `aria-required`/`aria-invalid`/`aria-describedby`; notes input gains `enterKeyHint="done"` + `autoCapitalize="sentences"`; DateTimeInput pinned to error region. |
| `src/components/measurements/measurement-list.tsx` | filter Select `aria-label="measurements.filterByType"`; edit dialog value/timestamp/notes wired to a dialog-local error banner via `aria-describedby`; notes carries `enterKeyHint="done"` + `autoCapitalize="sentences"`. |
| `src/components/medications/medication-form.tsx` | name → dose-amount → dose-unit → doses-per-pen `enterKeyHint` chain; name carries `autoCapitalize="words"`; schedule window inputs swapped to `type="time"` with `text-base md:text-xs` to dodge iOS Safari auto-zoom on focus (16 px floor); error banner wired across every required field via `aria-describedby`. |
| `src/components/medications/intake-history-list.tsx` | edit + create dialogs each pin their `DateTimeInput`s to a dialog-local error banner via `aria-describedby` and surface `aria-required` / `aria-invalid`. |
| `src/components/medications/inventory-section.tsx` | add-pen dialog: doses-total wired to a `formErrorId` via `aria-describedby` + `aria-required`/`aria-invalid`, gains `enterKeyHint="next"`; printed-expiry and purchased-at carry `enterKeyHint="next"`; notes textarea gains `enterKeyHint="done"` + `autoCapitalize="sentences"`. Banner is now `role="alert"` + `aria-live="polite"`. |
| `src/components/medications/SideEffectsSection.tsx` | notes textarea gains `enterKeyHint="done"` + `autoCapitalize="sentences"` + `autoComplete="off"`. |
| `src/components/mood/mood-form.tsx` | timestamp pinned to error region; tags Input opts into `autoCapitalize="none"` + `enterKeyHint="done"` + `autoComplete="off"` so chip values do not get title-cased. |

i18n: `measurements.filterByType` added in de + en, then fanned to
es / fr / it / pl per the locale-parity gate.

## Settings + admin

| File | Wiring |
|---|---|
| `src/components/settings/account-section.tsx` | username carries `autoComplete="username"` for password-manager binding; email gains `autoComplete="email"` + `enterKeyHint="next"`; height field surfaces `inputMode="decimal"` + `enterKeyHint="next"`. |
| `src/components/settings/telegram-card.tsx` | bot token + chat ID both opt out of autofill, disable spellCheck and autocapitalize, and lead the chained next → done keyboard order. |
| `src/components/settings/integrations-section.tsx` | Withings client-id (text) + client-secret (PasswordInput) + moodLog URL (`type="url"`) + moodLog API key (PasswordInput) all share the off-spell / no-capitalize secret-input contract and chain into the test / save action via `enterKeyHint`. |
| `src/components/settings/notifications-section.tsx` | each notification card wrapper (`#telegram`, `#ntfy`, `#web-push`) carries `scroll-mt-28` so direct anchor navigation lands the section header below the sticky page header instead of behind it. |
| `src/components/settings/thresholds-editor-section.tsx` | min/max inputs derive `inputMode="numeric"` for `ACTIVITY_STEPS` and `"decimal"` elsewhere, chain next → done. |
| `src/components/admin/reminders-section.tsx` | late-window + missed-window minute inputs pin `inputMode="numeric"` and chain next → done. (The brief points at `general-settings-section.tsx`; the reminder minutes inputs actually live in `reminders-section.tsx` — no `<Input>` exists in `general-settings-section.tsx`.) |

## Auth pages

| File | Wiring |
|---|---|
| `src/app/auth/login/page.tsx` | email/username carries `inputMode="email"` + `enterKeyHint="next"` + `autoCapitalize="none"` + `spellCheck={false}`; password carries `enterKeyHint="go"`. Both pin `aria-required` / `aria-invalid` / `aria-describedby` to the form-level error region; the banner gains `aria-live="polite"`. |
| `src/app/auth/register/page.tsx` | email + username + new-password gain the same aria wiring + keyboard hints; password surfaces `enterKeyHint="go"`. |

`src/app/auth/reset/page.tsx` does not exist in the tree, so no
edits there (the brief's "if exists" branch applied).

## Coach surface

| File | Wiring |
|---|---|
| `src/components/ui/popover.tsx` (new) | `Radix Popover` wrapper mirroring `tooltip.tsx`'s shape; same Dracula surface tokens, portal mount, slide-in animation. |
| `src/components/insights/coach-panel/coach-input.tsx` | textarea picks up `enterKeyHint="send"` + `autoCapitalize="sentences"`; new `autoFocusOnOpen` prop fires a one-shot `requestAnimationFrame` focus when the parent passes it (drawer flips it on for its fallback composer slot); info-icon disclosure swaps `<Tooltip>` → `<Popover>` so the long-form "Enter to send" hint tap-toggles reliably on touch surfaces. |
| `src/components/insights/coach-panel/coach-drawer.tsx` | the fallback composer slot now mounts `<CoachInput autoFocusOnOpen />` so the cursor lands in the textarea on first drawer open without re-stealing focus on subsequent re-renders. |
| `src/components/insights/coach-panel/message-thread.tsx` | evidence `<details>` is now controlled via `useState` (`evidenceOpen`); the summary carries an accurate `aria-expanded` driven from that state and `onToggle` syncs the native disclosure back into React. |
| `src/components/insights/coach-panel/__tests__/coach-input.test.tsx` | re-baselined the "renders the localised placeholder + the tooltip-trigger hint" test to call out the Popover swap; the regex assertion already matches the popover trigger and stayed green. |

## Tooltip → Popover swap location

Single location: the Coach composer hint inside
`src/components/insights/coach-panel/coach-input.tsx`. Other Tooltip
consumers (`personal-record-badge.tsx` etc.) keep `<Tooltip>` since
they are pure mouse-hover affordances that never need touch-toggle.

## Deviations from the brief

- The brief asked for reminder-minute inputs in
  `src/components/admin/general-settings-section.tsx`. That file
  has no `<Input>`; the reminder-window inputs actually live in
  `src/components/admin/reminders-section.tsx`. Wiring landed there.
- No `auth/reset/page.tsx` exists in the repo, so no reset-flow
  wiring landed (the brief's "if exists" branch).
- A small i18n follow-on commit (`1ca70225`) was needed to backfill
  `measurements.filterByType` into the four English-fallback locale
  files so the `i18n-locale-integrity` parity test stayed green.
  That keeps the per-commit gate clean even though it bumps the
  bucket to six commits instead of the planned five.

## Collision discipline

- `src/components/ui/input.tsx`: MB2's `h-10` lift already landed in
  `fb6fb4f5`; MB3's `inputMode` derivation layered on top in
  `9036e715` with no overlapping lines.
- `src/components/measurements/measurement-form.tsx`,
  `src/components/measurements/measurement-list.tsx`,
  `src/components/medications/medication-form.tsx`,
  `src/components/medications/intake-history-list.tsx`,
  `src/components/medications/inventory-section.tsx`,
  `src/components/medications/SideEffectsSection.tsx`: shared with
  MB1 (`ResponsiveSheet` mount) and MB2 (icon-button sweep).
  Every MB3 edit stayed strictly inside `<input>` / `<textarea>` /
  `<select>` props and their associated error-banner wiring; the
  parallel MB1/MB2 commits landed in disjoint line ranges without
  rebase conflict.
- `src/components/insights/coach-panel/coach-input.tsx`: MB2 had
  already lifted the hint button to `h-11`; MB3 only touched the
  Tooltip → Popover swap + textarea attrs + autoFocus prop.
- `src/components/insights/coach-panel/message-thread.tsx`: MB3
  owns the evidence aria-expanded state; MB2's thumbs feedback row
  and MB4's planned visualViewport listener live in distinct line
  ranges.
- `src/app/auth/login/page.tsx`, `src/app/auth/register/page.tsx`:
  MB2's submit-button lift work landed in parallel commits; MB3
  only edited the form input attributes and the error region.

No same-line rebase conflicts encountered during the sweep.
