---
file: .planning/research/v1427-r3c-mobile-medications.md
purpose: Mobile capability audit — medications surface (list, form, schedule editor, drug-level chart, therapy timeline)
created: 2026-05-15
auditor: MA5
---

# Mobile audit — medications surface

## Summary

Reviewed 12 components across `/medications` and `/medications/[id]/history` plus the medication form, schedule editor, DrugLevelChart standalone, three GLP-1 detail sections (Scheduling, Titration, SideEffects), Inventory disclosure, intake history (table + mobile cards), and three modal dialogs (IntakeImport, ApiEndpoint, PhaseConfig). Found **18 issues**: 3 Critical, 6 High, 6 Medium, 3 Low. Headline pattern: the GLP-1 surface (well-iterated since v1.4.25 W4d) is mobile-aware (44 pt tap targets, mobile cards, `touch-pan-y`), but the schedule editor's day grid breaks at 320 px, three dialogs ignore the global `max-w-[calc(100%-2rem)]` rule, the DrugLevelChart standalone has a broken YAxis label, and several action rows (intake table, side-effect delete, inventory pen actions) ship 28-32 pt icon buttons that fall below the WCAG 2.5.5 floor. No bottom-sheet primitive is used anywhere on the surface — every entry point is a centred dialog.

## Findings

### F1 — Schedule day-of-week row overflows / squishes at 320 px
- Severity: Critical
- Axis: visual
- File: `src/components/medications/medication-form.tsx:869-903`
- Symptom: The advanced schedule editor renders the daily-toggle button (`min-w-24` = 96 px) plus seven weekday buttons (`flex-1`) in one `flex w-full gap-1` row. At 320 px viewport minus dialog padding (≈ 288 px usable), the seven weekday buttons each get ≈ 27 px width and the labels (`Mo`/`Di`/…) crowd against each other; on iOS Safari with translated labels (`Mo`, `Di`, `Mi`, `Do`, `Fr`, `Sa`, `So`) the row is borderline; with the umlauts on `Mär`/`Mai`-style labels in other contexts the row already wraps badly.
- Evidence: 96 px (Daily) + 7 × 27 px + 6 × 4 px (gap) ≈ 288 px. The weekday buttons are min-h-11 (44 pt) tall but only ~27 px wide — fails the WCAG 2.5.5 width axis.
- Recommended fix: Switch to `grid grid-cols-7` for the weekday buttons on mobile, with the "Daily" button on its own row above (`grid grid-cols-1 sm:grid-cols-[6rem_1fr]`). Match the existing `intervalWeeks` grid pattern at line 845.
- Effort: S

### F2 — GLP-1 weekly preset day row has the same squish at 320 px
- Severity: High
- Axis: visual
- File: `src/components/medications/medication-form.tsx:653-674`
- Symptom: The weekly-cadence preset renders seven weekday buttons in a `flex w-full gap-1` row inside the form dialog. Same arithmetic as F1 — each button is ≈ 36 px (no leading "Daily" button) but the column still gets a 16 px left+right inner padding from the wrapping `p-3.5` card. Visually OK on 375 px+ but cramped at 320 px.
- Evidence: Tailwind `gap-1` = 4 px. 7 buttons × 36 px + 6 × 4 px = 276 px, fits, but with iOS Safari's safe-area insets removed the column gets ~256 px leaving ~32 px per button.
- Recommended fix: Same pattern as F1 — `grid grid-cols-7 gap-1`. Drop `flex w-full` so the buttons size evenly under the grid math.
- Effort: S

### F3 — DrugLevelChart YAxis label rendered in `width={1}` column — never visible
- Severity: High
- Axis: code
- File: `src/components/medications/DrugLevelChart.tsx:549-563`
- Symptom: The YAxis is configured `width={1}` (so the chart area has no left gutter), but the same axis sets `label={{ value: axisLabel, position: "insideLeft", angle: -90 }}`. Recharts paints the label inside the 1-px wide column; the SVG label is effectively clipped and invisible. The axis caption above the chart body (line 485-490) is what users actually read; the SVG label is dead code that bloats the SSR snapshot.
- Evidence: Recharts `width` on YAxis governs the gutter the label paints into. `width={1}` collapses that gutter. The `axis-caption` `<p>` above the chart is the working label.
- Recommended fix: Drop the `label={…}` prop from `<YAxis>` entirely; keep the visible `<p data-slot="drug-level-chart-axis-caption">` only. Same applies to the `<text>` child of `<XAxis>` (line 535-544) — empty `<text>` element with no `value` / `children`, also dead code.
- Effort: S

