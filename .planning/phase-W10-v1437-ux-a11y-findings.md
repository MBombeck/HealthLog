# v1.4.37 W10 — UX / Responsive / Accessibility Findings

Reviewer scope: UX, responsive (320 / 393 / 768 / 1280 viewports), WCAG 2.1 AA,
i18n. Source: full `v1.4.36..HEAD` diff on `develop` (98 files, ~50 commits).
READ-ONLY: no source mutated; only this findings doc was written.

Severity legend:
- **P0** — blocks the release (regression or hard a11y violation)
- **P1** — should land before tag (visible UX / parity break)
- **P2** — landable post-tag (polish, near-miss, debt)
- **P3** — note for the backlog

---

## P0 — Block tag

### P0-1 i18n: medication-intake quick-add ships English copy in es/fr/it/pl
- **Files**: `messages/{es,fr,it,pl}.json` — keys
  `dashboard.medicationIntakeQuickAdd.*` and `dashboard.quickAddMedicationIntake`
- **Symptom**: a Spanish / French / Italian / Polish user opens the dashboard
  "Hinzufügen" menu and sees `"Log medication intake"`. Open the sheet and the
  whole form (`sheetTitle`, `sheetDescription`, `medicationLabel`,
  `medicationPlaceholder`, `doseLabel`, `dosePlaceholder`, `doseHint`,
  `timeLabel`, `saveError`, `emptyTitle`, `emptyDescription`, `emptyCta`) is in
  English. The other dashboard quick-add rows are correctly localised in those
  locales, so the rest of the menu reads as Spanish/French/Italian/Polish and
  the new row is the odd one out — a visible Marc-voice/symmetry break.
- **Fix**: produce localised strings for all four locales. The shape mirrors
  the German block (see `messages/de.json` lines 1638-1672 sibling slot). The
  app does carry a `<MaintainershipBanner>` for those locales but EN copy
  inside a per-row menu still reads as a layout bug, not a translation
  caveat.
- Verified by inspection:
  `python3 -c "import json; print(json.load(open('messages/es.json'))['dashboard']['medicationIntakeQuickAdd'])"`
  returns the English block verbatim.

### P0-2 i18n: cumulative-day expand/collapse and daily total leak English into es/fr/it/pl
- **Files**: `messages/{es,fr,it,pl}.json` — keys
  `measurements.expandDay`, `measurements.collapseDay`,
  `measurements.dailyTotalCaption`
- **Symptom**: Apple-Health step user on Spanish locale sees the daily
  aggregate row read `"… (1234 samples)"` with an expand button whose
  `aria-label` is `"Show samples for this day"`. The rest of the
  measurement-list UI (filter, type labels, empty state) is localised, so the
  new W7c keys are the only English leakage in the row — same Marc-voice break
  as P0-1.
- **Fix**: localise the three keys across es/fr/it/pl (the de block at
  `messages/de.json` line 380 area is the reference shape).

### P0-3 a11y: medication-intake empty-state CTA misses the 44 px touch floor
- **File**: `src/components/dashboard/medication-intake-quick-add.tsx:325`
- **Symptom**: `<Button asChild size="sm" variant="outline">` lowers the
  primary "Medikament anlegen" affordance to `h-8` (32 px). Marc just promoted
  the onboarding checklist toggles to 44 px in W-CI (commit `40c25038`); this
  new affordance lands below the same floor on a Pixel-5 viewport. WCAG 2.5.5.
- **Fix**: drop `size="sm"` (or add `className="min-h-11 sm:h-9"`); the empty
  state is rare enough that visual weight isn't a concern.

### P0-4 a11y: medication-intake footer Cancel/Save miss the 44 px touch floor on mobile
- **File**: `src/components/dashboard/medication-intake-quick-add.tsx:267-292`
  (form footer) and `:299-307` (empty footer)
- **Symptom**: both `<Button>`s ride the default `h-10` (40 px). The
  measurement-form / mood-form siblings have the same pre-existing miss, but
  the v1.4.37 release explicitly raised the dashboard checklist + the
  intake-history pager to `min-h-11 sm:min-h-9`, and W10 is the right moment
  to apply the same fix to the new surface before it ships.
- **Fix**: add `className="min-h-11 sm:min-h-9"` (or `sm:h-10`) to both
  `<Button>`s in `footerNode` and the `emptyFooter` Cancel button.

