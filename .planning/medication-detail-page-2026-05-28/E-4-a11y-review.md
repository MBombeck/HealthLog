# E-4 — Accessibility review of D-2 (v1.5.5 medication detail page + wizard polish)

Scope: WCAG 2.1 AA + Apple HIG-equivalent rigor on `/Users/marc/Projects/HealthLog/.planning/medication-detail-page-2026-05-28/D-2-direction.md`. Out of scope: visuals (3A), UX walk (3B), architecture (3C), color-blindness deep dive. Locked decisions Marc carries (detail-page-as-new-URL, single-step delete, phase editor in Sheet, restrained status-bar) are honoured — none of the findings re-litigate them.

Reviewer cross-checks: `src/components/ui/dialog.tsx`, `src/components/ui/sheet.tsx`, `src/components/ui/responsive-sheet.tsx`, `src/components/ui/alert-dialog.tsx`, `src/components/ui/switch.tsx`, `src/components/ui/button.tsx`, `src/components/medications/wizard/MedicationWizardDialog.tsx`, `src/components/medications/intake-history-list-v2.tsx`, `src/components/medications/medication-detail-section.tsx`, `src/components/layout/auth-shell.tsx`.

---

## Critical (5)

### C-1 — Today's-dose card emits no `aria-live` confirmation; the only feedback is a toast
D-2 §3.2. The three primary buttons (`Genommen` / `Verschoben` / `Übersprungen`) mutate via `POST /api/medications/[id]/intake` and rely on react-query invalidation. D-2 does not name a polite live region for the success path nor an assertive region for the failure path. A screen-reader user taps "Genommen", focus stays on the button, and the toast (`sonner`) only announces when `aria-live="polite"` is wired on the toaster — verified in repo but not pinned in D-2 for this section. **Fix:** pin a `role="status" aria-live="polite"` invisible status node inside `<TodaysDoseCard>` that re-renders with `t("medications.takenConfirmed")` on success, OR explicitly cite the sonner polite-region as the canonical announcer and require it to be mounted at the auth-shell level. Same applies to §3.6 notifications switch (no announce on toggle), §3.8 tier-1 Pausieren switch (no announce on flip), §3.7 GraceMinutesRow (number input has no commit feedback for AT).

### C-2 — Loader-state coverage gap on detail-page section reads
D-2 names a `<Loader2 ... animate-spin />` precedent (§2.5 invariant 6) but does NOT pin an `aria-busy` + `aria-live="polite"` wrapper on the section-level loading skeletons. `intake-history-list-v2.tsx:184` already gets this wrong — bare spinner, no announce. D-2 §3.5 reuses V2 inside `<IntakeHistoryPreview>` so the same hole rides forward, and §3.4 (TitrationSection), §3.7 (ApiTokensRow / PhaseManagementRow), and §3.6 (NotificationsSection) all fetch independently. Pattern to enforce, matching `insight-status-card.tsx:53`: every async section wraps its loading branch in `<Card aria-busy="true" aria-live="polite">`. Codify in D-2 §3 as a per-section invariant or risk seven independent regressions.

### C-3 — Header band breaks reading order — `[Bearbeiten]` button precedes the drug name in tab order
D-2 §3.1 wireframe places `[✏ Bearbeiten]` on the same line as the drug name with float-right visual placement. The DOM order Marc's wireframe implies is `<h1>{name}</h1>` then `<Button>Bearbeiten</Button>` — that's fine on a flex row — but the spec doesn't pin which side renders first in the DOM. If the implementer follows the visual "right-aligned button" cue by writing the button first + `ml-auto`, sighted keyboard users will Tab to Edit BEFORE reading the drug name in DOM order, AT will announce "Bearbeiten button, [drug name]". **Fix:** D-2 §3.1 must state explicitly: heading element first in the DOM, edit button last, justified with `justify-between` on the parent. Same on §3.3 (cadence-summary Bearbeiten).

