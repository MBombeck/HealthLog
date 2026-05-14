# W21 Simplifier Findings — v1.4.25 release-candidate

Scan scope: `v1.4.24..develop` (60+ commits, ~2.5k new files), focused
on the W14b onboarding rebuild, W19c/d/e/f medication pure-modules and
detail-page sections, W19c-Safety surface, W15 hygiene cluster, W18
W10 Low+care items, and W20-rest P6 polish. Pure observation pass —
no code changes; the W18 simplifier already shipped the
apply-with-care list, so this is the fresh-eyes follow-up against the
code that landed after that pass.

Severity rubric (from the W21 dispatch brief):
- **Critical** — none expected; this is a quality lens, not a release-blocker lens.
- **High** — duplication or dead branch that hides a bug, or a nested ternary that lives in production conditional logic the rubric explicitly flags.
- **Medium** — clear simplification with >10-line savings AND clear callsite improvement.
- **Low** — style preference, micro-refactor, defer to v1.4.27.

---

## Summary

No critical issues. Seven High findings, ten Medium, eight Low.

The Wave-4b medication-detail panels (W19d/e/f) plus the inventory
disclosure all carry the same chrome (`border-border/60 rounded-md
border` shell + bordered header strip + `border-t` content well + EMA
disclaimer footer). Four near-identical `<section>` skeletons across
three sections is exactly the threshold the rubric flags as "warrants
a helper". Same story on the onboarding side: four step components
each ship a private `readError(res)` helper and three of them ship a
near-identical `async function advance()` with the
fetch-rate-limit-redirect-toast pattern.

The W19c-Safety / W19c-Frontend surface introduced two locally
redefined `interface ResearchModeStatus` types (advanced-section.tsx
and DrugLevelChart.tsx) plus a reverse-lookup loop over `GLP1_DRUGS`
that's now duplicated in two places. Neither is harmful today, but
both look exactly like the W18 simplifier work the W10 lens predicted.

The `glp1-pk.ts` module exports four names (`shotPhaseAt`, `ShotPhase`,
`OneCompartmentOptions`, `PkSample`) that nothing outside the test
file imports. The module's own JSDoc cites these as "the shot phase
chip on the dashboard tile (research §2.4)" — that surface hasn't
shipped yet, so they sit in the file as scope-creep insurance. Either
mark them with the `__testables` pattern from W15's api-handler or
remove them.

---

## High

### H1 — Onboarding step components each ship their own `readError(res)`

**Where**: 4 files — `src/components/onboarding/{WelcomeCarousel,GoalsChipPicker,SourceCardGrid,BaselineForm}.tsx`

**Current** (identical 10-line block, repeated 4×):
```ts
async function readError(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { error?: string };
    if (typeof json.error === "string" && json.error.length > 0) {
      return json.error;
    }
  } catch {
    /* fall through */
  }
  return `Request failed (${res.status})`;
}
```

**Suggested**: hoist to `src/lib/api/read-error.ts` (or
`src/components/onboarding/_helpers.ts`); 4 callers import it.

**LOC delta**: −30 (4 copies × 10 lines, minus one shared module of ~10 lines).
**Risk**: low — pure helper, identical across all callers, no closure state.

---

### H2 — `templateFill` in TitrationSection.tsx reinvents the i18n `t(key, params)` contract

**Where**: `src/components/medications/TitrationSection.tsx:53-61`

**Current**:
```ts
function templateFill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}
// then 5 call sites:  templateFill(t("medications.titration.stepLabel"), { n: step.stepIndex + 1 })
```

**Suggested**: drop `templateFill`; `t()` already accepts params. The
i18n provider in `src/lib/i18n/context.tsx:130-153` does exactly the
same `{param}` substitution natively:
```ts
{t("medications.titration.stepLabel", { n: step.stepIndex + 1 })}
```

**LOC delta**: −9 helper + slightly cleaner call sites.
**Risk**: low — `t()` already runs the same `replace(new RegExp(\`\\{${k}\\}\`, "g"), …)` substitution. Verified at `context.tsx:144-148`.

This is a clean bug-hide candidate: a future maintainer who renames a
placeholder in the German locale but not in `templateFill`'s caller
would get silent fallthrough.

