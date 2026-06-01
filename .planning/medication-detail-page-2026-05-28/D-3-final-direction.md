# D-3 — Final direction: v1.5.5 medication wizard polish + detail page

Authoritative spec. Reconciles E-1 (frontend), E-2 (UX), E-3 (architecture), E-4 (a11y) against D-2 and Marc's locked decisions. D-2 is superseded by reference. The implementation agent codes against D-3 only.

## 1. TL;DR

v1.5.5 ships a polished `MedicationWizardDialog` (560 px desktop shell, sticky-footer sheet on mobile, calm width-only progress, disciplined spacing) and a new client-side route `/medications/[id]/page.tsx` that restores every action the v1.5.4 cut buried — log today's dose, edit the plan, manage notifications, manage API tokens, import CSV, configure GLP-1 phases in a focused Sheet, walk a three-tier destructive cascade. The page reads as a clinical document from header to destructive footer; one phone-scroll reaches every restored feature. Patient feel: Apple Health-shaped top-down read with the labelled Gefahrenzone Apple lacks, and a wizard that no longer looks asymmetric. Decisions that made it: keep the radius vocabulary the rest of the app ships (no `rounded-xl` Button override, no new motion language on progress), keep mutations honest about server-derived fields, route every Switch through `<label>`, put a kebab on every intake row so keyboard always works.

## 2. Marc's four locked decisions (verbatim)

1. Detail page = new `/medications/[id]/page.tsx`; `/history` stays as bulk-delete sub-route.
2. Delete confirm = single-step `<AlertDialog>`, no type-back-name.
3. Phase editor (GLP-1 titration) = focused `<Sheet>` from a Settings row, NOT inline.
4. Status-bar animation = restrained width-only progress via shadcn `<Progress>` + Tailwind `transition-all`. NO Material-3 three-shape morph, NO clip-path animation, NO new motion vocabulary. D-2 §2.6/§2.7/§9 stripped.

## 3. Critical-fix punch list — must land in v1.5.5

Fourteen Criticals, grouped by area.

### Animation residue (decision #4)

