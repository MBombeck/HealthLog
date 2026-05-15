# R4 senior-dev architectural review — v1.4.27

Read-only review of the v1.4.27 MB1-MB7 surface on `develop` (HEAD
`617d4518`). Scope frame from the dispatch directive; severity tiers
follow `BLOCKER` → `HIGH` → `MED` → `LOW` → `NIT` with the v1.4.28
backlog as the deferral target for non-blocking items.

Conventions observed end-to-end: no forbidden vocabulary, Marc-voice
English, no PII. The review prose follows the same conventions.

## Summary

The MB1-MB7 work is structurally sound. The new primitives compose with
the existing shadcn vocabulary, the SSR-safe hooks degrade correctly,
the migration is idempotent, and the context-based Coach launch model
removes the sub-page unmount bug cleanly. The findings below are
**zero blockers, two HIGH, four MED, six LOW**, plus one annotation
that should land in the CHANGELOG.

The single most consequential finding is **HIGH-1 (ResponsiveSheet
footer slot under-used)** — every call site outside `export-section`
inlines the form footer into the body instead of feeding it through the
`footer` prop, so the sticky-pinned bottom rail the primitive promises
on the Sheet branch only paints empty. The fix is a 5-minute swap per
call site and lifts the actual UX promise to where the primitive's
JSDoc and tests already claim it lives.

---

## BLOCKER

(none)

---

## HIGH

### HIGH-1 — `<ResponsiveSheet>`'s sticky footer rail is dead code on every consumer except `export-section`

**Where:** every ResponsiveSheet call site:
- `src/app/page.tsx:523, 533`
- `src/app/measurements/page.tsx:92`
- `src/app/mood/page.tsx:51`
- `src/app/medications/page.tsx:261`
- `src/components/medications/SideEffectsSection.tsx:327` (inline footer at line 462)
- `src/components/medications/inventory-section.tsx:429` (inline footer at line 512)
- `src/components/medications/intake-history-list.tsx:539, 687`

**Symptom:** the primitive's docstring (`responsive-sheet.tsx:71-75`) and
smoke suite both pin a sticky-pinned `<SheetFooter>` on the Sheet
branch so primary CTAs stay reachable when the keyboard collapses the
viewport. That's the entire point of the bottom-sheet bias on mobile.
None of the call sites listed above pass a `footer={…}` prop. They
inline the Save / Cancel row inside the `children` body. The body has
`overflow-y-auto` (line 138 of the primitive), so on phones the CTA row
scrolls **away** under the keyboard exactly like the pre-MB1 baseline.

`grep -rn "footer=" src --include="*.tsx"` in this tree returns four
hits, all in `src/components/settings/export-section.tsx` — and that
file does not use `<ResponsiveSheet>` at all (the `footer` token there
binds to a different component).

**Fix:** the form-owner moves the footer JSX out of the form body and
passes it through `footer={…}`. The `<form>` tag stays in the body
because the `Save` button has `type="submit"` and form-association
crosses sticky-pinning fine when the submit button shares the same form
ancestor. Either move the `<form>` to wrap the whole `<ResponsiveSheet>`
or use `form="<id>"` on the submit button. Five call sites; ~80 lines
moved total.

**Impact:** the WCAG 2.5.5 floor work + the rest of MB1's mobile
narrative banks on this. Today the floor is correct but the rail is
unreachable when the keyboard is up — same UX class the lift was meant
to retire.

**Tier:** HIGH because the primitive ships a contract its consumers
silently violate. The fix is mechanical, not architectural; v1.4.28
W1a candidate.

### HIGH-2 — `<ResponsiveSheet>` mounts Sheet AND Dialog at the breakpoint boundary, losing focus + scroll position on viewport rotation

**Where:** `src/components/ui/responsive-sheet.tsx:96, 158`

