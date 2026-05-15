---
file: .planning/research/v1427-r4-dead-code.md
slot: R4
purpose: v1.4.27 dead-code scan — orphan routes, unused exports, dead i18n keys, stale comments, deferred @deprecated markers, unused React props
predecessor: .planning/research/w10-dead-code-candidates.md (v1.4.25 baseline)
companion: .planning/round-3-b7-symmetry-cleanup-report.md (B7 sweep landed `f72d2de2` + `d10e0f28`)
baseline: develop @ 617d4518
mode: read-only
target_tag: v1.4.27
---

# R4 — dead-code scan for v1.4.27

Most of the W10-era surface is gone. The B7 sweep (commits `2960f735`, `3a7599c8`, `f72d2de2`, `5cb29317`, `5deed3f9`) cleared the 414 dead i18n keys, the two `@deprecated` prompt-constant exports, the `__testables.WEEKDAY_KEYS` block, the `general-status` route residue, the `/api/audit-log` orphan, and ten `glp1-knowledge`/`glp1-pk`/`cadence` exports. Re-running every W10 probe at `617d4518` returns:

- `@deprecated` markers in `src/`: **0** (was 3)
- Dead i18n keys (template-prefix-aware, six locales): **0** (was 414)
- ESLint warnings + errors: **0** (clean run)
- `InsightsPageHero` / `BASE_SYSTEM_PROMPT` / `INSIGHTS_SYSTEM_PROMPT` / `IntakeTimeline` / `ComplianceCharts` / `queryKeys.insightsGeneralStatus`: **all gone**

What remains is residue — fourteen orphan exported functions/consts, the five README-tied admin/monitoring routes that B7 deliberately deferred to v1.4.28, one unused React prop, two cosmetic stale comments, and a stale Vitest mock. Most findings are Low severity; the Medium-tier entries are decisions, not bugs.

## Summary

| Severity | Items | Decision required |
|---|---|---|
| Medium | **5** | Per-endpoint maintainer call (already framed in v1.4.28 backlog) |
| Low | **17** | Drop-or-keep per item; one or two lines each |
| Informational | **4** | Pre-existing state confirmed; no action |

---

## Section 1 — orphan API routes

### 1.1 Five README-tied admin/monitoring endpoints — Medium (deferred to v1.4.28)

All five endpoints from the W10 Cat-B sweep remain orphan in source. R3 did NOT add a consumer for any of them. They survive only because the B7 fix-plan rule "a README mention counts as a consumer" parked the decision in v1.4.28 (`b7` commit `3a7599c8`, line 8 of the seed file at `.planning/v1428-backlog.md`).

Re-verified at `617d4518` — `grep -rn '<route>' src/components/ src/hooks/ src/app/` returns zero non-self hits for each:

| Endpoint | File | src callers | tests | README | CHANGELOG | Status |
|---|---|---|---|---|---|---|
| `/api/admin/ai-settings` | `src/app/api/admin/ai-settings/route.ts` | 0 | 0 | L362–363 | L752, L3261 | unchanged from W10 |
| `/api/admin/backup/test` | `src/app/api/admin/backup/test/route.ts` | 0 | 0 | L368 | L752 | unchanged from W10 |
| `/api/admin/status-overview` | `src/app/api/admin/status-overview/route.ts` | 0 | self-tests | L367 | L753 | unchanged from W10 (only ref is a comment in `/api/admin/backups/route.ts:63`) |
| `/api/monitoring/glitchtip/test` | `src/app/api/monitoring/glitchtip/test/route.ts` | 0 | self-tests | L381 | — | unchanged from W10 |
| `/api/monitoring/umami/test` | `src/app/api/monitoring/umami/test/route.ts` | 0 | self-tests | L382 | — | unchanged from W10 |

**Action:** none in v1.4.27. Per-endpoint maintainer call queued in v1.4.28. The v1.4.28 backlog entry frames each option (wire-a-consumer vs delete-route-plus-README-line).

### 1.2 W10 Cat-B1 iOS adapter routes — Informational (KEEP)

Re-verified clean — every endpoint in this set has a doc comment naming its iOS surface and is intentionally web-orphan ahead of v1.5. The R3c mobile audit suite (`v1427-r3c-mobile-*.md`) treats them as load-bearing.

