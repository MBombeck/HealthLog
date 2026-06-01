# R-medui — Medication detail page + history view + advanced-settings redesign

Implementation-ready frontend spec for the v1.7.0 medication-detail
overhaul. Builds **on top of** the v1.5.6 G-1 / v1.6.0 composition (the
files cited below are the *current* tree, not a clean slate). Scope:
the `/medications/[id]` header button row, the history view, and the
advanced-settings dialog. The list page (`/medications`) is untouched.

Conventions honoured: RSC-by-default does not apply (these are all
`"use client"` surfaces with TanStack reads); every `t()` call must
resolve in `messages/en.json` and propagate across `de/en/es/fr/it/pl`
(`i18n-call-site-coverage.test.ts` + `i18n-locale-integrity.test.ts`);
queryKeys come from `src/lib/query-keys.ts`; envelope reads unwrap
`(await res.json()).data`. Recharts (`DrugLevelChart`) stays.

---

## 0. Current state (what we are changing)

- **Header** (`medication-detail-header.tsx:108-129`): two buttons —
  `Pencil` "Edit" (outline) opening the wizard, and a `Settings2`
  ghost icon opening `<AdvancedSettingsSheet>`. **There is no history
  button.** History is reached only via the text link
  `"View full history →"` at the bottom of the intake preview
  (`intake-history-preview.tsx:220-228`) which routes to
  `/medications/[id]/history`.
- **History route** (`[id]/history/page.tsx`): renders, in order,
  `DrugLevelChart` (estimated active-ingredient curve) →
  `SideEffectsSection` → `SchedulingSection` ("Rhythmus") →
  `TitrationSection` → `IntakeHistoryListV2`. So the curve and the
  schedule editor dominate, and the intake table is last. The
  `IntakeHistoryListV2` default sort is `takenAt desc`
  (`intake-history-list-v2.tsx:156-157`) — but skipped rows have
  `takenAt: null`, rendered as `—` (line 329-331), which under
  `desc` collation sort *after* real timestamps in Postgres `NULLS
  LAST`… except the server default may emit `NULLS FIRST`, surfacing
  skipped/`—` rows at the top. That is the "skipped first" nonsense.
- **AdvancedSettingsSheet** (`advanced-settings-sheet.tsx`): a
  `<ResponsiveSheet contentWidth="lg">` (so desktop = `sm:max-w-lg` =
  512px, not 448 — the cramped feel is the `lg` cap + the three
  stacked `<MedicationDetailSection>` cards each with their own border
  chrome). Hosts Notifications → Settings (API / CSV-stub / Phasen /
  Grace) → DestructiveZone. **CSV import is only a one-line stub here**
  (`settings-section.tsx:116-127`); the real dialog lives on the
  intake preview header. Button styling is mixed: outline mint, ghost,
  destructive, primary — no consistent grouping.

The maintainer's asks map onto: (1) restore a history icon, (2) make
the history view intake-only + date-desc + direct, (3) add a third
gear button, (4) widen + re-group the advanced dialog with real CSV
import. Below is the target.

---

## 1. Icon picks (Lucide)

| Slot | Icon | Justify |
|---|---|---|
| **Edit** (keep) | `Pencil` | Already the anchor (`medication-detail-header.tsx:21,116`). Universally "edit". Unchanged. |
| **History** (restore) | **`History`** | Lucide `History` *is* the clock-with-counterclockwise-arrow glyph (a clock face with a CCW rewind arrow wrapping its left side) — exactly "the old icon" the maintainer describes. It is already imported and used 107× across the tree (incl. `intake-history-list-v2.tsx:11` as the empty-state icon), so it is the established HealthLog "history" semantic. `RotateCcw` is a bare rewind arrow with *no* clock face (reads as "undo/reset", and is already the IntakeImportDialog reset action — reusing it would collide semantically). `Undo2` reads as "undo last action". **Pick `History`.** |
| **Advanced settings** (new 3rd button) | **`SlidersHorizontal`** | Must be visually distinct from the `Pencil` edit. `Settings2` (the current advanced icon) is a gear — fine, but gears read as "app/global settings" and this dialog is *per-medication data + lifecycle controls*. `SlidersHorizontal` (three horizontal sliders) reads as "tune / advanced options for this thing", is already in the tree (8×), and is unmistakably different from a pencil at 16px. **Pick `SlidersHorizontal`.** (If the maintainer prefers a gear, `Settings2` is the fallback — but the brief explicitly lists `Settings2` *or* `SlidersHorizontal` and asks for "distinct from the edit pencil"; sliders win on distinctness.) |

