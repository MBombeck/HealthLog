# E-3 — Architectural review of D-2 (v1.5.5 medication-detail direction)

Reviewer: senior software architect, audit-only. The four Marc-locked
decisions (detail page at `/medications/[id]/page.tsx`; single-step
`<AlertDialog>` for delete; focused `<Sheet>` phase editor; restrained
width-only status-bar morph) are out of scope — the audit only checks
that the surrounding design is sound around them.

Severity legend: **Critical** = will break or leak on first deploy /
silently violate a project invariant; **High** = ships with a known bug
or invalidation gap and will surface in production; **Medium** = costs
churn or carries risk worth addressing before code lands;
**Low** = polish, naming, future-flex.

Tally: **3 Critical**, **5 High**, **6 Medium**, **5 Low** (19 total).

---

## CRITICAL

### C-1 — Marc-locked decision contradicts the rest of D-2 on PhaseConfigDialog

- **D-2 reference:** §3.7 sub-row table + §3.7 PhaseManagementRow narrative + §7 "inline editor for Phasen, no nested dialog" + §13 Q3.
- **Marc-locked direction:** "Phase editor = focused `<Sheet>`."
- **Conflict:** Three separate sections of D-2 explicitly commit to an inline `<PhaseManagementRow>` editor that REPLACES the v1.5.4 PhaseConfigDialog ("nesting modals inside a settings card is the v1.5.4 mistake repeated"). The locked decision reverses that. D-2 still has §13 Q3 unresolved.
- **Why this is Critical:** the entire §3.7 / §7 / §3.4 architecture is built around the inline pattern. A focused-Sheet variant moves `<PhaseManagementRow>` out of the SettingsSection composition, changes the invalidation surface (sheet open/close lifecycle vs always-mounted row), and re-introduces the orphaned-trigger risk pattern that bit v1.5.4 — the Sheet only matters if there is a row to open it from, and D-2 §11 lists no such trigger.
- **Action:** rewrite §3.7 + §7 + §11 + §13 to spell out the resurrected PhaseConfig sheet: where the trigger lives (settings sub-row CTA), what its prop surface is (resurrect the deleted I-1 §4 contract: `{ medicationId, open, onOpenChange }`), how Phasen empty state ("Phasen sind nur mit Kurs-Fenster verfügbar.") renders inside the trigger row when GLP-1 + no course window, and what query keys the sheet's save / reset mutations invalidate. Resolution of §13 Q3 must land BEFORE implementation.

### C-2 — Tier 1 "Pausieren" Switch wired to a non-existent field

- **D-2 reference:** §3.8 Tier 1: `PUT /api/medications/[id]` with `{ active: false, pausedAt: <iso> }`.
- **Live tree:** `src/lib/validations/medication.ts:257` exposes `active` on `updateMedicationSchema`, but NOT `pausedAt`. The PUT route at `src/app/api/medications/[id]/route.ts:122-129` computes `pausedAt` server-side as a derived patch — flipping `active:false` automatically stamps `pausedAt = new Date()`, and `active:true` clears it. Clients that send `pausedAt` get it dropped by Zod's strip-unknowns and the server overrides anyway.
- **Why this is Critical:** the wire contract in D-2 mints a client-side `pausedAt` timestamp the server will ignore. If a future schema migration changes the strip-unknowns posture (Zod v4 has `.strict()` knobs) the PUT 422s. The detail page would ship "works on my machine" until the schema tightens.
- **Action:** §3.8 Tier 1 should drop the `pausedAt` field from the PUT body. The active-flip is sufficient — the server derives `pausedAt` correctly. Same fix for the I-1 §1 "Pausieren / Aktivieren" snippet.

### C-3 — Authz read of `/api/medications/[id]/intake/purge` differs from the rest of the cluster