---

### H3 — Nested ternary inside the Settings "Research Mode" status line

**Where**: `src/components/settings/advanced-section.tsx:181-191`

**Current**:
```tsx
{isLoading
  ? t("common.loading")
  : status?.enabled
    ? versionsAligned
      ? t("settings.researchMode.acknowledgedOn", { date: ... })
      : t("settings.researchMode.enabledStaleStatus")
    : t("settings.researchMode.disabledStatus")}
```

**Suggested**: extract to a small helper `function statusLabel({isLoading, status, versionsAligned})` with a switch/early-return chain. The rubric calls out nested ternaries explicitly ("prefer switch statements or if/else chains for multiple conditions").

**LOC delta**: roughly neutral (+5 helper / -10 inline) but materially more readable; the four branches are independent.
**Risk**: low — pure presentation.

---

### H4 — `interface ResearchModeStatus` redeclared in two surfaces

**Where**:
- `src/components/settings/advanced-section.tsx:70-75`
- `src/components/medications/DrugLevelChart.tsx:75-80`

Both spell the same 4-field shape (`enabled`, `acknowledgedAt`,
`acknowledgedVersion`, `currentDisclaimerVersion`). The API route
already owns the canonical `ResearchModeResponse` type in
`src/app/api/auth/me/research-mode/route.ts:45-50`, but it isn't
exported.

**Suggested**: export the type from a shared `src/lib/medications/research-mode-types.ts` (the API route stays the source of truth, sibling to `glp1-pk.ts` where `RESEARCH_MODE_DISCLAIMER_VERSION` lives). Both components import the alias.

**LOC delta**: −10 (two 6-line interfaces collapsed to two import lines).
**Risk**: low — pure type alias, no runtime change.

---

### H5 — Reverse-lookup loop `Object.entries(GLP1_DRUGS) → drugId` duplicated

**Where**:
- `src/app/api/medications/[id]/titration/route.ts:69-78`
- `src/components/medications/DrugLevelChart.tsx:134-140`

**Current** (both):
```ts
let drugId: Glp1DrugId | null = null;
for (const [id, r] of Object.entries(GLP1_DRUGS)) {
  if (r === record) { drugId = id as Glp1DrugId; break; }
}
```

**Suggested**: add `findDrugIdByBrand(brand: string): Glp1DrugId | null` to `glp1-knowledge.ts` (mirroring the existing `findDrugByBrand`). Both callsites become a single named call.

**LOC delta**: −12 net.
**Risk**: low — pure read of a static catalog.

---

### H6 — `assertMedicationOwnership` defined twice with byte-identical body

**Where**:
- `src/app/api/medications/[id]/side-effects/route.ts:43-55`
- `src/app/api/medications/[id]/inventory/route.ts:37-49`

Plus the same inline 3-line check is repeated in the W19e/f cadence/titration routes (`route.ts:41-47` and `:44-52`), and in `[id]/intake/route.ts`, `[id]/glp1/route.ts`, `[id]/route.ts`, `[id]/compliance/route.ts`, `[id]/phase-config/route.ts`, `[id]/api-endpoint/route.ts`, `[id]/intake/purge/route.ts`, `[id]/intake/import/route.ts` — 11 callsites total counted by grep.

**Suggested**: hoist to `src/lib/medications/route-guards.ts` (parallel to `src/lib/api-handler.ts`): `async function assertMedicationOwnership(id, userId, opts?): Promise<NextResponse | { medication }>`. Each route reduces to one call.

**LOC delta**: −40 net across the 11 callsites.
**Risk**: low-medium — needs a careful pass on the variants that `include` schedules / doseChanges (cadence/titration use Prisma `include`, the side-effects route uses `select`). Helper either takes an `include` argument or exposes a two-step ownership check + caller-fetches-detail.

---

### H7 — `InventoryState` type alias redeclared as string-union in `inventory-section.tsx`

**Where**: `src/components/medications/inventory-section.tsx:35`

**Current**:
```ts
type InventoryState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
```

**Suggested**: import `MedicationInventoryState` from `@/generated/prisma/enums` (already used by `state-machine.ts`):
```ts
import type { MedicationInventoryState } from "@/generated/prisma/enums";
```

