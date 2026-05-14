---
file: 10-research-pointers.md
purpose: Cross-link map to the research and review notes already in .planning/research/ — the why behind every architecturally-load-bearing decision iOS-Claude will hit.
when_to_read: When the doc-pack says "read the equivalent research note", when designing a feature that touches Apple Health / Withings / GLP-1 / Health Score / source-priority, or before tagging a v1.5.x release.
prerequisites: 00-philosophy.md (the research-first directive)
estimated_tokens: ~3500
version_anchor: v1.4.25 / sha 49f71c92
---

## TL;DR

Marc's rule from `feedback_research_before_complex_features`: research benchmarks the ecosystem before code lands. The artefacts live under `.planning/research/` and are the canonical "why" alongside the doc-pack's "what". Read the matching research note BEFORE building any architecturally-new iOS feature; reach for the W21 review notes BEFORE tagging a release.

## How to use this file

Every entry is `<file>` → `<word count>` → `<status>` → `<one-line summary>` → `<read this if you're about to>`. Status is **current** (still drives v1.4.26+) or **historical** (already absorbed into shipped code — read for context only).

```
PROJECT_ROOT/.planning/research/   ← all paths in this file are relative to here
```

## STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| Just need an API contract | `03-api-contracts.md` |
| Just need a refusal-probe shape | `08-locked-contracts.md` § 7 |
| Just need the Coach mental model | `14-coach-mental-model.md` |
| Need the v1.4.25 reconcile inventory | `.planning/phase-W21-reconcile-plan.md` (see § 4 below) |

Otherwise: continue here.

---

## § 1 — Ecosystem research (Apple Health, wearables, GLP-1)

### `apple-health-ecosystem-scan.md` — 4113 words — current

GitHub topic `apple-health` deep scan: 30 top repos by stars, license + tech + maturity per row. Catalogues the OSS landscape HealthLog could plug into (HealthGPT, react-native-healthkit, apple-health-grafana, healthkit-to-sqlite, SleepChartKit).

Read this if iOS-Claude is about to:
- Pick an iOS HealthKit binding library
- Decide whether a SwiftUI native chart or a Recharts-WebView mirror is the right call
- Evaluate licence compatibility for any OSS Apple Health adapter

### `apple-health-sync-deep-dive.md` — 4968 words — current

iOS sync patterns + clean-room teardowns. The deeper version of the ecosystem scan; covers observer-query topology, HKAnchoredObjectQuery cursoring, background-delivery quirks, and the conflict-reconciliation patterns the open-wearables and healthkit-to-sqlite projects converged on.

Read this if iOS-Claude is about to:
- Wire `HKObserverQuery` + `HKAnchoredObjectQuery` for incremental sync
- Decide between background-delivery and explicit foreground polling
- Reconcile HealthKit's "edited samples are new IDs" model with the server's externalId-based dedup

### `glp1-feature-inspiration.md` — 12071 words — current — **CRITICAL**

The single largest research artefact in the pack. EMA EPAR PDFs (Tirzepatide / Semaglutide / Liraglutide / Dulaglutide / Saxenda / Rybelsus) extracted near-verbatim; ASCPT pop-PK paper (psp4.13099) for the journal-of-record two-compartment math; clean-room teardown of the closed-source `my-glp-shot` app; **EU MDR 2017/745 + MDCG 2021-24 boundary analysis**.

Read this if iOS-Claude is about to:
- Build ANY GLP-1-touching feature (medication list, injection-site map, dose-change history, plateau detection, Research Mode chart)
- Add or modify a GLP-1 drug in the catalog
- Touch the Coach refusal logic around drug levels (GROUND RULE 9/15)
- Surface a "weight projection" or "dose escalation" UI — those CROSS the MDR threshold and are explicitly out of scope

The four do-not-builds (N1–N4 in the research) are the iOS-side's hard line: never project weight loss, never recommend escalation, never check drug-drug interactions, never import code/schema from `my-glp-shot` (no LICENSE = all rights reserved).

### `glp1-injection-tracking.md` — 4488 words — historical

The W4 first-pass research. Predecessor to `glp1-feature-inspiration.md` — covers the foundational landscape (treatmentClass enum proposal, injection-site map design, side-effect taxonomy, dose-change history schema). Mostly absorbed into shipped code by v1.4.25.

Read this if iOS-Claude is about to:
- Trace the historical reasoning behind why `treatmentClass = GLP1` exists as a separate column
- Understand the injection-site rotation algorithm

