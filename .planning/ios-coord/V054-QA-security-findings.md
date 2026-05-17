# V054 IT-Security Review — PR #190 (4049c6c7 + c4f2e0bc)

Scope: APNs `category` + `MOOD_REMINDER` event-type. iOS coord patch on `main`.

Files inspected:

- `messages/{de,en,es,fr,it,pl}.json` (only de/en touched; rest unchanged)
- `prisma/migrations/0069_v054_mood_reminder/migration.sql`
- `prisma/schema.prisma` (User.moodReminderEnabled + MoodReminderDispatch)
- `src/lib/jobs/mood-reminder.ts` + test
- `src/lib/jobs/reminder-worker.ts` (queue registration + scheduledAt patch)
- `src/lib/notifications/senders/apns.ts` + test
- `src/lib/notifications/types.ts`

Method: read diff, trace dispatcher cascade for APNs delivery, search for opt-in write
paths, grep for log surfaces that touch device tokens or signing keys, manually
walk migration 0069 against the multi-writer / cascade rules.

Severity legend: Critical (block release) / High (must fix this release) /
Medium (fix before iOS GA) / Low (cosmetic or hardening).

---

## Severity counts

- Critical: 0
- High: 2
- Medium: 4
- Low: 3

---

## H-1 — MEDICATION_REMINDER APNs payload exposes medication name + IDs to Apple-servers and lock-screen

File: `src/lib/notifications/senders/apns.ts:240-277` (push composition) +
`src/lib/jobs/reminder-worker.ts:594-608` (caller; pre-existing) +
`src/lib/notifications/senders/apns.ts:391-411` (per-device send in `sendViaApns`).

What ships:

- `aps.alert.title` = `getPhaseMessage(...).title` which is templated with
  `{ medName }` — the medication's display name flows literally into the alert
  title. Apple's APNs servers see this in cleartext at the HTTP/2 boundary
  (TLS in transit, but Apple terminates) and iOS renders it on the
  lock-screen unless the user has globally hidden previews.
- `aps.alert.body` = `getPhaseMessage(...).message` which is templated with
  `{ medName, doseInfo, timeWindow, minutes }` — same exposure as the title,
  PLUS the dose string (e.g. "Mounjaro 7.5 mg"). The body shows in the
  Notification Center preview row even when notification previews are
  permission-gated.
- `aps` custom payload (`data`) carries `medicationId`, `scheduleId`,
  `phase`, `date`, `scheduledAt`, and `replyMarkup` (a Telegram-shaped
  `inline_keyboard` object). The custom payload is not rendered on the
  lock-screen, but Apple's relay still sees it, and any future iOS
  Notification Service Extension (mutable-content is forced on at
  `apns.ts:409`) will receive the entire object.

Why this is High and not Critical: HealthLog has historically routed the
same content through Telegram and Web Push, and Apple's relay TLS + opaque
server contract are industry-accepted. The new exposure is "now also on
Apple's network and iOS lock-screen", not "newly cleartext on the internet".
But it crosses two HealthLog norms:

1. The codebase comments repeatedly call out lock-screen exposure as a
   sensitive surface (see `MOOD_REMINDER` rationale at types.ts:38-52).
2. `replyMarkup` is a Telegram-specific field bleeding into the iOS payload
   — pure leakage with zero iOS-side consumer.

Remediation shape:

- Server-side: in `apns.ts:sendViaApns()` construct the per-channel payload
  inside the APNs sender (don't pass the dispatcher payload `data` through
  raw). Whitelist the fields APNs actually needs: `eventType`,
  `medicationId`, `scheduleId`, `scheduledAt`. Drop `replyMarkup`, `phase`,
  `date` from the iOS leg.
- Lock-screen: for `MEDICATION_REMINDER`, set
  `aps.alert.title-loc-key` + `loc-args` so iOS can render a generic
  "Medication reminder" title when the user has previews hidden, while the
  app still receives the real medName via `loc-args`. (Or simpler:
  render the title as the generic "Medication reminder" + put medName in
  `data` only, let the iOS app expand to the full string after unlock.)
- Decision lever for Marc: keep medName on the lock-screen (current UX
  parity with Telegram / Web Push) vs hide-until-unlock. Both are
  defensible — but `replyMarkup` leakage is not a UX choice and should be
  removed unconditionally.

---

## H-2 — `users.moodReminderEnabled` has no API write path → opt-in flow is missing

Files: PR adds the column + worker-side read, but no Next.js route, no
form, no Zod schema, no Settings UI touches the flag.

Verified by grep:
`grep -rn "moodReminderEnabled\|mood_reminder_enabled" src/app src/components`
returns zero non-generated matches.