```
/api/dashboard/summary          # "Aggregator endpoint for the iOS DashboardSummary view"
/api/insights/cards             # "iOS adapter over /api/insights/comprehensive"
/api/insights/correlations      # iOS placeholder
/api/integrations/healthkit     # HealthKit integration config
/api/measurements/by-external-ids   # iOS deletion reconciliation
/api/medications/intake-summary # iOS day-key aggregator
```

**Action: KEEP.** No change for v1.4.27.

### 1.3 External-caller webhooks — Informational (KEEP)

`/api/internal/deploy-webhook`, `/api/monitoring/csp-report`, `/api/withings/{callback,webhook}`, `/api/telegram/webhook`, `/api/integrations/moodlog/webhook` — all confirmed external callers. **KEEP.**

---

## Section 2 — orphan exported functions and consts

A blob scan across every `*.ts` / `*.tsx` in `src/` (incl. `__tests__/`) plus `scripts/` returned **14 exported functions / consts with zero consumers anywhere**. None overlap with the lib paths the prompt called out (`src/lib/medications/`, `src/lib/insights/`, `src/lib/ai/coach/`) for the heavy hitters — those three areas are clean after B7's `f72d2de2`. The list below crosses other lib surfaces.

| # | Symbol | File | Severity | Notes |
|---|---|---|---|---|
| 2.1 | `countMessages` | `src/lib/ai/coach/persistence.ts:324` | **Low** | Companion of `listConversations` / `fetchConversationWithMessages`; never consumed. Drop or keep as future-surface. |
| 2.2 | `buildGeneratePrompts` | `src/lib/ai/prompts/general-status.ts:76` | **Low** | Live consumer was `/api/insights/general-status` (deleted W3f `edae5696`); module's other exports still serve `general-status.ts` lib helper. This one is orphan residue. |
| 2.3 | `_resetSafetyContractsCacheForTests` | `src/lib/ai/prompts/safety-contracts.ts:191` | **Low** | Leading underscore + `ForTests` suffix promises a test consumer that never landed. Cache is module-private; the helper is dead. |
| 2.4 | `forEachLocaleAndRule` | `src/lib/ai/prompts/safety-contracts.ts:221` | **Low** | Higher-order helper exposed alongside the matrix loader. Zero callers in src/ or scripts/. |
| 2.5 | `getPulseRange` | `src/lib/analytics/classifications.ts:311` | **Low** | Sibling of `getBpRange` / `getWeightRange` (consumed). `getPulseRange` was added but never wired. |
| 2.6 | `trendLinePoints` | `src/lib/analytics/trends.ts:113` | **Low** | Public helper next to `summarize` (heavily consumed). The line-points helper has no caller. |
| 2.7 | `CHART_MINI_HEIGHT_PX` | `src/lib/charts/constants.ts:24` | **Low** | Companion to `CHART_DEFAULT_HEIGHT_PX` (consumed). The mini variant never landed in a chart. |
| 2.8 | `formatDateWithWeekday` | `src/lib/format.ts:65` | **Low** | Next to `formatDate`, `formatDateTime`, etc. — all consumed. This one is the leftover from the dropped weekly-report weekday chip. |
| 2.9 | `resolveGeneralStatusLocale` | `src/lib/insights/general-status.ts:406` | **Low** | The W3f route deletion took the only consumer. Other locale resolvers in the same file family (`resolveBmiStatusLocale`, etc.) ARE consumed. |
| 2.10 | `isSubPageSlug` | `src/lib/insights/sub-page-metric.ts:49` | **Low** | Type guard; `SUB_PAGE_SLUGS` is consumed externally but the guard itself isn't. |
| 2.11 | `recordHeartbeat` | `src/lib/jobs/worker-status.ts:47` | **Low** | Worker-status surface; the heartbeat write helper has no caller. The reader half (`fetchWorkerStatus`) IS consumed. |
| 2.12 | `EVENT_TYPE_LABELS` | `src/lib/notifications/types.ts:23` | **Low** | Labels record for notification types; never consumed at any UI / route surface (likely superseded by i18n key resolution). |
| 2.13 | `cleanupExpiredRateLimits` | `src/lib/rate-limit.ts:57` | **Low** | Janitor for the `rate_limit` table; no cron / worker calls it. Either wire to a scheduled job or drop. |
| 2.14 | `sleepStageEnum` | `src/lib/validations/measurement.ts:44` | **Low** | Standalone zod enum; consumers reference the parent `createMeasurementSchema` instead. Internal use only would suffice — drop the `export` keyword. |