---

## P1 — Land before tag

### P1-1 a11y: drill-down chevron has aria-expanded but no aria-controls
- **File**: `src/components/measurements/measurement-list.tsx:583-597` (desktop)
  and `:707-724` (mobile)
- **Symptom**: the W7c expand chevron exposes `aria-expanded={isExpanded}` but
  does NOT thread an `aria-controls` to the per-day `<DayDrillDown>` container.
  Screen readers know the row is expandable but can't jump from the button to
  the disclosed content. NVDA / VoiceOver users get an awkward navigation
  beat.
- **Fix**: build a per-row `useId()` (or `drilldown-${dayKey}`),
  set `aria-controls={drilldownId}` on the Button, and stamp `id={drilldownId}`
  on the `<TableRow colSpan=6>` wrapper (desktop) and the `<DayDrillDown>`
  outer `<div>` (mobile).

### P1-2 a11y: dropdown nowrap can clip long labels in narrow containers (no ellipsis)
- **Files**: `src/components/ui/dropdown-menu.tsx:83` (`whitespace-nowrap`),
  `src/components/layout/top-bar.tsx:84` (`w-48` user menu) — and any other
  `DropdownMenuContent` with a fixed narrow `w-*`
- **Symptom**: `DropdownMenuItem` now carries `whitespace-nowrap` globally
  (W4a item 2) and `DropdownMenuContent` carries `overflow-x-hidden`. The
  intent ("Benachrichtigungs-Center" stays on one line) works for the sidebar
  user menu (lifted to `w-60` in commit `5f86d6d4`), but the top-bar user
  menu **was not** lifted and remains at `w-48` (192 px). The German label
  "Benachrichtigungs-Center" (22 chars) + 16 px icon + 8 px gap + 16 px padding
  measures ≈ 220 px and overflows — `overflow-x-hidden` clips it without an
  ellipsis (the item has no `truncate`).
- **Fix**: either (a) bump `top-bar.tsx:84` to `w-60` matching the sidebar
  fix, or (b) drop the global `whitespace-nowrap` from
  `DropdownMenuItem` and apply it only where actually needed (e.g.
  `className="whitespace-nowrap"` on the sidebar items). Option (a) is the
  faster + safer change. Audit any other narrow `DropdownMenuContent` in the
  codebase (`glp1-medication-card.tsx:361` uses `w-56` and could carry the
  same risk for long "Nebenwirkung erfassen"-class strings).

### P1-3 Hinzufügen menu can overflow at 320 px (medication-intake row is the widest)
- **File**: `src/app/page.tsx:598-603`
- **Symptom**: the new third row "Medikamenteneinnahme erfassen" (24 chars in
  German) combined with `whitespace-nowrap` and the `align="end"` content
  measures ~260 px. On a 320 px viewport the `DropdownMenuContent` (no
  `max-w-[…]`) will paint a popover that Radix's collision-aware-positioning
  needs to shift left to fit. The popover will fit, but the right gutter
  collapses to ≈ 12 px which reads cramped. Other dropdowns previously sized
  their items short enough that this didn't surface.
