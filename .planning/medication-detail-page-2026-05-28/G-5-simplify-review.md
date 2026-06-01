# G-5 — v1.5.6 simplification review

Scope: `git diff d54addd6..release/v1.5.6`, RECENTLY CHANGED code only.
READ + analyze only — no commits made. Behavior-preserving suggestions.

Three workstreams reviewed: (A) medication detail-page rewrite + `advanced-settings-sheet.tsx`; (B) step-consolidation job + populator; (C) security hardening (safeFetch, avatar bounded reader, glitchtip/umami/send, ESLint plugin).

---

## High impact

### H-1 — Dead M-7 `landingIntent` / `landingStepForEdit` path in the wizard
`src/components/medications/wizard/MedicationWizardDialog.tsx:66,97,117,123,132,147`
plus `src/components/medications/wizard/wizard-payload.ts` (the `landingStepForEdit` export) and `src/components/medications/cadence-summary-row.tsx:9` (stale doc comment).

The detail-page rewrite (`page.tsx`) dropped both `wizardIntent` state and the `landingIntent` prop on every mount. Grep confirms **zero non-test, non-wizard callers** now pass `landingIntent`; the wizard always opens at Step 1. The `landingStepForEdit(hydrated, landingIntent)` branch, the `landingIntent?: "cadence" | "summary" | "name"` prop, its inclusion in `stateKey`, and the `landingStepForEdit` helper + its test are now dead per CLAUDE.md "no backwards-compat shims for hypothetical callers."

Fix: remove the `landingIntent` prop + `landingStepForEdit` import/usage from the dialog (default the initial step to Step 1 for edit mode), delete `landingStepForEdit` from `wizard-payload.ts`, fix the `cadence-summary-row.tsx:9` comment that still references `landingIntent: "cadence"`, and drop `wizard-payload.test.ts`'s `landingStepForEdit` cases.
Est. LOC delta: **-60 to -90** (helper + branch + prop + test cases).
NOTE: verify the wizard's own non-edit (`mode="new"`) callers and the `cadence-summary-row` standalone surface don't still rely on intent before deleting — if `cadence-summary-row` on the LIST page still wires an intent, scope the removal to the `"name"`/`"summary"` arms only.

### H-2 — `bucketLegacyStepRows` + `sumLegacyStepValues` duplicate the drain helpers
`src/lib/measurements/consolidate-legacy-steps.ts:` (`bucketLegacyStepRows`, `sumLegacyStepValues`)
vs. `src/lib/measurements/drain-per-sample-cumulative.ts:` (`bucketRowsByUserDay`, `sumBucketValues`).

`sumLegacyStepValues` is byte-identical to `sumBucketValues`. `bucketLegacyStepRows` differs from `bucketRowsByUserDay` only in (a) the skip-prefix constant (`STEP_DAILY_STATS_PREFIX` vs the literal `"stats:"`) and (b) returning the bare `Map` instead of `{ byDay }`. Both could collapse onto the existing exports — pass the skip-prefix as a parameter (default `"stats:"`) and read `.byDay` at the call site.

Fix: reuse `sumBucketValues` directly; parameterize `bucketRowsByUserDay(rows, tz, skipPrefix = "stats:")` and call it from the consolidation pass instead of the new copies.
Est. LOC delta: **-25 to -35** (delete two helpers + their dedicated unit tests in `consolidate-legacy-steps.test.ts` that re-cover already-tested bucketing).

---

## Medium impact

### M-1 — `wizardPayload` / `payload` double-binding in the detail page
`src/app/medications/[id]/page.tsx` (the `useMemo` `wizardPayload` + `const payload = wizardPayload as MedicationPayload`).

The page memoizes `wizardPayload: MedicationPayload | null`, then immediately re-aliases it to `payload` with an `as MedicationPayload` cast and a comment explaining the non-null narrowing. The early returns above already guarantee `medication` is defined at that point, so the memo can compute a non-null `MedicationPayload` and skip the alias+cast entirely — or just inline `snapshotToWizardPayload(medication)` once into a single const (it is now used in only two spots: `CadenceSummaryRow` and the wizard mount, both after the guard).

Fix: drop the `| null` union by computing the memo after the guard, or replace the memo+alias with one `const payload = snapshotToWizardPayload(medication)`. Removes the `as` cast and the explanatory comment.
Est. LOC delta: **-6 to -10**.
NOTE: `useMemo` was added "F-1 M-2" for object identity; a plain const recomputes per render. If the wizard remount churn was real, keep the memo but return non-null and delete only the `payload` alias + cast + comment (~ -5 LOC).

### M-2 — `CadenceSummaryRow` now receives a no-op `onEdit`
`src/app/medications/[id]/page.tsx` (`<CadenceSummaryRow ... hideEdit onEdit={() => {}} />`).

With `hideEdit` set, the row suppresses its own edit affordance, so `onEdit={() => {}}` is a dead handler kept only to satisfy a required prop. Make `onEdit` optional on `CadenceSummaryRow` (it is already gated behind `hideEdit`) and drop the empty arrow.
Est. LOC delta: **-1** in the page, clearer prop contract in `cadence-summary-row.tsx`.

### M-3 — `SettingsSection` phase-sheet branch carries two ways to open the same sheet
`src/components/medications/sections/settings-section.tsx` (`onRequestPhaseSheet ? onRequestPhaseSheet() : setPhaseSheetOpen(true)` + `{showPhases && !onRequestPhaseSheet && <PhaseConfigSheet/>}` + self-managed `phaseSheetOpen`).

