# F-1 — Senior-dev audit, v1.5.5 pre-tag

Scope: `git log --oneline bf6dfb8f..HEAD` (15 commits, v1.5.4 → HEAD). Goal-backward read against D-3-final-direction. Each finding pinned to file:line and to a commit SHA when the issue is recent.

Severity buckets and counts:

- Critical: 4
- High: 6
- Medium: 8
- Low: 7

---

## Critical

### C-1 — `<SettingsSection>` Grace-row save is dead on arrival

`src/components/medications/sections/settings-section.tsx:65-89` (commit `4ae8801c`).

The Grace row PUTs `{ reminderGraceMinutes: graceValue }` against `/api/medications/[id]`. The schema accepts `reminderGraceMinutes` only as a **per-schedule** field (`src/lib/validations/medication.ts:113`); the top-level `updateMedicationSchema` does not carry it (`:250-261`). The PUT returns 422; the toast surfaces `medications.detail.settings.grace.failed` and the user can never change the grace window from the detail page. The inline comment ("v1.5.4 flat-form bridge") describes a bridge that does not exist.

Fix: either extend `updateMedicationSchema` with a top-level `reminderGraceMinutes` that the route maps onto the primary schedule, or have the row emit a `schedules: [{ id, reminderGraceMinutes }]` array. D-3 §9.7 / H-4-UX picked the primary-schedule narrowing, so the route deserves the explicit shim.

### C-2 — `<IntakeHistoryPreview>` ships none of the D-3 §9.5 row affordances or bulk-delete UI

`src/components/medications/sections/intake-history-preview.tsx:42-79` (commit `4ae8801c`).

D-3 §9.5 spec: per-row right-edge `<DropdownMenu>` kebab with `Bearbeiten + Löschen`, group `<h3>` headers (`Heute / Diese Woche / Älter`), multi-select with bulk `<POST /intake/bulk-delete>` wire-up. The component renders `<IntakeHistoryListV2 medicationId={medicationId} pageSize={14} />` as-is — that list is explicitly read-only (`intake-history-list-v2.tsx:63` — "No edit-in-row, no delete buttons"). The bulk-delete endpoint exists (commit `8d5d039e`) but no client surface posts to it. The component's own header comment claims "multi-select + row kebab Bearbeiten / Löschen ride on top of the wrapped list" — the implementation does not match the comment. v1.5.4 displaced features 15 + 16 (Einnahmen bearbeiten / Einnahmen löschen) per §7 — neither is reachable on the new detail page.

Fix: either (a) extend `IntakeHistoryListV2` with the `onEditIntake / onDeleteIntake / selection` props promised in D-3 §9.5 and wire the bulk-delete POST on a selection toolbar, or (b) ship the row affordances in `<IntakeHistoryPreview>` over a fresh `last-14-grouped` reader and drop the `<IntakeHistoryListV2>` re-use.

### C-3 — Purge route does not invalidate the server-side per-user medication caches

`src/app/api/medications/[id]/intake/purge/route.ts:31-61` (touched in commit `af224964`).

`prisma.medicationComplianceRollup.deleteMany` runs, but the route never calls `invalidateUserMedications(user.id)`. The PUT / POST / DELETE / bulk-delete siblings all call it (e.g. `intake/bulk-delete/route.ts:145`, `[id]/route.ts:263`, `[id]/route.ts:320`). After a Tier-3a "Verlauf löschen" the in-memory caches `caches.medications` / `caches.medicationsIntake` / `caches.analytics` keep the pre-purge counts for up to their TTL. `/api/dashboard/summary` (analytics cache) and the iOS today-tally read can paint the wrong compliance for minutes after the user confirms the destructive cascade. The detail-page TanStack invalidation hides this for the source tab, not for any other client tab or any iOS poll cycle.

Fix: add `invalidateUserMedications(user.id)` to the purge route's success path alongside the rollup delete.

### C-4 — `glp1` GET still hand-rolls the ownership check

`src/app/api/medications/[id]/glp1/route.ts:44-61` (untouched by `af224964`).

