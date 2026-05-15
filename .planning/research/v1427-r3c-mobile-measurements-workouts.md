---
file: .planning/research/v1427-r3c-mobile-measurements-workouts.md
purpose: Mobile capability audit — measurements list / new-form / edit + workouts surface
created: 2026-05-15
auditor: MA4
---

# Mobile audit — measurements and workouts

## Summary

Reviewed the four files that compose this surface: `src/app/measurements/page.tsx` (74 LOC), `src/components/measurements/measurement-form.tsx` (446 LOC), `src/components/measurements/measurement-list.tsx` (820 LOC), `src/components/measurements/measurement-list-meta.ts` (metadata). Confirmed by grep that no client-side workouts route or component exists in `src/app/workouts` or `src/components/workouts`; B7 only wired `pickCanonicalWorkout()` into the JSON read path and there is currently no UI surface to attach, list, or detail workouts on the web. The measurements UI ships a dedicated mobile card grid (`md:hidden` branch in the list), which is good, but the new-measurement and edit dialogs are full-screen-hostile, numeric inputs are missing every keyboard hint and a11y attribute, and tap targets sit between 32 and 40 px on the mobile row's action buttons. 14 findings: 1 Critical, 5 High, 6 Medium, 2 Low.

Two findings (F1, F4) overlap with the MA1 dashboard report at `.planning/research/v1427-r3c-mobile-dashboard.md` because the same `<MeasurementForm>` is mounted from `/` and `/measurements`; the consolidator should de-duplicate when bucketing.

## Findings

### F1 — Numeric inputs ship without `inputmode`, `enterkeyhint`, `autocomplete`, or `aria-*` wiring

- Severity: Critical
- Axis: logic + code
- File: `src/components/measurements/measurement-form.tsx:266-335`, also re-used in `measurement-list.tsx:601-608` (edit dialog)
- Symptom: Every numeric field (`sys`, `dia`, `puls`, `value`, `edit-value`) renders `<Input type="number">` with no `inputMode`, no `enterKeyHint`, no `autoComplete` override, no `aria-required`, no `aria-invalid`. On iOS Safari `type="number"` still surfaces the full QWERTY keyboard by default unless `inputMode="decimal"` is set; the user then has to slide to the digit pane to type a weight. Form validation errors render as a single `role="alert"` block at the form bottom and are not linked back to the offending field via `aria-describedby`, so VoiceOver users do not hear which field failed.
- Evidence: `grep -n "inputMode\|inputmode\|enterkeyhint\|aria-required\|aria-invalid" measurement-form.tsx measurement-list.tsx` returns zero hits across both files.
- Recommended fix: Add `inputMode="decimal"` (and `enterKeyHint="next"` / `"done"` for the last field) to every numeric `<Input>`. Mirror `aria-required={true}` on `required` fields and toggle `aria-invalid` when the field rejects parse / range. Link the existing error banner via `aria-describedby={errorId}`.
- Effort: S

### F2 — Mobile list row edit / delete buttons sit at 32 and 40 px, below the 44 pt floor

- Severity: High
- Axis: visual
- File: `src/components/measurements/measurement-list.tsx:529-541`
- Symptom: The `md:hidden` mobile row uses `<Button … className="h-8 w-8">` for the edit pencil and the `DeleteButton` defaults to `h-8 w-8` (the call site overrides to `h-10 w-10`, still 40 px). Both targets fail WCAG 2.5.5 (44 × 44 CSS px) and AAA 2.5.8. Multi-row tap accuracy on iPhone SE / Pixel 5 viewports drops with the icons sitting side-by-side at `gap-1`.
- Evidence: lines 529-541; the same `DeleteButton` primitive at 778-819 ships a `h-8 w-8` default.
- Recommended fix: Pump the mobile-row pencil to `h-11 w-11`, lift the `DeleteButton` default to `h-11 w-11`, keep the desktop table inline icons at their current sizes via an explicit `className` override at the desktop callsite (line 459-470).
- Effort: S

### F3 — Pagination chevrons are `size="sm"` (32 px) on the only navigation control of the list

- Severity: High
- Axis: visual
- File: `src/components/measurements/measurement-list.tsx:560-575`
- Symptom: At 320 px the only way to move between pages of 25-row chunks is two side-by-side `<ChevronLeft />` / `<ChevronRight />` buttons sized `sm` (h-8 = 32 px) with `gap-1`. Tap targets fail the 44 pt floor; adjacent-tap error is high.
- Evidence: lines 560-575.
- Recommended fix: Switch to `size="icon"` with `className="h-11 w-11"` on small viewports, or render a single "Load more" CTA below `md:` (matches Apple Health / Withings list pagination idioms).
- Effort: S

