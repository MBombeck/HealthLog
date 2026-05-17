# V054 — QA specialist findings (APNs + Prisma migration)

**Scope.** Squash-merge `4049c6c7` ("feat(notifications): APNs category + MOOD_REMINDER event for iOS v0.5.4 (#190)") plus the v1.4.38.1 chore bump `c4f2e0bc` on `main`. Files in scope: `prisma/migrations/0069_v054_mood_reminder/migration.sql`, `prisma/schema.prisma`, `src/lib/notifications/senders/apns.ts` + test, `src/lib/notifications/types.ts`, `src/lib/jobs/mood-reminder.ts` + test, `src/lib/jobs/reminder-worker.ts`, `messages/{de,en,es,fr,it,pl}.json` (moodReminders namespace only).

Two specialist lenses applied: APNs payload schema (Apple 2024+) and Prisma migration idempotency / referential integrity. READ-ONLY review — no code modified, no migrations executed.

---

## Severity counts

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High     | 2 |
| Medium   | 4 |
| Low      | 3 |

---

## Findings

### H1 — `resolveLocale` drops es/fr/it/pl, defeats the just-shipped translations [High]

**File.** `src/lib/jobs/mood-reminder.ts:60-62`

```ts
function resolveLocale(locale: string | null | undefined): Locale {
  return locale === "en" || locale === "de" ? locale : defaultLocale;
}
```

**Issue.** The HealthLog locale set declared in `src/lib/i18n/config.ts:1` is `["de", "en", "fr", "es", "it", "pl"]`. `getServerTranslator` correctly serves all six locales (it indexes into `allMessages[locale]` and falls back to English on missing keys). However `buildMoodReminderPayload` funnels the user's locale through `resolveLocale`, which whitelists only `en` and `de` and downgrades everything else to `defaultLocale` (= `en`).

Net effect on iOS v0.5.4 ship: the Spanish / French / Italian / Polish `moodReminders.dailyTitle` + `dailyBody` strings introduced in the same PR (`messages/{es,fr,it,pl}.json:2991-2992`) are **unreachable** — every non-de/non-en user will receive the English copy regardless of `User.locale`. The translations are inert dead code today.

The unit test `buildMoodReminderPayload — falls back to the app default for null / unknown locales` (mood-reminder.test.ts:171-177) passes for the wrong reason: it asserts that the `null` and `"zz-ZZ"` fallbacks land on the same string, which they do — but `"fr"`, `"es"`, `"it"`, `"pl"` also currently land on that same English fallback.

**Fix shape.** Replace the explicit allow-list with a check against `locales` from `@/lib/i18n/config`, then cast the validated input to `Locale`:

```ts
import { locales } from "@/lib/i18n/config";
function resolveLocale(locale: string | null | undefined): Locale {
  return (locales as readonly string[]).includes(locale ?? "")
    ? (locale as Locale)
    : defaultLocale;
}
```

Add three test cases asserting `fr` → `"Enregistrer votre humeur"`, `es` → `"Registrar el ánimo"`, `it` → `"Registra il tuo umore"`, `pl` → `"Zapisz nastrój"`.

### H2 — French copy missing apostrophe: `aujourdhui` → `aujourd'hui` [High]

**File.** `messages/fr.json:2993`

```json
"dailyBody": "Comment vous sentez-vous aujourdhui ?"
```

**Issue.** Every other French string in the codebase writes `aujourd'hui` (curly apostrophe) or `aujourd'hui` (straight apostrophe) — see `fr.json:400, 529, 625, 979`. The new key is missing the apostrophe entirely, surfacing on iOS push notifications as the misspelled word. This is the user-visible mood reminder body — first impression for French users opting in.

**Fix shape.** Change to `"Comment vous sentez-vous aujourd'hui ?"` (curly apostrophe, matching the existing convention in `fr.json:400, 529`). Once H1 is fixed and French users can actually receive the string, this becomes immediately visible.

### M1 — node-apn d.ts cast pokes the `.category` setter directly; safer to write `aps.category` [Medium]

**File.** `src/lib/notifications/senders/apns.ts:265`

