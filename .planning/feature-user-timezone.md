# Feature proposal — per-user timezone

**Status:** documented, not scheduled.
**Trigger:** GitHub issue
[#167](https://github.com/MBombeck/HealthLog/issues/167) (Warsaw user,
v1.4.23).
**Captured:** 2026-05-12, during the v1.4.24 release retrospective.
**Owner:** unassigned — picks up in v1.5 product-lead planning.

This document is the long-form record so a future planning pass does
not start from zero. Read together with
`.planning/v15-backlog.md` (which only carries the one-line entry).

---

## 1. Background

Issue #167 reports that a Warsaw user enters a measurement at 11:05
local time, then sees `09:05` in the CSV export. He set
`TZ=Europe/Warsaw` + `PGTZ=Europe/Warsaw` on the container; the
discrepancy persisted.

That is not a deployment bug. The export writes ISO-8601 with the `Z`
suffix (UTC), and his viewer (Excel / LibreOffice) drops the marker,
so the user reads UTC as local time. The CSV is technically correct,
the framing is hostile. See `src/lib/export.ts:53, :103, :104, :129`.

The interesting part of the issue is what it surfaces: HealthLog is
hardcoded to `Europe/Berlin` end-to-end. The Warsaw reporter is in the
same UTC offset as Berlin year-round (CET/CEST), so he is the easiest
case. The same code path mis-labels every reading for a user in
London, New York, Tokyo or São Paulo — and does it silently.

---

## 2. Current state — where Berlin is wired in

Hardcoded `"Europe/Berlin"` references at the time of writing
(`grep -rn "Europe/Berlin" src/`):

| File                                                  | Role                                                      |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `src/lib/format-locale.ts:18`                         | `DISPLAY_TIMEZONE` constant — single source for display.  |
| `src/lib/analytics/berlin-day.ts:17`                  | Day-bucket key for analytics (`YYYY-MM-DD` in Berlin).    |
| `src/lib/analytics/correlations.ts:109, :117`         | Weekly ISO-Monday bucketing for correlations.             |
| `src/lib/analytics/bp-in-target.ts:64, :70, :160`     | SYS/DIA pairing fallback when timestamps drift ≥ 5 min.   |
| `src/lib/charts/bucket-time-series.ts:38`             | Daily / weekly / monthly chart buckets.                   |
| `src/lib/charts/comparison-shift.ts`                  | `chartData_compare` overlay anchored at Berlin-day-noon.  |
| `src/components/charts/health-chart.tsx:195`          | X-axis tick formatter.                                    |
| `src/components/medications/medication-card.tsx`      | "Last taken" + next-window time labels.                   |
| `src/components/admin/api-token-overview-section.tsx` | "Created / last used" timestamps in the admin table.      |
| `Dockerfile`                                          | `ENV TZ=Europe/Berlin` — container TZ for the Node clock. |
| `CLAUDE.md`                                           | Convention: "Berlin for display, UTC for storage".        |

Reminder schedules:

| File                                                       | Role                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/lib/jobs/reminder-worker.ts`                          | pg-boss cron tick interpreted in container TZ.                                |
| `src/lib/medications/window-resolution.ts` (or equivalent) | `windowStart` / `windowEnd` strings (`"07:00"`–`"09:00"`) are container-time. |
| `ReminderPhaseConfig` rows in `prisma/schema.prisma:387`   | Window thresholds per user, schema-naive ("just a string").                   |

Persistence:

- `Measurement.measuredAt`, `MedicationIntakeEvent.scheduledFor` /
  `.takenAt`, `MoodEntry.moodLoggedAt` are `DateTime` (`timestamptz`).
  Postgres stores UTC; correct. No write-path changes needed.
- `MoodEntry.date` is a `String` formatted `YYYY-MM-DD` — anchored to
  Berlin at the time of write. **This is the migration risk**: the
  same calendar moment falls into different `date` strings depending
  on the chosen anchor. See §7.
- `MedicationSchedule.windowStart` / `.windowEnd` are `String`
  `"HH:MM"` — same problem: a "08:00" window is Berlin local today.

---

## 3. Symptom catalogue — beyond the CSV

Closing the CSV alone is a 4-files patch. The architectural problem is
broader. Each row below is a separate symptom that an end-user can
hit:

1. **CSV / JSON export reads as UTC.** Issue #167. Fix in `export.ts`.
2. **Reminders fire at Berlin time, not user time.** A Tokyo user sets
   a 08:00 morning reminder; the pg-boss cron tick checks against
   container TZ, so the message arrives at 16:00 Tokyo. Hidden today
   because the only known users are CET/CEST.
3. **"Today" buckets misalign.** A user logs a 23:30 reading in their
   local zone that maps to "tomorrow" UTC and "tomorrow" Berlin →
   their day-summary card carries the reading on the wrong calendar
   day. Same effect on the streak counter (achievements) and the
   "today vs yesterday" comparison.
4. **Mood-entry date drift.** `MoodEntry.date` is a `String` written
   in Berlin. A New York user entering at 21:00 EDT (= 03:00 next-day
   Berlin) gets the wrong `date` string, which then disagrees with the
   `moodLoggedAt` timestamp.
5. **Withings sync day-mapping.** Withings ships UTC timestamps;
   `withings-sync` buckets them via `berlin-day.ts`. A reading taken
   at 23:50 local in Tokyo (14:50 UTC) lands on yesterday-Berlin
   instead of today-Tokyo. The user sees their evening reading on
   yesterday's chart.
6. **Charts X-axis labels.** Mobile chart x-axis label formatter
   passes `timeZone: "Europe/Berlin"` directly. A New York user sees
   `Mai 11` for a reading they remember entering on `May 10` 22:30 EDT.
7. **Email / push notification timestamps.** Notification body
   templates render times in the dispatcher, container TZ. Same
   mis-attribution as #2 once #2 is fixed.
8. **PDF doctor report.** `src/app/api/doctor-report/pdf/route.ts`
   renders rows with `formatInTimeZone` against Berlin. A PDF a US
   user takes to their doctor lists every reading at a Berlin
   timestamp.
9. **AI Coach + analytics context.** The Coach prompt context says
   "yesterday" and "this week" against Berlin-anchored buckets. Same
   day-misalignment problem as #3, but tucked inside the prompt where
   nobody will see it until a user complains the recommendation is
   for the wrong day.
10. **OpenAPI / iOS DTO contract.** `docs/api/openapi.yaml` ships
    timestamps as `string($date-time)` without a contract on offset.
    iOS will round-trip them as UTC. If the future iOS app renders
    its own clock, it will diverge from the web UI until the web UI
    learns user TZ too.

That is ten distinct surfaces, not one.

---

## 4. Design space

### Option A — leave display TZ alone, fix the export only

CSV/JSON write ISO-8601 with offset (`2026-05-11T11:05:00+02:00`)
instead of `Z`. Same instant, machine-parseable, human readable.

- Scope: 4 lines in `src/lib/export.ts` + 2 test updates.
- Closes issue #167.
- Does not fix the 9 other symptoms.
- Sensible if the product stays Europe-only.
- **Cost:** ~2 h.

### Option B — per-user `displayTimezone` setting, opt-in, default Berlin

Add a `User.displayTimezone` column (DEFAULT `"Europe/Berlin"`).
Surface a picker in `/profile`. Every display-side helper takes the
user pref instead of `DISPLAY_TIMEZONE`. Reminder cron + Withings
day-mapping + Coach context all become user-TZ-aware.

- Scope: large. ~30 files touch the constant, ~10 buckets need to
  parametrise their bucketing helper, ~5 surfaces switch from `Intl`
  literal to a hook/util.
- Existing data is unaffected by storage (still `timestamptz`).
- Existing `MoodEntry.date` strings and `MedicationSchedule.windowStart`
  / `.windowEnd` are the migration risk — see §7.
- Reminder worker rewrite: pg-boss cron is timezone-naive; choose
  between (a) per-user cron rows, (b) global 1-minute tick with
  in-app "is it time in user TZ?", (c) precompute the next absolute
  UTC fire time per reminder on every settings change and on each fire.
- **Cost:** 1–2 weeks elapsed, conservative. The honest number when
  every symptom from §3 is closed and the test suite is parametrised
  per TZ branch.
- **Recommended.**

### Option C — auto-detect from browser

`Intl.DateTimeFormat().resolvedOptions().timeZone` from the client,
stored in a cookie or sent with every request. No user-visible
picker.

- Implicit: the user never opted in, never sees what they are set to,
  cannot fix a wrong guess.
- Useless for the iOS app, CLI consumers, API-token clients.
- **Rejected** as a primary mechanism. Reasonable as the _default
  value_ for the §B picker on signup.

---

## 5. Recommended path

1. **v1.4.25 quick fix** (Option A, separate from this proposal):
   ship the ISO-8601-with-offset export so issue #167 closes
   immediately. Adds an `aria-label` / footer note in the export-UI
   that timestamps carry the user's display zone. Documented in the
   v1.4.25 changelog as a follow-on; no roadmap impact.
2. **v1.5 (or later) full feature** (Option B): plan as a dedicated
   wave. The migration risk in §7 dominates the schedule.

The two are independent — A can ship next week, B can sit on the
backlog without blocking it.

---

## 6. Migration strategy for Option B

### 6.1 Schema additions (forward-only, no breakage)

```prisma
model User {
  ...
  displayTimezone String @default("Europe/Berlin")
  ...
}
```

Migration `00XX_user_display_timezone` — additive, DEFAULT covers
every existing row, no backfill needed.

### 6.2 Constant → user-pref accessor

Replace every direct `DISPLAY_TIMEZONE` import with a context-aware
helper:

```ts
// Server side
const tz = await getUserTimezone(); // reads from session.user.displayTimezone

