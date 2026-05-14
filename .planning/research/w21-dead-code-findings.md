# W21 — Dead-Code Findings — v1.4.25 RC

**Scan run**: 2026-05-14 on branch `develop` at HEAD `51f23ef3`.
**Scope**: orphan API routes, unused module exports, dead i18n keys, dead test files, dead types and enum values across `src/**`. Read-only — no code changes proposed inside this phase.
**Method**: literal/regex grep + auto-extracted template-literal prefix detection (24 dynamic prefixes auto-discovered from production code). Cross-referenced against the W10 baseline (`.planning/research/w10-dead-code-candidates.md`), the W15 380-key i18n cleanup, the W18 useInsightStatus extraction, and the W20-rest P6-10 endpoint go/no-go memo.

## Summary

| Severity | Count | Cleanup target |
| --- | --- | --- |
| Critical | 0 | — |
| High | 4 | 3 orphan user-facing endpoints + `research-mode-staleness.ts` module (loaded zero by production) |
| Medium | 8 | unused export clusters in `glp1-knowledge`, `glp1-pk`, `scheduling/{cadence,compliance}`, `side-effects/{taxonomy,validators}`, `titration/ladder`, `inventory/state-machine`, `insights/sub-page-metric`, plus ~120 dead `insights.*` and `onboarding.v2.*` i18n keys |
| Low | 5 | one-off helpers, two `@deprecated` constant duplicates, stale comment artefacts |

**Headline**: W7e cleared the W10 Cat-A list, W15 pruned 380 i18n keys, W18 extracted `useInsightStatus`, W20-rest deferred Cat-B endpoint cleanup to v1.4.26 with explicit go/no-go recommendations. After all those passes, the residue is still **148 fully-dead i18n keys, 3 user-facing orphan endpoints, 1 standalone module with zero production callers, and ~20 unused individual exports** across the W4-5 medication modules. Nothing rises to "ship-blocker" — all candidates are clean v1.4.26-cycle wins.

---

## Critical

None. No orphan endpoint exposes data or auth surface without auth gating; the three confirmed user-facing orphans (`/api/audit-log`, `/api/import`, `/api/settings/account`) all sit behind `requireAuth` and only fail the "does anyone call me?" test.

---

## High

### H1 — `/api/audit-log` (user-facing, GET) — orphan since pre-v1.4.20

Returns the current user's own audit-log entries with `limit/offset` paging. **Zero non-test consumers** anywhere in `src/`. Confirms the W20-rest deferred-decision: either wire a `/settings/audit-log` sub-page in v1.4.26 (~80 LOC paginated list) or delete the route. The OpenAPI registry does NOT list this route (only the admin variant is documented), so an iOS adapter is NOT in waiting.

- File: `src/app/api/audit-log/route.ts`
- Verification: `grep -rn "/api/audit-log\b" src --include='*.ts' --include='*.tsx' | grep -v admin/audit-log` returns no consumer.
- Recommendation: **wire** (cheap settings sub-page, audit-log is a natural privacy-affordance) OR **delete** (Marc decision; remove route + test file together).

### H2 — `/api/import` (user-facing, POST) — orphan with test coverage

Bulk-imports measurements + intakes from a JSON envelope. Tests cover it (`src/app/api/import/__tests__/`) but **no UI surface fetches it**. Looks like the deferred sibling to backup-restore that never landed. Confirms W20-rest's recommendation.

- File: `src/app/api/import/route.ts`
- Verification: zero matches for `"/api/import"` outside the route file + tests.
- Recommendation: **delete** (route + tests + the orphan client probe in `IntakeSource.IMPORT` write path stays via `/api/medications/[id]/intake/import` which is the live family) OR mark `// PLANNED` with a v1.5 reference.

### H3 — `/api/settings/account` (DELETE account) — GDPR foot-gun orphan

Doc-comment promises cascading account deletion of every record owned by the user. **No "Delete my account" UI affordance fetches it** — confirmed by `grep -rn "/api/settings/account" src/components` returning zero. This is mildly worse than a plain orphan because GDPR Article 17 plausibly requires a self-serve deletion path for the iOS launch.