```ts
(note as unknown as { category: string }).category = input.payload.category;
```

**Issue.** The cast comment explains the d.ts gap accurately and node-apn 8.1's runtime does honour `.category` as a setter that writes through to `aps.category`. The fragility is the implicit dependency on an undocumented setter that the maintainer could rename in a minor release without breaking the d.ts contract (the contract doesn't mention it). A defensive belt-and-braces alternative is to write `note.rawPayload = { aps: { category: ... } }`, which is part of node-apn's documented API, or to fall back to a payload property assignment if the setter were ever removed.

This is a Medium because the behaviour is correct today (an explicit test pins it — `apns.test.ts:425-447`) but the abstraction layer is unusual for this codebase and a node-apn upgrade is the breakage vector.

**Fix shape.** Either (a) accept the runtime coupling and add an explicit comment-block changelog note pinning the supported node-apn version range, or (b) refactor to use node-apn's `note.aps.category = ...` access path, which is in the published `Aps` interface. Today's test would still pass.

### M2 — Mood-reminder `data: null/undefined` ⇒ no custom-keys envelope [Medium]

**File.** `src/lib/notifications/senders/apns.ts:275-277`

```ts
if (input.payload.data) {
  note.payload = { ...input.payload.data };
}
```

**Issue.** The lower-level `sendApnsPush` only attaches the `data` envelope when `input.payload.data` is truthy. The dispatcher-level entry point `sendViaApns` (line 393-396) always sets `data: { eventType: ..., ...metadata }`, so the contract holds for the production path. But a future caller of `sendApnsPush` that omits `data` would ship a push with no client-side disambiguator at all — the iOS handler has no way to tell `MOOD_REMINDER` from `MEDICATION_REMINDER` from `SYSTEM_ALERT` once the user taps. The `category` field on `aps` is enough for the action-button row, but it does NOT surface in `userInfo` on the legacy `didReceive` delegate path before iOS 10.

**Fix shape.** Always attach at least `{ eventType }` from the calling layer (or, alternatively, write `note.payload = { eventType, ...(data ?? {}) }` in the sender so the envelope is never empty). Add a sender-level test asserting `note.payload.eventType` is set even when the caller passes no `data`.

### M3 — `scheduledAt` ISO string in med-reminder metadata bypasses scheduling source-of-truth [Medium]

**File.** `src/lib/jobs/reminder-worker.ts:582-587`

```ts
const [winH, winM] = schedule.windowStart.split(":").map(Number);
const scheduledAtIso = new Date(
  todayStart.getTime() + winH * 3600000 + winM * 60000,
).toISOString();
```

