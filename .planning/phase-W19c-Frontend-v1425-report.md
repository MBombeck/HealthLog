# Phase W19c-Frontend — Research-mode dialog + drug-level chart + Settings toggle (v1.4.25)

**Branch:** `develop`
**Predecessor:** W19c-Backend (`cf27df4` — `.planning/phase-W19c-Backend-v1425-report.md`).
**Spec:** dispatch brief from Session 3 / W19c-Frontend, anchored on
research §2.3 + §9.6.7 + §11 + §12.4 in
`.planning/research/glp1-feature-inspiration.md`.
**Successor (queued):** W19c-Safety — Coach refusal GROUND RULE 15
plus the six safety YAMLs (see hand-off below).

## Commits landed

| SHA       | Subject                                                              |
| --------- | -------------------------------------------------------------------- |
| `3502f57` | `feat(medications): research-mode MDR acknowledgment dialog`         |
| `85ba382` | `feat(medications): estimated drug-level chart on GLP-1 detail pages` |
| `20a72d2` | `feat(settings): research-mode toggle with version re-prompt banner` |
| _this_    | `docs(planning): W19c-Frontend dialog + chart + settings phase report` |

## Scope delivered

### Commit 1 — Acknowledgment dialog

`src/components/medications/ResearchModeAcknowledgmentDialog.tsx`

- Controlled modal (`open` / `onOpenChange`) so the Settings toggle and
  the chart's gated placeholder can both drive it.
- Five labelled sections under the title: **What this is** (population
  PK / one-compartment Bateman framing, unit-less axis), **What this
  isn't** (not a measurement / not advice / not a basis for any dose
  decision), **Why it's an estimate** (population PK + 22 % / 49 % IIV
  cited verbatim), **Regulatory boundary** (EU 2017/745 + MDCG 2021-24
  cited by id), **Sources** (EMA EPAR + Schneck/Urva 2024 DOI
  10.1002/psp4.13099 cited verbatim).
- Acknowledge CTA `POST /api/auth/me/research-mode { acknowledged:
  true, version }` — uses the live `currentDisclaimerVersion` from the
  Settings `GET`, **not** the imported `RESEARCH_MODE_DISCLAIMER_VERSION`
  constant, per W19c-Backend's "redeploy without client reload" rule.
- Stale-version 400 (`research-mode.version.stale`) surfaces a
  localised toast (`staleVersionToast`) and keeps the dialog open;
  every other failure mode collapses to the generic `errorToast`.
- On success: invalidates the `["research-mode"]` query, fires the
  generic success toast (`successToast`), calls `onAcknowledged()`,
  and `onOpenChange(false)`.