- **D-2 reference:** §3.8 Tier 3a — Verlauf löschen → `DELETE /api/medications/[id]/intake/purge`.
- **Live tree:** `src/app/api/medications/[id]/intake/purge/route.ts:11-18` does NOT use the `assertMedicationOwnership(...)` helper that every other route in the cluster (intake, intake/[eventId], intake/import via the inline check, api-endpoint, phase-config, cadence, glp1, compliance, inventory) routes through. It rolls its own `findUnique({ where: { id } })` + `userId !== user.id ? 404`. The check IS correct today — but it's the only purge surface in the tree and D-2 promotes it to a user-discoverable destructive flow that runs alongside per-event DELETE in the same UI band.
- **Why this is Critical:** consistency now is cheaper than a CVE later. The route was added before the `assertMedicationOwnership` hoist (v1.4.25 W21 Fix-N); the v1.5.5 PR is the natural moment to fold it in so a future schema/auth change cascades through one helper, not nine route-local copies. Without this, the purge route is the one outlier where a developer changing the ownership predicate forgets to update the manual check.
- **Action:** §3.8 Tier 3a should call out a pre-work item: refactor `src/app/api/medications/[id]/intake/purge/route.ts:14-18` to use `assertMedicationOwnership` so the destructive cluster has a single ownership predicate. Same review pass for `intake/import/route.ts:34-38` and `[id]/route.ts:29-36` + `:63-66` while we're here (PUT + DELETE on the parent route also hand-roll `findUnique`).

---

## HIGH

### H-1 — Cache invalidation cascade for §3.8 destructive tiers is partially undocumented

- **D-2 reference:** §3.7 "Invalidate" column lists keys for the four settings sub-rows; §3.8 lists no explicit invalidation contract for any of the three destructive tiers.
- **Live tree:** `medicationDependentKeys` (`src/lib/query-keys.ts:357-364`) bundles `medications()` + `analytics()` + `insightsRoot()` + `insightsTargets()` + `gamificationAchievements()` + the `["dashboard-medication-compliance"]` prefix. The per-medication keys NOT in the bundle: `medicationDetail(id)`, `medicationTitration(id)`, `medicationCadence(id)`, `medicationGlp1Details(id)`, `medicationIntakeList(...)` prefix, `medicationCompliance(id)`, `medicationPhaseConfig(id)`, `medicationIntakeDrugLevelChart(id)`. Pause, Beenden, Verlauf-löschen, Medikament-löschen each touch a different subset.
- **Why this is High:** §3.8 wires four mutations into the same UI band; if the implementation copies the wizard's `invalidateKeys(queryClient, medicationDependentKeys)` (the wizard's pattern at `MedicationWizardDialog.tsx:274`), the detail-page header pill won't re-render after Pausieren (`medicationDetail(id)` is not in the bundle), the inline compliance chart won't refresh after Verlauf-löschen (`medicationCompliance(id)` and `medicationIntakeDrugLevelChart(id)` not in the bundle), and on Medikament-löschen the `router.push("/medications")` racing with the in-flight invalidations leaves the destination page reading from the still-warm `medications()` cache for ~60 ms.
- **Action:** add a per-tier invalidation table to §3.8 mirroring §3.7's. Concretely:
  - Tier 1 Pausieren → `medicationDependentKeys` + `medicationDetail(id)` + `medicationCadence(id)` + `medicationCompliance(id)`.
  - Tier 2 Beenden → same as Pausieren.
  - Tier 3a Verlauf löschen → `medicationDependentKeys` + `medicationDetail(id)` + `medicationIntakeList(id, *)` prefix + `medicationIntakeDrugLevelChart(id)` + `medicationCompliance(id)` + `medicationCadence(id)` + `["compliance-chart-inline"]`.
  - Tier 3b Medikament löschen → `medicationDependentKeys`, then `router.push("/medications")` AFTER `await invalidateKeys`, not before.

### H-2 — `medicationIntakeList` prefix invalidation is not declared in `medicationDependentKeys`