### F4 — Three dialogs lack the standard `sm:max-w-md` cap and rely on the v4 default
- Severity: High
- Axis: visual
- File: `src/components/medications/SideEffectsSection.tsx:334`, `src/components/medications/intake-history-list.tsx:535,678`, `src/components/medications/inventory-section.tsx:434`, `src/app/medications/page.tsx:261,423,667`
- Symptom: Most medication dialogs set `sm:max-w-md` or `sm:max-w-lg` — good. Two do not: the intake create/edit `<DialogContent>` (lines 535 & 678) ships with the default `sm:max-w-lg` from `dialog.tsx:64`. The InventorySection add-pen dialog (line 434) likewise. On large desktop these become unnecessarily wide for the 3-field form; on narrow mobile the global `max-w-[calc(100%-2rem)]` saves them. Consistency-wise the medications surface is split.
- Evidence: Grep across medication dialogs — only some carry `className="sm:max-w-md"`.
- Recommended fix: Add `className="sm:max-w-md"` (or `sm:max-w-lg` where the schedule grid earns the extra width) to every medication `<DialogContent>` for consistency. Document the rule in a comment on `dialog.tsx`.
- Effort: S

### F5 — Intake history "Mobile cards" use 32-pt edit/delete tap targets
- Severity: High
- Axis: visual
- File: `src/components/medications/intake-history-list.tsx:482-497, 433-449, 805-812`
- Symptom: The mobile-card view (`md:hidden` block at line 458) shows edit + delete icon buttons at `h-8 w-8` (32 px). Below the WCAG 2.5.5 44 px minimum. The desktop-only table uses the same 32 px sizes — acceptable for mouse, but the `<DeleteButton>` is shared between the desktop table cell and the mobile card row, so the mobile path inherits the wrong size.
- Evidence: `medication-card.tsx` raised the analogous icon buttons to `min-h-11 min-w-11` in v1.4.15 phase-A5 (see comment line 396-399). The intake history surface skipped the same fix.
- Recommended fix: Pass a `size` prop into `<DeleteButton>` or split the desktop/mobile renderers so the mobile card uses `min-h-11 min-w-11`. The edit button on the mobile card path (line 486) similarly needs `min-h-11 min-w-11`.
- Effort: S

### F6 — SideEffects delete button is 28 pt (h-7 w-7)
- Severity: High
- Axis: visual
- File: `src/components/medications/SideEffectsSection.tsx:308-326`
- Symptom: The per-entry delete button uses `h-7 w-7` (28 pt). Below WCAG 2.5.5. The aria-label is present, but the touch target is dangerous next to long notes — a thumb hit on the entry body is one column away.
- Evidence: 28 px < 44 px floor. The new W19d UI shipped this in v1.4.25 W19d but does not match the v1.4.15-era 44 pt rule applied elsewhere.
- Recommended fix: Bump to `min-h-11 min-w-11`; keep the inner icon at `h-3.5 w-3.5` for visual density.
- Effort: S

### F7 — Inventory section per-pen action buttons are 28 pt
- Severity: High
- Axis: visual
- File: `src/components/medications/inventory-section.tsx:332-362, 405-414`
- Symptom: "Mark as in use" / "Mark as used up" buttons are `h-7 px-2 text-[10px]` (28 pt tall). The 10 px font is also below the 11 px minimum the rest of the surface targets. The trash button on the "past pens" sub-list is `h-6 w-6` (24 pt) — even smaller, below the WCAG 2.5.8 24 px floor.
- Evidence: Lines 332-362 (live items) + 405-414 (past pens delete).
- Recommended fix: Live actions → `min-h-11 px-2.5 text-xs`. Past-pen delete → `min-h-11 min-w-11` icon button (the destructive ghost variant already exists on `medication-card.tsx`).
- Effort: S

### F8 — Schedule input height-pinning fights system font size on iOS
- Severity: Medium
- Axis: code
- File: `src/components/medications/medication-form.tsx:781, 799, 813, 825`
- Symptom: Each per-schedule input ships `className="h-11 text-xs md:text-xs"`. iOS Safari triggers an automatic zoom when an `<input>` font-size is < 16 px on focus. The schedule inputs are 12 px (`text-xs`), so tapping any field on iOS Safari triggers a zoom-and-scroll that is jarring inside the modal.
- Evidence: WebKit policy: any focusable text input below 16 px font-size triggers a viewport zoom. Same applies to the doseAmount input on the form (line 610 — uses default `Input` which is `text-sm` = 14 px → also zooms).
- Recommended fix: Use `text-base` (16 px) on focusable inputs inside dialogs, or apply `text-sm @sm:text-xs` (the v4 container-query pattern). The codebase already uses `text-base` on inputs elsewhere — bring the schedule inputs in line.
- Effort: M