Status dots (`bg-[hsl(var(--success/warning))]`) and all other icons
unchanged.

---

## 2. Detail-page header button row (Ask 1 + 3)

### 2.1 Component changes — `medication-detail-header.tsx`

Replace the two-button cluster (lines 108-129) with a **three-button
icon row**, all `size="icon"` for visual rhythm except Edit which
keeps its label on `sm+` (Edit is the primary action; History +
Advanced are secondary icon-only with tooltips/`aria-label`).

Prop changes to `MedicationDetailHeaderProps`:

```ts
export interface MedicationDetailHeaderProps {
  name: string;
  dose: string;
  active: boolean;
  endsOn?: string | null;
  onEditPlan: () => void;       // keep — Pencil → wizard
  onOpenHistory: () => void;    // NEW — History → /history navigation
  onOpenAdvanced: () => void;   // keep — SlidersHorizontal → sheet
}
```

`onOpenHistory` is a `() => void` so the page can decide between a
client `router.push` and a `<Link>`. Spec uses `router.push` from the
page (the page already imports `useRouter`, `page.tsx:31,137`) so the
history button is a real button (icon-only buttons should not be
anchors when they carry an `aria-label`).

### 2.2 Button order + styling

Left→right: **Edit · History · Advanced**. Rationale: Edit is the
primary (labelled, `variant="outline"`); History is the most-used
read action (icon, `variant="ghost"`); Advanced is rare/heavy (icon,
`variant="ghost"`). DOM order = Edit→History→Advanced so the
screen-reader walk goes primary→read→config.

```tsx
<div className="flex items-center gap-1.5">
  <Button variant="outline" size="sm"
    className="min-h-11 sm:min-h-9" onClick={onEditPlan}
    data-slot="medication-detail-edit-button">
    <Pencil aria-hidden="true" className="h-4 w-4" />
    <span>{t("common.edit")}</span>
  </Button>
  <Button variant="ghost" size="icon"
    className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
    onClick={onOpenHistory}
    aria-label={t("medications.detail.header.historyLabel")}
    data-slot="medication-detail-history-button">
    <History aria-hidden="true" className="h-4 w-4" />
  </Button>
  <Button variant="ghost" size="icon"
    className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
    onClick={onOpenAdvanced}
    aria-label={t("medications.detail.header.advancedLabel")}
    data-slot="medication-detail-advanced-button">
    <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
  </Button>
</div>
```

`min-h-11 min-w-11` keeps the 44px touch target on mobile (the
settings 44px sweep test already exempts hidden inputs; these are
visible interactive buttons and must pass). Reuse `common.edit`; add
two header labels (§7).

### 2.3 Page wiring — `[id]/page.tsx`

- Pass `onOpenHistory={() => router.push(`/medications/${id}/history`)}`
  to `<MedicationDetailHeader>` (line 269-276).
- **Remove the "View full history →" footer link** from the intake
  preview (it is now redundant with the header button, and the brief
  says the history icon should go *directly* to full history). See
  §4.3.
- The page keeps mounting `IntakeHistoryPreview`, `AdvancedSettingsSheet`,
  `PhaseConfigSheet`, `MedicationWizardDialog` as today.

### 2.4 Wireframe — header button row

Desktop (≥768px):
```
┌──────────────────────────────────────────────────────────────┐
│ ← Medications                                                  │
│                                                                │
│  Mounjaro                              [✏ Edit] [🕑] [⇆]        │
│  2.5 mg                                  ↑edit  ↑hist ↑sliders  │
│  ● Active                                                      │
└──────────────────────────────────────────────────────────────┘
```
Mobile (<768px) — same row, buttons 44×44, Edit keeps label:
```
┌────────────────────────────────┐
│ ← Medications                  │
│ Mounjaro                       │
│ 2.5 mg                         │
│ ● Active                       │
│            [✏ Edit] [🕑] [⇆]    │
└────────────────────────────────┘
```
(`🕑` = Lucide `History`, `⇆` = `SlidersHorizontal`.)

