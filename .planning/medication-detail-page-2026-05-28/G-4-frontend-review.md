# G-4 — Frontend / UX / a11y review: v1.5.6 medication detail-page refactor

Scope: `git diff d54addd6..release/v1.5.6 -- 'src/components/medications/**' 'src/app/medications/[id]/**' 'messages/**'`. Read-only. Audited against G-1 + D-3 §10 invariants.

## Block release on:

(none)

No Critical findings. The refactor matches the G-1 spec faithfully: modal depth holds at ≤2, the dropdown→sheet→AlertDialog paths use Radix primitives that manage focus correctly, all 6 locales carry the new keys with umlauts intact, and the list page is untouched apart from the sanctioned glyph swap. Ship-able as-is; the items below are polish.

---

## Critical

None.

---

## High

None.

---

## Medium

### M-1 — Pause/resume Switch ejects the user from the settings sheet
`src/components/medications/sections/destructive-zone-section.tsx:118` (pause) + `advanced-settings-sheet.tsx:95` (`onAfterAction={() => onOpenChange(false)}`)

Flipping the **Tier-1 pause Switch** inside the AdvancedSettingsSheet now fires `onAfterAction()`, which closes the entire sheet. Pause is a Switch, not a dialog — a single toggle ejects the user from settings with no confirmation step in between. This is literally what G-1 §5 asked for ("add `onOpenChange(false)` … on Tier 1/2/3a success"), so it is spec-compliant, but Tier-1 is the one reversible, frequently-toggled control and closing the whole surface on a switch flip reads as a glitch ("why did my settings disappear?"). End (Tier 2) and Purge (Tier 3a) close their own AlertDialog first, so for those the sheet-close lands on a calm surface and is fine.

Fix: scope the auto-close to the dialog-backed tiers only — pass `onAfterAction` to the End/Purge handlers but NOT to `handlePauseToggle`. Concretely, drop the `onAfterAction?.()` call at `destructive-zone-section.tsx:118` (leave it at :144 end + :167 purge). The pause toast already confirms the state change; the user stays in the sheet.

### M-2 — `IntakeEditDialog` note still seeds empty after the §9-Q1 fix
`src/components/medications/sections/intake-history-preview.tsx:248-252` seeds `{ id, takenAt, skipped }` only; `intake-edit-dialog.tsx:82,102` reads/writes `event.note`.

The seed fix correctly threads the real `takenAt` + `skipped`, but the dialog also supports `note` and the seed omits it, so editing a row with an existing note opens with an empty note field — and on save, an empty note body means the existing note is dropped from the request body (`intake-edit-dialog.tsx:102` only sets `body.note` when `note.trim().length > 0`). Root cause is upstream: `IntakeEvent` (`intake-history-list-v2.tsx:76-84`) has no `note` field — the list API response never returns it, so the row genuinely cannot seed it.

This is a known data-availability gap, not a regression introduced by this diff (the note was never seedable from the list, even in the v1.5.5 stub). But it now sits on the surface the maintainer is blessing as primary, and the "save silently strips an existing note" behaviour is a real paper-cut.

Fix (defer-able to v1.5.6.1): add `note: string | null` to the list response + `IntakeEvent`, thread it through the seed; OR have `IntakeEditDialog` fetch the single event on open so it edits the full record. Until then, document in I-1 that note edits are not round-tripped.

---

## Low

### L-1 — `Separator` import now dead in `page.tsx`? (verify)
`src/app/medications/[id]/page.tsx` — the diff removes the `<Separator className="opacity-0" />` render but the `import { Separator }` line was removed in the same hunk (confirmed in diff: `-import { Separator } from "@/components/ui/separator";`). No dead import. No action; noted for completeness — clean.

### L-2 — Header trigger gains a `ChevronDown` but keeps `common.edit` label only
`src/components/medications/medication-detail-header.tsx:118-122`

The trigger is now `[Pencil] Bearbeiten [ChevronDown]`. It carries no `aria-label` (correct per G-1 §4 — visible text is the accessible name) and `aria-haspopup`/`aria-expanded` are supplied by Radix `DropdownMenuTrigger`. Both Lucide icons are `aria-hidden="true"`. Compliant. One nit: the trigger now renders two 16px icons + a word; at the `min-h-9` desktop size with a long locale ("Ustawienia"… no, trigger stays `common.edit` = "Edytuj"/"Modifier") the German "Bearbeiten" + two icons fits comfortably > 44px wide. No collapse risk. No action.