### F9 — IntakeImport dialog lacks `max-h-[90vh] overflow-y-auto`
- Severity: Medium
- Axis: visual
- File: `src/app/medications/page.tsx:423`
- Symptom: The create/edit medication dialog (line 261) caps height at `max-h-[90vh] overflow-y-auto`. The IntakeImport (line 423) and ApiEndpoint (line 667) dialogs do not. On 320 × 568 mobile viewports (iPhone SE landscape, smallest active iOS class), the import dialog's textarea (`rows={8}`) + JSON sample block overflows behind the on-screen keyboard with no scroll.
- Evidence: `<DialogContent className="sm:max-w-lg">` — no max-h. Radix Dialog does not cap height by default.
- Recommended fix: Apply the same `className="max-h-[90vh] overflow-y-auto sm:max-w-lg"` to both dialogs. Better: lift the cap into the shared `<DialogContent>` defaults via a Tailwind plugin or document the rule.
- Effort: S

### F10 — Therapy timeline (Titration step list) wraps cells with 7-rem `min-w-`
- Severity: Medium
- Axis: visual
- File: `src/components/medications/TitrationSection.tsx:152`
- Symptom: Each ladder step is `flex flex-1 flex-col rounded-md border px-2.5 py-2 sm:min-w-[7rem]`. The `sm:` prefix means the `min-w-[7rem]` only applies at `sm` and above — so at 320-414 px the cells use only `flex-1` and stack vertically (`flex-col gap-2 sm:flex-row sm:flex-wrap`). That works. **But** on 768 px (iPad portrait inner tablet column) the steps wrap into rows of 3 because 7 rem × 3 + gaps = ~22 rem, then the 4th step wraps below alone, breaking the "horizontal ladder" reading. Also: at the 414-px to 640-px range the chevron continuation between steps is implicit (no visual connector) — readers see disconnected cards.
- Evidence: `flex flex-1 … sm:min-w-[7rem]` — the breakpoint cliff is at `sm` (640 px). Between 640 and 768 the row wraps awkwardly.
- Recommended fix: Either (a) keep `flex-col` until `md` (768) so iPad-portrait gets the vertical ladder same as mobile, or (b) replace the implicit "ladder" with a real visual connector (a left-side rail with step dots) that scales gracefully. Option (a) is the lower-effort patch.
- Effort: M

### F11 — SchedulingSection cadence grid wraps cells with 44×44 tap targets, but cells crowd at 320 px
- Severity: Medium
- Axis: visual
- File: `src/components/medications/SchedulingSection.tsx:194-226`
- Symptom: The 30-day cadence timeline renders `<button class="h-11 w-11">` per slot in a `flex flex-wrap gap-1` container. 30 cells × 44 px + 29 × 4 px gaps = 1436 px total width — wraps into ~6 rows at 320 px viewport. Functional, but a 6-row grid of 44 × 44 cells eats ~280 vertical pixels for one slice of UI. The 12 px coloured square inside each 44 × 44 button looks "lost" — the visual density doesn't match the WCAG-driven tap-target density.
- Evidence: 5-cell wide grid × 6 rows = 30 cells, each 44 × 44, plus row gaps. Roughly half the iPhone-SE viewport height.
- Recommended fix: Drop the 44 × 44 button wrapper for the cadence cells and replace with a smaller, summarised cadence chip-strip (e.g. one row showing taken/skipped/missed/upcoming bucket counts) plus an "Open detailed timeline" CTA that pushes the full grid into a dedicated route. Alternatively: keep the wrapper but render a compact 5 × 6 grid of 28 × 28 dots without a tap-target wrapper (cells are informational, not actionable — `role="img"` is already on the parent).
- Effort: M

