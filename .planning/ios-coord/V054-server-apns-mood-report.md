# V0.5.4 iOS Coord — Server-side APNs + MOOD_REMINDER Patches

**Branch:** `ios-coord/v054-apns-mood`
**PR:** https://github.com/MBombeck/HealthLog/pull/190
**Date:** 2026-05-17
**Status:** Open for operator review (do NOT merge to main without sign-off)

## Mission

Two server-side patches that unblock iOS HealthLog v0.5.4 push-notification
functionality:

1. **SR-1** — APNs `aps.category = "MEDICATION_REMINDER"` so iOS renders the
   three action-buttons wired in iOS v0.5.3 (Genommen / Snooze 15 min /
   Übersprungen).
2. **SR-2** — `MOOD_REMINDER` event-type + daily 22:00-local-time cron
   (opt-in, idempotent, locale-aware).

## Patches landed

### Commit 1 — `feat(notifications): set APNs category for med-reminders`

- `src/lib/notifications/senders/apns.ts`
  - `ApnsPayload` extended with optional `category` + `mutableContent`
    fields.
  - `sendApnsPush` writes the category through node-apn's setter
    (cast wraps the d.ts gap in node-apn 8.1; runtime setter at
    `apsProperties.js#166` lands the value at `aps.category`).
  - `sendViaApns` auto-forwards `payload.eventType` as the category,
    so every event-type the iOS app registers becomes actionable
    without per-event-type plumbing. `mutableContent: true` is set
    by default (NSE-ready).
- `src/lib/notifications/senders/__tests__/apns.test.ts`
  - 3 new tests pinning `aps.category = MEDICATION_REMINDER` on the
    dispatcher path, `aps.category = MOOD_REMINDER` for the new
    event-type, and the explicit-override path on `sendApnsPush`.

### Commit 2 — `feat(prisma): add moodReminderEnabled + MoodReminderDispatch ledger`

- `prisma/schema.prisma`
  - `users.mood_reminder_enabled BOOLEAN DEFAULT FALSE` (opt-in flag).
  - New model `MoodReminderDispatch` with `@@unique([userId, date])`
    — idempotency anchor for the daily cron.
- `prisma/migrations/0069_v054_mood_reminder/migration.sql`
  - Additive migration with `IF NOT EXISTS` + `DO $$ EXCEPTION WHEN
    duplicate_object` guards (idempotent on re-apply, matching the
    pattern from `0061` / `0068`).

### Commit 3 — `feat(notifications): add MOOD_REMINDER event type with daily 22:00 cron`

- `src/lib/notifications/types.ts`
  - `EVENT_TYPES` extended with `MOOD_REMINDER`. `EVENT_DEFAULT_ENABLED`
    sets it to `false` as a defence-in-depth gate behind the per-user
    `moodReminderEnabled` flag.
- `src/lib/jobs/mood-reminder.ts` (new module, 220 LOC)
  - `evaluateMoodReminderWindow(user, now)` — pure predicate for the
    22:00 window across any IANA timezone (DST-safe via
    `getLocalDateParts`).
  - `buildMoodReminderPayload(locale)` — locale-aware title/body
    (DE: "Stimmung erfassen" / "Wie geht es dir heute?";
    EN: "Log your mood" / "How are you feeling today?").
  - `runMoodReminderTick(prisma, now)` — orchestrator: pulls
    opted-in users, applies window + already-logged + already-
    dispatched filters, reserves the dedup row, dispatches.
- `src/lib/jobs/reminder-worker.ts`
  - Registers the `mood-reminder-check` queue with cron `*/15 * * * *`,
    `localConcurrency: 1`. Cadence matches the medication-reminder
    cron so any user's 22:00 boundary is caught within 15 min of
    wall-clock without one cron entry per IANA zone.
  - Existing medication-reminder dispatch now enriches metadata with
    a `scheduledAt` ISO 8601 string so the iOS snooze-15-min action
    pins against the schedule slot, not wall-clock delivery time.
- `src/lib/jobs/__tests__/mood-reminder.test.ts` (new, 13 tests)
  - Window-boundary: 21:59 / 22:00 / 22:59 / 23:00, plus a DST-bearing
    `America/New_York` check.
  - Opt-in gating, logged-today skip, ledger-already-exists skip,
    P2002 lost-race handling, multi-user multi-locale fan-out.
- `messages/{de,en,es,fr,it,pl}.json`
  - New `moodReminders.dailyTitle` + `moodReminders.dailyBody` keys
    in all six locales.

## Quality gates

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm test` | 4542 tests pass, 1 skipped (430 test files) |
| `pnpm openapi:check` | spec in sync |
| `pnpm format:check` | pre-existing warnings unchanged; my files prettier-formatted |

## Migration

`prisma/migrations/0069_v054_mood_reminder/migration.sql` ships with the
PR. Applied via `pnpm db:migrate:deploy` on staging — `IF NOT EXISTS`
guards make re-apply a no-op.

## Blockers

None.

## Follow-ups for the iOS contributor

- iOS app must register `UNNotificationCategory` identifiers
  `MEDICATION_REMINDER` (Take / Snooze 15 min / Skip) and
  `MOOD_REMINDER` (Log mood) at launch, otherwise iOS will render the
  pushes as plain alerts (the category will be present on the payload
  but iOS ignores unknown identifiers).
- iOS Settings → Notifications surface needs a toggle for
  `User.moodReminderEnabled` (PATCH /api/me or similar — the
  preferences route already exists at
  `src/app/api/notifications/preferences/route.ts` but only covers
  per-event-type matrix; this is a per-user flag, not a per-channel
  preference. Surface TBD by operator).
- The `scheduledAt` metadata field is already present on every
  outbound APNs payload for med-reminders — iOS just needs to read it
  from `userInfo`.

## Compatibility

- APNs payload changes are strictly additive. Older iOS builds that
  don't register the categories render plain alerts (iOS silently
  ignores unknown categories).
- `MOOD_REMINDER` is double-gated (per-event default OFF + per-user
  `moodReminderEnabled` defaults FALSE). Users who never opt in see no
  behavioural change.