**LOC delta**: −1 but eliminates a drift surface — adding a fifth state to the schema (Prisma enum) won't update the client union silently.
**Risk**: low — pure type alias, same shape.

---

## Medium

### M1 — `SIDE_EFFECT_CATEGORY_VALUES` / `SIDE_EFFECT_ENTRY_VALUES` duplicate the Prisma enum keys

**Where**: `src/lib/medications/side-effects/validators.ts:18-48`

Both arrays restate the values that already live as the keys of
`SIDE_EFFECT_CATEGORIES` and the entries of `SIDE_EFFECT_ENTRIES_BY_CATEGORY` in `taxonomy.ts`, and as a Prisma enum in `@/generated/prisma/client`.

**Suggested**: derive from the existing constants. The Zod 4 syntax
that the rest of the validator file already uses supports
`z.enum(Object.keys(SIDE_EFFECT_CATEGORIES) as [string, ...string[]])`
or, simpler, `z.nativeEnum(MedicationSideEffectCategory)` from the
generated Prisma enum.

**LOC delta**: −28 (two 14-line arrays collapse to two `nativeEnum` lines).
**Risk**: low — Zod's `nativeEnum` is the documented Prisma-enum bridge.

Bonus: the `taxonomy.test.ts` fixture (`ALL_ENTRIES` / `ALL_CATEGORIES`
at lines 30-60, 23 lines) is then derivable from the same enum, saving
another ~20 LOC of test-time drift surface.

---

### M2 — Three `async function advance()` blocks in onboarding are 95% the same

**Where**: `src/components/onboarding/{GoalsChipPicker.tsx:166-184,SourceCardGrid.tsx:97-115,WelcomeCarousel.tsx:131-149}`

**Current** (sketched):
```ts
async function advance() {
  if (advancing) return;
  setAdvancing(true);
  try {
    const res = await fetch("/api/onboarding/step", { method: "POST", … body: { step: N } });
    if (!res.ok) throw new Error(await readError(res));
    await queryClient.invalidateQueries({ queryKey: ["auth"] });
    router.push(`/onboarding/${N}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : t("onboarding.errorGeneric");
    toast.error(message);
    setAdvancing(false);
  }
}
```

The only variation across the three callers is the step number (2, 3,
4) and the route target.

**Suggested**: `useOnboardingAdvance({ from, to })` hook in
`src/hooks/use-onboarding-advance.ts` returns `{ advance, advancing }`.
The BaselineForm version is a slight superset (it threads through the
profile PUT first) but can compose the hook for the step write.

**LOC delta**: ~−50 across the three callers; one new ~30-line hook.
**Risk**: low — straightforward TanStack Query / router composition, mirrors the existing `useInsightStatus` pattern landed in this same release.

---

### M3 — Three near-identical `<section class="border-border/60 rounded-md border">` headers + content wells

**Where**: `src/components/medications/{TitrationSection.tsx,SchedulingSection.tsx,SideEffectsSection.tsx}` plus the `inventory-section.tsx` disclosure top.

Each section opens with the same shell:
```tsx
<section className="border-border/60 rounded-md border" aria-labelledby="…-heading">
  <header className="flex items-center justify-between px-3 py-2.5">
    <h2 id="…-heading" className="text-foreground/85 text-sm font-medium">{title}</h2>
    …
  </header>
  <div className="border-border/60 border-t px-3 py-3 text-xs">
    {body}
  </div>
