# W21 Reconcile Plan — v1.4.25

**Created**: 2026-05-14
**Input**: 8 W21 reviewer findings files (103 findings: 2C / 20H / 41M / 40L)
**Rubric**: Critical + High + applied-Medium ship now; Low defer to v1.4.27.
**Output**: 7 touch-disjoint Fix-* surfaces + W22 (CHANGELOG-only, planned separately).

## Headline

Reconcile collapses 63 must-fix findings (2C + 20H + 41M) into 7 touch-disjoint Fix-* surfaces totalling ~22 commits. The single Critical (Withings webhook secret in application logs) and the single security High (GLP-1 endpoint missing Zod/audit/rate-limit) are scoped to two small surfaces (`src/lib/logging/`, one route file). After Fix-J through Fix-P land, the only outstanding work for the v1.4.25 tag is W22 (CHANGELOG expand + Deferred-section reconcile), which is editorial, not engineering. No deploy blocker remains after Fix-J ships.

---

## Fix-* surfaces

### Fix-J — Withings webhook log redaction (path-segment secret leak)

**Items applied**:
- sec-C1 (Critical) — `WITHINGS_WEBHOOK_SECRET` lands in `http.path` of every Wide Event via `apiHandler` instrumentation. Three sinks: stdout, in-memory ring buffer, Loki. Highest-rate secret-in-logs leak on the build.
- sec-M1 (Medium) — `redactSecrets` carries no rule for path-segment secrets; durable fix-point for sec-C1.

**Files touched**:
- `src/lib/logging/redact.ts` — add path-segment redact rule (parameterised `PATH_SECRET_PATHS` registry).
- `src/lib/logging/event-builder.ts` — apply `redactSecrets` to `http.path` and `http.route` in `setHttp` (or egress in `emitEvent`).
- `src/lib/logging/__tests__/redact.test.ts` — new tests pinning the path-segment redaction.
- `src/lib/logging/__tests__/event-builder.test.ts` — assert `setHttp` redaction.

**Estimated commits**: 2 (one for the redact-rule + registry, one for the `setHttp` wiring + tests).

**Dispatcher skeleton**:
> Focus on Withings webhook secret-in-logs leak. Touch only `src/lib/logging/redact.ts`, `src/lib/logging/event-builder.ts`, and the matching `__tests__/` files. Apply sec-C1 + sec-M1: extend `redactSecrets` with a `PATH_SECRET_PATHS` registry seeded with the `/api/withings/webhook/[token]` shape, apply it inside `WideEventBuilder.setHttp` for both `path` and `route` fields, add tests asserting `/api/withings/webhook/test-secret` rewrites to `/api/withings/webhook/[REDACTED]`. Verify the existing query-string redaction is unaffected. Do not touch the route file itself.

---

### Fix-K — Endpoint hardening (GLP-1 convenience route + legacy webhook EOL counter)

**Items applied**:
- sec-H1 (High) — `POST /api/medications/[id]/glp1` skips Zod, `auditLog`, and `checkRateLimit`. Defines bounded `glp1DoseChangePostSchema` + `glp1InventoryPostSchema`, attaches `auditLog("medication.glp1.update", …)`, copies the 30/min/user rate-limit from sibling routes.
- sec-M2 (Medium) — legacy `?secret=` Withings webhook route has no counter and the warning text omits the migration URL. Add an in-memory `withings.webhook.legacy_form_total` counter surfaced via `ops-stats`, update the warning message to include the re-subscription URL.

**Files touched**:
- `src/app/api/medications/[id]/glp1/route.ts` — Zod-strict parse, `auditLog`, `checkRateLimit`, length caps on `note`, finite-number guard on `doseValue`, sane `effectiveFrom` bounds.
- `src/lib/validations/medication.ts` — add `glp1DoseChangePostSchema` + `glp1InventoryPostSchema` next to the existing inventory/side-effect schemas.
- `src/app/api/medications/[id]/glp1/__tests__/route.test.ts` — new asserts on 422 path + audit row + rate-limit headers.
- `src/app/api/withings/webhook/route.ts` — counter + migration URL in warning.
- `src/app/api/ops-stats/route.ts` (or wherever ops counters surface) — expose the counter.

**Estimated commits**: 3 (Zod + audit + rate-limit on GLP-1 route; webhook counter + warning text; supporting test additions).

**Dispatcher skeleton**:
> Focus on closing the loose-contract gap on `/api/medications/[id]/glp1` and the legacy Withings webhook hygiene. Touch only the GLP-1 convenience route + its validator + tests, plus the legacy webhook route + the ops-stats counter surface. Apply sec-H1 (Zod + audit + 30/min rate-limit on POST, length cap on `note`, finite-number gate on `doseValue`, sane bounds on `effectiveFrom`) and sec-M2 (in-memory `withings.webhook.legacy_form_total` counter, warning text gains the re-subscription URL). Do not touch the `/api/withings/webhook/[token]` route — that is Fix-J territory.

---

### Fix-L — Design polish (touch targets, palette consistency, contrast, dialog footer, native selects, back-button i18n)

