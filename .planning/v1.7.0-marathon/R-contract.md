# R-contract — Medication server contract design, v1.7.0

Read-only research. No source edits made. Citations are `file:line` against the
tree at the time of writing (post-v1.6.0, branch `main`).

## 0. Critical context — read-flip current truth

The v1.5.1 read-flip and the v1.6.0 today-tile read-flip are **both landed**.
Verified:

- `projectTodayIntakesAndRecompute(...)` is the single shared today-window
  projector. It routes every "does this schedule emit today?" decision through
  the canonical engine via `scheduleEmitsInWindow` →
  `occurrencesBetween` — `src/lib/medications/scheduling/project-today-intakes.ts:77-122`
  (the v1.6.0 read-flip comment is at line 77).
- Both `/api/medications/intake?scope=today` and `/api/dashboard/summary`
  call it: `src/app/api/medications/intake/route.ts:124` and
  `src/app/api/dashboard/summary/route.ts:350`.
- The reminder worker already routes through the same engine via
  `scheduleEmitsInWindow` (`src/lib/medications/scheduling/worker-helpers.ts:108-115`,
  doc note `:90-107`).

So **today-projection + reminder minting are canonical-engine-correct** for
RRULE / rolling / one-shot / bi-weekly. The legacy walker `expandTodayIntakes`
(`src/lib/medication-schedule.ts:112`) is now **dead** for production reads —
only referenced in comments/tests. Worth a delete in this release (see item 11).

**The remaining divergence is COMPLIANCE.** `calculateCompliance`
(`src/lib/analytics/compliance.ts:203`) delegates to `buildCadenceTimeline`
(`src/lib/medications/scheduling/cadence.ts:331`), which expands slots via
`expandScheduleSlots`. That expander reads **only** `daysOfWeek` (decoded to
weekdays + `intervalWeeks`) — `cadence.ts:177,196-208`. It does **NOT** read
`rrule`, `rollingIntervalDays`, or `oneShot`. Since every v1.5+/v1.6 write
defaults a plain recurring schedule to `rrule = "FREQ=DAILY"` with
`daysOfWeek = null` (route invariant 2, `src/app/api/medications/route.ts:197-205`),
a modern RRULE-only schedule expands to **daily-every-day** in compliance
(because `daysOfWeek=null` → "every day" in `cadence.ts`), which is *accidentally
correct only for FREQ=DAILY*. For `FREQ=WEEKLY;BYDAY=MO`, a rolling injection, or
a one-shot, compliance is **wrong** (denominator counts every day). This is
exactly the SB-SCHED-2 bug, and it is the spine of this release.

---

## Priority + dependency ordering

```
TIER A (engine foundation — everything else builds on it)
  SB-SCHED-2  cadence-canonical compliance via the canonical engine   ← do first
  └─ SB-SCHED-5  PRN + cyclic schedule types (engine math)            ← extends the engine; land with/just after SB-SCHED-2

TIER B (additive contract fields — independent, parallelisable once A lands)
  SB-LA-1     liveActivityEnabled boolean
  SB-AK-1     criticalAlarmEnabled boolean
  SB-SCHED-3  server-computed nextDueAt                                ← needs canonical engine (A) for correctness
  #5          schedule-aware compliance payload (due/expectedCount)    ← needs A
  #3          delivery-pref default (roaming) + device override
  SB-SCHED-4  APNs suppression multi-weekday projection (mostly done)

TIER C (independent, ship anytime)
  #9          dashboard widgets PUT 422 — accept unknown ids
  item 11     delete dead expandTodayIntakes walker (optional hygiene)
```

Migrations needed: **3** (consolidatable to 2). See §Migrations.

**Riskiest item: SB-SCHED-2.** It changes the denominator of every compliance
number across 8 call sites + Health Score + Coach prompt + doctor report. A
regression silently mis-states adherence. Mitigate with golden-fixture parity
tests per cadence type and a feature-flagged rollout is NOT needed (no wire
break) but a broad test net is.

---

## Migrations

Parallel-agent collision rule (per memory
`feedback_marathon_migration_renumber_collision`): the next free number on `main`
is **0089** (`prisma/migrations` tops out at `0088_v160_delivery_form`). To avoid
N agents all grabbing 0089, **pre-allocate above 0090**:

- `0091_v170_med_reminder_flags` — `live_activity_enabled`, `critical_alarm_enabled`
  on `medications` (SB-LA-1 + SB-AK-1, one migration).
- `0092_v170_schedule_types` — `schedule_type` enum/text + `cyclic_on_weeks` +
  `cyclic_off_weeks` on `medication_schedules` (SB-SCHED-5).
- (No migration for #3 delivery-pref default — rides the existing
  `User.notificationPrefs` jsonb. No migration for nextDueAt — computed. No
  migration for #5 — computed. No migration for #9 — enum-on-read.)

If an agent must renumber on cherry-pick, the manual fallback worked last
marathon — but pre-allocation is the primary plan. Brief every agent with its
assigned number in the dispatch.

---

## Item 1 — SB-LA-1 `liveActivityEnabled`  (TIER B)

Per-medication boolean, default false. iOS Live Activity opt-in for a med.

**Schema diff** (`prisma/schema.prisma`, Medication model ~`:883`):
```prisma
/// v1.7.0 — iOS Live Activity opt-in for this medication's reminders.
/// Default false; existing rows backfill false. Server stores + echoes;
/// the iOS client owns the ActivityKit lifecycle.
liveActivityEnabled  Boolean @default(false) @map("live_activity_enabled")
```

**Migration** (`0091`): `ALTER TABLE "medications" ADD COLUMN
"live_activity_enabled" BOOLEAN NOT NULL DEFAULT false;` — backfill is the
DEFAULT, no data step.

**Zod diff** (`src/lib/validations/medication.ts`):
- `createMedicationSchema` (`:233`): add
  `liveActivityEnabled: z.boolean().optional().describe("iOS Live Activity opt-in for this medication's reminders. Default false.")`.
- `updateMedicationSchema` (`:266`): same, optional.

**Route diff** (no mass assignment — match the `deliveryForm` pattern exactly):
- `POST` `src/app/api/medications/route.ts`: destructure `liveActivityEnabled`
  at `:118-130`; spread `...(liveActivityEnabled !== undefined && { liveActivityEnabled })`
  alongside the `deliveryForm` spread at `:185-186`.
- `PUT` `src/app/api/medications/[id]/route.ts`: destructure at `:88-102`; spread
  in `baseUpdateData` alongside `deliveryForm` at `:184`.

**OpenAPI** (`src/lib/openapi/routes.ts`, `medicationResource` `:588`): add
`liveActivityEnabled: z.boolean().describe(...)` to the response shape. The
create/update request schemas are the live Zod objects (`:1154`, `:1210`) so
they pick the field up automatically. Re-run `pnpm openapi:generate`.

**Compliance/engine impact:** none. Pure passthrough field.

**Tests:** create-echoes-false-by-default; create-with-true; PUT-toggle;
OpenAPI drift check (`pnpm openapi:check`).

---

## Item 2 — SB-AK-1 `criticalAlarmEnabled`  (TIER B)

iOS 26 AlarmKit critical reminder opt-in. **Identical shape to SB-LA-1.** Land
both in the **same migration `0091`** and the same route destructure block.

**Schema:** `criticalAlarmEnabled Boolean @default(false) @map("critical_alarm_enabled")`.
**Migration `0091`:** second `ADD COLUMN ... DEFAULT false`.
**Zod / route / OpenAPI:** mirror item 1 field-for-field.

**Security note worth flagging:** critical alarms bypass the iOS mute switch /
Focus. The server is only storing a preference — fine. But document that the
flag does not itself authorise anything server-side; it is metadata the iOS
client reads. No server-side behaviour hangs off it in v1.7.0.

**Tests:** mirror item 1.

---

## Item 3 — Delivery-preference default (roaming) + device-local override  (TIER B)

**Goal:** make iOS "Dieses Gerät / Alle Geräte" scope real. Today the only
delivery-pref knob is `medication.clientManaged` (a user-level boolean on
`User.notificationPrefs`, `src/lib/validations/notification-prefs.ts:28-44`),
which roams across all devices. There is no per-device override.

**Design — minimal + additive, no migration:**

1. **User-level roaming default** stays where it is: extend the
   `notificationPrefs` jsonb `medication` sub-object with a delivery shape. The
   schema is explicitly built to grow additively (`notification-prefs.ts:40-44`
   doc + `mergeOverDefaults` `:119`).

   New shape:
   ```
   medication: {
     clientManaged: boolean,                 // existing
     deliveryDefault: "server" | "client"    // NEW — roaming user default
   }
   ```
   `clientManaged` and `deliveryDefault` are kept as **two fields** rather than
   collapsed: `clientManaged` is the established cron gate (do NOT repurpose it
   — the reminder worker reads it verbatim at `reminder-worker.ts:690`).
   `deliveryDefault` is the human-meaningful "Alle Geräte" choice; the resolver
   maps `deliveryDefault === "client"` → `clientManaged: true` for backward
   compat so the cron keeps reading one boolean. Document this mapping in
   `resolveNotificationPrefs`.

2. **Device-local override** lives on the existing `Device` row
   (`schema.prisma:1930`) — the device is already the per-device anchor, no new
   table:
   ```prisma
   /// v1.7.0 — per-device delivery override. NULL = inherit the user-level
   /// roaming default (User.notificationPrefs.medication.deliveryDefault).
   /// "server" forces server APNs for this device; "client" forces local.
   medicationDelivery String? @map("medication_delivery")
   ```
   This DOES need a column. To stay at 2 migrations, fold it into `0091`
   (rename to `0091_v170_med_flags_and_device_delivery`) — it is still a pure
   additive nullable column, no backfill.

**Resolution order (document in a new helper, e.g.
`resolveDeviceDelivery(user.notificationPrefs, device.medicationDelivery)`):**
`device.medicationDelivery ?? deliveryDefault(user) ?? "server"`. The reminder
worker is **user-scoped, not device-scoped** today (it suppresses per-user via
`clientManaged`). v1.7.0 keeps cron suppression user-level (the device override
is an iOS-display concern — which device shows the local banner — not a
server-fan-out concern, because APNs already fans out to all the user's devices
and iOS dedupes). So the **device override is stored + echoed but does not
change cron fan-out in v1.7.0**. Flag this scope boundary to the maintainer
(open question Q2).

**Zod diff** (`notification-prefs.ts`):
- `medicationPrefsSchema` (`:28`): add
  `deliveryDefault: z.enum(["server","client"]).optional()`.
- `NotificationPrefs` interface (`:53`) + `DEFAULT_NOTIFICATION_PREFS` (`:65`):
  add `deliveryDefault: "server"`.
- `mergeOverDefaults` / `resolveNotificationPrefs`: layer the new key.
- New `deviceDeliverySchema = z.enum(["server","client"]).nullable()` for the
  device PATCH.

**Route diff:**
- `PATCH /api/auth/me/notification-prefs` (`route.ts:58`): already deep-merges
  `parsed.data` over the row (`:100-108`) — picks up `deliveryDefault` for free
  once the schema allows it. No route logic change beyond the schema.
- `PATCH /api/auth/me/devices/[id]` (`src/app/api/auth/me/devices/[id]/route.ts`):
  add `medicationDelivery` to its update schema + field-by-field `data`. (Verify
  this route exists as a PATCH; if it is GET/DELETE-only today, add the field to
  `POST /api/devices` registration body + a small PATCH. Found at
  `src/app/api/auth/me/devices/[id]/route.ts`.)

**OpenAPI:** extend the `NotificationPrefs` component + the `Device` component
schemas. Re-generate.

**Compliance/engine impact:** none.

**Tests:** default resolves to `server`; PATCH user default → roams; PATCH
device override → wins over default; `clientManaged` ↔ `deliveryDefault`
mapping; null device override inherits.

---

## Item 4 — SB-SCHED-2 cadence-canonical compliance  (TIER A — do first)

**Root cause (confirmed):** `calculateCompliance` → `buildCadenceTimeline` →
`expandScheduleSlots` reads only `daysOfWeek`+`intervalWeeks`
(`cadence.ts:177,196-208`), ignoring `rrule`, `rollingIntervalDays`, `oneShot`.
The `ComplianceSchedule` input type doesn't even carry those fields
(`compliance.ts:153-157`).

**Design — route the expected-slot grid through the canonical engine
(`recurrence.ts`), not the cadence walker.** Two viable shapes:

- **Option A (preferred): teach `calculateCompliance` to call
  `occurrencesBetween`.** Change the input contract so the caller passes the
  full canonical-capable schedule rows + a `RecurrenceContext` (medication
  `startsOn/endsOn/oneShot/createdAt`, `timeZone`, `lastIntakeAt`). Expected
  slots = `occurrencesBetween(canonical, effectiveStart, now, ctx)` per
  schedule. Pair recorded events against those slots with the same ±12 h radius
  the cadence chart uses. This makes ONE engine authoritative for both
  projection and compliance — the stated v1.5 design goal.

- **Option B (smaller diff): make `expandScheduleSlots` delegate to
  `occurrencesBetween` internally** when `rrule`/`rollingIntervalDays`/`oneShot`
  are present, keep the legacy weekday path only when all three are null. Lower
  blast radius on the chip/timeline surfaces that also use `cadence.ts`.

**Recommend Option B** for v1.7.0: it fixes compliance AND the detail-page
cadence chart in one place, and `cadence.ts` is already the shared expander for
both. The signature of `buildCadenceTimeline` already accepts `anchor` +
`timeZone` (`cadence.ts:331-337`); extend `ScheduleLike` (`cadence.ts:33`) to
carry `rrule`, `rollingIntervalDays`, and the medication context needed by the
engine (`oneShot`, `startsOn`, `endsOn`, `createdAt`, `lastIntakeAt`).

**`ComplianceSchedule` diff** (`compliance.ts:153`): add
`rrule?: string | null; rollingIntervalDays?: number | null;` and thread a new
optional `medicationContext` param into `calculateCompliance` carrying
`{ startsOn, endsOn, oneShot, createdAt, lastIntakeAt, timeZone }`. When the new
fields are absent the function must behave exactly as today (legacy callers /
fixtures keep passing) — that backward-compat is the safety net.

**ALL 8 call sites** (per CLAUDE.md; enumerated from grep — there are 9 distinct
`calculateCompliance(` invocations across 8 surfaces):

| # | Surface | File:line | What it must pass now |
|---|---|---|---|
| 1 | Per-med compliance endpoint | `src/app/api/medications/[id]/compliance/route.ts:44,50` | already has `medication.schedules` (full rows) + `medication` ctx; add rrule/rolling + ctx |
| 2 | Insights targets | `src/app/api/insights/targets/route.ts:893,899` | ensure the `med.schedules` select includes `rrule`,`rollingIntervalDays`; pass med ctx + `lastIntakeAt` |
| 3 | Insights comprehensive | `src/app/api/insights/comprehensive/route.ts:296,297` | same select widening + ctx |
| 4 | Insights features (Health Score input) | `src/lib/insights/features.ts:925,926,927` | same; note `:892` comment says it deliberately fetches a narrow shape — widen it |
| 5 | BP-status gate | `src/lib/insights/blood-pressure-status.ts:309,315` | same |
| 6 | Medication-compliance status pillar | `src/lib/insights/medication-compliance-status.ts:187,193` | same |
| 7 | Health-Score fast-path | `src/lib/analytics/health-score-fast-path.ts:333,348` | same; it already pins `now` via options — keep that |
| 8 | (per-med endpoint daily map, same file as #1) | `compliance/route.ts:60-135` | the `dailyCompliance` loop also needs the per-day DUE computation — see item 5 |

Each call site needs: (a) widen the Prisma `select`/`include` on `schedules` to
include `rrule` + `rollingIntervalDays` (most already `include: { schedules: true }`
so they get it free — verify the narrow `select` ones at #2/#4), and (b) fetch
`lastIntakeAt` (latest non-skipped `takenAt`) for rolling correctness, and (c)
pass medication `startsOn/endsOn/oneShot/createdAt` + user `timeZone`.

For the rolling case, `lastIntakeAt` is already groupBy'd in some routes (e.g.
`medications/route.ts:40-44`); reuse that pattern rather than a new query per med.

**PRN exclusion:** PRN schedules (item 7) emit zero expected slots — handled by
the engine returning `[]`, so `denom=0` → `rate:100` (the existing empty-window
contract `compliance.ts:276-278`). No extra branch needed.

**OpenAPI:** no request-shape change (compliance route is GET). Response shape
gains `due`/`expectedCount` per item 5.

**Tests (this is the high-risk item — be exhaustive):**
- Parity: legacy `daysOfWeek`-only schedule produces identical numbers
  pre/post (the no-context path).
- `FREQ=WEEKLY;BYDAY=MO`: 30-day window, took every Monday → 100% (today it
  reports ~13%).
- `FREQ=WEEKLY;INTERVAL=2;BYDAY=WE` bi-weekly → denominator counts only the on-weeks.
- Rolling `rollingIntervalDays=7` → only the next-due slot counts; logging
  re-anchors.
- One-shot → exactly one expected slot on `startsOn`.
- PRN → `rate:100`, `totalExpected:0`.
- DST boundary day (Europe/Berlin spring-forward) parity.
- Each of the 8 call sites: integration test asserting the widened select +
  ctx threading produces a sane rate for an RRULE med.

---

## Item 5 — Schedule-aware compliance PAYLOAD (`due` / `expectedCount`)  (TIER B, needs A)

**Problem:** the per-med compliance endpoint's `dailyCompliance` map stamps
`expected: schedulesPerDay` on **every** day (`compliance/route.ts:126-134`),
so iOS history renders empty "missed" marks on non-due days (off-weeks,
non-matching weekdays, PRN days).

**Design — additive per-day field.** Extend `DailyComplianceEntry`
(`compliance.ts:57-65`) and the route's per-day object:
```ts
export interface DailyComplianceEntry {
  expected: number;        // existing — but now = engine's actual due count for THAT day
  expectedCount: number;   // NEW — explicit alias; the true due-slot count for the day
  due: boolean;            // NEW — expectedCount > 0
  taken: number;
  skipped: number;
  onTime: number;
  late: number;
  veryLate: number;
  early?: number;
}
```
Compute `expectedCount` by asking the engine how many occurrences land in
`[dayStart, dayEnd)` for the med's schedules (reuse the Option-B expander from
item 4 — `occurrencesBetween(canonical, dayStart, dayEnd, ctx).length` summed
across schedules). `due = expectedCount > 0`. iOS renders a mark only when
`due === true`.

Keep `expected` populated (now = `expectedCount`) so existing web consumers
that read `expected` don't break; `expectedCount`+`due` are the new explicit
fields iOS keys off. This is additive — no field removed → no wire break.

**Route diff:** `compliance/route.ts:62-135` — replace the static
`schedulesPerDay` (`:59`) with a per-day engine query. Performance: 90 days × N
schedules engine calls per medication-detail open; acceptable for a single-med
detail view, but memoise the canonical-schedule build outside the loop.

**OpenAPI:** add `due` + `expectedCount` to the daily-compliance component (the
compliance route response is currently loosely typed — add/extend a
`MedicationComplianceDaily` component). Re-generate.

**Tests:** off-week day → `due:false, expectedCount:0`; matching weekday →
`due:true, expectedCount:N`; PRN day → `due:false`; iOS-shape snapshot.

---

## Item 6 — SB-SCHED-3 server-computed `nextDueAt`  (TIER B, needs A)

**Goal:** stop iOS re-implementing the recurrence engine. Server computes the
next due instant per medication/schedule.

**Where computed:** `nextOccurrenceAfter(schedule, now, ctx)` already exists and
is correct for all cadences (`recurrence.ts:147`). Build a thin helper
`computeNextDueAt(medication, schedules, now)` that:
- builds `RecurrenceContext` (needs `lastIntakeAt` — one query per med),
- calls `nextOccurrenceAfter` per schedule,
- returns the **earliest** `at` across schedules (and per-schedule values).

**Where exposed:**
- `GET /api/medications` list (`medications/route.ts:74-79` map): add
  `nextDueAt: string | null` to each list row. `lastIntakeAt` is already
  groupBy'd at `:40-44` — reuse it to avoid N+1.
- `GET /api/medications/[id]` detail (`[id]/route.ts:55`): add `nextDueAt` +
  optionally per-schedule `nextDueAt` on each schedule object.
- The cadence endpoint already returns `next` (`MedicationCadenceResponse`
  `:712-730`) — keep it; `nextDueAt` is the lighter list-level field.

**Caching gotcha:** the list GET is cached 60 s on userId
(`medications/route.ts:91-96`). `nextDueAt` is time-derived; a 60 s staleness is
already accepted for `todayEventCount` and is fine here too. Document it.

**Schema/migration:** none — computed, not stored.

**Zod/OpenAPI:** add `nextDueAt: z.iso.datetime({offset:true}).nullable()` to
`medicationResource` (`:588`) and `medicationListEntry` (`:634`). Re-generate.

**Compliance/engine impact:** read-only reuse of `nextOccurrenceAfter`.

**Tests:** daily → tomorrow's window; weekly BYDAY → next matching weekday;
rolling with last intake → lastIntake+N; one-shot in the past → null; endsOn
crossed → null; multi-schedule → earliest wins.

---

## Item 7 — SB-SCHED-5 PRN/as-needed + cyclic (on/off weeks)  (TIER A, with SB-SCHED-2)

Both approved for v1.7.0.

**Schema** (`MedicationSchedule`, `schema.prisma:915`):
```prisma
/// v1.7.0 — schedule type discriminator. SCHEDULED is the default
/// (rrule / rolling / legacy cadence as today). PRN = as-needed: never
/// projected, never reminded, excluded from compliance expected-count,
/// still loggable. CYCLIC = N weeks on / M weeks off from the anchor.
scheduleType   String @default("SCHEDULED") @map("schedule_type")
/// v1.7.0 — cyclic on/off weeks. Only meaningful when scheduleType=CYCLIC.
/// Repeats (cyclicOnWeeks on, then cyclicOffWeeks off) from startsOn ??
/// createdAt. Within an "on" week the rrule/legacy cadence applies as usual.
cyclicOnWeeks  Int? @map("cyclic_on_weeks")
cyclicOffWeeks Int? @map("cyclic_off_weeks")
```
Store `scheduleType` as TEXT (matches the `medication_categories` /
`deliveryForm`-as-enum precedent; TEXT keeps headroom without a Prisma enum
migration — but `deliveryForm` IS a Prisma enum, so for consistency a Prisma
`MedicationScheduleType` enum is also acceptable. **Recommend Prisma enum** to
match `MedicationDeliveryForm` precedent and get DB-level validation).

**Migration `0092`:** add the enum type + 3 columns; backfill
`scheduleType='SCHEDULED'` (the DEFAULT covers it), `cyclic*` NULL.

**Engine math** (`recurrence.ts`):
- **PRN:** `occurrencesBetween` returns `[]` and `nextOccurrenceAfter` returns
  `null` when `scheduleType === "PRN"`. Add an early-return at the top of
  `occurrencesBetween` (`:116`). PRN is loggable (intake route untouched) but
  invisible to projection + reminders + compliance-expected.
- **CYCLIC:** wrap the existing dispatch. After computing a candidate
  occurrence, gate it by the cyclic phase: `weeksFromAnchor =
  floor((occurrenceWeekStart - anchorWeekStart)/WEEK_MS)`, `cycleLen =
  onWeeks+offWeeks`, `phase = weeksFromAnchor mod cycleLen`; keep the slot iff
  `phase < onWeeks`. This composes with rrule/legacy (the inner cadence still
  decides which days within an on-week emit). Mirror the existing
  `intervalWeeks` phase math at `recurrence.ts:410-419`. Add to all three
  emitters (rrule/legacy; rolling is a single-slot semantic — apply the gate to
  the computed `nextDue`).

**`CanonicalSchedule` diff** (`recurrence.ts:47`): add `scheduleType: string`,
`cyclicOnWeeks: number | null`, `cyclicOffWeeks: number | null`.
`buildCanonicalSchedule` (`worker-helpers.ts:55`) + the project-today select
(`project-today-intakes.ts:62-73`) thread the new columns.

**Compliance impact:** PRN → zero expected (handled). CYCLIC → expected only in
on-weeks, automatically correct once compliance routes through the engine
(item 4). This is *why* item 7 must land with/after item 4.

**Zod diff** (`scheduleSchema`, `medication.ts:69`):
- `scheduleType: z.enum(["SCHEDULED","PRN","CYCLIC"]).optional()`.
- `cyclicOnWeeks: z.number().int().min(1).max(52).optional()`,
  `cyclicOffWeeks: z.number().int().min(0).max(52).optional()`.
- New `.refine`: when `scheduleType==="CYCLIC"`, both cyclic fields required;
  when `"PRN"`, rrule/rolling must be absent (PRN has no cadence).

**Route diff** (POST `route.ts:196`, PUT `[id]/route.ts:195`): add the three
fields to the per-schedule `data` build, field-by-field. Update route invariant
2 (the `FREQ=DAILY` default at `:197-205`) to **skip defaulting for PRN**.

**OpenAPI:** extend `MedicationScheduleInput` + `MedicationSchedule` components
with the three fields + the refine semantics in the description. Re-generate.

**Editor implications (NOTE ONLY — UI is a separate agent):** the wizard needs a
schedule-type selector (Scheduled / As-needed / Cyclic) gating the
cadence+cyclic-week inputs. PRN hides the reminder + times-of-day block.

**Tests:** PRN → no projection, no reminder, `rate:100`, still loggable via
intake route; CYCLIC 2-on/1-off → emits weeks 0,1 / skips week 2 / resumes
week 3; cyclic phase anchored to `startsOn`; cyclic + BYDAY composition; cyclic
`nextDueAt` lands in the next on-week.

---

## Item 8 — SB-SCHED-4 APNs suppression / multi-weekday projection  (TIER B)

**Already there:** user-level `clientManaged` suppression of `MEDICATION_REMINDER`
APNs — `reminder-worker.ts:689-715`, gated by
`isMedicationReminderClientManaged` (`notification-prefs.ts:109`), emits the
`medication_reminder_suppressed_client_managed` annotation. The
`MEASUREMENT_ANOMALY`/`MOOD_REMINDER`/etc. paths flow unchanged (confirmed by
the comment block `:686-688`).

**What's missing for multi-weekday projection:** the worker's missed-dose
mint + reminder dispatch loop iterates per-schedule and mints at
`schedule.windowStart` (`reminder-worker.ts:650-664,692`). With first-class
`timesOfDay` (multiple per day) the engine already emits one occurrence per
time-of-day (`recurrence.ts:349-358`), but the worker's reminder dispatch still
keys on the single `windowStart`. Verify the worker iterates **every**
`timesOfDay` entry, not just `windowStart`, when deciding which slot is due on
this tick — if it only checks `windowStart`, a med with `timesOfDay=["08:00","20:00"]`
gets one reminder/day, not two. This is the real SB-SCHED-4 gap: **multi-time
projection in the dispatch loop**, separate from suppression (which is done).

**Design:** in the worker tick, for each schedule that
`scheduleEmitsInWindow(...)`, expand `occurrencesBetween(canonical, tickWindow,
ctx)` and dispatch/mint per returned occurrence (per time-of-day), not once per
schedule. The suppression check (`:689`) wraps each dispatch unchanged.

**Suppression × device override (item 3):** keep user-level. Open question Q2.

**Schema/Zod/OpenAPI:** none (worker-internal + already-shipped flag).

**Tests:** med with two times-of-day → two reminder dispatches/day; with
`clientManaged` → both suppressed + two annotations; bi-weekly off-week → zero;
PRN → zero.

---

## Item 9 — Dashboard widgets PUT 422 on iOS-only widget IDs  (TIER C)

**Enum location:** `widgetIdEnum = z.enum(DASHBOARD_WIDGET_IDS)`
(`src/app/api/dashboard/widgets/route.ts:45`), source list
`DASHBOARD_WIDGET_IDS` (`src/lib/dashboard-layout.ts:17-45`). On READ, unknown
ids are already silently dropped (`dashboard-layout.ts:253-260`). On WRITE, the
strict enum rejects the **entire blob** if any id is unknown → the documented
422 → "Layout konnte nicht gespeichert werden" toast.

**Two options:**
- **(a) Expand the enum** with the iOS widget ids. Requires the server to know
  every id iOS ships — tight coupling, recurring 422 every time iOS adds a tile
  before a server release.
- **(b) Accept-and-ignore unknown ids on write** (preprocess: filter
  `widgets[].id` against `DASHBOARD_WIDGET_IDS` before Zod, mirroring the read
  path's `knownIds` filter at `:259`). The server persists only ids it knows;
  iOS-only ids are dropped server-side but iOS keeps its own local layout.

**Recommend (b)** — it is the safer, forward-compatible choice and mirrors the
existing read-side tolerance (`dashboard-layout.ts:253`). Tight enum coupling
across two release cadences is exactly what bit `achievements`/`glp1` before.

**Route diff** (`widgets/route.ts`, before `layoutSchema.safeParse` at `:140`):
preprocess `body.widgets = body.widgets?.filter(w => KNOWN.has(w.id))`. Keep the
enum for the **remaining** ids (still reject genuinely malformed shapes — a
non-string id, missing `order`). Emit an annotation
`dashboard.widgets.unknown-id-dropped` with the dropped ids + count so operators
can see iOS drift without a 422 storm. Do **not** drop the audit-ledger
breadcrumb for true validation failures (other-field 422s still fire).

**Risk flag:** (b) means a typo in a *known* widget id silently vanishes instead
of erroring. Acceptable — the read path already does this, and the alternative
(blocking the whole save) is worse. Mention in the annotation so it's
greppable.

**Schema/migration:** none. **OpenAPI:** the request schema's `id` field
description should note "unknown ids are ignored, not rejected". Re-generate.

**Tests:** PUT with one known + one unknown id → 200, known persisted, unknown
dropped, annotation emitted; PUT with malformed entry (missing `order`) → still
422; round-trip GET returns only known ids.

---

## Item 11 (hygiene, optional) — delete dead `expandTodayIntakes`

`expandTodayIntakes` (`src/lib/medication-schedule.ts:112`) is no longer on any
production read path (both today-projection routes use
`projectTodayIntakesAndRecompute`). Only comments + its own test reference it.
Safe to delete the function (keep `parseScheduleRecurrence` /
`serializeScheduleRecurrence` — still used by the route + the engine's legacy
fallback at `recurrence.ts:44,372`). Out of scope if time-boxed; flag for the
simplifier pass. Schema column `daysOfWeek` is slated for v1.6.0 drop per its
own comment (`schema.prisma:933`) but is **still read** by the legacy engine
fallback — do NOT drop the column in v1.7.0.

---

## Breaking-change risk summary

| Item | Wire break? | Risk |
|---|---|---|
| SB-LA-1 / SB-AK-1 | No (additive, defaulted) | Low |
| Delivery-pref default + device override | No (additive jsonb + nullable col) | Low; scope boundary on cron fan-out (Q2) |
| **SB-SCHED-2 compliance** | **No wire break, but semantic change to every adherence number** | **High — exhaustive parity tests required** |
| Compliance payload `due`/`expectedCount` | No (additive fields) | Low |
| nextDueAt | No (additive) | Low; 60 s cache staleness documented |
| PRN + cyclic | No (additive, defaulted SCHEDULED) | Medium — new engine branches; cyclic phase math |
| APNs multi-weekday | No (worker-internal) | Medium — verify per-time dispatch isn't a regression for single-time meds |
| Widgets 422 | No (more permissive) | Low; silent-drop trade-off |

## Open questions for the maintainer

- **Q1 (SB-SCHED-2 strategy):** Option A (rewrite `calculateCompliance` onto the
  engine) vs Option B (delegate inside `expandScheduleSlots`). Design recommends
  B for smaller blast radius + fixing the cadence chart in the same place. Confirm.
- **Q2 (device delivery scope):** v1.7.0 stores + echoes the per-device override
  but keeps cron suppression user-level (APNs fans out to all devices; iOS
  dedupes locally). Is per-device server-side fan-out suppression required this
  release, or is store+echo enough for the iOS "Dieses Gerät / Alle Geräte" UI?
- **Q3 (scheduleType storage):** Prisma enum (`MedicationScheduleType`, matches
  `deliveryForm` precedent, DB-validated) vs TEXT (matches category side-table).
  Design recommends Prisma enum.
- **Q4 (migration count):** 3 pre-allocated (0091 flags+device-delivery, 0092
  schedule-types). Confirm the 0091/0092 pre-allocation to avoid parallel-agent
  collision, or assign explicit numbers in the dispatch briefs.
