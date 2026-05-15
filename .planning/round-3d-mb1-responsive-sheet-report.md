# Round 3d — MB1 ResponsiveSheet — report

## Scope owned

CF-1 (`<ResponsiveSheet>` primitive root), CF-9 (Coach bottom-sheet
branch on narrow viewports), CF-17 (medication dialog caps), CF-12
(Coach settings-sheet close-X retire), CF-47 (iOS soft-keyboard
overflow on dialog inputs — paired with MB2's primitive-default
lift; MB1 contributes the `max-h-[calc(100dvh-2rem)]` cap on
`<DialogContent>`).

## Commits

Five atomic commits landed on `develop`. Two of mine got swept up
into parallel-bucket commits because of a `git add` race with MB2
(see *Race-condition notes* below) — the commit content is correct
but the commit message attribution is wrong. The work is on the
remote either way.

| # | SHA | Message | Notes |
|---|---|---|---|
| 1 | `65fd0bff` | `feat(ui): introduce the ResponsiveSheet primitive` | Clean. Primitive + `useIsMobile` hook + dialog `max-h` default + smoke suite. |
| 2 | `bd7cb938` | `feat(ui): lift the password toggle into a shared primitive` | Race-mislabeled. The diff is MB1's measurement / mood / dashboard form mount swap. MB2's actual password-toggle move landed in `b2568340` as a follow-up. |
| 3 | `04cce8d9` | `refactor(medications): mount the entry surfaces via ResponsiveSheet` | Clean. medication-form + intake + side-effects + inventory + medications page. |
| 4 | `44554729` | `chore(insights): apply the tap-target floor across the insights surface` | Race-mislabeled. The diff includes MB1's coach-drawer bottom-sheet branch + `useIsMobile("sm")` extension on top of MB2's coach surface tap-target sweep. |
| 5 | `48261b67` | `refactor(coach): retire the redundant settings-sheet close-X` | Clean. coach-settings-sheet swap + test mock extension. |

`pnpm typecheck` + `pnpm lint` clean at every commit boundary.
`pnpm test` clean for every test file the migrated surfaces own
(measurement / mood / medication / coach-settings-sheet — 22 + 68
+ 85 = 175 surface-relevant tests + 6 new `responsive-sheet`
smoke tests). One pre-existing locale-parity failure in
`src/lib/__tests__/i18n-locale-integrity.test.ts` (introduced by
MB3 adding `measurements.filterByType` to `en.json` without
backfill) is out of MB1's scope.

## ResponsiveSheet API

```ts
interface ResponsiveSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  hideHeader?: boolean;            // sr-only title, hide visual header
  footer?: React.ReactNode;        // sticky on Sheet, flow on Dialog
  className?: string;              // applied to SheetContent / DialogContent
  bodyClassName?: string;          // applied to the body wrapper
  showCloseButton?: boolean;       // forwarded to primitive
  children: React.ReactNode;
}
```

Branch decision via `useIsMobile()` from `src/hooks/use-is-mobile.ts`.
Default breakpoint `md` (768 px). `useIsMobile("sm")` (640 px) lives
in the same hook for the coach-drawer's tighter bottom-sheet cut.
SSR-safe — returns `false` on the server + first paint, then flips
to `matchMedia` truth on the effect tick.

The Sheet branch sticky-pins the footer slot at the bottom edge with
a backdrop-blur background. The Dialog branch flows the footer
normally. Both branches surface a `data-variant="dialog" | "sheet"`
hook for tests + downstream styling.

## Migrated forms

Primary entry forms (Decision G — "log this thing"):

- `src/app/measurements/page.tsx` — measurement add
- `src/app/mood/page.tsx` — mood add
- `src/app/page.tsx` — dashboard quick-entry (measurement + mood)
- `src/app/medications/page.tsx` — medication create/edit
- `src/components/medications/intake-history-list.tsx` — intake create + intake edit
- `src/components/medications/SideEffectsSection.tsx` — side-effect log
- `src/components/medications/inventory-section.tsx` — pen add

Coach surfaces:

- `src/components/insights/coach-panel/coach-drawer.tsx` — `side="bottom"`
  branch below `sm` (640 px); above `sm` keeps the existing right-side
  slide. Adds `data-variant="bottom-sheet" | "side-sheet"`.
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` —
  retires the primitive's absolutely-positioned close-X
  (`showCloseButton={false}`) in favour of an inline `<SheetClose>`
  in the header so the close affordance matches the coach-drawer
  pattern and clears 44 px.

Untouched (Decision G — "configure a parameter", stays centred):

- `src/app/medications/page.tsx` `IntakeImportDialog` — centred
  `<Dialog>` with the new `max-h-[calc(100dvh-2rem)]` primitive cap
  doing the overflow work.
- `src/app/medications/page.tsx` `ApiEndpointDialog` — same.
- Medication `phase-config-dialog.tsx` — out of MB1 scope per
  Decision G; MB7 owns the row-stack fix.

## Dialog primitive change

`src/components/ui/dialog.tsx` — `<DialogContent>` className now
includes `max-h-[calc(100dvh-2rem)] overflow-y-auto` so long centred
dialogs (medication editor, ApiEndpoint, IntakeImport, etc.) never
spill past the viewport on short / soft-keyboard mobile screens.
Distinct line range from MB2's close-X `min-h-9 min-w-9` lift —
documented sequenced edit in Section 3.

## Deviations from the brief

1. **Optional commit 6 (sticky-pin Save/Cancel pattern) deferred.**
   The migrated forms (measurement, mood, medication, intake,
   side-effect, inventory) carry their Save/Cancel button rows inside
   their own form bodies. Sticky-pinning those rows on the Sheet
   branch requires either lifting the buttons out via a render-prop
   contract or repurposing the `<ResponsiveSheet footer>` slot —
   both of which would touch every form's internal layout. The
   `<ResponsiveSheet>` primitive already supports sticky-pinning via
   the `footer` slot for callers that opt into it; the migration
   commits keep the existing form chrome intact and let the form's
   button row scroll with the body. Worth a follow-up R3d-extension
   commit if Marc wants the sticky-CTA pattern across the board.

2. **`useIsMobile` extended with a breakpoint argument.** The plan's
   Decision A names `md` (768 px) as the primitive cut. The coach
   bucket's CF-9 names `<sm` (640 px). Both consume the same hook
   via `useIsMobile()` (default `md`) and `useIsMobile("sm")`. No
   new sibling hook; a single typed enum parameter on the existing
   one.

## Race-condition notes for the coordinator

Two of my staged commits were swept into parallel-agent commits
because the working tree was a shared mutable resource between
MB1, MB2, MB3, and MB6 running concurrently. The pattern was:

1. MB1 stages files via `git add <file>` for a clean targeted set.
2. MB2 runs its own `git commit` against an overlapping staging
   zone (Husky-less repo, no atomic-stage lock); the commit
   succeeds and picks up MB1's staged content under the wrong
   commit message.
3. MB2 then redoes the original work in a follow-up commit.

End state on `develop`: every line of MB1 work is on the branch.
Commit messages are inconsistent. If a clean attribution matters
for the v1.4.27 changelog, the affected commits are `bd7cb938`
(measurement / mood / dashboard form mount swap) and `44554729`
(coach-drawer bottom-sheet branch + `useIsMobile("sm")` ext).

Forward-fix options:
- **Leave as-is** — the diff content is correct, the v1.4.27
  changelog can attribute the work to MB1 regardless of commit
  message; readers care about content not commit-message
  attribution.
- **Rewrite history** via `git rebase -i` to fix up the commit
  messages — risky during a multi-agent marathon; would force every
  agent to rebase their pending work.

Recommendation: leave as-is. Note the misattribution in the v1.4.27
release prep handoff so the marathon coordinator can keep an eye on
the issue on the next round.

## Done-when checklist

- [x] 5 atomic commits on `develop` (target was 5-6; optional commit 6
      deferred as documented above).
- [x] `pnpm typecheck` + `pnpm lint` clean at every commit boundary.
- [x] Surface-relevant `pnpm test` green at every commit boundary
      (responsive-sheet smoke + measurements + mood + medications +
      coach-panel). Repo-wide test failure in i18n-locale-integrity
      is pre-existing from MB3 and out of MB1 scope.
- [x] `<ResponsiveSheet>` API documented above.
- [x] Every migrated form listed above.
- [x] Deviations + race notes documented.
- [x] Pushed to `origin/develop`.