// Client side
const tz = useUserTimezone(); // hook, reads from auth context
```

`format-locale.ts` keeps exporting `DISPLAY_TIMEZONE` as a _fallback_
for non-user-scoped surfaces (admin tables, audit log viewer,
analytics QA dashboard — every place where "whose timezone?" has no
answer). Worker code (`reminder-worker.ts`, `withings-sync`) reads the
target user's pref before any bucketing.

### 6.3 Per-surface fixes (order matches §3)

| #   | Surface                | Change                                                                 |
| --- | ---------------------- | ---------------------------------------------------------------------- |
| 1   | CSV/JSON export        | `formatInTimeZone(..., userTz, "yyyy-MM-dd'T'HH:mm:ssXXX")`            |
| 2   | Reminder worker        | recompute next-fire on settings change, in user TZ                     |
| 3   | "Today" buckets        | `berlin-day.ts` → `user-day.ts` taking `tz` arg                        |
| 4   | `MoodEntry.date` drift | see §7                                                                 |
| 5   | Withings sync          | bucket via user-tz instead of `BERLIN_TZ`                              |
| 6   | Chart x-axis           | tick formatter takes `userTz` prop, falls back to Berlin               |
| 7   | Notification body      | dispatcher reads recipient's tz before formatting                      |
| 8   | PDF doctor report      | header reads user's tz; if export is for a target user, use theirs     |
| 9   | Coach prompt context   | "yesterday" / "this week" computed in user tz                          |
| 10  | OpenAPI / iOS DTO      | document timestamps as `string($date-time)` w/ note: always UTC offset |

### 6.4 Test strategy

`berlin-day.test.ts` has the right shape but pins to Berlin. The
parametrised version runs each test under 3–5 representative zones:

- `Europe/Berlin` — DST boundary cases stay green.
- `UTC` — sanity baseline.
- `America/New_York` — large negative offset, DST.
- `Asia/Tokyo` — large positive offset, no DST.
- `Pacific/Kiritimati` — UTC+14, extreme positive offset (catches
  off-by-one-day bugs in date-only strings).

A test helper `withTimezone(tz, () => { ... })` wraps the existing
suites. Expect ~30 existing tests to be parametrised; total suite size
roughly doubles for the TZ-sensitive units. Acceptable.

---

## 7. The real risk — date-only strings

The only thing in the schema that is _not_ time-instant data is the
two strings:

- `MoodEntry.date` (`YYYY-MM-DD`) — written from
  `formatInTimeZone(loggedAt, BERLIN_TZ, "yyyy-MM-dd")`.
- `MedicationSchedule.windowStart` / `.windowEnd` (`HH:MM`) — set by
  the user via the medication form; they read as "Berlin local time"
  today.

When the user switches their `displayTimezone` from `Europe/Berlin` to
`America/New_York`:

- **Mood entries:** every historical `MoodEntry.date` is now a Berlin
  calendar day, but the UI will render its day-summary card by
  New-York-calendar-day. Existing entries near midnight will appear
  to "jump" between days.
  - **Decision A — freeze:** TZ is captured at the time of write.
    Schema gains `MoodEntry.tz TEXT NOT NULL DEFAULT 'Europe/Berlin'`,
    UI groups by `(tz, date)`. Historical entries stay where the user
    logged them. **Recommended.**
  - **Decision B — recompute:** treat `date` as derived from
    `moodLoggedAt`, redo the string under the new TZ. Cleaner code,
    but historical "day" assignments shift, which can change streak
    counts and break achievements awarded retroactively.
- **Medication windows:** "07:00" today means "07:00 in Berlin". A
  user moving to Tokyo legitimately wants their morning dose at
  Tokyo-07:00, not Berlin-07:00. **Decision A — freeze** is wrong
  here, because the user's expectation is that their reminder follows
  them. **Decision B — re-anchor** is correct: schedules are stored
  as "wall clock in current display TZ" and reinterpreted under the
  new TZ.
- The asymmetry is real: historical observations want freeze, future
  schedules want re-anchor. The schema needs to express both
  contracts.

### 7.1 DST edge cases

The existing `berlin-day.test.ts` already covers Berlin DST. The
parametrised version inherits this. **Open question:** what happens
when a reminder window straddles a DST boundary in the user's TZ?
Today this is a Berlin-only concern and pg-boss handles it implicitly
via container TZ. With per-user TZ, the resolver has to make a choice
("fire at the wall-clock time on both sides" vs "fire at the absolute
UTC time of the pre-DST occurrence"). Document and pick a convention
before implementation.

---

## 8. Out-of-scope for this proposal

- Per-tenant / per-org TZ: HealthLog is single-tenant.
- TZ-by-IP fallback for unauthenticated surfaces: pricing dashboards
  and the auth pages stay Berlin.
- Localised number formats (German 1.234,56 vs US 1,234.56): tracked
  separately under i18n.
- Calendar locale (Monday-start vs Sunday-start week): same.

---

## 9. Open questions for the v1.5 product-lead pass

1. Is per-user TZ a v1.5 commitment, or does it slip to v1.6+ behind
   the iOS work?
2. If v1.5, does it ship before or after Apple Health import? Apple
   Health entries carry their own source-TZ metadata — could simplify
   the migration if we lift that as the canonical representation.
3. Decision A (freeze) vs Decision B (re-anchor) split per surface
   needs a product call, not an engineering call. Pre-fill from §7.
4. Acceptance criterion for "done": pick 1–2 user complaints we are
   willing to ship with, and 1–2 that block release. Probably "Coach
   prompt context drift" is acceptable for an MVP; "reminder fires at
   wrong wall-clock time" is not.

---

## 10. Pointers for the next agent

- This file lives at `.planning/feature-user-timezone.md`.
- One-line carry in `.planning/v15-backlog.md` under "From issue
  triage".
- One-line carry in `.planning/ROADMAP.md` under v1.5 / v1.6+ reserved
  themes.
- Triggering issue: GitHub #167 (Warsaw user, v1.4.23, CSV export
  shows UTC).
- The v1.4.25 quick fix (Option A) is independent — file it as its
  own backlog row, not blocked on this proposal.