---

## 3. (no section — numbering aligns with asks)

---

## 4. History view redesign (Ask 2)

The history view becomes **intake history only**, date-descending,
reached directly from the header `History` button. No active-ingredient
curve by default, no "Rhythmus bearbeiten" / schedule editing. The only
editable units are individual intakes; import is present but
de-emphasised.

### 4.1 Route — `[id]/history/page.tsx` rewrite

**Remove** these mounts (lines 97-137):
- `DrugLevelChart` (the estimated active-ingredient curve) — gone by
  default. *Optional progressive disclosure:* a collapsed
  `<details>`/disclosure "Show estimated drug-level curve" at the
  bottom for GLP-1 only, default-closed. Recommended to keep it
  *available* (it is genuine history context) but out of the default
  read. If the maintainer wants it fully gone, drop the disclosure too.
- `SideEffectsSection` — this is logging UI, not pure history; it
  belongs on the detail page (already mounted there,
  `page.tsx:315`). Remove from history route.
- `SchedulingSection` ("Rhythmus") — schedule editing. **Remove** —
  the only schedule editor is the wizard (header Edit pencil).
- `TitrationSection` — read-only ladder; same call as DrugLevelChart:
  fold into the optional collapsed disclosure or drop. Default-closed.

**Keep + promote** `IntakeHistoryListV2` to the primary (only) surface.

New route body:
```tsx
return (
  <div className="space-y-6">
    {/* back → detail page, not list (history is a drill-down OF the med) */}
    <Button variant="ghost" size="sm" asChild className="...-ml-2 gap-1">
      <Link href={`/medications/${id}`}>
        <ArrowLeft className="h-4 w-4" /> {t("medications.detail.history.back")}
      </Link>
    </Button>

    {medication && (
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">{medication.name}</h1>
          <p className="text-muted-foreground text-sm">{medication.dose}</p>
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.history.subtitle")}
          </p>
        </div>
        {/* de-emphasised import — ghost icon, not a prominent CTA */}
        <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}
          className="text-muted-foreground min-h-11 sm:min-h-9"
          data-slot="history-import-trigger">
          <Upload className="h-4 w-4" /> {t("medications.detail.intake.importButton")}
        </Button>
      </div>
    )}

    {medication && (
      <IntakeHistoryListV2
        medicationId={id}
        pageSize={25}
        onEditIntake={setEditingEvent}
        onDeleteIntake={setPendingDeleteId}
      />
    )}

    {/* optional, default-closed */}
    {medication?.treatmentClass === "GLP1" && (
      <CollapsibleDrugLevel medicationId={id} medication={medication} />
    )}

    {/* dialogs: IntakeImportDialog + IntakeEditDialog + delete AlertDialog */}
  </div>
);
```

The edit/delete dialog plumbing (`IntakeEditDialog`, delete
`AlertDialog`, optional bulk-delete toolbar) is **lifted from
`intake-history-preview.tsx`** — that component already owns the exact
state machine (`editingEvent`, `pendingDeleteId`, `confirmRowDelete`,
bulk-delete). Best path: **extract a shared
`<IntakeHistoryEditable>`** wrapper (the body of `IntakeHistoryPreview`
minus the `<MedicationDetailSection>` chrome and the footer link) and
have both the detail-page preview and the full history route render it.
See §6 reuse table.

### 4.2 Sort: date-descending, skipped-rows-not-first

The bug: skipped rows (`takenAt: null`) sort to the top under the
current `sortBy=takenAt&sortDir=desc` because NULLs are not pinned
last. Two-part fix:

1. **Default the history view sort key to a non-null column.** Sort by
   the *effective intake date* — for taken rows that is `takenAt`, for
   skipped rows `scheduledFor`. The cleanest UI-side fix without a
   server change: default `sortBy="scheduledFor"` `sortDir="desc"` on
   the full-history surface (every completed row has a non-null
   `scheduledFor`), and render the displayed date as
   `takenAt ?? scheduledFor`. This guarantees a clean
   today→yesterday→… descending order with no `—` rows floating up.
2. **Server hardening (recommended, separate task):** ensure the
   `GET /api/medications/[id]/intake` ORDER BY pins `NULLS LAST` on
   `takenAt` so the `takenAt` sort option is also correct. This is the
   robust fix; verify the route's `orderBy` before relying solely on
   the client default. *Open question O-1.*

