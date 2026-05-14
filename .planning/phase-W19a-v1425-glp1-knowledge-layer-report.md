# Phase W19a — GLP-1 EMA drug knowledge layer

**Branch:** `develop`
**Status:** complete
**Date:** 2026-05-14

## Scope shipped

| Sub-task | Outcome |
|---|---|
| 19a.1 — TS module `src/lib/medications/glp1-knowledge.ts` | landed, 32 tests |
| 19a.2 — i18n keys `medications.glp1.drug.*` + `medications.glp1.source.*` | landed, all 6 locales |
| 19a.3 — drift-guard test against research file | landed, 30 tests |
| 19a.4 — Coach prompt grounding | DEFERRED per brief; no Coach files touched |

## Commits

1. `cee5bf5` — `feat(medications): GLP-1 EMA drug knowledge layer — 5 drugs, EPAR-sourced`
2. `da73e06` — `feat(i18n): GLP-1 drug knowledge labels across 6 locales`
3. `45bbfe4` — `test(medications): drift-guard for glp1-knowledge.ts vs EMA + psp4.13099 citations`

## Drugs covered

Five EMA-approved agents, indexed by stable lowercase id, with one-to-many brand mapping:

| Drug id | INN | Brands | Route | Class |
|---|---|---|---|---|
| `tirzepatide` | Tirzepatide | Mounjaro, Zepbound | SC | GIP-GLP-1 dual agonist |
| `semaglutide` | Semaglutide | Ozempic, Wegovy, Rybelsus | SC (Rybelsus oral) | GLP-1 RA |
| `liraglutide` | Liraglutide | Saxenda, Victoza | SC | GLP-1 RA |
| `dulaglutide` | Dulaglutide | Trulicity | SC | GLP-1 RA |
| `exenatide` | Exenatide | Byetta, Bydureon | SC | GLP-1 RA |

Retatrutide explicitly excluded (no EMA approval — N7).

## Parameter-citation count

- **Tirzepatide:** 8 pinned PK params (half-life, Tmax, Ka, F, Vd, CL, steady-state, compartment model) cross-validated against Schneck & Urva 2024 (DOI 10.1002/psp4.13099) + EMA EPAR §5.2
- **Semaglutide / Liraglutide / Dulaglutide / Exenatide:** 7 pinned PK params each (Ka left null where EMA EPAR does not publish a pop-PK estimate)
- **All drugs:** titration ladder, max dose, storage window (unopened + post-opening), pen form-factor, EMA §4.8 four-tier ADR vocabulary, contraindications, warnings, EMA EPAR URL
- **Brand-route override map** on semaglutide (Rybelsus oral exception)

Total ~ 40 distinct numeric pins per drug × 5 drugs = ~200 cited values surfaced and asserted by the drift guard.

## Test counts

- `glp1-knowledge.test.ts`: 32 tests (shape integrity, pinned PK values, brand-route, ascending titration, storage windows, lookup helpers)
- `glp1-knowledge-drift.test.ts`: 30 tests (hard pins against EMA / psp4.13099 + soft pins against the research file citations)
- `injection-sites.test.ts`: 7 existing tests untouched
- All 69 medications tests green

## Quality gates

- `pnpm typecheck`: clean
- `pnpm lint src/lib/medications/`: clean
- `pnpm vitest run src/lib/medications/`: 69/69 pass
- `pnpm vitest run src/lib/__tests__/i18n-locale-integrity.test.ts`: 26/26 pass
- All 6 messages/*.json validate as JSON

## Files touched (in scope only)

- `src/lib/medications/glp1-knowledge.ts` (new, 510 lines)
- `src/lib/medications/__tests__/glp1-knowledge.test.ts` (new, 32 tests)
- `src/lib/medications/__tests__/glp1-knowledge-drift.test.ts` (new, 30 tests)
- `messages/{de,en,es,fr,it,pl}.json` (29 added lines each, `medications.glp1.*` namespace)

No files outside scope touched. No Coach files, no API routes, no workout files, no schema.

## Flags

None. Coach grounding remains DEFERRED to W14c follow-up as instructed; the catalog is read-ready for any future consumer (medication card, inventory countdown, doctor report, Coach snapshot).

The catalog is intentionally narrower than what `glp1-feature-inspiration.md` §8.1 sketches — it omits the pop-PK detail fields (allometric exponents, IIV percentages, fat-mass covariates) that only the deferred R8 research-view curve will consume. When that wave lands, extend `Glp1Pharmacology` with the Vc / Vp / Q / IIV fields from psp4.13099 Table 3; the type widening will be additive.