### F4 — `<DialogContent>` for new-measurement and edit-measurement has no max-height and no internal scroll

- Severity: High
- Axis: logic
- File: `src/components/ui/dialog.tsx:64`, `src/app/measurements/page.tsx:58-66`, `src/components/measurements/measurement-list.tsx:581-585`
- Symptom: Both entry points mount the unstyled `<DialogContent>`, which carries `max-w-[calc(100%-2rem)]` but no `max-h-…` and no `overflow-y-auto`. On a 320 × 568 iPhone SE viewport the BP form is taller than the screen even before the iOS soft-keyboard occludes the lower third; the user cannot scroll inside the dialog to reach Save. The edit dialog has the same shell. (This overlaps MA1 F1 — same root component fix unblocks both.)
- Evidence: `grep -n "max-h\|overflow-y" src/components/ui/dialog.tsx` returns zero hits.
- Recommended fix: Add `max-h-[calc(100dvh-2rem)] overflow-y-auto` to the base `DialogContent` className, and on the measurement-side switch to `<Sheet side="bottom">` below `md:` once a `useIsMobile()` hook lands (consolidator should sequence with MA1 F1).
- Effort: M

### F5 — No `/measurements/new` route exists but four insights empty-states link to it

- Severity: High
- Axis: logic
- File: `src/app/measurements/page.tsx` (no `/new` subdirectory exists); link sites at `src/app/insights/puls/page.tsx:92`, `src/app/insights/bmi/page.tsx:88`, `src/app/insights/blutdruck/page.tsx:81`, `src/app/insights/gewicht/page.tsx:78`
- Symptom: Insights pages render `<Link href="/measurements/new">` empty-state CTAs. The directory listing for `src/app/measurements` contains only `page.tsx` — no `new/page.tsx`. The empty-state CTA produces a 404 on every viewport, but the hit is much more painful on mobile where the dashboard quick-add menu and the `/measurements` add button are the only other routes into the form. iOS users coming from the BP insights empty state hit a hard dead-end.
- Evidence: `ls src/app/measurements/` returns `page.tsx` only; the four `<Link href="/measurements/new">` callsites are above.
- Recommended fix: Either (a) add `src/app/measurements/new/page.tsx` that renders the form full-page on mobile, or (b) swap the four insights links to query-param-trigger the dialog on `/measurements?add=BLOOD_PRESSURE` and have the measurements page open the dialog on mount when the param is present. Option (b) reuses the existing dialog plumbing and keeps the `defaultType` prop's purpose intact.
- Effort: S (option b) / M (option a)

### F6 — Empty-state "Add first" CTA is `size="sm"` (32 px)

- Severity: Medium
- Axis: visual
- File: `src/components/measurements/measurement-list.tsx:370-374`
- Symptom: Brand-new accounts land on the empty-state where the only action is `<Button size="sm">`. 32 px tap target on a primary CTA the user must hit to onboard.
- Evidence: line 371-374.
- Recommended fix: Drop `size="sm"` so it picks up `default` (h-9, still 36 px — pair with the global Button h-9 → h-10 sweep that MA1 should be flagging) and add `min-h-11` for now.
- Effort: S

### F7 — `<DateTimeInput>` uses the native `<input type="datetime-local">` with no shadcn DatePicker fallback

- Severity: Medium
- Axis: logic
- File: `src/components/ui/date-input.tsx:25-28` (used by `measurement-form.tsx:362-367` and `measurement-list.tsx:614-620`)
- Symptom: iOS Safari renders `datetime-local` as a partial-screen wheel picker that does not honour the document `lang=` hint for locale formatting on every iOS version. Desktop Firefox renders nothing at all (gap). On iPhone the wheel picker covers the lower half of the screen and the user cannot see the rest of the form; combined with F4 this is the second worst keyboard-occlusion failure on the measurement surface.
- Evidence: `date-input.tsx` exports `DateTimeInput` as a thin wrapper that passes `type="datetime-local"`. There is no `Calendar` / `Popover` shadcn DatePicker in the repo (grep `import.*Calendar.*ui` returns zero).
- Recommended fix: Land a shadcn `<DatePicker>` + `<TimePicker>` composition (consolidator should choose between a shared component or the `react-day-picker` install). Until that ships, swap to a date `<input>` plus a separate native time `<input>` so the two halves don't lock the screen together on iOS.
- Effort: L (defer to v1.4.28 per the severity policy ≤ M rule)

