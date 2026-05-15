# v1.4.27 R4 — Code Review Report

**Range:** `v1.4.26..617d4518` (~97 commits, ~19 k LOC added, ~3 k LOC removed)
**Reviewer pass:** read-only senior-developer audit, no fixes applied
**Focus areas (per directive):** bug surfaces / API contract / architectural drift

---

## Summary of findings by severity

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 4     |
| Medium   | 8     |
| Low      | 7     |

Headline observations. The round shipped a coherent mobile-first pass — the new `<ResponsiveSheet>`, `<NativeSelect>`, `<Popover>`, `<Checkbox>`, and `<CoachLaunchProvider>` primitives are small, tested, and largely free of obvious defects. The bulk of the risk is concentrated in three places: (1) the new `GET /api/workouts` route's pagination contract is broken under dedup pressure, (2) `<ResponsiveSheet>` discards children on viewport-cross-of-`md`, (3) `useIsMobile` has an SSR/first-paint gap that mid-tree primitives now consume. Notes below sized to be actionable without nitpicks.

---

## HIGH

### H1. `GET /api/workouts` pagination is incorrect under canonical-dedup

* **Severity:** High
* **File:** `src/app/api/workouts/route.ts:55-142`
* **Symptom:** Pages beyond the first lose canonical rows that the previous page dropped as duplicates, and `meta.total` is wrong.
* **Evidence:**
  * The handler reads `rawTake = limit * FETCH_MULTIPLIER` rows with `skip: offset` (line 100-104).
  * `pickCanonicalWorkout()` collapses the window in-memory, then `page = canonical.slice(0, limit)` returns the first `limit` of the de-duplicated result (line 130).
  * For `offset=50, limit=50`: the route reads rows 50..149, dedupes that window, and returns at most 50 canonical rows starting from raw-row 50. Any canonical row whose first-cluster member sits in raw-rows 0..49 (returned by page 1) AND whose later cluster member sits in raw-rows 50..149 is therefore double-counted or — worse — the per-page dedup runs in isolation, so the boundary clusters that span pages get duplicated across two pages.
  * `meta.total` is set to `canonical.length` (line 135), which is only the de-duplicated count of the **current fetch window**, not the user's true canonical total. The iOS sync cursor and the future `/workouts` list view cannot paginate correctly off this number.
* **Recommended fix:** Either (a) compute the canonical projection once at write time (Workout.canonical bool column or a materialised view) and read directly from it with normal `skip`/`take`, or (b) keep the runtime dedup but anchor each page on a `(startedAt, id)` cursor and run the picker on a deterministic over-fetch window large enough to fully resolve the cluster (e.g. `proximityMinutes * 2` look-ahead), then return `nextCursor` instead of `offset`. Drop `meta.total` until one of those is in place — exposing a wrong count is worse than no count.
* **Effort:** Half a day for the cursor variant; ~1 day plus a migration for the column variant.

### H2. `<ResponsiveSheet>` unmounts its children on viewport-cross-of-`md`

* **Severity:** High
* **File:** `src/components/ui/responsive-sheet.tsx:94-194`
* **Symptom:** Rotating a tablet across the 768 px breakpoint mid-edit drops every controlled-input value inside the sheet (medication form, measurement form, GLP-1 intake import). The form re-mounts as either a `<Sheet>` or a `<Dialog>` depending on `isMobile`; the two branches are different Radix roots, so React unmounts the previous subtree.
* **Evidence:** The component returns from inside an `if (isMobile)` block (line 96) with `<Sheet>...</Sheet>` vs `<Dialog>...</Dialog>` on the other side (line 158). Both branches mount a fresh `<DialogPrimitive.Root>` / `<SheetPrimitive.Root>`. React's reconciler treats them as distinct trees by type, so the children re-mount and lose internal `useState`.
* **Repro:** Open `/measurements`, click *Add measurement*, type a value, rotate the iPad from portrait (md-) to landscape (md+). Field clears.
* **Recommended fix:** Hoist the form state up to the page (controlled inputs from outside the sheet) OR refactor the primitive so the form lives in a stable subtree and only the surrounding chrome (Sheet vs Dialog) swaps. A small "stable inner content" wrapper that both branches mount the children inside via `<Slot>` would close it without leaking the chrome into every caller.
* **Effort:** ~1 day across the four current consumers (measurement, medication, intake, settings).

### H3. `useIsMobile` returns `false` on every SSR render and on first client paint