- Footer carries the live disclaimer version stamp as small italic
  text (so the user can see which version they're acknowledging).

#### i18n

`messages.medications.researchMode.dialog.*` — 14 keys × 6 locales:

```
title, intro,
whatItIsHeader, whatItIs,
whatItIsntHeader, whatItIsnt,
whyEstimateHeader, whyEstimate,
mdrBoundaryHeader, mdrBoundary,
citationsHeader, citations,
versionLine,
acknowledgeCta, cancelCta,
successToast, errorToast, staleVersionToast
```

DE + EN are hand-curated Marc-Voice (English, professional, no AI /
phase / wave mentions). FR / ES / IT / PL are drafted from EN with
locale-appropriate phrasing for the regulatory line (EU 2017/745 +
MDCG 2021-24 cited verbatim in every locale).

#### Tests

`src/components/medications/__tests__/ResearchModeAcknowledgmentDialog.test.tsx`
— 8 cases:

1. Renders nothing while closed.
2. Renders the five-section copy + cited regulatory ids (`2017/745`,
   `MDCG 2021-24`, `10.1002/psp4.13099`) + the version line.
3. The mutation captured from `useMutation` posts the right body
   shape to the right URL.
4. `onSuccess` fires the success toast + invokes `onAcknowledged` +
   closes the dialog.
5. The stale-version error path raises the stale toast and keeps the
   dialog open.
6. Generic error path raises the generic toast.
7. Acknowledge CTA stays `disabled` until the server-supplied version
   lands.
8. German locale renders the German copy + the EU 2017/745 citation.

### Commit 2 — Drug-level chart

`src/components/medications/DrugLevelChart.tsx`

- Reads three queries:
  - `["research-mode"]` — the version-aligned state.
  - `["medications", id, "glp1-details"]` — dose-change history.
  - `["medications", id, "intake", "drug-level-chart"]` — recent
    intake events (last 20, sorted desc by `takenAt`).
- Resolves the medication's brand to a `Glp1DrugId` via the catalog
  helper (`findDrugByBrand`) plus a reverse-lookup against `GLP1_DRUGS`
  (the helper returns the record value, not the key). When the brand
  isn't in the EMA-approved catalog the chart renders an unknown-drug
  placeholder rather than throwing.
- Doses are derived by mapping each non-skipped intake's `takenAt` to
  the applicable `MedicationDoseChange.doseValue` (latest
  `effectiveFrom ≤ takenAt`); intakes that pre-date every dose-change
  row fall back to the medication's headline `dose` string parsed by
  the inline `parseDoseMg` helper.
- Calls `computeOneCompartment(drug, doses, asOf)` from
  `src/lib/medications/glp1-pk.ts` with a **21-day look-back, 0
  forward, 6-h step** window — three weekly cycles of history with
  "now" at the right edge, matching research §2.4's research-view
  recommendation.
- Recharts `<AreaChart>` over a numeric x-axis (`dayOffset` in days
  since now). Y-axis carries `tick={false}` + `axisLine={false}` so
  no numeric ticks paint (research §2.3 — unit-less). A small visible
  caption above the chart carries the **"Estimated level (relative)"**
  framing so both screen-readers and SSR snapshots surface it.
- Gradient fill + 2 px stroke in `var(--dracula-purple)` matches the
  visual language of `medication-compliance-chart.tsx` and the other
  Recharts surfaces (Marc-memory: charts must remain visually
  identical to the existing pattern).

#### Gating decision tree (defence-in-depth)

| Condition | Placeholder data-slot |
| --- | --- |
| medication brand not in catalog | `drug-level-chart-unknown-drug` |
| `researchMode.enabled === false` | `drug-level-chart-gated` (`data-stale="false"`) |
| `acknowledgedVersion !== currentDisclaimerVersion` | `drug-level-chart-gated` (`data-stale="true"`) |
| loading (RQ in flight) | `drug-level-chart-loading` |
| no non-skipped intake events | `drug-level-chart-empty` |
| otherwise | `drug-level-chart-area` (the Recharts frame) |

The chart also paints an educational disclaimer caption
(`drug-level-chart-disclaimer`) below the frame whenever it's actually
rendering.

#### Mount point — `/medications/[id]/history`

Repository has no `/medications/[id]/page.tsx` route today (the
medication-list page is at `/medications`; the per-medication detail
view is `/medications/[id]/history`). The chart mounts there,
conditional on `medication.treatmentClass === "GLP1"` — the chart's
own internal gate then handles Research-Mode opt-in. Documented in
the page comment so the v1.5 iOS work that adds a real
`/medications/[id]/page.tsx` can move the mount without searching.

#### i18n

`messages.medications.researchMode.chart.*` — 10 keys × 6 locales:

```
title, axisLabel, emptyState, emptyStateCta, estimateNote,
gatedTitle, gatedBody, gatedStaleTitle, gatedStaleBody, gatedCta,
unknownDrug
```

DE + EN hand-curated; FR / ES / IT / PL drafted from EN.

#### Tests

`src/components/medications/__tests__/DrugLevelChart.test.tsx` —
10 cases:

1. Unknown drug → `unknown-drug` placeholder, no PK math runs.
2. Research Mode OFF → `gated` placeholder with `data-stale="false"`,
   no PK math runs.
3. Versions stale → `gated` placeholder with `data-stale="true"`, no
   PK math runs.
4. Gate open but no intake events → `empty` placeholder.
5. Gate open + events present → chart paints; `computeOneCompartment`
   is called with the right drug id (`"tirzepatide"`), only the
   non-skipped doses, and the supplied `asOf`.
6. The y-axis carries no `recharts-cartesian-axis-tick-value` text
   elements (unit-less per research §2.3).
7. The axis-label caption still renders.
8. `parseDoseMg` parses `"7.5 mg"`, `"12,5 mg"`, `"0.25 mg"`,
   `"15 mg"`.
9. `parseDoseMg` returns NaN for non-numeric strings.
10. `resolveDoseMg` walks the dose-change history correctly and
    returns the fallback on unparseable input.

### Commit 3 — Settings toggle

`src/components/settings/advanced-section.tsx`

- Added `ResearchModeCard` above the existing `DataResetCard`. Both
  controls are opt-in / acknowledgment-style operations, so they share
  a semantic shelf on the Advanced page. No new settings slug was
  added — adding one would have pulled in sidebar + i18n parity
  scaffolding for a single card.
- The card reads the `["research-mode"]` query, renders a title +
  subtitle, the toggle, and a status line below the toggle:
  - When OFF: "Disabled. The drug-level chart is hidden."
  - When ON + versions aligned: "Acknowledged on `{date}`."
  - When ON + versions diverged: "The disclaimer was updated.
    Re-acknowledge below to bring the chart back."
- Toggle ON opens the dialog from commit 1 (the dialog owns the
  POST). Toggle OFF fires `DELETE /api/auth/me/research-mode` directly
  and invalidates the query. A `disableError` toast fires on
  network/HTTP failure.
- **Re-prompt banner** — amber, slot `settings-research-mode-reprompt`
  — renders above the toggle whenever
  `enabled === true && acknowledgedVersion !== currentDisclaimerVersion`.
  Carries a "Re-acknowledge disclaimer" CTA that opens the dialog.
  This is the defence-in-depth UX rule from the backend phase report.
- Advanced section description (`settings.sections.advanced.description`)
  updated across all six locales to reflect that the section now
  hosts both research-mode + danger-zone.

#### i18n

`messages.settings.researchMode.*` — 10 keys × 6 locales:

```
sectionTitle, subtitle, toggleLabel,
disabledStatus, enabledStaleStatus, acknowledgedOn,
rePromptTitle, rePromptBody, rePromptCta,
disableError
```

DE + EN hand-curated; FR / ES / IT / PL drafted from EN.

#### Tests

`src/components/settings/__tests__/advanced-research-mode.test.tsx` —
5 cases:

1. OFF state: card renders title + subtitle + OFF status, no re-prompt
   banner, toggle unchecked.
2. ON + aligned: "Acknowledged on" status, no banner, toggle checked.
3. ON + stale: re-prompt banner with Re-acknowledge CTA, toggle still
   checked, status line reflects the stale state.
4. Dialog receives the live `currentDisclaimerVersion` from the
   parent's `GET` payload (asserted via the mocked dialog's
   `data-version` attribute).