- **D-2 reference:** §3.5 "Per-row affordance" + §6.3 edit/delete mutations declare "Invalidates the `["medications", id, "intake", "list"]` prefix."
- **Live tree:** `queryKeys.medicationIntakeList(...)` at `src/lib/query-keys.ts:98-118` builds `["medications", id, "intake", "list", sortBy, sortDir, limit, offset, status]`. The list prefix is `["medications", id, "intake", "list"]`. `medicationDependentKeys` (`:357-364`) only ships the `["medications"]` root. Per TanStack's hierarchical-prefix semantics that DOES invalidate every sub-key including the intake list — so the read is "everything refetches on every intake mutation" rather than "only the intake list".
- **Why this is High:** D-2 §3.5 + §6.3 describe a narrower invalidation than what `medicationDependentKeys` actually performs. Worse, the per-row Edit / Delete on §6.3 routes through `invalidateKeys(queryClient, medicationDependentKeys)` and gets the full cascade — every other medication's compliance, the analytics tree, the achievements, the dashboard compliance chart. That is the right behaviour (compliance changes on any intake edit), but D-2 wording implies otherwise.
- **Action:** §3.5 + §6.3 should explicitly invoke `invalidateKeys(queryClient, medicationDependentKeys)` for both edit + delete + bulk-delete. The prefix-only language is a footgun for the implementer.

### H-3 — Cross-surface invalidation: dashboard `medication-intake-quick-add` already runs the bundle + a one-off `["compliance-chart-inline"]` fan-out — detail page must mirror

- **D-2 reference:** §3.2 Today's dose card "invalidates `medicationDependentKeys` and `queryKeys.medicationDetail(id)` on success."
- **Live tree:** `src/components/dashboard/medication-intake-quick-add.tsx:265-270` runs `await invalidateKeys(queryClient, medicationDependentKeys)` AND `await queryClient.invalidateQueries({ queryKey: ["compliance-chart-inline"] })` because `compliance-chart-inline` is a bare-literal key (factory-routed as `medicationComplianceChart` at `query-keys.ts:74-75` but the prefix is NOT in the bundle).
- **Why this is High:** when the user taps Genommen on the detail page, the dashboard's compliance chart (if cached from a previous session) won't refresh. The two surfaces drift. The fix in v1.4.40 W-RSC was to add `["dashboard-medication-compliance"]` to the bundle, but the per-medication inline chart prefix was left out.
- **Action:** either (a) add `["compliance-chart-inline"]` to `medicationDependentKeys` so every surface stays symmetric, or (b) mirror the explicit two-key fan-out in §3.2 + §3.8 + the wizard's onSuccess. Preference (a) — one source of truth wins.

### H-4 — Forward-compat: detail page reads through legacy cadence helpers that the v1.5.x read-flip hasn't yet replaced

