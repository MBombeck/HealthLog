# E-2 — UX + QoL review of D-2 direction

Scope: walk D-2 against the I-1 punch list, the v1.5.4 wizard Marc tested, and R-2's evidence. Out-of-scope per brief: design tokens, architecture, a11y, and the four locked decisions (URL split, single-step delete, Phase Sheet — overridden to inline by D-2 §3.7, restrained progress animation). Where D-2 has already swapped the locked Sheet for inline editing on Phasen, I flag it but do not relitigate the call; Marc's directive accepted "Sheet" for the editor's *focus*, not the literal primitive, and inline is defensible.

Findings are pinned to D-2 sections (§n) or component files. Verbatim German is quoted where the wording itself is the issue.

---

## Critical

### C1. The Today's-Dose card invents a wire shape that doesn't exist (D-2 §3.2)

D-2 §3.2 specifies:

> API: `POST /api/medications/[id]/intake` with `{ status: "TAKEN" | "SKIPPED" | "DEFERRED" }`. The route already exists; the shape mirrors the per-card action on the list page.

`src/app/api/medications/[id]/intake/route.ts:75` parses `{ scheduledFor, takenAt, skipped, idempotencyKey }`. There is no `status` enum, no `TAKEN`, no `SKIPPED`, no `DEFERRED` anywhere in the route, anywhere in the schema, anywhere in messages/de.json (which carries only `Eingenommen` / `Übersprungen` / `Ausgelassen`). The `DEFERRED` / `Verschoben` concept has no home in the data model.

Three UX consequences cascade off this:

1. The wireframe button **`[⤳ Verschoben]`** can't be wired without a schema migration the v1.5.5 brief does not have on its plate.
2. The list-page per-card action that D-2 says this "mirrors" is the existing `take` / `skip` pair on `<MedicationCard>` — two buttons, not three. The D-2 mock invents a third state.
3. The empty-state line `Heute keine Einnahme geplant.` and the three-button row both depend on a `today's due event` shape that the medication-detail GET does not currently return. The reader needs to compute "is there an event due today" from the schedule — that's a non-trivial cadence-engine call the section assumes is free.

Recommendation: collapse Today's Dose to two buttons (`[✓ Genommen]` / `[✗ Übersprungen]`) and POST the existing wire shape. If "Verschoben" is a v1.5.5 feature Marc wants, it needs an explicit data-model decision (a new `deferredUntil` column? a status enum migration?) flagged in §13 — it cannot ship as "the route already exists; the shape mirrors the per-card action".

### C2. Wizard hand-off lands the user on the wrong step for cadence edits (D-2 §5 + wizard-payload.ts:870)

D-2 §5:

> The cadence-summary row's `[✏ Bearbeiten]` button (lands on `landingStepForEdit(payload)` per the existing helper — currently the cadence step).

`landingStepForEdit` at `wizard-payload.ts:870`:

```ts
export function landingStepForEdit(payload: WizardPayload): number {
  return payload.schedules.length > 1 ? 8 : 1;
}
```

The helper returns Step **1** (name) or Step **8** (schedule list). It does not return "the cadence step". A user tapping `[✏ Bearbeiten]` on the cadence-summary row to fix a cadence question will land on the *name* input (single-schedule meds) or the *summary* (multi-schedule meds) — two screens away from Step 5/6/7 where the cadence actually lives. The Apple Health and Round Health precedents R-2 cited gate "Edit Schedule" behind a dedicated row exactly because rewriting cadence is a heavy operation; landing the user on a different step than the one they tapped on breaks the spatial contract.

Two-row recommendation: either teach `landingStepForEdit` an optional `intent: "cadence" | "summary" | "name"` argument (the header band passes "name", the cadence row passes "cadence" → Step 5), or split the helper so the cadence row imports a different entry function. Either way, the wireframe in D-2 §5 promises a wizard mount it does not currently deliver, and the user-facing wording matters: "Bearbeiten" on the cadence row reads as a cadence-scoped edit, not a full-wizard reopen.