Commit `af224964` "route every detail-page sub-route through assertMedicationOwnership" did NOT touch the glp1 GET branch. The handler still reads the medication via `findUnique` then runs `medication.userId !== user.id ? 404`. C-E3-3 / D-3 §10 invariant 24 ("`assertMedicationOwnership` is the single ownership predicate across `src/app/api/medications/[id]/**`") is unmet. The same file's POST branch (line 127) and the other sub-routes converged; only the GET stayed on the old shape. The functional behaviour is identical, but the contract D-3 explicitly enumerated is broken and the next refactor that changes the 404 leak shape (e.g. `not-owned` vs `not-found` diagnostic) will silently miss this branch.

Fix: lift the glp1 GET to `assertMedicationOwnership(id, user.id)` like every sibling and drop the hand-rolled compare.

---

## High

### H-1 — Duplicate DOM id in `<NotificationsSection>`

`src/components/medications/sections/notifications-section.tsx:60` + `:134` + `:158` (commit `4ae8801c`).

`TITLE_ID = "medication-detail-notifications-title"` is rendered twice in the same subtree: once on `<MedicationDetailSection titleId={TITLE_ID}>` (the section `<h2>`), once on the inner `<span id={TITLE_ID}>` wrapping the switch row label. axe will flag `duplicate-id`. The Switch's `aria-labelledby` will resolve to the first occurrence in tree order (the section heading), not the row title — the helper ID is also picked up by `aria-describedby` regardless, so the announced name is "Benachrichtigungen, Benachrichtigungen aktivieren, helper". Fix: split the constants — one id for the section heading, one for the row title.

### H-2 — Bare-array `queryKey` bypass in `<ApiTokensRow>`

`src/components/medications/sections/api-tokens-row.tsx:54-57` (commit `4ae8801c`).

`const queryKey = useMemo(() => ["medications", medicationId, "api-endpoint"] as const, …)`. CLAUDE.md "TanStack Query keys live in the centralised factory" + §10 invariant 15 + ESLint `healthlog/queryKey-factory` rule. The literal escapes the rule because it's wrapped in `useMemo` rather than appearing as a direct `queryKey: [...]` object property — but the spirit (one source of truth in `query-keys.ts`) is violated. Fix: add `medicationApiEndpoint(medicationId)` to `src/lib/query-keys.ts:73-90` next to the other per-medication keys and import it here.

### H-3 — `phase-config` PUT returns 400, not 422-multi-issue

`src/app/api/medications/[id]/phase-config/route.ts:60-63`.

The PUT/DELETE handlers call `apiError("Invalid input", 400)` on a Zod failure (line 62) rather than `returnAllZodIssues(parsed.error, 422)`. CLAUDE.md "Every body-accepting route runs Zod `safeParse` and returns 422 via `returnAllZodIssues`". The phase-config PUT is a v1.5.5 first-class surface (D-3 §9.7) and should match the bundle's convention so iOS gets per-field error feedback instead of a flat "Invalid input".

Fix: replace `apiError("Invalid input", 400)` with `returnAllZodIssues(parsed.error, 422)`; matching the v1.5.5 bulk-delete sibling on the same surface.

### H-4 — `phase-config` upsert spreads `parsed.data` whole

`src/app/api/medications/[id]/phase-config/route.ts:65-72`.

The upsert's `create` and `update` branches spread `...parsed.data` into the Prisma payload. CLAUDE.md "No mass assignment. Every `prisma.X.{create,update}({ data: ... })` builds its `data` object field-by-field". The schema currently lists eight fields so the security blast radius is small, but the invariant is structural and a future schema extension (adding say `notifyOnPhaseChange`) would silently land on the Prisma write.

Fix: build the payload field-by-field from `parsed.data.greenValue / .greenMode / .yellowValue / …`.

### H-5 — `safeFetch` migration missed three constant-host call sites

`src/lib/withings/client.ts:112`, `:155`, `:272`, `:349`, `:400`; `src/lib/withings/sync-activity.ts:151`; `src/lib/withings/sync-sleep.ts:121`; `src/lib/ai/codex-oauth.ts:176`, `:217`, `:243`, `:279`; `src/app/api/bugreport/route.ts:162` (commit `425503e0`).