**Items applied**:
- design-H1 (High) — onboarding wizard buttons below 44×44 px floor across OnboardingShell, WelcomeCarousel, GoalsChipPicker, SourceCardGrid, BaselineForm.
- design-H2 (High) — `range-bar.tsx` mixes Tailwind raw palette + Dracula tokens; swap zone backgrounds to Dracula tokens, update pinned test.
- design-H3 (High) — personal-record badge dark-mode contrast ≈ 2.6:1; swap to `text-success`/`bg-success/15` pattern or `--foreground` text with green ring.
- design-M-2 (Medium) — `ResearchModeAcknowledgmentDialog` footer scrolls below fold on small viewports; pin `DialogFooter` outside the scrolling region.
- design-M-4 (Medium) — welcome carousel dot pager hit area 10×10 px; wrap each dot in 44×44 transparent hit area OR drop `role="tab"`.
- design-M-5 (Medium) — medication history page back-button hard-codes "Zurück"; route through `t()`.
- design-L-3 (Low → Apply, dirt-cheap) — welcome carousel live-region duplicates slide-of-N translation key. Fix in same pass since the file is already open.
- code-M-4 (Medium) — `GoalsChipPicker` localStorage block has no consumer and no schema column; drop the storage layer until v1.4.26 ships `User.onboardingGoals`.
- simp-M-9 (Medium) — `goalsStorageKey` + `ONBOARDING_GOALS_STORAGE_PREFIX` exports have zero importers; remove with the storage block.

**Files touched**:
- `src/components/onboarding/OnboardingShell.tsx` — back/skip/next button sizes.
- `src/components/onboarding/WelcomeCarousel.tsx` — arrow buttons, dot pager hit area, live-region dedup.
- `src/components/onboarding/GoalsChipPicker.tsx` — button sizes + drop storage block + drop `goalsStorageKey` exports.
- `src/components/onboarding/SourceCardGrid.tsx` — button sizes.
- `src/components/onboarding/BaselineForm.tsx` — button sizes.
- `src/components/targets/range-bar.tsx` — Dracula token swap.
- `src/components/targets/__tests__/range-bar.test.tsx` — pin Dracula tokens, drop raw-palette assertions.
- `src/components/insights/personal-record-badge.tsx` — contrast fix.
- `src/components/medications/ResearchModeAcknowledgmentDialog.tsx` — footer outside scroll region.
- `src/app/medications/[id]/history/page.tsx` — back-button `t()` wiring.
- `src/components/onboarding/__tests__/GoalsChipPicker.test.tsx` (if it exists) — drop storage-block assertions.

**Estimated commits**: 4 (onboarding tap targets + carousel dedup; range-bar palette + test; PR-badge contrast; dialog footer + back-button + goals-storage cleanup).

**Dispatcher skeleton**:
> Focus on design-system regressions in the v1.4.25 release-candidate. Touch onboarding components (OnboardingShell, WelcomeCarousel, GoalsChipPicker, SourceCardGrid, BaselineForm), `range-bar.tsx` + its test, `personal-record-badge.tsx`, `ResearchModeAcknowledgmentDialog.tsx`, and the medication history page header. Apply design-H1 (44×44 touch target across all onboarding CTAs), design-H2 (range-bar Dracula token swap + test rewrite), design-H3 (PR-badge contrast lift), design-M2 (dialog footer pinning), design-M4 (carousel dot pager hit area), design-M5 ("Zurück" hardcode → `t()`), design-L3 (carousel live-region dedup, picked up while the file is open), code-M4 (drop the GoalsChipPicker localStorage block until v1.4.26 ships the column), and simp-M9 (drop the unused `goalsStorageKey` exports with the storage block). Do not refactor section chrome (that is Fix-N).

---

### Fix-M — Inventory state-machine + onboarding step correctness + workout schema gate

**Items applied**:
- code-H1 (High) — inventory PATCH bypasses state machine on `markAsFirstUseAt`. Re-run `computeInventoryState` after composing the next-state view.
- code-H3 (High) — `expireStaleInUseItems` loops `prisma.update` per stale row; replace with a single `updateMany`.
- code-M2 (Medium) — `createWorkoutSchema` accepts `endedAt < startedAt`; add `.superRefine` gate. Also guard PR detector's MIN-direction slot against `durationSec === 0`.
- code-M7 (Medium) — onboarding step write is fetch-then-update; condition the update on `{ id, onboardingStep: current, onboardingCompletedAt: null }` and return 409 on concurrent write.

**Files touched**:
- `src/app/api/medications/[id]/inventory/[itemId]/route.ts` — re-run state machine on PATCH.
- `src/app/api/medications/[id]/inventory/__tests__/route.test.ts` — new test for back-dated first-use → EXPIRED.
- `src/lib/medications/inventory/service.ts` — replace expire loop with `updateMany`.
- `src/lib/medications/inventory/__tests__/service.test.ts` — pin the bulk-update contract.
- `src/lib/validations/workout.ts` — `.superRefine` for `endedAt > startedAt`.
- `src/lib/validations/__tests__/workout.test.ts` — pin the gate.
- `src/lib/personal-records/pr-detection-worker.ts` — MIN-direction zero-duration guard.
- `src/lib/personal-records/__tests__/pr-detection-worker.test.ts` — regression test for same-millisecond write + null slot.
- `src/app/api/onboarding/step/route.ts` — conditional update + 409.
- `src/app/api/onboarding/__tests__/step.test.ts` — concurrent-write regression test.