**Action:** Single-commit sweep. Either delete each symbol outright (preferred — they are residue from features that landed, retreated, or never finished) or drop the `export` keyword where the helper is still useful internally. Estimated diff: **-140 / +0** LOC.

### 2.x Lower-confidence "internal-only" exports

51 additional exports are flagged by the scan as "declared and used only in the declaring file, never imported elsewhere." Most are zod schemas / type-helpers used via `z.infer` in the same module (the import-the-type pattern). Two stand out as drop-the-export-keyword candidates because the symbol is referenced ONLY at the inference site:

- `coachMessageRoleSchema` (`src/lib/ai/coach/types.ts:16`) — only used at line 18 as `z.infer<typeof coachMessageRoleSchema>`. The `CoachMessageRole` type is the external-facing artifact.
- `coachToneEnum` (`src/lib/validations/coach-prefs.ts`) — three uses in the same file, none external.

**Action: optional.** Either case is a one-word edit (`export const` → `const`). Bundle with Section 2 sweep or skip.

---

## Section 3 — orphan `__testables` exports beyond `WEEKDAY_KEYS`

After B7's `WEEKDAY_KEYS` retirement, two `__testables` blocks remain in src/:

### 3.1 `src/lib/api-handler.ts:100` — KEEP (legit test consumer)

```
src/lib/__tests__/api-handler-safe-request-prop.test.ts:34: import { __testables } from "@/lib/api-handler";
```

Wired. **No action.**

### 3.2 `src/lib/ai/coach/glp1-snapshot.ts:414` — **Low** dead-export

Exports `{ deriveDrugNames, parseTagList, parseDaysOfWeek, predictNextInjection }`. Grep for `__testables.deriveDrugNames` / `__testables.parseTagList` / etc. across the repo returns **zero** consumers. The companion test file `src/lib/ai/coach/__tests__/glp1-snapshot.test.ts:10` imports only `buildGlp1SnapshotBlock` (the public surface).

Same residue as the `WEEKDAY_KEYS` block B7 retired — the testable export was added but the matching unit test never landed. The four helpers are still legitimate internal functions; only the export block is dead.

**Action:** delete the `export const __testables = { ... }` block (lines 413–419). Estimated diff: **-7 / +0**.

---

## Section 4 — dead i18n keys

`pnpm test --run src/lib/__tests__/i18n-locale-integrity.test.ts` passes (26/26). A re-run of the W10 template-prefix-aware scan returns **DEAD COUNT: 0 of 2341** across `messages/en.json`. The 414-key cleanup landed clean in `2960f735` and survived every subsequent commit.

A new namespace gap is on record for v1.4.28 — `insights.coach.window.lastYear` is missing across all six locale bundles after B7 commit 6 added the snapshot window enum value but the i18n companion was deferred. That gap is a **missing** key, not a **dead** key, so it's out of R4 scope but flagged here for cross-reference.

**Action: no R4 work.** The i18n surface is clean as of `617d4518`.

---

## Section 5 — unused imports detected by ESLint

`pnpm lint` returns clean (0 errors, 0 warnings) at HEAD. The Next.js + TS preset enforces `no-unused-vars` at the import / local-binding level. No unused imports slipped through.

**Action: none.**

---

## Section 6 — stale `@deprecated` markers

```
grep -rn "@deprecated" /Users/marc/Projects/HealthLog/src
# zero hits
```

All three W10-flagged markers (`InsightsPageHero`, `BASE_SYSTEM_PROMPT`, `INSIGHTS_SYSTEM_PROMPT`) plus their underlying code were removed in earlier v1.4.27 commits. **No deferred markers remain.**

### 6.1 Cleanup candidate — `getInsightsSystemPrompt` is dead even without a `@deprecated` marker — **Low**

The `getInsightsSystemPrompt(locale)` helper at `src/lib/insights/prompt.ts:99` (the locale-aware replacement that survived the `INSIGHTS_SYSTEM_PROMPT` removal) has **zero production consumers**. Grep returns three hits:

```
src/lib/insights/prompt.ts:99             # export itself
src/lib/ai/prompts/insight-generator.ts:717  # JSDoc comment naming the legacy helper
src/app/api/insights/generate/__tests__/route.test.ts:80   # vi.mock returning a stub
```