- **D-2 reference:** §3.3 "reuses the existing `summariseCadence(payload, t)` helper" — that helper sits in `wizard-payload.ts` and consumes the `WizardPayload` shape; §12 "Cadence-engine read-flip (separate v1.5.x track)" acknowledges the timing.
- **Live tree:** `medication-card.tsx:91-113` reads `parseScheduleRecurrence(schedule.daysOfWeek)` and walks `recurrence.daysOfWeek` / `recurrence.intervalWeeks` to compute the next dose, NOT through `src/lib/medications/scheduling/recurrence.ts` (the canonical engine, which the v1.5.0 cut wired only to the reminder worker per the file's own preamble at `recurrence.ts:7-13`). A rolling-cadence medication minted by the wizard has `rollingIntervalDays` set, but `medication-card.tsx` walks `parseScheduleRecurrence(schedule.daysOfWeek)` first and only falls back to the rolling tier if the recurrence walker emits nothing — which it will, but the read happens through the legacy chip render, not the canonical engine.
- **Why this is High:** D-2 §3.3's cadence-summary line uses `summariseCadence` correctly (the wizard's helper is fed by the wizard payload), so the row reads "every 7 days" for a rolling-cadence medication. But `MedicationCardHeader` / `SchedulingSection` / `glp1-medication-card` (the other surfaces D-2 §3 doesn't touch) still surface the legacy chip. If the detail page is the primary surface a user lands on after editing, they may see the rolling label but the dashboard card still paints a weekly chip — a known v1.5.x defect D-2 doesn't propagate the warning for.
- **Action:** §12 should explicitly enumerate which detail-page rows are read-flip-safe (the new cadence summary in §3.3 is, because it reads `summariseCadence` over the WizardPayload) and which inherit the v1.5.x legacy reader (the GLP-1 §3.4 dose ladder via `SchedulingSection`, if mounted alongside — D-2 §3.4 says it's not mounted directly but the history-page route still mounts it). Document the read-flip caveat at the detail-page level so the implementer knows where NOT to add a "consistent across surfaces" assertion in tests.

### H-5 — N+1 round-trips on detail-page mount, no aggregate `/detail` endpoint considered

- **D-2 reference:** §11 component tree implies ≥ 7 concurrent reads on mount: `medicationDetail(id)` (header + cadence summary + today's card share this), `medicationTitration(id)` (GLP-1 conditional), `medicationCadence(id)` (today's-dose schedule resolution if applicable), `medicationIntakeList(id, default-params)` (history preview, 14 rows), `notificationsStatus()` (notifications section helper line), `tokens()` (settings api-tokens), `medicationPhaseConfig(id)` (settings GLP-1 conditional), plus the api-endpoint per-medication probe.
- **Live tree:** each route is its own `apiHandler(...)` round-trip. The cadence + intake routes carry sub-100ms p50 today; the api-endpoint probe (`isApiGloballyEnabled()` + `count`) and the tokens read (Bearer-scoped list) are the two slowest.
- **Why this is High:** the detail page is the primary post-edit landing surface. The marathon's perf budget calls out the page-blocking critical path target ≤ 1 s; eight serial-tolerant but mount-fanout reads against a busy Postgres pool risk pool starvation under load — the v1.4.40 audit identified this exact class as the "fan-out starves Prisma pool" symptom.
- **Action:** consider a single `/api/medications/[id]/detail` aggregate endpoint that folds the medication + titration + cadence-summary + phase-config + tokens-summary into one round-trip, mirroring the dashboard summary pattern at `src/app/api/dashboard/summary/route.ts`. Failing that, explicit `Promise.all` in the page's loader with a hard cap on parallel reads. §12 should call this out as v1.5.6 follow-up if not v1.5.5.

---

## MEDIUM

### M-1 — `<MedicationDetailHeader>` is named in §11 but listed as "inline JSX block, no separate file needed" — file-naming convention drift risk

- **D-2 reference:** §11 component tree line 1: "`<MedicationDetailHeader>` NEW — inline JSX block, no separate file needed".
- **Live tree:** CLAUDE.md "File naming" — "Components and lib files: kebab-case … React component exports stay PascalCase regardless of filename. The 18 PascalCase outliers under `src/components/medications/` + `src/components/onboarding/` are pre-existing drift and worth cleaning up when the surrounding files come up for edit."
- **Why this is Medium:** naming it as a component while not extracting it sets up the next maintainer to extract it carelessly into `MedicationDetailHeader.tsx` (PascalCase outlier), instead of `medication-detail-header.tsx` (the convention). The other §11 entries (`todays-dose-card.tsx`, `cadence-summary-row.tsx`, etc.) already use kebab-case correctly.
- **Action:** drop the "no separate file needed" hedge; either extract to `medication-detail-header.tsx` from day one (so the SettingsSection's symmetry pattern carries through) or remove the component name from §11 and just render the JSX block inline at the page level under a `data-slot="medication-detail-header"`.

### M-2 — `<MedicationCard>` ↔ `<MedicationDetailHeader>` duplication is real but the audit lens missed it

- **D-2 reference:** §11 lists `<MedicationDetailHeader>` without proposing reuse of `medication-card.tsx` or its sub-component `MedicationCardHeader.tsx`.
- **Live tree:** `src/components/medications/medication-card.tsx` renders the same `{name} · {dose} · status pill` shape on the list page; `MedicationCardHeader.tsx` already exists as the extracted header chrome. The detail-page header could absorb `MedicationCardHeader.tsx` directly as the title block, leaving only the status pill + edit affordance distinct.
- **Why this is Medium:** future drift between the list-card header and the detail-page header is the exact "edit one, forget the other" failure mode CLAUDE.md guards against ("`useAuth` uses `["auth", "me"]` but `queryKeys.auth()` returns `["auth"]`" was the precedent). Two surfaces, one component, one cache.
- **Action:** §11 should propose either (a) lifting `MedicationCardHeader.tsx` to drive both surfaces (preferred — it's already a stable extraction), or (b) explicitly noting why the detail-page header diverges (so future readers don't refactor blind).

### M-3 — Wizard ↔ detail-page mutation conflict surface for `notificationsEnabled`

- **D-2 reference:** §5 "Wizard owns: name, category, treatmentClass, dose, dosesPerUnit, oneShot, startsOn, endsOn, schedules[]. Detail page owns everything else: active, notificationsEnabled, …"
- **Live tree:** `MedicationWizardDialog.tsx` build-create-body path (`wizard-payload.ts` exports `buildCreateBody`) emits `notificationsEnabled` IF the wizard surfaces a step for it; the v1.5.4 wizard does not, but the payload carries it (`notificationsEnabled: initial.notificationsEnabled ?? true` at `wizard-payload.ts:858`). `updateMedicationSchema.notificationsEnabled` at `validations/medication.ts:258` is optional on the PUT. The detail page is the canonical surface for this toggle (§3.6).
- **Why this is Medium:** if the user toggles notifications on the detail page, then opens the wizard for an edit and saves, the wizard's payload could overwrite the just-saved notifications flag depending on which value the payload was hydrated with. The hydration at `MedicationWizardDialog.tsx:131` rides `hydrateWizardPayload(initial)` which captures `initial.notificationsEnabled` at sheet-open time — if the user toggled the flag after that point but before saving the wizard, the toggle is lost.
- **Action:** §5 should declare that the wizard NEVER mutates `notificationsEnabled` on PUT — the field must not enter the wizard's `buildCreateBody` payload. This is a small wizard-payload audit item, not a detail-page change, but it belongs in the spec because the detail page is the toggle's new home.

### M-4 — Detail-page tests not enumerated; cross-surface invalidation tests not pinned

- **D-2 reference:** the doc does not have a §13 "Test surface" section.
- **Why this is Medium:** the marathon's previous releases have pinned cross-surface invalidation as a non-negotiable (the `medicationDependentKeys` bundle, the dashboard / detail symmetry, the Coach disable cascade invariant test). Without an explicit test list, the implementer ships green CI that still leaves the cascade silently broken.
- **Action:** add §14 "Test surface" with at minimum:
  1. **Component:** `<MedicationDetailSection>` renders chrome for each of the seven sections with no console errors at default i18n locale (de + en).
  2. **Component:** `<TodaysDoseCard>` renders Genommen / Verschoben / Übersprungen buttons with 44 px floor, and disabled state on `cadence.next === null`.
  3. **Integration:** Pausieren on `/medications/[id]` invalidates the list-page card's status pill + the dashboard quick-add medication option list within one tick.
  4. **Integration:** Verlauf-purge on `/medications/[id]` evicts the intake history preview AND the `medicationCompliance(id)` AND `compliance-chart-inline` caches.
  5. **Integration:** Medikament-löschen on `/medications/[id]` lands `/medications` on a fresh `medications()` cache (no stale row).
  6. **Integration:** wizard edit landing on the page hydrates `summariseCadence` correctly for one-shot / daily / weekday / rolling / monthly / yearly modes.
  7. **Component:** intake-history preview's per-row edit / delete affordance respects `min-h-11` floor on mobile.

### M-5 — `<IntakeImportDialog>` lift-out is correctly noted as pre-work but the trigger surface ownership is ambiguous

- **D-2 reference:** §3.5 "The 'Importieren' CTA opens the existing `IntakeImportDialog` (currently orphaned at `src/app/medications/page.tsx:344`); the detail page lifts the dialog onto its own surface and wires the trigger." Plus §11 "Refactor pre-work: extract `IntakeImportDialog` from `src/app/medications/page.tsx` into `src/components/medications/intake-import-dialog.tsx` so the detail page imports cleanly."
- **Live tree:** the dialog still mounts on the list page (`src/app/medications/page.tsx:292`) referenced by `setImportMedId(...)` — but no current trigger calls that setter (post-v1.5.4 it's orphaned).
- **Why this is Medium:** D-2 implicitly assumes the list page DROPS its mount once the detail page picks it up. Without an explicit lift contract, two mounts may co-exist (memory + state-machine churn). The CSV import row in §3.7 + the intake-history preview header CTA in §3.5 both gesture at this dialog — only one should own the mount.
- **Action:** §11 / §3.5 should declare a single canonical mount of `<IntakeImportDialog>` on the detail page, with §3.7's CsvImportRow and §3.5's "Importieren" CTA both reaching the SAME `intakeImportOpen` state at the page level (lifted state, not duplicated). Remove the orphaned mount from `medications/page.tsx`.

### M-6 — Bulk-delete in §6.2 uses `Promise.allSettled` over per-event DELETE — no rate-limit or partial-failure UX

- **D-2 reference:** §6.2 "Backend: existing `DELETE /api/medications/[id]/intake/[eventId]` looped via `Promise.allSettled` — no new API route."
- **Live tree:** `src/app/api/medications/[id]/intake/[eventId]/route.ts` triggers `recomputeMedicationComplianceForEvent` per delete + `reconcileOneShotState`. Looped 50× in parallel from the client, that's 50 rollup recomputes against the same `(userId, medicationId, dayKey)` row — potential write-lock thrash on the rollup table.
- **Why this is Medium:** the v1.4.39 W-MED rollup pass was tuned for a single intake mutation; a bulk delete fan-out is a new shape. Also, `Promise.allSettled` silently swallows per-event failures — the UI shows "30 ausgewählt gelöscht" when only 27 succeeded.
- **Action:** §6.2 should commit to either (a) a small `POST /api/medications/[id]/intake/bulk-delete` accepting `eventIds[]` and recomputing rollups once per touched dayKey (mirror the import-route pattern at `intake/import/route.ts:93-95`), or (b) hard-cap client-side parallelism (e.g. `Promise.all` over chunks of 5), surface per-event failures in a sonner toast, and prove the rollup table doesn't deadlock under contention. Option (a) is cleaner.

---

## LOW

### L-1 — `medicationDetail(id)` is the most-invalidated key but not in the central `medicationDependentKeys` bundle

- **D-2 reference:** §3.1 + §3.3 share `queryKeys.medicationDetail(id)`; every destructive tier (§3.8) and every settings sub-row (§3.7) needs to invalidate it; the wizard's onSuccess also needs it.
- **Live tree:** `medicationDependentKeys` at `src/lib/query-keys.ts:357-364` does include `queryKeys.medications()` whose prefix `["medications"]` covers `["medications", id]` via TanStack's hierarchical-prefix match. So invalidating the bundle DOES evict `medicationDetail(id)`. No bug — just non-obvious.
- **Action:** add a comment to `medicationDependentKeys` noting that `medications()` is the prefix that catches every `medicationDetail(id)` / `medicationCompliance(id)` / `medicationCadence(id)` / `medicationTitration(id)` / `medicationGlp1Details(id)` / `medicationIntakeList(...)` / `medicationIntakeDrugLevelChart(id)` consumer. Two minutes of clarity that defends the bundle's purpose for the next reader.

### L-2 — `<NotificationsSection>` reads `queryKeys.notificationsStatus()` but the section is per-medication

- **D-2 reference:** §3.6 helper line reads from `queryKeys.notificationsStatus()`.
- **Live tree:** `notificationsStatus()` at `query-keys.ts:139` is the global push-channel status (which channels are connected at all). It's the right key for the helper line (APNs · Telegram · Web-Push chip strip).
- **Why this is Low:** the per-medication switch state lives on `medicationDetail(id).notificationsEnabled` and rides the PUT; the global status read is a separate concern. D-2 is correct, but the implementer might confuse the two — the section name and the cache key both say "notifications" but mean different things.
- **Action:** §3.6 should explicitly call out the dual-source read: `medicationDetail(id).notificationsEnabled` drives the Switch state, `notificationsStatus()` drives the helper-line chip strip. They share no cache slot and invalidate independently.

### L-3 — Status-bar morph spec uses `data-slot="progress-indicator"` — confirm shadcn primitive exposes that selector

- **D-2 reference:** §2.6 + §9 CSS targets `[data-slot="progress-indicator"]` on the `<Progress>` indicator slot.
- **Live tree:** shadcn-ui's `progress.tsx` ships `data-slot="progress-indicator"` in v0.9+; HealthLog's `src/components/ui/progress.tsx` would need a quick grep to confirm.
- **Why this is Low:** if the slot attribute isn't present, the CSS silently no-ops and the morph never runs. Worth pinning a unit test that asserts the slot is on the rendered Progress.
- **Action:** §14 (new) test list should include "Progress slot attribute exists" assertion; or §2.6 should grep-verify the slot in the existing primitive before locking the spec.

### L-4 — `setActiveDialogOpen(true)` mount pattern conflicts with the §5 "second copy" claim

- **D-2 reference:** §5 "The list page keeps its own wizard mount for create + per-card edit; the detail page mounts a second copy with its own state."
- **Live tree:** `MedicationWizardDialog` keys its inner state container on `${props.open ? "open" : "closed"}:${props.mode}:${props.initial?.id ?? "new"}` (line 114). Two mounts with different open-states share the same `medications()` cache and the same query client — fine — but they DO race on the `onSuccess` callback's invalidation if both happen to be open at once (unlikely but not impossible if the user clicks Bearbeiten on a card while the detail-page sheet is also open from a back-nav).
- **Why this is Low:** edge case; the only consequence is a double-invalidation, which the bundle handles idempotently.
- **Action:** §5 should add a one-line note that the two mounts share `queryKeys.medicationDetail(id)` — invalidations are idempotent so a race is harmless.

### L-5 — iOS native-detail-screen forward-compat is acknowledged but not constrained

- **D-2 reference:** §12 "Native iOS mirror — the contract under `docs/api/openapi.yaml` is locked; iOS picks up the new endpoints (none — every wired API in this doc already ships) when its own release cuts."
- **Live tree:** every API surface in D-2 already exists; no new endpoint is implied. ✓
- **Why this is Low:** the v1.5.5 detail-page work doesn't strain the iOS contract, but the iOS client today opens detail screens with a strict subset of the web surface. The audit lens just confirms that's still true (D-2 doesn't smuggle in a new field on the wire).
- **Action:** none. D-2 §12 is correct as written. Listed for completeness.

---

## What D-2 got right

- Section ordering (§3 1-8) is the right clinical-document rhythm; matches Apple Health's daily / configuration / destructive split.
- Tier 1 (Pausieren) as a Switch with no confirmation, Tier 2/3 as single-step `<AlertDialog>` matches the `settings/advanced-section.tsx:287-317` precedent.
- Status-bar morph CSS is a clean v1.5.5-fit — CSS-only, no new dep, respects `prefers-reduced-motion`.
- Wizard ↔ detail-page boundary (§5) is the right cut: wizard owns the plan, detail page owns the state + the destructive edge.
- Restored-feature placement table (§4) accounts for every I-1 row.
- Out-of-scope (§12) is explicit and correctly leaves the v1.5.x read-flip + multi-schedule compose-mode for follow-up.
- No new Prisma migration: confirmed against `prisma/schema.prisma` — every field D-2 touches already exists.

---

## Summary of pre-implementation work

Before code lands, D-2 needs:

1. §3.7 + §7 + §11 + §13 rewritten around Marc's locked `<Sheet>` phase editor (C-1).
2. `pausedAt` field removed from §3.8 Tier 1 PUT body — server derives it (C-2).
3. `assertMedicationOwnership` rolled into the purge route AND the parent PUT/DELETE route as pre-work (C-3).
4. §3.8 invalidation table mirroring §3.7 (H-1).
5. §3.5 / §6.3 explicit `medicationDependentKeys` invalidation (H-2).
6. `compliance-chart-inline` folded into `medicationDependentKeys` OR mirrored in detail-page mutations (H-3).
7. Read-flip caveat surfaced per row (H-4).
8. Aggregate `/api/medications/[id]/detail` evaluated; deferred to v1.5.6 acceptable but document the decision (H-5).
9. §11 file-name convention + `MedicationCardHeader` reuse note (M-1, M-2).
10. Wizard payload's `notificationsEnabled` write surface (M-3).
11. §14 Test surface block added (M-4).
12. `<IntakeImportDialog>` single-mount contract (M-5).
13. Bulk-delete strategy choice — endpoint vs chunked parallel (M-6).

Lows are polish; address inline with the rest.