**Issue.** `todayStart` is a UTC Date returned from `getUserTodayBounds` (the user's local midnight expressed as UTC). Adding `winH * 3600000 + winM * 60000` to that timestamp is a straight UTC offset — correct ONLY when the user's local midnight + `winH` hours yields the same wall-clock as `winH` in local time, which is `false` across a DST transition day in any IANA tz that observes DST.

Concrete example: user in `Europe/Berlin` on the autumn fall-back day (2026-10-25, clock goes back 1h at 03:00). `todayStart` resolves to 2026-10-24T22:00:00Z (00:00 local). For a `windowStart="22:00"` schedule, the code computes `2026-10-25T20:00:00Z` and stamps it as the schedule slot. The actual wall-clock 22:00 local that day is `2026-10-25T21:00:00Z` (one hour later in UTC because the day has 25 hours). The metadata sent to APNs is off by one hour exactly on transition days.

This is a Medium because (a) the impact is one wrong second of `scheduledAt` per user per DST day per schedule, (b) the iOS client uses `scheduledAt` to anchor the "snooze 15 min" calculation — it would snooze relative to the wrong baseline on DST days, and (c) Marc's user base is concentrated in Europe/Berlin where this fires twice a year.

**Fix shape.** Project `windowStart` into the user's timezone via the same `Intl.DateTimeFormat` machinery that powers `getLocalDateParts` — or, simpler, store `scheduledAt` as the local YYYY-MM-DDTHH:mm string + tz separately and let the iOS client convert. Either way, do not arithmetic-add hours to a UTC `todayStart` and call it a local-time slot.

### M4 — `getServerTranslator` is synchronous but reads `allMessages` from disk on first call [Medium]

**File.** `src/lib/jobs/mood-reminder.ts:104` (via `getServerTranslator`)

**Issue.** Once per worker boot, the first `runMoodReminderTick` invocation triggers a synchronous read of every locale's messages bundle through `allMessages`. The worker has `localConcurrency=1` and this only happens once per process, so the runtime cost is irrelevant. The concern is initialisation order: if `runMoodReminderTick` ever runs on a code path where the locale messages aren't yet bundled into the runtime (e.g. a unit test that mocks `@/lib/i18n/shared-resolve` partially), the dispatcher silently returns the raw key like `"moodReminders.dailyTitle"` as the push body.

The unit test `buildMoodReminderPayload — returns German strings for locale=de` (mood-reminder.test.ts:160-163) does NOT mock the i18n layer — it exercises the real translator. That guards the de/en path but not against future re-arrangements of how messages are bundled.

This is a Medium because the production codepath works today; the brittleness is the dependency on global init.

**Fix shape.** Add a defensive assertion in `buildMoodReminderPayload` that the resolved string is not equal to the input key, throwing if so. That converts a silent "user receives `moodReminders.dailyTitle` as their push" into a loud worker error visible in the wide-event log.

### L1 — Idempotency-row created BEFORE dispatch ⇒ dispatcher failure leaves a poison-pill row [Low]

**File.** `src/lib/jobs/mood-reminder.ts:198-216`

**Issue.** The handler reserves the `MoodReminderDispatch` row first (lines 202-216), then calls `dispatchImpl` (lines 220-229). If the dispatcher throws — APNs network outage, web-push 500, Telegram quota — the ledger row is already persisted with `dispatched_at = now()`. The next 15-min tick checks the ledger, finds the row, and skips the user for the rest of the day. The user never receives the reminder despite the dispatcher having no successful delivery.

The comment on line 197-201 acknowledges the race-vs-double-fire tradeoff but doesn't address the failure-mode tradeoff. The current ordering optimises for "never double-send"; the alternative would optimise for "always retry on transient failure".

**Fix shape.** Either (a) accept the tradeoff explicitly and document that an APNs outage during the 22:00 window means the user gets no reminder that day — which may be the right call for a low-stakes nudge, or (b) move the ledger write to AFTER successful dispatch with a UNIQUE constraint catch on the second tick. Option (a) is probably right for v0.5.4. A test pinning the chosen contract would be valuable.

### L2 — `scheduledAt` UTC string risks confusing the iOS handler in non-Berlin zones [Low]

**File.** `src/lib/jobs/mood-reminder.ts:225-228`

```ts
metadata: {
  scheduledAt: now.toISOString(),
  localDate: decision.localDate,
},
```

**Issue.** `now.toISOString()` is the wall-clock UTC of the cron tick that fired, NOT the local 22:00 boundary. The iOS handler reading `scheduledAt` to derive "you should have logged your mood by 22:00 local" gets a UTC timestamp 0–14 minutes after 22:00 local. Not wrong, but ambiguous: the API field name reads as "when was this scheduled to fire" — answer is "22:00 local" — but the value is "22:07Z on a Friday in Berlin".

This is a Low because the iOS contract for `scheduledAt` is not pinned anywhere in this PR (no iOS code in scope), and the dispatcher payload pattern matches the new med-reminder enrichment (M3). Worth aligning on a convention with the iOS team before v0.5.4 ships.

**Fix shape.** Either rename to `dispatchedAt` (which is what the value is) or compute the actual 22:00 local boundary in UTC and ship that — same fix shape as M3, same convention.

### L3 — Cron `*/15` may miss the 22:00 window for a user whose tz transitions during the hour [Low]

**File.** `src/lib/jobs/reminder-worker.ts:183-194`

**Issue.** A user on the `Asia/Kathmandu` (+05:45) timezone — or any other quarter/half-hour-offset tz — could in principle have a DST transition lining the cron's 15-minute UTC tick pattern up such that all four UTC ticks within the user's local 22:00 hour are on the "old" side of the transition and one falls on the "new" side that's no longer 22. Practically, no quarter-hour-offset tz observes DST today (Asia/Kathmandu, Asia/Yangon, Pacific/Chatham +12:45 don't), so this is theoretical.

