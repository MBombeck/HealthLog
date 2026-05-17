# v1.4.38 W-D — UX / a11y polish wave report

Scope: the ~17 P1/P2/P3 items from `.planning/round-v1438-backlog.md`
(UX/a11y sections), sourced from
`.planning/phase-W10-v1437-ux-a11y-findings.md`.

Branch: `develop`. Base: `dcd0b0a5`. Marc-Voice English atomic commits.

---

## Commits landed (W-D)

| SHA        | Commit                                                                       | Closes        |
| ---------- | ---------------------------------------------------------------------------- | ------------- |
| `1fd76f26` | a11y(measurements): aria-controls on drill-down chevron                      | P1-1          |
| `c72b3ce8` | (cross-wave mixed) — included messages/de.json + page.tsx + 6-locale test    | P1-3, P1-4    |
| `b6aefc67` | ui(select): tighten trigger right padding for Safari parity                  | P1-6          |
| `3246a6c3` | ui(medication-intake): promote empty-state CTA into footer slot              | P2-1          |
| `4de3e9da` | a11y(insights): announce loaded assessment via polite live region            | P2-2          |
| `31895fce` | a11y(medications): pair window-status colour with a Lucide glyph             | P2-3          |
| `bc1f384e` | ui(buttons): tighten min-h floors on Arztbericht and dismiss CTAs            | P3-2, P3-3    |

Net **6 W-D atomic commits** plus 1 mixed commit that absorbed three W-D
edits (page.tsx max-w, messages/de.json label-shortening, 6-locale
test extension) into a W-A commit because the working tree was
unstaged when W-A's `git add` ran. The W-D content is correct and
present at HEAD; the commit attribution is mixed.

---

## Per-item disposition

### P1 (5 items)

- **P1-1** — done (`1fd76f26`). Stable `drilldown-{desktop,mobile}-${dayKey ?? id}` ids
  threaded as `aria-controls` on the chevron + `id` on the disclosed
  panel (TableRow on desktop, wrapping div on mobile).
- **P1-3** — done (in `c72b3ce8`). `max-w-[calc(100vw-2rem)]` on the
  Hinzufügen `DropdownMenuContent`, and the DE label
  "Medikamenteneinnahme erfassen" → "Einnahme erfassen" so the three
  rows now read "Messung erfassen / Stimmung erfassen / Einnahme
  erfassen".
- **P1-4** — done (in `c72b3ce8`). `quick-add-labels.test.ts` `it.each`
  table extended from en+de to all six locales.
- **P1-5** — **no-op confirm**. `gap-3 md:gap-4` on `target-card.tsx`
  is fine: the status pill is on the title row (`sm:flex-row
  sm:justify-between`), so the gap between header and headline is not
  affected by pill length. `MEDICATION_COMPLIANCE` and `MOOD_STABILITY`
  status labels live in the pill, not below the headline. Keeping as
  `gap-3 md:gap-4`.
- **P1-6** — done (`b6aefc67`). `pr-2.5` → `pr-2`, dropped
  `[&_svg:last-child]:mr-1`. Chevron now parks 8 px from the trigger
  border, matching Safari/Chromium-legacy native date-input gutters.
  Chromium-Material still reads aligned at ~16-20 px combined.

### P2 (5 items)

- **P2-1** — done (`3246a6c3`). Empty-state CTA promoted into the
  sheet footer slot next to Cancel; the body now carries only the
  hint. Footer-slot promise holds across both branches. SSR test
  still asserts `href="/medications"` + `min-h-11` and passes.
- **P2-2** — done (`4de3e9da`). `aria-live="polite"` on the success
  Card so the load → loaded transition is announced.
- **P2-3** — done (`31895fce`). Applied to BOTH the generic
  `MedicationCard` AND the `Glp1MedicationCard` for symmetry — the
  W10 finding noted the GLP-1 card alone but on inspection the
  generic card also painted the pill colour-only. Icons:
  `CircleCheck` (in_window) / `AlertCircle` (late) / `AlertTriangle`
  (very_late). All `aria-hidden="true"` (the text already carries the
  translated label).
- **P2-4** — **no-op confirm**. `health-score-card.tsx:268`
  `grid-rows-[auto_auto_auto_auto_auto_1fr_auto]` is the documented
  intent. W10 itself classed this as "documentation only".