- File: `src/app/api/settings/account/route.ts`
- Recommendation: **wire** a settings affordance for the v1.5 launch (one button in the danger-zone block) OR **delete** the route and document the manual admin-side process. Status quo (route exists, no UI calls it) is the worst combination — a working backdoor with no audit trail of who called it.

### H4 — `src/lib/medications/research-mode-staleness.ts` — entire module unused in production

Module exports `RESEARCH_MODE_ACK_MAX_AGE_DAYS = 90` and `isAcknowledgmentStale(ack, asOf)` but the **only** consumer is its own test file (`src/lib/medications/__tests__/research-mode-staleness.test.ts`). W19c-Safety's phase report flagged this as "deferred for wiring to UI" — the wiring still hasn't happened across Waves 1-5. Whole module + test file is currently dead weight.

- Files: `src/lib/medications/research-mode-staleness.ts` (~70 LOC), `src/lib/medications/__tests__/research-mode-staleness.test.ts` (~120 LOC tests).
- Verification: `grep -rn "research-mode-staleness\|isAcknowledgmentStale\|RESEARCH_MODE_ACK_MAX_AGE_DAYS" src` shows only self-references + test references.
- Recommendation: **wire it into the research-mode dialog** (the obvious caller — show "Your acknowledgment is N days old, please re-confirm" when stale) OR **delete the module + test** since the v1.4.23 `RESEARCH_MODE_DISCLAIMER_VERSION` version-bump path already exists in `/api/auth/me/research-mode/route.ts` and provides a cleaner re-prompt trigger.

---

## Medium

### M1 — `/api/admin/ai-settings` (GET/PUT) — orphan admin endpoint

Live admin AI surface is `/api/admin/ai-quality` (read-only). The PUT path lets the admin overwrite `AppSettings.adminAiKeyEncrypted` / model / baseUrl with no UI form to call it. Per W20-rest's recommendation: **delete**. Keeping a PUT route that rotates AI keys mid-request without an audit-friendly UI is a foot-gun.

- File: `src/app/api/admin/ai-settings/route.ts`
- Verification: `grep -rn "ai-settings\|aiSettings" src/components` returns zero.

### M2 — `/api/admin/backup/test` (singular) — duplicate of `/api/admin/backups/...`

Singular smoke-test endpoint. Live family is `/api/admin/backups/...` (plural). No admin UI button calls the singular variant. Per W20-rest: **delete**.

- File: `src/app/api/admin/backup/test/route.ts`

### M3 — `/api/admin/status-overview` — admin endpoint with zero quoted-URL consumer

No string-literal `fetch("/api/admin/status-overview")` anywhere. The admin shell uses `/api/admin/status` (suffix-less). Per W20-rest: **keep + verify inline-consumer first** — the admin React-Query layer might consume it without a quoted URL via a hook factory. Spot-check during cleanup phase before delete.

- File: `src/app/api/admin/status-overview/route.ts`

### M4 — `/api/monitoring/glitchtip/test` + `/api/monitoring/umami/test` — duplicates of admin pair

Both have admin twins (`/api/admin/monitoring/glitchtip-test`, `/api/admin/monitoring/umami-test`). The non-admin pair is the leftover. Per W20-rest: **delete the non-admin pair**. Confirmed: admin variants are reachable via `src/components/admin/reminders-section.tsx` and `src/components/admin/glitchtip-section.tsx`; the non-admin pair has zero consumers.

- Files: `src/app/api/monitoring/glitchtip/test/route.ts`, `src/app/api/monitoring/umami/test/route.ts`

### M5 — `glp1-knowledge.ts` unused exports (8 type exports + 2 constants)

Eight type aliases plus two value exports declared but never imported outside the file:

| Symbol | Kind | Production consumers |
| --- | --- | --- |
| `Glp1Route` | type alias | 0 |
| `Glp1DrugClass` | type alias | 0 |
| `Glp1Pharmacology` | type alias | 0 |
| `Glp1Storage` | type alias | 0 |
| `Glp1Pen` | type alias | 0 |
| `Glp1AdverseReactions` | type alias | 0 |
| `Glp1Indications` | type alias | 0 |
| `Glp1SourceCitations` | type alias | 0 |
| `routeForBrand` | function | 0 |
| `GLP1_DRUG_IDS` | const array | 0 |

