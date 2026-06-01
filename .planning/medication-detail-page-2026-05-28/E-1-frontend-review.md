# E-1 — Frontend-design audit of D-2 (v1.5.5 medication-surface direction)

Reviewer's lens: visual rhythm, primitive token consistency, section hierarchy, animation discipline, accessibility-adjacent polish, dark-mode + reduced-motion fallbacks. Marc's four locked decisions (detail-page URL split, single-step `<AlertDialog>` on delete, focused-Sheet phase editor, restrained width-only progress) are out of scope for relitigation — only audited for consistency where D-2 prose still echoes the superseded direction.

Severity counts:

- Critical: 3
- High: 5
- Medium: 7
- Low: 4

---

## Critical

### C-1. Status-bar animation section (D-2 §2.6 + §9) is entirely superseded by decision #4 and must be stripped

D-2 §2.6 ("Status-bar morph animation"), §2.7 ("Step transition animation"), and §9 ("Status-bar morph — pinned spec") commit ~85 LOC of doc + ~70 lines of CSS to a three-shape `clip-path` morph (half-circle → rounded square → capsule → full capsule) plus a separate per-step `wizard-step-in` keyframe animation, both layered under a brand-new `@layer components` block in `src/app/globals.css`. Decision #4 supersedes all of this. The implementation must:

- Drop the entire `.wizard-progress-bar[data-step="N"]` clip-path interpolation. The shipped `<Progress>` primitive (`src/components/ui/progress.tsx:24`) already carries `transition-all` on its indicator. The only legitimate v1.5.5 polish on the bar is the `h-1 → h-1.5` stroke bump (justified by reduced-motion testing — keep), plus an optional `aria-label={stepOf}` already in place.
- Drop the new `@layer components` block. No precedent exists — `globals.css:218` ships exactly one `@layer base` block, and the two existing `@keyframes` (`insight-fade-in`, `pulseDot`) live at top level. D-2's claim "the project already keeps custom utilities there" (line 108) is factually wrong.
- Drop `wizard-step-in` + `wizard-step-back-in` keyframes. The step body already re-mounts via `key={step}` (line 413 of the wizard); a fade alone could ride on `data-[mounted]:animate-in fade-in-0 duration-200` using the existing tailwindcss-animate utility classes the dialog already imports (e.g. `dialog.tsx:43`). No new keyframes needed; no new motion vocabulary introduced.

Action: replace §2.6/§2.7/§9 with a three-paragraph note pinning the existing `<Progress>` + `transition-all` cadence, a `motion-reduce:transition-none` discipline note, and the `h-1.5` stroke. Match the project precedent at `intake-history-list-v2.tsx:184` (`animate-spin motion-reduce:animate-none`).

### C-2. Detail-page width override (`max-w-3xl mx-auto`) breaks cross-surface page-container parity

D-2 §3 (line 232) caps the detail page at `max-w-3xl mx-auto` (768 px) on `md+`. Every other top-level surface in the tree rides the auth-shell's `max-w-screen-xl` container (1280 px, set in `src/components/layout/auth-shell.tsx:186`). `/insights/page.tsx`, `/dashboard/page.tsx`, `/medications/page.tsx`, and the existing `/medications/[id]/history/page.tsx` all read edge-to-edge at the shell width. Imposing a 768 px ceiling on the detail page alone produces a visible visual hiccup when the user navigates `/medications` (full-width grid) → `/medications/[id]` (centred narrow column) → back. R-2's "concentric tokens" argument supports inner-section padding, not a separate page cap.

Action: drop the `max-w-3xl mx-auto` wrapper. If the cadence-summary line + intake-history table read edge-to-edge as too wide, cap *those individual sections* via the existing `<MedicationDetailSection>` chrome which already centres content within its `px-3` body band. The page-level container stays inherited from the auth-shell.

### C-3. `rounded-xl` symmetry contract (D-2 §2.5) contradicts every shipped primitive