### C3. One-shot medications break the entire section model below Step 4 (D-2 §3 + I-1 §1 item 13)

D-2 §3 locks the eight sections in a recurring-cadence-shaped order. Walk a one-shot vaccine through it:

| § | Section | One-shot reality |
|---|---|---|
| 1 | Header band | OK — `Aktiv` until taken, then? Beendet? Status pill semantics unspecified for one-shot. |
| 2 | Today's dose | OK on dose-day. **What renders on day-1 + 1?** "Heute keine Einnahme geplant." is technically true but reads wrong — the dose was *yesterday*, not "not scheduled". |
| 3 | Cadence summary | D-2 §3.3: "one-shot meds render a single-line `Einmalig am DD.MM.` and hide the Bearbeiten affordance". This contradicts D-2 §5, which says the cadence-row Bearbeiten always opens the wizard. Pick one. |
| 4 | Dose ladder | Hidden when not GLP-1 — fine. |
| 5 | Intake history preview | At most **one** row. The "Heute / Diese Woche / Älter" grouping reads as bureaucratic theatre over one record. |
| 6 | Notifications | Switch is moot once the dose is logged — v1.5.4's auto-deactivate-on-log behaviour (`feat(meds): auto-deactivate one-shot medications when the dose is logged`, commit `39430e16`) means notifications are off the moment the user taps Genommen. The page still renders the switch as if it were live. |
| 7 | Settings | API tokens + CSV import are absurd for a single-dose vaccine. PhaseManagementRow is hidden (no GLP-1). GraceMinutesRow applies but is one minute of decision-surface. The whole section reads as out-of-scope. |
| 8 | Destructive zone | Tier 1 Pausieren is meaningless after the dose was logged; Tier 2 Beenden is redundant with the auto-deactivate. Only Löschen + Verlauf löschen remain coherent. |

The v1.5.4 auto-deactivate behaviour is a quiet but material change: a one-shot medication that's been logged is essentially archived. D-2 needs to treat "one-shot, logged" as a third lifecycle alongside `Aktiv` / `Pausiert` / `Beendet` and suppress sections 2, 5 (or collapse to "Einmalig genommen am DD.MM."), 6, and most of 7. The current spec renders the full ladder regardless, which is the same "dense settings list" critique R-2 §2 levelled at MyTherapy.

Recommendation: add a `kind: "oneShot"` branch at the top of the route that renders a five-section variant — Header, Logged dose card (read-only: "Einmalig genommen am DD.MM. um HH:MM"), Cadence summary (single line), Notifications (only if not yet logged), Destructive zone. Hide §3.4, §3.5 grouping, §3.7 entirely.

---

## High

### H1. Destructive zone Tier 1 (Pausieren) ships without confirmation and without explicit reversibility cue (D-2 §3.8)

> Tier 1 — Pausieren: `<Switch>`, no confirmation. … Fully reversible.

R-2 §D endorses "no confirmation" because pause is fully reversible. The user-facing affordance is fine; what's missing is the *signal* that the pause is reversible. The MyTherapy uservoice thread R-2 cited explicitly shows users uncertain whether "pause" means "skip today" or "stop until I say so". HealthLog's pause is the latter — but the German copy `Erinnerungen pausieren, Verlauf bleibt.` reads more like "skip today" than "park indefinitely". 

Recommendation: rewrite the helper line to `Erinnerungen anhalten, bis du sie wieder aktivierst. Verlauf bleibt erhalten.` — the "bis du sie wieder aktivierst" clause makes the indefinite-but-reversible nature explicit. Marc's voice contract (every committed string is one human writing notes to the next) survives the rewrite.

### H2. The destructive zone has four tiers, not three, and the wireframe order is wrong (D-2 §3.8)

D-2 §3.8 numbers them as `Pausieren / Beenden / Verlauf löschen / Medikament löschen` — four tiers. The ASCII wireframe groups Tier 3a (Verlauf löschen) and Tier 3b (Medikament löschen) together visually but doesn't separate them with the `─────` divider it uses between Beenden and the deletion pair. Two consequences:

1. **Order reads wrong.** The current order escalates Pausieren → Beenden → Verlauf löschen → Medikament löschen, which mixes a *data scope* axis (just-the-history vs. the-whole-record) into a *severity* axis. A patient reading top-down can't tell whether "Verlauf löschen" is more or less destructive than "Beenden" — the former is *irreversibly* destructive over a *narrower* scope; the latter is *recoverable-by-reactivating* over a *wider* scope. Both can't be "less destructive" than the next tier simultaneously.
2. **Visual grouping doesn't match severity.** Apple Health's solution (R-2 §1) is to put Archive (reversible) and Delete (irreversible) at opposite ends of the Options scroll, with one swipe affordance pulling Archive and the other pulling Delete. D-2 puts all four tiers in one card with one divider, which makes the destructive escalation hard to scan.

Recommendation: split into two cards. Card A "Verwaltung" houses Tier 1 (Pausieren) + Tier 2 (Beenden) — both reversible-or-archival operations. Card B "Gefahrenzone" houses Verlauf löschen + Medikament löschen with explicit red-tinted destructive accent (the project already uses `text-destructive` on the Tier 2 + 3 buttons; the card-level distinction makes the severity gradient visible at a glance). The `<Separator>` between the two cards becomes meaningful (visual scope change) rather than decorative.

### H3. The "Einnahmen importieren" trigger appears in two places without precedence rules (D-2 §3.5 + §3.7 + restored-feature table item 5)

> Settings CSV row + Einnahmen header  — `<CsvImportRow>` + `<IntakeHistoryPreview>` header CTA → existing `IntakeImportDialog`

Two surfaces to launch one dialog. Marc's voice contract aside, this surfaces a discoverability question: which trigger wins for the muscle memory of returning users? The header CTA is one scroll away; the Settings row is six scrolls away. If a user lands on the page and the Settings row is the "official" home, the header CTA reads as a duplicate that won't survive the next sweep.

Recommendation: pick one. R-2 §B + §C suggest the intake-history header is the right home because every CSV-import workflow ends with the user wanting to see the new rows land in the history list. Drop the Settings row to a one-line stub `Importiere Einnahmen direkt aus dem Verlauf oben.` with a `Zum Verlauf` link that scrolls to the section. Saves one new component, removes the duplicate.

### H4. Settings section assumes endpoints that the codebase may not expose at the documented paths (D-2 §3.7)

D-2 §3.7 settings-row API column lists:

| Row | API documented in D-2 |
|---|---|
| Externe Integration | `GET /api/medications/[id]/api-endpoint`, `POST` to mint, `DELETE /api/tokens/[id]` |
| Phasen | `GET/PUT/DELETE /api/medications/[id]/phase-config` |
| Grace | `PUT /api/medications/[id]` with `{ reminderGraceMinutes }` |

I-1 §3 confirms `api-endpoint` + `phase-config` routes exist; the `reminderGraceMinutes` field on PUT medication is the one I cannot verify against the code without a deeper read. If grace is currently a per-schedule (not per-medication) field, the implementer needs to pick a primary schedule, which D-2 acknowledges in a parenthetical aside:

> per-schedule field — applied to the medication's primary schedule for the v1.5.5 surface; multi-schedule grace is a v1.5.x follow-up

A user on a multi-schedule medication who edits grace from this row will silently update only one schedule. From the UX side that's the worst-of-both-worlds: it looks like a global control, but writes a scoped one. Either label the row explicitly (`Erinnerungsfenster — gilt für deinen Hauptzeitplan`) or defer the row to v1.5.6 alongside the multi-schedule handling.

### H5. Intake history preview's swipe-to-reveal pattern collides with vertical scroll on 360 px (D-2 §6.3)

> The trigger element on mobile is a swipe-to-reveal Bearbeiten + Löschen affordance using CSS scroll-snap (no JS gesture library — the project bans new dependencies).