### C-4 — Modal-stack: AlertDialog opened from `<IntakeHistoryPreview>` is fine on the route page, but the same `onDeleteIntake` callback is also reachable from `/medications/[id]/history` (§6.2) where `<IntakeHistoryListV2>` mounts as a child of a different surface
The detail-page preview opens its destructive AlertDialog at the route level (clean). The bulk surface §6.2 wraps the same V2 list AND opens a sticky-bottom batch action bar AND opens a bulk-delete AlertDialog. If the per-row swipe-reveal Bearbeiten target opens a `<ResponsiveSheet>` per §6.3, and the user immediately fires the row-level delete, a `<Sheet>` and `<AlertDialog>` stack inside the route. Radix handles this correctly but the **focus-return chain breaks** when an AlertDialog dismisses while the Sheet underneath is also closing: focus returns to `document.body`, not the row trigger. D-2 must pin the contract: the edit Sheet's destructive-delete affordance lives INSIDE the Sheet (and dismisses the Sheet via its own onSuccess), it never opens a peer AlertDialog. Stack depth ≤ 2 with explicit close-then-confirm sequencing.

### C-5 — `bg-emerald-500 / bg-amber-500 / bg-zinc-500` status-pill dots are non-textual indicators; the pill text MUST carry the state for WCAG 1.4.1
D-2 §3.1: `Aktiv` / `Pausiert` / `Beendet` pill uses an `h-2 w-2 rounded-full` colored dot + text. WCAG 1.4.1 is satisfied because text IS present (`Aktiv`, `Pausiert`, `Beendet`) — but D-2 does NOT pin that the text MUST stay rendered at all viewport widths. If the implementer hides the text under a `sm:hidden` because the row crowds on 320 px, the pill collapses to a color-only signal — fail. Add an invariant: status-pill text never hides, the dot is `aria-hidden="true"`. Same for the Heute / Diese Woche / Älter group headers in §3.5 if they ever pick up colored chevrons.

---

## High (9)

### H-1 — Wizard focus management on edit-mode landing-step is undefined for screen readers
D-2 §5: header-band Edit lands the user on Step 1, cadence Edit lands them on `landingStepForEdit(payload)`. The wizard's `useEffect` at `MedicationWizardDialog.tsx:213-224` runs after mount and focuses the first interactive child. **Gap:** when the wizard opens on Step 5 (cadence-edit landing), the screen reader will announce the Sheet/Dialog title (`{name} bearbeiten`) but not the step context — the user lands in the middle of the form with no anchor. **Fix:** D-2 must pin `aria-labelledby` on the wizard body to the step title h2, and require the step title to receive focus (or be referenced via `aria-describedby`) when the wizard mounts mid-flow. Today the title is `<h2>` only — add `tabIndex={-1}` and a focus call when the landing step is anything other than 1.

### H-2 — Step transition `key={step}` re-mount loses focus across step navigation
`MedicationWizardDialog.tsx:413` uses `key={step}` to re-mount the body on every step change. The `useEffect` then re-runs and focuses the first interactive control — but the body re-mount happens BEFORE the effect runs, which causes a single-frame focus loss (focus reverts to `document.body`). Screen readers announce nothing during that frame; some AT (NVDA in particular) drops the next announcement. D-2 §2.7 adds a CSS animation on the same re-mount, which extends the gap to 220 ms. **Fix:** pin focus-restore inside the animation's `onAnimationEnd`, or use `aria-live="polite"` on a sr-only step-context announcer that fires the `stepOf` + `stepTitle` synchronously on `step` change, independent of the body re-mount.

### H-3 — Status-bar morph animation: `prefers-reduced-motion` collapses transition but does NOT collapse the clip-path geometry
D-2 §2.6 / §9 hard-locks the CSS. The `@media (prefers-reduced-motion: reduce)` block sets `transition: none` — the clip-path still snaps to the new shape on `data-step` change, but instantly. For a user with vestibular sensitivity who set this preference, a leading-edge SHAPE change with no transition is still a discrete motion event in their peripheral vision; the v1.5.5 progress bar fires a flicker on every step change. **Acceptable per spec** but better: under reduced-motion, drop the morph entirely and render a single capsule that grows by width only. D-2 §13 Q4 asks Marc to confirm "downgrade to width-only" — the a11y default IF Marc doesn't decide should be width-only under `prefers-reduced-motion`.

### H-4 — Destructive zone: tier 1 Pausieren is the only switch on the page that shares its tap zone with no label
D-2 §3.8 wireframe: row reads `Pausieren  [●— ]  Erinnerungen pausieren, Verlauf bleibt.` The switch is on the right, the label "Pausieren" is the row title, the helper text is below. Radix Switch's accessible name is whatever is wired via `aria-labelledby` — D-2 doesn't pin which element the switch references. **Fix:** require `aria-labelledby={pauseLabelId} aria-describedby={pauseHelperId}` on `<Switch>`. Same risk on §3.6 NotificationsSection and §3.7 ApiTokensRow / CsvImportRow / etc. — pin the labelledby/describedby contract once at §3 and reference it from every sub-row.

