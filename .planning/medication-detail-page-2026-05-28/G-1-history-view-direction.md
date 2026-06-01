# G-1 — Direction: v1.5.6 pure-history detail page + AdvancedSettingsSheet

Authoritative direction for the v1.5.6 medication-detail refactor. Supersedes the v1.5.5 D-3 §6/§7/§9 *composition* (the section order and the inline-settings placement). It KEEPS D-3 §10 invariants and reuses every section component D-3 shipped — they move container, not contents. The list page (`/medications`) is out of scope and untouched.

## 1. TL;DR

`/medications/[id]` becomes a pure "Vergangenheit" surface: a slim header (name / dose / status pill + one Edit button), a STATIC one-line cadence summary, and the intake-history TABLE with per-row edit, per-row delete and bulk-delete. The Today's-Dose-Card is removed from the detail page (it lives only on the list page's `todays-dose-card`). Every setting — Notifications, API-Tokens, Phasen, CSV-Import, Reminder-Window (grace), and the destructive zone — moves into a new `<AdvancedSettingsSheet>` (a `<ResponsiveSheet>`), reached from a two-option Edit picker in the header: "Plan bearbeiten" opens the existing wizard untouched, "Erweiterte Einstellungen" opens the new sheet. This is the Apple Health model — drillable history on the surface, the schedule editor and destructive controls behind an explicit gate (R-2 §1 / §A) — minus Apple's discoverability problem, because the picker is one obvious control.

## 2. What changes vs D-3, in one table

| D-3 element | v1.5.6 disposition |
|---|---|
| §9.2 Today's dose card | REMOVED from detail page. `todays-dose-card.tsx` stays as a file (list page owns it); the detail page stops importing it. |
| §9.3 Cadence summary (editable) | KEPT as a STATIC line. `cadence-summary-row.tsx` rendered with `hideEdit` always — no pencil. |
| §9.4 Dose ladder / Phasen | Phasen editor moves into the sheet. `DrugLevelChart` + `TitrationSection` (read-only visualisation) stay on the detail page (they are history/context, not settings). |
| §9.5 Intake history preview | KEPT, becomes the primary surface. Same `intake-history-preview.tsx`, same props. |
| §9.6 Notifications | MOVED into `<AdvancedSettingsSheet>`. |
| §9.7 Settings (API / CSV stub / Phasen / Grace) | MOVED into `<AdvancedSettingsSheet>`. |
| §9.8 Verwaltung & Gefahrenzone | MOVED into `<AdvancedSettingsSheet>` (bottom). |
| Header pencil → wizard `intent:"name"` | REPLACED by the two-option picker. |

## 3. Detail-page section order (final)

Pure history. No dose-logging action anywhere on the page.

### Recurring variant

1. **Back link** — unchanged (`<Link href="/medications">`, `page.tsx:270-280`).
2. **Header band** — name / dose / status pill + Edit picker (see §4). Reuse `medication-detail-header.tsx`; the `onEdit: () => void` prop becomes the picker trigger instead of a direct wizard open.
3. **Cadence summary (static)** — `cadence-summary-row.tsx` rendered with `hideEdit` always true. One line via `summariseCadence(payload, t)`. Course-window sub-line when set.
4. **Dose ladder / Phasen-Visualisierung** — GLP-1 only. `DrugLevelChart` + `TitrationSection` as-is (read-only). The *editor* is in the sheet; this is the history view of where the user is on the ladder.
5. **Intake-history table** — `intake-history-preview.tsx`, unchanged props. Per-row edit/delete kebab + bulk-delete toolbar + footer link to `/medications/[id]/history`. The "Importieren" CTA in its header stays (it acts on the table directly — keep it where the data it changes lives, R-2 §C).

### One-shot variant

Drop section 4 (not GLP-1). Section 3 collapses to the static `Einmalig am DD.MM.` one-shot card already in `page.tsx:306-318`. Section 5 renders the single intake row. No Today's-dose card (it was the only thing that differed for one-shot; now removed for every variant).

1. Back link
2. Header band + Edit picker
3. Cadence static line (`Einmalig am …`)
4. Intake-history table (single row)

### Paused / ended variant

Identical structure. The status pill flips to `Pausiert` / `Beendet` via the existing `resolveStatus()` in `medication-detail-header.tsx:42-54`. Nothing on the surface disables — pause/resume now lives in the sheet's destructive zone, so the surface stays a calm read of the past.

The page no longer reads `intakeList?.events.find(... isToday ...)` (that fed the today card). It still reads `medicationIntakeList(...)` for `intakeCount`, which the sheet's destructive zone needs (`page.tsx:254`). Pass `intakeCount` into the sheet.