Security implication: with the flag at default `false`, the feature is
functionally inert in production until someone writes a UI/PATCH endpoint.
That part is safe. But the iOS coord patch frames this as the user-facing
opt-in, and the iOS app will presumably want to flip it via the existing
auth-cookie + CSRF middleware on `/api/user/settings` or similar. Whoever
wires that endpoint MUST:

- Authenticate (session cookie or bearer iOS API token).
- Apply the same CSRF guard as the rest of `/api/user/*` (HealthLog uses
  the shared `apiContext` wrapper — verify the eventual route uses it).
- Validate the body via Zod (a single boolean).
- NOT accept mass-toggle on behalf of another userId (the route handler
  must read userId from session, never from request body).

Remediation shape: file this as a non-negotiable acceptance criterion on
the future "POST /api/user/notification-prefs" task (or wherever the toggle
lands). Add an integration test that asserts:

1. Unauthenticated request → 401.
2. Request with a different userId in body → ignored / 403.
3. Request without CSRF token (web) → 403.
4. Value coerced to boolean (no `"true"` string injection enabling).

Severity High because the opt-in is the GDPR + ethical anchor of an
"emotionally-loaded" surface (per the schema comment), and shipping the
write endpoint without these guards would silently let a malicious page
opt the user into a daily push.

---

## M-1 — `mood_reminder_dispatches` ledger has no retention policy

File: `prisma/migrations/0069_v054_mood_reminder/migration.sql:18-30` +
`prisma/schema.prisma:1192-1212`.