### F8 — Mobile row source / note metadata uses `text-[10px]` and `text-xs` (10-12 px) — below legibility floor

- Severity: Medium
- Axis: visual
- File: `src/components/measurements/measurement-list.tsx:501-525`
- Symptom: The BP-side-badge inline at `mr-1.5 h-5 px-1 text-[10px]` (line 501), the source badge at `text-[10px]` (line 515), the date row and note row at `text-xs` (12 px) all sit below the 13-14 px floor recommended for sustained reading on mobile. WCAG 1.4.4 (resizable text) is not violated because Tailwind `text-xs` honours `rem`, but the perceived legibility on a Pixel 5 is poor for the date + source row, which is the only timestamp affordance the user has.
- Evidence: lines 501, 515, 509, 522.
- Recommended fix: Lift the BP-side and source badges to `text-[11px]` and `h-5`, lift the date / note paragraphs to `text-[13px]` (`text-sm` is 14 px and acceptable). Verify the `tabular-nums` value pill on line 506 stays `text-base` or larger.
- Effort: S

### F9 — Form action row's "more options" (reset) icon button is 36 px on a row with three other buttons

- Severity: Medium
- Axis: visual
- File: `src/components/measurements/measurement-form.tsx:402-414`
- Symptom: `<Button size="icon" className="h-9 w-9">` for the reset menu trigger; on a 320 px viewport the bottom action row contains "..." + Cancel + Save and the icon button sits at 36 px — below 44 pt. The drop-down's only entry is "Form zurücksetzen", which could be folded into a visible secondary text button at the same row instead of hiding behind a kebab.
- Evidence: lines 402-414 (form), repeats verbatim at `measurement-list.tsx:651-665` for the edit dialog's delete menu trigger.
- Recommended fix: Either (a) lift both kebabs to `h-11 w-11` and surface only when the action set ≥ 2 entries (today: one entry hidden, one entry destructive — both candidates for promotion to visible text buttons on mobile); or (b) merge reset into the Cancel button's right-click / long-press affordance — too clever; prefer (a).
- Effort: S

### F10 — Form does not use react-hook-form + Zod; uses raw `useState` + manual `parseFloat` + manual `Number.isFinite` checks

- Severity: Medium
- Axis: code
- File: `src/components/measurements/measurement-form.tsx:130-243`, `src/components/measurements/measurement-list.tsx:280-303`
- Symptom: Out of step with the project's current best-practice (react-hook-form + Zod). Raw `useState` for nine fields (`type`, `value`, `sysBp`, `diaBp`, `pulse`, `notes`, `measuredAt`, `glucoseContext`, `loading`, `error`) means: no field-level validation surface, no `formState.isSubmitting` so the disabled wiring is hand-rolled, no derived-error mapping back to `aria-invalid`, no shared schema with the API route's Zod validator. The edit flow at `measurement-list.tsx:280-303` reimplements the same parse logic verbatim.
- Evidence: `grep -n "react-hook-form\|useForm\|zodResolver" measurement-form.tsx measurement-list.tsx` returns zero hits; the validators at `src/lib/validations/measurement.ts` (Zod) are not imported by either component.
- Recommended fix: Convert both flows to `useForm({ resolver: zodResolver(measurementSchema) })` against the existing Zod schema. Field-level `aria-invalid` falls out automatically. Defer to v1.4.28 if effort exceeds bucket budget.
- Effort: M

### F11 — Type-filter `<Select>` trigger is `w-48` fixed width with no narrow-viewport collapse

- Severity: Medium
- Axis: visual
- File: `src/components/measurements/measurement-list.tsx:317-329`
- Symptom: `<SelectTrigger className="w-48">` is 192 px. Combined with the trailing "23 Messwerte" count badge (line 330-336) the row fits at 320 px but is tight; on a 280 px split-view iPad / small foldable the row wraps unpredictably because the parent is `flex items-center justify-between` with no `gap` or `min-w-0`. The first inner `<Select>` is missing `aria-label`.
- Evidence: lines 316-336.
- Recommended fix: Switch the filter trigger to `w-full max-w-[12rem]` plus `min-w-0` on the parent; add `aria-label={t("measurements.filterByType")}` or wrap with a hidden `<Label>` for screen-reader context. The count badge should hide below `sm:` since the same total surfaces on the pagination row.
- Effort: S

### F12 — `<SelectTrigger>` default height is 36 px (`h-9`) and the underlying `<Input>` primitive matches