`safe-fetch.ts:91-95` documents "the four hard-coded hosts also route through it for convention consistency" — Anthropic / OpenAI / Apple / Telegram. In practice Withings, Codex, and the GitHub bug-reporter still bypass `safeFetch`. Constant hosts dodge the DNS-rebinding hardening risk so the security claim holds, but each missing site is a worker that a tar-pit upstream can pin for as long as the underlying socket waits (no `AbortSignal.timeout` on any of them). Withings + Codex are routinely-hit. Recommend extending `safeFetch` migration to these in a follow-up patch with the same convention (`timeoutMs` opt-in, no `requirePublicHost`).

### H-6 — Bulk-delete endpoint has no rate limit

`src/app/api/medications/[id]/intake/bulk-delete/route.ts:49-149` (commit `8d5d039e`).

The route caps `eventIds` at 500 per call, but a caller can fire repeated requests with disjoint `eventIds` sets and force `recomputeMedicationComplianceForDay` to spin per affected `dayKey`. The recompute is best-effort but it still hits Postgres. Single-user-scoped abuse only (the route is owner-scoped) so the blast radius is the user's own pool. Recommend a `checkRateLimit("medication-intake-bulk-delete:<userId>", 30, 60_000)` matching the `glp1` POST cap pattern (`glp1/route.ts:36-37`).

---

## Medium

### M-1 — `<MedicationCard>` "History" icon glyph stays after the route change

`src/components/medications/medication-card.tsx:265-280` (commit `8c740fd1`).

The icon button now routes to `/medications/{id}` instead of `/medications/{id}/history`, and the `aria-label` updates to `medications.openDetailPage`. The visual glyph is still `<History />` (clock-arrow). A user expecting "go to history" gets a route the icon does not advertise; a screen reader hears the new label correctly but the sighted user runs into a glyph-label mismatch. Pick a neutral glyph — `ChevronRight`, `ExternalLink`, or `Maximize2` — to match the new destination.

### M-2 — `<MedicationDetailPage>` re-hydrates the wizard payload on every render

`src/app/medications/[id]/page.tsx:319-323` + `:386` (commit `4ae8801c`).

`snapshotToWizardPayload(medication)` runs inline at both the `<CadenceSummaryRow medication=...>` mount and the `<MedicationWizardDialog initial=...>` mount; both run on every render. The function does Date construction + `parseScheduleRecurrence` walk per schedule. The wizard's `stateKey` (`MedicationWizardDialog.tsx:123`) re-keys the inner shell on intent change which already re-instantiates the payload, so the inline computation is redundant. Memoise via `useMemo(() => snapshotToWizardPayload(medication), [medication])` so the per-render hot path stays cheap.

### M-3 — `<IntakeHistoryPreview>` mounts `<IntakeImportDialog>` permanently

`src/components/medications/sections/intake-history-preview.tsx:74-77` (commit `4ae8801c`).

The dialog mount is unconditional: `<IntakeImportDialog medicationId={importOpen ? medicationId : null} onClose={...}/>`. The `medicationId` null-guard inside the dialog gates its render, but the dialog component still mounts on first paint and pulls its own deps (Dropzone, React-Hook-Form). D-3 §10 invariant 19 + L-7 say "skeleton choreography" — the dialog should mount lazily. Either gate the JSX with `{importOpen && <IntakeImportDialog … />}` or hoist behind a `next/dynamic` boundary.

### M-4 — `<ApiTokensRow>` minted token persists in component state for 30 s

`src/components/medications/sections/api-tokens-row.tsx:131-135`.

After mint the token sits in `useState` and renders in plain text under the auto-copy chip. 30 s auto-clear via setTimeout is appropriate, but the underlying value sticks in the React tree until either the timer fires or the user navigates. Recommend clearing on `unmount` too (return cleanup in the effect already does this) AND on `onBlur` of the window so a multi-tab user copying then switching does not leave the value visible. Defence-in-depth, not a critical leak.

### M-5 — `<SettingsSection>` Phasen row hides instead of explaining when one bound is set but not both

`src/components/medications/sections/settings-section.tsx:62`.

`hasCourseWindow = Boolean(startsOn) && Boolean(endsOn)`. When only one of the two is set the row shows the muted `requiresCourseWindow` fallback. D-3 §9.7 spelled out the empty-state copy as "Phasen sind nur mit Kurs-Fenster verfügbar" — works for the "no window at all" branch but reads confusingly for a user who set `startsOn` only and expects to see what's missing. Tighten the helper to "Setze Start- UND Enddatum, damit die Phasen aktiv werden" or split the two states.

