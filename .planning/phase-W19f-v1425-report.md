# Phase W19f — EMA titration-ladder display on the GLP-1 detail page

**Branch:** `develop`
**Release:** v1.4.25
**Sub-wave:** Wave 4b (3 of 3 — W19d → W19e → W19f, all touching the
medication detail page)

## Commits

| SHA | Subject |
|---|---|
| `bdaf128` | feat(medications): pure titration-ladder helpers from W19a knowledge |
| `b4ed2ed` | feat(api): GET titration-ladder + current-step for GLP-1 medications |
| `86dbff0` | feat(medications): EMA titration-ladder display on GLP-1 detail page |
| _this_     | docs(planning): W19f titration ladder + Wave 4b closeout phase report |

## Scope shipped

1. **Pure titration helpers** (`src/lib/medications/titration/ladder.ts`).
   Reads the EMA-pinned `titrationStepsMg` + `titrationIntervalWeeks`
   already on the W19a `glp1-knowledge.ts` catalog and normalises
   them into the `TitrationStep` contract the API route + the UI
   section share:
   - `getLadder(drugId)` / `ladderFromRecord(record)` — ordered step
     list with stepIndex + typicalWeeks
   - `findCurrentStep(drugId, latestDoseMg)` — snap to the closest
     step within a ±10 % tolerance window; null outside any bucket
   - `nextStep(drugId, currentStep)` — null at the ladder ceiling
   - `weeksOnCurrentStep(drugId, currentStep, doseChanges, asOf)` —
     elapsed whole-weeks since the latest matching dose-change row;
     0 with no matching rows or future-only matches
   - `escalationDue(drugId, currentStep, weeksOnStep)` —
     observational flag (dwell-time reached AND next step exists)
   Zero DB access; all functions take pre-fetched rows. Same shape
   as the W19d side-effects helpers and the W19e cadence module.

2. **API** — `GET /api/medications/[id]/titration` returns
   `{ drugId, drugInn, ladder, currentStep, currentStepIndex,
     weeksOnCurrentStep, nextStep, escalationDue, sourceEMA }`.
   Defence-in-depth gating: `requireAuth` + ownership check + 404
   when `treatmentClass !== "GLP1"` + 404 when the medication name
   doesn't map to a catalog brand (same `findDrugByBrand` path the
   `DrugLevelChart` uses). Reads `MedicationDoseChange` for the
   dose stream; falls back to parsing the legacy free-text
   `medication.dose` only when the stream is empty. Pure-read; no
   writes; `annotate()` instrumentation only.

