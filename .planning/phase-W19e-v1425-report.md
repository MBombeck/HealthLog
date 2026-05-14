# Phase W19e — Cadence visualisation + compliance chips on the GLP-1 detail page

**Branch:** `develop`
**Release:** v1.4.25
**Sub-wave:** Wave 4b (2 of 3 — W19d → W19e → W19f, all touching the
medication detail page)

## Commits

| SHA | Subject |
|---|---|
| `4af09170` | feat(medications): pure cadence + compliance helpers for GLP-1 detail |
| `3ef49679` | feat(medications): cadence + compliance read endpoint |
| `71cc05ac` | feat(medications): GLP-1 cadence visualisation + compliance chips on detail page |
| _this_     | docs(planning): W19e cadence + compliance phase report |

## Scope shipped

1. **Pure scheduling helpers** (`src/lib/medications/scheduling/`).
   - `cadence.ts` — `expandScheduleSlots`, `pairDoses`,
     `buildCadenceTimeline`, `computeNextDose`, `missedDoses`.
     Handles daily / weekday-restricted / `intervalWeeks ≥ 2` /
     overnight-window schedules, anchored to a stable reference date so
     a 30-day vs 90-day view always lands on the same bi-weekly grid.
   - `compliance.ts` — `complianceChips` aggregator returning
     `{ adherenceRate, currentStreak, longestStreak, missedLast30,
       windowDays }`. Skipped doses are excluded from the adherence
     denominator (user-deliberate, not a compliance failure). Streak
     rules: consecutive days where every expected slot is taken or
     skipped; days with no expected slot advance the streak.
   - Zero DB access; all functions take pre-fetched rows. Same shape
     as the W19d side-effect taxonomy module.

2. **API** — `GET /api/medications/[id]/cadence?days={1..180}` returns
   the rolling-window timeline + chips + next-dose pointer. Anchored
   to `medication.createdAt` so the chart and the chips agree on the
   bi-weekly grid regardless of window-size choice. `requireAuth` +
   ownership guard + `annotate()` instrumentation; no writes, so no
   audit-log row.

3. **SchedulingSection component**
   (`src/components/medications/SchedulingSection.tsx`) — mounts
   between `<SideEffectsSection>` (W19d) and `<IntakeHistoryList>`.
   Same chrome (`border-border/60 rounded` + `text-foreground/85 text-sm
   font-medium`) so the three Wave-4b panels feel like one visual
   group. Three sub-sections:
   - Header strip — reminder ON/OFF badge driven by
     `Medication.notificationsEnabled` (the toggle the existing
     reminder-check worker already reads) + a "Edit" button that
     deep-links to `/medications` where the canonical `medication-form`
     remains the single source of truth for schedule edits.
   - Cadence visualisation — 30-day track of one cell per expected
     dose, status-coloured (`taken` / `skipped` / `missed` / `upcoming`)
     plus a legend. Pure CSS-grid, no Recharts — visually consistent
     with the design system without spinning up a heavyweight chart.
   - Compliance chips — four monochrome chips (adherence rate %,
     current streak in days, longest streak in days, missed in the
     last 30 days). Tooltips explain each chip; no gamified badges
     per Marc-memory directive.

4. **Mount** — `src/app/medications/[id]/history/page.tsx`.
   Same `medication?.treatmentClass === "GLP1"` gate, identical
   conditional pattern as the W19d block.

5. **i18n** — six locales (DE / EN / FR / ES / IT / PL) under
   `medications.scheduling.*`. DE + EN hand-curated Marc-Voice;
   FR / ES / IT / PL drafted from EN.

## Tests

- `src/lib/medications/scheduling/__tests__/cadence.test.ts` — 18
  cases (slot expansion, day-of-week filtering, `intervalWeeks=2`
  every-other-week phasing, overnight windows, pair-claim ordering,
  past/future status, no-double-match guarantee, `computeNextDose`,
  `missedDoses` parity with timeline).
- `src/lib/medications/scheduling/__tests__/compliance.test.ts` —
  8 cases (null adherence on no-doses, 100% all-taken, 0% no-events,
  skipped-exclusion from denominator, streak across consecutive days,
  streak-break on missed day, weekly cadence does not penalise off-days,
  weekly missed Monday counts).
- `src/app/api/medications/[id]/cadence/__tests__/route.test.ts` —
  6 cases (401 / 404 / 422 / happy path / default 30-day window /
  null next-dose on empty schedule list).
- `src/components/medications/__tests__/SchedulingSection.test.tsx` —
  7 cases (heading EN + DE render, reminder on/off badge switch,
  four chip values render, `No data` adherence rendering, empty-state
  copy, four-status legend).

**Total new tests: 39, all passing.** The wider medication test suite
(274 cases across 20 files) was re-run to verify no regression.

## Gates

- `pnpm typecheck` — clean.
- `pnpm lint` over the touched surface — clean.
- `pnpm test --run <touched-surface>` — 39 / 39 pass; 274 / 274 across
  the medication surface.

## Deviations