All eight types are field types inside `Glp1DrugRecord` — the record itself IS consumed, but downstream code accesses the fields via `record.pharmacology.halfLifeHoursStart` etc. without ever importing the standalone type. **Action**: keep `Glp1DrugRecord` (consumed), drop the eight standalone aliases unless an iOS adapter is planned to ship a flatter DTO. Drop `routeForBrand` and `GLP1_DRUG_IDS` outright.

- File: `src/lib/medications/glp1-knowledge.ts`

### M6 — `glp1-pk.ts` unused exports (3 of 8 symbols)

`PkSample`, `OneCompartmentOptions`, and `ShotPhase` (alongside `shotPhaseAt`) are exported but never imported outside the file:

| Symbol | Production consumers |
| --- | --- |
| `PkSample` | 0 |
| `OneCompartmentOptions` | 0 |
| `ShotPhase` | 0 |
| `shotPhaseAt` | 0 |

`computeOneCompartment` IS consumed by `DrugLevelChart.tsx`, but the function returns inline-typed `PkSample[]` — callers never destructure into the type. The `shotPhaseAt` helper was likely planned for the W4 plateau insight but never wired. **Action**: drop the 4 unused symbols; keep `computeOneCompartment` + `DoseEvent` + `RESEARCH_MODE_DISCLAIMER_VERSION` (all consumed).

- File: `src/lib/medications/glp1-pk.ts`

### M7 — `scheduling/{cadence,compliance}.ts` unused exports (5 type aliases)

Cadence + compliance helpers landed in W4 with a wide type-export surface. Only the function returns are consumed; the standalone type aliases (`ScheduleLike`, `IntakeEventLike`, `ExpectedDose`, `PairedDose`, `ComplianceChips`) and `expandScheduleSlots` / `pairDoses` / `missedDoses` helpers have zero callers outside the module and its tests.

| Symbol | Production consumers |
| --- | --- |
| `ScheduleLike` | 0 |
| `IntakeEventLike` | 0 |
| `ExpectedDose` | 0 |
| `PairedDose` | 0 |
| `expandScheduleSlots` | 0 |
| `pairDoses` | 0 |
| `missedDoses` | 0 |
| `ComplianceChips` | 0 |

Consumed: `complianceChips`, `computeNextDose`, `buildCadenceTimeline`. All three flow through `/api/medications/[id]/cadence/route.ts` only — the rest of the surface is undriven helper machinery. **Action**: collapse internal helpers to non-exported, drop the unused type exports.

- Files: `src/lib/medications/scheduling/cadence.ts`, `src/lib/medications/scheduling/compliance.ts`

### M8 — Dead `insights.*Status*` i18n keys (per-metric loading/no-key/unavailable copy)

W18 extracted `useInsightStatus` and standardised on `insights.noProviderConfigured` as the single "API key missing" string. The pre-W18 per-metric variants were never deleted:

```
insights.weightStatusLoading        insights.weightStatusNoKey       insights.weightStatusUnavailable
insights.bmiStatusLoading           insights.bmiStatusNoKey          insights.bmiStatusUnavailable
insights.pulseStatusLoading         insights.pulseStatusNoKey        insights.pulseStatusUnavailable
insights.moodStatusLoading          insights.moodStatusNoKey         insights.moodStatusUnavailable
insights.bloodPressureStatusLoading insights.bloodPressureStatusNoKey insights.bloodPressureStatusUnavailable
insights.medicationComplianceStatusLoading
insights.medicationComplianceStatusNoKey
insights.medicationComplianceStatusUnavailable
insights.generalStatusTitle         insights.generalStatusLoading
insights.generalStatusNoKey         insights.generalStatusUnavailable
insights.generalStatusBadge.critical
```

22 keys across 6 locales = **132 dead string literals** sitting in `messages/*.json`. None resolved by any production t-call. **Action**: bulk drop in v1.4.26 alongside the rest of the i18n cleanup below.

---

## Low

### L1 — `@deprecated` constants left from Wave-1 prompt-locale split

Two `@deprecated` constants still exist in production code:

- `BASE_SYSTEM_PROMPT` (in `src/lib/ai/prompts/base-system.ts:192`) — re-exports `BASE_SYSTEM_PROMPT_DE`. Zero callers.
- `INSIGHTS_SYSTEM_PROMPT` (in `src/lib/insights/prompt.ts:101`) — re-exports `INSIGHTS_SYSTEM_PROMPT_DE`. Zero callers.

The W10 baseline flagged these as Cat-A; they survived W7e's pass because the constants only got the JSDoc deprecation but the `export const` line was retained. **Action**: drop both single-line exports. Touch-disjoint with prompt YAMLs (W19c-Safety stable surface).

Note re-checking: I see the constants are no longer in code per `grep -rn "BASE_SYSTEM_PROMPT[^_]" src` — only the per-locale `_DE`/`_EN` constants remain. **Status: already cleaned**, leaving this only as a forensic note. Comment in `hero-strip.tsx:20` and `hero-strip.test.tsx:10` still mentions `<InsightsPageHero>` by name but that component file is gone — pure paper trail.

### L2 — `side-effects/validators.ts` unused exports (5 of 7 symbols)

```
SIDE_EFFECT_CATEGORY_VALUES   — 0 consumers
SIDE_EFFECT_ENTRY_VALUES      — 0 consumers
SIDE_EFFECT_NOTES_MAX         — 0 consumers
CreateSideEffectInput         — 0 consumers (type)
ListSideEffectsInput          — 0 consumers (type)
```

Only `createSideEffectSchema` and `listSideEffectsSchema` flow into the route handler. The arrays of allowed values are unused — the zod schemas wrap them inline. **Action**: drop the unused constant arrays + type aliases. Low because they're small and the bundle impact is negligible.

- File: `src/lib/medications/side-effects/validators.ts`

### L3 — `inventory/state-machine.ts` unused exports (6 of 8 symbols)

```
DEFAULT_IN_USE_WINDOW_DAYS    — 0 consumers (used internally via default param)
InventoryItemView              — 0 consumers (type)
computeInventoryState          — 0 consumers (only test)
DecrementOutcome               — 0 consumers (type)
DecrementResult                — 0 consumers (type)
decrementDose                  — 0 consumers (only test)
```