Growth rate: ~365 rows / opted-in user / year, kept forever. Each row
holds `userId`, `date`, `dispatchedAt` — low PII surface, but it is a
behavioural footprint ("at which dates did this user fail to log a mood
before 22:00").

GDPR posture: the row is technically health-adjacent (it derives from
mood-logging behaviour). Storing it indefinitely for users who later
disable the reminder leaks behavioural history.

Remediation shape:

- Add a daily cron (slot it next to the audit-log cleanup at 03:15) that
  deletes `mood_reminder_dispatches` rows older than ~90 days. The dedup
  contract only needs the current day's row to be live.
- Alternatively, set up a Postgres partition + drop-by-month, but for
  ~365 rows/user/year the simple `deleteMany` with a date predicate is
  plenty.
- Ensure account-deletion cascade already handles this (FK
  `ON DELETE CASCADE` is set at migration line 36 — confirmed safe).

Severity Medium: privacy-relevant, not security-exploitable.

---

## M-2 — Mood-reminder dispatcher aborts the whole tick on a single bad timezone

File: `src/lib/jobs/mood-reminder.ts:151-164` + `src/lib/timezone.ts:21-32`.

`getLocalDateParts` calls `new Intl.DateTimeFormat(..., { timeZone: tz })`
which throws `RangeError: Invalid time zone specified` for unknown IANA
strings. The mood-reminder loop has no per-user `try` wrapper — one
corrupted `users.timezone` value (typo from a manual DB write, future
import bug) will throw out of `runMoodReminderTick`, propagate to
`handleMoodReminderCheck` → `evt.setError` → `throw err`, and the entire
tick rolls back. Every opted-in user downstream of the bad row is silently
skipped for that 15-min window.

Reliability bug, not a classic security bug, but availability is part of
the security CIA triad and this is one rogue row → cohort-wide
notification outage.

Remediation shape: wrap the per-user body in `try { ... } catch (err) {
evt.addWarning(...); continue; }` and increment a
`summary.skippedInvalidTimezone` counter. Mirrors the pattern the
medication-reminder loop uses (see `reminder-worker.ts` per-user error
handling).

---

## M-3 — APNs key file read error logs full filesystem path

File: `src/lib/notifications/senders/apns.ts:172-179`.

```
signingKey = readFileSync(/* turbopackIgnore: true */ keyFile, "utf8");
// catch
getEvent()?.addWarning(`APNs key file read failed: ${message}`);
```

`fs.readFileSync` errors include the literal path (`ENOENT: no such file
or directory, open '/secrets/apns/key.p8'`) in `err.message`. This lands
in the wide-event log. If logs ever surface to a less-trusted boundary
(Coolify admin UI, support export, log shipping to a SaaS), the operator
discloses their secret-mount path.

The signing key content itself is NOT in `err.message`, only the path.

Remediation shape: log `err.code` (`ENOENT` / `EACCES` / `EISDIR`) without
the path, e.g.
`getEvent()?.addWarning("APNs key file read failed: " + (err.code ?? "read_failed"))`.

Severity Medium because:

1. Path is sensitive but not health-PII.
2. The warning fires only at process boot.
3. Wide-event log is operator-only today.

---

## M-4 — APNs cascade priority means iOS push fires even when user globally disabled the channel via a different transport

File: `src/lib/notifications/dispatcher.ts:115` (`channelPriority`) +
`src/lib/notifications/dispatcher.ts:126-145` (per-channel iteration).

APNs is cascade-priority 0 (fires first). The per-event preference check at
line 124-132 reads `EVENT_DEFAULT_ENABLED[MOOD_REMINDER] = false`, so a
user has to flip `NotificationPreference.MOOD_REMINDER.enabled = true` for
the APNs channel for the push to surface.

The double opt-in claim in the code comment ("a user has to opt in twice
before the server starts nudging them about an emotionally-loaded
surface") is therefore real ONLY for users who already have an APNS
channel row. Two scenarios where the comment lies:

1. A user with NO `NotificationChannel(type=APNS)` row will see the
   dispatcher skip APNs naturally — fine.
2. A user who paired an iPhone (APNS channel row created) and flipped
   `moodReminderEnabled = true` but NEVER touched the per-channel
   `NotificationPreference.MOOD_REMINDER.enabled` — the dispatcher
   honours `EVENT_DEFAULT_ENABLED[MOOD_REMINDER] = false` and skips. Good.

So the double opt-in actually holds in code today. BUT: the iOS coord
patch presumably ships an iOS Settings toggle that flips ONLY
`User.moodReminderEnabled` (not the per-channel preference row). If the
iOS app's toggle wires straight to the user-level flag without ALSO
creating the per-channel preference row, the worker enqueues the
notification via `dispatchNotification("MOOD_REMINDER")` and the
dispatcher swallows it because of the per-event default-off. Net: the
user toggled "on" in iOS, sees no push, blames the app.

Not a security exposure — it's a "fail-closed-but-confusingly" interaction.
Worth a contract test once the iOS-facing endpoint exists, and a docs note
on the iOS coord plan that the endpoint must upsert BOTH:

- `users.mood_reminder_enabled = true`
- `notification_preferences (channel=APNS, event=MOOD_REMINDER, enabled=true)`

Severity Medium because shipping the iOS toggle without this upsert sets
up the user for a silent feature failure that looks like a bug.

---

## L-1 — `dispatchedAt` second index `(user_id, dispatched_at)` is unused

File: `prisma/migrations/0069_v054_mood_reminder/migration.sql:29-30` +
`prisma/schema.prisma:1209`.

The handler only queries by `(userId, date)` (uses the unique index). No
code path uses the `(user_id, dispatched_at)` composite index. It costs
~1 row-write CPU and ~B-tree storage per dispatch; harmless today but
also no benefit. Remediation: drop the index in a follow-up migration OR
add the retention-cron predicate that would use it (`WHERE userId = $1
AND dispatched_at < now() - 90 days`).

Severity Low — minor hygiene.

---

## L-2 — `MOOD_REMINDER` lacks a per-event `category` registration check in tests

File: `src/lib/notifications/senders/__tests__/apns.test.ts:449-467`.

The test pins that `note.category === "MOOD_REMINDER"`, but there is no
contract test against the iOS-coord doc that the app actually registered
a `MOOD_REMINDER` UNNotificationCategory. Server-side this is fine
(APNs ignores unknown categories per the apns.ts comment at line 401-403);
just a documentation observation.

Severity Low — no server-side fix needed, flag for iOS sub-team.

---

## L-3 — `provider.shutdown()` in `resetApnsForTesting` is fire-and-forget

File: `src/lib/notifications/senders/apns.ts:191-196`.

`void provider.shutdown()` discards the returned promise. In tests this
is fine, but if any production code path ever calls
`resetApnsForTesting()` (it's exported), the in-flight HTTP/2 streams
could be torn down mid-send. Today no prod caller exists; the export is
test-only. Consider renaming to `_resetApnsForTesting` or guarding with
`if (process.env.NODE_ENV !== "test") throw ...` so future refactors
don't accidentally pick it up.

Severity Low.

---

## Top 3 issues (Marc-facing brief)

1. **H-1** — MEDICATION_REMINDER APNs payload puts medication name +
   `replyMarkup` (Telegram inline-keyboard object) into Apple's relay
   and onto the iOS lock-screen. `replyMarkup` is pure leakage; medName
   is a UX choice that crosses HealthLog's lock-screen-exposure norm.

2. **H-2** — `users.moodReminderEnabled` has no API write path in this
   PR. The opt-in toggle endpoint that the iOS coord patch needs must
   land with auth + CSRF + userId-from-session guards; pre-flag those
   acceptance criteria.

3. **M-1** — `mood_reminder_dispatches` grows ~365 rows/user/year
   forever, storing a behavioural footprint of mood-logging gaps. Add a
   90-day retention cron alongside the audit-log cleanup at 03:15.

No queue-injection surface found (cron registration is process-internal,
no API route enqueues `mood-reminder-check`). No new key material exposed
(signing key cached in process memory only, never logged). No device
tokens in logs.