`IntakeHistoryListV2` already supports both sort keys
(`intake-history-list-v2.tsx:128,156`); add a `defaultSortBy` prop
(default `"takenAt"` to preserve the detail-preview behaviour; the
history route passes `"scheduledFor"`). Display column: change the
"Taken" cell to show `event.takenAt ? dateTime(takenAt) : dateTime(scheduledFor)`
with a muted "(planned)" suffix for skipped — keeps the date column
always populated and chronological.

### 4.3 Detail-page intake preview

- **Remove** the footer "View full history →" link
  (`intake-history-preview.tsx:220-228`) — the header History button
  replaces it. Keep the preview's own table (14 rows) + import CTA +
  per-row edit/delete on the detail page as today.

### 4.4 Wireframe — history view

Desktop:
```
┌────────────────────────────────────────────────────────────────┐
│ ← Mounjaro                                                       │
│                                                                  │
│  Mounjaro                                          [🕑 Import]    │  ← ghost, muted
│  2.5 mg                                                          │
│  Full intake history                                             │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Intake history                                              │ │
│  │ ┌────────────┬────────────┬─────────┬────────┬──┐           │ │
│  │ │ Taken ↓    │ Scheduled  │ Status  │ Source │⋮ │           │ │
│  │ ├────────────┼────────────┼─────────┼────────┼──┤           │ │
│  │ │ 31.05 08:1 │ 31.05 08:0 │ ✓ Taken │ WEB    │⋮ │ ← today    │ │
│  │ │ 30.05 08:0 │ 30.05 08:0 │ ✓ Taken │ REM.   │⋮ │ ← yesterday│ │
│  │ │ 29.05 (pl) │ 29.05 08:0 │ ⤼ Skip. │ WEB    │⋮ │            │ │
│  │ │ …                                              │           │ │
│  │ │           ‹ Prev   Page 1/4 (87)   Next ›       │           │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ▸ Show estimated drug-level curve            (GLP-1, collapsed) │
└────────────────────────────────────────────────────────────────┘
```
Mobile: single-column, table scrolls horizontally inside the card
(existing `IntakeHistoryListV2` behaviour); import ghost button drops
under the title; the drug-level disclosure stays collapsed.

---

## 5. Advanced-settings dialog redesign (Ask 4)

Wider, sectioned, consistent buttons, generous spacing, CSV import
present and usable.

### 5.1 Width — extend the existing `contentWidth` system

`ResponsiveSheet` already accepts `contentWidth: "md"|"lg"|"2xl"|"3xl"|"4xl"`
(`responsive-sheet.tsx:71-84`). **No new prop needed** — change the
`AdvancedSettingsSheet` from `contentWidth="lg"` (512px) to
**`contentWidth="2xl"`** (`sm:max-w-2xl` = 672px). `2xl` is the right
call over `3xl/4xl`: the content is single-column sectioned forms, not
a two-column editor; 672px gives generous breathing room without
stranding controls across a too-wide line. Mobile is unaffected (the
Sheet branch always spans the viewport). This is a one-token change at
`advanced-settings-sheet.tsx:66`.

### 5.2 Section grouping — four labelled groups

Replace the three stacked `<MedicationDetailSection>` cards (each with
its own border) with **four labelled groups** under one consistent
visual system. Use a lightweight group header (uppercase micro-label +
hairline rule) instead of three full bordered section cards — this
reads as "one settings document, four parts" rather than "three
boxes". Map every action:

| Group | Heading key | Contents | Source component |
|---|---|---|---|
| **Data** | `…advanced.group.data` | CSV import (real, full affordance) · API endpoint URL + token mint + request examples | NEW inline import block + `ApiTokensRow` |
| **Reminders** | `…advanced.group.reminders` | Notifications switch + channel chips · Reminder grace minutes (primary-schedule) | `NotificationsSection` body + grace row from `SettingsSection` |
| **Lifecycle** | `…advanced.group.lifecycle` | Pause/resume switch · End (Beenden) · Phasen / course-window editor button (GLP-1 + window) | pause/end from `DestructiveZoneSection` Card A + Phasen row from `SettingsSection` |
| **Danger zone** | `…advanced.group.danger` | Purge intake history · Delete medication | `DestructiveZoneSection` Card B |