## 4. The two-option Edit picker

**Component: shadcn `<DropdownMenu>`** (already in the tree — used by `intake-history-list-v2.tsx:24-29` and `intake-import-dialog.tsx:31-36`). Not a dialog: a dialog to choose-then-open-another-modal is a 3-deep stack and feels heavy; a dropdown is one tap, keyboard-native via Radix, and matches Medisafe/Apple's "pencil top-right" placement (R-2 §1 / §3).

Lives in the header band, replacing the single Edit button at `medication-detail-header.tsx:101-110`. The trigger keeps the same `<Button variant="outline" size="sm">` with `Pencil` icon + `{t("common.edit")}` so the visual anchor is unchanged.

```
[Pencil  Bearbeiten ▾]   ← DropdownMenuTrigger (min-h-11 sm:min-h-9)
  ├─ Plan bearbeiten            → opens MedicationWizardDialog (mode="edit")
  └─ Erweiterte Einstellungen   → opens <AdvancedSettingsSheet>
```

- Labels (new i18n keys): `medications.detail.edit.planOption` = "Plan bearbeiten", `medications.detail.edit.advancedOption` = "Erweiterte Einstellungen". Trigger label stays `common.edit`.
- "Plan bearbeiten" opens the wizard with `mode="edit"`, `initial={snapshotToWizardPayload(medication)}`. Drop the `landingIntent` plumbing: with cadence no longer editable inline, the header is the only wizard entry, so it lands on Step 1 (omit `landingIntent`, which keeps the legacy 1/8 heuristic — see `MedicationWizardDialog.tsx:94-97`). The `wizardIntent` state and `openWizardWithIntent` helper in `page.tsx:160-261` are removed.
- a11y: Radix `DropdownMenu` already manages roving focus, Escape-to-close, and returns focus to the trigger on close — the §10 invariant-7 "focus returns to trigger" requirement is satisfied by the primitive. Each `DropdownMenuItem` is keyboard-reachable; `onSelect` opens the respective surface. The trigger carries no extra `aria-label` (its text is the label); add `aria-haspopup` is implicit via Radix.
- Modal-depth note: the dropdown is a popover, not a modal — opening the sheet from it is depth 1, not depth 2. Safe.

## 5. AdvancedSettingsSheet spec

New file: `src/components/medications/advanced-settings-sheet.tsx` (kebab-case, §10 invariant 22). Wraps `<ResponsiveSheet>` (`responsive-sheet.tsx`) — mobile bottom sheet, desktop right/centred dialog, sticky footer, `max-h-[90dvh]` body scroll already built in.

Props:

```ts
interface AdvancedSettingsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  medicationId: string;
  medicationName: string;
  treatmentClass?: string;
  active: boolean;
  startsOn?: string | null;
  endsOn?: string | null;
  notificationsEnabled: boolean;
  reminderGraceMinutes: number | null;
  intakeCount: number;
}
```

`title` = `t("medications.detail.advanced.title")` ("Erweiterte Einstellungen"). The body scrolls (`ResponsiveSheet` body is `overflow-y-auto`); no sticky footer needed because each section saves itself (every moved section already owns its own save button / switch). Leave the `footer` slot empty.

### Section order inside the sheet (top → bottom: routine → rare → destructive)