### H-5 — Intake-history kebab/swipe per-row affordance: keyboard equivalent on mobile is undefined
D-2 §6.3: mobile = swipe-to-reveal, desktop = `<DropdownMenu>` kebab. The mobile branch uses CSS scroll-snap (no JS gesture lib). Keyboard users on mobile (e.g. an iPad with a hardware keyboard, or AT users with switch-control) cannot trigger a scroll-snap with Tab. The "swipe-reveal" intrinsically excludes keyboard. **Fix:** the swipe surface MUST also expose the same actions through a kebab/DropdownMenu visible at the row-tail at all viewports — let the SWIPE be an additional discovery affordance, not the only one. The kebab adds 44 px to row tail; the swipe-reveal hides actions until interaction. Both can coexist. Codify in §6.3.

### H-6 — Switch tap target leaks 13 px outside the visible track but no `aria-label` on the `::before` pseudo-element
The project precedent (`switch.tsx`) uses `before:absolute before:inset-[-13px]` to widen pointer-event hit-zone to 44 px. The visual switch is `1.15rem` (~18.4 px) tall. **Gap:** the `::before` is a pseudo-element — it captures clicks but is invisible to AT layout heuristics. iOS VoiceOver's rotor and macOS Accessibility Inspector flag this as a 18×32 px hit area, not 44×44 px. Apple's audit tooling will fail this rule. **Fix on D-2:** every Switch caller on the detail page (NotificationsSection, Pausieren, the page-wide reminder toggles) must ensure the SURROUNDING row is the actual interactive label — wrap the switch + label in a `<label>` (Radix Switch supports this) so the entire row is the hit target reported by AT. D-2 doesn't say this anywhere.

### H-7 — German vs English label length collapse below 44 px on the destructive-zone CTA row
D-2 §3.8 wireframe: `[Medikament löschen]` (≈ 18 chars) on tier 3b. The EN equivalent is `[Delete medication]` (17 chars) — comparable. But §3.7 PhaseManagementRow: `[Auf Standard zurücksetzen]` (26 chars) and `[Speichern]` (10 chars) ride on a `flex justify-end gap-2` footer row. On a 320 px viewport, the row's combined min-width is ~280 px including padding — fits — but EN equivalent `[Reset to defaults]` is shorter. The risk is the OPPOSITE direction: a future locale (es / fr / it / pl per the v1.4.38 expansion) with `Restablecer los valores predeterminados` (40 chars) blows out the row, forcing `flex-wrap` and collapsing buttons below 44 px floor. **Fix:** pin a `min-h-11` floor on every settings-row button AND mandate `flex-wrap gap-2` over single-row layout for any row with ≥ 2 buttons; if buttons wrap, each retains 44 px.

### H-8 — Color contrast — destructive zone CTA on `bg-card`
D-2 §3.8: tier 2 + tier 3a + tier 3b CTAs use `<Button variant="destructive">` which is `bg-destructive text-white`. Project default `--destructive` is roughly the Dracula red `#ff5555` family. White-on-#ff5555 contrast ratio is approximately 3.45:1 — **fails WCAG 2.1 AA for body text (4.5:1), passes Large Text (3.0:1)**. The button is `text-sm font-medium` (14 px, 500-weight) — borderline Large Text per WCAG (Large = ≥ 18 px regular OR ≥ 14 px bold/700). 500-weight is NOT bold per WCAG. **Fix:** D-2 must either (a) raise the button's font-weight to 600 to qualify as Large Text, (b) darken `--destructive` to a 4.5:1 white-text ratio, or (c) switch the variant to a destructive-outline + red-text-on-card (better contrast against #282a36).