3. **TitrationSection component**
   (`src/components/medications/TitrationSection.tsx`) — mounts
   between `<SchedulingSection>` (W19e) and `<IntakeHistoryList>`
   on the medication detail page. Same chrome
   (`border-border/60 rounded` + `text-foreground/85 text-sm
   font-medium`) so the three Wave-4b panels feel like one visual
   group.
   - Header strip: section title + drug INN
   - Mobile-first step list (`flex-col`); horizontal `flex-row` track
     from `sm` upwards. Each step is a small card with `stepLabel`,
     dose, and the typical-weeks badge; the current step carries a
     `border-primary ring-2` highlight + `aria-current="step"`
   - "You are here" caption on the matched step only
   - Optional `currentStepDwell` ("On this step for N weeks") below
     the ladder; flips to `escalationDueHint` ("you've been on this
     step for N weeks; the ladder typically steps up around T weeks")
     when the EMA dwell-time has elapsed. **Both phrasings are
     strictly observational — never prescriptive. MDR boundary.**
   - `nextStepCaption` when a next step exists; `ceilingMessage` at
     the top; `nonStandardDose` caption when the user's latest dose
     doesn't snap to any step inside the tolerance window
   - Always-on disclaimer + external EMA-source link

4. **Mount** — `src/app/medications/[id]/history/page.tsx`. Same
   `medication?.treatmentClass === "GLP1"` gate, identical
   conditional pattern as the W19d / W19e blocks.

5. **i18n** — six locales (DE / EN / FR / ES / IT / PL) under
   `medications.titration.*`, inserted **after** `medications.scheduling`
   per the W19e handoff so JSON ordering stays stable across waves.
   DE + EN hand-curated Marc-Voice; FR / ES / IT / PL drafted from EN.

## Tests

- `src/lib/medications/titration/__tests__/ladder.test.ts` — 22
  cases (every EMA drug exposes a non-empty ladder, strictly
  ascending doses, sequential stepIndex, typicalWeeks parity,
  exact-match snap, ±10 % tolerance snap, outside-tolerance null,
  ceiling no-next-step, weeksOnCurrentStep 0 on empty / null-step,
  positive case, ignores other-step rows, future-match returns 0,
  escalationDue boundary toggle, ceiling never fires).
- `src/app/api/medications/[id]/titration/__tests__/route.test.ts`
  — 8 cases (401, 404 on non-owner, 404 on non-GLP-1, 404 on
  unknown brand, happy path on a 5 mg Mounjaro user with two
  dose-change rows, null current step on non-standard dose, null
  next step at the ladder ceiling, escalationDue=true past the
  EMA dwell-time).
- `src/components/medications/__tests__/TitrationSection.test.tsx`
  — 10 cases (heading + INN, all six steps render, "You are here"
  appears exactly once, next-step caption, ceiling message,
  non-standard dose caption, disclaimer + EMA link, empty ladder
  empty state, observational-copy discipline (no "should/must
  step up"), DE locale render).

**Total new tests: 40, all passing.** The full medication surface
(22 files, 306 cases) re-runs clean. The i18n-locale-integrity
test (26 cases) + the settings i18n parity test pass on the new
`medications.titration.*` keys.

## Gates

- `pnpm typecheck` — clean.
- `pnpm lint` over the touched surface — clean.
- `pnpm test --run <touched-surface>` — 40 / 40 new pass; 306 / 306
  across the wider medication surface; 49 / 49 across the i18n
  parity tests.

## Deviations

1. **No new schema migration.** W19a's `glp1-knowledge.ts` already
   carries `titrationStepsMg` (the ladder) and
   `titrationIntervalWeeks` (the EMA dwell time) for all five
   EMA-approved drugs; the existing `MedicationDoseChange` stream
   is the history-of-record for per-user dose transitions and
   already drives the `MedicationDoseChange` ordering this section
   reads. Adding a parallel `titration_step` table would have
   created a second source of truth for the ladder data; the W19e
   "no new infra unless the existing primitives don't fit" rule
   carries over. **Net effect:** migration `0060` stays unassigned
   — still available for the next wave that needs it.

2. **No "Edit dose" CTA / dose-change recording surface on this
   section.** The brief did not call for one; the existing
   `medication-card-glp1` disclosure on `/medications` is the
   canonical surface for logging titration changes
   (`POST /api/medications/[id]/glp1` with `doseChange`). Adding
   a second writer would duplicate the W19e mistake-shape the
   handoff explicitly warned against.

3. **Observational copy only, never prescriptive.** The
   `escalationDueHint` boolean toggles *display* of "you've been
   on this step for N weeks; the ladder typically steps up around
   T weeks", not display of any "should/must step up" copy. The
   `TitrationSection` test pins this with three negative
   assertions — no "should step up", no "must step up", no
   "recommend step up". MDR boundary, parallel to the W19c safety
   ground rules.

4. **CSS-grid step track, no Recharts.** The ladder is six small
   monochrome step cards. Recharts is overkill for a discrete
   six-element ordinal display and the simpler render keeps SSR
   cost low.

5. **±10 % step-match tolerance.** Marc-typed doses are free-text;
   the user might log "0.5 mg" against a 0.5 mg step OR "0.49"
   against the same step. ±10 % is generous enough to capture
   user-typed rounding without snapping a 0.6 mg dose to either
   the 0.5 mg or the 1 mg step (0.5 + 10 % = 0.55; 1 − 10 % =
   0.9). The test pins the boundary; the API returns
   `currentStep: null` outside any step's tolerance window so the
   UI surfaces "non-standard dose" rather than misleading the user
   with a false "you are here".

## Wave 4b — closed

After W19f, the GLP-1 medication detail page section stack is:

```
+--------------------------------------------------+
| Back to medications                              |
+--------------------------------------------------+
| "Intake history"      [ + Add intake CTA ]       |
| <medication name> · <dose>                       |
+--------------------------------------------------+
| <DrugLevelChart>       (W19c — chart)            |
+--------------------------------------------------+
| <SideEffectsSection>   (W19d — taxonomy)         |
+--------------------------------------------------+
| <SchedulingSection>    (W19e — cadence)          |
+--------------------------------------------------+
| <TitrationSection>     (W19f — ladder, just now) |
+--------------------------------------------------+
| <IntakeHistoryList>    (existing)                |
+--------------------------------------------------+
```

The three Wave-4b panels (W19d / W19e / W19f) share identical
chrome and identical conditional-mount pattern; each one's pure
helpers expose a stable contract (`buildCadenceTimeline`,
`complianceChips`, `getLadder`, `findCurrentStep`,
`weeksOnCurrentStep`, `escalationDue`) the Coach snapshot or a
future Health-Score adherence dimension can read without
re-deriving.

**Wave 4b CLOSED.** No destructive concerns; no PII landed in any
user-facing copy; no new schema migrations; no advice copy
anywhere in the user-facing artefacts.

## Pen for the next agent

- The titration module exports `getLadder`, `findCurrentStep`,
  `nextStep`, `weeksOnCurrentStep`, and `escalationDue` as stable
  contracts. The Coach snapshot can read these for ladder-context
  without re-implementing the step-matching math.
- ±10 % is encoded as a private `STEP_MATCH_TOLERANCE = 0.1` in
  `ladder.ts`; changing it will move the boundary of
  `findCurrentStep` and (transitively) `weeksOnCurrentStep`.
- The route reads `MedicationDoseChange` ordered ascending by
  `effectiveFrom`; the helper then re-sorts defensively because it
  doesn't trust caller ordering. Either side can change
  independently without breaking the other.
- The `escalationDueHint` copy is the most safety-sensitive string
  on the section. Any future change must preserve the
  observational frame — never "you should / must / are advised to
  step up".
