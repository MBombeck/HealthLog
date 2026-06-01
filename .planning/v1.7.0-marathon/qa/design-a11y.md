# v1.7.0 — Frontend Design + Accessibility Review (code-level, READ-ONLY)

Reviewer scope: new/changed UI in `git diff main..release/v1.7.0`. No browser
available — every finding is a static read of classes/ARIA/structure. Items
tagged `[CI]` need a Playwright/axe or visual confirmation in CI.

## Severity counts

- Critical: 0
- High: 0
- Medium: 4
- Low: 6
- Pass (verified, no action): 8

---

## Medium

### M-1 — Unit-preference segmented control: touch targets below 44px on mobile
`src/components/settings/unit-preference-card.tsx:150-155`
The segmented `<button>`s use `min-h-9` (36px) with no mobile bump. Every other
new v1.7.0 affordance follows `min-h-11 sm:min-h-9` (44px mobile → 36px desktop)
— detail header, advanced sheet buttons, export panel format buttons, history
import, destructive zone. This control breaks that release-wide rule.
Fix: `min-h-11 sm:min-h-9` on the option buttons. Padding stays `px-4`.

### M-2 — Unit-preference radio buttons have no visible focus ring
`src/components/settings/unit-preference-card.tsx:150-155`
The raw `<button role="radio">`s carry no `focus-visible:ring-*`. They sit on a
`bg-muted` track, so the UA default outline is low-contrast / easy to miss. The
shadcn `<Button>` used by the export-panel radiogroup brings its own
focus-visible ring; these hand-rolled buttons don't. WCAG 2.4.7.
Fix: add `focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none`
(match the shadcn Button token), or render the options through `<Button>` like
the export panel does for consistency.

### M-3 — Radiogroups lack arrow-key navigation / roving tabindex
`src/components/settings/unit-preference-card.tsx:132-161`,
`src/components/settings/health-record-export-panel.tsx:177-191`
Both use `role="radiogroup"` + `role="radio"` + `aria-checked`, but each radio is
independently tabbable and there is no Arrow-key handler. An ARIA radiogroup is
expected to be one tab stop with Arrow keys moving selection (roving tabindex).
Note: this matches the pre-existing house pattern (Step2Class, mood-form,
SideEffectsSection all do the same), so it is NOT a v1.7.0 regression — but the
two new groups extend the gap. `[CI]` axe will not fail this (it's a
keyboard-interaction expectation, not a static rule); flag for the broader
radiogroup-pattern cleanup. Lowest-friction alternative: drop `role="radiogroup"`
and use a real `<fieldset>`+radio-input set, or implement roving tabindex once in
a shared `<SegmentedControl>`.

### M-4 — Export panel: "Medikamente" toggle silently controls only `compliance`; `medList` has no UI
`src/components/settings/health-record-export-panel.tsx:320-324, 49-67, 90`
The single `medications` ToggleRow is bound to `sections.compliance`; `medList`
defaults `true` and is never exposed, so unchecking "Medikamente" still ships the
medication list in the payload (`{ list: true, compliance: false }`). The label
implies it governs the whole medication block. Either bind the toggle to both
flags, split into two rows, or relabel to "Adherence/Compliance" so the control
matches what it does. Functional-correctness adjacent; surfaces as a confusing
selection UI.

---

## Low

### L-1 — `<SettingsGroup>` section has no accessible name
`src/components/medications/settings-group.tsx:31-41`
The group `<section>` wraps a plain `<p>` micro-label not connected via
`aria-labelledby`. A bare `<section>` with no accessible name is a generic region
to AT. This is a deliberate choice (the comment explains it avoids a duplicate-id
axe failure and the dialog already owns the title) and is defensible, but the
four groups read as unlabelled regions. Optional: give the `<p>` an `id` and set
`aria-labelledby` on the section (ids are unique per-group, so no dup-id risk), or
drop `<section>` for a `<div>` to avoid an unnamed landmark-ish region. `[CI]`
confirm axe stays green either way.

### L-2 — Export panel error renders raw HTTP status with no friendly mapping
`src/components/settings/health-record-export-panel.tsx:131-134, 375-379`
On a non-OK response the panel sets `error` to the bare status code and renders
`t("settings.healthRecord.error", { code })`. `role="alert"` is correct, but a
413/429/500 surfaces as "…(500)" with no guidance. Low — copy/UX polish.

### L-3 — Export download has no success affordance
`src/components/settings/health-record-export-panel.tsx:135-147`
On success the blob just downloads; the spinner stops and nothing announces
completion (no `role="status"` toast). For a multi-second PDF/package this leaves
the user unsure it worked. Low — add a polite status line mirroring the
unit-preference card's pattern.

### L-4 — `<details>`/`<summary>` disclosure: no `aria-expanded` mirror, animation-free (good)
`src/app/medications/[id]/history/page.tsx:137-143`
Native `<details>` is the right primitive and exposes expanded state to AT for
free; no fix needed. Noting only that the summary chevron is text-only (no icon
rotation), so there is zero motion concern here — consistent with the W9
auto-scroll remediation. Verified PASS-adjacent; listed for completeness.