The section now supports BOTH a self-hosted phase sheet (standalone surface) and a sibling-swap callback (detail-page surface). That dual mode keeps `phaseSheetOpen` state, the inline `<PhaseConfigSheet>`, and the ternary alive. Check whether the standalone surface still exists after the detail rewrite — `SettingsSection` is now only mounted via `AdvancedSettingsSheet`, which ALWAYS passes `onRequestPhaseSheet`. If there is no remaining caller without the callback, the self-managed branch (`phaseSheetOpen` state + inline `PhaseConfigSheet` + ternary fallback) is dead.
Est. LOC delta: **-10 to -18** if the standalone path is confirmed gone.
NOTE: requires confirming `SettingsSection` has no caller other than `AdvancedSettingsSheet`. If a standalone surface remains, leave as-is — the dual mode is then load-bearing.

### M-4 — `consolidate-legacy-steps.ts` dry-run branch mirrors the write branch counters
`src/lib/measurements/consolidate-legacy-steps.ts` (the `else` after `if (!dryRun)` re-deriving `dailyRowsUpserted` / `legacyRowsSoftDeleted`).

The dry-run else-branch re-increments the same totals the transaction would, duplicating the `!hadExistingTotal` and row-count logic. Since the bucket already records `legacyRowCount` and `hadExistingTotal`, the totals can be accumulated once from the bucket regardless of dry-run, and only the DB writes gated behind `if (!dryRun)`. Collapses the two counter sites into one.
Est. LOC delta: **-5 to -8**, removes a divergence risk between preview and real counts.

---

## Low impact

### L-1 — Oversized header doc-block on `step-consolidation.ts` / `consolidate-legacy-steps.ts`
`src/lib/jobs/step-consolidation.ts:1-25` and `src/lib/measurements/consolidate-legacy-steps.ts:1-45`.

Both files open with ~25-45 line narrative comments that partly restate the code immediately below (the discovery-query shape, the idempotency argument, the field-by-field upsert rationale). The architectural "why" (matches `rollup-full-backfill`, queue must be in `allQueues`, double-count avoidance) is worth keeping; the per-step numbered walkthrough that mirrors the function body is restatement. CLAUDE.md: "no comments stating the obvious."
Est. LOC delta: **-20 to -30** of comment, no behavior change. Low priority — these are accurate and the queue-registration warning is genuinely useful.

### L-2 — `runStepConsolidationForUser` silent-logger comment-only closure
`src/lib/jobs/step-consolidation.ts` (`log: () => { /* Silent ... */ }`).

The `log` sink is passed an empty arrow whose only content is a comment explaining it is silent. Since `consolidateLegacySteps` already defaults `log` to `console.log`, and the queue wants silence, pass `log: () => {}` (the comment restates the obvious) — or expose a `silent: true` option on `StepConsolidationOptions` if silence recurs. Minor.
Est. LOC delta: **-2**.

### L-3 — `BodyTooLargeError` class for a single internal throw
`src/app/api/user/avatar/route.ts` (`class BodyTooLargeError`).

A dedicated error subclass is declared but only thrown+caught within the same module against one `instanceof`. A sentinel is fine, but the class + name assignment is more ceremony than the single call site needs; a module-private `const BODY_TOO_LARGE = Symbol()` reject or a plain `Error` matched by a boolean flag would be lighter. Borderline — keep if a second size-capped route is imminent (none today; grep shows `readBoundedBody` is single-use).
Est. LOC delta: **-4 to -6** if simplified. Leave as-is if the bounded reader is slated to be shared.

### L-4 — `IntakeImportDialog` now conditionally mounted AND still takes a nullable id
`src/components/medications/sections/intake-history-preview.tsx` (`{importOpen && <IntakeImportDialog medicationId={medicationId} ... />}`).

The dialog moved from always-mounted-with-null-id to conditionally-mounted-with-real-id. Good change, but confirm `IntakeImportDialog`'s `medicationId: string | null` prop and its internal `medicationId ? ... : null` open-gate are now redundant — if this is the only caller, the prop can drop `| null` and the internal gate goes away.
Est. LOC delta: **-3 to -5** in `IntakeImportDialog`, pending caller audit.

---

## Reviewed and intentionally NOT flagged

- **safeFetch option objects** (withings/ai/glitchtip/umami/send): each call passes a distinct `init` + a small `{ requirePublicHost }` or `{ timeoutMs }` third arg. `safeFetch` already centralizes `redirect: "manual"` + `AbortSignal.timeout` defaults, so the per-call objects are NOT duplicated boilerplate — they're genuinely per-endpoint. No change.
- **`readBoundedBody`** (avatar route): single-use, no duplication; the `pipeTo`-into-counting-sink approach is the correct bounded drain. Comment is dense but load-bearing (explains the clone-in-parallel rationale). Keep.
- **ESLint `safe-fetch-required.js`**: new rule, no simplification target.
- **`dayKeyForUserTz` / `canonicalDailyTimestamp` / `PerSampleRow`**: correctly IMPORTED from `drain-per-sample-cumulative.ts`, not re-implemented. Good reuse (the only leakage is H-2's two bucket/sum copies).
- **`Europe/Berlin` tz fallback**: repeated literal in both consolidation + drain, but it's a one-liner default already established project-wide; not worth a shared const for two sites.