### `open-wearables-comparison.md` — 4075 words — current

Side-by-side: Apple Health vs Withings vs HealthLog. Covers data-source coverage, sync mechanics, conflict resolution, and the unique design problems each platform solves. The source for the two-axis source-priority decision.

Read this if iOS-Claude is about to:
- Design any UI that surfaces "which source provided this reading"
- Add a new metric type and need to know which sources can supply it
- Build a Settings → Sources screen

### `withings-api-coverage.md` — 4648 words — historical

Earlier Withings API audit (pre-W17). Coverage table of every Withings endpoint with what HealthLog ingested vs what it ignored. Largely absorbed; the W17 follow-up below supersedes it for activity + sleep specifics.

Read this if iOS-Claude is about to:
- Need a historical "what did Marc consider but not ship" answer for Withings

### `withings-plus-comparison.md` — 5306 words — historical

Older competitive intel on Withings+ subscription. Captures the "what does the consumer app surface that HealthLog doesn't" gaps as of the time it was written. Useful as a feature-parity reference but not actionable for v1.5.

Read this if iOS-Claude is about to:
- Pitch a feature parity argument with the Withings+ app

---

## § 2 — UX + design research

### `health-score-provenance-ux.md` — 3467 words — current

The W8e research that shaped the Health Score provenance accordion. Covers the "trust surface" reasoning, the four-component decomposition, and the `aria-labelledby` pairing pattern.

Read this if iOS-Claude is about to:
- Build a Health Score tile on iOS
- Design the per-component provenance disclosure UI

### `insights-sub-pages-ux.md` — 4961 words — current

The W4 Insights mother-page + sub-pages UX research. Apple Health vs Withings vs Oura tile patterns, hero+sub-tile composition, where the daily briefing sits.

Read this if iOS-Claude is about to:
- Build the iOS Insights surface
- Decide between a single scrollable feed and per-metric tabs
- Design the Daily Briefing tile

### `source-priority-two-axis.md` — 2742 words — current

The W8c two-axis source-priority research. Why metric × device-type is the right shape (vs flat ladder), and how the iOS Settings → Sources screen surfaces both axes.

Read this if iOS-Claude is about to:
- Build Settings → Sources on iOS
- Touch the `pickCanonicalSource()` resolver semantics in any way

### `zielwerte-redesign.md` — 5600 words — historical

The older target-zone redesign research. Mostly absorbed; surfaces the BD-Zielbereich UI thinking that ships at `/insights/zielwerte`.

Read this if iOS-Claude is about to:
- Build the iOS target-zone editor
- Understand why "Zielwerte" is a distinct page (vs nested under Settings)

---

## § 3 — Feature-specific research

### `w8d-implementation-outline.md` — 5051 words — current

Apple Health enum extensions spec. The implementation outline for the v1.4.25 W8d additions (AUDIO_EXPOSURE_ENV, AUDIO_EXPOSURE_HEADPHONE, TIME_IN_DAYLIGHT, plus the workout-batch endpoint).

Read this if iOS-Claude is about to:
- Add a new MeasurementType to the iOS side
- Wire workout ingest

### `w14b-onboarding-rebuild.md` — 3177 words — current

The onboarding wizard redesign spec. Four-step state machine, race-safe step advance, the rationale for skipping the localStorage goals shim.

Read this if iOS-Claude is about to:
- Build the iOS onboarding flow
- Touch any `/api/onboarding/*` endpoint

### `w14c-native-coach-prompts.md` — 3616 words — current

Multi-locale Coach prompt strategy. The reasoning behind native FR/ES/IT/PL prompts (vs the pre-v1.4.25 EN-with-language-footer approach), the YAML matrix structure, the parity test design.

Read this if iOS-Claude is about to:
- Modify any Coach prompt or refusal copy
- Understand why the iOS side cannot localise refusal copy itself (it MUST come from the server)

### `w16b-workout-ingest.md` — 2589 words — current

Workout batch ingest research (W16b). Covers HKWorkout shape, the 5 MB ceiling, the `endedAt < startedAt` guard, and the cross-source dedup gap deliberately left for v1.5.

Read this if iOS-Claude is about to:
- Implement workout ingest from HealthKit on iOS
- Hit a 413 from `/api/workouts/batch`

### `w16c-pr-detection.md` — 2501 words — current

PR detection research (W16c). The warm-up gate, the 6 workout slots, the silent-on-historical-backfill rule, the tie-handling logic.

