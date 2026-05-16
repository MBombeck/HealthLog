---
file: .planning/round-3c-med-report.md
purpose: R3c-Med sub-pass close-out — medications surface consistency
contributor: R3c-Med
created: 2026-05-15
---

# R3c-Med — close-out

Medications surface consistency sub-pass for v1.4.28. Four logical
deliverables shipped: FB-G1, FB-F1 + FB-F2, FB-F3 + FB-F4, BK-M2. Due
to live `git add -A` races from adjacent contributors the four atomic
commits split slightly differently than the kickoff envisaged — total
commit count is five (one i18n half landed under its own commit when
the original `fix(medications): align side-effects card` race-lost the
locale files). All scoped work is in the develop tree at the end of
this sub-pass.

## Commits

| SHA | Subject |
|---|---|
| `6f6992c6` | refactor(medications): unify medication-list row shape |
| `7d38a54d` | fix(medications): align side-effects card to the surface convention |
| `88085615` | fix(medications): shorten side-effects add CTA across locales |
| `5109e930` | refactor(medications): collapse detail-page chrome to one heading scale |
| `0e7c97c5` | fix(insights): align briefing empty-state CTA variant |

### Per-commit one-liners

- `6f6992c6` — FB-G1. Carved `<MedicationCardHeader>` and routed both
  `<MedicationCard>` and `<Glp1MedicationCard>` through it. GLP-1 row
  loses its `<Syringe>` glyph + middle-dot separator; both rows now
  render `{name} {dose}` on line 1 and class label + state badges on
  line 2. Tests updated to pin the new contract.
- `7d38a54d` — FB-F1 test-half. Pins the new "Log" / "Erfassen" CTA
  assertions on `SideEffectsSection.test.tsx`. (The substantive
  SideEffectsSection.tsx F2 layout adjustment originally landed inside
  the adjacent contributor's `806b3ecc` commit via `git add -A` race;
  was reverted shortly after; was re-applied in `5109e930`.)
- `88085615` — FB-F1 i18n-half. Trims the side-effects add-CTA in all
  six locales to a single verb (Log / Erfassen / Consigner / Registrar
  / Registra / Dodaj) so the chip stops overflowing the card on narrow
  viewports.
- `5109e930` — FB-F3 + FB-F4 + restored FB-F2 layout. Lifted the
  section-header chrome on `/medications/[id]` to one canonical shape
  via `<MedicationDetailSection>` (`text-base font-semibold leading-6
  tracking-tight`). DrugLevelChart's standalone header migrates to
  `<h2>` with the same classes. Swept micro labels from
  `text-[10px]` / `text-[11px]` to `text-xs` across SchedulingSection,
  TitrationSection, SideEffectsSection. Restored the FB-F2 fixed-width
  date slot + line-clamped notes that race-loss had reverted.
- `0e7c97c5` — BK-M2. Switched the daily-briefing empty-state CTA from
  `variant="outline"` to the default filled variant so it matches the
  dashboard empty-state shape. (Commit also swept five R3c-Insights
  files via a `git add -A` race window; my own change is only the
  daily-briefing variant flip.)

## Key decisions

### FB-F1 — qualifier choice

Adopted the competitive recommendation (peer-app convention §3): keep
the verb, drop the qualifier. Section title carries the context. Per
locale:

- en: "Log side effect" → "Log"
- de: "Nebenwirkung erfassen" → "Erfassen"
- fr: "Consigner un effet" → "Consigner"
- es: "Registrar efecto" → "Registrar"
- it: "Registra effetto" → "Registra"
- pl: "Dodaj skutek uboczny" → "Dodaj"

The verb-only chip slots cleanly inside the section header on Pixel-5
(375 px) and below — the qualifier was the bytes responsible for the
overflow.

### FB-F4 — font scale on `/medications/[id]`

Three scales survive on the page:

- Heading: `text-base font-semibold leading-6 tracking-tight` (one
  shape via `<MedicationDetailSection>`; DrugLevelChart's standalone
  header migrated to the same shape).
- Body: `text-sm` (the new default for prose, list-item entries, dose
  values).
- Micro: `text-xs` (replacing every `text-[10px]` / `text-[11px]` on
  the page — labels, captions, the disclaimer + EMA link in Titration,
  the legend + compliance-chip labels in Scheduling).

Badge components keep their internal `text-xs` since that's the badge
primitive's own size; not part of the page's text scale.

### MedicationCardHeader extraction call

Carved as a shared primitive instead of inline duplication. Two
consumers each had ~25 lines of header chrome diverging on three
dimensions (heading composition, dose placement, icon presence); the
shared component collapsed each consumer to 10 lines and pinned the
two-line + class-label-on-line-2 contract once, not twice.

### BK-M2 — variant pick

Dashboard empty-state uses the default filled variant. Daily-briefing
empty-state was using outline. Aligned to default — empty-state
actions on a card surface read as the single primary affordance and
deserve the filled chip. The directive said "land the change ONLY on
`daily-briefing.tsx`" so the dashboard was not touched.

## Punted / nothing

No items were punted. All four bucket items are in the develop tree.

## iOS-touch

Zero. All files in this sub-pass are web-only chrome:

- `src/components/medications/medication-card.tsx`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/medications/MedicationCardHeader.tsx` (new)
- `src/components/medications/medication-detail-section.tsx`
- `src/components/medications/SideEffectsSection.tsx`
- `src/components/medications/SchedulingSection.tsx`
- `src/components/medications/TitrationSection.tsx`
- `src/components/medications/DrugLevelChart.tsx` (header chrome only)
- `src/components/medications/__tests__/medication-card-glp1.test.tsx`
- `src/components/medications/__tests__/SideEffectsSection.test.tsx`
- `src/components/insights/daily-briefing.tsx`
- `messages/{de,en,fr,es,it,pl}.json` (one key per locale)

No touch on `src/app/api/`, `prisma/`, or `src/lib/validations/`. iOS
contract on `/api/medications/[id]/intake`, the `Glp1InventoryDTO`
slot, and the side-effects route are byte-stable.

## Gates

- `pnpm typecheck` clean (after one stale `.tsbuildinfo` refresh
  caused by an adjacent contributor's missing-file reference; my own
  changes typecheck cleanly).
- `pnpm lint` clean.
- `pnpm test --run src/components/medications/` — 7 files, 68 tests
  passing.
- `pnpm test --run src/components/insights/__tests__/daily-briefing.test.tsx`
  — 18 tests passing.

## Race notes (information only — not requesting follow-up)

The autonomous parallel-contributor model raced on shared paths
(`messages/*.json`, `src/components/insights/`) more aggressively than
the kickoff's collision matrix anticipated. Concrete patterns observed:

1. Foreign contributors ran `git add -A` and swept my un-committed
   work into their commits (commits `806b3ecc` and `0e7c97c5`).
2. Foreign rebases reverted my completed edits twice (the
   SideEffectsSection F2 layout work and the daily-briefing variant
   change both required re-application).
3. The autonomous-runner test-file revert at the system-reminder
   layer required two re-applications of the test-assertion edits.

For future v1.4.x sub-passes: tighter file-ownership enforcement
(e.g. atomic locks per file before parallel dispatch) would reduce
the re-application overhead seen here.