1. **`<NotificationsSection medicationId notificationsEnabled />`** — verbatim from `sections/notifications-section.tsx`.
2. **`<SettingsSection medicationId medicationName treatmentClass startsOn endsOn reminderGraceMinutes />`** — verbatim from `sections/settings-section.tsx` (hosts API-Tokens row, CSV-import stub, Phasen button, Grace).
3. **`<DestructiveZoneSection medicationId medicationName active intakeCount />`** — verbatim from `sections/destructive-zone-section.tsx`, last, so the irreversible cards sit at the bottom of the scroll (matches Apple's "Options at the bottom", R-2 §A / §D).

Each of these already renders inside `<MedicationDetailSection>` chrome (bordered card with `<h2>` heading), which reads cleanly stacked inside a sheet body — no wrapper changes needed.

### Nested-sheet / modal-stack handling (the one real risk)

Two sections open their own overlays from inside the sheet:

- **PhaseConfigSheet** (`sections/phase-config-sheet.tsx`) is itself a `<ResponsiveSheet>`, opened by the Phasen button in `SettingsSection`. AdvancedSettingsSheet → PhaseConfigSheet = a 2-deep sheet stack. To honour §10 invariant 7 (modal stack ≤ 2) and avoid a janky two-sheet overlay, **the Phasen button closes the AdvancedSettingsSheet before opening the PhaseConfigSheet** — they become sibling sheets, not nested. Implementation: lift the phase-sheet open state out of `SettingsSection` into `AdvancedSettingsSheet` (or the page), and on "Phasen konfigurieren": `onOpenChange(false)` for the advanced sheet, then open the phase sheet. This is a small wiring change to `SettingsSection` (it currently owns `phaseSheetOpen` at `settings-section.tsx:55`); give it an optional `onRequestPhaseSheet?: () => void` callback so the parent can orchestrate the swap. When `onRequestPhaseSheet` is absent (no parent orchestration), it falls back to its current self-managed sheet.
- **IntakeImportDialog / IntakeEditDialog / bulk-delete AlertDialog** all live in `intake-history-preview.tsx` on the detail SURFACE, not in the sheet — so they never stack on top of the AdvancedSettingsSheet. No change.
- **DestructiveZoneSection's AlertDialogs** (end / purge / delete) open from inside the sheet → AdvancedSettingsSheet (sheet) + AlertDialog = 2-deep. AlertDialog over a Sheet is acceptable (it is the documented "confirm a destructive action revealed in a sheet" pattern and Radix returns focus correctly). This is at the depth ceiling; do not add a third layer. The Tier 3b delete already routes `router.push("/medications")` on success (`destructive-zone-section.tsx:181`) — add `onOpenChange(false)` for the sheet on Tier 1/2/3a success so the user lands back on a fresh surface.

## 6. Intake-history table

No new component — reuse `sections/intake-history-preview.tsx` exactly as shipped. It already wires every affordance the maintainer asked for:

- **Per-row edit**: `onEditIntake={setEditingId}` → opens `<IntakeEditDialog>` → `PUT /api/medications/{id}/intake/{eventId}` (`intake-edit-dialog.tsx:105-112`).
- **Per-row delete**: `onDeleteIntake={setPendingDeleteId}` → single-step `<AlertDialog>` → `DELETE /api/medications/{id}/intake/{eventId}` (`intake-history-preview.tsx:119-124`).
- **Bulk-delete**: `selection={{ mode:"multi", selected, onToggle }}` drives the per-row `<Checkbox>` (`intake-history-list-v2.tsx:308-323`); the toolbar appears when `selected.size > 0` (`intake-history-preview.tsx:167`) → confirm `<AlertDialog>` → `POST /api/medications/{id}/intake/bulk-delete` with `{ eventIds }` (`intake-history-preview.tsx:91-98`).

Every mutation routes through `invalidateKeys(queryClient, medicationDependentKeys)` (which includes the `compliance-chart-inline` prefix, D-3 §10 invariant 20).

Props contract reused as-is (`intake-history-list-v2.tsx:99-123`):
- `onEditIntake?: (eventId: string) => void`
- `onDeleteIntake?: (eventId: string) => void`
- `selection?: { mode: "single" | "multi"; selected: Set<string>; onToggle: (id) => void }`

**One open question** on the edit dialog — see §9.

## 7. Component inventory

### Reused as-is (no edit)
- `sections/intake-history-preview.tsx` — primary surface.
- `intake-history-list-v2.tsx` — the table.
- `intake-edit-dialog.tsx`, `intake-import-dialog.tsx` — row edit + CSV import.
- `sections/notifications-section.tsx`, `sections/api-tokens-row.tsx`, `sections/phase-config-sheet.tsx` — moved into the sheet, unchanged.
- `sections/destructive-zone-section.tsx` — moved into the sheet (one small add: call `onOpenChange(false)` on non-navigating success; see §5).
- `cadence-summary-row.tsx` — rendered with `hideEdit` always.
- `DrugLevelChart.tsx`, `TitrationSection.tsx` — read-only ladder on the surface (PascalCase pre-existing per §10 invariant 22).
- `responsive-sheet.tsx`, shadcn `dropdown-menu` — primitives.

### Edited
- `medication-detail-header.tsx` — `onEdit` becomes the picker trigger. Either embed the `<DropdownMenu>` here (preferred — keeps the header self-contained) or accept `onEditPlan` + `onOpenAdvanced` callbacks and render the menu. Recommend embedding the menu in the header and passing two callbacks down, so the page owns the open-state for wizard + sheet.
- `sections/settings-section.tsx` — add optional `onRequestPhaseSheet?: () => void` so the parent can sibling-swap the phase sheet (§5).
- `src/app/medications/[id]/page.tsx` — the big rewrite: remove `TodaysDoseCard` import + render; remove `NotificationsSection` / `SettingsSection` / `DestructiveZoneSection` from the page body and mount them inside `<AdvancedSettingsSheet>`; remove `wizardIntent` state + `openWizardWithIntent`; add `advancedOpen` state; render the two-option picker via the header; render `cadence-summary-row` with `hideEdit`. Keep both `useQuery` reads (`medicationDetail`, `medicationIntakeList`) — the latter still feeds `intakeCount`.

### New
- `src/components/medications/advanced-settings-sheet.tsx` — the only new file. Hosts the three moved sections in order.

### Deleted (usage, not files)
- Today's-dose-card removed from `page.tsx` (file kept for the list page).
- The inline settings composition in `page.tsx:348-373` (the `!oneShot && (<NotificationsSection/><Separator/><SettingsSection/>)` block + the always-on `DestructiveZoneSection`) — deleted from the page, relocated into the sheet.
- `isToday()` helper + `todayEvent` derivation in `page.tsx:138-253` — dead once the today card is gone.

## 8. Invariants to preserve (from D-3 §10)

All still apply to the moved components and the new sheet:

1. Async sections wrap loading in `<Card aria-busy aria-live="polite">` (already in `phase-config-sheet.tsx:156-167`, `api-tokens-row`).
2. Mutations announce via polite live region or persist visibly in the same paint as the toast (the optimistic switches in notifications + destructive zone already do this).
3. Icon-only triggers carry `aria-label` from i18n + context (intake kebab, `intake-history-list-v2.tsx:369`).
4. Every `<Switch>` wraps in `<label>` (notifications + pause rows — preserved).
5. Status-pill text never hides; dot `aria-hidden` + Dracula tokens (`medication-detail-header.tsx:73-99`).
6. Kebab always rendered on intake rows; no swipe.
7. **Modal stack ≤ 2** — the load-bearing one this refactor must respect: dropdown→sheet is depth 1; sheet→AlertDialog is depth 2 (ceiling); the phase sheet is sibling-swapped, not nested (§5).
9. AlertDialog Cancel keeps autofocus; never autofocus destructive (preserved in `destructive-zone-section.tsx`).
10. Intake group headers `<h3>`; dividers `<Separator>`.
11. Destructive CTAs `font-semibold` (preserved at every destructive call site).
12. Section-title icons `text-foreground`, body icons `text-muted-foreground`, every Lucide `aria-hidden`.
13. Mobile CTAs `min-h-11`; close-X 36 px exception.
14. Every animation utility carries `motion-reduce:*`.
15. TanStack keys from the central factory only.
21. `<MedicationDetailSection>` is the only section chrome; the moved sections keep it inside the sheet.
22. New files kebab-case under `src/components/medications/`.
24. `assertMedicationOwnership` is the single ownership predicate across `src/app/api/medications/[id]/**` (no new routes in v1.5.6 — every endpoint the sheet hits already exists and already uses it after D-3 C-E3-3).

Radius vocabulary (D-3 §8): Card `rounded-xl`, Dialog/Sheet `rounded-lg`, Button `rounded-md`, no `rounded-xl` Button override — unchanged, no new surfaces introduce a radius.

## 9. Open questions for the maintainer

1. **IntakeEditDialog seed bug.** The preview opens the edit dialog with a stub event `{ id, takenAt: null, skipped: false }` (`intake-history-preview.tsx:236-240`) rather than the actual row's `takenAt` / `skipped` / `note`. So "Bearbeiten" always shows an empty form regardless of the row's real state. This pre-dates v1.5.6 but sits squarely in the surface the maintainer is now blessing as primary. Fix it in this pass (thread the real `IntakeEvent` from the list row up through `onEditIntake(event)` instead of `onEditIntake(id)`) or defer? Recommendation: fix it — it is the kind of "got worse" paper-cut that prompted v1.5.6.

2. **Phase sheet swap vs. stacked sheet.** §5 proposes closing AdvancedSettingsSheet before opening PhaseConfigSheet (sibling, depth-safe). The alternative is to let them stack (depth 2, but two full-height sheets on mobile read poorly). Confirm the close-then-open swap — it means a user editing phases returns to the *surface*, not to the open settings sheet. Acceptable? Recommendation: yes, swap; phase editing is rare and self-contained.

3. **Reminder-grace placement.** Grace currently sits inside `SettingsSection`. It is arguably "plan"-adjacent (it shapes when reminders fire) rather than "advanced". Keep it in the sheet's Settings block (proposed), or is it wizard territory? Recommendation: keep in the sheet — it is per-primary-schedule and the wizard does not currently own it.