5. German locale renders the German copy.

The existing `<AdvancedSection> renders the danger-zone card only`
assertion in `sections.test.tsx` continues to pass because the test
only asserts presence of the title + absence of export keys — the
ResearchMode card doesn't trip any of those.

## Quality gates

Per-commit (and final sweep on this report's branch state):

- `pnpm typecheck` — clean.
- `pnpm lint` — clean.
- Touched-surface tests — clean.
  - Dialog spec: 8 cases.
  - Chart spec: 10 cases.
  - Settings spec: 5 cases.
  - Existing medications + settings suites (33 + 86 cases) stay
    green.
- i18n parity test (`sections-i18n-parity.test.ts`) — clean, including
  the EN-vs-DE description-difference guard the changed advanced
  description now satisfies.

## Deviations + design choices

1. **Chart mount lives on `/medications/[id]/history`, not on a
   missing `/medications/[id]` detail page.** The repo has no detail
   page today, and creating one would have pulled in routing, header,
   metadata, and tests outside this phase's scope. The history page is
   the existing per-medication detail view; mounting there keeps the
   surface coherent and lets v1.5 iOS work create the proper detail
   route without re-wiring the chart.

2. **Settings home is `/settings/advanced`, not a new
   `/settings/medications` route.** Adding a new slug would have
   required: sidebar entry, icon pick, sidebar test order, i18n
   parity entries (`title` + `description` in six locales), the page
   wrapper file, the section-slugs constant update. For a single
   research-mode card the cost-benefit favoured reusing Advanced,
   which is already the home of the other opt-in / irreversible
   account-level control (the danger zone). The Advanced description
   was rewritten in all six locales to reflect the new dual scope.

3. **Y-axis tick suppression uses Recharts `tick={false}` rather
   than `tickFormatter={() => ""}`.** The `tick={false}` flag also
   suppresses the axis line so the chart frame stays clean. The
   axis-label caption above the chart frame carries the
   "Estimated level (relative)" framing for SSR + screen-readers,
   complementing the Recharts `<YAxis label={...}>` that paints inside
   the SVG at runtime.

4. **Switch stays "checked" even when versions are stale.** The user's
   previous opt-in choice is preserved; the banner above the toggle
   explains why the chart isn't painting. Flipping the switch back to
   "off" automatically when the version drifts would silently undo
   the user's prior consent.

5. **`/medications/[id]/intake` GET is used for the chart's intake
   feed, not the GLP-1 details endpoint's `recentIntakes`.** The
   details endpoint already returns the last 12 events with only
   `takenAt + injectionSite`; the chart needs `skipped + scheduledFor`
   to filter correctly. Using the existing list endpoint adds zero
   new backend surface.

## Touch-disjoint compliance

Files touched (all permitted by the dispatch spec):

- `src/components/medications/ResearchModeAcknowledgmentDialog.tsx`
  (new)
- `src/components/medications/__tests__/ResearchModeAcknowledgmentDialog.test.tsx`
  (new)
- `src/components/medications/DrugLevelChart.tsx` (new)
- `src/components/medications/__tests__/DrugLevelChart.test.tsx`
  (new)
- `src/app/medications/[id]/history/page.tsx` (small edit — add the
  chart mount under a `treatmentClass === "GLP1"` guard)
- `src/components/settings/advanced-section.tsx` (additive — added the
  ResearchModeCard sibling next to DataResetCard)
- `src/components/settings/__tests__/advanced-research-mode.test.tsx`
  (new)
- `messages/{de,en,fr,es,it,pl}.json` — added
  `medications.researchMode.{dialog,chart}.*` and
  `settings.researchMode.*`, updated
  `settings.sections.advanced.description` in every locale.

Did not touch:

- `prisma/` (W19c-Backend shipped).
- `src/lib/medications/glp1-pk.ts` (W19c-Backend; read-only).
- `src/app/api/auth/me/research-mode/` (W19c-Backend; read-only).
- `src/app/onboarding/**` (W14b-Content territory).
- `src/components/onboarding/**` (W14b-Content territory).
- `src/lib/coach/**` (W19c-Safety territory).
- Coach prompt YAMLs (W19c-Safety territory).

## For W19c-Safety

The Coach refusal-layer that the W19c-Safety phase ships will sit
**on top of** this UI surface. The contract the safety layer needs to
know:

1. The chart is **opt-in and version-gated**. The Coach can rely on
   "if Research Mode is off, the user has never seen a numeric or
   qualitative drug-level surface in HealthLog." The Coach prompt
   must still refuse any drug-level reasoning ("when will my level
   peak?", "should I inject earlier?", "is my level safe?") regardless
   of toggle state — the refusal is universal, not conditional on the
   chart being visible.

2. The dashboard "shot phase" chip (rising / peak / fading), once
   shipped (research §2.4 — not in this phase's scope), reads from
   the same PK helpers (`shotPhaseAt`). The Coach refusal must cover
   the chip too. Suggested wording: "I won't infer whether you're at
   peak or trough — that's not a measurement my view can support."

3. The acknowledgment record (`user.researchModeAcknowledgedAt`
   + `Version`) is **not exposed to the Coach context bundle**. The
   safety layer should NOT add it to the snapshot — the Coach has
   no need to know which disclaimer version the user accepted.
   Persistent reasoning about "you turned on Research Mode three
   weeks ago, so…" is exactly the kind of inference that crosses
   the line.

4. The dialog copy carries the verbatim regulatory refs **EU 2017/745**
   and **MDCG 2021-24**. If the safety layer needs to surface a
   refusal explanation, it can reference either by id without paraphrasing
   — the user has already seen these strings in the acknowledgment
   modal.

5. Test fixtures: the chart test pins `tirzepatide` as the resolved
   drug id for the brand `"Mounjaro"` (via the catalog's `findDrugByBrand`
   helper). The Coach refusal tests can reuse the same brand string
   when constructing dose-event fixtures.
