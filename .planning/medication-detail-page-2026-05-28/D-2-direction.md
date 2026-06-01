# D-2 — v1.5.5 design direction: medication wizard polish + detail page

Authoritative spec the implementation will follow. Grounded in `I-1-deleted-features-inventory.md` (the sixteen actions the v1.5.4 cut buried) and `R-2-detail-patterns.md` (Apple Health / MyTherapy / Medisafe / Round Health / Dosecast / Shotsy + Glapp evidence, plus the verdict on architecture, history, settings, destructive flow, visual rhythm, and status-bar morph). Every layout token references what already ships under `src/components/ui/*`, `src/components/medications/*`, and `src/lib/query-keys.ts`; no new primitives, no new dependencies.

## 1. Direction in one paragraph

The wizard becomes a dignified plan editor, and a brand-new `/medications/[id]` detail page becomes everything else — Today's dose, cadence summary, dose ladder, intake history, notifications, settings (API tokens / CSV import / phase config / reminder grace), and a destructive zone. The dialog gets a wider 560 px shell on desktop, a sticky-footer + scrolling body on mobile, a top-right close X, a 40×40 step icon plate with a left-aligned step header below the progress bar, and a single 6/8 spacing rhythm so the asymmetry Marc reported can never recur. A horizontal progress band morphs across three discrete shapes (circle → rounded square → capsule) over the eight-step path, falling back to an instant snap under `prefers-reduced-motion`. The detail page reads top-down as a clinical document: drug + status pill, today's tap-to-log card, plain-language cadence line with a Bearbeiten affordance that opens the wizard, the existing dose-ladder for GLP-1, a preview of the last 7–14 intakes grouped Heute / Diese Woche / Älter with row-level Bearbeiten + Löschen, notifications, settings rows, and a three-tier destructive footer (Pausieren reversible, Beenden archival, Löschen purges). Patient feel: every action Marc lost in v1.5.4 is reachable within one scroll on the device that prompted the rebuild.

## 2. Wizard polish (`MedicationWizardDialog`)

`src/components/medications/wizard/MedicationWizardDialog.tsx` stays the entry point. The shell still nests `<ResponsiveSheet>` for the dialog/sheet split; the polish is geometry, header structure, spacing tokens, the status-bar morph, and the step transition.

### 2.1 Geometry

Desktop (`md+`) — switch from the inherited `sm:max-w-md` (≈448 px) to `sm:max-w-[560px]`. R-2's evidence: the asymmetry Marc reported reads cramped at 448 px because the cadence-summary line, the schedule list on Step 8, and the icon-plate + step subline all fight for the same horizontal band. 560 px lets the summary breathe one full line and matches the iOS 26 sheet preference for left-aligned readability.