### L-3 — `data-slot="advanced-settings-sheet-body"` duplicates `responsive-sheet-body`
`advanced-settings-sheet.tsx:73` adds `data-slot="advanced-settings-sheet-body"` on an inner `<div>` that sits directly inside ResponsiveSheet's own `data-slot="responsive-sheet-body"` wrapper (`responsive-sheet.tsx`). Two nested body slots is harmless (distinct slot names, no `id` collision) but slightly redundant — the inner `space-y-6` div could drop the data-slot or fold into `bodyClassName`. Cosmetic; no functional impact. No dead/duplicate DOM `id`.

### L-4 — Radius vocabulary: ResponsiveSheet mobile branch uses `rounded-t-2xl`, not `rounded-lg`
`src/components/ui/responsive-sheet.tsx` (pre-existing, not in this diff)

D-3 §8 vocabulary is Sheet `rounded-lg`; the mobile bottom-sheet branch uses `rounded-t-2xl` (iOS bottom-sheet idiom). This pre-dates v1.5.6 and the new AdvancedSettingsSheet introduces no radius override of its own (it only sets `sm:max-w-lg` + `bodyClassName="gap-6"`). Invariant satisfied for the new code; flag the primitive drift only if §8 is meant to be literal. No action this release.

### L-5 — `IntakeImportDialog` now conditionally mounted — confirm no focus-loss on close
`src/components/medications/sections/intake-history-preview.tsx:232-237`

Changed from always-mounted (`medicationId={importOpen ? id : null}`) to `{importOpen && <IntakeImportDialog … />}`. Unmounting a Radix Dialog on close is fine (Radix returns focus to the trigger before unmount in the same tick), and the import CTA lives in the preview header so focus returns there. Verified the dialog is a `<Dialog>` with its own `onOpenChange`. No focus-trap leak. Behaviour improvement (no hidden dialog in the tree). No action.

---

## Invariant pass/fail summary (D-3 §10 + G-1)

| Invariant | Status | Evidence |
|---|---|---|
| Modal stack ≤ 2 | PASS | dropdown=popover (depth 0); sheet→AlertDialog=2; phase sheet sibling-swapped via `openPhaseSheet()` closing advanced first (`page.tsx`). |
| Status-pill text never hidden + Dracula tokens | PASS | header unchanged at `:73-99`; dot `aria-hidden`. |
| Every `<Switch>` in `<label>` | PASS | notifications + pause rows unchanged; no new switches. |
| Destructive CTAs `font-semibold` | PASS | destructive-zone CTAs unchanged. |
| Icon-only triggers `aria-label` | PASS | list-page nav glyph keeps `aria-label={t("medications.openDetailPage")}` (`medication-card.tsx:275`, `glp1-medication-card.tsx:337`); intake kebab unchanged. Edit dropdown trigger has visible text (no aria-label needed). |
| Group headers `<h3>` | PASS | intake group headers unchanged; section chrome `<h2>` preserved inside sheet. |
| `motion-reduce` on animation | PASS | no new animation utilities introduced; ResponsiveSheet/Radix transitions pre-existing. |
| New files kebab-case | PASS | `advanced-settings-sheet.tsx`. |
| Radius vocabulary | PASS (new code) | new sheet adds no radius override; see L-4 re primitive. |
| i18n keys in all 6 locales + umlauts | PASS | `medications.detail.edit.{planOption,advancedOption}` + `medications.detail.advanced.title` present in de/en/es/fr/it/pl; "Erweiterte Einstellungen" umlaut intact; es/fr/it/pl translated (not stubbed). |
| List page untouched except glyph swap | PASS | only `History`→`ChevronRight` in `medication-card.tsx` + `glp1-medication-card.tsx`; no other list-page change in diff. |
| Focus return dropdown→sheet→dialog | PASS | Radix DropdownMenu returns focus to trigger on `onSelect`; ResponsiveSheet renders real `SheetTitle`/`DialogTitle` so accessible name + focus trap are managed; AlertDialog over sheet returns focus correctly. |
| Dead/duplicate DOM id | PASS | no `id` collision; `PAUSE_SWITCH_ID` unchanged + single-mounted. data-slot redundancy only (L-3). |
| German label layout collapse <44px | PASS | trigger label is `common.edit`; sheet/dropdown items are full-width rows. No sub-44px German label. |