### M-6 — `<IntakeHistoryPreview>` import button label outside the section header

`src/components/medications/sections/intake-history-preview.tsx:47-58`.

`headerExtras` correctly carries the `[⤴ Importieren]` button per D-3 §9.5, but the `Upload` icon (`ArrowUp` glyph in Lucide naming) reads as "export" / "send" rather than "import". D-3 uses an `⤴` arrow which Lucide does not ship as a single glyph; the closest match is `Upload` (arrow into a tray) which has the right semantic. Keep `Upload`, but consider adding a `<span className="sr-only">{t("medications.detail.intake.importButton")}</span>` near the icon for clarity if a future tooltip rolls in.

### M-7 — `landingStepForEdit` does NOT short-circuit a multi-schedule "cadence" intent

`src/components/medications/wizard/wizard-payload.ts:903-913`.

`intent === "cadence"` lands the user at Step 5 regardless of whether the payload has > 1 schedule. The legacy fall-through (no intent) puts a multi-schedule payload at Step 8 (summary), which is the muscle memory call-out documented in the function's own comment. A user tapping "Bearbeiten" on the cadence-summary row of a multi-schedule medication will land at Step 5 of the FIRST schedule — surprising if their target was schedule #2. D-3 §6 / §8 considered this single-schedule by default; the docstring covers the call shape but a multi-schedule cadence edit on the detail page (currently rare but reachable) drops the user on the wrong schedule. Recommend: if `payload.schedules.length > 1 && intent === "cadence"` → land at 8 with a note, or add a `scheduleIndex` arg.

### M-8 — Insights layout is not in the generated OpenAPI

`docs/api/openapi.yaml` (no `insights/layout` path).

`/api/insights/layout` GET/PUT/DELETE shipped (commit `a75b96b2`) but no `.meta()` registration exists in `src/lib/openapi/routes.ts` (grep shows only `/api/user/avatar` + `/api/user/avatar/{id}` for v1.5.5 additions). iOS clients have to discover the shape by trial. Mirroring `/api/dashboard/widgets` (which is in the registry) would close the gap.

---

## Low

### L-1 — `<DestructiveZoneSection>` re-renders Card B border with `border-destructive/40` regardless of count

`src/components/medications/sections/destructive-zone-section.tsx:250-253`.

The destructive border stays visually destructive even when `intakeCount === 0` makes the Tier-3a button non-actionable. Minor visual confusion — the card looks ready to hurt the user but its primary action is disabled. Consider keeping the border but muting it when `intakeCount === 0 && deleteDialogOpen === false`.

### L-2 — `intake/route.ts:208` reconciles oneShot state after the audit row already landed

`src/app/api/medications/[id]/intake/route.ts:208`.

The oneShot reconciliation runs AFTER `auditLog("medication.intake")` writes its row. A reconciliation flip is `noop` or `deactivated`; the audit row reads `medication.intake` only, with no `lifecycle: "auto-deactivated"` breadcrumb. The detail page's one-shot variant gate (page.tsx:248) depends on `medication.oneShot === true` AND the now-flipped `active`. Add a second annotate / audit row on the flip so the operator can trace why the medication transitioned (closes a long-standing v1.5 observability gap).

### L-3 — `<TodaysDoseCard>` overwrites local error state on a second submit attempt

`src/components/medications/todays-dose-card.tsx:101-135`.

A failed submit ("error"), then a second click sets state back to "submitting", but the toast is not re-emitted on error — the user sees the inline `<p>` flicker into "submitting" then back to "error" with no toast. Add an explicit `toast.error(message)` on the error branch so the error is announced through the polite live region.

### L-4 — `<NotificationsSection>` Switch + chip strip dual mount on every paint

`src/components/medications/sections/notifications-section.tsx:139-181`.

The clientManaged branch renders ONLY a chip; the regular branch renders the Switch + chip strip. The branch resolves correctly, but the chip strip (line 183) sits at the same tree level for both branches and re-mounts on a flip. Wrap the chip strip in the same `clientManaged ? … : …` ternary to avoid the remount.

