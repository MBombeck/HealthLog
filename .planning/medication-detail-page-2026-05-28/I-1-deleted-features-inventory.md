# I-1 — Inventory of features lost in v1.5.4 `medication-form.tsx` + `phase-config-dialog.tsx` deletion

Reference commit: `105fcee2` — "refactor(meds): route /medications/new and the edit trigger through the new dialog" (Thu 2026-05-28).
Files deleted: `src/components/medications/medication-form.tsx` (1327 LOC) + `src/components/medications/phase-config-dialog.tsx` (268 LOC).
Snapshot inspected: parent commit `105fcee2^` — the moment before deletion.

The v1.5.4 cut routed both the "+ Neu" button and the per-card "Bearbeiten" trigger through `MedicationWizardDialog`. The wizard owns the field-by-field create / edit form but does NOT surface the kebab menu the flat form carried. Every action that lived behind that kebab is now unreachable from the UI even though the underlying API routes are still live and the list page still imports `IntakeImportDialog` + `ApiEndpointDialog` (with the trigger paths cut).

Marc's verbatim demands (anchor for the v1.5.5 redesign):

- „Einnahmen löschen"
- „Einnahmen bearbeiten"
- „Die ganzen API Roots"

## 1. TL;DR — every lost action

| # | German label (Marc's voice) | Old trigger | API | Detail-page home (v1.5.5) |
|---|---|---|---|---|
| 1 | Bearbeiten | Sheet kebab → field grid + Save | `PUT /api/medications/[id]` | "Stammdaten" section, primary action in header |
| 2 | Löschen | Sheet kebab → AlertDialog | `DELETE /api/medications/[id]` | "Gefahrenzone" footer section |
| 3 | Pausieren / Aktivieren | Sheet kebab toggle (writes via `active` flag on PUT) | `PUT /api/medications/[id]` (`active` field) | "Status" card in header, switch + chip |
| 4 | Benachrichtigungen aus / ein | Sheet kebab toggle (writes via PUT) | `PUT /api/medications/[id]` (`notificationsEnabled`) | "Erinnerungen" section, switch + Quiet-hours preview |
| 5 | Einnahmen importieren | Sheet kebab → mounts `IntakeImportDialog` | `POST /api/medications/[id]/intake/import` | "Einnahmen" section header, secondary action |
| 6 | API-Endpunkt | Sheet kebab → mounts `ApiEndpointDialog` | `GET/POST /api/medications/[id]/api-endpoint` + `tokens` | "API-Zugriff" section, full block |
| 7 | Titrations-Phasen konfigurieren | Sheet kebab → `PhaseConfigDialog` modal | `GET/PUT/DELETE /api/medications/[id]/phase-config` | "GLP-1 Phasen" sub-section (visible only for GLP1 + Course-Window-Mode) |
| 8 | Aufzeichnungen löschen ("Purge") | Sheet kebab destructive item → AlertDialog | `DELETE /api/medications/[id]/intake/purge` | "Gefahrenzone" footer, above "Löschen" |
| 9 | Zurücksetzen (Formular leeren, create only) | Sheet kebab item | client-side only | n/a (not on detail page; lives on wizard) |
| 10 | GLP-1 Wochentags-Preset | Form body, day-button row | client-side write into schedule | "Cadence" section on detail page; preset row visible for `treatmentClass === GLP1` |
| 11 | Schedule hinzufügen / entfernen | Form body, per-schedule kebab | client-side schedule array | "Cadence" section, add/remove rows |
| 12 | Legacy reminder window (windowStart/windowEnd) Fallback | Form body, visible only on `legacyOnLoad` | client-side | "Cadence" section, fallback block (defensive) |
| 13 | One-Shot Switch | Form body switch | client-side; PUT `oneShot:true` | "Cadence" header, switch + warning |
| 14 | Course-Window-Picker (startsOn / endsOn) | Form body | PUT body `startsOn`/`endsOn` | "Cadence" → "Kurs-Fenster" sub-section |
| 15 | Einnahmen bearbeiten (per-dose) | `IntakeHistoryListV2` row kebab | `PUT /api/medications/[id]/intake/[eventId]` | "Einnahmen" row kebab — embed list on detail page |
| 16 | Einnahmen löschen (per-dose) | same | `DELETE /api/medications/[id]/intake/[eventId]` | same |

