# RC2 — `<ResponsiveSheet>` reconcile report

Owner: RC2. Target: `develop`. Round: v1.4.27 R4 reconcile.

## Scope

Two convergent must-fix findings from three R4 reviewers:

- **HIGH-1 (senior-dev + design)**: every page-level `<ResponsiveSheet>`
  consumer except `export-section` inlined the form footer inside the body
  slot, so the primitive's sticky-pinned bottom rail painted empty on the
  Sheet (`<md`) branch. The Save / Cancel row therefore scrolled with the
  body and slid under the soft keyboard on phones — the exact bug the
  primitive was carved out of `<Dialog>` to fix.
- **P0 (ui-conformity)**: six surfaces still mounted a raw `<Dialog>` for
  an editable form where the bottom-sheet branch would improve mobile UX.

## What landed

### Pattern

Two reusable patterns, picked to avoid touching the primitive (Decision A
of `v1427-mobile-fix-plan.md` locked the shape) and to keep form state
encapsulated:

1. **Portal + HTML `form="id"` association.** The form renders
   `<form id={formId}>` around its body fields and exposes a `footerSlot`
   prop. When the caller passes a DOM ref into that prop, the form
   `createPortal`s its action-row (kebab + Cancel + Save) into the
   `<ResponsiveSheet>` footer slot. The Save button references the form
   element via the HTML `form` attribute so submit-on-Enter, native
   validation, and React's synthetic events all continue to work end-to-end.
2. **Inline footer prop** for surfaces whose CTAs aren't `type="submit"`
   (e.g. target-edit's Save is an onClick handler over a mutation). These
   pass the action-row straight into `<ResponsiveSheet footer={...}>` with
   no portal needed.

The form element stays as the outer wrapper of its own body fields per
the brief; the submit button still lives "inside the form" semantically
via the HTML `form` attribute even when DOM-mounted in the sheet's
footer slot.

### Footer-slot wiring (Phase 1)

Every page-level `<ResponsiveSheet>` consumer now wires the footer slot:

| File | Mount(s) | Footer source |
|---|---|---|
| `src/app/page.tsx` | dashboard quick-entry Measurement + Mood | `MeasurementForm` / `MoodForm` portal |
| `src/app/measurements/page.tsx` | `/measurements` add | `MeasurementForm` portal |
| `src/app/mood/page.tsx` | `/mood` add | `MoodForm` portal |
| `src/app/medications/page.tsx` | `/medications` create/edit | `MedicationForm` portal |
| `src/components/medications/SideEffectsSection.tsx` | side-effects log | local portal, `form="id"` |
| `src/components/medications/inventory-section.tsx` | inventory add-pen | local portal, `form="id"` |
| `src/components/medications/intake-history-list.tsx` | edit + create intake (two sheets) | local portal, `form="id"` |

Each form gained an optional `footerSlot?: HTMLElement | null` prop (or
local `useState<HTMLDivElement | null>` for inline forms) and a stable
`useId()` `formId` consumed by the form element + the portalled Save
button.

### Dialog → ResponsiveSheet migrations (Phase 2)

Six surfaces moved off raw `<Dialog>`:

| File | Notes |
|---|---|
| `src/components/mood/mood-list.tsx` | row-edit sheet + portalled footer with kebab/Cancel/Save |
| `src/components/measurements/measurement-list.tsx` | row-edit sheet + portalled footer with kebab/Cancel/Save |
| `src/components/targets/target-edit-sheet.tsx` | filename already promised a sheet; implementation now matches. Mount-effect replaces Radix's `onOpenAutoFocus` (the primitive doesn't expose it). |
| `src/components/medications/phase-config-dialog.tsx` | GLP-1 phase-window editor; reset + Cancel + Save in footer prop. |
| `src/components/medications/ResearchModeAcknowledgmentDialog.tsx` | MDR opt-in gate; Cancel + Acknowledge in footer prop. Test fixture (`__tests__/ResearchModeAcknowledgmentDialog.test.tsx`) updated to mock `@/components/ui/responsive-sheet` instead of the legacy `@/components/ui/dialog` mock. |
| `src/components/admin/feedback-inbox-section.tsx` | feedback detail viewer; bottom status/action row moved to footer prop, per-note Save stays inline next to the textarea (different concern). |

### What was NOT touched

Per coordination:

- `src/components/ui/responsive-sheet.tsx` — primitive shape unchanged; the
  contract was already correct, only the consumers were misusing it.
- `.github/workflows/*` — RC1 territory.
- `messages/*.json` — RC1 territory; no new keys introduced.
- `src/components/insights/insight-advisor-card.tsx` — RC1 territory.
- `src/app/api/workouts/route.ts`, `src/hooks/use-is-mobile.ts`,
  `src/components/ui/sheet.tsx` — RC3 territory.

## Commits

1. `6704579c fix(forms): wire the ResponsiveSheet footer slot across every page-level form mount` — Phase 1 (7 files, 9 mount points).
2. `0baea139 refactor(forms): migrate mood and measurement row-edit dialogs to ResponsiveSheet` — Phase 2 part A (2 row-edit dialogs).
3. `bfb13351 chore(ui): align TrendCard heading weight, account form rhythm, and MoodChart tick margin with siblings` — **note**: this RC3 commit also picked up RC2's staged Phase 2 part B (target-edit-sheet, phase-config-dialog, ResearchModeAcknowledgmentDialog + test fixture, feedback-inbox-section) because both contributors had files staged simultaneously when the commit ran. The code in `bfb13351` for these four files is RC2's work; the commit message is RC3's. Deferred to release notes / triage to disentangle if needed.

## Gates

- `pnpm typecheck` — clean after every commit.
- `pnpm lint` — clean after every commit.
- Targeted test runs across every affected surface — green.
  - `src/components/ui/__tests__/responsive-sheet.test.tsx` (7 tests)
  - `src/components/targets/__tests__/target-edit-sheet.test.tsx` (6 tests)
  - `src/components/medications/__tests__/ResearchModeAcknowledgmentDialog.test.tsx` (8 tests, fixture updated)
  - `src/components/medications/__tests__/SideEffectsSection.test.tsx` (7 tests)
- Full suite has two pre-existing failures in
  `src/components/i18n/__tests__/maintainership-banner.test.tsx` (FR/PL
  locale notice copy) that pre-date RC2's changes and live in RC1's
  territory.

## Coordination notes for the next pass

- The accidental merge of RC2 work into `bfb13351` happened because the
  two contributors had overlapping staged trees when one of them ran
  `git commit`. Future R4 reconcile rounds should serialize commits more
  tightly or use separate worktrees. The substance is correct; the
  commit message attribution is misleading. Flag for the release-notes
  drafter so the v1.4.27 changelog credits the work to the right line
  item.
- `<ResponsiveSheet>` does not expose Radix's `onOpenAutoFocus`. The
  target-edit-sheet migration falls back to a `useEffect` +
  `requestAnimationFrame` for first-input focus. If RC1 or RC3 want a
  cleaner solution, surface an `onOpenAutoFocus` pass-through on the
  primitive in v1.4.28.