* **Severity:** High
* **File:** `src/hooks/use-is-mobile.ts:20-37`
* **Symptom:** The hook is documented to return `false` until the `useEffect` tick runs, then flips. Two new primitives consume it (`<ResponsiveSheet>`, `<CoachDrawer>`) and now decide *what tree to render* off the value. On phone-class viewports the first paint of either primitive renders the desktop branch, then immediately swaps to the mobile branch on the effect tick. The swap is a full tree replacement (see H2) — every controlled input inside the freshly-opened sheet/drawer flashes through desktop layout for one paint and then unmounts. On the Coach drawer the side flips from `right` to `bottom` between the first and second paint, producing a visible jump.
* **Evidence:**
  * `use-is-mobile.ts:21` initialises `useState<boolean>(false)`.
  * The matchMedia listener fires inside `useEffect` so the initial paint is locked at `false`.
  * Both `<ResponsiveSheet>` (line 94) and `<CoachDrawer>` (line 142) read the value at the top level of render and switch branches off it.
* **Recommended fix:** Use `useSyncExternalStore` with a SSR snapshot of `false` and a client snapshot read from `window.matchMedia(...).matches` on first render. This gives a stable client value on the very first paint and matches the standard React 18 pattern for media-query subscriptions. Pair with H2 so the tree no longer re-mounts on viewport boundaries.
* **Effort:** ~2 hours for the hook itself; covers H2 once the children-stability fix lands.

### H4. `<CoachDrawer>` flips `side` prop on the same Radix root — no slide animation, instant layout swap

* **Severity:** High
* **File:** `src/components/insights/coach-panel/coach-drawer.tsx:264-298`
* **Symptom:** The drawer's `<Sheet>` root stays mounted across the `sm` boundary, but `side={isPhoneViewport ? "bottom" : "right"}` flips the position classes on `<SheetContent>`. Radix derives its slide-in animation from `data-state=open` — that attribute does not change on viewport-cross, so the new branch's `data-[state=open]:slide-in-from-bottom` selector never re-fires. The user sees the drawer instantly jump from the right edge to the bottom edge of the viewport without any transition. Worse, the drawer's content height (`h-[95dvh]` vs `h-[100dvh]`) flips at the same moment, producing a layout reflow under any open keyboard.
* **Evidence:** `coach-drawer.tsx:270` sets `side={isPhoneViewport ? "bottom" : "right"}`. The Sheet primitive `cn(...)` (sheet.tsx:62-72) renders all four side branches under a single content element whose `data-state` does not re-key.
* **Recommended fix:** Render the drawer with `key={isPhoneViewport ? "phone" : "desktop"}` on the `<Sheet>` root so Radix gets a fresh mount on viewport-cross — accept the brief unmount in exchange for a clean slide-in. Alternatively, mount two `<Sheet>` instances side-by-side and gate them by the breakpoint at the JSX level. The current single-instance form is the worst of both: tree continuity without animation continuity.
* **Effort:** ~3 hours including a unit test mocking matchMedia.

---

## MEDIUM

### M1. Stale `CRITICAL` comment in `InsightsLayoutShell` contradicts the new mount site

* **Severity:** Medium
* **File:** `src/components/insights/insights-layout-shell.tsx:28-31`
* **Symptom:** The JSDoc reads `CRITICAL — the <CoachDrawer> does NOT mount here. It lives only in src/app/insights/page.tsx body`. R3d MB4 promoted the drawer to `layout.tsx` via `<LayoutCoachMount>` (commit `246c1def`). The comment now actively misleads contributors.
* **Recommended fix:** Replace the paragraph with the new mount story (provider + mount in the layout, every routed surface owns a `<CoachLaunchButton>`).
* **Effort:** 5 minutes.

### M2. `dispatch-localised.ts`, `telegram/test/route.ts`, and `admin/notifications/test/route.ts` each carry a private `isLocale` clone

* **Severity:** Medium
* **Files:**
  * `src/lib/notifications/dispatch-localised.ts:54-57`
  * `src/app/api/settings/telegram/test/route.ts:11-14`
  * `src/app/api/admin/notifications/test/route.ts:64-67`
  * A fourth canonical version lives at `src/lib/i18n/server-locale.ts:7`.
* **Symptom:** All three new copies enumerate the six-locale literal manually. Adding a seventh locale (planned per `messages/` audit) requires four edits and the lint chain doesn't enforce it.
* **Recommended fix:** Export `isLocale` from `src/lib/i18n/config.ts` (next to `defaultLocale`) and import it from the three call-sites + the existing `server-locale.ts`. Locale-typeguard is a single place.
* **Effort:** ~30 minutes.