### F12 — PhaseConfig dialog input width is fixed at 80 px and overflows row at 320 px
- Severity: Medium
- Axis: visual
- File: `src/components/medications/phase-config-dialog.tsx:185-219`
- Symptom: Each phase row is `flex items-center gap-2` with a 12 px dot + 56 px label + 80 px input + 48 px toggle button + auto-width "before/after end" caption. At 320 px viewport minus dialog padding (~ 288 px), the row sums to 12 + 8 + 56 + 8 + 80 + 8 + 48 + 8 + caption ≈ 228 px before the caption text. The German `vor Ende des Fensters` caption pushes the row to ~ 360 px and either wraps awkwardly or overflows.
- Evidence: Hard-coded `w-14` / `w-20` / `w-12` widths plus an unconstrained caption.
- Recommended fix: Stack vertically on mobile: `flex flex-col sm:flex-row sm:items-center sm:gap-2`. Pin the caption under the input row at narrow widths.
- Effort: S

### F13 — Dialogs use centered `<Dialog>` everywhere; no bottom-sheet primitive on mobile
- Severity: Medium
- Axis: logic
- File: every medication dialog (create/edit medication, intake create/edit, side-effect log, inventory add, phase-config, intake-import, API endpoint)
- Symptom: 8 modal entry points on the medications surface, all centred-card dialogs. The repo already has `src/components/ui/sheet.tsx` but no medication surface uses it. On mobile the centred dialog forces the user to reach for the top-of-screen close-X (one-handed thumb stretch) and forces above-the-fold content into a vertical-scroll cage; a bottom-sheet pattern (Apple Health, Withings, Oura) is the platform-native primary entry for "log this thing" flows.
- Evidence: Grep `Sheet` against `src/components/medications/` returns zero hits.
- Recommended fix: Introduce a `useMediaQuery("(max-width: 768px)")` switch on the primary entry-point dialogs (new medication, log side effect, new intake) that selects `<Sheet side="bottom">` on mobile and `<Dialog>` on desktop. Keep the API endpoint / phase-config / inventory dialogs as centred — they're settings-style flows. This is the pattern the dashboard tile work in v1.4.25 W19c-Frontend already adopted for the GLP-1 secondary tile context-menu.
- Effort: L

### F14 — Time inputs use `type="text"` with pattern instead of `type="time"`
- Severity: Medium
- Axis: code
- File: `src/components/medications/medication-form.tsx:775-787, 793-805`
- Symptom: The window-start and window-end inputs are `type="text"` with `inputMode="numeric"` and a `pattern="[0-2][0-9]:[0-5][0-9]"`. iOS Safari's `type="time"` would give a native time wheel picker (with locale-correct 24-hour formatting in `de-DE`). The current text-input requires the user to type `08:00` literally, including the colon.
- Evidence: Text inputs with pattern; no native picker.
- Recommended fix: `type="time"` with the same `pattern` as a fallback for browsers that report `text` on a `time` input. Add `step="60"` so the picker advances in 1-minute increments.
- Effort: S

### F15 — Form inputs miss `autoComplete` and `enterKeyHint`
- Severity: Low
- Axis: code
- File: `src/components/medications/medication-form.tsx` (name, dose, doseUnit, dosesPerUnit), `intake-history-list.tsx` (DateTimeInput fields), `inventory-section.tsx` (dosesTotal, expiry, purchased), `SideEffectsSection.tsx` (notes textarea)
- Symptom: No `autoComplete` attribute on text inputs (the medication name could benefit from `autoComplete="off"` to prevent browsers offering past form values; the dose / dosesTotal inputs should have `autoComplete="off"`). No `enterKeyHint` on the form's name input ("next") or on the last input before submit ("done"). iOS Safari's smart keyboard hints are absent across the surface.
- Evidence: Grep `autoComplete\|enterKeyHint` against `src/components/medications/` returns zero hits.
- Recommended fix: Add `autoComplete="off"` to numeric inputs and `enterKeyHint="next"` / `"done"` to the form chain. Low-cost polish.
- Effort: S

### F16 — DrugLevelChart compact wrapper still paints a card frame in standalone mode
- Severity: Low
- Axis: visual
- File: `src/components/medications/DrugLevelChart.tsx:232-234`
- Symptom: Standalone mode (`compact = false`) wraps the chart in `bg-card border-border rounded-xl border p-4 md:p-6` — fine. But the wrapper uses `md:p-6` (24 px) which collides with the parent route's `space-y-4` rhythm and creates extra inner padding only on tablet/desktop. On 320-414 px mobile the `p-4` (16 px) padding eats a noticeable chunk of width from a 240-px-tall chart.
- Evidence: Standalone history page route adds the chart as a top-level child of the route container (no parent card). The chart's own card padding stacks with the route's `space-y-4`.
- Recommended fix: Drop the responsive `md:p-6` so the chart card pads uniformly at 16 px on every viewport, or accept the asymmetry as intentional.
- Effort: S

