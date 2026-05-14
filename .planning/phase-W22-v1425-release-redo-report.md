# W22 — v1.4.25 Release Redo (CHANGELOG expand + PR Ready)

**Status**: complete
**Branch**: `develop`
**Commit (CHANGELOG)**: `49f71c9` — `chore(release): expand v1.4.25 with Wave 4-5 and reconcile features`
**Commit (phase report)**: appended after this file lands
**PR #168**: Draft → Ready-for-review (transitioned via `gh pr ready 168`)

## Scope

Editorial-only task. No production code edits. Closes the three product-lead findings that gated the v1.4.25 tag:

1. **C1** — `CHANGELOG.md` was frozen at `cb07d5c` (W11 release-prep) and omitted ~90 commits of Wave-4 + Wave-5 + reconcile work.
2. **H1** — Test-count footer read `2244 → 2652` unit / `140 → 174` integration, both stale by a wide margin.
3. **H2** — `Deferred to v1.4.26` section still listed items already shipped (OpenAPI hard-flip, onboarding rebuild, native FR/ES/IT/PL Coach prompts, PR detection worker, workout ingest, Withings Activity, Withings Sleep v2, 414 dead i18n keys).

## Deliverables

### Commit 1 — CHANGELOG expand (`49f71c9`)

**Diffstat**: 1 file changed, 468 insertions, 96 deletions.

Headline rewrite captures the shipped scope across the v1.4.x line:

- Insights → seven dedicated metric routes
- GLP-1 end-to-end (10 surfaces: injection picker, dashboard tile, weight-chart markers, therapy timeline, plateau detection, drug-level chart with Research Mode gate, EMA drug knowledge, EMA titration ladder, cadence + compliance, side-effect taxonomy, pen-and-vial inventory + 30-day clock, doctor-report section)
- Cross-source priority two-axis resolver + per-user Settings surface
- Per-user timezone threaded through ten surfaces
- Withings: twelve new measurement types + BP/temperature webhooks + Activity + Sleep v2 syncs
- Onboarding rebuilt as nested-route wizard with welcome carousel, goals chips, source grid, baseline form, welcome-back banner
- Personal Records: detection worker + push opt-in + metric trend badge
- Health Score per-component provenance accordion
- Coach native first-party prompts across six locales with 1800+ refusal-probe assertions
- OpenAPI drift-gate hard-fail flip
- Multi-arch Docker image
- Migrations 0043 → 0060 (9 new + 1 hardening)
- `PROMPT_VERSION` 4.24.0 → 4.25.0 with GROUND RULE 9 (dose recommendations refusal) + GROUND RULE 15 (drug-level estimate refusal with MDR + MDCG 2021-24 cites)

**Marc-Voice gates passed**:

- Zero `claude` / `agent` / `marathon` / `subagent` / `session` hits
- Zero `wave` / `phase` user-facing hits (only route paths `phase-config` and `ai-settings` survive; those are file identifiers, not narrative)
- Zero PII (Marc's name, health figures, BD-Zielbereich values, measurement counts)
- Locale framing rewritten per product-lead-M5: FR/ES/IT/PL described as "first-party translation bundles with community-maintainable banner" + "structural refusal-probe coverage in CI" rather than "AI-translated" or "AI-drafted"
- Research Mode + drug-level chart framed as **display only** with the **EU MDR 2017/745** boundary explicit in both Added and Security
- "AI Coach" / "AI provider" / "AI prose" all replaced with the neutral framing
- English, terse, technical

**Test footer updated**:

- 2244 → 3828 unit tests across 344 files
- 140 → ~170 integration across 11 files
- Refusal-probe matrix: 1800+ assertions × 15 GROUND RULES × 6 locales × 20+ paraphrasings
- 9 new migrations (0051-0059) + 1 hardening (0060)

**Deferred-to-v1.4.26 section rewritten**:

Out: OpenAPI hard-flip (W14a shipped), onboarding rebuild (W14b shipped), native FR/ES/IT/PL Coach prompts (W14c shipped), PR detection worker (W16c shipped), workout ingest (W16b shipped), Withings Activity (W17b shipped), Withings Sleep v2 (W17c shipped), 414 dead i18n keys (W15 shipped 380 of the 528 candidates).

In: `User.onboardingGoals` column; `advance()` hook extraction; `glp1-pk.ts` unused-export decision; seven orphan endpoint go/no-go decisions; ~148 dead i18n keys second-pass; FR/ES/IT/PL prose hand-review; Coach `lastYear` + row-tap polish; sleep stacked-column visual polish; mood verbal labels persistence; drug-level chart-side 90-day staleness wiring (defence-in-depth — the version-bump path and GROUND RULE 15 cover the contract); iOS-18 long-tail HK mappings; VO2 chart-row card; lazy-loaded locale bundles.

### Commit 2 — PR #168 Draft → Ready

`gh pr ready 168` transitioned the long-lived release PR from Draft to Ready-for-review. Verified via `gh pr view 168 --json isDraft`.

Comment posted summarising:

- Net commits since v1.4.24
- Test count delta
- Critical W21 finding shipped (Withings webhook secret redaction)
- Reconcile rubric outcome
- Ready for Marc UAT — tag after approval

### Commit 3 — This phase report

`docs(planning): W22 release-redo phase report`.

## Findings closed

| Finding | Severity | Status | Evidence |
|---|---|---|---|
| product-lead C-1 | Critical | Closed | `49f71c9` rewrites the `## [1.4.25]` section to reflect the ~90 Wave-4-5-reconcile commits |
| product-lead H-1 | High | Closed | Test footer updated to 3828 unit / 344 files / ~170 integration / 1800+ refusal-probe assertions |
| product-lead H-2 | High | Closed | `Deferred to v1.4.26` rewritten — already-shipped items moved into Added/Changed/Fixed/Security/Refactor |
| product-lead M-5 | Medium | Closed | FR/ES/IT/PL Coach prompts framed as native first-party bodies with maintainership banner, no "AI-drafted" wording |
| product-lead L-1 | Low | Closed | Headline narrative removed "AI-translated" framing |

## Caveats

- `package.json` version stays `1.4.25` (already correct from W11). No tag was created. No push to `main`. Marc tags after UAT.
- The CHANGELOG cites `EU MDR 2017/745` + `MDCG 2021-24` for GROUND RULE 15 — same wording as the in-app dialog so the public release note and the user-facing surface speak the same language.
- One pre-existing skipped unit test carries through (not introduced this release); footer notes it.
- Carryover detail: a small number of Wave-4-5 refactor items live under `Refactor / Hygiene` rather than `Refactor` to reflect the brief's preferred header; section name updated from `### Refactor` to `### Refactor / Hygiene`.

## Headline

**v1.4.25 ready for Marc UAT.**