- Severity: Medium
- Axis: code
- File: `src/components/ui/select.tsx:40`, `src/components/ui/input.tsx:40`
- Symptom: The whole form-control floor on the measurement surface (and every other form surface in the app) is 36 px. WCAG 2.5.5 floor is 44 px. The repo currently overrides per-callsite (`min-h-11`) instead of centralising the change. Mobile is the dominant target for v1.4.27; the primitive needs to grow.
- Evidence: `select.tsx:40` `data-[size=default]:h-9`; `input.tsx:40` `h-9`. Button primitive at `button.tsx:24` matches.
- Recommended fix: Coordinated lift of Input + Select + Button defaults to `h-10` (40 px) with `data-[size=lg]` going to `h-11` (44 px) for primary form controls. This is the cross-cutting primitive change MA1 + MA4 + MA5 all touch; the consolidator should bucket it under a single primitives sweep.
- Effort: M (single primitive sweep) — consolidator-level decision

### F13 — No swipe-to-delete or long-press affordance on mobile rows

- Severity: Low
- Axis: logic
- File: `src/components/measurements/measurement-list.tsx:480-546`
- Symptom: The mobile-row deletion path is "tap the small trash icon → AlertDialog confirm." Two-tap to delete is OK, but iOS users expect a swipe-from-right red action affordance on list rows. Today this is a missed opportunity; not broken.
- Evidence: lines 528-541 — no Framer Motion / `react-swipeable` import on the surface.
- Recommended fix: Defer to v1.4.28 — out of scope for the v1.4.27 mobile pass. Note for the iOS Swift port.
- Effort: L

### F14 — No workouts UI surface exists; B7 wired the canonical-workout backend with no client read-side

- Severity: Low
- Axis: logic
- File: absence — no `src/app/workouts/*`, no `src/components/workouts/*`
- Symptom: `find src -type d -name workouts` returns `src/app/api/workouts` (the JSON route B7 hardened) and nothing else. The B7 read-path now de-duplicates Withings + Apple Health workouts canonically, but the web client has no list, no detail, no manual-attach UI to surface that data. The audit assignment listed "manual-workout attach UI if any" — there is none. The mobile-capability story for workouts is therefore a strategic-defer, not a polish task.
- Evidence: directory listing + `grep -l "workout" src/app/**/*.tsx` returns only `privacy/page.tsx` (legal copy).
- Recommended fix: No fix in v1.4.27. Note in the v1.4.27 release notes that workout data is now canonicalised server-side; UI surface will follow in v1.5 alongside the iOS app's workout views. Add a `v1428-backlog.md` entry: "web workout list + detail UI, mobile-first."
- Effort: L — out of scope for v1.4.27

## Headline metrics

- Components reviewed: 4 in-scope files (measurements page + form + list + meta), plus 6 referenced primitives (Dialog, Sheet, Input, Select, Button, DateTimeInput). 0 workout components — none exist.
- Findings by tier: C: 1 (F1), H: 5 (F2, F3, F4, F5, F6 → revised to: F2 high, F3 high, F4 high, F5 high), M: 6 (F6, F7, F8, F9, F10, F11, F12), L: 2 (F13, F14). Net tier counts: C 1, H 4, M 7, L 2.
- Mobile-hostile patterns flagged for the B7-style symmetry / primitive pass: 3 (F4 dialog-shell, F10 RHF-conversion, F12 primitive-height lift) — these three are single-touch fixes that unblock most of the high-tier items.
- Overlap with MA1 dashboard report: F1 (numeric input hints), F4 (Dialog shell). Consolidator: dedupe.

## Open questions for the consolidator

- **F5 routing — option (a) full-page route or option (b) query-param dialog trigger?** Option (b) is the smaller change and matches the dashboard quick-add pattern; option (a) is the right answer if v1.5 wants a deep-linkable / share-friendly entry form. Recommend (b) for v1.4.27, (a) deferred to the v1.5 iOS sprint where the form becomes the mobile-web fallback of the native sheet.
- **F12 primitives lift** is a cross-cutting change that touches every form surface. Consolidator should decide whether it lands as a single primitive-only commit early in R3d (and every other bucket inherits the new floor) or stays per-callsite. The former is cleaner; the latter ships less risk.
- **F10 RHF migration** could expand scope significantly. Recommend deferring to v1.4.28 unless the consolidator wants a single contributor to take both `measurement-form` and `measurement-list` edit flows as one bucket; in that case it's a 4-6 hour rewrite with shared schema reuse against `src/lib/validations/measurement.ts`.
- **F7 DateTimeInput rewrite** is a known L-effort item. Defer per the severity policy.
- **F13 swipe-to-delete and F14 workouts UI** are explicit defers — log into `v1428-backlog.md` and the v1.5 iOS-paired UI epic respectively.