**Symptom:** the primitive's render branch is a hard `if (isMobile)
return <Sheet>…; return <Dialog>…;`. Both branches are full Radix
portal mounts. When the viewport crosses 768 px (tablet rotation, browser
window resize, devtools toggle) `useIsMobile` flips and React unmounts
one tree and mounts the other.

For an open ResponsiveSheet that means:
- input focus is lost (the focused element is unmounted)
- a partially-scrolled body resets to the top
- a half-typed `<textarea>` value is preserved only because every
  consumer holds the value in React state, not the DOM — but that's a
  consumer-side rescue, not a primitive guarantee

**Fix proposals (pick one for v1.4.28):**
1. Lock the branch at first mount: `const [isMobile] = useState(() =>
   useIsMobile())` so the chosen mount survives rotation. Trade-off:
   a user who rotates while the sheet is open keeps the wrong layout
   for that session. Acceptable for the dominant use case (rotation
   while a sheet is open is rare).
2. Match-route the same `<DialogPrimitive.Root>` against a different
   `<Content side=…>` driven by Tailwind responsive classes, so the
   tree never unmounts. Higher refactor cost; better UX.

**Tier:** HIGH because the breakage class (focus loss, scroll reset) is
visible on a documented user flow (iPad portrait → landscape with the
quick-entry sheet open). Not a v1.4.27 blocker because the trigger is
narrow; flag for v1.4.28.

---

## MED

### MED-1 — Three remaining raw `<select>` blocks bypass `<NativeSelect>`

**Where:** `src/components/settings/ai-section.tsx:370, 823, 1008`

**Symptom:** MB7 / CF-52 consolidated three Settings native pickers
behind the shared `<NativeSelect>` primitive
(`src/components/ui/native-select.tsx`) to retire the drifting
`NATIVE_SELECT_CLASS` triplet. Three more raw `<select className="…">`
still live in `ai-section.tsx`. The classNames differ from the primitive
(`mt-1 h-9 w-full rounded-md border px-3 text-sm sm:max-w-md` vs the
primitive's `flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs
transition-[color,box-shadow]…`). That's exactly the drift the
primitive was introduced to cure.

**Fix:** swap to `<NativeSelect>` and add `mt-1 sm:max-w-md` via
`className`.

**Tier:** MED — visual drift Marc has already declared a bug class
in MB7; not a regression in this release but the primitive's purpose is
defeated as long as these three lag.

### MED-2 — `CoachLaunchScope` parameter is silently dropped today; no schema lock for v1.4.28

**Where:** `src/lib/insights/coach-launch-context.tsx:33-73`

**Symptom:** `askCoach(prefill, scope?)` accepts the scope arg and
explicitly `void scope`s it, documenting that v1.4.28 will pre-narrow
the sources rail. Good forward-compat shape, but:
1. The `CoachLaunchScope` type is `{ metric?: string }` — `string` is
   not narrowed to the metric-key union the sources rail consumes
   (`CoachScopeSource`). When v1.4.28 wires it up the call sites can
   already pass any string and only typecheck against `string`.
2. No call site passes scope today (`grep "askCoach\(" src` returns 4
   call sites; all single-argument). Zero usage, zero compile-time
   pressure to keep the contract honest.
3. The `scope?.metric` shape will not survive contact with a "narrow to
   medication + mood" multi-source request, which the v1.4.28 plan
   already hints at.

**Fix for v1.4.27:** tighten `metric?: string` to the existing
`CoachScopeSource` (or `CoachScopeSource[]`) type imported from
`@/lib/ai/coach/scope` (or wherever it lives) so the future wiring is
type-locked.

**Tier:** MED — forward-compat hazard, no runtime cost today.

### MED-3 — `<ResponsiveSheet>` Dialog branch ignores `bodyClassName` for the footer; visual drift between branches

**Where:** `src/components/ui/responsive-sheet.tsx:179-191`

**Symptom:** the Sheet branch's footer uses
`sticky bottom-0 mt-0 flex-row justify-end gap-2 border-t bg-background/95
backdrop-blur supports-[backdrop-filter]:bg-background/80`. The Dialog
branch's footer is `<DialogFooter>` with no class override. They render
visually different on a tablet portrait that just crossed 768 px going
wider — a different border, a different background. The
`data-slot="responsive-sheet-footer"` selector is identical on both
branches so test assertions against the slot pass uniformly even though
the visual contract diverges.

**Fix:** either pull a shared `RESPONSIVE_SHEET_FOOTER_CLASS` constant
out so both branches stay synchronized, or document the divergence in
the primitive's JSDoc as intentional (the smoke suite already pins this
shape at line 173-188 of the test file).

**Tier:** MED — visual drift class; same primitive Marc just introduced
to cure visual drift elsewhere.

### MED-4 — Empty-state Insights sub-pages drop the Coach launch surface

**Where:** every `/insights/{metric}/page.tsx` empty branch — confirmed
in `blutdruck/page.tsx:77-92`, `gewicht/page.tsx:75-…`, etc.

**Symptom:** when the user has zero observations for a metric, the
sub-page short-circuits to a `<SubPageShell>` + `<EmptyState>` and
**does not** mount the `<CoachLaunchButton>`. The Coach is reachable
from the layout's drawer mount, but the sticky FAB / inline-button pair
on the populated branch is the only visible entry point on these pages.
The empty branch leaves an unauthenticated-feeling page with one CTA
("add a measurement") and no path to the Coach who can explain *why*
adding the measurement matters.

The mother `/insights/page.tsx` empty branch (line 140-155) does the
same thing — Coach-less.

This is the directive's "fallback CTA" question: today there is no
secondary fallback. The empty-state is a single-CTA dead-end.

**Fix proposal (v1.4.28):** add `<CoachLaunchButton />` below the
`<EmptyState>` action so a user with zero data still has one tap to
"ask the coach why blood pressure matters at my age". The Coach drawer
already handles zero-data conversations (it just acknowledges the lack
of data and falls back to general guidance).

**Tier:** MED — explicit directive question, not a regression but a
deliberate one-CTA call. Worth promoting to v1.4.28 if Marc agrees the
Coach is the secondary CTA on these pages.

---

## LOW

### LOW-1 — `useIsMobile` SSR-default biases mobile users toward a desktop first paint

**Where:** `src/hooks/use-is-mobile.ts:21`

**Symptom:** the hook returns `false` on the server **and** the first
client render (`useState<boolean>(false)`). The effect then flips to the
live value on the next tick. For a mobile user this means:
1. Server renders the Dialog branch (centred, sm:max-w-md).
2. Client hydrates that markup.
3. Effect runs, hook returns `true`, Dialog branch unmounts, Sheet
   branch mounts.

Mobile users see one frame of the desktop variant before it flips. The
visible flash is short (the effect runs synchronously after hydration)
but it's there, and on a cold cache it's noticeable enough to matter
for the "feels native" bar Marc set for v1.4.27.

**Fix:** either accept the trade-off (the hook's doc-comment explicitly
calls it out as the SSR-vs-flash trade), or read `navigator.userAgent`
on first paint in a `useSyncExternalStore` wrapper so the initial value
matches the live viewport. The `useSyncExternalStore` pattern keeps SSR
markup deterministic while the client's first paint reads the live
state.

**Tier:** LOW — known trade-off; not a regression; the SSR-safe path
is the right default for HealthLog's auth-gated SPA where most surfaces
mount inside `"use client"` islands.

### LOW-2 — `Checkbox`'s `onCheckedChange` boolean type bleeds the Radix `boolean | "indeterminate"` union to consumers

**Where:** `src/components/ui/checkbox.tsx`, consumed at
`src/components/insights/coach-panel/sources-rail.tsx:249`

**Symptom:** the consumer calls `onCheckedChange={() => toggleSource(row.key)}`
ignoring the value. The Radix `onCheckedChange` signature is
`(checked: boolean | "indeterminate") => void`. The checkbox can never
actually emit `"indeterminate"` here (no state pushes it there), so the
consumer pattern is safe, but the type-narrowing is asymmetric: if a
future consumer reads `checked` and forwards to `setState<boolean>` they
need to narrow.

**Fix:** consumers in v1.4.27 are clean; for v1.4.28 (or whenever a
non-toggling checkbox lands) wrap the primitive's `onCheckedChange` to
re-emit a strict `boolean` (treating `"indeterminate"` as `false`).

**Tier:** LOW — no runtime issue; latent TS sharp edge.

### LOW-3 — `Popover` lacks an `<Anchor>` re-export

**Where:** `src/components/ui/popover.tsx:55`

**Symptom:** exports `Popover, PopoverTrigger, PopoverContent`. The
Radix `Popover` namespace also surfaces `Anchor`, useful when the
trigger is icon-only and the popover should align to a different
element (a label, a parent row). The Coach composer hint (the MB3
consumer) doesn't need it today; the next consumer will.

**Fix:** re-export `PopoverAnchor` from the primitive for parity with
the rest of the shadcn surface.

**Tier:** LOW — additive nit, not a defect.

### LOW-4 — Visual-viewport listener does not debounce; rapid `auto` scrolls during keyboard animation

**Where:** `src/components/insights/coach-panel/message-thread.tsx:208-221`

**Symptom:** the iOS soft-keyboard animation fires several `resize`
events as the keyboard slides up (each ~16 ms). Each fires
`scrollTo({ behavior: "auto" })` which forces a sync scroll. The result
is correct (the bubble lands at the tail) but the cost is several layout
reflows during the animation. RAF-debouncing would coalesce them to one
write per frame.

**Fix:** wrap the resize handler in a `requestAnimationFrame` so
multiple resize events per frame collapse to one scroll. Cleanup also
needs to `cancelAnimationFrame(handle)`.

**Tier:** LOW — perf nit, not a correctness bug. The cleanup itself is
correct (lines 219-220).

### LOW-5 — `ResponsiveSheet` swallows `className` collisions on the Sheet branch (`flex…` defaults vs consumer `className`)

**Where:** `src/components/ui/responsive-sheet.tsx:104-111`

**Symptom:** Sheet branch's container has a hardcoded `flex max-h-[90dvh]
flex-col gap-0 rounded-t-2xl p-0` followed by `className`. The class
order means consumer overrides for `max-h`, `rounded-t-*`, or `flex-*`
have to fight Tailwind's specificity. The Dialog branch only adds
`sm:max-w-md` so it composes cleanly. Marc's `medications/page.tsx:269`
already passes `className="sm:max-w-lg"` — that lands on both branches
because `sm:max-w-*` doesn't conflict with the Sheet's `max-h-[90dvh]`,
but a future consumer who wants `max-h-screen` on the Sheet branch
will need `!important`.

**Fix:** route the consumer `className` through `cn(…)` with the
defaults *after* it, or split the Sheet defaults into a separate
`sheetClassName` prop. The smoke suite would catch the regression as
soon as a consumer tests it.

**Tier:** LOW — latent override friction, no consumer hits it today.

### LOW-6 — `CoachLaunchProvider`'s prefill drop on close races a `react-strict-mode` double-invoke

**Where:** `src/lib/insights/coach-launch-context.tsx:75-81`

**Symptom:** `handleSetOpen(false)` calls `setPrefill(null)` immediately.
Under React 19 + strict mode double-invoke a third-party listener that
fires `setOpen(false)` twice would set `prefill` to `null` twice — a
no-op, but it also tears down the cached prefill before the drawer's
exit animation finishes reading it. The drawer renders the prefill via
the `prefill` prop, and `CoachDrawer` already uses `useResettableValue`
(line 168) so an immediate clear of `prefill` to `null` would seed a
fresh empty input mid-close-animation if the close happens to interrupt
a re-open with a prefill.

**Fix:** defer the prefill clear to the next tick (`setTimeout(() =>
setPrefill(null), 0)`) or wait for the drawer's transition-end before
clearing. The race is narrow today (no observed bug) but the right place
to fix it is in the provider, not the consumer.

**Tier:** LOW — speculative; documents the trade-off.

---

## NIT

### NIT-1 — `ResponsiveSheet`'s test mock-tree includes both portal mocks even though the test exercises one branch

**Where:** `src/components/ui/__tests__/responsive-sheet.test.tsx:20-116`

The mock setup runs at module-evaluate time (`vi.mock` calls hoist) so
both Sheet and Dialog mocks are installed regardless of which branch
the assertion exercises. It works fine, but trims to roughly half its
size if each `describe.each([…])` block sets up only the branch it
tests. Future readers will appreciate the smaller mock surface.

### NIT-2 — `useIsMobile` defaults to the `"md"` token; the Coach drawer's `useIsMobile("sm")` call is the only `"sm"` consumer

**Where:** `src/components/insights/coach-panel/coach-drawer.tsx:142`

The hook's `breakpoint: "sm" | "md"` parameter is a binary today. If a
future consumer wants `lg` or `xl` the union has to expand. Documenting
this as a known limitation (or generalising to a numeric `px`
parameter) saves a future patch round.

---

## Migration safety — `0061_audit_log_carrier`

The migration is **safe to deploy**. Verified against the project's
established pattern:
- Same `IF NOT EXISTS` shape as `0058_user_research_mode` (the
  migration's own docstring cites the parallel).
- Both columns are nullable so older rows, private-IP rows, and
  offline-miss rows stay valid (no backfill needed).
- The schema row at `prisma/schema.prisma:1240-1241` matches the SQL
  exactly (`asn Int?` ↔ `INTEGER`, `carrier String?` ↔ `TEXT`).
- Prisma client regeneration: the Dockerfile builder stage runs
  `pnpm db:generate` at line 18, and the generated tree in
  `src/generated/prisma/internal/prismaNamespace.ts` already lists
  `auditLog` in the model props (`AuditLogOmit` shape line 4526). The
  runtime client at `docker-entrypoint.sh:47-48` runs `prisma migrate
  deploy` against the live DB before the app starts. Sequence is
  airtight.
- `src/lib/auth/audit.ts:48-50` reads `asnRow.asn` / `asnRow.carrier`
  and writes to the new columns inside a fire-and-forget race wrapped
  in a 3 s timeout (line 28-38). Failure modes:
  - Online provider hung → 3 s timeout → location backfill skipped, ok.
  - MMDB miss → `lookupIpAsn` returns null → audit row stays without
    asn/carrier, ok.
  - Race shape: `Promise.race([Promise.all([…]), timeout])` — the
    location lookup happens inside the `Promise.all` arm. If the
    location lookup hangs, the timeout arm wins and the `.then(result
    => …)` short-circuits on `if (!result) return;`. ASN lookup is
    synchronous (`Promise.resolve(lookupIpAsn(...))`) so it never
    contributes to the race delay. Sound.

The one **observation** (not a finding): the `auditLog()` helper
returns the original `prisma.auditLog.create` result before the
fire-and-forget runs. Callers that `await` `auditLog()` and then
immediately read `auditLog.findUnique(…)` will see a row without
`asn`/`carrier`. No call site does this today, but tests that mock
both `lookupIpLocation` and `lookupIpAsn` need to flush the microtask
queue before asserting (the audit test suite at line 191-… already
does so).

---

## Drift between `<ResponsiveSheet>` and existing `<Sheet>` / `<Dialog>`

Sheet surface still has these direct mounts:
- `src/components/insights/coach-panel/coach-drawer.tsx:265` — raw
  `<Sheet>` driven by `useIsMobile("sm")` that flips `side` between
  `"bottom"` and `"right"` (not Sheet vs Dialog). Distinct pattern
  from MB1's "Sheet on mobile, Dialog on desktop" — both ship today
  side-by-side.
- `src/components/insights/coach-panel/coach-drawer.tsx:493, 525` — the
  history + sources rail trays, `side="left"` / `side="right"`. These
  are *adjacency* surfaces, not primary modals; correct to stay on raw
  Sheet.
- `src/components/insights/coach-panel/coach-settings-sheet.tsx` — same
  adjacency pattern.
- `src/components/layout/bottom-nav.tsx` — the mobile nav drawer; not a
  form modal.

Dialog surface has 11 remaining direct consumers
(`grep -l "from \"@/components/ui/dialog\""`). The notable ones are:
- `phase-config-dialog.tsx` — could migrate to ResponsiveSheet (form on
  mobile would benefit). v1.4.28 candidate.
- `ResearchModeAcknowledgmentDialog.tsx` — modal disclaimer with primary
  CTA; benefits from the bottom-sheet on phones.
- `target-edit-sheet.tsx` — already imports Dialog; the file name lies.
  Consolidation target.
- `mood-list.tsx`, `measurement-list.tsx` — edit-row modals. The mood
  and measurement *create* surfaces flipped to ResponsiveSheet via
  `<MoodForm>` / `<MeasurementForm>`, but the row-edit modals
  did not. Asymmetric.

**Net:** the drift is real and the MB1 work is incomplete in the
direction the directive worried about. Not a v1.4.27 blocker because
every remaining Dialog still works on mobile (it just keeps the
pre-MB1 layout). The five Dialog → ResponsiveSheet swaps above are a
natural v1.4.28 follow-up bucket.

---

## Form integrations to `<ResponsiveSheet>` — react-hook-form intact?

The codebase is `react-hook-form` *installed* but not *used* in the
form components that landed under MB1:
- `MedicationForm`, `MeasurementForm`, `MoodForm`,
  `SideEffectsSection`, `InventorySection`, `IntakeHistoryList` — all
  `useState`-based. `grep -rln "useForm\b" src` returns zero hits.
- `package.json:71` lists `react-hook-form: ^7.75.0` and
  `@hookform/resolvers: ^5.2.2` as deps; nothing imports them.

The form integration question is therefore vacuous — there are no
react-hook-form forms to break. The `useState` pattern composes
cleanly with ResponsiveSheet because `ResponsiveSheet` is
state-passthrough only.

(Tangent: the unused `react-hook-form` deps are a v1.4.28 hygiene item
— either commit to one form library or drop the deps. Out of scope for
this review.)

---

## `<Input>` `inputMode` derivation — controlled / uncontrolled safety

`src/components/ui/input.tsx:50-78` adds a single derived attribute
(`inputMode`) and does not touch `value` / `defaultValue` / `onChange`.
Both controlled and uncontrolled `<input>` callers pass through
unchanged. The smoke suite at `src/components/ui/__tests__/input.test.tsx`
covers:
- Default derivation for every type the switch handles.
- Explicit `inputMode="numeric"` override on `type="number"` (line 64-70).
- Plain text drops `inputMode` entirely (line 59-62).

One thin edge: the `type` prop is `React.HTMLInputTypeAttribute |
undefined`. If a future consumer passes `type={undefined}` and
`inputMode={undefined}` the primitive emits `inputMode={undefined}`
(omitted attribute), which is the React-clean shape. No risk.

The pattern correctly leaves password-manager hints intact for explicit
`autoComplete` values (line 57-58). Already covered by the existing
test.

---

## `LayoutCoachMount` boundary

`src/components/insights/layout-coach-mount.tsx` is 26 lines, one
`useCoachLaunch()` hook call, one `<CoachDrawer>` mount. The boundary
between the server-component layout (`src/app/insights/layout.tsx`)
and the client-only `<CoachDrawer>` is correctly threaded:
- `layout.tsx` stays server-renderable (no `"use client"` directive,
  but the children + the provider + the mount are all marked
  `"use client"`).
- `LayoutCoachMount` is the bridge — tiny client island that consumes
  the context.
- `<CoachLaunchProvider>` ships its own `"use client"` directive
  (`coach-launch-context.tsx:1`).

The boundary is at the right level. The only nit is that the bridge
component could trivially inline into `CoachLaunchProvider` (the
provider could render the drawer alongside `{children}`), but that
couples the provider to the drawer mount and would block the v1.4.28
case where a non-Coach client consumes the same context (e.g. a future
"Ask the coach" CTA on `/dashboard`). The current shape stays open for
that.

---

## `<CoachLaunchProvider>` + `useCoachLaunch` — React 18 patterns review

The context shape is textbook for React 19:
- `useState` for `open` + `prefill` (each independent state cell).
- `useCallback` on `askCoach` + `handleSetOpen` so consumers don't
  re-mount on every parent render.
- `useMemo` on the `value` so the context never invalidates unless a
  state cell flips.
- Reading the context with `useCoachLaunch()` returns `null` outside
  the provider so consumer fallbacks (the launch button's null-render,
  the mother page's conditional `onAskCoach`) compose cleanly.

Stale-closure traps: none in the current code path. `askCoach`'s body
references `setPrefill` and `setOpen` only (setters are stable). The
`scope` arg is currently `void`ed. If v1.4.28 starts using `scope`
inside `askCoach` to update sources-rail state, that state must be
lifted into the provider or read via a setter-pattern hook — not closed
over.

The `useMemo` deps array correctly lists every state cell + every
callback. No drift.

---

## Commit attribution drift in MB1 — release blocker or annotation?

The drift is real and limited to **one** commit:

**`bd7cb938` carries the wrong subject + body.** The commit message
reads `feat(ui): lift the password toggle into a shared primitive`
with a `<PasswordInput>` move narrative. The diff is the
ResponsiveSheet migration of `src/app/page.tsx`, `src/app/measurements/page.tsx`,
`src/app/mood/page.tsx` (Dashboard / Measurements / Mood pages swapping
`<Dialog>` for `<ResponsiveSheet>` on the quick-entry sheets). The
*real* PasswordInput move landed in `b25683404` six minutes later with
the identical commit body. So the body was duplicated, the diff is the
wrong work.

**`44554729` is fine.** The commit message
`chore(insights): apply the tap-target floor across the insights surface`
matches its diff (coach-drawer.tsx pills + buttons lifted to `h-11`,
hero-strip drops `size="sm"`, etc.). The directive's flag here looks
like a misread — this commit's narrative is internally consistent.

**Release-blocker assessment:** not a blocker. The commit hash, author,
date, and merge tree are intact; the only damage is to the git log's
storytelling. The fix options:
1. Annotate v1.4.27 CHANGELOG with a note: "commit bd7cb938 ships the
   ResponsiveSheet migration of Dashboard / Measurements / Mood quick-
   entry sheets under a misattributed subject — see b25683404 for the
   intended PasswordInput primitive move."
2. Cherry-pick the right body onto a fresh commit with `git commit
   --amend` (rewrites history; develop branch only — not yet on main
   per the branch model). The MB1 PR is already on develop so an amend
   forces a `git push --force-with-lease`. Per the safety protocol Marc
   would have to authorise.
3. Leave it; the diff is reviewable, the tag is months away.

**Recommendation:** CHANGELOG annotation. v1.4.27 ships from develop →
main with the misattributed commit intact + the annotation explaining
the swap. No history rewrite. Marc's PII-aware release notes already
gloss over commit subjects; the audit trail stays in the planning
docs.

---

## Cross-cutting observations (not severity-tiered)

- **Test coverage is healthy.** ResponsiveSheet smoke at 6 assertions,
  coach-launch-context smoke at 3 assertions, input.tsx at 9
  assertions. The patterns + scenarios that matter are pinned.
- **i18n surface is clean.** No new untranslated keys leaked into the
  primitives (they're all consumer-driven `t(...)` calls).
- **No PII / personal data in any of the new strings.** The migration
  SQL comments reference example carriers ("Deutsche Telekom AG") but
  the columns themselves are arbitrary user-traffic data, not the
  reviewer's own.
- **The forbidden vocabulary scan is clean.** `grep -rn -E
  "AI|Claude|agent|marathon|wave|phase|session|subagent|Anthropic" src`
  against the v1.4.27 diff returns only `phase` matches inside data
  variables (`MedicationPhase`, `phase-config-dialog`, etc.) — domain
  vocabulary, not authorship references.

---

## Suggested follow-ups (v1.4.28 candidates)

1. **HIGH-1 fix** — move inline form footers to `<ResponsiveSheet
   footer={…}>` across all five call sites. ~80 LOC.
2. **HIGH-2 path** — pick rotation strategy for ResponsiveSheet
   (lock-at-mount vs unified Dialog/Sheet root).
3. **MED-1 fix** — swap `ai-section.tsx`'s three raw `<select>` blocks
   to `<NativeSelect>`.
4. **MED-2 fix** — type-narrow `CoachLaunchScope.metric` to the
   `CoachScopeSource` union before v1.4.28 wires it up.
5. **MED-3 fix** — extract `RESPONSIVE_SHEET_FOOTER_CLASS` constant or
   document the divergence as intentional.
6. **MED-4 decision** — secondary CTA on Insights empty surfaces; if
   yes, mount `<CoachLaunchButton>` below the action.
7. **Drift cleanup** — convert 5 remaining `<Dialog>` consumers
   (`phase-config-dialog`, `ResearchModeAcknowledgmentDialog`,
   `mood-list` row-edit, `measurement-list` row-edit, `target-edit-sheet`)
   to `<ResponsiveSheet>`.
8. **react-hook-form deps** — either commit to the lib or drop the two
   unused deps.

---

End of review.