CSS scroll-snap horizontal-on-a-vertically-scrolling-list works, but on a 360 px viewport with 14 rows stacked, every accidental horizontal drag near the edge of a row pulls the row into reveal-state. The Apple Health and MyTherapy precedents R-2 cited use native iOS swipe — backed by `UISwipeActionsConfiguration`, which has gesture-arbitration code HealthLog doesn't have access to in a PWA.

Worse: the destructive `Löschen` reveals on the **right** (per the wireframe), which is the same edge a right-handed thumb naturally rests near while scrolling. The thumb-reach map for a 360 × 800 viewport puts the right-edge bottom half in the "easy reach" zone — exactly where the user wants to scroll and exactly where they'll accidentally trigger Löschen.

Recommendation: lean on the desktop pattern for mobile too — kebab `<DropdownMenu>` at the row's right edge, always visible, 44 px tap target. The kebab is the project precedent (`intake-history-list-v2.tsx` already ships with `text-muted-foreground` row controls). The swipe affordance only makes sense if it's gestur-arbitrated against the parent scroll — and that's a JS dependency the project bans. Document the decision in §13 so Marc can override if he wants the iOS-feel.

### H6. Status-bar morph animation spec contradicts the locked decision (D-2 §2.6 + brief locked decision #4)

The locked decision is:

> Status-bar animation = restrained width-only progress in the existing HealthLog design vocabulary (NO Material-3 three-shape morph, NO new motion language).

D-2 §2.6 + §9 ship the three-shape clip-path morph (half-circle → rounded square → capsule → full capsule). The CSS doesn't import a new library, but it absolutely introduces a new motion language — the discrete shape morph is exactly what Marc's locked decision rules out.

The brief is explicit that this audit reviews D-2 for UX coherence and does NOT relitigate the four locked decisions. The morph spec violates a locked decision; either D-2 is wrong or the locked decision wasn't communicated to D-2's author. Surface this for Marc to resolve before implementation. If the spec stands, drop §2.6 + §9 entirely and replace with `<Progress value={progress} className="h-1.5" aria-label={stepOf} />` plus a CSS-only width transition matching the existing `<Progress>` primitive default.

---

## Medium

### M1. Header status pill conflates two orthogonal axes (D-2 §3.1)

> `Aktiv` / `Pausiert` / `Beendet`

These are lifecycle states. The header band also surfaces the cadence summary (`Wöchentlich · seit 12.03.`) and the dose. The wireframe shows three pills' worth of information on one line, which on 360 px will wrap. The `seit 12.03.` postfix is muted but reads as a date of *activation*, not the course start — and for a course-window medication those are different days. Recommendation: drop `seit DD.MM.` from the header (it's repeated on the cadence-summary row a few pixels below) and let the pill carry only the lifecycle state.

### M2. Empty-state copy inventory is incomplete (D-2 §3.2 + §3.5 + §3.7)

D-2 pins copy for:

- §3.2 Today's dose: `Heute keine Einnahme geplant.` (new key needed)
- §3.5 Intake history preview: `Noch keine Einnahmen erfasst.` (exists at `messages/de.json:1033`)
- §3.7 ApiTokensRow: `Noch kein Token erzeugt.` (new key needed)
- §3.7 PhaseManagementRow: `Phasen sind nur mit Kurs-Fenster verfügbar.` (new key needed)

Not pinned:

- §3.3 Cadence summary when payload is incomplete (cadence has no schedule yet — only reachable through a corrupted record but the page still has to render)
- §3.4 Dose ladder when titration catalog is missing for a GLP-1 row
- §3.6 Notifications when no push channel is configured (the helper line "APNs · Telegram · Web-Push" doesn't degrade gracefully to "Keine Push-Kanäle konfiguriert")

Pin the missing four; add the four new DE keys to the i18n table in §10.

### M3. The natural-language "✨ Aus Text" affordance disappears on edit but the wireframe doesn't say so (D-2 §2.3 header structure)

Wizard code `MedicationWizardDialog.tsx:388`:

```tsx
{step === 1 && mode === "create" && (
  <Button ... >Aus Text</Button>
)}
```

The button only renders on `mode === "create"`. D-2 §2.3 wireframes the header with `[✨ Aus Text]` shown, no note that it's create-only. A reader following the wireframe to the letter would mount the button in edit mode, where the NL extractor doesn't have a sensible reset path. Annotate the wireframe.

### M4. R-2's rolling-cadence wording is missing from the cadence-summary row (D-2 §3.3)

R-2 §A item 3 explicitly calls out "Alle 12 h nach letzter Einnahme" as a Dosecast-pattern sentence the cadence-summary line should support. The example sentences in D-2 §3.3 mock only `Wöchentlich, mittwochs · 08:00`. The `summariseCadence` helper already supports the `rolling` cadence (`summary.cadence.rolling`), but D-2 doesn't restate it in the wireframe — which matters because the wireframe is what the implementer reads first. Add one rolling example, one everyNWeeks example, one monthly example. The R-2 patient-pain item — "I can't model schedules that aren't every day" — needs the wireframe to *show* the non-daily case.

### M5. `clientManaged` note placement is buried (D-2 §3.6)

> when the calling session has `notificationPrefs.clientManaged === true`, render a single `text-xs text-muted-foreground` line: `Diese Erinnerungen werden auf deinem iPhone verwaltet.`

A `text-xs text-muted-foreground` line below an unresponsive switch is the worst-of-both-worlds: the switch reads as broken until the user reads the explanation. Either disable the switch with a tooltip-on-tap, or replace the switch entirely with a read-only chip `iPhone steuert die Erinnerungen` when `clientManaged` is true. The iOS coordination memo for v1.4.49 hard-rules that the server cron skips dose-due APNs when this flag is true; the UI should match that hard-rule visually.

### M6. The wizard's primary CTA on Step 8 (Save) sits inside a sticky footer; the height contract isn't honoured by the v1.5.4 code (D-2 §2.1 + MedicationWizardDialog.tsx:330-368)

D-2 §2.1 specifies `min-h-[60dvh] md:min-h-0` on the ResponsiveSheet to fix the "too short" bug Marc reported. The footer is sticky-pinned in the Sheet branch but absolute-positioned in the Dialog branch (both via `ResponsiveSheet`). On a 60dvh-tall sheet with two visible inputs (e.g. Step 3 Dose) the body fills less than the floor and the footer floats mid-screen with whitespace below — which is uglier than the cramped state D-2 was trying to fix. Either drop the floor to `min-h-[40dvh] md:min-h-0` or move the footer to the natural document flow on short steps. The fix is a regression risk and needs a screenshot pass at every step on a 360 × 640 viewport before merge.

### M7. Bulk-delete on `/medications/[id]/history` ships without a per-row optimistic strategy (D-2 §6.2)

> Backend: existing `DELETE /api/medications/[id]/intake/[eventId]` looped via `Promise.allSettled` — no new API route.

The user marks 50 rows, taps `Löschen`, the page fires 50 parallel `DELETE`s. With `Promise.allSettled` the UI gets a single "X erfolgreich, Y fehlgeschlagen" summary at the end. UX consequence: the user sees no progress for 50× the per-DELETE latency (~1-2 s on a cold rollup-tier query). A 30 s "wait while we delete" is a worse experience than the "no bulk delete" state. Either gate bulk-delete behind a max of 20 rows per submit (with a "split into batches?" prompt above), or build a dedicated `DELETE /api/medications/[id]/intake?ids=...` route as a v1.5.5 prerequisite. Document the decision in §13.

### M8. ApiTokensRow's "Endpunkt: POST /api/medications/abc/intake" + Kopieren is opaque (D-2 §3.7 ApiTokensRow wireframe)

The user sees the endpoint URL with `abc` as the literal medication id. That's the actual id of the medication — opaque to a patient ("what's abc and why is it my medication?"). Round Health and Dosecast hide raw IDs entirely; the API-token flow is the one place a power-user needs the id, but the wireframe doesn't label *which* medication's endpoint this is. Add a one-line caption `Endpunkt für „Mounjaro 7,5 mg"` above the URL so the user is anchored.

Worse: a `Kopieren` button is shown but the wireframe doesn't disambiguate "copy the URL" vs. "copy the URL + a freshly-minted token". The original `ApiEndpointDialog` would mint a token and surface it once (HMAC-SHA256 means the plaintext is gone after that view). The settings row needs to make "the token plaintext appears here ONCE; copy it now" explicit — this is a security-sensitive copy decision that R-2 §C marked as the place users complain about ambiguity.

---

## Low

### L1. The wizard's edit-title interpolation is fragile for long medication names (D-2 §2.3 + MedicationWizardDialog.tsx:303)

`t("medications.wizard.header.editTitle", { name: initial.name })` renders something like `Mounjaro 7,5 mg bearbeiten`. D-2 §2.3's wireframe header reserves a single line for "Schritt 3 von 8" + "✨ Aus Text". The edit-title is the dialog's title (passed to `<ResponsiveSheet title>`) but the wizard sets `hideHeader`, so the title is screen-reader-only. Fine. But the new 560 px geometry adds enough room to *show* the edit title, and that would be more user-friendly than leaving it as sr-only. Surface this as an enhancement option.

### L2. The destructive Tier 3a body interpolates `{count}` without an empty-state fallback (D-2 §3.8)

> body `Die {count} Einnahmen werden unwiderruflich gelöscht. Das Medikament selbst bleibt.`

If the user opens Verlauf-löschen on a medication with zero intakes, the dialog reads `Die 0 Einnahmen werden unwiderruflich gelöscht.` Either disable the affordance when count is 0 or branch the copy to `Es sind keine Einnahmen zum Löschen vorhanden.` The cleaner fix is the disable — there's nothing to confirm.

### L3. The Lucide icon for Tier 2 Beenden is `Square` (D-2 §10)

`Square` is a content-empty icon (just a square outline). Apple Health uses an archive-box glyph; the lucide equivalent is `Archive` or `ArchiveX`. `Square` reads as "stop button" only in TV-remote context, not in a medication-management surface. Swap to `Archive`.

### L4. The wizard step-transition animation direction logic doesn't propagate to the goto-from-Step-8 case (D-2 §2.7)

The `onEditSchedule` handler at `MedicationWizardDialog.tsx:230` does `setStep(5)` — that's a *backward* jump from 8 to 5 but uses the default `direction = "next"` (the state defaults to "next" on the initial render and only flips on `goBack`). The user would see an 8 px slide-from-right when navigating from "I'm editing the summary" to "I'm editing schedule 2's cadence" — directionally wrong. Set `setDirection("back")` in `onEditSchedule` too, or build a `goToStep(step, direction)` wrapper.

### L5. "Heute" group label in the intake history preview reads as a date, not a relative bucket (D-2 §3.5)

The R-2 reference apps (MyTherapy, Apple Health) label the group with the absolute date (`Mo, 28.05.`) and let the user infer "today" from context. The German `Heute` reads as a label, not a date, which is correct for the bucket but creates ambiguity when the user scrolls back: the next row's date-context starts at "Diese Woche", forcing the eye to compute "what's today's date" from elsewhere on the page. Add the absolute date in parens for unambiguous timestamping: `Heute (Mi, 28.05.)`. Low because the existing pattern is fine for chronic users; the parenthetical is the polish layer.

### L6. The intake-import dialog extraction (D-2 §11 refactor pre-work) is a separate PR but D-2 doesn't say so

> Refactor pre-work: extract `IntakeImportDialog` from `src/app/medications/page.tsx` into `src/components/medications/intake-import-dialog.tsx` so the detail page imports cleanly.

The extraction crosses test-coverage boundaries (list-page test mocks vs. detail-page test mocks). v1.5.5 PRs that bundle the extraction with the new detail page will be hard to review; the rebase risk on `develop` while the marathon runs is non-trivial. Note this as "land the extraction as the first commit of the PR series" so the diff stays scannable.

### L7. The skeleton/loading choreography is unspecified across the whole page (D-2 §3 + §11)

The detail page reads four to six endpoints (`medicationDetail`, `medicationTitration` for GLP-1, `medicationIntakeList`, `notificationsStatus`, `tokens`, `medicationPhaseConfig` for GLP-1). D-2 doesn't pin a per-section skeleton vs. a whole-page spinner. The existing history page at `[id]/history/page.tsx:51` blocks the entire page on `(authLoading || medLoading)`. Replicating that for the detail page would mean the user sees a spinner while *every* tail call resolves — including the GLP-1 phase-config, which is slow on uncached tenants. R-2 §A's "concentric document" reads of the detail surface assume the header band lands first and sections cascade in. Per-section `<Suspense>` boundaries are the project precedent (mentioned in MEMORY.md re v1.4.40 W-13 per-tile Suspense). Pin the staging: header + cadence-summary render on the first paint, every other section streams in. Without this in D-2 the implementer will default to the history-page blocking pattern.

### L8. Sonner toast precedent vs. inline status banner (D-2 §3.7 PhaseManagementRow)

> Status banner becomes a `toast.success(t("medications.phaseSaved"))` — drop the 2 s auto-clear banner.

The 2 s banner in the original `PhaseConfigDialog` was close to the action that fired it — eyes already pointing at the save button see the success. A sonner toast lives in the top-right of the viewport, away from the save button on the bottom of the settings section. The patient may not even see the toast if they're scrolled into a section. The 2 s banner was actually better UX for a settings-card save; defending the swap needs a "where does the user's eye land after save?" answer D-2 doesn't give. Recommendation: keep the inline banner for in-card saves, reserve sonner for cross-page operations.

---

## Summary

- **Critical: 3** — C1 (Today's-Dose wire shape doesn't exist), C2 (cadence-row Bearbeiten lands on wrong step), C3 (one-shot meds break the section model).
- **High: 6** — H1 (Pausieren copy ambiguous), H2 (destructive zone tier ordering), H3 (CSV-import duplicate triggers), H4 (grace silently scoped to one schedule), H5 (swipe-to-reveal collides with scroll), H6 (status-bar morph violates locked decision).
- **Medium: 8** — M1 (header pill conflation), M2 (empty-state inventory gaps), M3 (NL button create-only undocumented), M4 (rolling-cadence example missing), M5 (clientManaged note placement), M6 (sheet floor regression), M7 (bulk-delete no progress), M8 (API endpoint context).
- **Low: 8** — L1 (edit title sr-only), L2 (zero-intake purge copy), L3 (Lucide icon swap), L4 (step-transition direction edge case), L5 (Heute label ambiguity), L6 (extraction PR order), L7 (loading choreography unspecified), L8 (toast vs. banner).

Marc-walk count for the brief scenario ("öffne /medications → lösche heute morgens Einnahme → pausiere für 3 Tage"): **7 taps** today (medications → card → detail → history-preview kebab → Bearbeiten/Löschen → confirm → back to detail → destructive pause switch). Down from the v1.5.4 status of "unreachable except via API". Friction concentrates at the kebab → swipe pattern (H5) and the missing "pause for 3 days" affordance — D-2's pause is indefinite, not duration-scoped. The patient who said "pause for 3 days" needs a `Pausieren bis…` date-picker option that no tier of the destructive zone offers; that's a v1.5.6 enhancement, not a v1.5.5 hold.

Restored-feature mapping (I-1 → D-2 §4): all 16 features traced. Items most awkward in the new home: #15 + #16 (intake CRUD via swipe — see H5) and #6 (API endpoint — see M8). Every other feature reaches a more discoverable surface than v1.5.4 buried it under.