### M3. `safeRequestProp` console warning gate uses `NODE_ENV !== "test"`, but production-only would be safer

* **Severity:** Medium
* **File:** `src/lib/api-handler.ts:81-96`
* **Symptom:** Every fallback path now logs `[api-handler] safeRequestProp fallback — tolerable error: ...` to the dev console. In dev that's fine; in production this writes one stderr line per affected request. The known callers (vitest direct-invoke + force-static placeholders) are quiet, but anything inside the tolerated-error set will flood production logs the moment a bot scanner triggers the placeholder path.
* **Evidence:** Line 87 reads `if (process.env.NODE_ENV !== "test")` — production passes the gate. Comment on line 84-86 admits the intent is "show up in the dev console + the run log", suggesting Marc wants dev-only behaviour.
* **Recommended fix:** Change to `process.env.NODE_ENV === "development"` so production stays silent. If ops triage requires production breadcrumbs, route through `getEvent()?.addWarning(...)` instead of `console.warn` so it lands in the Wide Event payload with redaction.
* **Effort:** 5 minutes.

### M4. `proxy.ts` admits `/about-us`, `/about.json`, etc. via `pathname.startsWith("/about")`

* **Severity:** Medium
* **File:** `src/proxy.ts:11-39, 50-55`
* **Symptom:** The new `/about` entry uses the loose `startsWith` form. v1.4.22 W5 already retrofitted `/onboarding` to an exact-match branch precisely to close this kind of overshoot (`/onboarding-export` etc.). The same overshoot is back for `/about`.
* **Evidence:** Line 35 adds `"/about"`. Line 54 runs `PUBLIC_PATHS.some((p) => pathname.startsWith(p))` — so `/about-page-that-leaks-data` would be public.
* **Recommended fix:** Lift `/about` into the `isPublicPath` exact-match branch alongside `/onboarding` (line 51), or add a trailing slash + an explicit terminal `/about` literal entry.
* **Effort:** 10 minutes.

### M5. `parseTimeToMinutes` returns `0` instead of bailing on malformed schedule strings

* **Severity:** Medium
* **File:** `src/app/api/admin/notifications/reminder-check/route.ts:11-17`
* **Symptom:** A malformed `windowEnd` (e.g. `"x:30"`) silently parses to `0` minutes after midnight. The next conditional `currentMins <= endMins` becomes "any time past midnight is overdue", so the route would fire a "missed" Telegram alert for every active medication.
* **Evidence:** Lines 13-16 `if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;` — but the natural sentinel is `NaN` so the comparisons downstream short-circuit to `false`.
* **Recommended fix:** Return `null` (and skip the schedule if either end is null), or throw a clear error so the bug surfaces at write time rather than at midnight.
* **Effort:** 1 hour incl. test.

### M6. `<ResponsiveSheet>` portals + nested `<Sheet>` create overlay stacking ambiguity inside `<CoachDrawer>`

* **Severity:** Medium
* **File:** `src/components/insights/coach-panel/coach-drawer.tsx:493-555`
* **Symptom:** The Coach drawer is itself a `<Sheet>`, and it now mounts three child `<Sheet>` instances (history tray, sources tray, plus the existing `<CoachSettingsSheet>`). Every child uses `<SheetPrimitive.Portal>` which renders into `document.body`, so on phone-viewports the trays paint **on top of** the bottom-sheet drawer rather than inside it. The current z-index strata (`z-50` everywhere) means the last-mounted portal wins; the order is render-order-dependent, not state-dependent.
* **Recommended fix:** Either (a) move the trays inside the drawer's own portal subtree (Radix accepts a `container` prop on Portal), or (b) collapse the trays into in-flow `<aside>` slide panels when the drawer is on the bottom-sheet branch. The current behaviour is correct on desktop but visually inconsistent on phones — the user sees a left-edge tray slide in from outside the bottom-sheet bezel.
* **Effort:** ~3 hours.

### M7. `Glp1Tile` range-points → hours cap silently coerces "All" to 365 d

* **Severity:** Medium
* **File:** `src/components/dashboard/glp1-tile.tsx:60-64`
* **Symptom:** `rangePointsToHours(0)` returns `365 * 24`. The button label says "All" (`t(preset.labelKey)`), but the drug-level chart sees a 365-day window. A user on a 18-month titration history sees their first 6 months silently dropped — there is no UI hint that the cap kicked in.
* **Evidence:** Line 61-64. The comment admits the cap is intentional ("past that point the unit-less curve flattens to invisibility"), but the user is never told.
* **Recommended fix:** Either rename the preset label to "1 year" when `points === 0` is mapped through this helper, or paint a small "history truncated at 12 mo" caption under the chart when the underlying medication started > 365 d ago.
* **Effort:** 1 hour.