### L-5 — Export panel format change can leave AI-summary/charts toggles set but hidden
`src/components/settings/health-record-export-panel.tsx:101-102, 337-350`
Switching to FHIR hides `includeCharts`/`includeAiSummary` but keeps their state;
switching back restores the prior values (fine), and the POST only reads them when
PDF-like via the spread — but they ARE still sent in the body regardless of format
(`includeCharts`, `includeAiSummary` always in the payload at 126-127). Backend
presumably ignores them for FHIR; confirm the server drops them so a stale
`includeAiSummary: true` can't leak an AI summary into a FHIR export. `[CI]`/backend.

### L-6 — Detail header status dot relies on colour + always-on text label (good); muted-foreground "ended" dot contrast
`src/components/medications/medication-detail-header.tsx:90-95`
Status is conveyed by both an always-visible text label and a colour dot
(`aria-hidden`), so colour is not the sole channel — correct. The "ended" dot uses
`bg-muted-foreground` inside a `secondary` Badge; the dot is decorative so contrast
isn't required, but visually it can be hard to distinguish from the badge text.
Cosmetic only.

---

## Verified PASS (no action)

1. **Detail header three-button row** — Edit is a labelled outline button; History
   + Advanced are icon-only with distinct `aria-label`s and `aria-hidden` icons;
   all carry `min-h-11 min-w-11 sm:min-h-9 sm:min-w-9` (44px mobile). DOM order
   name→dose→status→edit→history→advanced is sensible for AT.
   `medication-detail-header.tsx:122-153`.

2. **Advanced settings sheet redesign ("Kraut und Rüben" fix)** — Genuinely
   consistent now: four `<SettingsGroup>` blocks, uniform `space-y-8` between
   groups + `space-y-4` within, `<Separator>` between rows, neutral actions
   `outline` / destructive `destructive font-semibold` / toggles as labelled
   switches. Widened to `2xl` (token exists in ResponsiveSheet: `sm:max-w-2xl`).
   No mixed dark/light button salad remains. `advanced-settings-sheet.tsx`,
   `settings-group.tsx`.

3. **History view** — intake-only; sort defaults `scheduledFor desc` so skipped
   rows don't float; drug-level curve is a default-CLOSED native `<details>`;
   import de-emphasised as ghost; back link present; loader respects
   `motion-reduce:animate-none`. `[id]/history/page.tsx`,
   `intake-history-editable.tsx`.

4. **Bulk/row delete dialogs** — AlertDialog with title+description, destructive
   action styled consistently, `aria-busy` on pending, selection toolbar is a
   labelled `role="region"`. `intake-history-editable.tsx`.

5. **HealthKit chart pages (24 new)** — All thin wrappers over
   `HealthKitMetricPage`; identical envelope to the existing wave-A pages. Line
   colours are Dracula hex via the `color` prop (`#50fa7b`, `#ffb86c`, `#bd93f9`,
   `#ff79c6`, `#8be9fd`) — same mechanism as existing chart pages. **No raw
   `text-green/red/orange/yellow-*` Tailwind utilities introduced** (grep clean),
   so the known prior status-text contrast issue is not reintroduced.
   `valueScale` is folded at the single read boundary and re-keys the query cache;
   no contrast/structure change to the chart itself. `[CI]` visual smoke on a few
   pages to confirm empty-state + axis render.

6. **Destructive / lifecycle / notifications / settings section bodies** — Switches
   wrapped in `<label>` (whole-row hit target), distinct `aria-labelledby` +
   `aria-describedby`, the duplicate-id heading split is preserved
   (SECTION_TITLE_ID vs ROW_TITLE_ID), decorative channel chips `aria-hidden`,
   destructive CTAs carry `font-semibold` for the WCAG large-text band, every
   spinner `motion-reduce:animate-none`, all action buttons `min-h-11 sm:min-h-9`.

7. **Export panel core structure** — `<section aria-labelledby>`, `<fieldset>` +
   `<legend>` for format + included-data groups, labelled `<NativeSelect>` for
   range, labelled `<Input>` for practice name, format buttons `min-h-11 sm:min-h-9`
   with `aria-checked`, generate button `motion-reduce:animate-none`, `role="alert"`
   on error, mood default-OFF (privacy). Focus order is natural DOM order.

8. **Motion / reduced-motion** — No new auto-scroll or dizzy animation introduced.
   insights-tab-strip change is data-only (new sub-page + group entries), no motion.
   Every `animate-spin` in new code pairs with `motion-reduce:animate-none`.
   Avatar change is `object-cover` (fixes squashed photos) — no motion.

---

## CI follow-ups

- `[CI]` axe sweep on: medication detail page, `/medications/[id]/history`,
  Settings → Display (unit card), Settings → Export (health-record panel),
  advanced-settings sheet open state (mobile + desktop ResponsiveSheet).
- `[CI]` 44px touch-target sweep will catch M-1 if the sweep covers the unit-pref
  control — verify the segmented buttons aren't exempted like the hidden avatar
  file input was.
- `[CI]` keyboard-only walk of both radiogroups (M-3) — Tab/Arrow behaviour.
- `[CI]`/backend: confirm FHIR export drops `includeCharts/includeAiSummary` (L-5)
  and that `medList` selection semantics match the label (M-4).