Production paths use `consumeOneDose` from `service.ts` instead (which does its own state transition + database write). The standalone state-machine functions were likely the v1.4.x design before the service-layer refactor. **Action**: confirm `decrementDose` / `computeInventoryState` are truly orphaned (the test file shouldn't be the only consumer) before deletion.

- File: `src/lib/medications/inventory/state-machine.ts`

### L4 — `insights/sub-page-metric.ts` `isSubPageSlug` — exported but only self-typing

`isSubPageSlug(value)` type-guard never called outside its own file. The component (`insights-tab-strip.tsx`) iterates `SUB_PAGE_SLUGS` and relies on the exhaustive map at compile time. **Action**: drop the type-guard or wire it into the `params.section` validation for `/insights/[slug]/page.tsx`-style routing if Marc plans to support dynamic sub-page slugs.

- File: `src/lib/insights/sub-page-metric.ts:49`

### L5 — `insights/general-status.ts` `resolveGeneralStatusLocale` unused

`generateGeneralStatusForUser` is consumed by the reminder worker — KEEP. The sibling `resolveGeneralStatusLocale` (line 405) has zero callers (all other `*-status.ts` modules' resolve helpers are consumed by their matching route files; this one was never moved into a route because the user-facing route was deleted in W3f).

- File: `src/lib/insights/general-status.ts:405`

### L6 — `IntakeSource.IMPORT` enum value — schema-only

`IntakeSource` enum has `WEB | API | REMINDER | IMPORT` values. `IMPORT` has exactly one write-site: `/api/medications/[id]/intake/import/route.ts:86`. The plain `/api/import` (H2 candidate) also writes `IntakeSource.IMPORT` for the legacy importer. If `/api/import` is deleted per H2, then `IMPORT` becomes single-callsite and is still legitimate (the per-medication import endpoint is live). KEEP.

### L7 — Stale comment in `targets/route.ts:807`

The `// general-status}.ts` comment from the W10 baseline still has the typo `}` brace inside the path. Single-character fix, cosmetic.

- File: `src/app/api/insights/targets/route.ts:807`

---

## Inventory

### Orphan endpoints

170 route files scanned. After excluding iOS-adapter contracts (`/api/dashboard/summary`, `/api/insights/cards`, `/api/insights/correlations`, `/api/integrations/healthkit`, `/api/measurements/by-external-ids`, `/api/medications/intake-summary`) and external webhooks (`/api/internal/deploy-webhook`, `/api/withings/{callback,webhook}`, `/api/telegram/webhook`, `/api/monitoring/csp-report`, `/api/integrations/moodlog/webhook`), and confirming the 5 insight-status endpoints are consumed via `src/hooks/use-insight-status.ts`, the true orphan set is:

| Endpoint | Verdict | LOC | Recommended action |
| --- | --- | --- | --- |
| `/api/audit-log` (GET) | **H1 orphan** | ~80 | wire `/settings/audit-log` UI in v1.4.26 OR delete |
| `/api/import` (POST) | **H2 orphan** | ~150 | delete (legacy) OR mark `// PLANNED` for v1.5 restore |
| `/api/settings/account` (DELETE) | **H3 orphan** | ~60 | wire danger-zone button for v1.5 GDPR OR delete |
| `/api/admin/ai-settings` (GET/PUT) | **M1 orphan** | ~120 | delete (foot-gun rotation surface) |
| `/api/admin/backup/test` (POST) | **M2 orphan** | ~40 | delete (singular duplicate of plural family) |
| `/api/admin/status-overview` (GET) | **M3 verify-first** | ~80 | spot-check admin hook factory before delete |
| `/api/monitoring/glitchtip/test` (POST) | **M4 orphan** | ~30 | delete (admin twin is the live surface) |
| `/api/monitoring/umami/test` (POST) | **M4 orphan** | ~30 | delete (admin twin is the live surface) |

Total cleanup if all delete-or-wire decisions land: **~590 LOC** of route + test code (rough estimate; per-route includes route handler + matching `__tests__/route.test.ts`).

### Unused exports

| Module | Unused symbols | Severity |
| --- | --- | --- |
| `src/lib/medications/glp1-knowledge.ts` | 10 (8 types + 2 values) | M5 |
| `src/lib/medications/glp1-pk.ts` | 4 (`PkSample`, `OneCompartmentOptions`, `ShotPhase`, `shotPhaseAt`) | M6 |
| `src/lib/medications/scheduling/cadence.ts` | 7 (4 types + 3 helpers) | M7 |
| `src/lib/medications/scheduling/compliance.ts` | 1 (`ComplianceChips` type) | M7 |
| `src/lib/medications/research-mode-staleness.ts` | 2 (entire module) | H4 |
| `src/lib/medications/side-effects/taxonomy.ts` | 4 (4 constants + 1 type guard `isSideEffectSeverity`) | M5 |
| `src/lib/medications/side-effects/validators.ts` | 5 (3 constants + 2 type aliases) | L2 |
| `src/lib/medications/inventory/state-machine.ts` | 6 (constant + 3 types + 2 functions) | L3 |
| `src/lib/medications/titration/ladder.ts` | 2 (`DoseChangeLike`, `getLadder`) | M5 |
| `src/lib/insights/sub-page-metric.ts` | 1 (`isSubPageSlug`) | L4 |
| `src/lib/insights/general-status.ts` | 1 (`resolveGeneralStatusLocale`) | L5 |

Total individual symbols: ~43 unused exports across 11 modules. Most are type aliases that compile away — bundle impact is roughly zero. Code-clarity impact is the win: the public surface of each module shrinks to the symbols actually flowing through routes/components.

### Dead i18n keys

**148 fully-dead keys** in `messages/en.json` (and by parity, all six locales). Auto-detected 22 template-literal prefixes from production code to exclude false positives (`medications.glp1.drug.${id}.name` etc. are NOT counted as dead).

Namespace breakdown:

```
insights:      102
onboarding:     26
medications:    10
charts:          4
admin:           4
notifications:   2
```

Notable clusters:

- **Insights status copy (22 keys)** — pre-W18 per-metric variants (`weightStatusLoading/NoKey/Unavailable`, same pattern × 6 metrics + general). Superseded by `insights.noProviderConfigured`.
- **Onboarding v2 (26 keys)** — `onboarding.v2.subtitle/stepOf/back/continue/finish/skipStep/step1.*/step2.*/step3.*/doneToast/shell.*`. The v2 onboarding shell was either replaced by v3 or never shipped to production. Verify with Marc before bulk-drop.
- **Insights correlation strings (~30 keys)** — `weightBpStrong/Moderate/Weak/None`, `moodBpStrong/Moderate/Weak/None`, `moodVsBp`, `moodVsPulse`, `moodVsWeight`, `bpMedNegative/Positive/None/Count`, `notEnoughCorrelationData`, `minCorrelationData`, `notEnoughMedData`, `notEnoughMoodCorrelationData`. The W3f general-status deletion likely orphaned the correlation card prose that used these.
- **Legacy charts (4 keys)** — `charts.selectMedication`, `charts.noComplianceData`, `charts.history`, `charts.complianceDays90`. Pre-comparison-rewrite leftovers.
- **Confidence levels (3 keys)** — `insights.confidence_niedrig`, `insights.confidence_mittel`, `insights.confidence_hoch`. The German-named keys are clearly v1.3.x residue; the live keys use the English form via the per-card scope.
- **Admin feedback tabs (4 keys)** — `admin.feedback.tab{Open,Acknowledged,Resolved,Archived}`. Feedback-inbox uses different copy now.
- **Misc** — `medications.titration.weeksUnit`, `medications.deleteIntakeAriaLabel`, `medications.glp1.source.{ema,psp4}`, `medications.siteAbdomenRight/UpperLeft/UpperRight/ThighLeft/ThighRight/UpperArmLeft` (6 of 7 injection sites — likely a refactor moved them under `medications.site*` with a template-prefix and these singular keys were forgotten).
- **Apple Health enum (`APPLE_HEALTH`)** — all three Wave-5 enum additions (`MeasurementSource.APPLE_HEALTH`, `IntakeSource.IMPORT`, sleep-stage enum) have read sites in production. NOT dead.

### Dead test files

Zero `.test.ts(x)` files test deleted code. One `it.skip()` in `src/lib/i18n/__tests__/fallback-chain.test.tsx:30` is intentional (documents an unreachable fallback case guarded by the parity test). The `skipIf(!RESEARCH_AVAILABLE)` blocks in `glp1-knowledge-drift.test.ts` are environment-aware (skip on CI when the research file is absent). Both are legitimate; no triage needed.

### Dead types and enum values

- All 4 `MeasurementSource` enum values (`MANUAL/WITHINGS/IMPORT/APPLE_HEALTH`) have read sites. Apple Health Wave-5 additions all consumed.
- All 4 `IntakeSource` enum values (`WEB/API/REMINDER/IMPORT`) have write sites. `IMPORT` reachable via `/api/medications/[id]/intake/import` (live) and `/api/import` (H2 orphan — but enum stays even if route deletes).
- ~30 type aliases across W4-5 medication modules unused — listed under M5/M6/M7/L2/L3.

---

## Closing

The W21 dead-code scan finds the codebase in good shape post-W7e + W15 + W18 cleanups. Critical = 0. The high-severity items are all "decision-pending" (audit-log UI yes/no, GDPR delete-account yes/no, import yes/no, research-mode-staleness wire-or-delete) rather than active risk. Medium-severity items are the expected leftover from Wave-4 medication-module landings where the type-export surface is wider than the call surface — a normal pattern after a feature ships, not a defect.

Recommended v1.4.26 cleanup phase scope:

1. **Endpoint cleanup commit** (per W20-rest P6-10 recommendations + this report's H1-H3 + M1-M4): 8 orphan endpoints, Marc's go-ahead per endpoint, ~590 LOC removed.
2. **Unused-export sweep commit**: 43 individual exports across 11 modules, one atomic commit per module; ~200 LOC removed; bundle impact ~0 but module surface clarity is the real win.
3. **i18n bulk drop commit**: 148 fully-dead keys × 6 locales = 888 string literals removed from `messages/*.json`; the locale-parity test stays green because all 6 locales drop in the same commit.
4. **`research-mode-staleness.ts` wire-or-delete decision**: separate small commit either way.

Pre-release v1.4.25 RC: no shipping blocker. Everything above is v1.4.26 patch-cycle material.