Key moves vs current:
- **CSV import is promoted from a one-line stub to a real block** in
  the Data group. The brief explicitly wants it "clearly present and
  usable" here. The block renders a `[⬆ Import CSV/JSON]` outline
  button that opens the existing `IntakeImportDialog` (reused
  verbatim). The import dialog state lifts to the page (it already
  does — `page.tsx:144,326-329` owns `importOpen`); pass an
  `onOpenImport` callback into the sheet. Delete the
  `settings-section.tsx:116-127` stub copy.
- **Phasen** moves from "Settings" into **Lifecycle** (it is a
  course-window / scheduling-lifecycle concern). Keep the
  sibling-swap: `onRequestPhaseSheet` closes the advanced sheet then
  the page opens `<PhaseConfigSheet>` (`page.tsx:247-250`) so modal
  depth ≤ 2 stays intact.
- **Pause + End** move from the old "Verwaltung & Gefahrenzone" into
  **Lifecycle**, separated from the irreversible Danger zone.

### 5.3 Consistent button styling

One rule, applied across the dialog:
- **Reversible / neutral actions** (Copy URL, Mint token, Import CSV,
  Save grace, Open Phasen): `variant="outline" size="sm"`,
  `min-h-11 sm:min-h-9`. Primary save-style only for the single most
  expected action per group is unnecessary here — keep them all
  outline for visual consistency (the prior mixed primary/outline/ghost
  is what reads "generated").
- **Destructive actions** (End, Purge, Delete): `variant="destructive"
  size="sm" font-semibold` (WCAG large-text band on
  white-on-`#ff5555`, already the convention in
  `destructive-zone-section.tsx:251,279,304`).
- **Toggles** (Notifications, Pause): `<Switch>` wrapped in `<label>`
  for full-row hit target (already the pattern).
- Drop the `IntakeImportDialog`'s lone `MoreHorizontal` kebab-for-reset
  in favour of a plain `[Reset]` text button inside the dialog footer
  area (the kebab-for-one-item is the "generated" smell;
  `intake-import-dialog.tsx:201-221`). Optional polish, low priority.

### 5.4 Spacing + typography tokens

- Sheet body: `bodyClassName` stays `gap-6`; inner wrapper
  `space-y-8` between the four groups (was `space-y-6` between three
  bordered cards — more air now that the borders are gone).
- Group header: `text-xs font-medium uppercase tracking-wide
  text-muted-foreground` + a `border-border/60 border-t pt-1`
  hairline; group body `space-y-4`.
- Row title: `text-foreground text-sm font-medium`; helper:
  `text-muted-foreground text-xs`. (Matches the existing section
  rows.)
- Within-group dividers: `<Separator />` between sub-rows (already
  used in `settings-section.tsx`).
- Dialog title: keep `medications.detail.advanced.title`
  ("Advanced settings").

### 5.5 Refactor shape

Rather than four sub-components, keep the existing three section
components but **render their bodies under group headings** inside a
new layout in `advanced-settings-sheet.tsx`. Cleanest: introduce a
tiny presentational `<SettingsGroup label>{children}</SettingsGroup>`
helper (local to the medications folder) and re-slot the existing
section *bodies*. Because the three section components currently each
wrap themselves in `<MedicationDetailSection>` chrome, the lower-churn
path is:
1. Add a `chrome?: "section" | "bare"` prop to each of
   `NotificationsSection`, `SettingsSection`, `DestructiveZoneSection`
   (default `"section"` preserves any other consumer; the sheet passes
   `"bare"`), OR
2. Split each section's *body* into an exported inner component
   (`NotificationsBody`, etc.) and have the section wrapper +
   the sheet both consume it.

Option 2 is cleaner (no conditional chrome branch) and matches the
`<IntakeHistoryEditable>` extraction in §4. Recommended. The Lifecycle
group then composes: pause+end body (from DestructiveZone Card A) +
phasen row (from SettingsSection) — so DestructiveZone's body splits
into `LifecycleManageBody` (Card A) + `DangerZoneBody` (Card B).

### 5.6 Wireframe — advanced-settings dialog (desktop, 672px)