§2.5 invariant #1: "The step icon plate AND the primary footer CTA share `rounded-xl`." Three problems:

1. `<Button>` ships `rounded-md` by default (`button.tsx:33`) on every size variant (`xs`, `sm`, `lg`, all explicit at `rounded-md`). Overriding the wizard-Next button to `rounded-xl` introduces a one-off curvature on the wizard footer that no other button in the app shares — including the destructive-zone buttons D-2 wires elsewhere on the same surface. The user sees `rounded-md` on every CTA across `/medications`, `/insights`, `/dashboard`, and then `rounded-xl` on the wizard footer only.
2. `<DialogContent>` ships `rounded-lg` (`dialog.tsx:72`) and `<AlertDialogContent>` ships `rounded-lg` (`alert-dialog.tsx:61`). The dialog chrome is `rounded-lg`, the inner icon plate is `rounded-xl`, the CTA would also be `rounded-xl` — the user reads three different radii on a single surface.
3. `<Card>` ships `rounded-xl` (`card.tsx:23`). The detail page's `<TodaysDoseCard>` will be a Card — its outer corner is already `rounded-xl`. Promoting the inner buttons to match the card outer corner violates the concentric rule R-2 cited (inner radius < outer radius).

Action: keep the icon plate at `rounded-xl` (it's a visual accent, not chrome), keep `<Button>` at default `rounded-md`. Rewrite invariant #1 as "the step icon plate is the only `rounded-xl` element inside the dialog body — every other chrome is `rounded-md` (Button, MedicationDetailSection) or `rounded-lg` (DialogContent)."

---

## High

### H-1. Section-title type cascade fragments across the page

§2.3 promotes the wizard step title from `text-base font-medium leading-tight` to `text-lg font-semibold leading-tight tracking-tight`. §10 then specifies the detail-page section title as `text-base font-semibold leading-6 tracking-tight` (matching the shipped `<MedicationDetailSection>` at `medication-detail-section.tsx:68`). The user sees:

- Wizard step title: 18 px / 600
- Detail-page section title: 16 px / 600
- IntakeHistoryListV2 `<CardTitle className="text-base">`: 16 px / 600

The wizard step title would be the only `text-lg` element on the surface, even though the wizard opens *over* the detail page. Promoting one element produces a single outlier rather than a coherent type cascade. R-2's 17 pt / 600 section header maps cleanly to `text-base font-semibold` (the precedent shipped). Pick one.

Action: hold the wizard step title at `text-base font-semibold leading-tight tracking-tight` so it matches every other section title in the app. The "title outweighs subline" R-2 argued for is achieved by the weight delta (`font-semibold` vs `text-sm` body), not the size delta.

### H-2. Spacing-token table promises three classes but ships six

§2.4 opens with "Every internal gap maps to one of three Tailwind classes; reviewers reject any PR that introduces a fourth." The table then lists eight distinct gap tokens: `p-4 pr-12`, `p-5 sm:p-6`, `space-y-5 sm:space-y-6`, `gap-3`, `space-y-1`, `gap-6 sm:gap-8`, `gap-2`, `space-y-3`. The "three classes" rule is unenforceable as written. A reviewer cannot reject a PR for adding a fourth token when the spec itself defines eight.

Action: either restate as "five tokens — outer (`p-5 sm:p-6`), section (`gap-6 sm:gap-8`), row (`space-y-3`/`gap-3`), tight (`space-y-1`), footer (`gap-2`)" — five concrete buckets the implementer maps to — or drop the "three classes" framing and let the table stand as the contract. Currently the prose and the table disagree.

### H-3. Page-level vertical rhythm picks `space-y-6 sm:space-y-8` while sibling surfaces ship a single class

D-2 §3 (line 231) proposes `space-y-6 sm:space-y-8`. Sibling surfaces:

- `/medications/[id]/history/page.tsx:66` — `space-y-6` (no breakpoint shift)
- `/insights/page.tsx:195` — `space-y-8` (no breakpoint shift)

Picking a breakpoint-shifted token on the detail page alone means navigating between the two `/medications/[id]/*` routes shows different scroll cadence (24 px on history, 24 → 32 px on detail). The shipped pages chose one cadence each and stuck to it.

Action: pin to `space-y-6` (matches history sibling, matches dashboard pillars) OR `space-y-8` (matches insights), but not both. Recommended: `space-y-6` — it matches the v1.4.28 collapse-to-canonical decision documented at `/medications/[id]/history/page.tsx:59-64`.

### H-4. Wizard step body padding shift (`p-4` → `p-5 sm:p-6`) introduces asymmetry with the progress strip

§2.3 proposes step body `p-5 sm:p-6`. The progress strip stays `p-4 pr-12` (line 380 of the shipped wizard). At mobile width the progress strip pads at 16 px while the body pads at 20 px — the user sees the progress fill bar inset 4 px more than the icon-plate row below it. Marc reported the v1.5.4 dialog as "asymmetric"; this is a new asymmetry introduced by the polish itself.

Action: keep the progress strip and the body at the same horizontal padding. Either bump the progress strip to `p-5 sm:p-6 pr-12 sm:pr-14` or keep the body at `p-4`. Recommended: keep both at `p-4` on mobile and bump *both* to `sm:p-6` at the breakpoint, so the optical left edge stays aligned at every width.

### H-5. Loading skeleton + error state coverage is missing per section

§3.1–§3.8 specify components, APIs, and empty-state copy, but the loading and error states are only spelled out for one block (§3.5 mentions `Loader2` indirectly via the existing `IntakeHistoryListV2` precedent). The other six sections — `<TodaysDoseCard>`, `<CadenceSummaryRow>`, `<TitrationSection>` (already shipped), `<NotificationsSection>`, `<SettingsSection>` sub-rows, `<DestructiveZoneSection>` — have no spec for the `isLoading` or `isError` branch. The Coach disable-cascade pattern from v1.4.49 means missing skeletons land as flashes of empty card chrome before content fills in.

Action: add a single subsection at the bottom of §3 listing the loading and error contracts: "every section renders `<Loader2 className='h-5 w-5 animate-spin motion-reduce:animate-none' />` centred inside the section chrome on `isLoading`; renders `<p className='text-destructive text-sm'>{t(\"common.loadFailed\")}</p>` on `isError`; renders the section-specific empty-state copy on the empty branch." Single contract, every section conforms.

---

## Medium

### M-1. Section-order weighting: Settings (§3.7) is heavy enough to bury the Destructive zone

§3 puts Notifications (6) → Settings (7) → Destructive zone (8). Settings is the heaviest block on the page (four sub-rows, the API-token grid alone is ~120 px of vertical space, the inline phase editor adds 320 px when GLP-1 + course window). On a mobile viewport at 360 px width the destructive zone lands ~1400 px below the header — past the second-screen fold even on a tall device. Apple Health's destructive zone is similarly far down its detail page, but Apple Health users complain (R-2 §1 cited "where is delete?" as the dominant signal). The R-2 verdict (§A) explicitly calls out "discoverability" as the gap to close, and §3.8 quietly hides the destructive zone behind the largest section on the page.

Action: either swap §3.7 and §3.8 — destructive zone before Settings, so the labelled "Gefahrenzone" appears at ~1100 px — or accept Apple's placement but add an in-page anchor link or jump-to nav. Recommended: swap. The destructive zone visibility was the headline R-2 argument against Apple Health's pattern; current §3 repeats Apple's mistake.

### M-2. Focus-ring discipline not specified for the destructive cascade

§3.8 specifies the three-tier destructive zone with `<Switch>` + `<AlertDialog>` primitives. The shipped `<Switch>` and `<AlertDialogAction variant="destructive">` already render focus rings via the button primitive's `focus-visible:ring-ring/50 focus-visible:ring-[3px]` class chain (`button.tsx:33`). What's not specified: the destructive `<AlertDialogAction>` should render the focus ring on the destructive token rather than the default ring. Currently `button.tsx` uses `focus-visible:ring-ring/50` for every variant; a destructive button shows a blue focus ring around a red button, which reads as visual noise.

Action: add a sentence to §3.8: "every `<AlertDialogAction variant='destructive'>` uses the existing primitive — no custom focus-ring override. If the destructive ring colour reads wrong against the red button, that's a Button-primitive concern to surface separately." Lock the surface against ad-hoc focus-ring overrides per section.

### M-3. Reduced-motion fallback missing from the step-fade contract

Per the locked decision #4, the morph and slide animations are dropped. But the step body still re-mounts via `key={step}`. If the implementer reaches for the `data-[mounted]:animate-in fade-in-0` pattern (recommended in C-1), the `prefers-reduced-motion: reduce` discipline needs to be explicit: the tailwindcss-animate package's `animate-in` utility already honours `prefers-reduced-motion` *only when paired with* `motion-reduce:animate-none`. D-2 §2.5 invariant #6 captures this for loader spins but doesn't extend it to step transitions.

Action: lift §2.5 invariant #6 from "Loader animations everywhere use `animate-spin motion-reduce:animate-none`" to "every animation utility (`animate-in`, `animate-spin`, transition-* on the progress bar) carries `motion-reduce:animate-none` or `motion-reduce:transition-none`. No exceptions; this is the project precedent."

### M-4. Status-pill colour tokens use raw Tailwind palette names instead of semantic theme tokens

§3.1 specifies status pill accent dots as `bg-emerald-500` / `bg-amber-500` / `bg-zinc-500`. These are raw Tailwind palette names — fine in light mode, fine in dark mode (Tailwind's palette is tuned for both), but they bypass the theme system at `globals.css`. The rest of the app uses semantic tokens — `bg-primary`, `bg-muted-foreground`, `text-destructive` — that map to the Dracula palette via CSS variables. A raw `bg-emerald-500` won't shift if the operator ever themes the app away from defaults.

Action: pick one of two paths. Either (a) restate the status pill colours as raw palette tokens, with an explanatory note "status colours don't theme — they're traffic-light semantic and stay constant", or (b) introduce three new theme tokens (`--state-active`, `--state-paused`, `--state-stopped`) and reference them as `bg-[var(--state-active)]`. Recommended: (a) with the note, since the destructive zone in §3.8 doesn't theme either (uses `<Switch>` default colour). Be explicit so the rule is documented.

### M-5. iOS clientManaged note copy + key path not in i18n yet

§3.6 introduces a new DE key `medications.notifications.clientManagedNote`. This key does not exist in `messages/de.json` today (grep confirms). The i18n-call-site-coverage test would fail the moment the wired component lands without the key being added to all six locales (`de`, `en`, `es`, `fr`, `it`, `pl`). D-2 mentions the key in passing without listing every required locale or pinning the en/es/fr/it/pl copy.

Action: add a sub-table to §3.6 listing every new i18n key the v1.5.5 surface needs, with each locale's copy. Crosscheck: D-2 §3.6 introduces `clientManagedNote`, §3.7 implicitly needs `medications.settings.{title,apiTokens,csvImport,phases,grace}.*`, §3.8 reuses `medications.dangerZoneTitle` (lives) but introduces new sub-row labels (`pauseTitle`, `endTitle`, `purgeTitle`, `deleteTitle` + descriptions). Inventory or this becomes a Phase-4 implementer surprise.

### M-6. CSS `clip-path: inset(... round 0 999px 999px 0)` syntax is not a stable Tailwind contract

Even after stripping the morph per C-1, the residual block still ships in D-2 §2.6. If anything from that block survives unaudited into the implementer's PR, `clip-path: inset(0 0 0 0 round 0 999px 999px 0)` is parsed inconsistently across Safari < 17, Chromium-based, and Firefox — the round syntax with per-corner radii is iOS 17.4+ / Chrome 121+ / Firefox 128+ baseline. HealthLog supports iOS 15+ via the PWA. The progress bar would render correctly on every modern browser but the clip-path would silently no-op on older iOS, leaving the indicator as a flat rectangle.

Action: confirm C-1 is applied. If anything from §2.6 survives, gate it behind a `@supports (clip-path: inset(0 round 0 999px 999px 0))` block with a `border-radius: 9999px` fallback. Or just don't ship the morph.

### M-7. Sub-row component file count (§11) sprawls the directory

§11 introduces eight new files under `src/components/medications/sections/` — `intake-history-preview.tsx`, `notifications-section.tsx`, `settings-section.tsx`, `api-tokens-row.tsx`, `csv-import-row.tsx`, `phase-management-row.tsx`, `grace-minutes-row.tsx`, `destructive-zone-section.tsx` — plus two more in `src/components/medications/` (`todays-dose-card.tsx`, `cadence-summary-row.tsx`). The current `src/components/medications/` directory has 18 PascalCase outliers already (CLAUDE.md flagged this). Adding 10 new files at once, mixing kebab-case (new) with PascalCase (existing), is a visible filename-convention split mid-directory.

Action: confirm all 10 new files land kebab-case (D-2 §11 already lists them that way — good). Add a one-line note: "PascalCase outliers in the same directory (`TitrationSection.tsx`, `SideEffectsSection.tsx`, `SchedulingSection.tsx`, `DrugLevelChart.tsx`) are pre-existing per CLAUDE.md and stay until those files come up for edit. New files in this batch are kebab-case." Locks the convention so the reviewer doesn't have to relitigate.

---

## Low

### L-1. Sticky-footer + sticky-header overlap not specified

The wizard uses a sticky footer (`responsive-sheet.tsx:147`). The detail page header band (§3.1) is not specified as sticky. On a long scroll past the destructive zone, the user has no quick way back to "edit" — they have to scroll all the way up. Apple Health's detail page pins the back button + drug name in the nav bar. R-2 §A mentions "header band" but doesn't pin sticky vs static.

Action: add one sentence to §3.1: "header band is static — no sticky behaviour. The app shell's bottom nav already pins navigation. Scroll-to-top is a standard browser gesture."

### L-2. Swipe-to-reveal pattern (§3.5, §6.3) needs an explicit fallback for desktop without `<DropdownMenu>` mount

§3.5 + §6.3 spec the row-level edit/delete as "mobile: swipe-to-reveal, desktop: kebab via `<DropdownMenu>`". The breakpoint pick is not specified — `useIsMobile()` (already in the tree) vs CSS `md:` class. Mixing the two on the same component produces SSR hydration mismatches.

Action: pick the existing precedent — `useIsMobile()` from `src/hooks/use-is-mobile.ts` — and spell it out in §6.3. The hook already powers `<ResponsiveSheet>`; reusing it keeps the breakpoint single-source.

### L-3. Iconography map (§10) doesn't pin the icon colour token

§10 lists 13 Lucide icon assignments but doesn't pin the colour. The shipped wizard icon plate uses `text-primary` for the step icon (`MedicationWizardDialog.tsx:421`). Detail-page section icons would default to `currentColor` inheriting the section title's `text-foreground`. Mixed treatment across sections (icon ≠ title colour) would read as drift.

Action: pin one rule: "every section-title icon inherits `text-foreground` (matching the title text). Inline body icons inherit `text-muted-foreground`. The icon plate stays the only `text-primary` accent."

### L-4. "tap targets ≥ 44 px everywhere" claim in the brief is not enforceable as stated

Brief asked: "Tap targets ≥ 44 px everywhere?" D-2 §2.5 invariant #6 pins loader animation, but no invariant pins tap-target floor. The shipped `<Button>` primitive ships `h-11` (44 px) only on size `lg`; `default` is `h-9` (36 px) and `sm` is `h-8` (32 px). The wizard footer (`MedicationWizardDialog.tsx:338,348,360`) explicitly sets `className="h-11"` to override. Detail-page sections will use the default `size="default"` (36 px) unless every consumer overrides. The dialog primitive's close-X already has the 44 → 36 px exception documented (`dialog.tsx:80-86`).

Action: add to §2.5 invariants: "Primary CTAs (`<Button>` not size-overridden) on mobile (`<md`) render at `min-h-11` (44 px); the existing wizard precedent at `MedicationWizardDialog.tsx:338` is the template. Icon-only close-X stays at the 36 px documented exception." Locks the floor.

---

## Confirmation — what D-2 gets right

The audit is not all gaps. D-2 holds up cleanly on several axes:

- **Section-order patient logic (§3.1–§3.8)** is patient-coherent: daily actions (log today, see recent) at top, rare actions (destructive) at bottom. The Apple-Health-style top-down read survives Marc's locked decisions intact.
- **Component reuse discipline (§11)** correctly leverages `<MedicationDetailSection>`, `<IntakeHistoryListV2>`, `<TitrationSection>`, `<ResponsiveSheet>`, `<AlertDialog>` without reaching for new primitives. The pre-work to extract `IntakeImportDialog` and retire `ApiEndpointDialog` (§11 footer) is correct.
- **Phase-editor placement (decision #3 alignment)** is consistent with the locked decision — §3.7's "inline" phase row is what Marc picked. The brief's "focused `<Sheet>` opened from a Settings row" is a refinement that fits cleanly with the row component already named `<PhaseManagementRow>`; switching to a Sheet trigger is a one-line change.
- **Single-step `<AlertDialog>` for delete (decision #2 alignment)** lands cleanly. §3.8's reuse of the `settings/advanced-section.tsx:287-317` precedent is the right model. §13's open question about the type-back-name guard is now answered by Marc's lock — strip §13 question 2 entirely from the document.
- **Detail-page URL split (decision #1 alignment)** is exactly as Marc picked: new `/medications/[id]/page.tsx` as primary, `/medications/[id]/history` as bulk-delete deep-dive. §6.1/§6.2 split is correct.
- **The wizard geometry shift to `sm:max-w-[560px]` + `min-h-[60dvh]`** is the right call against Marc's "too short" complaint. §2.1 maps cleanly to the shipped `<ResponsiveSheet>` primitive.
- **The `pr-12` close-X gutter fix (§2.2)** is a clean one-line patch with no primitive change.

---

## Recommendations for the implementer

1. Strip §2.6, §2.7, §9, and §13 question 4 entirely — they are superseded by Marc's locked decision #4 (Critical C-1).
2. Strip the `max-w-3xl` page wrapper — keep the inherited auth-shell container (Critical C-2).
3. Keep the `<Button>` primitive at `rounded-md`; only the icon plate is `rounded-xl` (Critical C-3).
4. Hold the wizard step title at `text-base font-semibold` (High H-1).
5. Resolve the spacing-token "three classes" vs "eight tokens" contradiction (High H-2).
6. Pick `space-y-6` for the page-level rhythm (High H-3).
7. Align progress strip + step body horizontal padding (High H-4).
8. Add a single loading/error/empty-state contract subsection (High H-5).
9. Swap §3.7 and §3.8 so the destructive zone is more discoverable (Medium M-1).
10. Inventory every new i18n key with all six locales' copy before Phase 4 implementation (Medium M-5).

After these passes, D-2 lands inside the existing HealthLog design language (Dracula palette, zinc base, shadcn new-york, the same `transition-*` cadence the rest of the app uses) and inherits decision #4's restraint at the implementation layer.