**Estimated commits**: 4 (inventory PATCH state machine; expire loop bulk update; workout schema gate + PR guard; onboarding step concurrency).

**Dispatcher skeleton**:
> Focus on correctness bugs across the W19b inventory state machine, W16b workout ingest, and W14b onboarding step write. Touch the inventory PATCH route + service, `createWorkoutSchema`, the PR detection worker MIN-direction branch, and the onboarding step route. Apply code-H1 (re-run `computeInventoryState` after composing next-state view; add back-dated first-use test asserting EXPIRED), code-H3 (replace the row-loop in `expireStaleInUseItems` with `updateMany`), code-M2 (`.superRefine` on `createWorkoutSchema` for `endedAt > startedAt`, plus `durationSec > 0` guard in PR worker), and code-M7 (conditional update on `onboardingStep` + `onboardingCompletedAt` to close the race, return 409 on concurrent write). Do not touch shared helpers (that is Fix-N) and do not edit `inventory-section.tsx` (that is Fix-N's wrapper surface).

---

### Fix-N — Simplifier helpers, drift guards, section wrapper, route hardening

**Items applied**:
- simp-H1 (High) — onboarding `readError` helper duplicated 4×; hoist to `src/lib/api/read-error.ts`.
- simp-H2 (High) — `templateFill` in TitrationSection reinvents `t(key, params)`; drop helper, lean on i18n.
- simp-H3 (High) — Settings advanced-section nested ternary for research-mode status; extract `statusLabel` helper.
- simp-H4 (High) — `ResearchModeStatus` interface redeclared in two surfaces; share via `src/lib/medications/research-mode-types.ts`.
- simp-H5 (High) — `Object.entries(GLP1_DRUGS) → drugId` reverse lookup duplicated; add `findDrugIdByBrand` to `glp1-knowledge.ts`.
- simp-H6 (High) — `assertMedicationOwnership` body duplicated across 11 medication routes; hoist to `src/lib/medications/route-guards.ts`.
- simp-H7 (High) — `InventoryState` string-union in `inventory-section.tsx` redeclares the Prisma enum; import `MedicationInventoryState`.
- simp-M1 (Medium) + code-M1 (Medium) — `SIDE_EFFECT_CATEGORY_VALUES` / `SIDE_EFFECT_ENTRY_VALUES` restate the Prisma enum keys; derive via `z.nativeEnum` and add drift-guard test asserting Prisma enum, taxonomy map, and validator stay in sync.
- simp-M3 (Medium) — extract `<MedicationDetailSection>` wrapper composing the three section shells (Titration / Scheduling / SideEffects) and the inventory disclosure top.
- simp-M4 (Medium) — three near-identical `parseDose*` helpers; collapse to one `parseDoseMg` in `src/lib/medications/dose-string.ts`.
- simp-M5 (Medium) — client-side `daysRemainingInUse` reimplementation in `inventory-section.tsx`; widen the pure helper signature instead.
- simp-M8 (Medium) — three W19 routes use a 4-line `for (const [k, v] of Object.entries(rateLimitHeaders(rl)))` pattern; align on the option-bag form `apiError("Too many requests", 429, { headers: rateLimitHeaders(rl) })`.
- design-M-1 (Medium) — `BaselineForm` gender field native `<select>` + `SideEffectsSection` category native `<select>` break design-system consistency; replace with `@/components/ui/select`. BaselineForm select goes here (Fix-L owns its buttons only; the structural Select swap is design-system work).
- design-M-3 (Medium) — `SchedulingSection` cadence-timeline cells `h-3 w-3` (12×12 px) — grow to 44 px touch target OR remove `title`-only contract in favour of tap-popover. (Same file gets the wrapper, so consolidate here.)
- code-M-6 (Medium) — `categoryForEntry` defensive 422 vs derive-and-write: drop `category` from `createSideEffectSchema`, derive on the server only. Backwards-compatible (no iOS DTO yet).

**Files touched**:
- `src/lib/api/read-error.ts` (new).
- `src/lib/medications/research-mode-types.ts` (new).
- `src/lib/medications/route-guards.ts` (new).
- `src/lib/medications/dose-string.ts` (new — merged parser).
- `src/components/medications/medication-detail-section.tsx` (new wrapper).
- `src/components/medications/TitrationSection.tsx` — drop `templateFill`, use wrapper, use shared parser.
- `src/components/medications/SchedulingSection.tsx` — use wrapper, grow cadence cells to touch target.
- `src/components/medications/SideEffectsSection.tsx` — use wrapper, swap native `<select>` to design-system Select.
- `src/components/medications/inventory-section.tsx` — use wrapper top, swap `InventoryState` for Prisma enum, drop reimplemented `daysRemainingInUse`.
- `src/components/medications/DrugLevelChart.tsx` — use shared `ResearchModeStatus` + `findDrugIdByBrand` + shared dose-string parser.
- `src/components/settings/advanced-section.tsx` — use shared `ResearchModeStatus`, extract `statusLabel` helper.
- `src/components/onboarding/WelcomeCarousel.tsx` — import shared `readError`.
- `src/components/onboarding/GoalsChipPicker.tsx` — import shared `readError`.
- `src/components/onboarding/SourceCardGrid.tsx` — import shared `readError`.
- `src/components/onboarding/BaselineForm.tsx` — import shared `readError` + swap gender native `<select>` for design-system Select.
- `src/lib/medications/glp1-knowledge.ts` — add `findDrugIdByBrand`.
- `src/lib/medications/side-effects/validators.ts` — derive arrays via `z.nativeEnum`.
- `src/lib/medications/side-effects/__tests__/drift-guard.test.ts` (new) — assert Prisma enum / taxonomy / validator triangle.
- `src/app/api/medications/[id]/{titration,side-effects,inventory,cadence,intake,compliance,phase-config,api-endpoint}/route.ts` — call `assertMedicationOwnership`, align rate-limit headers pattern (3 routes per simp-M8). Note: `glp1` route is Fix-K's territory but the assertion may need re-applying once Fix-K lands; coordinate via merge order (Fix-K first, then Fix-N re-applies the shared helper). The `inventory/[itemId]/route.ts` is Fix-M's territory; leave that file alone here.
- `src/app/api/medications/[id]/side-effects/route.ts` — drop `category` field write per code-M6 + add drift-guard.

**Estimated commits**: 6 (shared helpers extraction; section wrapper + Schedule/Titration/SideEffects/Inventory rewrap; route ownership helper rollout across 9 routes; SIDE_EFFECT enum derivation + drift guard; rate-limit header alignment; advanced-section + DrugLevelChart type sharing).

**Dispatcher skeleton**:
> Focus on cross-route + cross-component helper extraction and drift-guard tightening. Touch the listed new helper modules and the medication-detail components + nine medication routes (NOT the inventory `[itemId]` PATCH route — that is Fix-M, and NOT the glp1 convenience route — that is Fix-K). Apply simp-H1 (`readError`), simp-H2 (drop `templateFill`), simp-H3 (extract `statusLabel`), simp-H4 (shared `ResearchModeStatus`), simp-H5 (`findDrugIdByBrand`), simp-H6 (`assertMedicationOwnership` across 9 routes), simp-H7 (`MedicationInventoryState` import), simp-M1 + code-M1 (derive validators via `z.nativeEnum`, drift-guard test), simp-M3 (`<MedicationDetailSection>` wrapper for the three sections + inventory top), simp-M4 (merge `parseDose*` parsers), simp-M5 (widen pure `daysRemainingInUse`), simp-M8 (rate-limit header pattern alignment in 3 routes), design-M1 (swap native `<select>` to design-system Select in BaselineForm and SideEffectsSection), design-M3 (grow Schedule cadence cells to touch target), code-M6 (derive `category` server-side; drop from schema).

---

### Fix-O — Schema hardening + Withings activity TZ + dead-helper decision + migration comment

**Items applied**:
- senior-M1 (Medium) — Migration 0057 `onboarding_step` ships nullable; backfill data migration + flip to `NOT NULL DEFAULT 0`. Closes the tri-state ambiguity.
- senior-M2 (Medium) — Withings activity sync anchors per-day rows at 23:59:59 UTC; mis-buckets for positive-offset users. Anchor at noon UTC (12:00:00Z) or thread through user timezone.
- senior-M3 (Medium) — PR detection worker test gap: add regression test for "same userId / metricType / null slot / same achievedAt × 2 back-to-back invocations" asserting one row.
- code-H2 (High) — cadence + compliance helpers ignore per-user timezone; thread `timeZone` into `expandScheduleSlots`, `pairDoses`, `buildCadenceTimeline`, `complianceChips` (via `Intl.DateTimeFormat` or `date-fns-tz`). Cadence route resolves via `resolveUserTimeZone(user)`.
- code-M5 (Medium) + dead-H4 (High) — `research-mode-staleness.ts` module has zero production importers. Decision: **delete the module + its test file** for v1.4.25 (the version-bump path in `/api/auth/me/research-mode/route.ts` already provides the cleaner re-prompt trigger). Re-add only if/when Marc decides to wire the 90-day gate in v1.4.26.
- code-M8 (Medium) — Migration 0057 comment misstates PG default-backfill behaviour; rewrite to "Existing rows are backfilled to 0 by PostgreSQL's fast-path ADD COLUMN DEFAULT (PG11+)."
- product-lead-M1 (Medium) — drug-level chart-side staleness wiring deferred to v1.4.26. Aligned with the delete-helper decision above; document in W22 CHANGELOG that the staleness gate is intentionally deferred (not silently omitted).

**Files touched**:
- `prisma/migrations/0060_onboarding_step_not_null/` (new) — backfill + `ALTER COLUMN onboarding_step SET NOT NULL`.
- `prisma/schema.prisma` — flip `onboardingStep Int? @default(0)` → `onboardingStep Int @default(0)`.
- `prisma/migrations/0057_user_onboarding_step/migration.sql` — comment-only rewrite (no schema delta).
- `src/lib/withings/sync-activity.ts` — anchor at `T12:00:00.000Z` (noon UTC) for the `YYYY-MM-DD` parse; document the contract.
- `src/lib/withings/__tests__/sync-activity.test.ts` — regression test asserting Berlin / LA / Tokyo users all bucket the same `YYYY-MM-DD` into the same local day.
- `src/lib/medications/scheduling/cadence.ts` — `timeZone` argument threading; `Intl.DateTimeFormat` for local-day boundaries.
- `src/lib/medications/scheduling/compliance.ts` — `timeZone` argument threading.
- `src/lib/medications/scheduling/__tests__/{cadence,compliance}.test.ts` — TZ-bound assertions across UTC+0, UTC+9, UTC-8.
- `src/app/api/medications/[id]/cadence/route.ts` — call `resolveUserTimeZone(user)` and forward.
- `src/lib/personal-records/__tests__/pr-detection-worker.test.ts` — null-slot dup regression.
- `src/lib/medications/research-mode-staleness.ts` — **delete**.
- `src/lib/medications/__tests__/research-mode-staleness.test.ts` — **delete**.

**Estimated commits**: 5 (Migration 0060 + schema flip; comment rewrite on 0057; Withings activity TZ anchor; cadence/compliance TZ threading; PR worker regression + research-mode-staleness delete).

**Dispatcher skeleton**:
> Focus on schema correctness + multi-tz preparation for v1.5. Touch Migration 0060 (new), 0057 comment, `sync-activity.ts`, `scheduling/{cadence,compliance}.ts`, the cadence route, the PR worker test, and **delete** `research-mode-staleness.ts` + test. Apply senior-M1 (Migration 0060 backfills NULL onboarding_step rows and flips column to NOT NULL DEFAULT 0; schema.prisma matches), senior-M2 (anchor Withings activity rows at noon UTC), senior-M3 + L2 (null-slot dup regression test), code-H2 (thread `timeZone` into the cadence + compliance pure helpers via `Intl.DateTimeFormat`, cadence route resolves through `resolveUserTimeZone`), code-M5 + dead-H4 (delete `research-mode-staleness.ts` and its test — the version-bump re-prompt already covers the regulatory contract), code-M8 (rewrite the misleading PG11+ comment in 0057). Do not touch shared route helpers (Fix-N) or inventory routes (Fix-M).

---

### Fix-P — i18n + e2e incidentals

**Items applied**:
- i18n-Low-1 (Low → Apply, trivial) — `e2e/locale-switch.spec.ts` uses cookie name `healthlog_locale` (underscore) where server reads `healthlog-locale` (hyphen). Spec passes vacuously today. One-character fix.

**Files touched**:
- `e2e/locale-switch.spec.ts` — rename cookie.

**Estimated commits**: 1.

**Dispatcher skeleton**:
> Focus on one trivial e2e cookie-name typo. Touch only `e2e/locale-switch.spec.ts`. Rename `healthlog_locale` → `healthlog-locale` so the spec actually exercises locale switching. The runtime probe under i18n-runtime-findings.md confirms there are zero raw-key leaks in production — this spec is broken in test-land only.

---

## W22 — out-of-scope-for-reconcile

**Items**: product-lead-C1 + product-lead-H1 + product-lead-H2 (CHANGELOG.md frozen at the Wave-3 surface; test counts stale; `Deferred to v1.4.26` section lists items already shipped in Wave-4-5).

**Not a Fix-* slot**: already a separately-planned task at W22 per the Session-2 handoff. The work is editorial — expand CHANGELOG.md to cover the 60+ Wave-4-and-5 commits, update test-count footer to ~3400 unit + ~170 integration, re-categorise the Wave-4-5 items out of "Deferred" and into Added / Changed / Fixed / Security / Refactor. New commit `chore(release): expand v1.4.25 with Wave 4-5 features` lands on `develop` after Fix-J–Fix-P merge, before the tag.

The product-lead-M5 framing nit (FR/ES/IT/PL Coach prompts shipped as LLM-quality drafts with structural coverage tests) is part of the W22 wording exercise — describe what shipped without billing it as "AI-drafted" per the Marc-Voice memory.

---

## Deferrals matrix (Medium-only)

| Reviewer-ID | Severity | Finding | Decision | Reason |
|---|---|---|---|---|
| sec-M1 | Medium | `redactSecrets` missing path-segment rule | Apply (Fix-J) | Durable fix-point for sec-C1; same surface |
| sec-M2 | Medium | Legacy Withings webhook EOL counter + URL | Apply (Fix-K) | Pairs naturally with the GLP-1 endpoint hardening pass |
| design-M1 | Medium | BaselineForm + SideEffectsSection native `<select>` | Apply (Fix-N) | Files already in Fix-N for wrapper extraction; same touch |
| design-M2 | Medium | ResearchModeAcknowledgmentDialog footer below fold | Apply (Fix-L) | Single-line DOM reshuffle; visual polish surface |
| design-M3 | Medium | Cadence cells 12×12 px tap target | Apply (Fix-N) | SchedulingSection already in Fix-N for wrapper |
| design-M4 | Medium | Welcome carousel dot pager 10×10 px hit area | Apply (Fix-L) | Same file as design-H1 onboarding tap-target pass |
| design-M5 | Medium | History page back-button "Zurück" hardcode | Apply (Fix-L) | One-line i18n wiring; design surface |
| product-lead-M1 | Medium | Research-mode-staleness wiring deferred | Apply (Fix-O) | Resolved by deleting the unused helper module |
| product-lead-M2 | Medium | `User.onboardingGoals` column deferred | Defer v1.4.26 | Schema work; documented in W14b-Content deviation §1; W22 CHANGELOG notes it |
| product-lead-M3 | Medium | W11a multi-arch lowercase fix landed late | Defer v1.4.27 | Operational note; already resolved in Fix-H + W20-rest `vars.COOLIFY_AUTO_DEPLOY` toggle; no code action |
| product-lead-M4 | Medium | Session-1 W12/W13 deliverables not in Session-2 W24 plan | Defer v1.4.26 | Operational note; Marc-driven post-tag list, not engineering |
| product-lead-M5 | Medium | FR/ES/IT/PL Coach prompts framed truthfully | Apply (W22) | Pure CHANGELOG wording; part of W22 editorial pass |
| senior-M1 | Medium | Migration 0057 nullable invariant | Apply (Fix-O) | New Migration 0060 backfill + NOT NULL |
| senior-M2 | Medium | Withings activity sync 23:59:59 UTC TZ mis-bucket | Apply (Fix-O) | Anchor at noon UTC; bounded LOC |
| senior-M3 | Medium | PR worker null-slot dup test gap | Apply (Fix-O) | Test-only; co-locates with the worker delete |
| code-M1 | Medium | Side-effect taxonomy 3-way drift surface | Apply (Fix-N) | Pairs with simp-M1 enum derivation |
| code-M2 | Medium | `createWorkoutSchema` accepts `endedAt < startedAt` | Apply (Fix-M) | Single `.superRefine`; PR-detector zero-duration guard |
| code-M3 | Medium | Manual-workout route attach uses serial `findFirst` | Defer v1.4.26 | Dead path today (no manual workout UI); contract correctness only matters once v1.5 UI lands |
| code-M4 | Medium | GoalsChipPicker localStorage-only persistence | Apply (Fix-L) | Drop the storage block now; v1.4.26 ships the column |
| code-M5 | Medium | research-mode-staleness module never wired | Apply (Fix-O) | Resolved by deleting (dead-H4) |
| code-M6 | Medium | `categoryForEntry` 422 vs derive | Apply (Fix-N) | Drop `category` field; derive server-side |
| code-M7 | Medium | Onboarding step race window | Apply (Fix-M) | Conditional update; 409 on conflict |
| code-M8 | Medium | Migration 0057 comment misstates PG behaviour | Apply (Fix-O) | Comment-only; one-line edit |
| simp-M1 | Medium | SIDE_EFFECT validators duplicate Prisma enum | Apply (Fix-N) | Pairs with code-M1 drift guard |
| simp-M2 | Medium | Three near-identical `async function advance()` | Defer v1.4.26 | LOC > 50 across three callers; hook extraction merits its own design pass; affects components Fix-L is already touching for sizes (collision risk) |
| simp-M3 | Medium | `<MedicationDetailSection>` wrapper | Apply (Fix-N) | Locks the pattern before W19g (if it lands) |
| simp-M4 | Medium | Three near-identical dose-string parsers | Apply (Fix-N) | Single new module; clean merge |
| simp-M5 | Medium | `daysRemainingInUse` reimplemented client-side | Apply (Fix-N) | Widen pure helper signature; small touch |
| simp-M6 | Medium | `pairDoses()` sorts twice | Defer v1.4.27 | Micro-optimisation; cadence chart not slow today |
| simp-M7 | Medium | `escalationDue` drugId rename/JSDoc | Defer v1.4.27 | Comment-only polish |
| simp-M8 | Medium | rate-limit headers pattern misalignment | Apply (Fix-N) | Three routes; trivial option-bag swap |
| simp-M9 | Medium | `goalsStorageKey` exports unused | Apply (Fix-L) | Drops with the storage block code-M4 owns |
| simp-M10 | Medium | `glp1-pk.ts` unused exports (`shotPhaseAt` et al.) | Defer v1.4.26 | Decision required (internalise vs wire dashboard chip); not a refactor |
| dead-M1 | Medium | `/api/admin/ai-settings` orphan | Defer v1.4.26 | Marc decision per W20-rest go/no-go memo |
| dead-M2 | Medium | `/api/admin/backup/test` orphan duplicate | Defer v1.4.26 | Marc decision per W20-rest |
| dead-M3 | Medium | `/api/admin/status-overview` verify-first | Defer v1.4.26 | Needs admin-hook spot-check first |
| dead-M4 | Medium | `/api/monitoring/{glitchtip,umami}/test` non-admin orphans | Defer v1.4.26 | Marc decision per W20-rest |
| dead-M5 | Medium | `glp1-knowledge.ts` unused exports (10 symbols) | Defer v1.4.26 | Module-surface narrowing; co-locates with M5/M6/M7 cleanup phase |
| dead-M6 | Medium | `glp1-pk.ts` unused exports (4 symbols) | Defer v1.4.26 | Mirrors simp-M10 decision |
| dead-M7 | Medium | scheduling/{cadence,compliance}.ts unused type+helper exports | Defer v1.4.26 | Module-surface narrowing |
| dead-M8 | Medium | Dead `insights.*Status*` i18n keys (132 strings) | Defer v1.4.26 | Bulk i18n drop; v1.4.26 dedicated commit |
| i18n-M1 | Medium | FR/ES/IT/PL EN-fallback values (~7,400 strings) | Defer v1.4.27+ | Translation-author work; outside engineering scope. Acknowledged via maintainership banner. W22 CHANGELOG notes "drafts with structural coverage; contributions welcome" |

---

## Low findings appendix (40 items, deferred to v1.4.27)

- **security (3)**: L-1 `Workout.metadata` unbounded JSON; L-2 PR-detection enqueue swallows errors; L-3 cadence/titration GETs no rate-limit.
- **design (3)**: L-1 acknowledgment dialog duplicate `gap-2`; L-2 DrugLevelChart Y-axis label rendered twice; L-3 carousel duplicate slide-of-N (relocated → Fix-L because the file is open; counted here for completeness).
- **product-lead (6)**: L-1 "AI-translated" wording nit (resolved via W22); L-2 EMA EPAR citations (no action); L-3 personal_records NULLS DISTINCT guard (v1.4.26 backlog); L-4 `/api/audit-log` consumer decision (cross-references dead-H1); L-5 MOOD_LABEL_KEYS closed; L-6 Prisma format whitespace re-flow.
- **senior-dev (5)**: L1 Migration 0058 NULL sanity probe; L2 PR worker single-flight queue gate (v1.5 fleet scale); L3 Migration 0055 index-name sanity probe; L4 pg-boss DLQ for `pr-detection`; L5 onboarding "step 4.5" stale brief note.
- **code-review (8)**: L1 `zod` vs `zod/v4` import style; L2 onboarding step-4 URL forward-block review; L3 `pr-direction.ts` missing `default` arm; L4 `glp1-pk.ts` `resolveKa` 3/tmax heuristic; L5 `/api/auth/me/research-mode` DELETE no rate-limit; L6 `PR_DETECTION_FALLBACK_CRON` fleet-scope; L7 PR worker 42-roundtrip measurement scan; L8 enqueue audit-log error-swap nit.
- **simplifier (8)**: L1 inventory state-machine nested ternary; L2 DrugLevelChart 5-deep ternary; L3 OnboardingShell duplicated `clamped===0 ? 1 : clamped`; L4 `MS_PER_DAY` / `DAY_MS` / inline constants drift (5 copies); L5 dose-regex inconsistency (rolls into M4); L6 SideEffects plural vs singular naming; L7 OnboardingShellProps unnecessary export; L8 WelcomeCarousel SLIDES + CarouselSlide file-private.
- **dead-code (7)**: L1 `@deprecated` constants forensic note (already cleaned); L2 side-effects/validators.ts unused exports (5); L3 inventory/state-machine.ts unused exports (6); L4 `isSubPageSlug` unused type-guard; L5 `resolveGeneralStatusLocale` unused; L6 IntakeSource.IMPORT enum keep; L7 targets/route.ts stale comment typo.
- **i18n (0)**: zero raw-key leaks across 210 probes.

---

## File-touch matrix (collision check)

| File | Fix-J | Fix-K | Fix-L | Fix-M | Fix-N | Fix-O | Fix-P |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `src/lib/logging/redact.ts` | X | | | | | | |
| `src/lib/logging/event-builder.ts` | X | | | | | | |
| `src/lib/logging/__tests__/*.ts` | X | | | | | | |
| `src/app/api/medications/[id]/glp1/route.ts` | | X | | | | | |
| `src/lib/validations/medication.ts` | | X | | | | | |
| `src/app/api/withings/webhook/route.ts` | | X | | | | | |
| `src/app/api/ops-stats/route.ts` | | X | | | | | |
| `src/components/onboarding/OnboardingShell.tsx` | | | X | | | | |
| `src/components/onboarding/WelcomeCarousel.tsx` | | | X | | | | |
| `src/components/onboarding/GoalsChipPicker.tsx` | | | X | | | | |
| `src/components/onboarding/SourceCardGrid.tsx` | | | X | | | | |
| `src/components/onboarding/BaselineForm.tsx` (buttons only)  | | | X | | | | |
| `src/components/targets/range-bar.tsx` (+ test) | | | X | | | | |
| `src/components/insights/personal-record-badge.tsx` | | | X | | | | |
| `src/components/medications/ResearchModeAcknowledgmentDialog.tsx` | | | X | | | | |
| `src/app/medications/[id]/history/page.tsx` | | | X | | | | |
| `src/app/api/medications/[id]/inventory/[itemId]/route.ts` | | | | X | | | |
| `src/lib/medications/inventory/service.ts` (+ test) | | | | X | | | |
| `src/lib/validations/workout.ts` (+ test) | | | | X | | | |
| `src/lib/personal-records/pr-detection-worker.ts` | | | | X | | | |
| `src/lib/personal-records/__tests__/pr-detection-worker.test.ts` | | | | X | X | | |
| `src/app/api/onboarding/step/route.ts` (+ test) | | | | X | | | |
| `src/lib/api/read-error.ts` (new) | | | | | X | | |
| `src/lib/medications/research-mode-types.ts` (new) | | | | | X | | |
| `src/lib/medications/route-guards.ts` (new) | | | | | X | | |
| `src/lib/medications/dose-string.ts` (new) | | | | | X | | |
| `src/components/medications/medication-detail-section.tsx` (new) | | | | | X | | |
| `src/components/medications/TitrationSection.tsx` | | | | | X | | |
| `src/components/medications/SchedulingSection.tsx` | | | | | X | | |
| `src/components/medications/SideEffectsSection.tsx` | | | | | X | | |
| `src/components/medications/inventory-section.tsx` | | | | | X | | |
| `src/components/medications/DrugLevelChart.tsx` | | | | | X | | |
| `src/components/settings/advanced-section.tsx` | | | | | X | | |
| `src/lib/medications/glp1-knowledge.ts` | | | | | X | | |
| `src/lib/medications/side-effects/validators.ts` (+ drift test) | | | | | X | | |
| `src/app/api/medications/[id]/{titration,side-effects,inventory,cadence,intake,compliance,phase-config,api-endpoint}/route.ts` | | | | | X | | |
| `src/components/onboarding/{WelcomeCarousel,GoalsChipPicker,SourceCardGrid,BaselineForm}.tsx` — `readError` import line | | | (X buttons) | | (X import) | | |
| `prisma/migrations/0060_onboarding_step_not_null/` (new) | | | | | | X | |
| `prisma/migrations/0057_user_onboarding_step/migration.sql` (comment-only) | | | | | | X | |
| `prisma/schema.prisma` | | | | | | X | |
| `src/lib/withings/sync-activity.ts` (+ test) | | | | | | X | |
| `src/lib/medications/scheduling/cadence.ts` (+ test) | | | | | (X helper) | X | |
| `src/lib/medications/scheduling/compliance.ts` (+ test) | | | | | | X | |
| `src/app/api/medications/[id]/cadence/route.ts` | | | | | X (ownership) | X (TZ) | |
| `src/lib/medications/research-mode-staleness.ts` (+ test) — DELETE | | | | | | X | |
| `e2e/locale-switch.spec.ts` | | | | | | | X |

### Collisions found and resolved

Two pairs of overlapping files were intentionally consolidated rather than split, to keep each agent's diff atomic. Both are listed below with the chosen owner.

| File | Buckets touching | Resolution |
|---|---|---|
| `src/components/onboarding/{WelcomeCarousel,GoalsChipPicker,SourceCardGrid,BaselineForm}.tsx` | Fix-L (button sizes, dot pager, storage drop) + Fix-N (`readError` import) | Fix-L lands first; Fix-N's single-import-line edit is appended in the same merge window. Risk: trivial (one import line at top of file vs jsx body edits at the bottom). |
| `src/lib/medications/scheduling/cadence.ts` (+ compliance) | Fix-N (helper extraction in route-guards) + Fix-O (timezone threading) | Fix-O owns the file; Fix-N's touches on the route layer (`src/app/api/medications/[id]/cadence/route.ts`) overlap with Fix-O's TZ wiring on the same route. Resolution: **Fix-O runs first on `cadence/route.ts` to land `resolveUserTimeZone()`, then Fix-N adds `assertMedicationOwnership` on top**. Document the merge order in the orchestrator's dispatch sheet. |
| `src/app/api/medications/[id]/cadence/route.ts` | Fix-N + Fix-O | Same as above — Fix-O first, Fix-N second. |
| `src/lib/personal-records/__tests__/pr-detection-worker.test.ts` | Fix-M (zero-duration MIN guard test) + Fix-O (null-slot dup test) | Both are additive — distinct `describe` blocks. Run Fix-M first, Fix-O appends. |

Zero file-touch collisions where two agents would edit the **same lines**. Three files have sequenced edits (top of file vs body, separate `describe` blocks). The orchestrator schedules Fix-O before Fix-N on the cadence route, and Fix-L before Fix-N on the onboarding components.

---

## Closing

The reconcile plan reduces 63 must-fix findings to 7 touch-disjoint Fix-* surfaces with three sequenced merge windows (Fix-O before Fix-N on cadence; Fix-L before Fix-N on onboarding; Fix-M before Fix-O on the PR worker test). Estimated total: ~22 commits across the seven buckets, plus the W22 editorial pass on CHANGELOG.

Critical (sec-C1) and the single security High (sec-H1) are scoped to two small surfaces — `src/lib/logging/` and one route file — and ship in Fix-J + Fix-K. Once those land, no v1.4.25 deploy blocker remains; everything else is correctness/polish/refactor that compounds the release quality without gating it.

After all seven Fix-* surfaces merge, dispatch W22 (CHANGELOG expand + Deferred-section reconcile + test-count footer update), then Marc UAT, then the tag. Post-tag W24 handles the Demo redeploy, sister-repo version pins, docs/audit/v1425-summary.md, the Codex audit prompt, and the v15-ios-handoff.md — none of those touch product code.