</section>
```

**Suggested**: a `<MedicationDetailSection title="…" trailing={…} aria-labelledby={…}>` wrapper composes the three. The TitrationSection / SchedulingSection / SideEffectsSection components shrink to ~80% of their current size since the header + chrome boilerplate drops out.

**LOC delta**: ~−45 across the three sections, plus one new ~30-line wrapper.
**Risk**: low — visual diff should be zero (string-for-string class identical); each section keeps its own body. Worth doing now before the next Wave 4-b section ships and pins a fourth copy.

---

### M4 — `parseDoseMg` / `parseDose` / `parseDoseString` are three near-identical dose-string parsers

**Where**:
- `src/components/medications/DrugLevelChart.tsx:522-527` — `parseDoseMg(input: string): number` (NaN sentinel)
- `src/app/api/medications/[id]/titration/route.ts:140-146` — `parseDoseString(dose: string): number | null` (null sentinel)
- `src/components/medications/medication-form.tsx:200` — `parseDose(dose: string): { amount, unit }` (separate concern: splits the unit; but the numeric extraction overlaps)

**Suggested**: a single `parseDoseMg(input: string | null): number | null` in `@/lib/medications/dose-string.ts` returns `null` on miss (matches the route's contract; the chart can `?? Number.NaN` once at the call site for its NaN-cascade math).

**LOC delta**: −7 net, plus one parser surface to fuzz instead of three.
**Risk**: low — both helpers ship unit tests; merge the test suites.

---

### M5 — `daysRemainingInUse` exists in two places with subtly different signatures

**Where**:
- `src/lib/medications/inventory/state-machine.ts:211-224` (pure, takes `nowMs`, drug-window param, requires full `InventoryItemView`)
- `src/components/medications/inventory-section.tsx:59-68` (client-side, hardcoded `Date.now()`, takes ISO string only)

**Suggested**: extend the pure helper to accept a `firstUseAt: Date | null` signature for the client surface, then drop the duplicate from `inventory-section.tsx`. The client-side reimplementation exists because the pure version requires an `InventoryItemView`; loosen it to `Pick<InventoryItemView, 'firstUseAt'>` and the client can use the canonical helper.

**LOC delta**: −10 net.
**Risk**: medium — the client passes `Date.now()` where the pure helper expects an explicit `asOf`. The reason for the pure-helper signature is testability; preserve it by widening, not narrowing.

---

### M6 — `pairDoses()` sorts twice in 50 lines

**Where**: `src/lib/medications/scheduling/cadence.ts:188-228`

`pairDoses` sorts `slots` by window-centre on entry (line 188-192),
runs the matching loop, then re-sorts the result back to chronological
on exit (line 228). Both sorts are over the same `slots.length`.

**Suggested**: build an index array `[0..slots.length-1]`, sort the
index by window-centre, then iterate the index. Push results into a
pre-allocated `PairedDose[]` at the original slot's index. One sort,
predictable allocations.

**LOC delta**: ~+5 (slightly more code; the optimisation reasoning is
the bigger win for the next maintainer to read).
**Risk**: low — pure rearrangement; well-tested.

Note: low priority unless the cadence chart starts feeling slow on
large windows. Today the window is 30 days × handful-of-schedules so
both sorts are O(n log n) at n≈30 — micro-optimisation. Flagging
because the comment "Restore the chronological order callers expect"
at line 227 reads like a workaround.

---

### M7 — `escalationDue(drugId, currentStep, weeks)` drops `drugId` after the nextStep guard

**Where**: `src/lib/medications/titration/ladder.ts:193-201`

```ts
export function escalationDue(drugId, currentStep, weeksOnStep): boolean {
  if (!currentStep) return false;
  if (!nextStep(drugId, currentStep)) return false;
  return weeksOnStep >= currentStep.typicalWeeks;
}
```

The `drugId` is used only by `nextStep` lookup — `typicalWeeks` is
already on `currentStep`. The signature shape suggests it's load-bearing
when it's a pass-through.

**Suggested**: keep the signature (it's a public API) but rename the
parameter to `drugIdForCeiling: Glp1DrugId` or document the role in the
JSDoc. Today the JSDoc explains *why* but not *what role the param plays*.

**LOC delta**: 0; comment-only.
**Risk**: low — comment polish.

---

### M8 — `for (const [k, v] of Object.entries(rateLimitHeaders(rl)))` pattern across W19 routes

**Where**:
- `src/app/api/medications/[id]/inventory/route.ts:90-92`
- `src/app/api/medications/[id]/side-effects/route.ts:121-123`
- `src/app/api/auth/me/research-mode/route.ts:105-107`

vs. the shorter `{ status: 429, headers: rateLimitHeaders(rl) }`
pattern used in 7+ other routes (e.g. `auth/login/route.ts:33`).

**Suggested**: align the W19c/d/b routes on the existing shorter
construction `apiError("Too many requests", 429, { headers: rateLimitHeaders(rl) })`. Or expose a `rateLimitedError(rl)` helper in `api-response.ts`.

**LOC delta**: −9 across three routes (4-line for-loop → 1-line option).
**Risk**: low — the helper already supports option-bag construction in
the other handlers.

---

### M9 — `goalsStorageKey(userId)` is exported but only one caller imports it

**Where**: `src/components/onboarding/GoalsChipPicker.tsx:94-96, 45`

```ts
export const ONBOARDING_GOALS_STORAGE_PREFIX = "healthlog.onboarding.goals";
export function goalsStorageKey(userId: string): string {
  return `${ONBOARDING_GOALS_STORAGE_PREFIX}:${userId}`;
}
```

Verified: zero importers outside the file (a `grep -rn 'goalsStorageKey'` returns only the declaration site). Likely intended for the BaselineForm to read the goal set on step 3 / 4 — but BaselineForm doesn't read it today.

**Suggested**: either wire BaselineForm to read the persisted set (bundled into the profile PUT or the step:4 write — true follow-up item), or move both names to a non-exported `const` inside the component and ditch the exported helper.

**LOC delta**: small but indicates an incomplete contract.
**Risk**: low. The W14b-Content report mentions this as a v1.4.26 wire-up item — flagging here so it doesn't get forgotten.

---

### M10 — `glp1-pk.ts` exports `shotPhaseAt`, `ShotPhase`, `OneCompartmentOptions`, `PkSample` — zero non-test importers

**Where**: `src/lib/medications/glp1-pk.ts:121, 139, 301, 303`

Module's JSDoc references the dashboard tile "shot phase" chip (research §2.4 / §2.5) as a future caller, but that surface hasn't shipped. Today, only `DoseEvent`, `computeOneCompartment`, and `RESEARCH_MODE_DISCLAIMER_VERSION` are imported across the codebase.

**Suggested**: two options, neither is "delete":
1. **Keep + mark internal**: move `shotPhaseAt` + its types into a `__testables` export bag (the W15 api-handler pattern):
   ```ts
   export const __testables = { shotPhaseAt };
   export type { ShotPhase, PkSample, OneCompartmentOptions };
   ```
2. **Inline the dashboard tile wire-up**: connect the shot-phase chip to the existing `dashboard/glp1-tile.tsx` in a v1.4.26 task. The math is ready; the UI surface is the missing piece.

**LOC delta**: 0 either way; the noise is the public-API surface inflation, not the line count.
**Risk**: low — neither option changes behaviour.

This is the inverse of "dead code" — it's *aspirational* code that was
shipped early and labelled with the right comments. The W18 simplifier
report explicitly handles this kind of scaffolding (`Apply-with-care`
bucket). Defer the decision but pick one before v1.4.26 ships.

---

## Low

### L1 — `inventory/state-machine.ts:180-185` uses nested ternary for outcome classification

```ts
const change: DecrementOutcome =
  nextDosesRemaining === 0
    ? "depleted"
    : wasFirstUse
      ? "first_use"
      : "consumed";