```
┌───────────────────────────────────────────────────────────┐
│  Advanced settings                                      [✕] │
├───────────────────────────────────────────────────────────┤
│                                                             │
│  DATA ─────────────────────────────────────────────────    │
│   CSV / JSON import                                         │
│   Import past intakes from a file or pasted JSON.           │
│        [ ⬆ Import CSV/JSON ]                                │
│   ──────────────────────────────────────────────           │
│   External integration — Endpoint for "Mounjaro"           │
│   ┌─────────────────────────────────────────────────────┐  │
│   │ POST https://…/api/ingest/medication                 │  │
│   └─────────────────────────────────────────────────────┘  │
│        [ ⧉ Copy URL ]   [ 🔑 Generate token ]               │
│   Request example   [ cURL ▾ ]                              │
│   ┌── code ──────────────────────────────────────────[⧉]┐  │
│   └──────────────────────────────────────────────────────┘  │
│                                                             │
│  REMINDERS ────────────────────────────────────────────    │
│   Send a reminder                                  ( ●—— )  │
│   Channels:  [apns] [telegram] [ntfy]                       │
│   ──────────────────────────────────────────────           │
│   Reminder window (primary schedule)                        │
│        [ 30 ] minutes   [ Save ]                            │
│                                                             │
│  LIFECYCLE ────────────────────────────────────────────    │
│   Pause reminders                                  ( ——● )  │
│   ──────────────────────────────────────────────           │
│   End course                                  [ ▣ End ]     │
│   ──────────────────────────────────────────────           │
│   Phases / course window           [ Manage phases ]        │
│                                                             │
│  DANGER ZONE ───────────────────────────────────────────   │
│   ┌──────────────────────────── border-destructive/40 ──┐  │
│   │ Clear intake history (87)        [ 🗑 Clear ]         │  │
│   │ ────────────────────────────────                     │  │
│   │ Delete medication                [ 🗑 Delete ]        │  │
│   └──────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────┘
```

Mobile (Sheet branch, full-width, `rounded-t-2xl`, `90dvh`, scroll):
same four groups stacked; sticky nothing (no footer — each control
self-saves, `advanced-settings-sheet.tsx:8-17`). Buttons 44px.

---

## 6. Reuse vs refactor table

| File | Action | Notes |
|---|---|---|
| `medication-detail-header.tsx` | **Refactor** | Add `onOpenHistory`; 3-button row; import `History` + `SlidersHorizontal`; drop `Settings2` import. |
| `[id]/page.tsx` | **Refactor** | Wire `onOpenHistory` → `router.push`; pass `onOpenImport` into sheet; no other structural change. |
| `[id]/history/page.tsx` | **Rewrite** | Intake-only; remove DrugLevelChart/SideEffects/Scheduling/Titration from default; mount `<IntakeHistoryEditable>` + optional collapsed drug-level; back-link to `/medications/[id]`. |
| `intake-history-preview.tsx` | **Refactor** | Extract body into `<IntakeHistoryEditable>` (table + edit/delete/bulk dialogs, no section chrome, no footer link). Preview = chrome + `<IntakeHistoryEditable pageSize={14}>`. Remove footer link. |
| **NEW** `intake-history-editable.tsx` | **Create** | Shared editable history (preview + full route consume it). `pageSize`, `defaultSortBy` props. |
| `intake-history-list-v2.tsx` | **Refactor** | Add `defaultSortBy?: SortKey`; date cell shows `takenAt ?? scheduledFor` with planned suffix. |
| `advanced-settings-sheet.tsx` | **Refactor** | `contentWidth="2xl"`; four `<SettingsGroup>`; pass `onOpenImport`. |
| **NEW** `settings-group.tsx` | **Create** | Presentational group header (uppercase micro-label + hairline). |
| `notifications-section.tsx` | **Refactor** | Export `NotificationsBody`; wrapper keeps section chrome for any standalone consumer. |
| `settings-section.tsx` | **Refactor** | Split grace row + phasen row + api row into bodies; **delete CSV stub** (lines 116-127). |
| `destructive-zone-section.tsx` | **Refactor** | Split `LifecycleManageBody` (Card A: pause+end) + `DangerZoneBody` (Card B: purge+delete). |
| `intake-import-dialog.tsx` | **Reuse verbatim** | Opened from advanced-sheet Data group + (de-emphasised) history route. Optional: swap kebab-reset for text button. |
| `ResponsiveSheet` | **Reuse** | `contentWidth` already supports `2xl`. No change. |
| `DrugLevelChart` / `TitrationSection` | **Reuse** | Only inside optional collapsed disclosure on history route. |
| `SideEffectsSection` / `SchedulingSection` | **Unchanged** | Stay on detail page only; removed from history route. |