**C-E1-1 — Strip three-shape clip-path morph + `wizard-step-in` keyframe** (E-1 C-1; D-2 §2.6/§2.7/§9; `src/app/globals.css` + `data-step` wiring in `MedicationWizardDialog.tsx`). D-2 committed ~155 LOC of CSS to a three-shape clip-path morph + slide keyframe (violates decision #4; the `@layer components` claim was wrong — only `@layer base` ships). Fix: drop every named CSS rule. Progress bar is `<Progress value={progress} className="h-1.5" aria-label={stepOf} />` — shipped primitive carries `transition-all` (`progress.tsx:24`). Step transitions use tailwindcss-animate `animate-in fade-in-0 duration-200`. Both carry `motion-reduce:*`. Acceptance: grep on `globals.css` returns zero hits for `wizard-progress-bar` / `wizard-step-body` / `wizard-step-in`.

### Wizard polish

**C-E1-2 — Drop `max-w-3xl` wrapper; inherit auth-shell** (E-1 C-2; D-2 §3 page wrapper). D-2 capped at 768 px while siblings inherit `max-w-screen-xl`. Fix: strip the `max-w-3xl mx-auto` wrapper; container stays inherited. `<MedicationDetailSection>` ships `px-3` for per-section comfort. Acceptance: route's outermost `<div>` has no `max-w-*` class; Playwright snapshot at 1024 px matches `/medications/[id]/history`.

**C-E1-3 — Keep `<Button>` at `rounded-md`; icon plate is the only `rounded-xl` accent** (E-1 C-3; D-2 §2.5 invariant 1). D-2 promoted Next button to `rounded-xl` (Button is `rounded-md`, Dialog `rounded-lg`, Card `rounded-xl` — three radii on one surface, violates concentric). Fix: rewrite invariant — **icon plate is the only `rounded-xl` inside the dialog body; every other chrome is `rounded-md` (Button) or `rounded-lg` (Dialog).** No override, no new radius proposal. Acceptance: review checklist flags any `rounded-xl` override on a wizard-child `<Button>`.

### Detail-page architecture (decision #3 + wire correctness)

**C-E3-1 — Resurrect `PhaseConfigDialog` as a focused `<Sheet>` from a Settings row** (E-3 C-1; decision #3; D-2 §3.7 + §7 + §11 + §13 Q3). D-2 committed three sections to an inline editor; decision #3 reverses. Fix: Settings hosts `<PhaseManagementRow>` whose body is a single `[Phasen konfigurieren]` outline button (mounts only on `treatmentClass === "GLP1"` + course window set). Opens new `<PhaseConfigSheet>` (`src/components/medications/sections/phase-config-sheet.tsx`) — resurrects v1.5.4 `{ medicationId, open, onOpenChange }` contract inside `<ResponsiveSheet>` (mobile bottom, desktop right). Hosts four-row green/yellow/orange/red grid + Auf-Standard + Speichern. PUT/DELETE `/api/medications/[id]/phase-config`. Success invalidates `medicationPhaseConfig(id)` + `medicationDependentKeys` + closes. 2 s status banner → `toast.success(t("medications.phaseSaved"))`. No course window → muted `Phasen sind nur mit Kurs-Fenster verfügbar.`; button hidden. Acceptance: conditional mount test; save invalidates two keys + closes.

**C-E3-2 — Drop `pausedAt` from the Pausieren PUT body** (E-3 C-2; D-2 §3.8 Tier 1). D-2 minted client-side `pausedAt`; `updateMedicationSchema` (`validations/medication.ts:257`) exposes only `active`; PUT route (`[id]/route.ts:122-129`) derives `pausedAt` server-side. Fix: Pausieren PUTs `{ active: false }` only; re-activate PUTs `{ active: true }`. Server derives timestamp. Optimistic update flips `medicationDetail(id).active` only. Acceptance: integration test asserts server-set `pausedAt`; grep confirms no `pausedAt` literal on Tier 1 mutation.

**C-E3-3 — Hoist purge + parent PUT/DELETE onto `assertMedicationOwnership`** (E-3 C-3; `api/medications/[id]/intake/purge/route.ts:11-18`, `intake/import/route.ts:34-38`, `[id]/route.ts:29-36` + `:63-66`). Four hand-rolled `findUnique` + `userId !== user.id ? 404` while every other route uses `assertMedicationOwnership`. Purge is the destructive outlier; v1.5.5 promotes it to user-discoverable. Fix: pre-work refactor to `assertMedicationOwnership(user.id, id)`. No behavioural change. Acceptance: grep returns zero hand-rolled checks under `src/app/api/medications/[id]/**`; route tests green.

### A11y mutation feedback + focus + contrast

**C-E4-1 — Polite live region on every mutating section** (E-4 C-1; D-2 §3.2/§3.6/§3.7/§3.8). D-2 left mutation feedback to sonner without pinning the contract. Fix: auth-shell `<Toaster />` carries `aria-live="polite"`. Every mutation persists state visibly in the same paint as the toast — Tier 1 Pausieren flips header pill via optimistic update; Today's-dose card switches to read-only `Heute genommen um HH:MM`; notifications switch flips its label. Per-section contracts in §9 pin the live-region wiring. Acceptance: axe walk asserts toaster region; component tests assert cache update in same render pass as toast.

**C-E4-2 — Loading branch wraps in `<Card aria-busy="true" aria-live="polite">`** (E-4 C-2; D-2 §3.4–§3.7). D-2 named the `Loader2` precedent but did not pin `aria-busy` + `aria-live`. `intake-history-list-v2.tsx:184` ships a bare spinner. Fix: every async section renders loading as `<Card aria-busy="true" aria-live="polite">{spinner}</Card>` per `insight-status-card.tsx:53`. Error: `<p className="text-destructive text-sm">{t("common.loadFailed")}</p>` inside same Card. Empty: section-specific (§9). Acceptance: every new sections component carries the wrapper; axe walk reports zero "missing-live-region" violations.

**C-E4-3 — DOM order: drug name first, edit button last** (E-4 C-3; D-2 §3.1 header + §3.3 cadence row). If implementer reads the right-aligned visual as `<Button>` first + `ml-auto`, tab order announces "Bearbeiten" before `<h1>`. Fix: header DOM is `<div className="flex items-start justify-between gap-3"><div className="space-y-1"><h1>{name}</h1>{dose}{statusRow}</div><Button>{edit}</Button></div>`. Cadence row: section `<h2>` first, `<p>` next, edit last. Acceptance: screen-reader walk announces name → dose → status → "Bearbeiten button".

**C-E4-4 — Modal stack ≤ 2; row-edit Sheet hosts no destructive action** (E-4 C-4; D-2 §6.3). Sheet → peer `<AlertDialog>` mid-close returns focus to `document.body`. Fix: row-edit Sheet hosts only the edit form. Single-row Löschen lives on the row kebab (kebab → `<AlertDialog>` directly). Sheet → AlertDialog stack forbidden. Acceptance: Sheet tree contains no `<AlertDialog>`; focus returns to kebab.

**C-E4-5 — Status-pill text never hides; dot uses Dracula tokens** (E-4 C-5 + H-9; D-2 §3.1). Raw Tailwind palette (`bg-emerald-500` / `bg-amber-500` / `bg-zinc-500`) bypasses theme; D-2 did not pin that text never hides. Fix: `<Badge variant="secondary">` with `Aktiv` / `Pausiert` / `Beendet` text always rendered. Dot `aria-hidden="true"`, Dracula tokens via `bg-[hsl(var(--success))]` / `bg-[hsl(var(--warning))]` / `bg-muted-foreground`. If `--success` / `--warning` not yet exposed, pre-work adds them next to `--destructive` with Dracula `#50fa7b` / `#ffb86c`. Acceptance: axe contrast passes; snapshot at 320 px shows label.

### UX wire correctness + lifecycle (E-2 Criticals)

**C-E2-1 — Two-button Today's-dose card + locked wire shape + `compliance-chart-inline` in bundle** (E-2 C-1; co-resolves E-3 H-1/H-2/H-3; D-2 §3.2; `medicationDependentKeys`). D-2 invented a `DEFERRED`/`Verschoben` status absent from route + schema + i18n; the wire shape mismatched the actual route (`{ scheduledFor, takenAt, skipped, idempotencyKey }`); `compliance-chart-inline` prefix was not in the bundle. Fix: two buttons `[Genommen]` + `[Übersprungen]` (Verschoben dropped, §12); POST `{ scheduledFor: <today-iso>, takenAt: <now-iso>, skipped: boolean }`; card derives "due today" from `medication.cadence` + `summariseCadence`; empty `Heute keine Einnahme geplant.`. Pre-work adds `["compliance-chart-inline"]` to `medicationDependentKeys`; every detail mutation routes through `invalidateKeys(queryClient, medicationDependentKeys)` only. Acceptance: integration test asserts wire shape; cache test asserts inline-compliance evicts in one tick.

**C-E2-2 — `landingStepForEdit` gains `intent`; step title receives focus on landing ≠ 1** (E-2 C-2; co-resolves E-4 H-1/H-2 + E-2 L-4; `wizard-payload.ts:870`; `MedicationWizardDialog.tsx:213-224`). D-2's cadence-row edit promised "the cadence step" but the helper only returns 1 or 8. `key={step}` re-mount drops one frame of focus; `onEditSchedule` 8→5 used `direction="next"`. Fix: `landingStepForEdit(payload, intent?: "cadence" | "summary" | "name"): number` — `"cadence"`→5, `"name"`→1, omitted→current 1/8. Header edit passes `"name"`; cadence row passes `"cadence"`. Title `<h2>` carries `tabIndex={-1}`; focus effect focuses the title first when landing ≠ 1. Slide stripped (C-E1-1) → `direction` state removed. Acceptance: unit test asserts `(payload, "cadence") === 5`; component test asserts title focus on edit-mount.

**C-E2-3 — One-shot variant of the detail page; suppress sections 4/6/7 once logged** (E-2 C-3; D-2 §3 section order). v1.5.4 auto-deactivate (commit `39430e16`) kills notifications post-log; sections 5 / 6 / 7 read as bureaucratic theatre for a single dose. Fix: page branches on `kind = medication.oneShot ? "oneShot" : "recurring"`. One-shot renders 5 sections — Header (Einmalig genommen pill when logged) / Today's-dose-or-logged-state / Cadence static line / Intake row (no grouping) / Verwaltung & Gefahrenzone. Notifications + Settings not rendered. Cadence row hides edit affordance (wizard handles via header edit). Acceptance: snapshot asserts 5 sections; wizard-edit from header lands correctly for one-shot.

## 4. High-priority items that ship in v1.5.5

Bundled by area. `[absorbed]` = a Critical already covers it.

**H-cluster-D — Type cascade + spacing tokens + padding alignment** (E-1 H-1/H-2/H-3/H-4). Wizard title at `text-lg` (sole outlier); "three tokens" framing with eight; page rhythm `space-y-6 sm:space-y-8` while siblings ship one class; body `p-5 sm:p-6` vs strip `p-4`. Fix: wizard title stays `text-base font-semibold leading-tight tracking-tight`. Five buckets — outer `p-4 pr-12 sm:p-6 sm:pr-14`, section `gap-6 sm:gap-8`, row `gap-3`, tight `space-y-1`, footer `gap-2`. Page rhythm `space-y-6`. Strip + body share padding. Tests: component asserts both titles at `text-base`; snapshot asserts shared left edge.

**H-cluster-E — Loading/error/empty contract per section** `[absorbed by C-E4-2]`. Pinned in §9.

**H-cluster-F — Pausieren copy rewrite + two-card destructive split** (E-2 H-1/H-2). Old helper reads as "skip today"; mixing scope+severity in one card hides escalation. Fix: helper → `Erinnerungen anhalten, bis du sie wieder aktivierst. Verlauf bleibt erhalten.`. Split destructive into two cards under heading `Verwaltung & Gefahrenzone`. Card A hosts Pausieren + Beenden (reversible); Card B (`border-destructive/40`) hosts Verlauf + Medikament löschen (irreversible). Tests: i18n key `medications.pause.helper` ships; snapshot shows split.

**H-cluster-G — Bundle includes `compliance-chart-inline`** `[absorbed by C-E2-1]`. Tier 3b orders `await invalidateKeys(...); router.push("/medications");`. Per-row edit/delete also routes through the bundle. Inline comment on bundle explains prefix-match coverage. Tests: cache test asserts inline-compliance evicts on every mutation; Tier 3b lands on fresh cache.

**H-cluster-H — Switch in `<label>`; kebab universal; flex-wrap on settings footers** (E-4 H-4/H-5/H-6/H-7). Switch accessible name unpinned; swipe excluded keyboard; German label length risked flex-wrap collapse < 44 px. Fix: Switch wraps in `<label>` (row = AT hit target); `aria-labelledby` row title + `aria-describedby` helper. Intake-row affordance is `<DropdownMenu>` kebab at every viewport — swipe dropped. Settings footers `flex flex-wrap gap-2 justify-end` with `min-h-11` per button. Tests: axe walk reports no labelling violations; keyboard reaches every action.

**H-cluster-I — Destructive CTA `font-semibold`** (E-4 H-8). `<Button variant="destructive">` ships `text-sm font-medium`; white on `#ff5555` is ~3.45:1. Fix: override to `font-semibold` (600) at call sites — qualifies as WCAG Large Text. Tests: axe contrast walk reports no destructive violations.

**H-3-UX — CSV import only in intake-history header** (E-2 H-3). Settings CsvImportRow becomes one-line stub `Importiere Einnahmen direkt aus dem Verlauf oben.` (no button). Page-level `intakeImportOpen` state lifted into intake-history. Tests: snapshot asserts stub; component asserts single mount.

**H-4-UX — Grace row labelled primary-schedule-scoped** (E-2 H-4). Label → `Erinnerungsfenster — gilt für deinen Hauptzeitplan`; helper explains multi-schedule case (deferred §12). Tests: i18n key `medications.settings.grace.primaryScheduleNote` ships.

**H-6-UX — Status-bar morph contradicts decision #4** `[absorbed by C-E1-1]`.
**H-5-UX — Swipe-to-reveal collides with scroll** `[absorbed by H-cluster-H]`.

## 5. Mediums and Lows — explicit defer or absorb

29 Mediums + 23 Lows (52 rows).

| Origin | Title | Disposition |
|---|---|---|
| E-1 M-1 | Settings buries destructive | absorb (H-cluster-F) |
| E-1 M-2 | Focus-ring on destructive | absorb (no override) |
| E-1 M-3 | Reduced-motion on step-fade | absorb (§10) |
| E-1 M-4 | Raw Tailwind palette on status pill | absorb (C-E4-5) |
| E-1 M-5 | clientManaged copy + key path | absorb (§9) |
| E-1 M-6 | clip-path browser support | absorb (C-E1-1) |
| E-1 M-7 | File-name kebab-case | absorb (§10) |
| E-2 M-1 | Header pill conflates lifecycle+date | absorb (drop `seit DD.MM.` from header) |
| E-2 M-2 | Empty-state inventory gaps | absorb (§9) |
| E-2 M-3 | NL "Aus Text" create-only | absorb (§8) |
| E-2 M-4 | Rolling cadence example missing | absorb (§9.3) |
| E-2 M-5 | clientManaged note placement | absorb (read-only chip when true) |
| E-2 M-6 | Sheet height floor | absorb (`min-h-[40dvh]`; revisit) |
| E-2 M-7 | Bulk-delete no progress | absorb (new bulk-delete endpoint) |
| E-2 M-8 | API endpoint context | absorb (caption + two buttons; §9.7) |
| E-3 M-1 | Header naming drift | absorb (kebab-case extraction; §9.1) |
| E-3 M-2 | Card-header duplication | defer v1.5.6 |
| E-3 M-3 | Wizard `notificationsEnabled` write | absorb (§10) |
| E-3 M-4 | Detail-page tests not enumerated | absorb (§9) |
| E-3 M-5 | IntakeImportDialog single mount | absorb (page-owned state) |
| E-3 M-6 | Bulk-delete partial failure | absorb (same as E-2 M-7) |
| E-4 M-1 | Close-X overlap with progress | absorb (`flex-col` wrapper) |
| E-4 M-2 | Toast is only confirmation | absorb (§10) |
| E-4 M-3 | AlertDialog focus default | absorb (§10) |
| E-4 M-4 | Kebab `aria-label` missing | absorb (§9.5) |
| E-4 M-5 | Group headers `<h3>` | absorb (§9.5) |
| E-4 M-6 | Section icons `aria-hidden` | absorb (§10) |
| E-4 M-7 | Tier 2 self-describing title | absorb (§9.8 copy) |
| E-4 M-8 | Notification chips decorative | absorb (§9.6) |
| E-1 L-1 | Sticky-header overlap | absorb (header static) |
| E-1 L-2 | `useIsMobile()` breakpoint | obsolete (swipe dropped) |
| E-1 L-3 | Icon colour token | absorb (§10) |
| E-1 L-4 | 44 px floor not pinned | absorb (§10) |
| E-2 L-1 | Edit-title sr-only | record only |
| E-2 L-2 | Tier 3a `count === 0` | absorb (disable when 0) |
| E-2 L-3 | Lucide Square → Archive | absorb (§9.8) |
| E-2 L-4 | Step-transition direction | obsolete (slide stripped) |
| E-2 L-5 | `Heute (Mi, 28.05.)` label | defer v1.5.6 |
| E-2 L-6 | Import-dialog extraction order | absorb (§10) |
| E-2 L-7 | Skeleton choreography | absorb (§9 + §10) |
| E-2 L-8 | Sonner vs inline banner | defer v1.5.6 |
| E-3 L-1 | `medicationDetail(id)` in bundle | absorb (comment) |
| E-3 L-2 | Notifications dual-source read | absorb (§9.6) |
| E-3 L-3 | Progress `data-slot` selector | obsolete |
| E-3 L-4 | Wizard double-mount race | record only |
| E-3 L-5 | iOS forward-compat | record only |
| E-4 L-1 | Skip-link target | record only |
| E-4 L-2 | TOC for long scroll | record only |
| E-4 L-3 | `prefers-reduced-motion` on Card hover | absorb (§10) |
| E-4 L-4 | AlertDialog 200% reflow | record only |
| E-4 L-5 | Switch keyboard + onClick | absorb (§10) |
| E-4 L-6 | `aria-busy` on body+Save | record only |

## 6. Final detail-page section order

### Recurring variant (8 sections)

1. **Header band** — drug name + dose + status pill + edit. Static.
2. **Today's dose card** — `[Genommen]` / `[Übersprungen]`. Empty: `Heute keine Einnahme geplant.`.
3. **Cadence summary** — plain-language line + Bearbeiten → wizard Step 5 (`intent: "cadence"`).
4. **Dose ladder / Phasen** — GLP-1 only. Reuses `<TitrationSection>`.
5. **Intake history preview** — last 14 grouped Heute/Diese Woche/Älter, kebab per row. CSV-import trigger in header. Footer link to `/history`.
6. **Notifications** — `<Switch>` in `<label>` + read-only chip strip.
7. **Settings** — Externe Integration / CSV-Import stub / Phasen (button → Sheet) / Grace.
8. **Verwaltung & Gefahrenzone** — Card A (Pausieren + Beenden), Card B (Verlauf + Medikament löschen) under one heading.

### One-shot variant (5 sections)

Drop section 4 (not GLP-1), 6 (notifications already off post-log), 7 (settings nonsensical). Section 5 collapses to one row; section 3 becomes static `Einmalig am DD.MM.` with no edit affordance.

1. Header band
2. Today's-dose-or-logged-state (read-only `Einmalig genommen am DD.MM. um HH:MM` if taken; two-button card if not)
3. Cadence summary static line
4. Intake history (single row)
5. Verwaltung & Gefahrenzone (Pausieren + Beenden + Verlauf löschen + Medikament löschen)

### Paused variant

Same section structure as the active recurring/one-shot variant. Status pill flips to "Pausiert" (Dracula orange dot). Today's-dose card renders muted `Pausiert — keine Erinnerung heute.` with both buttons `aria-disabled` until re-activation. Every other section continues to render — user can still edit, manage phases/tokens, import CSV, walk destructive cascade.

## 7. Final restored-feature placement table

| # | Feature | v1.5.4 | v1.5.5 home | Section | Component |
|---|---|---|---|---|---|
| 1 | Bearbeiten | none | wizard edit (intent-aware) | Header + Cadence | `<MedicationWizardDialog mode="edit">` |
| 2 | Löschen (Medikament) | none | tier 3b | Verwaltung & Gefahrenzone | `<DestructiveZoneSection>` + `<AlertDialog>` |
| 3 | Pausieren / Aktivieren | none | tier 1 | Verwaltung & Gefahrenzone | `<DestructiveZoneSection>` `<Switch>` (PUT `{ active }`) |
| 4 | Benachrichtigungen | none | switch | Notifications | `<NotificationsSection>` + `<Switch>` in `<label>` |
| 5 | Einnahmen importieren | none | intake-history header CTA | Intake history preview | `<IntakeHistoryPreview>` + extracted `<IntakeImportDialog>` |
| 6 | API-Endpunkt | none | Externe Integration sub-row | Settings | `<ApiTokensRow>` (absorbs `ApiEndpointDialog`) |
| 7 | GLP-1 Phasen | none | Phasen sub-row → focused Sheet | Settings | `<PhaseManagementRow>` + `<PhaseConfigSheet>` |
| 8 | Aufzeichnungen löschen | none | tier 3a | Verwaltung & Gefahrenzone | `<DestructiveZoneSection>` + `<AlertDialog>` |
| 9 | Zurücksetzen (create-only) | none | out of scope | — | — |
| 10 | GLP-1 Wochentags-Preset | wizard Step 5 | wizard Step 5 | wizard | `<Step5Cadence>` |
| 11 | Schedule hinzufügen/entfernen | wizard Step 8 | wizard Step 8 | wizard | `<Step8Summary>` |
| 12 | Legacy reminder-window | wizard Step 7 | wizard Step 7 | wizard | `<Step7Times>` (`legacyOnLoad`) |
| 13 | One-Shot Switch | wizard Step 4 | wizard Step 4 | wizard | `<Step4Window>` |
| 14 | Course-Window-Picker | wizard Step 4 | wizard Step 4 | wizard | `<Step4Window>` + `<CourseWindowRow>` |
| 15 | Einnahmen bearbeiten | `/history` (read-only) | preview kebab | Intake history preview | `<IntakeHistoryListV2>` + `onEditIntake` (Sheet) |
| 16 | Einnahmen löschen | same | preview kebab | Intake history preview | `<IntakeHistoryListV2>` + `onDeleteIntake` (peer AlertDialog) |

## 8. Final wizard-polish spec

- **Geometry.** Desktop `<ResponsiveSheet className="sm:max-w-[560px] min-h-[40dvh] md:min-h-0">`. Mobile `<Sheet side="bottom">` capped `max-h-[90dvh]`, sticky footer, `min-h-[40dvh]` (revisit v1.5.6). Progress strip + body share `p-4 pr-12 sm:p-6 sm:pr-14`.
- **Close X.** Shipped top-right; `min-h-11 min-w-11` mobile / 36 px desktop. Raise contrast via `text-foreground/70 hover:text-foreground`. Sr-only label `{t("common.close")}` → `Schließen` (no new key).
- **Spacing — five buckets only.** Outer `p-4 pr-12 sm:p-6 sm:pr-14` / section `gap-6 sm:gap-8` / row `gap-3` / tight `space-y-1` / footer `gap-2`. "Three classes" framing dropped.
- **Radius.** Icon plate `rounded-xl` (only accent). Dialog/Sheet `rounded-lg`. Button `rounded-md` (no override). Card `rounded-xl`.
- **Progress.** `<Progress value={progress} className="h-1.5" aria-label={stepOf} />`. Shipped `transition-all`. No clip-path, no keyframes. `motion-reduce:transition-none` per §10.
- **Step transition.** Fade-only via tailwindcss-animate: `animate-in fade-in-0 duration-200 motion-reduce:animate-none` on body wrapper. `key={step}` triggers it. No slide, no `wizard-step-in`, no `data-direction`.
- **Field error + submit-busy.** `<form noValidate>`. Errors: `<p id={errorId} className="text-destructive text-xs">{error}</p>`; input `aria-invalid="true" aria-describedby={errorId}`. Save `aria-busy={submitting}` + `disabled` (shipped).
- **Title focus.** Body wraps title `<h2>` with `tabIndex={-1}`. Focus effect focuses title first when landing-step ≠ 1.
- **`landingStepForEdit`.** `(payload, intent?: "cadence" | "summary" | "name") → 5 | 1 | (existing 1/8)`. Header edit passes `"name"`; cadence-row passes `"cadence"`.
- **NL "Aus Text".** Renders only when `mode === "create"` (annotated in wireframe).

## 9. Final detail-page-section spec

Per section: layout, component, API, query key, a11y invariants, tests.

**9.1 Header band.** Outer `<div className="flex items-start justify-between gap-3">`. Left `<div className="space-y-1">` hosts `<h1 className="text-2xl font-bold tracking-tight">{name}</h1>` + dose `<p className="text-muted-foreground text-sm">` + status row `<div className="text-xs flex items-center gap-2">` (no `seit DD.MM.`). Right: `<Button variant="outline" size="sm">` Pencil + `t("common.edit")`. New `<MedicationDetailHeader>` at `src/components/medications/medication-detail-header.tsx`. Reads `medicationDetail(id)`. A11y: name first, edit last; status pill text always rendered. Tests: snapshot at 320/768/1024; tab order asserts heading-then-button.

**9.2 Today's dose card.** `<Card className="p-5 sm:p-6 space-y-4">`; `flex gap-2 flex-wrap` row with two `min-h-11 sm:min-h-9` buttons. New `<TodaysDoseCard>` at `src/components/medications/todays-dose-card.tsx`. POST `/api/medications/[id]/intake` with `{ scheduledFor, takenAt, skipped }`. Reads `medicationDetail(id)`; invalidates `medicationDependentKeys`. A11y: polite `role="status"` region announces success; card optimistically switches to read-only `Heute genommen um HH:MM`. Empty: `Heute keine Einnahme geplant.` (new key `medications.today.noneScheduled`). Tests: integration asserts wire shape; component asserts 44 px floor + optimistic switch.

**9.3 Cadence summary.** `<MedicationDetailSection title={t("medications.cadence.title")}>`. Body: `<p className="text-sm">{summariseCadence(payload, t)}</p>` covering every cadence kind (daily / weekday / everyNWeeks / monthly / yearly / rolling / oneShot — e.g. `Alle 12 h nach letzter Einnahme`, `Alle 2 Wochen, mittwochs`, `Monatlich am 15.`). Course-window sub-line when set. Right `<Button variant="outline" size="sm">` Bearbeiten passes `intent: "cadence"`. New `<CadenceSummaryRow>` at `src/components/medications/cadence-summary-row.tsx`. Reads `medicationDetail(id)`. A11y: edit last in DOM. Tests: unit asserts every kind rendered; component asserts intent prop.

**9.4 Dose ladder / Phasen.** Reuses shipped `<TitrationSection>`. Conditional on `treatmentClass === "GLP1"`. Reads `medicationTitration(id)`. A11y inherited. Tests: conditional mount.

**9.5 Intake history preview.** `<MedicationDetailSection>` chrome with header CTA `[⤴ Importieren]` (only CSV trigger). Body groups last 14 rows into Heute / Diese Woche / Älter; group labels are `<h3 className="text-xs uppercase tracking-wide text-muted-foreground">`. Per-row right-edge `<DropdownMenu>` kebab with Bearbeiten + Löschen items + `aria-label={t("medications.intakeRowActions", { time })}`. Footer link to `/medications/[id]/history`. New `<IntakeHistoryPreview>` at `src/components/medications/sections/intake-history-preview.tsx` wraps `<IntakeHistoryListV2>` with optional `onEditIntake`, `onDeleteIntake`, `selection` props. GET `/api/medications/[id]/intake?limit=14&offset=0&sortBy=takenAt&sortDir=desc`. Single-row PUT/DELETE on `[eventId]`; bulk-delete via new `POST /api/medications/[id]/intake/bulk-delete` (pre-work). Reads `medicationIntakeList(...)`; invalidates `medicationDependentKeys`. A11y: `<h3>` headers; kebab `aria-label`; edit opens `<ResponsiveSheet>` with form only (C-E4-4); delete opens peer `<AlertDialog>` from kebab. Tests: keyboard walk; bulk-delete recomputes rollups once per dayKey.

**9.6 Notifications.** `<MedicationDetailSection title={t("medications.notifications.title")}>`. Body: `<label className="flex items-center justify-between">` wraps `<Switch>` (entire row is the hit target). Below: `text-xs text-muted-foreground` summary with single `aria-label`; chip `<Badge variant="outline">` are `aria-hidden="true"`. Quiet-hours preview below. New `<NotificationsSection>` at `src/components/medications/sections/notifications-section.tsx`. PUT `/api/medications/[id]` with `{ notificationsEnabled }`. Reads `medicationDetail(id).notificationsEnabled` for switch state + `notificationsStatus()` for chip strip (dual-source — comment in component). Invalidates `medicationDependentKeys`. Switch `aria-labelledby` row title + `aria-describedby` helper. When `notificationPrefs.clientManaged === true`, switch replaced by read-only chip `iPhone steuert die Erinnerungen` (new key `medications.notifications.clientManagedChip`). Tests: label-wrap as hit target; chip replaces switch.

**9.7 Settings.** `<MedicationDetailSection title={t("medications.settings.title")}>`. Four sub-rows `space-y-4`:

- **Externe Integration** — new `<ApiTokensRow>` (`api-tokens-row.tsx`). Always mounts. Caption `Endpunkt für „{medicationName}"` above URL. Two buttons `[URL kopieren]` + `[Token erzeugen]`; minted token shows in one-shot modal auto-closing after copy. GET/POST `/api/medications/[id]/api-endpoint`, DELETE `/api/tokens/[id]`. Invalidates `tokens()` + `medicationDependentKeys`.
- **CSV-Import stub** — new `<CsvImportRow>`. One-line stub `Importiere Einnahmen direkt aus dem Verlauf oben.`; no button.
- **Phasen** — new `<PhaseManagementRow>` + `<PhaseConfigSheet>`. Mount when GLP-1 + course window. Body: `[Phasen konfigurieren]` outline button opens Sheet with four-row green/yellow/orange/red grid (MINUTES/PERCENT) + `[Auf Standard]` + `[Speichern]`. GET/PUT/DELETE `/api/medications/[id]/phase-config`. Success → `toast.success` + close + invalidate `medicationPhaseConfig(id)` + bundle. Empty (no course window): muted `Phasen sind nur mit Kurs-Fenster verfügbar.`; button hidden.
- **Grace** — new `<GraceMinutesRow>`. Label `Erinnerungsfenster — gilt für deinen Hauptzeitplan`. PUT `/api/medications/[id]` with `{ reminderGraceMinutes }` on primary schedule.

**9.8 Verwaltung & Gefahrenzone.** `<MedicationDetailSection title={t("medications.dangerZone.title")}>` single heading. Body: two `<Card>` children `space-y-4`. New `<DestructiveZoneSection>` at `src/components/medications/sections/destructive-zone-section.tsx`.

*Card A — Verwaltung:*
- Tier 1 Pausieren: `<label className="flex items-center justify-between"><Switch />Pausieren</label>` + helper `Erinnerungen anhalten, bis du sie wieder aktivierst. Verlauf bleibt erhalten.`. No confirmation. PUT `{ active: false }`.
- `<Separator />`
- Tier 2 Beenden: `<Button variant="destructive" className="font-semibold">` + `Archive` icon. `<AlertDialog>` title `Medikament beenden — Erinnerungen stoppen, Verlauf bleibt sichtbar.` + body `Keine weiteren Erinnerungen. Alte Einträge bleiben.`. PUT `{ endsOn: <today-iso> }`.

*Card B — Gefahrenzone (`border-destructive/40`):*
- Tier 3a Verlauf löschen: `<Button variant="destructive" className="font-semibold">`. Disabled when count is 0. `<AlertDialog>` title `Verlauf wirklich löschen?` + body `Die {count} Einnahmen werden unwiderruflich gelöscht. Das Medikament selbst bleibt.`. DELETE `/api/medications/[id]/intake/purge`.
- `<Separator />`
- Tier 3b Medikament löschen: `<Button variant="destructive" className="font-semibold">`. `<AlertDialog>` title `Medikament löschen?` + body lists purge scope. DELETE `/api/medications/[id]`. Success: `await invalidateKeys(queryClient, medicationDependentKeys); router.push("/medications");`.

Every tier invalidates `medicationDependentKeys`. AlertDialog Cancel autofocus preserved; switch label-wrap; destructive CTAs `font-semibold`. Tests: integration asserts four mutations + invalidations + Tier 3b ordering.

## 10. Cross-cutting invariants

1. Async sections wrap loading in `<Card aria-busy="true" aria-live="polite">` (C-E4-2).
2. Mutations either announce via polite live region OR persist state visibly in same paint as toast (C-E4-1, E-4 M-2).
3. Icon-only triggers carry `aria-label` from i18n + row context (E-4 M-4).
4. Every `<Switch>` wraps in `<label>` (H-cluster-H).
5. Status-pill text never hides; dot `aria-hidden="true"` + Dracula tokens (C-E4-5).
6. Kebab always rendered on intake rows; swipe dropped (H-cluster-H).
7. Modal stack ≤ 2; row-edit Sheet hosts no destructive action (C-E4-4).
8. Step title `tabIndex={-1}` + focus on landing ≠ 1 (H-cluster-B).
9. AlertDialog Cancel autofocus stays default — never autofocus destructive (E-4 M-3).
10. Heute/Diese Woche/Älter use `<h3>`; dividers are `<Separator>` (E-4 M-5).
11. Destructive CTAs at `font-semibold` 600 (H-cluster-I).
12. Section-title icons inherit `text-foreground`; body icons `text-muted-foreground`; wizard plate is only `text-primary`; every Lucide `aria-hidden="true"` (E-4 M-6, E-1 L-3).
13. Mobile primary CTAs render `min-h-11`; close-X stays 36 px exception (E-1 L-4).
14. Every animation utility carries `motion-reduce:animate-none` or `motion-reduce:transition-none` (E-1 M-3, E-4 L-3).
15. TanStack keys come from the central factory only — no bare arrays (ESLint `healthlog/queryKey-factory`).
16. Wizard `buildCreateBody` PUT does NOT emit `notificationsEnabled` (E-3 M-3).
17. Every `prisma.X.{create,update}({ data })` builds field-by-field, no spreads (CLAUDE.md).
18. New API routes wrap in `apiHandler(...)` with Zod `safeParse` + `returnAllZodIssues`. Only new route in v1.5.5: `POST /api/medications/[id]/intake/bulk-delete`.
19. `IntakeImportDialog` lifts to `src/components/medications/intake-import-dialog.tsx` as the first commit of the PR series (E-2 L-6).
20. `medicationDependentKeys` includes `["compliance-chart-inline"]` (H-cluster-G).
21. `<MedicationDetailSection>` is the only section chrome; new components mount inside it.
22. New component files are kebab-case under `src/components/medications/sections/` or `src/components/medications/`. PascalCase outliers (`TitrationSection.tsx`, `SideEffectsSection.tsx`, `SchedulingSection.tsx`, `DrugLevelChart.tsx`) are pre-existing per CLAUDE.md (E-1 M-7).
23. Per-section `<Suspense>` boundaries — header + cadence render first, others stream (E-2 L-7).
24. `assertMedicationOwnership` is the single ownership predicate across `src/app/api/medications/[id]/**` (C-E3-3).

## 11. Open questions for Marc

None. Synthesised calls:

- URL split / type-back-name / phase editor / status-bar morph → locked by decisions #1–#4.
- Sheet `min-h` floor (E-2 M-6) → `min-h-[40dvh] md:min-h-0` for v1.5.5.
- Bulk-delete strategy (E-2 M-7 / E-3 M-6) → build `POST /api/medications/[id]/intake/bulk-delete` as pre-work.
- Aggregate `/api/medications/[id]/detail` → defer v1.5.6; per-section `<Suspense>` for now.

## 12. What's deferred to v1.5.6+

- Cadence-engine read-flip (separate v1.5.x track).
- Wider design-system refresh.
- Native iOS mirror — only v1.5.5 addition is `POST /api/medications/[id]/intake/bulk-delete`.
- Multi-medication batch actions on `/medications/page.tsx`.
- Wizard multi-schedule compose mode.
- Aggregate `/api/medications/[id]/detail` endpoint.
- `MedicationCardHeader.tsx` lift to drive list-card + detail-page headers.
- `Heute (Mi, 28.05.)` parenthetical bucket-label.
- `Verschoben` / deferred-dose status (needs schema decision).
- Multi-schedule grace settings.
- "Pausieren bis…" duration-scoped pause.
- `min-h-[60dvh]` sheet floor revisit.
- Sonner-toast vs inline-banner for PhaseConfigSheet save.
- Framer Motion / `motion` / Lottie — CSS only per project rule.