**Fix shape.** No action needed today. Add a comment near the cron declaration noting that the every-15-min cadence assumes IANA timezones with full-hour DST shifts, so the assumption is reviewable when a new tz is added to the supported list.

---

## Prisma migration 0069 — verdict: GREEN

The migration `prisma/migrations/0069_v054_mood_reminder/migration.sql:15-39` correctly implements the idempotency guards:

- `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mood_reminder_enabled" BOOLEAN NOT NULL DEFAULT FALSE` — the `IF NOT EXISTS` guard is supported on Postgres 9.6+ (HealthLog runs PG 16). Re-application is silent. Default `FALSE` matches the Prisma decl `Boolean @default(false)` in `schema.prisma:208` and the "default off" contract claimed in the commit message.
- `CREATE TABLE IF NOT EXISTS "mood_reminder_dispatches"` — also idempotent, ditto the `CREATE UNIQUE INDEX IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` lines.
- The composite unique index `mood_reminder_dispatches_user_id_date_key` on `("user_id", "date")` matches the Prisma `@@unique([userId, date])` in `schema.prisma:1208` byte-for-byte (Prisma's auto-generated index name convention is `{table}_{col1}_{col2}_key`). The `userId_date` composite query at `mood-reminder.ts:174` will hit this index.
- The `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL END $$` block correctly handles re-application of the FK constraint, catching the `duplicate_object` SQLSTATE that PG raises when an FK with the same name already exists.
- `ON DELETE CASCADE` on `mood_reminder_dispatches.user_id` is the correct choice for privacy retention: when a user is deleted, their reminder ledger goes with them. The ledger contains no clinical data — only an opaque `id`, `user_id`, `date`, `dispatched_at` — so the cascade is also GDPR-clean.

Re-applying the migration on a database where it already ran will succeed silently — verified by code inspection of all four `IF NOT EXISTS` / `EXCEPTION` guards.

---

## APNs payload — verdict: GREEN with one nuance

- `aps.category` is set via node-apn's `Notification.category` setter (`apns.ts:265`), which writes through to `aps.category` per the library's runtime contract. The value is a plain string matching exactly what iOS v0.5.3 registers (`MEDICATION_REMINDER`, `MOOD_REMINDER`). No typos. ✅
- `aps.mutable-content` is set via `note.mutableContent = true` (`apns.ts:270`), which node-apn correctly serialises as the JSON integer `1`, not the boolean. node-apn's `Notification` setter is documented and respects Apple's strict-integer rule. ✅
- Payload size: the largest enrichment added in this PR is `scheduledAt` (~26 chars ISO string) + `localDate` (~10 chars). The med-reminder branch adds the same `scheduledAt`. Total payload across all metadata keys is well under 1 KB — nowhere near the 4 KB / 5 KB APNs limits. ✅
- Alert localisation: server-side string interpolation via `getServerTranslator`, no `loc-key` / `loc-args` template path. That's a deliberate choice — `loc-key` requires the iOS bundle to ship the matching `Localizable.strings`, and the server can change copy without an App Store release this way. Tradeoff is mentioned for completeness, not flagged. ✅
- Device token handling: no token logging, no token leakage in the wide-event payload. `apns.ts:285-290` logs only `service`, `method`, `duration_ms`, `status`, `error`. The `addExternalCall` call never receives the token. ✅

---

## Test-coverage note

The 13 unit tests in `mood-reminder.test.ts` pin window boundaries, opt-in gating, dedup, and the P2002 race correctly. The locale test at lines 159-177 is weak: it covers de + en + null/unknown but misses fr/es/it/pl. Adding four lines there would catch H1 immediately and is the smallest possible regression guard.

The APNs test at `apns.test.ts:449-467` pins `MOOD_REMINDER` category forwarding correctly. Good coverage of the new event-type's APNs path.