### M8. `meta.total` mismatch (alias of H1) leaks into the iOS sync DTO

* **Severity:** Medium
* **File:** `src/app/api/workouts/route.ts:131-141`
* **Symptom:** Pinned here because the iOS workout list view will consume `meta.total` directly to paint a "Showing N of M" footer. With the dedup contract above, M is wrong from the first page. The iOS side has no way to detect the discrepancy and would render a confusing "showing 50 of 0" once dedup outpaces the page size.
* **Recommended fix:** Same as H1; pinned separately because the iOS contract should stop relying on `meta.total` until the underlying pagination is sound. A short-term mitigation: omit the field from the envelope when dedup occurred (`droppedDuplicates > 0`).
* **Effort:** Covered by H1.

---

## LOW

### L1. `measurements/page.tsx` `ALLOWED_ADD_TYPES` lists four type strings that no `MeasurementForm` entry recognises

* **Severity:** Low
* **File:** `src/app/measurements/page.tsx:19-28`
* **Symptom:** `BMI`, `GLUCOSE`, `TEMPERATURE`, `HEART_RATE`, `BODY_FAT` either don't exist in `MEASUREMENT_TYPES` (form uses `BLOOD_GLUCOSE`, has no `TEMPERATURE`, no `HEART_RATE`, no `BMI`) or — for `BODY_FAT` — do exist but no caller links there. The empty-state CTAs only use `BLOOD_PRESSURE`, `WEIGHT`, `PULSE`. The dead allow-list rows are confusing but not harmful (`ALLOWED_ADD_TYPES.has(addParam)` short-circuits on the form side anyway).
* **Recommended fix:** Trim the allow-list to the three live CTAs, or extend `MEASUREMENT_TYPES` if those four are intended additions.
* **Effort:** 10 minutes.

### L2. `auditLog` Promise.race timeout fires `setTimeout` without `unref`

* **Severity:** Low
* **File:** `src/lib/auth/audit.ts:28-30`
* **Symptom:** Every auth audit row spawns a 3 s `setTimeout`. The race resolves on whichever fires first, but the timer handle is not `unref`'d, so a vitest test that exits before the timer drains keeps Node alive until the timer expires. Production processes are unaffected.
* **Recommended fix:** Wrap as `const t = setTimeout(...); t.unref?.()` so test runners exit promptly.
* **Effort:** 5 minutes.

### L3. `<NativeSelect>` defaults to no `name` attribute → `<form>` submission omits the value

* **Severity:** Low
* **File:** `src/components/ui/native-select.tsx:35-51`
* **Symptom:** The new primitive forwards props but adds no default `name`. Three migrated call-sites (`AccountSection`, `TimezonePicker`, `GeneralSettingsSection`) already pass `name`; future consumers who copy the primitive's JSDoc and forget to pass it ship a native select that the browser will not include in form submission. The current call-sites are all controlled, so this is latent.
* **Recommended fix:** Add a doc warning in the JSDoc, or warn at runtime in dev when `name` and `onChange` are both absent.
* **Effort:** 15 minutes.

### L4. `<CoachLaunchButton>` renders two DOM nodes (FAB + inline) on every page

* **Severity:** Low
* **File:** `src/components/insights/coach-launch-button.tsx:50-92`
* **Symptom:** Both buttons sit in the DOM (gated by `lg:hidden` / `hidden lg:inline-flex`). Each sub-page mounts the component, so the document carries one extra hidden button per sub-page route. Visual impact is zero; the extra node makes the a11y tree slightly noisier for assistive tech that doesn't honour `hidden`. Trivial.
* **Recommended fix:** Use `useIsMobile("lg")` to render only the active branch. Bonus: closes the same SSR-flash that H3 calls out for the larger primitives.
* **Effort:** Covered by H3.

### L5. `<Popover>` content tap-outside dismiss conflicts with the surrounding `<form onSubmit>` on the composer