```

Rubric flags nested ternaries. Two levels deep is on the edge. A
`switch (true)` / chained-if would read more linearly. Defer.

### L2 — `DrugLevelChart.tsx:240-264` decision-tree uses a 5-deep ternary

The chart-body switch (`!drugId ? Gated : !gateOpen ? Gated : isLoading ? Loader : !hasDoses ? Empty : Chart`) is exactly the pattern the rubric warns about. There's a comment-block above it that names the five cases verbatim — so the author knew. Replace with an early-return chain or a tiny `switch (true)` for readability. Defer; not buggy.

### L3 — `OnboardingShell.tsx:111` repeats the `clamped === 0 ? 1 : clamped` expression twice

Once in `aria-valuenow`, once in the dot-pager's `aria-current` check. Hoist to a local `currentDotStep` const for symmetry.

### L4 — `cadence.ts` mixes `MS_PER_DAY`, `WEEK_MS`, `DAY_MS` — two of them are the same value

`DAY_MS` (cadence.ts:57) and `MS_PER_DAY` (state-machine.ts:31, glp1-pk.ts uses inline `1000 * 60 * 60`, compliance.ts:41). Five copies of the same constant across the new modules. Hoist to `src/lib/time/constants.ts` (or reuse the existing `@/lib/time/units` if it exists).

Verified at `grep -rn "MS_PER_DAY\|DAY_MS" src/lib/medications` → 5 declarations.

### L5 — `parseDoseString` regex `/[-+]?\d*\.?\d+/` vs `parseDoseMg` regex `/([0-9]+(?:[.,][0-9]+)?)/`

The first does not accept comma-decimals; the second does. The first
matches signs; the second doesn't. They're not interchangeable. M4
above wants one helper — pick the comma-aware regex (German users
log "0,5 mg") and ditch the sign matching (negative doses don't exist).

### L6 — `SideEffectsSection` named in plural but `ScheduleSection` is singular

Naming: `SchedulingSection`, `SideEffectsSection`, `TitrationSection`, `InventorySection`. The plural on side-effects matches the API route (`/side-effects` is plural; `/cadence`, `/titration`, `/inventory` are singular). Consistent enough for now; flag for a v1.5 naming pass if the team adopts a strict singular convention.

### L7 — `OnboardingShell` is a server component but `OnboardingShellProps` is exported as a public type

`src/components/onboarding/OnboardingShell.tsx:33`. Nothing outside the file imports the type today (grep is clean). Drop the `export` modifier to shrink the public surface.

### L8 — `WelcomeCarousel.tsx:48-67` `SLIDES` constant + `CarouselSlide` type are file-private

The slide-list pattern could be the seed for a shared `<Carousel>` primitive if/when a second carousel ships in the app (e.g. Withings onboarding tour). Today it's the only carousel. Flagging only because the W21 brief asks about "three-or-more similar code patterns" — this is just one, so defer.

---

## Test redundancy notes

The new test suites under `src/lib/medications/{scheduling,titration,inventory,side-effects}/__tests__/` are well-organised — each maps one-to-one with the pure module. No double-testing observed.

One observation: `taxonomy.test.ts` re-declares `ALL_ENTRIES` (21 strings) and `ALL_CATEGORIES` (5 strings) at the top, then the test body iterates them to assert every entry maps to a category. This is structurally fine, but the same string lists also appear in `validators.ts` as `SIDE_EFFECT_ENTRY_VALUES` / `SIDE_EFFECT_CATEGORY_VALUES`. If M1 lands (derive validators from the Prisma enum), the test can read from the enum too and drop the literal arrays. Three sources of truth → one.

---

## CSS / Tailwind redundancy

Confirmed by grep — `border-border/60 rounded-md border` (the W19 section shell) appears in 4 places; `border-border/60 border-t` (the section content well) appears in 4 places. See **M3** for the wrapper-component proposal.

The `bg-primary/10 text-primary flex size-16 items-center justify-center rounded-full` (or `size-20` for the done screen) icon-badge appears in:
- `WelcomeCarousel.tsx:195` (size-16)
- `DoneScreen.tsx:33` (size-20)
- `GoalsChipPicker.tsx:233-241` (size-9, plus a checked-state variant)

A small `<IconBadge size="sm|md|lg">` would compose these. Defer — the count is right at the rubric's "three-or-more" floor, and the variations are non-trivial (the GoalsChipPicker version flips colour on the checked state). Re-evaluate if the wizard adds a fifth IconBadge surface.

---

## Prompt / safety-contract redundancy

W19c-Safety added GROUND RULE 15 (`drug-level estimate refusal`) plus
a peer-level `drug_level_refusal` block. Both ship in all six locale
YAMLs with the matching translations.

Per the W21 brief I'm not reviewing prompt *content*. Structurally:
the 15 ground-rules pattern is already a uniform schema (each rule
has `parser_critical`, `surface`, `en`, `<locale>`, `trigger_examples`,
`must_contain`) — that's good. The companion `drug_level_refusal`
block uses a different shape; the YAML schema (`safety-contracts.ts:135`)
already enforces the asymmetry, so this is correct, not redundant.
No findings here.

---

## Files reviewed

Production code (new in v1.4.24..develop):

- `src/lib/medications/glp1-pk.ts` (W19c)
- `src/lib/medications/research-mode-staleness.ts` (W19c-Safety)
- `src/lib/medications/titration/ladder.ts` (W19f)
- `src/lib/medications/scheduling/cadence.ts` (W19e)
- `src/lib/medications/scheduling/compliance.ts` (W19e)
- `src/lib/medications/side-effects/taxonomy.ts` (W19d)
- `src/lib/medications/side-effects/validators.ts` (W19d)
- `src/lib/medications/inventory/state-machine.ts` (W19b carry-over surface)
- `src/lib/medications/inventory/service.ts`
- `src/app/api/medications/[id]/titration/route.ts`
- `src/app/api/medications/[id]/cadence/route.ts`
- `src/app/api/medications/[id]/side-effects/route.ts`
- `src/app/api/medications/[id]/inventory/route.ts`
- `src/app/api/auth/me/research-mode/route.ts`
- `src/app/api/onboarding/step/route.ts`
- `src/components/medications/TitrationSection.tsx`
- `src/components/medications/SchedulingSection.tsx`
- `src/components/medications/SideEffectsSection.tsx`
- `src/components/medications/inventory-section.tsx`
- `src/components/medications/DrugLevelChart.tsx`
- `src/components/medications/ResearchModeAcknowledgmentDialog.tsx`
- `src/components/onboarding/OnboardingShell.tsx`
- `src/components/onboarding/WelcomeCarousel.tsx`
- `src/components/onboarding/GoalsChipPicker.tsx`
- `src/components/onboarding/SourceCardGrid.tsx`
- `src/components/onboarding/BaselineForm.tsx`
- `src/components/onboarding/DoneScreen.tsx`
- `src/components/settings/advanced-section.tsx`
- `src/hooks/use-insight-status.ts` (W18 deliverable)

Wave 5 deliverables sampled:

- `src/lib/api-handler.ts` (W7d hardening + `__testables` pattern)
- `src/lib/tz/format.ts` + `src/lib/tz/resolver.ts` (W7d client-bundle split)
- `src/components/settings/sources-section.tsx` (W18 `reorderLadder` helper)
- W15 i18n cleanup (380 dead keys removed) and W15 dead-prompt-constants removal — clean, no findings.
- W20-rest P6 polish (a11y/aria + chart token fixes) — clean.

Tests sampled:

- `src/lib/medications/__tests__/glp1-pk.test.ts`
- `src/lib/medications/__tests__/research-mode-staleness.test.ts`
- `src/lib/medications/scheduling/__tests__/cadence.test.ts`
- `src/lib/medications/scheduling/__tests__/compliance.test.ts`
- `src/lib/medications/titration/__tests__/ladder.test.ts`
- `src/lib/medications/inventory/__tests__/state-machine.test.ts`
- `src/lib/medications/inventory/__tests__/service.test.ts`
- `src/lib/medications/side-effects/__tests__/taxonomy.test.ts`

Safety contracts (structural review only):

- `src/lib/ai/prompts/safety-contracts.ts`
- `src/lib/ai/prompts/safety-contracts.{en,de,fr,es,it,pl}.yaml`

---

## Closing

Top finding to act on next: **H2 — drop `templateFill` in
TitrationSection.tsx**. The `t()` context already does
`{param}` substitution; the local helper is silent-fallback drift bait.
Two-line fix, no tests need to change.

Runners-up worth picking up in the W21-reconcile fix pass:

- **H1** (onboarding `readError`) — four files, mechanical extraction.
- **H6** (`assertMedicationOwnership`) — 11 callsites; high signal, medium effort, defers nicely to a v1.4.26 cleanup task if the reconcile budget runs tight.
- **M3** (`<MedicationDetailSection>` wrapper) — sets the right pattern before W19g (if it lands) or v1.5 adds a fifth detail-page section.
- **M10** (`glp1-pk.ts` unused exports) — needs a decision call (internalise vs ship dashboard chip), not a refactor.

No findings I'd consider release-blocking. The Wave-4b medication
work in particular is well-decomposed (pure modules + thin routes +
read-only sections) — the duplications listed above are the kind that
emerge naturally when three sibling features ship in close succession,
not signs of a structural problem.
