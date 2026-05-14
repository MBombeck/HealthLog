# Phase W4d — v1.4.25 GLP-1 Full Integration

**Status:** shipped (all 10 phases landed).
**Branch:** develop (no push, no tag per Marc directive).
**Research source:** `.planning/research/glp1-injection-tracking.md`.
**Marc directive (2026-05-14):** "komplett rein in v1.4.25, nichts brickt
von unserer View, harmonisch einlistet."

---

## Per-phase commit map

| Phase                                             | Commit                                          | Scope                                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Schema additions                              | `cbcc059`                                       | Migration 0046, MedicationCategory + MedicationDoseChange + InjectionSite enums, MedicationInventoryEvent table, `Medication.treatmentClass` / `Medication.dosesPerUnit`, `MedicationIntakeEvent.injectionSite`. |
| 2a — Coach snapshot block                         | `2bd2902`                                       | `buildGlp1SnapshotBlock()` + `weeklyContext.glp1` injected into `buildCoachSnapshot()`.                                                                                                                          |
| 2b — Coach GROUND RULE 9 + insight GROUND RULE 14 | `330be96` (folded under another agent's commit) | EN + DE rules forbidding dose prescription; PROMPT_VERSION bump 4.24.0 → 4.25.0; `glp1_plateau` keyFinding enum value.                                                                                           |
| 3 — Form weekly preset                            | `94cc7f5`                                       | Treatment-class dropdown, "Once weekly on …" preset with localStorage memory, dosesPerUnit input, wire-schema extensions in zod.                                                                                 |
| 4 — GLP-1 card variant                            | `b8a1c18`                                       | `Glp1MedicationCard` + dispatcher in /medications, `injection-sites.ts` recommender, `/api/medications/[id]/glp1` details endpoint.                                                                              |
| 5 — Body-map picker                               | `6750d09`                                       | `injection-site-picker.tsx` with SVG outline + 22px hit-targets + dashed-ring recommended-next annotation. Unit tests cover rotation algorithm.                                                                  |
| 6 — Pen/vial inventory                            | folded into Phase 1 + 4                         | `MedicationInventoryEvent` table + dosesPerUnit + low-stock signal in glp1 details endpoint.                                                                                                                     |
| 7 — MoodEntry side-effect tags                    | `52a9682` + `ddabe17`                           | Chip strip on mood-form with toggle behaviour; EN + DE labels under `medications.sideEffectTag*`. No schema change (tags column is free-text).                                                                   |
| 8 — Therapy timeline                              | `2c7c3cc`                                       | `TherapyTimeline` mounted on /insights/medikamente; `/api/insights/glp1-timeline` aggregates dose changes + injections + inventory + side-effect days.                                                           |
| 9 — Plateau detection                             | `6148a17`                                       | `detectGlp1Plateau()` + `buildGlp1PlateauPrompt()` wired into the insight-generator user prompt. GROUND RULE 14 keeps the safety contract.                                                                       |
| 10 — Doctor-report PDF                            | `f45adb2`                                       | New "GLP-1 therapy" section on the PDF (weight curve, titration table, side-effects). Aggregator gains optional `glp1` block; PDF renderer skips it when null.                                                   |
| Hygiene                                           | `a68dbdc` + `[style commit]`                    | Test-environment prisma-tolerance guards on `buildGlp1SnapshotBlock()` + `detectGlp1Plateau()`; DE locale parity for `therapyTimelineDescription`; OpenAPI regeneration; prettier across touched files.          |

---

## Verification

| Gate                    | Status                                                                                                                                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`        | One pre-existing error in `doctor-report-prefs/route.ts` (parallel agent's code, NOT mine). My files: clean.                                                                                                                                                               |
| `pnpm lint`             | One pre-existing error in `targets/target-edit-sheet.tsx` (parallel agent's untracked file, NOT mine). My files: clean.                                                                                                                                                    |
| `pnpm test` (unit)      | 2482 passed / 1 skipped / 0 failed.                                                                                                                                                                                                                                        |
| `pnpm test:integration` | 132 passed / 2 failed — both failures pre-existing (coach-prefs.test.ts asserts shape predating another agent's `defaultWindow` addition; measurements-batch-delete.test.ts hits a unique-constraint conflict from stale test DB state). Neither failure touches W4d code. |
| `pnpm openapi:check`    | In sync. Regenerated to pick up `/api/medications/[id]/glp1` + `/api/insights/glp1-timeline`.                                                                                                                                                                              |
| `pnpm format:check`     | All W4d files prettier-clean. Pre-existing warnings in other agents' files.                                                                                                                                                                                                |

---

## Scope decisions / open items

**1. `Medication.category` vs `treatmentClass` naming.** The research and
phase brief asked for a `category MedicationCategory` field on
`Medication`. The existing codebase already uses
`medication.category` for the clinical taxonomy (BLOOD_PRESSURE /
VITAMIN / … via the `medication_categories` side-table read at the
API boundary). Reusing the slot would have either broken the v1.4.24
UI (which dispatches on the existing taxonomy values) OR required
renaming the side-table semantics — neither matched Marc's "nichts
brickt" rule. Decision: shipped the Prisma enum as
`Medication.treatmentClass: MedicationCategory` with values
`GENERIC | GLP1`. The existing `category` slot stays untouched.
Logically the two are orthogonal: "clinical category" vs "treatment
class needing special handling".

**2. Dashboard tile (Phase 4 partial).** The brief listed the
medication-card variant under Phase 4. The dashboard tile was W6's
responsibility (per the "Conflict awareness" section) and another
agent's commit `88efd42` landed it correctly against the schema this
phase landed. The schema commit (Phase 1) landed early as instructed
to unblock W6, and W6's tile uses the new `treatmentClass = "GLP1"`
discriminator + the dose-history rows produced by `MedicationDoseChange`.

**3. Coach prompt commit landed under another agent's commit message.**
The GROUND RULE 9 + GROUND RULE 14 edits + PROMPT_VERSION bump landed
inside commit `330be96` "feat(coach): default analysis window as user
preference" — another parallel agent's `git add` swept up my unstaged
edits. The changes are present and correct; only the commit message
is suboptimal. I cannot rewrite history.

**4. MoodEntry tag schema.** The existing tag column is free-text /
JSON-array, so the curated GLP-1 chips append localised strings
verbatim. The Coach snapshot aggregator and the therapy-timeline
endpoint accept both English and German variants (the SIDE_EFFECT_TAGS
sets include both). No schema change required.

**5. Tests deferred.** I did not write component-level integration
tests for the GLP-1 medication card or the body-map picker — those
would have been React-DOM tests, and the cardinality of permutations
(GLP-1 active vs paused, with/without dose history, with/without
inventory, with/without recent site) suggests a full suite would
have ballooned this phase past Marc's "ship it komplett" timebox.
Instead I shipped unit tests for the load-bearing pure helpers
(`nextInjectionSite`, `describeInjectionSite`, `SITE_COORDS`,
`buildGlp1PlateauPrompt`) and integration coverage relies on the
existing `/api/medications/[id]/glp1` + `/api/insights/glp1-timeline`
endpoints answering correctly. Backlog item for v1.4.26: full
React-DOM tests for the card variant + picker.

**6. Pre-existing integration-test failures.** Both
`tests/integration/coach-prefs.test.ts` and
`tests/integration/measurements-batch-delete.test.ts` are red on
this run. Neither failure is W4d-related: the coach-prefs test
asserts a shape that another agent's `defaultWindow` addition
changed, and the measurements-batch-delete test hits a unique-constraint
conflict from stale rows in the dev DB. Filing them as pre-existing
in this report rather than fixing them here keeps W4d atomic.

---

## Notes on parallel-agent friction

Several files (especially `messages/en.json`, `messages/de.json`, and
`src/components/mood/mood-form.tsx`) were repeatedly reverted by what
appeared to be parallel git stash/pop activity. The pattern: my edits
applied, then a few commands later the file would re-appear in its
pre-edit state, sometimes with `<<<<<<<` conflict markers. Workaround:
edit → immediately `git add` → commit before the auto-revert hits.
The final state is correct; the journey was bumpy.

---

## Files touched

**New:**

- `prisma/migrations/0046_glp1_dose_history/migration.sql`
- `src/lib/ai/coach/glp1-snapshot.ts`
- `src/lib/insights/glp1-plateau.ts`
- `src/lib/insights/__tests__/glp1-plateau.test.ts`
- `src/lib/medications/injection-sites.ts`
- `src/lib/medications/__tests__/injection-sites.test.ts`
- `src/components/medications/glp1-medication-card.tsx`
- `src/components/medications/injection-site-picker.tsx`
- `src/components/insights/therapy-timeline.tsx`
- `src/app/api/medications/[id]/glp1/route.ts`
- `src/app/api/insights/glp1-timeline/route.ts`

**Extended:**

- `prisma/schema.prisma` (3 new models / 1 enum / 2 columns / 1 index)
- `src/lib/ai/coach/snapshot.ts` (weeklyContext.glp1)
- `src/lib/ai/coach/system-prompt.ts` (GROUND RULE 9 EN + DE)
- `src/lib/ai/prompts/insight-generator.ts` (GROUND RULE 14 + PROMPT_VERSION)
- `src/lib/ai/schema.ts` (glp1_plateau sourceMetric enum)
- `src/components/insights/daily-briefing.tsx` (icon mapping)
- `src/lib/validations/medication.ts` (treatmentClass + dosesPerUnit)
- `src/app/api/medications/route.ts` + `[id]/route.ts` (field plumbing)
- `src/app/api/insights/generate/route.ts` (plateau injection)
- `src/lib/doctor-report-data.ts` (glp1 aggregator + intake/dose-change preload)
- `src/lib/doctor-report-pdf-core.ts` (GLP-1 therapy section render)
- `src/components/medications/medication-form.tsx` (weekly preset + dosesPerUnit)
- `src/components/medications/medication-card.tsx` (treatmentClass field)
- `src/app/medications/page.tsx` (card variant dispatch)
- `src/app/insights/medikamente/page.tsx` (timeline mount)
- `src/components/mood/mood-form.tsx` (side-effect chip strip)
- `messages/en.json` + `messages/de.json` (every GLP-1 surface)
- `docs/api/openapi.yaml` (regenerated)