- **Fix**: add a `max-w-[calc(100vw-2rem)]` (or similar) override on the
  `<DropdownMenuContent>` at `src/app/page.tsx:575` so Radix wraps the menu
  rather than running to the screen edge — or shorten the label to
  "Einnahme erfassen" (15 chars). Latter is faster and matches the
  Marc-Voice rhythm ("Messung erfassen" / "Stimmung erfassen" / "Einnahme
  erfassen" — three two-word labels).

### P1-4 Coach-cascade contract: i18n test only covers EN+DE
- **File**: `src/app/__tests__/quick-add-labels.test.ts:47-78`
- **Symptom**: the new `medicationIntake` collision guard runs against `en`
  and `de`. Because `es/fr/it/pl` still hold the literal English string
  (P0-1), the guard happens to pass — but if a future translation lands and
  someone accidentally reuses the EN trigger word, the test would not
  catch it. Low-blast-radius today, but the guard intent is "screen-reader
  user hears distinct labels in every locale".
- **Fix**: extend the `it.each` table to all six locales so the guard scales
  with the translation work that closes P0-1.

### P1-5 Targets card gap claim: tightening works for BP but visually undersized for tile-types with a long status pill
- **File**: `src/components/targets/target-card.tsx:430` — `gap-3 md:gap-4`
  override on Card root
- **Symptom**: the W4a item 3 fix pulls the gap from `gap-4 md:gap-6` (default
  Card) to `gap-3 md:gap-4`. For BP (`Heart` icon + "Blutdruck optimal" pill)
  the rhythm tightens nicely. For metrics with a long status pill like
  `MEDICATION_COMPLIANCE` ("Slightly elevated" wraps in DE, and the pill
  uses `ring-1 + px-2.5` — taller stride) the headline number ("87.5 %") now
  sits close to the pill — at 320 px it reads as one stacked block rather than
  a header + headline. Acceptable, but check `WEIGHT` vs `MOOD_STABILITY`
  (verbal-label headline) — the verbal-stability label runs longer and now
  abuts the pill row more aggressively.
- **Fix**: optional — `gap-3 md:gap-4` is fine for the most common metric.
  Consider `gap-3 md:gap-4 [&:has([data-target-type=MEDICATION_COMPLIANCE])]:gap-4`
  if Marc reports the longer cards feel cramped. Otherwise note as P3 polish.

### P1-6 Select chevron parity claim: ~4 px off the native date-input
- **File**: `src/components/ui/select.tsx:52` — `[&_svg:last-child]:mr-1` +
  `pr-2.5`
- **Symptom**: W4a item 4 claims the chevron now matches the date-input
  glyph "at the same visual gutter as the browser-native date-input calendar
  icon (~16-20 px on Chromium)". Measured: pr-2.5 (10 px) + mr-1 (4 px) =
  14 px between chevron and the right border. Native date-input on Chromium
  is ~10-14 px depending on Material vs legacy theme. The two now MATCH on
  Material but lag by ~4 px on legacy / non-Chromium engines (Safari). Marc's
  "symmetry" directive cares about side-by-side rows, so test the actual
  paired surface: `/settings/account` profile form where DOB (DateInput) sits
  next to Gender (Select). At 768 px both controls land in the same grid
  column.
- **Fix**: optional — if Marc reports the gutters look "fast okay aber",
  bump the trigger to `pr-2` and ditch `[&_svg:last-child]:mr-1` so the
  chevron parks 8 px from the border (matches Chromium legacy + Safari).
  Otherwise close as "good enough for Chromium-primary".

---

## P2 — Polish / land soon

### P2-1 Empty-footer Cancel-only row reads visually unbalanced
- **File**: `src/components/dashboard/medication-intake-quick-add.tsx:299-307`
- **Symptom**: when the user has zero active medications the sheet renders an
  `EmptyState` with the in-body "Medikament anlegen" CTA AND a footer with
  only the `Close` button (right-aligned). The footer has no primary action;
  it reads as the dialog losing a save button. Marc's symmetry rule: the
  empty-state CTA is the "primary action" — promote it INTO the footer (e.g.
  replace the Close button with the Link CTA and keep the Cancel arrow at
  left) so the user finds the primary action in the canonical sheet-footer
  slot.
- **Fix**: in the empty branch render `<>Empty hint (no in-body button)</>`
  in the body, and render `<Cancel> <Link asChild>Medikament anlegen</Link>`
  in the footer. Keeps the footer-slot promise across all branches.

### P2-2 BMI structured skeleton uses `bg-muted` + `animate-pulse` (good) but no aria-busy / sr-only message on success card
- **File**: `src/components/insights/insight-status-card.tsx:52-68` (loading
  branch), `:107-134` (success branch)
- **Symptom**: the skeleton correctly carries `aria-busy="true"`,
  `aria-live="polite"`, and an `sr-only` "Loading" message. Once the assessment
  lands, the success card does NOT carry an `aria-live` region or any signal
  that the content swapped. Screen-reader users get no feedback that the
  card transitioned from loading → loaded. Low priority but easy fix.
- **Fix**: stamp `aria-live="polite"` on the success Card so the post-load
  prose is announced when it replaces the skeleton in the same slot.

### P2-3 GLP-1 card take-now pill uses tri-state colour but no icon
- **File**: `src/components/medications/glp1-medication-card.tsx:394-421`
- **Symptom**: the W4b symmetry fix paints the take-now / overdue /
  very-overdue pill with `text-success` / `text-dracula-yellow` /
  `text-warning` and a localised string. The generic `<MedicationCard>` uses
  the same colour vocabulary but reads `<Pill icon>` + label; the GLP-1 card
  has no icon. Colour-blind users (red-green) cannot distinguish
  in_window from late from very_late. WCAG 1.4.1 (Use of Color).
- **Fix**: prefix the localised label with a status icon: `<Circle>` for
  in_window, `<AlertCircle>` for late, `<AlertTriangle>` for very_late
  (matching whichever icons the generic medication card uses). Same prop
  thread; ~3 lines.

### P2-4 Health-score grid row count and the disclaimer `mt-auto` interplay
- **File**: `src/components/insights/health-score-card.tsx:268` —
  `grid-rows-[auto_auto_auto_auto_auto_1fr_auto]`
- **Symptom**: the 7-row grid switch is well-reasoned: row 6 = `1fr` collects
  slack on the provenance accordion. With the accordion COLLAPSED (the
  default), row 6 carries no content and the `1fr` distributes the slack
  cleanly. With the accordion EXPANDED on a tall card (768 px+), the
  provenance rows expand into row 6's `1fr` and push the disclaimer down.
  This is the intended behaviour, but at 320 px viewport with the accordion
  expanded + a tall hero on the left side, the card may scroll past the
  fold — the parent flex-stretch on `<md:` is `gap-5 flex-col`, so on mobile
  the score lives BELOW the title block, not next to it, so the height
  issue doesn't bite. OK as designed; flag here as documentation only.
- **Fix**: none required. Note the contract assumes the row stretches only
  on md+ viewports.

### P2-5 Dashboard "Hinzufügen" `items-center` on mobile breaks the visual baseline of the page-header rhythm
- **File**: `src/app/page.tsx:544` — `items-center sm:items-start`
- **Symptom**: at 393 px viewport the title "Dashboard" + "Guten Tag, marc"
  stacks two lines (~60 px tall). With `items-center` the +Hinzufügen
  button centers vertically at ~30 px from the top, which means the button
  parks BELOW the title's text baseline. Marc's other 2-line + button rows
  (e.g. on /settings/export where the H1 also stacks above a sub-text) use
  `items-start` and let the button align with the heading's cap height. The
  W4a item 7 fix solves a different problem (button floating with no anchor)
  but the chosen anchor (`items-center`) reads as visually different from the
  other 2-line headers in the app.
- **Fix**: try `sm:items-start items-end` (button bottom-aligns to the
  welcome-text baseline, which is the closest analogue to the desktop
  `items-start` baseline). Or keep `items-center` and accept the difference.
  Marc to decide; document in PR description.

---

## P3 — Backlog / note only

### P3-1 Mood mini-chart `gap-0` interplay with theme dark-mode shadow
- **File**: `src/components/charts/mood-chart.tsx:553` — `gap-0 rounded-md py-2 shadow-none`
- **Note**: the gap collapse to 0 lands the title's `pb-1` (4 px) flush with
  the chart strip. Looks identical to BP / Weight minis in light mode. In
  dark mode the Card has `shadow-none` already so the change is purely
  geometric — fine.

### P3-2 Arztbericht hero `min-h-11 sm:h-10` Button override needs a `sm:min-h-9`
- **File**: `src/components/settings/arztbericht-hero-card.tsx:166`
- **Note**: `h-11 px-5 text-sm font-medium sm:h-10` — the responsive shrink
  works, but pair with `min-h-11 sm:min-h-9` so a future style override
  can't accidentally re-lift the min. Cosmetic; current code works.

### P3-3 Onboarding checklist `min-h-11` on the dismiss-button assumes desktop default `h-10`
- **File**: `src/components/onboarding/getting-started-checklist.tsx:367` —
  `min-h-11 sm:min-h-10`
- **Note**: the comment claims "the shadcn `default` Button is `h-10`" — true.
  But the Ghost variant carries the same `h-10`, so the `sm:min-h-10`
  override is a no-op on desktop (the explicit floor matches the default).
  Either remove `sm:min-h-10` (the default does the same work) or change it
  to `sm:min-h-9` to match the dashboard +Hinzufügen pattern. Tiny.

### P3-4 Timezone picker visual hole after Übernehmen retirement
- **File**: `src/components/settings/timezone-picker.tsx`
- **Note**: the picker now reads as a single `<NativeSelect>` + hint. No
  visual hole; the surrounding form rows close the gap naturally. The
  account-section bootstrap effect that silently seeds the browser zone
  (`resolveInitialTimezone`) is well-documented. Closed as designed.

### P3-5 Medication intake-history list pager touch floor
- **File**: `src/components/medications/intake-history-list-v2.tsx:306-321`
- **Note**: `min-h-11 sm:min-h-9` already applied. Sortable column headers
  carry the same `min-h-11 sm:min-h-9` (lines 213, 224). Consistent.

### P3-6 Health-score card provenance pill `text-[10px]` on data-source label
- **File**: `src/components/insights/health-score-card.tsx:555` —
  `text-[10px] leading-none`
- **Note**: the SOURCE PILL inside the provenance accordion is 10 px.
  Marc's BL-P4-9 L2 rule pins 11 px as the lowest tolerated non-primary
  text. Pill is short ("manual", "withings"); legibility is fine but the
  rule is breached. Pre-existing; not a W10 introduction.

### P3-7 Hero strip flex-stretch on tablet (md) renders left column shorter when SuggestedPrompts are gated off
- **File**: `src/components/insights/hero-strip.tsx:225-273`
- **Note**: when `coachEnabled` is false, the action row + the prompt strip
  both vanish (correctly — no dead controls per the cascade contract). The
  HealthScoreCard on the right still has its full natural height. With
  `items-stretch`, the LEFT column will stretch to match the RIGHT card,
  which means the greeting block now occupies the full row height with no
  visible interior structure. Acceptable; the gradient backdrop reads fine
  empty. Note for the Coach-off operator persona.

---

## Cross-cutting observations

1. **Touch-floor symmetry across newly-added affordances** — the v1.4.37
   release explicitly raised checklist toggles to 44 px (commit `40c25038`)
   and the intake-history pager. The new medication-intake quick-add did
   NOT receive the same treatment (P0-3, P0-4). This is the single biggest
   symmetry break in the release.
2. **i18n parity** — fr/es/it/pl are documented as AI-initial locales with
   a `MaintainershipBanner`, but the new W7b + W7c keys ship as literal
   English strings rather than going through the AI translation step that
   the rest of the catalogue did. Marc's "Umlaute everywhere" directive
   maps to "honest localised copy everywhere"; the EN-leakage on those
   keys breaks the implicit contract.
3. **Coach cascade contract is tight** — verified `HeroStrip`, `TargetCard`,
   `SuggestedPrompts`, `CoachDrawer` on `/targets`, and the Health-score
   card all gate on `flags.coach`. No dead-control surfaces. The
   `coach-cascade.test.tsx` invariant pins it. Well-implemented; no
   findings here.
4. **Medication-card symmetry (Ramipril vs Mounjaro)** — W4b lifts the
   take-now pill, purple dose accent, category-label lookup, and overflow
   kebab into both surfaces. Symmetry contract test pins it. The remaining
   delta is the colour-only state pill on the GLP-1 card (P2-3).
5. **Apple Health step collapsed-view UX** — chevron + `(N samples)`
   caption explains the aggregation; daily total formatting is correct.
   Missing `aria-controls` (P1-1) is the only a11y miss; otherwise the
   design follows the Apple Health.app pattern Marc benchmarked.

---

## File-path index (for fix dispatch)

- `src/components/dashboard/medication-intake-quick-add.tsx` — P0-3, P0-4, P2-1
- `src/components/measurements/measurement-list.tsx` — P1-1
- `src/components/ui/dropdown-menu.tsx` — P1-2
- `src/components/layout/top-bar.tsx` — P1-2
- `src/app/page.tsx` — P1-3, P2-5
- `src/app/__tests__/quick-add-labels.test.ts` — P1-4
- `src/components/targets/target-card.tsx` — P1-5 (optional)
- `src/components/ui/select.tsx` — P1-6 (optional)
- `src/components/insights/insight-status-card.tsx` — P2-2
- `src/components/medications/glp1-medication-card.tsx` — P2-3
- `src/components/insights/health-score-card.tsx` — P2-4, P3-6
- `src/components/charts/mood-chart.tsx` — P3-1
- `src/components/settings/arztbericht-hero-card.tsx` — P3-2
- `src/components/onboarding/getting-started-checklist.tsx` — P3-3
- `src/components/settings/timezone-picker.tsx` — P3-4
- `messages/{es,fr,it,pl}.json` — P0-1, P0-2