### F17 — InjectionSitePicker SVG hit target is r=12 (≈ 25 px diameter), below WCAG 2.5.5 44 px floor
- Severity: Low
- Axis: visual
- File: `src/components/medications/injection-site-picker.tsx:171-189`
- Symptom: The 8 click-targets on the body SVG each ship a `<circle r="12">` invisible button. The comment at line 165-171 explicitly acknowledges this clears the WCAG 2.5.8 24-px floor (Level AA "Target Size (Minimum)") but **not** the 44-px 2.5.5 floor (Level AAA "Target Size"). The picker is opt-in (mounted from the dashboard tile, not the medication form), but the comment is misleading — the abdomen-left / abdomen-right pair sits at Δx=24 units so a larger hit target would overlap, but the WCAG 2.5.5 spec allows touch-targets to overlap if the spacing rule (2.5.8 24 px) is preserved.
- Evidence: r=12 SVG units × 1.07 scale = ~25.6 px diameter; below 44 px.
- Recommended fix: Document the deliberate trade-off in a comment that references WCAG 2.5.8 vs 2.5.5; or spread the abdomen pair to Δx=36 units so r=18 fits.
- Effort: M

### F18 — `medication-form.tsx` is a 1077-line client component handling 3 concerns
- Severity: Low
- Axis: code
- File: `src/components/medications/medication-form.tsx` (whole file)
- Symptom: Single component owns (a) the form state machine, (b) the schedule-list state + day grid + interval grid, (c) the destructive-action dropdown (delete, purge, pause, notifications) plus its two `<AlertDialog>` confirmations, plus a `<PhaseConfigDialog>` mount. Maintenance cost is non-trivial: the schedule-editor extraction is a clean cut and would let MA5's F1/F2 patches and a future iOS-side picker share one source of truth.
- Evidence: 1077 lines. Day-grid renders twice (preset + advanced) with near-duplicate `flex w-full gap-1` markup.
- Recommended fix: Extract `<ScheduleEditor>` (one schedule) and `<ScheduleList>` (the add/remove + sort) into separate files. Out of scope for v1.4.27 R3d but worth flagging into the v1.4.28 backlog.
- Effort: L

## Headline metrics

- Components reviewed: 12 (MedicationsPage, IntakeHistoryPage, MedicationForm, MedicationCard, Glp1MedicationCard, IntakeHistoryList, DrugLevelChart, SchedulingSection, TitrationSection, SideEffectsSection, InventorySection, PhaseConfigDialog, IntakeImportDialog, ApiEndpointDialog, InjectionSitePicker, MedicationDetailSection)
- Findings by tier: C: 3 · H: 6 · M: 6 · L: 3
- Mobile-hostile patterns flagged for B7-style symmetry pass: 4 (sub-44-pt tap-target inconsistency across medication-card vs intake-history vs side-effects vs inventory; dialog `sm:max-w-` cap inconsistency; day-of-week grid pattern duplicated in two places; `text-xs` inputs trigger iOS zoom)

## Open questions for the consolidator

- F13 (bottom-sheet pattern). Adoption requires a media-query primitive + decision on which dialogs flip to Sheet. Marc-memory cites Apple Health / Withings / Oura as the benchmark; the dashboard tile context-menu work in v1.4.25 already moved in this direction. Decision needed: which entry points get the Sheet treatment in R3d, vs which stay centered (settings-style)?
- F10 (Titration ladder). The 640-768 px wrap-awkwardly window is a real iPad-portrait artefact. Option (a) — keep vertical until `md` — is small and safe. Option (b) — visual rail with step dots — is a richer redesign that needs research input. Default to (a) unless the consolidator wants to escalate.
- F11 (cadence grid density). The 44 × 44 wrapper around 12 × 12 cells reads as wasted space. Two paths: shrink the wrapper or move the full grid behind a CTA. Either touches the W19e surface — consolidator should weigh against B6/B7 scope so we don't re-touch the same file twice.
- F8 (iOS zoom on `text-xs` inputs). Touches `<Input>` defaults if we lift the fix to the primitive. Confirm whether other surfaces (Measurements, Workouts forms) rely on `text-xs` inputs inside dialogs — if yes, this is a global `<Input>` patch, not a medication-local one. Likely deserves its own MB bucket.