(15 + 16 were not deleted in v1.5.4 — they live on `IntakeHistoryListV2`, which is currently only mounted on `/medications/[id]/history`. Marc's „Einnahmen bearbeiten / löschen" demand still applies because the detail page is the new home and the history list should be embedded there.)

## 2. Per-action deep-dive

### Bearbeiten (PUT medication)

- **Original location.** Sheet body (every form field) + Save button in the portalled footer slot.
- **Trigger.** `<Button type="submit" form={formId}>` in the footer; the kebab was decorative for the destructive / settings rail.
- **API.** `PUT /api/medications/${initial.id}` — body excerpt:

```ts
body: JSON.stringify({
  name, dose, category, treatmentClass,
  ...(dosesPerUnit ? { dosesPerUnit: Number(dosesPerUnit) } : isEdit ? { dosesPerUnit: null } : {}),
  ...(isEdit ? {
    active,
    ...(notificationsEnabled !== (initial?.notificationsEnabled ?? true) && {
      notificationsEnabled,
    }),
  } : {}),
  ...(startsOn !== null && { startsOn: courseStartsOnIso }),
  ...(endsOn !== null && { endsOn: courseEndsOnIso }),
  ...(oneShot && { oneShot: true }),
  schedules: serialisedSchedules,
}),
```

- **Invalidates.** `await invalidateKeys(queryClient, medicationDependentKeys)` — `medications()` + `analytics()` + `insightsRoot()` + `insightsTargets()` + `gamificationAchievements()`.
- **Toast.** `toast.success(t("common.saved"))`.
- **Auth.** Cookie session, scope `requireAuth()`. Per-medication ownership enforced server-side.
- **Status.** Calls `onSuccess?.()` → list-page `closeDialog()`.
- **v1.5.5 home.** Detail page hero — "Stammdaten" section (name + dose + category + treatment class + course window). Use inline edit + Save bar that sticks to the bottom on small screens, matches the existing Quiet-hours pattern in Settings.

### Löschen (medication)

- **Original location.** Footer kebab → AlertDialog confirmation.
- **API.** `DELETE /api/medications/${initial.id}`.
- **Invalidates.** Same `medicationDependentKeys` set.
- **Toast.** No success toast (only sets error on failure); list refresh is the visual confirmation.
- **Confirmation.** Two-step: kebab item opens `<AlertDialog>` with `medications.deleteConfirm` title + description, destructive variant action button.
- **Auth.** Cookie session only.
- **Status.** Calls `onSuccess?.()` → closes sheet, list refreshes.
- **v1.5.5 home.** Detail page "Gefahrenzone" footer card, red outline, requires confirmation. Below "Aufzeichnungen löschen" (purge).

Snippet — handler:

```ts
async function handleDelete() {
  if (!initial) return;
  setError(null); setDeleting(true);
  try {
    const res = await fetch(`/api/medications/${initial.id}`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError(json?.error ?? t("medications.deleteError")); return; }
    await invalidateKeys(queryClient, medicationDependentKeys);
    onSuccess?.();
  } catch { setError(t("medications.deleteError")); }
  finally { setDeleting(false); }
}
```

### Pausieren / Aktivieren

- Sheet kebab; icon flips between `<Pause />` and `<Play />`.
- `setActive((prev) => !prev)` — local state, rides the next Save; folds into `PUT /api/medications/[id]` body via `active: <bool>`.
- No dedicated toast.
- **v1.5.5 home.** "Status" card in the detail-page header — `<Switch>` next to a Pausiert / Aktiv chip. Wire a direct `PUT /api/medications/[id]` with `{ active }` so the toggle is instant; mutate the medication query cache optimistically.

### Benachrichtigungen aus / ein

- Sheet kebab toggle; emits `notificationsEnabled` on the PUT body when local state diverges from the initial value. Server cascades to `MedicationReminder` row state (v1.4.49 disable-cascade invariant test pins the contract).
- **v1.5.5 home.** "Erinnerungen" section — Switch + Quiet-hours preview + per-channel chip (APNs / Telegram / ntfy / Web-Push). Inline note for the v1.4.49 `clientManaged` opt-in for iOS users.

### Einnahmen importieren

- Sheet kebab → `editActions.onImportIntakes()` → list-page state `setImportMedId(id)` → mounts `IntakeImportDialog`.
- `POST /api/medications/${id}/intake/import` (CSV / JSON paste). Toast + error banner internal to the dialog. Cookie session.
- **v1.5.5 home.** "Einnahmen" section header — small "Importieren" outline button next to "+ Neue Einnahme".

### API-Endpunkt

- Sheet kebab → `editActions.onApiAccess()` → list-page state `setApiMed(...)` → mounts `ApiEndpointDialog`.
- `GET /api/medications/${id}/api-endpoint` for status + `POST` for token mint; underlying table is `tokens` (HMAC-SHA256, narrow per-medication scope per `tokens.create`). Cookie session for the management surface; the issued Bearer is per-medication-scoped.
- **v1.5.5 home.** "API-Zugriff" section — full block: endpoint URL, token list, "Token erzeugen" button, copy-to-clipboard helpers, scoping note („kann nur Einnahmen für dieses Medikament melden"), revoke action. This is „Die ganzen API Roots" Marc called out.

### Titrations-Phasen konfigurieren (GLP-1)

- Sheet kebab → `setPhaseConfigOpen(true)` → `<PhaseConfigDialog medicationId={initial.id} … />` modal.
- `GET /api/medications/${id}/phase-config` (load), `PUT` (save), `DELETE` (reset to defaults). Invalidates `queryKeys.medicationPhaseConfig(id)`. Inline status banner via `setStatusMessage(...)` auto-clears after 2 s (NOT sonner). Cookie session.
- **v1.5.5 home.** "GLP-1 Phasen" sub-section — only visible when `treatmentClass === "GLP1"` AND a course window is set. Inline grid (green / yellow / orange / red rows), no nested dialog. Restore the "Auf Standard zurücksetzen" action as an outline button at the section foot. See §4.

### Aufzeichnungen löschen (Purge intake history)

- **Original location.** Sheet kebab → destructive item → `<AlertDialog>` confirmation.
- **API.** `DELETE /api/medications/${initial.id}/intake/purge`.
- **Invalidates.** `medicationDependentKeys`.
- **Toast.** No success toast; the dialog closes and the list updates.
- **Auth.** Cookie session.
- **Status.** Closes the alert dialog. Keeps the medication row; only drops the linked intake history.
- **v1.5.5 home.** "Gefahrenzone" footer card on the detail page, above the medication delete. Same two-step confirmation pattern, different copy ("Nur die Einnahmen löschen, das Medikament selbst behalten").

Snippet:

```ts
async function handlePurge() {
  if (!initial) return;
  setPurging(true);
  try {
    const res = await fetch(`/api/medications/${initial.id}/intake/purge`, { method: "DELETE" });
    const json = await res.json().catch(() => null);
    if (!res.ok) { setError(json?.error ?? t("medications.purgeError")); return; }
    await invalidateKeys(queryClient, medicationDependentKeys);
    setPurgeDialogOpen(false);
  } finally { setPurging(false); }
}
```

### Zurücksetzen (form reset, create-only)

- **Original location.** Sheet kebab when `isEdit === false`. Resets every controlled input back to defaults.
- **API.** Client-side only.
- **v1.5.5 home.** Not relevant on the detail page; lives on the wizard (currently retired — separate decision whether the wizard needs it back).

### GLP-1 Wochentags-Preset

- Form body when `treatmentClass === "GLP1"`. Day-button row (Sun…Sat); selecting a day writes `cadence.kind = "weekdays"` with the single BYDAY token + persists the choice to localStorage (`medication-form:last-weekly-weekday`). Below the row, a "Hattest du letztes Mal…" suggestion link applies the last-used weekday.
- **v1.5.5 home.** "Cadence" section, visible only for GLP1 + recurring. Restore the localStorage anchor.

### Schedule hinzufügen / entfernen

- Per-schedule kebab on each schedule card + "+ Neuer Zeitplan" link. Folds into PUT body `schedules: [...]`.
- **v1.5.5 home.** "Cadence" section on the detail page. The wizard collapses to a single schedule; the detail page should support the multi-schedule edit path the flat form did (this is the compose-mode the commit message defers — currently lost).

### Legacy reminder window fallback

- Visible only when `schedule.legacyOnLoad === true` (no v1.5 fields populated). Surfaces `windowStart` / `windowEnd` time inputs as a defensive fallback during the v1.5.x migration window. Feeds the dual-write derivation `deriveLegacyWindow(...)`.
- **v1.5.5 home.** "Cadence" section, conditional render. Same defensive intent.

### One-Shot Switch

- Inside the "Kurs-Fenster" fieldset. Flipping it on collapses to a single schedule with one `timesOfDay` entry and warns via `toast.warning(t("medications.scheduling.oneShot.collapseWarning"))` when this would drop additional schedules. PUT body emits `oneShot: true` only when true.
- **v1.5.5 home.** "Cadence" header — same Switch with the same warning toast on collapse.

### Course-Window-Picker (startsOn / endsOn)

- Uses `<CourseWindowRow startsOn={…} endsOn={…} lockEndsToStart={oneShot} onChange={...} />`. PUT body `startsOn` + `endsOn` are ISO date-only, encoded by `toIsoDateOnly()` from UTC components (avoids the cross-timezone drift `toISOString().slice(0, 10)` introduces east of UTC).
- **v1.5.5 home.** "Cadence" → "Kurs-Fenster" sub-section. The component still exists; reuse.

## 3. Hooks + utility code the form depended on

Every item below still exists in the tree — none of them fell with the form. The detail-page redesign can lean on them without porting work.

| Helper | Path | Status |
|---|---|---|
| `invalidateKeys(...)` + `medicationDependentKeys` | `src/lib/query-keys.ts:349` | Lives. Use unchanged. |
| `queryKeys.medicationPhaseConfig(id)` | `src/lib/query-keys.ts:131` | Lives. Reuse for the inline GLP-1 section. |
| `CadencePicker` + `TimesOfDayChips` + `CourseWindowRow` | `src/components/medications/scheduling/*` | Lives. Used by the wizard; can be embedded on the detail page too. |
| `inferCadenceFromLegacy` + `legacyPairFromCadence` | `src/components/medications/scheduling/legacy-bridge.ts` | Lives. Required for the `legacyOnLoad` fallback. |
| `parseScheduleRecurrence` | `src/lib/medication-schedule.ts` | Lives. List page still uses it to hydrate the wizard. |
| `IntakeImportDialog` (inline class on list page) | `src/app/medications/page.tsx:344` | Lives but ORPHANED — no trigger reaches it. The detail page is the new home. |
| `ApiEndpointDialog` (inline class on list page) | `src/app/medications/page.tsx:559` | Lives but ORPHANED — same. |
| `IntakeHistoryListV2` | `src/components/medications/intake-history-list-v2.tsx` | Lives. Currently only mounted on `/medications/[id]/history`. Embed on detail page. |
| `ResponsiveSheet` | `src/components/ui/responsive-sheet.tsx` | Lives. The dialog/sheet split the form used. The detail page is a full route, so this is only relevant for nested confirmation flows. |
| Sonner `toast.success` / `toast.warning` | dependency | Lives. Use for Save / one-shot-collapse warning. |
| `<AlertDialog>` from shadcn | dependency | Lives. Use for purge + delete confirmation. |
| `useTranslations()` + `t()` keys under `medications.*` | `src/lib/i18n/context.tsx` + `messages/*` | Lives. Every key listed in the snippets above resolves today (the i18n-call-site-coverage test would have failed otherwise on v1.5.4). |

## 4. PhaseConfigDialog — full surface

The 268-LOC component was a `ResponsiveSheet` over a 4-row form. It was reachable from exactly one place: the medication-form kebab "Phasen konfigurieren" item. With both deleted, the per-phase configuration is now unreachable from the UI even though the API + query key + i18n strings are all still live.

**Props.**

```ts
interface PhaseConfigDialogProps {
  medicationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

**Internal state model.**

```ts
interface PhaseConfigData {
  greenValue: number;  greenMode: "MINUTES" | "PERCENT";
  yellowValue: number; yellowMode: "MINUTES" | "PERCENT";
  orangeValue: number; orangeMode: "MINUTES" | "PERCENT";
  redValue: number;    redMode: "MINUTES" | "PERCENT";
}
```

Defaults: green 60 min before end / yellow 30 min before end / orange 0 min after end / red 240 min after end (every mode = MINUTES).

**Read.** `useQuery({ queryKey: queryKeys.medicationPhaseConfig(medicationId), queryFn: () => fetch('/api/medications/${id}/phase-config').then(r => r.json()).data })` — fires only when `open === true`.

**Mutations.**

- `saveMutation` — `PUT /api/medications/${medicationId}/phase-config` with `JSON.stringify(config)`. On success: clears local form, invalidates `medicationPhaseConfig(id)`, shows inline status banner `t("medications.phaseSaved")` for 2 s.
- `resetMutation` — `DELETE /api/medications/${medicationId}/phase-config`. On success: same cache invalidate + status banner `t("medications.phaseReset")`.

**Actions surfaced.**

- "Auf Standard zurücksetzen" — outline button bottom-left (calls `resetMutation`).
- "Abbrechen" — outline button bottom-right (calls `onOpenChange(false)`).
- "Speichern" — primary button (calls `saveMutation`).
- Per-row: numeric input (0…1440) + MINUTES/PERCENT toggle + suffix caption ("vor Kursende" / "nach Kursende"). Wraps under `sm:` for Galaxy Fold widths.

**Where it should land on v1.5.5.** Inline section on the detail page titled "GLP-1 Phasen". No nested modal. Rows render flat under "Kurs-Fenster". The save / reset actions become the section footer; status banner becomes a sonner toast.

**Auth.** Cookie session, owner-only. Server route at `src/app/api/medications/[id]/phase-config/route.ts` has GET / PUT / DELETE handlers under `apiHandler(...)`.

**TitrationSection cross-check.** `src/components/medications/TitrationSection.tsx` does NOT reference `PhaseConfigDialog`. It hits `/api/medications/${medicationId}/titration` only — a separate route that reads the GLP-1 ladder catalog. The section is therefore intact and functional today; it just shows a different concern (which titration step the user is on) than `PhaseConfigDialog` did (when the green/yellow/orange/red bands fall around the dose window). Both have a home in v1.5.5: TitrationSection embeds as-is, the GLP-1 Phases section replaces the dialog.

## 5. Critical gaps Marc cannot work around today

Three actions have NO accessible surface in v1.5.4 — they are fully orphaned:

1. **Einnahmen löschen / bearbeiten (per-dose).** `IntakeHistoryListV2` lives only on `/medications/[id]/history`. The list page does not embed it, the wizard does not surface it. The only path is a manual URL navigation.
2. **Die ganzen API Roots (per-medication API token + endpoint).** The `ApiEndpointDialog` is mounted on the list page but no trigger calls `setApiMed(...)`. The kebab that called it died with the form.
3. **Aufzeichnungen löschen + Medikament löschen.** Both AlertDialog flows died with the form. The list page has no row-level "Löschen" action and the wizard's footer is Save/Cancel only — the only way to delete a medication today is the API.

Secondary gaps (workarounds exist but are awkward):

- **Pause / Activate.** Can be flipped via Bearbeiten → wizard, but the wizard step that exposes `active` is inside the multi-step flow rather than a one-tap toggle.
- **Notifications enable/disable per medication.** Same as Pause — buried in the wizard.
- **GLP-1 Phasen konfigurieren.** No UI path; only `PUT /api/medications/[id]/phase-config` directly.
- **Einnahmen importieren.** `IntakeImportDialog` orphaned identically to `ApiEndpointDialog`.

Total inventory: **16 distinct actions** lost or rendered unreachable. The detail page redesign needs to land every one of items 1-14 in §1 to restore parity; items 15 + 16 are existing-component-relocations rather than rebuilds.