* **Severity:** Low
* **File:** `src/components/insights/coach-panel/coach-input.tsx:175-271`
* **Symptom:** Tapping the Info icon opens the popover. Tapping outside it (e.g. the textarea) dismisses it. If the dismiss path bubbles through the textarea, the `<form onSubmit>` does not fire (no submit gesture happens), so the bug is latent. Worth a manual check on touch: the Radix Popover trigger uses `onPointerDown` to toggle; a quick double-tap may trigger an unintentional submit if Radix's default `data-state` handling collides with the form's `Enter` handler. Tap behaviour on iOS Safari is what the round was tightening, so a smoke test on the device would close the loop.
* **Recommended fix:** Manual touch test pass; add `event.stopPropagation()` on the popover trigger if the dismiss bubble reaches the textarea.
* **Effort:** 20 minutes.

### L6. `compliance-heatmap.tsx` outside-click listener uses capture-phase `pointerdown`

* **Severity:** Low
* **File:** `src/components/charts/compliance-heatmap.tsx:100-113`
* **Symptom:** The listener is registered with `capture: true` (third arg). A parent component that wires its own `pointerdown` handler (e.g. a parent Sheet for swipe-to-close) would race the heatmap's listener. Today no such parent exists; flagged for the day someone wraps the heatmap in a swipeable card.
* **Recommended fix:** Drop the capture flag — bubble-phase is enough for an "outside container" check and matches the convention used elsewhere in the codebase.
* **Effort:** 5 minutes.

### L7. `CoachLaunchProvider` accepts a `scope` parameter but the doc says "ignored in v1.4.27" — surface area without behaviour

* **Severity:** Low
* **File:** `src/lib/insights/coach-launch-context.tsx:33-73`
* **Symptom:** The provider accepts `scope?: CoachLaunchScope` on `askCoach()` but the implementation explicitly `void scope` and ignores it. Consumers can pass it today and silently get no effect. The intent is forward-compat for v1.4.28; in the interim, anyone wiring a call site has no way to tell from the type system that the parameter is a no-op.
* **Recommended fix:** Either remove the parameter (re-add when v1.4.28 wires it) or rename to `_scopeReservedForV1428` so the TypeScript signature warns at the call site.
* **Effort:** 5 minutes.

---

## Architectural notes (not findings, but worth recording)

* **`<ResponsiveSheet>` is the right primitive but mis-sized.** A shared mount that flips between Sheet and Dialog is the correct shape; the issue is just that the swap is implemented as a tree-level branch rather than a chrome-level branch. Once H2 is closed, the primitive is a keeper. Four consumers today, easy to grow.
* **`<NativeSelect>` is a clean DRY win.** Three drift-prone copies collapsed to one styled forwardRef; nothing fancy.
* **`<Popover>` joining the primitive set is sensible.** The motivation (Radix `<Tooltip>` doesn't tap-toggle on touch) is correct. Limited surface (one consumer in the composer hint today) keeps risk low.
* **`<Checkbox>` shadcn primitive landed cleanly.** Single consumer (`<SourcesRail>`), proper `radix-ui` integration, focus ring and 44 px hit slot present.
* **`<CoachLaunchProvider>` solves the v1.4.26 regression where sub-pages couldn't reach the Coach.** Mount site (`/insights/layout.tsx`) is correct. The provider state survives navigation between routed sub-pages but is dropped on `/insights` leave — this matches the intended scope (Coach is an Insights-area feature). One quirk: the drawer keeps its conversation id across sub-page nav, so a user mid-conversation who jumps to a sub-page does NOT lose context. That's a small but real UX upgrade.
* **`prisma/migrations/0061_audit_log_carrier`** is idempotent (`ADD COLUMN IF NOT EXISTS`) and consistent with v1.4.25's `0058_user_research_mode` pattern. No schema concerns.
* **Test contract changes.**
  * `insights-card.test.tsx` was deleted (158 lines) in favour of two new files (`insight-status-card.test.tsx`, `insights-tab-strip.test.tsx`). The old test's coverage is preserved — confirmed by the new files' assertion count.
  * `withings/__tests__/sync-{activity,sleep}.test.ts` were extended for the scope-skip path (`parkIntegrationAtReauth`); no contract removal.
  * `audit.test.ts` extended for the new ASN/carrier branch; pre-v1.4.27 expectations preserved.

## Out-of-scope observations (record only, no action)

* The 414-key i18n strip in commit `2960f735` flagged in the marathon log was a deliberate dead-key sweep; the new `i18n-drift-guard.test.ts` pins the new required keys per locale and is a sound safety net for the next round.
* The new `CHART_RANGE_PRESETS` constant module (`src/lib/charts/constants.ts`) consolidates four duplicated preset lists; clean DRY win.

---

*End of v1.4.27 R4 report.*