1. **No new schema migration.** The brief reserved migration `0060`
   for a `medication_schedule` table with `cadenceDays` /
   `anchorTime` / `reminderEnabled` / `reminderLeadMinutes`. After
   reading the existing schema and worker code:
   - `MedicationSchedule` already carries `windowStart`, `windowEnd`,
     and `daysOfWeek` (encoded by `serializeScheduleRecurrence` so the
     `intervalWeeks` 1–4 multi-week cadence is already supported).
   - `Medication.notificationsEnabled` already drives reminder
     dispatch.
   - `ReminderPhaseConfig` already carries lead-time-equivalent
     thresholds (GREEN / YELLOW / ORANGE / RED in minutes).
   - The pg-boss queue `medication-reminder-check` already runs every
     15 minutes and dispatches `MEDICATION_REMINDER` via the existing
     notification dispatcher (Telegram / ntfy / Web Push / APNs).
   - The notification event-type enum already includes
     `MEDICATION_REMINDER` with default-ON opt-out behaviour.

   Adding a parallel `cadenceDays` / `anchorTime` / `reminderLeadMinutes`
   column would have introduced a second source of truth for the same
   information. Marc-correction in the W19e brief was explicit:
   *"Reuse pg-boss + notifications/dispatcher — no new infra."* I
   extended the principle to schema: no new columns where existing
   ones already model the same concept.

   **Net effect:** migration `0060` stays unassigned — W19f or any
   later wave can pick it up as the next-free slot.

2. **No new pg-boss queue.** Per (1), the existing
   `medication-reminder-check` queue already does everything the brief
   described, including phase-based deduplication (per-day-per-phase
   uniqueness via `TelegramReminderMessage`) which is functionally
   equivalent to the brief's "track last-notified per (userId,
   medicationId, dueAt)".

3. **No second schedule editor.** The brief described an in-section
   schedule-edit form. The existing `medication-form.tsx` is the
   canonical edit surface for the same data; cloning it on the detail
   page would create a maintenance burden every time the schema or
   the recurrence-string format changed. The W19e section instead
   surfaces an "Edit" button that deep-links to `/medications`, plus a
   read-only reminder badge tied to `notificationsEnabled`. If the
   user research surfaces friction on the round-trip, a future wave
   can lift the form into a modal here without changing the contract.

4. **CSS-grid timeline, no Recharts.** The visualisation is 30 small
   monochrome cells in a row plus a legend. Recharts is overkill for
   a binary-status track and the simpler render keeps the SSR cost
   low; the section is mounted on a page that already loads Recharts
   (`DrugLevelChart`) so reusing it would not have been a hard no, but
   the chart isn't doing anything chart-like.

5. **Anchor = `medication.createdAt`.** For `intervalWeeks ≥ 2`
   schedules the bi-weekly grid needs a stable phase reference. The
   helper takes an explicit `anchor` parameter; the API route passes
   `medication.createdAt`. This means a user who switches from
   weekly to bi-weekly retains the same Monday parity going forward
   (which matches the existing `medication-form.tsx` UI assumption).

## Handoff to W19f — medication detail page layout map

`src/app/medications/[id]/history/page.tsx` after W19e:

```
+--------------------------------------------------+
| Back to medications                              |
+--------------------------------------------------+
| "Intake history"      [ + Add intake CTA ]       |
| <medication name> · <dose>                       |
+--------------------------------------------------+
| <DrugLevelChart>       (W19c — already mounted) |
+--------------------------------------------------+
| <SideEffectsSection>   (W19d — mounted)         |
+--------------------------------------------------+
| <SchedulingSection>    (W19e — just mounted)    |
+--------------------------------------------------+
|  ⌥  Titration ladder                              |
|     ← W19f mounts HERE (between W19e and the     |
|        intake list, or below it if the combined  |
|        section stack is too tall on mobile)      |
+--------------------------------------------------+
| <IntakeHistoryList>    (existing)                |
+--------------------------------------------------+
```

**For W19f:** insert the titration-ladder section immediately *after*
`<SchedulingSection>` and *before* `<IntakeHistoryList>`. Reuse the
same `border-border/60 rounded` chrome + `text-foreground/85 text-sm
font-medium` heading; the i18n root is `medications.titration` (or
whatever W19f chooses); add it after `medications.scheduling` in
every locale to keep JSON ordering stable.

Migration `0060` is unassigned and free for W19f if it needs schema
work (the W19a / W19c knowledge layer carries the EMA titration
ladder already, so W19f may not need a migration either — same
no-new-infra principle applies).

## Pen for the next agent

- The scheduling module exports `buildCadenceTimeline` +
  `complianceChips` as stable contracts. The Coach snapshot or future
  Health-Score adherence dimension can read these without re-deriving.
- `intervalWeeks` encoding lives in `src/lib/medication-schedule.ts`
  (`parseScheduleRecurrence` / `serializeScheduleRecurrence`); the
  scheduling helpers depend on it. Any change to the encoding format
  needs to update both modules.
- No destructive concerns. No PII landed in user-facing copy.