### H-9 — The status pill (`<Badge variant="secondary">`) accent dot — Dracula contrast against pill background
D-2 §3.1: pill body is `<Badge variant="secondary">` (likely `bg-secondary text-secondary-foreground`, a low-contrast plate). The accent dot `bg-emerald-500 / bg-amber-500 / bg-zinc-500` sits ON that plate. `bg-zinc-500` (#71717a) on Dracula's `--secondary` (a dark grey) yields ~2.1:1 — the "Beendet" dot is functionally invisible at 8 px. The text saves WCAG 1.4.1 (per C-5) but the dot becomes decorative-only. **Fix:** the dot palette must be Dracula tokens — `bg-dracula-green` (#50fa7b), `bg-dracula-orange` (#ffb86c), `bg-dracula-comment` (#9aa3b3, the existing muted). Tailwind's `emerald-500` / `amber-500` / `zinc-500` are not from the project palette and break the design-token contract Marc has on file.

---

## Medium (8)

### M-1 — Wizard close-X overlap mitigation (D-2 §2.2 fix #1) shrinks the `<Progress>` bar's `right` edge
D-2 §2.2 says move the progress strip to `pr-12` to give the X its own gutter. Acceptable, but `<Progress aria-label={stepOf}>` is the AT-readable counter for the wizard; squeezing it under 80% width on 360 px mobile makes the "Schritt 3 von 8" line wrap UNDER the bar. Verify the text-counter stays on the same row as the progress meter for AT lipreading. **Fix:** wrap the counter + bar in a `flex-col` and keep the X gutter on the OUTER container, not on the progress strip.

### M-2 — `Toast` (sonner) success on mutation is the ONLY persistent confirmation
Throughout D-2 (§3.2, §3.6, §3.8, §3.7 PhaseManagementRow per spec: "Status banner becomes a `toast.success(...)`"), the success indicator is a sonner toast that auto-dismisses (~4 s). AT users may miss the announcement window. **Fix:** the toast region must be `aria-live="polite"` (confirmed in repo) AND every mutation must additionally update the visible UI to a new state the user can re-read. E.g. tier 1 Pausieren toggling to "Pausiert" — the header pill flip is the persistent confirmation; verify D-2 wires the cache invalidation chain so the pill ACTUALLY flips visibly in the same paint, not just on the next route revisit.

### M-3 — `<AlertDialog>` focus-default — Radix focuses Cancel by default; D-2 should pin this for the destructive flow
The locked decision is single-step `<AlertDialog>` for tier 2 + 3a + 3b. Radix UI defaults to focusing the Cancel button on AlertDialog open (the safer choice). D-2 should EXPLICITLY confirm this default is honored — the temptation to autofocus the destructive action for "fewer taps" must be resisted. Note in §3.8.

### M-4 — `<DropdownMenu>` kebab on intake-history rows — missing `aria-label`
D-2 §6.3 mentions a kebab but doesn't pin the trigger's `aria-label`. Lucide `MoreVertical` icon alone has no accessible name. **Fix:** the trigger must carry `aria-label={t("medications.intakeRowActions", { time })}` with the specific row's scheduled time as anchor so each kebab announces unambiguously ("Aktionen für 08:00 Mittwoch").

### M-5 — Heute / Diese Woche / Älter grouping headers must use `<h3>` or equivalent landmarks
D-2 §3.5 lists three group buckets. These need to be `<h3>` headings (under the `<h2>` of `<MedicationDetailSection>`) so AT users can navigate by heading. Today the wrap component renders them inline as `<p>` or `<div>` per the wireframe ASCII. **Fix:** explicitly require `<h3>` for group labels.

### M-6 — Wizard step-icon plate is `aria-hidden="true"` (correct) but the Lucide icon inside has no `aria-hidden`
`MedicationWizardDialog.tsx:419` wraps the icon plate with `aria-hidden="true"` — the inner `<Icon className="...h-6 w-6" />` is implicitly hidden via inheritance, but the project's other icon-in-button patterns explicitly mark every Lucide `aria-hidden="true"`. D-2 §10 ("All `aria-hidden='true'` because labels carry the accessible name") is correct on principle but verify it's enforced on the detail-page section icons too — `Sunrise`, `Repeat`, `Bell`, `Settings2`, etc. carry no semantic value next to a section title.

### M-7 — Tier 2 Beenden confirmation copy: `Keine weiteren Erinnerungen` — no AT context for what "beenden" means
D-2 §3.8 tier 2 dialog body: `Keine weiteren Erinnerungen. Alte Einträge bleiben sichtbar.` For a first-time user with AT (or any user), "beenden" the medication vs "löschen" needs the title to clearly say "Medikament beenden — alle Erinnerungen werden gestoppt, der Verlauf bleibt." instead of relying on the user reading the body separately. The AlertDialog title should fully describe the action. **Fix:** lengthen the title to be self-describing or wire `aria-describedby` so AT reads title+body together.

### M-8 — Notifications switch in §3.6 + helper line "APNs · Telegram · Web-Push" — chip row is decoration
The chip row of active push channels is decorative (read-only). It must not be announced as 3 separate interactive chips. **Fix:** wrap the chips in `<div role="list">` + `<div role="listitem">` per chip, OR make the row a single AT-readable summary like `aria-label={t("medications.notifications.activeChannels", { list: "APNs, Telegram, Web-Push" })}` and `aria-hidden="true"` on the individual badges.

---

## Low (6)

### L-1 — Skip-link target on `/medications/[id]/page.tsx` is `#main-content` via the auth-shell — verify the route page mounts beneath that id
Already in place from `auth-shell.tsx:155-160`. The skip-link works ONLY if the detail page's outer wrapper falls inside `<main id="main-content">` (it does — auth-shell mounts everything under). No new skip-link needed for the long-scroll detail page; the existing one suffices. Mention in D-2 §3 so a future "let's add our own skip link" doesn't double up.

### L-2 — Section-internal navigation: 8 sections is long enough to benefit from a TOC, but the locked spec is top-to-bottom scroll
Not a a11y violation, but power users navigating by heading (NVDA `H` shortcut) will appreciate that every section uses `<h2>` consistently (per `<MedicationDetailSection>`). Confirm — already enforced.

### L-3 — `prefers-reduced-motion` honoured everywhere on the wizard CSS (§2.6 + §2.7) — confirm the same coverage on the detail-page's `<Card>` hover/transitions
shadcn `<Card>` ships no transitions by default, but if the detail page adds `hover:shadow-md transition` or similar polish in 3A, those need `motion-reduce:transition-none`. Codify as an invariant in §3 alongside the existing §2.5 invariant 6.

### L-4 — `<AlertDialog>` content lacks an explicit `<AlertDialogMedia>` icon — fine, but verify the title font-size meets WCAG 1.4.4 reflow at 200% zoom
Title is `text-lg font-semibold` (18 px). At 200% zoom on 320 px viewport = 36 px effective, the AlertDialog content's `max-w-[calc(100%-2rem)]` constraint keeps it readable. No fix; flagged for completeness.

### L-5 — `<Switch>` for tier 1 Pausieren — Radix Switch responds to Space + Enter; confirm no spurious `onKeyDown` handler blocks them on the surrounding row
If the row wraps the switch in a `<label>` per H-6 fix and the row carries `onClick` to trigger the same toggle (for the larger hit target), the keyboard handler must not double-fire. Pin once in §3.8 as a contract.

### L-6 — Wizard `aria-busy={submitting}` is set on both the body wrapper AND the Save button (`MedicationWizardDialog.tsx:358, 376`)
This is technically correct (busy state on container + control) but a single source is cleaner. Not a violation; flagged for tidiness.

---

## Pinned invariants D-2 should absorb before implementation

1. Every section that fetches async data wraps the loading branch in `<Card aria-busy="true" aria-live="polite">`. (C-2)
2. Every section that mutates data hosts a polite `role="status"` region OR persists state visibly within the same paint as the toast. (C-1, M-2)
3. Every icon-only trigger has an `aria-label` derived from i18n + row context. (M-4)
4. Every `<Switch>` is wrapped in a `<label>` so AT reports the row as the hit target, not the 18×32 px visual track. (H-6)
5. Status-pill text never hides; the colored dot is `aria-hidden="true"`. (C-5, H-9)
6. Status-pill dot palette uses Dracula tokens, not Tailwind's `emerald/amber/zinc`. (H-9)
7. `<DropdownMenu>` kebab is always rendered as the keyboard-accessible peer of the swipe-reveal, not a desktop-only fallback. (H-5)
8. Modal stack depth ≤ 2; the row-edit Sheet's destructive flow dismisses the Sheet before opening an AlertDialog peer. (C-4)
9. Wizard step title receives focus when the wizard mounts on any step other than 1 (edit landing). (H-1)
10. `prefers-reduced-motion` collapses the status-bar morph to width-only, not just `transition: none`. (H-3) — open question Q4 for Marc.
11. Destructive CTAs raise font-weight to 600 OR switch to outline-on-card to clear 4.5:1 contrast. (H-8)
12. Heute / Diese Woche / Älter use `<h3>` headings; group dividers are `<Separator role="separator">` not styled `<div>`s. (M-5)

---

## Counts

| Severity | Count |
|---|---|
| Critical | 5 |
| High | 9 |
| Medium | 8 |
| Low | 6 |
| **Total** | **28** |