The real production system-prompt resolver is `getStrictInsightsSystemPrompt(locale)` at `src/lib/ai/prompts/insight-generator.ts:717` (imported by `generate/route.ts:13`). The legacy non-strict helper is mocked but the mocked module's `getInsightsSystemPrompt` key is no longer imported by the route under test — it's dead test-fixture residue from the v1.4.20 prompt switch.

**Action:** Drop `getInsightsSystemPrompt` from `prompt.ts`. Drop the matching key from the `vi.mock("@/lib/insights/prompt", ...)` block in `route.test.ts:79–82`. Estimated diff: **-12 / +0**.

---

## Section 7 — unused React props

A heuristic interface-vs-body scan across every `*.tsx` (skipping `__tests__/`) returns exactly **one** declared-but-never-consumed prop:

### 7.1 `MedicationComplianceChart.compareBaseline` — **Low** (intent-documented)

```
src/components/charts/medication-compliance-chart.tsx:182
  compareBaseline?: "none" | "lastMonth" | "lastYear";
```

The doc comment (lines 173–181) states this is "accepted so the parent doesn't have to special-case this chart, and surface a small caption when comparison is on so the user understands the asymmetry." The component body (line 191–) never destructures `compareBaseline` and never renders any caption. So either:

- the caption is missing (wire it: ~15 LOC), or
- the prop is dead (drop it from the interface — but every caller in `dashboard-layout.tsx` and beyond passes it unconditionally, so removing it forces a parent change).

The "accept and ignore" pattern is intentional per the original commit. The bug is the missing caption.

**Action:** maintainer decision. Either wire the caption (per the v1.4.16 reconcile note in the doc comment) or drop the prop and update the four call sites. Defer-friendly; nothing breaks if left as-is.

---

## Section 8 — unused TypeScript types and enums

A blob scan returned 46 exported `type` / `interface` / `enum` declarations with one in-file occurrence (i.e. the declaration only). 45 of the 46 are `z.infer<typeof xSchema>` types in `src/lib/validations/*` — callers use the **schema** directly via `.parse()` / `.safeParse()` and pass the inferred type implicitly through `z.infer` chains, so the TS export is genuinely never imported by name. These are defensive contract exports that document the public shape; the cost of carrying them is one line each.

The remaining one is genuinely orphan code rather than a schema-derived defensive export:

### 8.1 `InsightsOutput` interface — **Low**

```
src/lib/insights/prompt.ts:105
export interface InsightsOutput {
  changed: Array<{...}>;
  stable: Array<{...}>;
  drivers: string[];
  ...
}
```

The v1.4.5 `{changed, stable, drivers, ...}` shape the legacy `getInsightsSystemPrompt` produced. Per the comment in `generate/route.ts:303` the strict prompt (PROMPT_VERSION 4.20.x) replaced this shape; the modern surface uses `insightResultSchema` in `src/lib/ai/types.ts`. **`InsightsOutput` has zero consumers anywhere** — drop alongside Section 6.1.

The 45 validation-types decision is informational. If maintainer wants a tighter surface, drop the `export` keyword on each (~45 single-word edits, no behaviour change). Otherwise leave — they're harmless.

---

## Section 9 — stale comments

### 9.1 `src/components/insights/hero-strip.tsx:20` + `__tests__/hero-strip.test.tsx:10` — **Low**