Read this if iOS-Claude is about to:
- Build the PR list screen
- Wire APNs for `PERSONAL_RECORD_ACHIEVED` notifications

### `w17b-c-withings-activity-sleep.md` — 2653 words — current

Withings v2 spec (activity sync + sleep stage segments). Covers the webhook subscription channels, the OAuth scope upgrade banner, and the hourly fallback cron schedule.

Read this if iOS-Claude is about to:
- Surface the Withings scope upgrade banner on iOS
- Wire the Withings reconnect deep-link return

---

## § 4 — Pre-tag W21 review findings (current v1.4.25 state)

The 8-reviewer parallel pass that ran before the v1.4.25 release-merge. Each finding file is the unfiltered output of one reviewer; the consolidated reconcile plan is the canonical "what's still pending in v1.4.26".

### `w21-code-review-findings.md` — 2340 words

Audited: bug-spotting across the v1.4.25 diff. Caught the `endedAt < startedAt` workout-gate gap, the inventory state-machine bypass, and several quiet edge cases.

Still pending in v1.4.26:
- Light-severity items deferred per the rubric (see reconcile plan)
- Refactor recommendations tagged as M-low priority

### `w21-security-findings.md` — 2358 words

Audited: secret leaks, auth boundary, injection vectors. Caught the critical Withings webhook secret-in-logs leak (Fix-J in the reconcile) + the GLP-1 endpoint missing Zod/audit/rate-limit (Fix-K).

Still pending in v1.4.26:
- Medium-severity dependency upgrade recommendations
- Long-term auth-token rotation policy review

### `w21-design-findings.md` — 2023 words

Audited: touch targets ≥ 44×44 px, palette consistency, contrast WCAG-AA. Caught onboarding wizard buttons below floor, range-bar palette drift, PR-badge dark-mode contrast.

Still pending in v1.4.26:
- Low-severity visual polish items (already documented as deferred)

### `w21-senior-dev-findings.md` — 2466 words

Audited: architecture + future-proofing. Flagged the `withRateLimit` positional-args drift (now option-bag), the `safeRequestProp` narrow-catch surface, several abstraction-needed surfaces.

Still pending in v1.4.26:
- Module boundary cleanup recommendations
- Test infrastructure improvements

### `w21-simplifier-findings.md` — 3340 words

Audited: dead code, redundant abstractions. Caught the `goalsStorageKey` orphaned export + the `GoalsChipPicker` localStorage block with no consumer.

Still pending in v1.4.26:
- Lower-priority dead-code removals deferred to next cleanup pass

### `w21-product-lead-assessment.md` — 3394 words

Audited: user-facing acceptance, copy quality, flow polish. Caught medication history page hard-coded "Zurück" back-button (now `t()`-routed), several copy polish items.

Still pending in v1.4.26:
- Copy-tone refinements scoped as Low
- UX flow simplifications scoped as Medium-defer

### `w21-i18n-runtime-findings.md` — 2624 words

Audited: hard-coded strings, locale-bundle parity. Caught the medication history "Zurück" leak + several runtime-translatable-but-static strings.

Still pending in v1.4.26:
- Long-tail copy that survives in admin-only surfaces
- Locale-pluralisation edge cases for non-DE/EN

### `w21-dead-code-findings.md` — 2841 words

Audited: unused exports, unreferenced files. Caught the same `goalsStorageKey` issue (cross-referenced with simplifier), plus older onboarding-spec leftovers.

Still pending in v1.4.26:
- Confirmed-dead items waiting for the v1.4.26 cleanup pass

---

## § 5 — Older review findings (W10 baseline)

Historical context — the pre-v1.4.20 review pass that established the W21-style 8-reviewer pattern.

| File | Words | Audited |
| --- | --- | --- |
| `w10-code-review-findings.md` | 1990 | First-pass bug audit |
| `w10-security-review-findings.md` | 1465 | First-pass security audit |
| `w10-design-review-findings.md` | 1521 | First-pass design audit |
| `w10-senior-dev-findings.md` | 1974 | First-pass architecture audit |
| `w10-simplifier-findings.md` | 1873 | First-pass simplification audit |
| `w10-product-lead-assessment.md` | 2592 | First-pass UX audit |
| `w10-i18n-runtime-gaps.md` | 1949 | i18n runtime probe baseline |
| `w10-dead-code-candidates.md` | 2124 | Dead-code baseline |
| `w10-reconcile-A-design-report.md` | 973 | Reconcile fix-out for design |
| `w10-reconcile-B-architecture-report.md` | 991 | Reconcile fix-out for architecture |
| `w10-reconcile-C-security-auth-report.md` | 715 | Reconcile fix-out for security/auth |
| `w10-reconcile-D-simplifier-report.md` | 479 | Reconcile fix-out for simplifier |