- **P2-5** — **no-op confirm**. `page.tsx:544` `items-center
  sm:items-start` is the documented W4a item-7 intent. The W10 finding
  flagged it as Marc-decision; without explicit Marc input we keep
  the documented behaviour. Note: this may warrant re-visit in v1.5
  if Marc reports the baseline shift looks off vs. other 2-line
  headers.

### P3 (7 items)

- **P3-1** — **no-op**. `mood-chart.tsx:553` `gap-0` interplay
  documented as "fine" in W10.
- **P3-2** — done (`bc1f384e`). `arztbericht-hero-card.tsx`:
  `h-11 px-5 ... sm:h-10` → `h-11 min-h-11 px-5 ... sm:h-10
  sm:min-h-9`. Future overrides cannot re-lift the floor.
- **P3-3** — done (`bc1f384e`). `getting-started-checklist.tsx`:
  `min-h-11 sm:min-h-10` → `min-h-11 sm:min-h-9`. The previous
  `sm:min-h-10` was a no-op against the Button default of `h-10`;
  aligned with the dashboard +Hinzufügen pattern.
- **P3-4** — **no-op**. timezone-picker closed as designed in W10.
- **P3-5** — **no-op**. intake-history pager already consistent.
- **P3-6** — **deferred to v1.5**. `health-score-card.tsx:555`
  `text-[10px]` on the source pill breaches the BL-P4-9 L2 rule (11
  px minimum). W10 itself notes "pre-existing; not a W10
  introduction"; bumping to `text-[11px]` would require checking
  every pill render path + the design-token contract. Defer to v1.5
  with the rest of the typography-token sweep.
- **P3-7** — **no-op**. Hero strip Coach-off stretching is
  acceptable per W10.

---

## Tests delta

Targeted run before final wave-end:

```
pnpm test --run src/components/measurements/__tests__/ \
  src/components/medications/__tests__/ \
  src/components/dashboard/__tests__/ \
  src/components/insights/__tests__/ \
  src/components/settings/__tests__/arztbericht-hero-card.test.tsx \
  src/app/__tests__/quick-add-labels.test.ts
```

- 47 test files, 400 tests passed.
- `quick-add-labels.test.ts`: 2 cases (en, de) → 6 cases (en, de, es,
  fr, it, pl). All pass against current message catalogue (es/fr/it/pl
  still hold the literal EN string; guard catches any future
  divergence that introduces a collision).
- `medication-intake-quick-add.test.tsx`: 7 tests pass. Empty-state
  SSR assertions (`href="/medications"`, `min-h-11`,
  no-form-leak) all still hold after the footer-promotion refactor.
- `medication-card-symmetry.test.tsx`: 7 tests pass. The icon
  addition is symmetric across both cards.
- No new snapshot files (project convention is SSR contract tests).

No regressions introduced. No re-snap needed.

## Quality gates

- `pnpm typecheck` — PASS on the W-D file set. Failed at the wave end
  for an unrelated reason (`src/lib/insights/comprehensive-aggregator.ts:467`
  parsing error from W-F's in-progress edit; not under W-D ownership).
- `pnpm lint` — same as above; the one error reported is in W-F's
  unstaged edit, not in any W-D file.
- `pnpm test --run` (targeted on W-D scope) — PASS (47/47 files, 400
  tests).

---

## i18n note

Only one new visible-copy edit: DE "Medikamenteneinnahme erfassen" →
"Einnahme erfassen" (rhythm fix; the other 5 locales still hold the
literal English block — W-E owns the bulk translation pass).

No new translation keys introduced by W-D. The `quickAddMedicationIntake`
key already existed in all 6 locales; only the DE value was edited.

---

## Snapshot diffs

No snapshot files exist in the touched scope (project uses SSR
contract tests via `renderToStaticMarkup`). All such tests pass
unchanged.

## Coordination notes

- The `c72b3ce8` "fix(geo-backfill)" commit by W-A absorbed three
  W-D file edits because the working tree had unstaged W-D changes
  when W-A staged + committed. Content is correct at HEAD; commit
  attribution is mixed. No rebase attempted — Marc-Voice + atomic
  intent is partially compromised but the change set is recoverable
  via `git log -p`.
- W-F's in-progress edit to
  `src/lib/insights/comprehensive-aggregator.ts` introduces a parse
  error that blocks `pnpm typecheck` / `pnpm lint`. W-F owns; W-D
  does not block.