Mobile (`< md`) — keep `<Sheet side="bottom">` capped at `max-h-[90dvh]`, sticky-pinned footer (already wired in `ResponsiveSheet`'s Sheet branch), body scroll on overflow. Add `min-h-[60dvh]` so short steps (Step 1 — single text input) don't collapse the sheet to a thin band that looks broken. The 60/90 floor + ceiling is the Marc-reported "too short" fix.

Concrete `<MedicationWizardDialog>` change:

```tsx
<ResponsiveSheet
  ...
  className="sm:max-w-[560px] min-h-[60dvh] md:min-h-0"
  bodyClassName="gap-0 p-0"
  showCloseButton           // already true; explicit for the audit
  footer={...}
>
```

The Dialog branch of `ResponsiveSheet` already applies `max-h-[calc(100dvh-2rem)]` and `overflow-y-auto` through the shared `<DialogContent>` primitive (`src/components/ui/dialog.tsx:72`). No new primitive needed; the className override drives both widths simultaneously.

### 2.2 Close affordance

Already exists in `<DialogContent>` and `<SheetContent>` at top-right. The wizard currently passes `showCloseButton` and `<ResponsiveSheet>` forwards it. The audit failure was that Marc couldn't see it because the icon is `text-muted-foreground` at low contrast against the header progress band. Two fixes:

1. The shell's first child is the progress + counter band on a `border-b` strip; the X sits absolutely positioned at `top-3 right-4` (per `dialog.tsx:84-86`). The progress strip is `p-4`, so the X overlaps it visually. Move the progress band's right-padding to `pr-12` so the X has its own gutter, mirroring how `responsive-sheet.tsx` already pads the Sheet header (`pr-12`).
2. The `<DialogContent>` close button already carries `min-h-11 min-w-11` on mobile (44 px tap target) and shrinks to 36 px on `sm+` per `dialog.tsx:86`. Leave the floor; just raise contrast by adding `text-foreground/70 hover:text-foreground` to the existing class chain in the wizard-specific override. (No edit to the shared primitive — wrap the override at the call site if contrast tests fail.)

Aria — the primitive already injects `<span class="sr-only">{t("common.close")}</span>`. Verify the DE key resolves; it ships as "Schließen" in `messages/de.json`. No new i18n keys.

### 2.3 Header structure

Vertical rhythm inside the dialog body, top to bottom:

```
┌───────────────────────────────────────────────────────────┐
│  ▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱                                  [X] │  ← progress strip + close gutter
│  Schritt 3 von 8                       [✨ Aus Text]   │
├───────────────────────────────────────────────────────────┤
│                                                           │
│  ┌────┐                                                   │
│  │ 🧪 │  Dosis & Einheit                                  │
│  └────┘  Gib die Dosis pro Einnahme an.                   │
│                                                           │
│  [ field row ]                                            │
│  [ field row ]                                            │
│                                                           │
└───────────────────────────────────────────────────────────┘
[  Zurück                                          Weiter  ] ← sticky footer
```

Concrete numbers:

- Progress strip: `border-b border-border/70 p-4 pr-12 space-y-1.5` (existing) — the `pr-12` is the close-X gutter fix.
- Step body: `space-y-6 p-6` on desktop (was `space-y-4 p-4`), `space-y-5 p-5` on mobile. Use `space-y-6 p-5 sm:p-6` so one class chain drives both.
- Icon plate: `grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border/60 bg-card` (already in `MedicationWizardDialog.tsx:417`) — keep.
- Header row: `gap-3` between plate and title block; title block uses `space-y-1`.
- Step caption (multi-schedule context): `text-muted-foreground text-xs` — keep.
- Step title: bump from `text-base font-medium leading-tight` to `text-lg font-semibold leading-tight tracking-tight` so the title outweighs the subline by the type cascade R-2 endorsed.
- Step subline: `text-muted-foreground text-sm` — keep.
- Field surface: `space-y-4`.

### 2.4 Spacing tokens — the symmetry contract

Every internal gap maps to one of three Tailwind classes; reviewers reject any PR that introduces a fourth.

| Concern | Token |
|---|---|
| Progress strip padding | `p-4 pr-12` (X-gutter on the right) |
| Step body padding | `p-5 sm:p-6` |
| Step body vertical rhythm | `space-y-5 sm:space-y-6` |
| Icon plate → title block gap | `gap-3` |
| Within title block | `space-y-1` |
| Top-level wizard sections (Step 8 only) | `gap-6 sm:gap-8` |
| Footer button group gap | `gap-2` |
| Field rows internally | `space-y-3` |

R-2's concentric 24/20 + 32 px maps to `p-6 / p-5` and `gap-8 / gap-6` cleanly. 20 px mobile floor, 32 px desktop ceiling. Nothing in between.

### 2.5 Symmetry invariants

Hard-code these into the code-review checklist for the v1.5.5 PR:

1. The step icon plate AND the primary footer CTA share `rounded-xl` (not `rounded-md`, not `rounded-lg`). The plate is `rounded-xl` today; the Button primitive ships `rounded-md`. Override the wizard-Next button to `rounded-xl` so the curvature reads as one family.
2. Every progress strip element (bar, counter text, NL button) lives at `text-xs`. The counter is already `text-xs`; do not promote.
3. The step subline (`text-sm`) and the footer secondary "Back" button text (`text-sm` via Button defaults) share weight. No bolding the subline.
4. Every section gap on Step 8 (the only multi-section step) is `gap-6 sm:gap-8`. The schedule cards inside ride `space-y-3`.
5. The 40×40 plate is the only square chrome. No nested square iconography in the body — Lucide icons render at `h-4 w-4` or `h-5 w-5` inline with text.
6. Loader animations everywhere use `animate-spin motion-reduce:animate-none`. No exceptions; this is the project precedent (e.g. `intake-history-list-v2.tsx:184`).

### 2.6 Status-bar morph animation

The dialog's progress is currently `<Progress value={progress} className="h-1" />`. R-2's verdict: morph the progress *shape* across the eight-step path so the patient feels the rhythm of the form rather than watching a fill bar inch. Three discrete shapes — circle at the head (step 1), rounded square at midpoint (step 4–5), elongated capsule at the tail (step 8). Implemented as a CSS-only `clip-path` interpolation over the existing `<Progress>` indicator; no Framer Motion, no `motion` library, no new dependency.

The fill bar itself stays linear; the *leading edge* morphs. The 280 ms total uses `cubic-bezier(0.32, 0.72, 0, 1)` — the same curve Apple ships for spring-like attack on system UI, available in plain CSS. R-2's "Material 3 spring damping 25–30" maps to this curve once translated from spring physics to a Bézier approximation.

Add to `src/app/globals.css` under a `@layer components` block (the project already keeps custom utilities there):

```css
@layer components {
  .wizard-progress-bar {
    /* Underlying primitive paints the fill; we override the
       indicator's clip-path + transition so the leading edge
       morphs across the three shapes as `--wizard-step` advances. */
    --wizard-step: 0;
    transition:
      clip-path 280ms cubic-bezier(0.32, 0.72, 0, 1),
      width 280ms cubic-bezier(0.32, 0.72, 0, 1);
  }

  /* Step 1 — leading edge is a half-circle (full radius). */
  .wizard-progress-bar[data-step="1"] [data-slot="progress-indicator"] {
    clip-path: inset(0 0 0 0 round 0 999px 999px 0);
  }

  /* Steps 2–4 — leading edge tapers to a rounded square. */
  .wizard-progress-bar[data-step="2"] [data-slot="progress-indicator"],
  .wizard-progress-bar[data-step="3"] [data-slot="progress-indicator"],
  .wizard-progress-bar[data-step="4"] [data-slot="progress-indicator"] {
    clip-path: inset(0 0 0 0 round 0 6px 6px 0);
  }

  /* Steps 5–7 — leading edge stretches into a capsule. */
  .wizard-progress-bar[data-step="5"] [data-slot="progress-indicator"],
  .wizard-progress-bar[data-step="6"] [data-slot="progress-indicator"],
  .wizard-progress-bar[data-step="7"] [data-slot="progress-indicator"] {
    clip-path: inset(0 0 0 0 round 0 999px 999px 999px);
  }

  /* Step 8 — fully filled capsule (the entire bar reads as one pill). */
  .wizard-progress-bar[data-step="8"] [data-slot="progress-indicator"] {
    clip-path: inset(0 0 0 0 round 999px);
  }

  @media (prefers-reduced-motion: reduce) {
    .wizard-progress-bar,
    .wizard-progress-bar [data-slot="progress-indicator"] {
      transition: none;
    }
  }
}
```

Wire it in `MedicationWizardDialog.tsx`:

```tsx
<Progress
  value={progress}
  className="wizard-progress-bar h-1.5"
  data-step={step}
  aria-label={stepOf}
/>
```

Three shapes, not seven (R-2's upper bound) — HealthLog's discrete state space is small. The h-1.5 (was h-1) is the minimum stroke that lets the clip-path morph register at 1× pixel density without aliasing.

Reduced-motion fallback: the transitions collapse to `none`; the clip-path still applies but snaps instantly. Patients on `prefers-reduced-motion: reduce` still see the shape rhythm — just without the easing — which preserves the navigational hint while honouring the system preference.

### 2.7 Step transition animation

R-2 hinted "fade + 8 px slide-from-right on goNext". Confirmed, but the fade carries the load; the 8 px slide should only ride on goNext, NOT goBack (sliding from the right on backward navigation reads as a forward gesture and confuses the spatial model).

```css
@layer components {
  .wizard-step-body {
    animation: wizard-step-in 220ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  .wizard-step-body[data-direction="back"] {
    animation-name: wizard-step-back-in;
  }

  @keyframes wizard-step-in {
    from {
      opacity: 0;
      transform: translateX(8px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes wizard-step-back-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .wizard-step-body,
    .wizard-step-body[data-direction="back"] {
      animation: none;
    }
  }
}
```

Wire the direction on the body wrapper:

```tsx
const [direction, setDirection] = useState<"next" | "back">("next");
// goNext / goBack already exist; set the direction before setStep(...).

<div
  ref={bodyRef}
  className="wizard-step-body space-y-5 p-5 sm:space-y-6 sm:p-6"
  data-slot="wizard-step-body"
  data-direction={direction}
  key={step}     // existing — forces re-mount on step change
>
```

The `key={step}` already in place re-mounts the body on every step change, which triggers the CSS animation deterministically without needing any state machine.

## 3. Detail page — `src/app/medications/[id]/page.tsx` (NEW)

`/medications/[id]/history/page.tsx` exists today; `/medications/[id]/page.tsx` does not. v1.5.5 creates the route and the existing history page stays for the dedicated bulk-history surface (§6). The route is a client component (`"use client"`) because every section subscribes through TanStack Query.

Vertical rhythm at the route level: outer wrapper `space-y-6 sm:space-y-8` so sections breathe at 24/32 px — R-2's concentric token. Inner sections use the existing `<MedicationDetailSection>` wrapper at `src/components/medications/medication-detail-section.tsx` for chrome symmetry with the GLP-1 sub-pages.

Mobile-first: every wireframe below describes the 360 px baseline. On `md+` the page widens to `max-w-3xl mx-auto` so the cadence-summary line + intake-history table stop reading edge-to-edge on tablet portrait.

### Section order (locked)

```
1. Header band                 — drug name + dose + status pill + edit affordance
2. Today's dose card           — Genommen / Übersprungen / Verschoben one-tap
3. Cadence summary             — plain-language line + Bearbeiten → wizard
4. Dose ladder / Phasen        — only for GLP-1 + course window
5. Intake history preview      — last 7–14 grouped Heute / Diese Woche / Älter
6. Notifications               — switch + helper line
7. Settings                    — API tokens, CSV import, Phasen, grace
8. Destructive zone            — Pausieren / Beenden / Löschen
```

Daily actions at the top (log today's dose, see what's coming), rare ones at the bottom — Apple Health's pattern with the labelled destructive zone Apple's surface lacks.

### 3.1 Header band

```
┌───────────────────────────────────────────────────┐
│ Mounjaro                              [✏ Bearbeiten] │
│ 7,5 mg                                            │
│ ● Aktiv  ·  Wöchentlich · seit 12.03.            │
└───────────────────────────────────────────────────┘
```

- Component: inline JSX (no new wrapper). The header is light enough not to warrant a custom component.
- Type cascade: `text-2xl font-bold tracking-tight` for the drug name (matches `/medications/[id]/history/page.tsx:82`); `text-muted-foreground text-sm` for the dose; `text-xs` for the status row.
- Status pill: `<Badge variant="secondary">` with one of three shapes (Aktiv / Pausiert / Beendet). The accent dot is a `bg-emerald-500` / `bg-amber-500` / `bg-zinc-500` square `h-2 w-2 rounded-full`.
- Edit affordance: outline `<Button variant="outline" size="sm">` with the `Pencil` Lucide icon and the `t("common.edit")` label, fires `setEditDialogOpen(true)` → mounts `<MedicationWizardDialog mode="edit" initial={…} />` (see §5).
- API: read via `queryKeys.medicationDetail(id)` from `GET /api/medications/[id]` — already used by `/medications/[id]/history/page.tsx`.

Empty state: not applicable (a 404 redirects before the page mounts).

### 3.2 Today's dose card

```
┌───────────────────────────────────────────────────┐
│ Heute                                              │
│ Geplant: 08:00                                     │
│ [✓ Genommen]   [⤳ Verschoben]   [✗ Übersprungen]  │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<TodaysDoseCard>` in `src/components/medications/todays-dose-card.tsx`. Uses `<Card>` from shadcn for chrome. Three primary buttons in a `flex gap-2 flex-wrap` row.
- API: `POST /api/medications/[id]/intake` with `{ status: "TAKEN" | "SKIPPED" | "DEFERRED" }`. The route already exists; the shape mirrors the per-card action on the list page.
- Query key: invalidates `medicationDependentKeys` and `queryKeys.medicationDetail(id)` on success.
- Each button: `min-h-11` mobile tap target (44 px floor), `sm:min-h-9`. Inside the Card, `p-5 sm:p-6 space-y-4`.
- Empty-state copy DE: `Heute keine Einnahme geplant.` rendered when the cadence has no due-event for today.

### 3.3 Cadence summary

```
┌───────────────────────────────────────────────────┐
│ Rhythmus                                          │
│ Wöchentlich, mittwochs · 08:00                    │
│ Kurs: 12.03.2026 → 12.06.2026                     │
│                                       [✏ Bearbeiten] │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<CadenceSummaryRow>` in `src/components/medications/cadence-summary-row.tsx`. Mounts `<MedicationDetailSection>` for chrome.
- Logic: reuses the existing `summariseCadence(payload, t)` helper at `src/components/medications/wizard/wizard-payload.ts:657` — the wizard's Step 8 summary line. Pass the medication payload + the translator and render the returned string.
- Edit affordance: outline button identical to the header's, opens the wizard prefilled with the current state.
- API: read-only; no mutations on this row.
- Query key: shares `queryKeys.medicationDetail(id)` with the header.
- Empty state: only appears for course-mode + recurring meds; one-shot meds render a single-line `Einmalig am DD.MM.` and hide the Bearbeiten affordance (the wizard handles one-shot edits but the row label changes).

### 3.4 Dose ladder / Phasen (GLP-1 only)

Reuses the existing `<TitrationSection>` at `src/components/medications/TitrationSection.tsx`. Currently mounted only when `treatmentClass === "GLP1"` on the history page; lift the same conditional onto the detail page. Reads `GET /api/medications/[id]/titration`; query key `queryKeys.medicationTitration(id)`.

The PhaseConfigDialog functionality (green/yellow/orange/red bands) is NOT this section — that's the §7 SettingsSection sub-row.

Empty state: when the medication is GLP-1 but no titration is configured, the existing component already handles the placeholder; no new copy.

### 3.5 Intake history preview

```
┌───────────────────────────────────────────────────┐
│ Einnahmen                       [⤴ Importieren]   │
│                                                    │
│ Heute                                              │
│   08:02   7,5 mg   ✓ Genommen          ⋯          │
│                                                    │
│ Diese Woche                                        │
│   Mi 08:00   7,5 mg   ✓ Genommen        ⋯          │
│   So 08:00   —        ✗ Übersprungen    ⋯          │
│                                                    │
│ Älter                                              │
│   Mi 22.05  08:00   7,5 mg   ✓ Genommen ⋯          │
│                                                    │
│              [ Alle Einnahmen anzeigen ]           │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<IntakeHistoryPreview>` wrapping `<IntakeHistoryListV2>` with new props (see §6). Uses `<MedicationDetailSection>` for chrome.
- API: `GET /api/medications/[id]/intake?limit=14&offset=0&status=completed&sortBy=takenAt&sortDir=desc`.
- Query key: `queryKeys.medicationIntakeList(id, { sortBy: "takenAt", sortDir: "desc", limit: 14, offset: 0, status: "completed" })`. Already in the factory — no new key.
- Grouping: client-side bucket by `takenAt` (or `scheduledFor` if no taken) into Heute (today), Diese Woche (this ISO week excluding today), Älter (everything before).
- Per-row affordance: mobile uses a swipe-to-reveal pattern; desktop renders a kebab. Both fire `setEditingEvent({ id, scheduledFor })` or `setDeletingEvent({ id })` on the parent.
- The "Alle Einnahmen anzeigen" CTA links to `/medications/[id]/history` (the existing dedicated page).
- The "⤴ Importieren" CTA opens the existing `IntakeImportDialog` (currently orphaned at `src/app/medications/page.tsx:344`); the detail page lifts the dialog onto its own surface and wires the trigger.
- Empty state DE (already in i18n): `Noch keine Einnahmen erfasst.` from `messages/de.json:1001` + the existing action chip routing to `/medications`.

### 3.6 Notifications

```
┌───────────────────────────────────────────────────┐
│ Erinnerungen                                       │
│                                          [●—   ]  │
│ APNs · Telegram · Web-Push                         │
│ Ruhezeit 22:00 – 07:00                             │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<NotificationsSection>` in `src/components/medications/sections/notifications-section.tsx`. Uses `<MedicationDetailSection>`.
- Primary control: `<Switch>` from shadcn (`src/components/ui/switch.tsx`). On toggle: `PUT /api/medications/[id]` with `{ notificationsEnabled }`. Optimistic update — flip the cache, rollback on error.
- Helper line below the switch: lists the active push channels as `<Badge variant="outline">` chips, reading from `queryKeys.notificationsStatus()`. Single-line read; no per-channel toggles on this surface (those live in global Settings).
- Query keys: invalidates `queryKeys.medicationDetail(id)` + `medicationDependentKeys` on success.
- iOS clientManaged note: when the calling session has `notificationPrefs.clientManaged === true`, render a single `text-xs text-muted-foreground` line: `Diese Erinnerungen werden auf deinem iPhone verwaltet.` (new DE key `medications.notifications.clientManagedNote`).
- Empty state: not applicable — the switch always renders.

### 3.7 Settings consolidation

R-2's verdict: inline `<SettingsSection>`, NOT a Sheet/Drawer. Locked.

```
┌───────────────────────────────────────────────────┐
│ Einstellungen                                      │
│                                                    │
│ ┌─ Externe Integration ───────────────────────┐    │
│ │  Token „iOS"     Erstellt 12.03.   Widerrufen │    │
│ │  Token „Bot"     Erstellt 02.04.   Widerrufen │    │
│ │  [ + Neuen Token erstellen ]                  │    │
│ │  Endpunkt:  POST /api/medications/abc/intake  │    │
│ │  [ Kopieren ]                                 │    │
│ └───────────────────────────────────────────────┘    │
│                                                    │
│ ┌─ Einnahmen importieren ─────────────────────┐    │
│ │  CSV oder JSON. Lädt deine bestehenden      │    │
│ │  Einnahmen in die Historie.                  │    │
│ │  [ ⤴ Importieren ]                            │    │
│ └───────────────────────────────────────────────┘    │
│                                                    │
│ ┌─ Erinnerungsphasen ─────────────────────────┐    │
│ │  Grün       60     Min  vor Kursende        │    │
│ │  Gelb       30     Min  vor Kursende        │    │
│ │  Orange      0     Min  nach Kursende       │    │
│ │  Rot       240     Min  nach Kursende       │    │
│ │  [ Auf Standard ] [ Speichern ]              │    │
│ └───────────────────────────────────────────────┘    │
│                                                    │
│ ┌─ Erinnerungsfenster (Grace) ────────────────┐    │
│ │  Kulanz in Minuten:  [ 15 ▼ ]                │    │
│ │  Erinnerungen sind innerhalb dieses Fensters │    │
│ │  noch fällig.                                │    │
│ └───────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<SettingsSection>` in `src/components/medications/sections/settings-section.tsx`. Wraps `<MedicationDetailSection>` and composes four sub-rows. Each sub-row is its own component file so the unit tests stay narrow.

Sub-rows + wiring:

| Row | Component | Mount when | API | Invalidate |
|---|---|---|---|---|
| Externe Integration | `<ApiTokensRow>` (resurrects `ApiEndpointDialog` body inline) | always | `GET /api/medications/[id]/api-endpoint`, `POST /api/medications/[id]/api-endpoint` to mint, `DELETE /api/tokens/[id]` to revoke | `queryKeys.tokens()` + `queryKeys.medicationDetail(id)` |
| CSV-Import | `<CsvImportRow>` | always | opens `IntakeImportDialog` → `POST /api/medications/[id]/intake/import` | `queryKeys.medicationIntakeList(...)` prefix + `medicationDependentKeys` |
| Phasen | `<PhaseManagementRow>` (inline editor, NOT a nested dialog) | `treatmentClass === "GLP1"` + has course window | `GET/PUT/DELETE /api/medications/[id]/phase-config` | `queryKeys.medicationPhaseConfig(id)` |
| Grace | `<GraceMinutesRow>` | always | `PUT /api/medications/[id]` with `{ reminderGraceMinutes }` (per-schedule field — applied to the medication's primary schedule for the v1.5.5 surface; multi-schedule grace is a v1.5.x follow-up) | `queryKeys.medicationDetail(id)` |

PhaseManagementRow's decision (R-2 left it open): inline editor, not a focused modal. The four rows fit in 320 px of vertical space; nesting a dialog inside a settings card is the v1.5.4 mistake repeated. Rows render as a `grid grid-cols-[1fr,5rem,4rem,1fr] gap-2 items-center` (label / numeric input / MINUTES toggle / suffix). The "Auf Standard zurücksetzen" and "Speichern" CTAs sit in a footer row below the grid (`flex justify-end gap-2 pt-3`). Status banner becomes a `toast.success(t("medications.phaseSaved"))` — drop the 2 s auto-clear banner.

Empty states:
- ApiTokensRow with no tokens: `Noch kein Token erzeugt.` + the create button.
- PhaseManagementRow when no course window is set: rendered as a stub row `Phasen sind nur mit Kurs-Fenster verfügbar.` linking back to the cadence-summary edit affordance.

### 3.8 Destructive zone

```
┌───────────────────────────────────────────────────┐
│ Gefahrenzone                                       │
│                                                    │
│  Pausieren                                  [●—  ] │
│  Erinnerungen pausieren, Verlauf bleibt.           │
│                                                    │
│  ─────────────────────────────────────────────     │
│                                                    │
│  Beenden            [Medikament beenden]           │
│  Kein neuer Verlauf, alte Einträge bleiben.        │
│                                                    │
│  ─────────────────────────────────────────────     │
│                                                    │
│  Verlauf löschen    [Verlauf löschen]              │
│  Nur Einnahmen löschen, Medikament bleibt.         │
│                                                    │
│  Medikament löschen [Medikament löschen]           │
│  Löscht das Medikament samt allen Einnahmen.       │
│                                                    │
└───────────────────────────────────────────────────┘
```

- Component: NEW `<DestructiveZoneSection>` in `src/components/medications/sections/destructive-zone-section.tsx`. Uses `<MedicationDetailSection>` with `title={t("medications.dangerZoneTitle")}` (already in i18n at `messages/de.json:2260`).
- Row spacing: `space-y-4` with `<Separator>` from shadcn (`src/components/ui/separator.tsx`) between tiers.
- Tier 1 — Pausieren: `<Switch>`, no confirmation. `PUT /api/medications/[id]` with `{ active: false, pausedAt: <iso> }`. Optimistic. Header pill flips to "Pausiert". Fully reversible.
- Tier 2 — Beenden: single-step `<AlertDialog>` confirmation. `PUT /api/medications/[id]` with `{ endsOn: <today-iso> }` so the existing course-window-ended path kicks in. Title `Medikament beenden?`; body `Keine weiteren Erinnerungen. Alte Einträge bleiben sichtbar.`; destructive action button `Beenden`.
- Tier 3a — Verlauf löschen (purge intake): single-step `<AlertDialog>` confirmation per the existing `settings/advanced-section.tsx` precedent. `DELETE /api/medications/[id]/intake/purge`. Title `Verlauf wirklich löschen?`; body `Die {count} Einnahmen werden unwiderruflich gelöscht. Das Medikament selbst bleibt.`; destructive action.
- Tier 3b — Medikament löschen: single-step `<AlertDialog>` confirmation, same primitive. `DELETE /api/medications/[id]`. Title `Medikament löschen?`; body lists what gets purged. After success, `router.push("/medications")`.

The type-back-name guard mentioned in the brief is overkill for the project's precedent — `settings/advanced-section.tsx:287-317` ships a single-step alert dialog for the user-wide purge, which is a strictly more destructive action than a per-medication delete. Match that precedent: single-step `<AlertDialog>` with destructive accent on the confirm button. Documented as an open question (§13) so Marc can override.

## 4. Restored-feature placement table

Every row traces to an `I-1-deleted-features-inventory.md` row.

| # | Feature (Marc's German label) | Trigger today | v1.5.4 status | v1.5.5 home | Section | Component |
|---|---|---|---|---|---|---|
| 1 | Bearbeiten | none — wizard handles it | LIVE | wizard (edit mode) | Header band + Cadence summary | `<MedicationWizardDialog mode="edit">` |
| 2 | Löschen (Medikament) | none | ORPHAN | tier 3b destructive | Destructive zone | `<DestructiveZoneSection>` + `<AlertDialog>` |
| 3 | Pausieren / Aktivieren | none | ORPHAN | tier 1 destructive | Destructive zone | `<DestructiveZoneSection>` `<Switch>` |
| 4 | Benachrichtigungen aus / ein | none | ORPHAN | Notifications switch | Notifications | `<NotificationsSection>` |
| 5 | Einnahmen importieren | none | ORPHAN | Settings CSV row + Einnahmen header | Settings + Intake history | `<CsvImportRow>` + `<IntakeHistoryPreview>` header CTA → existing `IntakeImportDialog` |
| 6 | API-Endpunkt | none | ORPHAN | Externe Integration sub-row | Settings | `<ApiTokensRow>` (resurrects `ApiEndpointDialog` body inline) |
| 7 | Titrations-Phasen konfigurieren (GLP-1) | none | ORPHAN | Phasen sub-row (inline) | Settings | `<PhaseManagementRow>` (replaces `PhaseConfigDialog` modal) |
| 8 | Aufzeichnungen löschen (Purge) | none | ORPHAN | tier 3a destructive | Destructive zone | `<DestructiveZoneSection>` + `<AlertDialog>` |
| 9 | Zurücksetzen (form reset) | none | n/a — create flow only | (deferred) | wizard | wizard internal — out of scope per I-1 |
| 10 | GLP-1 Wochentags-Preset | wizard Step 5 | LIVE (in wizard) | wizard Step 5 | wizard | `<Step5Cadence>` |
| 11 | Schedule hinzufügen / entfernen | wizard Step 8 | LIVE (in wizard, single-schedule edit; multi-schedule compose deferred) | wizard Step 8 | wizard | `<Step8Summary>` |
| 12 | Legacy reminder window fallback | wizard Step 7 | LIVE (in wizard via `legacyOnLoad`) | wizard Step 7 | wizard | `<Step7Times>` |
| 13 | One-Shot Switch | wizard Step 4 | LIVE (in wizard) | wizard Step 4 | wizard | `<Step4Window>` |
| 14 | Course-Window-Picker | wizard Step 4 | LIVE (in wizard) | wizard Step 4 | wizard | `<Step4Window>` + `<CourseWindowRow>` |
| 15 | Einnahmen bearbeiten (per-dose) | `/medications/[id]/history` row (read-only today) | DEGRADED | Intake history preview row kebab/swipe | Intake history preview | `<IntakeHistoryListV2>` with `onEditIntake` |
| 16 | Einnahmen löschen (per-dose) | same | DEGRADED | same | Intake history preview | `<IntakeHistoryListV2>` with `onDeleteIntake` |

Items 1, 10, 11, 12, 13, 14 stay in the wizard per §5. Items 2–8, 15, 16 land on the detail page. Item 9 is the only one explicitly out of scope (I-1 §1, "n/a — not on detail page; lives on wizard").

## 5. Edit-the-medication trigger

Contract:

- Wizard owns: `name`, `category`, `treatmentClass`, `dose`, `dosesPerUnit`, `oneShot`, `startsOn`, `endsOn`, `schedules[]`.
- Detail page owns everything else: `active`, `notificationsEnabled`, `pausedAt`, phase-config bands, API tokens, CSV import, reminder grace, intake CRUD, destructive cascade.

Two triggers open `<MedicationWizardDialog mode="edit" initial={medicationToPayload(med)} />`: the header band's `[✏ Bearbeiten]` outline button (lands on Step 1) and the cadence-summary row's `[✏ Bearbeiten]` button (lands on `landingStepForEdit(payload)` per the existing helper — currently the cadence step).

The list page keeps its own wizard mount for create + per-card edit; the detail page mounts a second copy with its own state. On save the wizard already invalidates `medicationDependentKeys`; the detail page additionally invalidates `queryKeys.medicationDetail(id)` so the header re-renders.

## 6. Intake history detail

Two surfaces:

### 6.1 Inline preview on `/medications/[id]/page.tsx`

`<IntakeHistoryPreview>` wraps `<IntakeHistoryListV2>` and projects only the last 14 rows. The grouped Heute / Diese Woche / Älter rendering lives in the wrapper, not in V2 (V2 stays a flat sortable table for the dedicated history page).

### 6.2 Dedicated surface — `/medications/[id]/history/page.tsx`

Already exists. Bulk surface, month-grouped pagination, the existing `<IntakeHistoryListV2>` table, the GLP-1 sub-sections (`DrugLevelChart`, `SideEffectsSection`, `SchedulingSection`, `TitrationSection`). v1.5.5 adds bulk-delete: a header CTA `Auswählen` flips the table into multi-select mode (`<Checkbox>` per row, header-row "Alle" checkbox), and a sticky-bottom action bar surfaces `{n} ausgewählt` + a single destructive `<AlertDialog>` confirming the batch delete. Backend: existing `DELETE /api/medications/[id]/intake/[eventId]` looped via `Promise.allSettled` — no new API route.

### 6.3 `<IntakeHistoryListV2>` prop additions

Current props: `medicationId`, `pageSize`. The list is read-only today (the JSDoc spells this out — "No edit-in-row, no delete buttons").

Add three optional props:

```ts
interface IntakeHistoryListV2Props {
  medicationId: string;
  pageSize?: number;
  /** When provided, each row renders a per-row trigger that fires this. */
  onEditIntake?: (event: IntakeEvent) => void;
  /** When provided, each row renders a per-row trigger that fires this. */
  onDeleteIntake?: (event: IntakeEvent) => void;
  /** Bulk mode — adds a leading checkbox column + emits selection updates. */
  selection?: {
    selected: Set<string>;
    onToggle: (id: string) => void;
  };
}
```

The detail-page preview wraps V2 with `onEditIntake` and `onDeleteIntake` callbacks that open a `<ResponsiveSheet>`-backed edit sheet (re-use `responsive-sheet.tsx`) and an `<AlertDialog>` respectively. The history page passes a `selection` prop when the user enters bulk mode.

The trigger element on mobile is a swipe-to-reveal Bearbeiten + Löschen affordance using CSS scroll-snap (no JS gesture library — the project bans new dependencies). On desktop it's a `<DropdownMenu>` kebab at the row's right edge. Both targets respect the 44 px floor.

Edit mutation: `PUT /api/medications/[id]/intake/[eventId]` with `{ takenAt? , scheduledFor?, skipped?, notes? }`. Invalidates the `["medications", id, "intake", "list"]` prefix.

Delete mutation: `DELETE /api/medications/[id]/intake/[eventId]`. Same invalidation prefix.

## 7. Settings consolidation

§3.7 is the authoritative spec. Decision the brief asked: **inline editor for Phasen, no nested dialog.** The four bands fit comfortably; nesting modals inside settings cards repeats the v1.5.4 mistake.

## 8. Destructive zone

§3.8 is the authoritative spec. Three tiers, single-step `<AlertDialog>` on Tier 2 + 3a + 3b matching the existing project precedent in `settings/advanced-section.tsx:287-317`. Type-back-name guard filed as open question §13.

## 9. Status-bar morph — pinned spec

§2.6 holds the implementation-locked CSS. Restated as a contract:

- One CSS class (`.wizard-progress-bar`) lives in `globals.css`.
- The class drives a `clip-path: inset(...)` interpolation across four `data-step` buckets — step 1 (half-circle leading edge), steps 2–4 (rounded square), steps 5–7 (capsule), step 8 (full capsule).
- Transition: `clip-path` and `width` both at `280ms cubic-bezier(0.32, 0.72, 0, 1)`.
- The `<Progress>` indicator's underlying slot (`data-slot="progress-indicator"`) is targeted — this is the radix-ui Progress primitive's stable selector, exposed by shadcn.
- `prefers-reduced-motion: reduce` collapses the transition to `none`; the clip-path still applies but snaps. No animation runs.
- No JS state machine. The morph rides entirely on the `data-step={step}` attribute already available in the wizard.

R-2 specified "spring damping 25–30" for Material 3 Expressive. The CSS-only equivalent is `cubic-bezier(0.32, 0.72, 0, 1)` — Apple's iOS-default ease-out attack, well-known in design-press literature as the cleanest spring-emulation in pure CSS. 280 ms total because R-2's three-shape morph at 60 fps reads as crisp at ≤ 300 ms and laggy past 400 ms.

## 10. Iconography & typography map

Lucide icons per section:

| Section | Lucide |
|---|---|
| Header edit | `Pencil` |
| Today's dose | `Sunrise` |
| Cadence summary | `Repeat` |
| Dose ladder | `TrendingUp` |
| Intake history | `History` (matches V2 empty state) |
| Notifications | `Bell` |
| Settings | `Settings2` |
| Externe Integration | `KeyRound` |
| CSV Import | `Upload` |
| Phasen | `Layers` |
| Grace | `Timer` |
| Destructive zone | `AlertTriangle` |
| Pausieren / Beenden / Löschen | `Pause` / `Square` / `Trash2` |

Sizing: `h-5 w-5` next to a section title; `h-4 w-4` inside body rows. All `aria-hidden="true"` because labels carry the accessible name.

Type cascade (R-2: 28 / 17 / 15 / 13 px):

| Role | Tailwind | Use |
|---|---|---|
| Drug name | `text-2xl font-bold tracking-tight` | Header band only |
| Section title | `text-base font-semibold leading-6 tracking-tight` | Every `<MedicationDetailSection>` heading (matches `medication-detail-section.tsx:67`) |
| Body | `text-sm` | Default for every paragraph + helper line |
| Micro / timestamps / status pills | `text-xs` | Status row, ms-since labels, Badge text |

Left-aligned throughout. No centring inside cards. The wizard's Step 8 summary is the only exception (`text-center` for the badge-row of completion icons), unchanged from current.

## 11. Component tree

```
src/app/medications/[id]/page.tsx (NEW)
├── <MedicationDetailHeader>           NEW — inline JSX block, no separate file needed
├── <TodaysDoseCard>                   NEW — src/components/medications/todays-dose-card.tsx
├── <CadenceSummaryRow>                NEW — src/components/medications/cadence-summary-row.tsx
├── <TitrationSection>                 EXISTS — src/components/medications/TitrationSection.tsx
├── <IntakeHistoryPreview>             NEW — src/components/medications/sections/intake-history-preview.tsx
│   └── <IntakeHistoryListV2>          🔧 needs prop additions (§6.3)
├── <NotificationsSection>             NEW — src/components/medications/sections/notifications-section.tsx
├── <SettingsSection>                  NEW — src/components/medications/sections/settings-section.tsx
│   ├── <ApiTokensRow>                 NEW — src/components/medications/sections/api-tokens-row.tsx
│   ├── <CsvImportRow>                 NEW — src/components/medications/sections/csv-import-row.tsx
│   ├── <PhaseManagementRow>           NEW — src/components/medications/sections/phase-management-row.tsx
│   └── <GraceMinutesRow>              NEW — src/components/medications/sections/grace-minutes-row.tsx
├── <DestructiveZoneSection>           NEW — src/components/medications/sections/destructive-zone-section.tsx
├── <MedicationWizardDialog mode="edit"> EXISTS — src/components/medications/wizard/MedicationWizardDialog.tsx 🔧 polish (§2)
├── <IntakeImportDialog>               EXISTS — currently inline at src/app/medications/page.tsx:344, EXTRACT to standalone file
└── <ApiEndpointDialog>                EXISTS — currently inline at src/app/medications/page.tsx:559, RETIRE (logic absorbed by <ApiTokensRow>)
```

Refactor pre-work: extract `IntakeImportDialog` from `src/app/medications/page.tsx` into `src/components/medications/intake-import-dialog.tsx` so the detail page imports cleanly. `ApiEndpointDialog`'s body folds entirely into `<ApiTokensRow>` — the inline dialog stops existing.

## 12. Out of scope for v1.5.5

- Cadence-engine read-flip (separate v1.5.x track).
- Wider design-system refresh — only the wizard + detail-page surfaces shift.
- Native iOS mirror — the contract under `docs/api/openapi.yaml` is locked; iOS picks up the new endpoints (none — every wired API in this doc already ships) when its own release cuts.
- Multi-medication batch actions on the list page (`/medications/page.tsx`). The list stays card-grid; v1.5.5 only adds a per-card link to the detail page.
- Type-back-name destructive guard — filed in §13 for Marc to decide.
- Wizard multi-schedule compose mode — the flat form's multi-schedule edit path is acknowledged by I-1 item 11 as deferred. The wizard still supports the single-schedule edit path; the detail page does not duplicate the schedule list. A "Weitere Zeitpläne bearbeiten" affordance can land in v1.5.6 if Marc's clinical workflow proves the wizard's single-schedule view too restrictive.
- Framer Motion / `motion` / Lottie. CSS animations only, per the project's no-new-deps rule.

## 13. Open questions for Marc

1. **Detail-page route URL.** `/medications/[id]/page.tsx` is proposed as the new top-of-the-funnel route. `/medications/[id]/history` stays as the dedicated bulk-history surface (it already mounts `DrugLevelChart`, `SideEffectsSection`, `SchedulingSection`, `TitrationSection`, `IntakeHistoryListV2`). Confirm the split, or do you want the detail page to live AT `/medications/[id]/history` and the bulk surface to move to `/medications/[id]/history/full`?
2. **Type-back-name confirm on delete.** The project precedent in `src/components/settings/advanced-section.tsx:287-317` is a single-step `<AlertDialog>` for the more-destructive "delete every user data point" surface. v1.5.5 follows that precedent for the per-medication delete + purge. Are you OK with the single-step guard, or do you want the type-back-name pattern for the per-medication delete? (Note: no such pattern exists in the tree today; introducing one is a new primitive.)
3. **Phase-management editor.** §3.7 + §7 lock the inline editor on the detail page. The alternative is to resurrect `PhaseConfigDialog` as a focused `<ResponsiveSheet>` opened from a `<PhaseManagementRow>` button. Inline is the proposal because nesting a modal inside a settings card is the v1.5.4 mistake; a focused sheet from a settings row would partially repeat it. Confirm inline.
4. **Status-bar morph variant.** §2.6 commits to the three-shape clip-path morph (half-circle / square / capsule / full capsule) over 280 ms. R-2's reference was Material 3 Expressive's seven-shape loop; we collapsed to three shapes because HealthLog's state space is discrete and small. If you want something even more subtle — say a single capsule that just stretches without changing radius — the CSS collapses further. Confirm three-shape, or downgrade to width-only.