Both files carry a comment block describing the file as "Replaces the v1.4.16 `<InsightsPageHero>` with the wider band from …". The replaced component was deleted in B7. The comment is still semantically meaningful (it documents the migration's intent), but it references a symbol that no longer exists in the codebase.

**Action:** optional one-line trim per file, or leave as historical context.

### 9.2 `src/components/charts/medication-compliance-chart.tsx:172–181` — **Low**

Coupled with Section 7.1 — the doc claims a caption that the body never renders. Either resolve by wiring the caption or by dropping both the comment and the prop.

---

## Section 10 — items checked clean

The following candidates were re-verified at `617d4518` and require no R4 work:

- `__testables` blocks beyond `glp1-snapshot.ts` (Section 3.1 keeps; the W10 `WEEKDAY_KEYS` block is gone)
- `src/lib/openapi/registry.ts` — consumed by `scripts/check-openapi.ts` + `scripts/generate-openapi.ts`
- `src/lib/ai/mock-client.ts` — `MockAIProvider` consumed by integration tests
- `coach-launch-context.tsx` — every exported helper has at least one consumer
- `src/lib/medications/scheduling/cadence.ts` (`pairDoses`, `expandScheduleSlots`, `missedDoses`, `PairedDose`, `IntakeEventLike`, `ScheduleLike`) — internal + test consumers
- `src/lib/medications/glp1-knowledge.ts` — surviving exports (`routeForBrand`, `findDrugByBrand`, `findDrugIdByBrand`, `GLP1_DRUGS`, `GLP1_DRUG_IDS`) all have prod or test consumers per B7's per-symbol table
- `src/lib/medications/glp1-pk.ts` (`shotPhaseAt`, `computeOneCompartment`, `RESEARCH_MODE_DISCLAIMER_VERSION`) — consumed by `DrugLevelChart.tsx` + the research-mode route
- `src/lib/medications/titration/ladder.ts:getLadder` — only test consumers, but is also called internally by `findCurrentStep` / `nextStep` so the export keyword is still load-bearing
- `src/lib/insights/no-key-fallbacks.ts` — all seven `getNoKey*StatusText` helpers consumed
- `src/lib/insights/memory.ts` — `getPreviousInsightContext` + `formatPreviousContextForPrompt` + `PreviousInsightContext` all consumed
- `src/lib/insights/correlations.ts` — every exported helper is consumed
- `src/lib/ai/coach/budget.ts` — every export consumed by `/api/insights/chat/route.ts` or its tests
- `src/lib/ai/coach/persistence.ts` — every export except `countMessages` (Section 2.1) is consumed
- `src/lib/ai/coach/keyvalues.ts` — every export consumed
- `src/lib/ai/coach/refusal.ts` — every export consumed
- `src/lib/ai/coach/target-prompts.ts` + `target-scope.ts` — consumed by `target-card.tsx`

---

## Recommendation — single-commit R4 sweep

If maintainer pulls R4 into v1.4.27 fix-surfaces, propose one atomic commit:

1. Section 2 — drop the 14 orphan exported functions/consts (Section 2.1 through 2.14)
2. Section 3.2 — drop the `__testables` block in `glp1-snapshot.ts`
3. Section 6.1 + Section 8.1 — drop `getInsightsSystemPrompt` + `InsightsOutput` + the stale `vi.mock` key in `route.test.ts`
4. Section 9.1 — optional one-line comment trims in the two hero-strip files

Estimated diff: **-180 / +0 LOC**. Risk: low — every symbol is verified-zero-caller across `src/` + `scripts/` + `__tests__/`.

Items NOT proposed for v1.4.27:

- Section 1.1 (five admin/monitoring routes) — already deferred to v1.4.28 by the B7 fix-plan rule
- Section 7.1 (`compareBaseline` prop) — maintainer call (wire-the-caption vs drop-the-prop)
- Section 2.x (51 internal-only exports) — bulk export-keyword removal is a separate hygiene pass, not dead-code
- Section 8 zod-derived contract types — defensive surface; no action needed

---

## Verification commands the reviewer can re-run

```bash
# Section 1.1 — confirm five admin/monitoring routes still orphan
for r in /api/admin/ai-settings /api/admin/backup/test /api/admin/status-overview \
         /api/monitoring/glitchtip/test /api/monitoring/umami/test; do
  echo "=== $r ==="
  grep -rln "$r" src/components src/hooks src/app 2>/dev/null | grep -v "src/app/api"
done

# Section 2 — re-run orphan-exports scan
node /tmp/unused_funcs.mjs   # see source in the R4 working set

# Section 3.2 — confirm glp1-snapshot __testables is unconsumed
grep -rn "__testables\.\(deriveDrugNames\|parseTagList\|parseDaysOfWeek\|predictNextInjection\)" src

# Section 4 — re-run dead-i18n-key scan
node /tmp/i18n_dead.mjs   # expected: DEAD COUNT: 0 of 2341

# Section 5 — re-run lint
pnpm lint

# Section 6 — confirm @deprecated markers are gone
grep -r "@deprecated" src   # expected: zero hits

# Section 6.1 — confirm getInsightsSystemPrompt is dead in production
grep -rn "getInsightsSystemPrompt" src   # expected: declaration + JSDoc + test mock only

# Section 7.1 — confirm compareBaseline never destructured
grep -n "compareBaseline" src/components/charts/medication-compliance-chart.tsx

# Section 8.1 — confirm InsightsOutput is dead
grep -rn "InsightsOutput" src   # expected: declaration only
```