These are historical — every must-fix item from the W10 pass landed across v1.4.20-v1.4.24. Read only when investigating the historical reasoning behind a v1.4.20-v1.4.24 change.

---

## § 6 — The W21 reconcile plan

### `.planning/phase-W21-reconcile-plan.md` — outside `research/`

The canonical post-W21 reconcile inventory + the 7-Fix-* surface map. Collates 103 findings (2 Critical + 20 High + 41 Medium + 40 Low) from the 8 reviewers into 7 touch-disjoint Fix-* surfaces totalling ~22 commits.

The 7 Fix-* surfaces (each touch-disjoint):

| Surface | Scope | Severity |
| --- | --- | --- |
| **Fix-J** | Withings webhook log redaction (`src/lib/logging/`) | Critical |
| **Fix-K** | GLP-1 endpoint hardening + legacy webhook EOL counter | High |
| **Fix-L** | Design polish (touch targets, palette, contrast, dialog footer, native selects, back-button i18n) | High + Medium |
| **Fix-M** | Inventory state-machine + workout schema gate | Medium |
| **Fix-N** | `withRateLimit` option-bag standardisation + helper extraction | Medium |
| **Fix-O** | Audit-log retention + geo enrichment cleanup | Medium |
| **Fix-P** | Dead-code sweep + simplifier follow-ups | Medium |

**iOS-Claude implication**: every item in the reconcile plan that touches a contract is already documented in `08-locked-contracts.md`. The reconcile plan itself is internal-only — never published. Read it BEFORE tagging v1.5.x to understand what v1.4.26 will likely close.

---

## § 7 — Research-first directive (the meta rule)

Marc-memory `feedback_research_before_complex_features`:

> AI / insights / chart work runs through a research agent first. The agent benchmarks Apple Health / Withings / Oura, proposes an ecosystem-fit plan, then the implementation phase starts.

For iOS-Claude this means: before any of these touches code, a `.planning/research/` note must exist:

- New Coach surface or refusal change
- New Insight type or sub-page
- New chart family (sparkline, range bar, scatter, etc.)
- New ingest source (e.g. Garmin, Fitbit, Strava)
- New medical-adjacent feature (anything PK / dose / drug-interaction / projection)

If the relevant note doesn't exist, file one before writing the iOS code. The research-first rule is the single most reliable predictor of which v1.X.Y features ship cleanly and which need an emergency follow-up patch.

---

## § 8 — How to write a new research note

Format convention (mirrors the existing notes):

```markdown
# <Feature> Research — v1.5.X

**Scope.** One sentence on what's in / what's out.
**Read-only.** No code commits, no schema commits.
**Date.** YYYY-MM-DD
**Author.** Marc Bombeck

## TL;DR
<2-3 sentence summary of the recommendation>

## Section 1 — Ecosystem inventory
<table of 10-30 comparable projects with stars / license / tech / one-liner>

## Section 2 — Clinical / regulatory foundation (when relevant)
<EMA EPAR / FDA / WHO / MDR references with direct PDF links>

## Section 3 — App teardowns
<closed-source app analysis, screenshots, feature lists>

## Section 4 — Boundary analysis (when relevant)
<EU MDR / GDPR / accessibility line-not-to-cross>

## Section 5 — Implementation outline
<schema sketches, route sketches, NOT prescriptive code>

## Section 6 — Recommendations
<3-5 numbered recommendations the Marathon can dispatch from>

## Section 7 — Do-not-builds
<explicit list of features that violate boundaries; cite the source>
```

Word-count target: 2000-5000 for a single-feature note, up to 12000 for a multi-feature deep-dive (like `glp1-feature-inspiration.md`).

---

## § 9 — STOP HERE if…

| If your task is… | …skip the rest and read… |
| --- | --- |
| Just need a contract refresher | `08-locked-contracts.md` |
| Just need the Coach pipeline | `14-coach-mental-model.md` |
| Just need to call an endpoint | `03-api-contracts.md` |
| Tagging v1.5.x | `09-recommended-flow.md` § 4 (marathon-pattern handoff) + `09-recommended-flow.md` § 5 (Quality Gate) |

Otherwise: you have read every file in the v1.5 iOS handoff doc-pack. Marc UAT awaits.