---

## 7. i18n keys touched

Reuse existing wherever possible (`common.edit`, `common.cancel`,
`common.save`, `common.import`, `medications.detail.intake.importButton`,
`medications.detail.advanced.title`, `medications.intakeHistory`, all
`medications.detail.zone.*`, `…notifications.*`, `…api.*`,
`…settings.grace.*`, `medications.phaseConfig*`).

**New keys** (add to `messages/en.json`, propagate to de/es/fr/it/pl):

| Key | EN value |
|---|---|
| `medications.detail.header.historyLabel` | `View intake history` |
| `medications.detail.header.advancedLabel` | `Advanced settings` (or reuse `medications.detail.edit.advancedOption`) |
| `medications.detail.history.back` | `Back to medication` |
| `medications.detail.history.subtitle` | `Full intake history` |
| `medications.detail.history.plannedSuffix` | `planned` |
| `medications.detail.advanced.group.data` | `Data` |
| `medications.detail.advanced.group.reminders` | `Reminders` |
| `medications.detail.advanced.group.lifecycle` | `Lifecycle` |
| `medications.detail.advanced.group.danger` | `Danger zone` |
| `medications.detail.advanced.csvImport.title` | `CSV / JSON import` |
| `medications.detail.advanced.csvImport.helper` | `Import past intakes from a file or pasted JSON.` |
| `medications.detail.advanced.csvImport.button` | `Import CSV/JSON` |

**Removed copy:** `medications.detail.settings.csvImport.title` +
`…csvImport.stub` (the stub goes away). Leave the keys in the bundle or
delete them — deleting requires removing the call site first
(`settings-section.tsx:121,124`); since that whole stub block is being
removed, delete both keys from all six locales. Reuse
`…intake.viewAllLink` is no longer referenced after the footer-link
removal — delete it too (call site `intake-history-preview.tsx:226`
goes away).

Re-run `i18n-call-site-coverage.test.ts` + `i18n-locale-integrity.test.ts`
after the bundle edits; both walk every `t()` literal so any orphan
fails CI.

---

## 8. Verification checklist

- `pnpm typecheck` clean (new props on header/list/sections).
- `pnpm lint` — queryKeys untouched (no new keys needed; reads reuse
  `medicationIntakeList`). No raw `fetch` added outside existing
  same-origin client reads.
- i18n guards green (new keys in all six locales; stub keys removed).
- 44px touch-target sweep: the three header buttons + all dialog
  buttons carry `min-h-11` on mobile.
- a11y: icon-only History + Advanced buttons carry `aria-label`; group
  headings are presentational (`<p>`, not duplicate `<h2>` ids) so no
  duplicate-id axe failure (the `notifications` heading-id split at
  `notifications-section.tsx:67-68` is precedent — keep group labels
  out of the `aria-labelledby` graph).
- Visual: open advanced sheet on desktop → 672px, four groups, all
  buttons outline/destructive only, CSV import button present in Data.
- History route: skipped rows no longer float to top; order is
  today→yesterday→… descending; no curve by default.

---

## 9. Open questions

- **O-1 (server sort):** does `GET /api/medications/[id]/intake` ORDER
  BY pin `NULLS LAST` on `takenAt`? The client-side `defaultSortBy="scheduledFor"`
  fix makes the history view correct regardless, but the detail-page
  preview still defaults to `takenAt desc` — confirm the route's
  `orderBy` before shipping, or switch the preview to `scheduledFor`
  too. Needs a read of the intake route handler (out of scope for this
  doc).
- **O-2 (drug-level disclosure):** keep the estimated active-ingredient
  curve as a default-closed `<details>` on the history route, or remove
  it entirely? Spec recommends keep-but-collapsed (it is genuine
  context); maintainer may want it gone. One-line toggle either way.
- **O-3 (advanced icon):** `SlidersHorizontal` (recommended,
  distinct-from-pencil) vs keeping `Settings2` (current). Maintainer's
  brief lists both as acceptable.