### L-5 — `phase-config` GET response shape inconsistent (returns either the saved row or a default literal)

`src/app/api/medications/[id]/phase-config/route.ts:33-44`.

When no row exists, the route returns a literal `{ greenValue: 60, … }` with NO `medicationId`, `createdAt`, `updatedAt`. When a row exists, the route returns the full row. Clients that destructure `config.medicationId` get `undefined` on a fresh medication. Either always normalise the response to the same shape, or mark the absence with `{ defaults: true, … }` so the client can tell the two apart.

### L-6 — `<MedicationDetailPage>` does not handle the iOS-coord `clientManaged` toggle on the today's-dose card

`src/app/medications/[id]/page.tsx:292-301`.

The page passes `active: medication.active` to `<TodaysDoseCard>` but does not surface the `notificationPrefs.medication.clientManaged` state — which `<NotificationsSection>` reads — to the dose card. A user with the iOS-managed-reminders opt-in still sees the "Heute keine Einnahme geplant" web copy when in fact the iOS reminder is what they care about. Minor — the dose card is action-first, not status-first — but flagging for a v1.5.6 polish pass.

### L-7 — `bulk-delete` audit row carries `requestedCount` AND `deletedCount` but no `eventIds` breadcrumb

`src/app/api/medications/[id]/intake/bulk-delete/route.ts:126-134`.

The audit row captures the count but not the ids. A user disputing "why did my row vanish" cannot resolve which 14 events were deleted. Trade-off: storing 500 ids per audit row inflates the ledger. Recommend the truncated first-N ids + a hash of the full set, or skip ids entirely and rely on Postgres WAL.

---

## Cross-cutting positive findings (no action needed)

- Migrations 0083 → 0086 are additive-only, no order coupling (each `ALTER TYPE ADD VALUE IF NOT EXISTS` or nullable `ADD COLUMN`).
- `safeFetch` defaults (`redirect: "manual"`, `AbortSignal.timeout(15_000)`) match issue #218; the `requirePublicHost`-gated undici dispatcher (`safe-fetch-dispatcher.ts`) closes #217 cleanly.
- `assertMedicationOwnership` lifted on purge / intake / import / parent PUT / parent DELETE / bulk-delete / phase-config / api-endpoint / titration / cadence — only the `glp1` GET (C-4 above) and the inventory + side-effects + compliance siblings (pre-existing scope, not touched in v1.5.5) deviate.
- `medicationDependentKeys` carries `["compliance-chart-inline"]` (`query-keys.ts:377`) per §10 invariant 20; every detail-mutation routes through the bundle.
- Locale parity confirmed across en/de/es/fr/it/pl for `medications.detail.*` (77 keys, 0 missing in any locale); umlauts intact in de.json.
- Avatar size guards fire on `content-length` first (route.ts:85-95), then on `file.size` (line 112), then magic-byte sniff, then dimension check — no DoS via large-file-small-declared-size claim.
- Avatar GET is owner-scoped (`/api/user/avatar/[id]/route.ts:41-46`); admin-elevation explicitly declined.
- Insights layout PUT is owner-scoped (`route.ts:84-153`) and busts its server-side cache via `invalidateUserInsightsLayout`.
- Status-pill text always renders; dot uses Dracula tokens (`medication-detail-header.tsx:73-78`); `--success` / `--warning` defined in globals.css.
- Wizard `buildCreateBody` skips `notificationsEnabled` on edit per §10 invariant 16.
- C-E1-1 grep clean: zero `wizard-progress-bar` / `wizard-step-body` / `wizard-step-in` keyframe hits in `globals.css`.

---

## Recommended pre-tag actions

Block release on:

- C-1 (Grace row dead-write — user-visible regression on a restored feature).
- C-2 (intake-history preview missing kebab + bulk-delete UI — D-3 §9.5 unmet, the v1.5.4 displaced features 15 + 16 still unreachable).

Ship-then-patch on:

- C-3 (stale dashboard summary post-purge — one-tick visual lag, not a security issue).
- C-4 (`glp1` GET ownership invariant — same behaviour, contract drift).

The High bucket is appropriate for a v1.5.5.1 hotfix bundle; the Mediums + Lows fit a v1.5.6 polish wave.
