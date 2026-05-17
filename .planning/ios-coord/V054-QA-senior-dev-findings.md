# v0.5.4 iOS-coord PR #190 — Senior Code Review

Scope: squash merge `4049c6c7` + version bump `c4f2e0bc` on `main`.

## Verdict at a glance

| Severity | Count |
|---|---|
| Critical | 1 |
| High     | 4 |
| Medium   | 5 |
| Low      | 3 |

Headline: the implementation is well-shaped, the test coverage is the strongest part, and the integration with the existing reminder-worker is clean. There is **one Critical**: the ledger row is written **before** `dispatchNotification` is called, but the dispatcher swallows every internal error — so a transient APNs / Telegram failure leaves the ledger marked "dispatched" forever and the user silently gets no push that day, and no push the next day until the ledger key rolls over. Two High-severity issues concern the i18n contract (four supported locales fall back to English instead of using their freshly added strings) and the 15-minute cron cadence producing up to four wide-event lines per user-per-day even when the handler has nothing to do.

---

## Critical

### C-1. Ledger row is committed before delivery; lost pushes never retry
File: `src/lib/jobs/mood-reminder.ts:202-229`
Also: `src/lib/notifications/dispatcher.ts:209-211` (the catch-all that masks the failure)

The handler does:

```
moodReminderDispatch.create(...)   // step A — commits the dedup row
dispatchImpl({ eventType: "MOOD_REMINDER", ... })   // step B — fire-and-forget
```

`dispatchNotification` is a `void` returning function whose outer `try/catch` swallows every error path inside it (`dispatcher.ts:209`). The dispatcher also internally treats `APNs not configured`, `no devices`, every channel `hardReject`, every transient failure, and the case where the user simply has zero enabled channels as silent. That means:

* If the cron tick lands at 22:00 on a day where APNs is mid-rotation, the network is wobbly, the dispatcher throws on a DB connection blip, or the user happens to have no enabled channel yet, the ledger row is **still committed**.
* The dedup guard then correctly suppresses every subsequent tick in the 22:00 window and the next day's window stays open — but the user got nothing for *this* day.
* Worse: because `dispatchImpl` cannot be observed to fail, the handler reports `summary.dispatched += 1` even when the push never reached a single channel. The wide-event will read "we nudged the user" when in fact nothing went out.

Recommended fix shape:
1. Move the ledger write to **after** the dispatch returns. Use a `try/finally` so a thrown dispatch still records the ledger (preventing a tight retry loop within the 15-min window if dispatcher latency briefly spikes), but also gate the ledger commit on at-least-one-channel-success. The cleanest path is to give the dispatcher a return value (`{ delivered: boolean }`) and only insert the ledger when `delivered === true`.
2. Failing that, accept the at-most-once trade-off but increment `summary.dispatched` *after* dispatch returns and split `summary.delivered` vs `summary.attempted` so the wide-event is honest about what happened.
3. Either way, the dispatcher's internal swallow needs a return-value signal — `dispatcher.ts:209-211` should bubble (or surface) the outcome enough that the mood-reminder handler can branch.

This is the only finding that materially breaks the user-visible contract; everything else below is defence-in-depth or quality.

---

## High

### H-1. Locale resolver drops four of the six supported locales
File: `src/lib/jobs/mood-reminder.ts:60-62`

```
function resolveLocale(locale: string | null | undefined): Locale {
  return locale === "en" || locale === "de" ? locale : defaultLocale;
}
```

`src/lib/i18n/config.ts:1` declares the supported set as `["de", "en", "fr", "es", "it", "pl"]`, and **this same PR adds `moodReminders.dailyTitle / dailyBody` strings for all four of the additional locales** (`messages/{es,fr,it,pl}.json`). A French user with `user.locale = "fr"` will receive the English copy, even though `messages/fr.json` has the translation sitting one resolver call away.

This is also the only place where v0.5.4 narrows the supported-locale set — the existing reminder worker uses the full set via `getServerTranslator`.

Recommended fix shape: import `locales` from `@/lib/i18n/config` and check membership against that array (or rely on `getServerTranslator` to fall back internally and just pass through the user's locale unchanged).

Test gap: `buildMoodReminderPayload` only has three tests (`de`, `en`, `null/unknown`) — add a parameterised case across all six maintained locales so this never regresses.

### H-2. 15-min cron cadence produces ~96 wide-event lines per day per user (4× the necessary fan-out and 96× the necessary background-event scaffolding)
File: `src/lib/jobs/reminder-worker.ts:185, 1142-1163`

The cron is `*/15 * * * *`. Inside the 22:00 window for any user this means up to 4 ticks per user per day where `inWindow == true`, each running a Prisma `findUnique` against the ledger (cheap, but logged as a wide-event subtree). The remaining 92 ticks per day fire `withBackgroundEvent("job.mood_reminder", ...)` and execute a `findMany` over every opted-in user even though no user is in their 22:00 hour from the worker's perspective — there is no early-exit shortcut.

For a fleet of N opted-in users we get:
* 96 ticks/day × 1 `user.findMany` each = 96 unnecessary scans.
* 96 wide-event roots/day.
* `localConcurrency=1` means these ticks serialise against each other (fine today, but the queue could starve if N grows).

Recommended fix shape: either run the cron at `0 * * * *` (top-of-hour only — covers every IANA-hour boundary while cutting the noise 4×) and accept a worst-case 0–59 min latency on the *first* in-window tick (acceptable since the second hour-tick still gets the user the same day), or keep the 15-min cadence but early-exit the handler with a `SELECT 1 WHERE EXISTS (... AND user.timezone such that local hour == 22)` so the no-op ticks don't pull every row across the wire.

If 15-min cadence is kept for the iOS contract reason, at minimum suppress the `withBackgroundEvent` root when zero candidates are in-window so the observability dashboards don't flood with no-op events.

### H-3. `note.payload = { ...input.payload.data }` can collide with `aps`
File: `src/lib/notifications/senders/apns.ts:275-277`
Caller: `src/lib/notifications/senders/apns.ts:392-410` spreads arbitrary `payload.metadata` into `data`.

`note.payload` becomes the top-level JSON adjacent to `aps`. If any caller (now or later) puts `aps`, `apns`, `apns-push-type`, or other Apple-reserved keys inside `metadata`, node-apn will serialise them at the JSON root, potentially clobbering the alert/category/sound `aps` block that the same code path just configured. Today only known callers exist (medication reminders + the new mood reminder), but `metadata` is `Record<string, unknown>` — a future caller has zero compile-time protection.

Recommended fix shape: strip known-reserved root keys (`aps`, `apns-*`) from `input.payload.data` before assigning; or assert and throw in `sendApnsPush` when a reserved key is present so the regression surfaces at the call site instead of at the user's lock-screen.

### H-4. `MOOD_REMINDER` event is gated on `EVENT_DEFAULT_ENABLED = false` AND `moodReminderEnabled`, but the user-facing UI to flip either is not in this PR
File: `src/lib/notifications/types.ts:40-52`, `src/lib/jobs/mood-reminder.ts:80-82`
Plan ref: the schema comment at `prisma/schema.prisma:204-209` says "explicitly opt in from Settings → Notifications".

Neither this PR (nor anything in `git grep -n moodReminderEnabled src/app`) wires a Settings toggle for `moodReminderEnabled`. So the v0.5.4 server contract ships with a user-invisible flag — operators or iOS clients have to flip it manually, and the per-event `NotificationPreference` row also has to be created with `enabled = true` for the dispatcher to even visit any channel (because the per-event default is `false`).

This means the feature is **dark-launched**, which may be intentional for the iOS coordination patch. But there is no operator-facing note, no admin route, and no API endpoint in this PR to set the flag. If iOS v0.5.4 is expected to drive the toggle, that contract is missing on the server.

Recommended fix shape: either ship a `PATCH /api/users/me/notification-prefs` extension that accepts `moodReminderEnabled`, or document in the PR description that iOS is the only caller and link the corresponding iOS PR. At minimum, an integration test that hits the (planned) endpoint would make the contract explicit.

---

## Medium

### M-1. Cron `*/15 * * * *` interacts with `tz: "Europe/Berlin"` schedule — fine today, but the comment is misleading
File: `src/lib/jobs/reminder-worker.ts:181-188, 1692-1693`

The comment says "every 15 minutes (same cadence as the medication-reminder loop)". The `boss.schedule(... { tz: "Europe/Berlin" })` is irrelevant for `*/15 * * * *` (which fires every 15 wall-clock minutes regardless of tz reference), but a future maintainer might assume the tz applies. The handler does NOT depend on the tz parameter — the per-user local-hour check inside `evaluateMoodReminderWindow` is the only timezone-aware piece. Add a comment clarifying that the `tz` on the schedule entry is inert for this cron.

### M-2. `evaluateMoodReminderWindow` returns `localHour: -1` for opt-out users
File: `src/lib/jobs/mood-reminder.ts:80-82`

Returning a sentinel `-1` for a "real" `localHour` is a smell — the field's type is `number` and any downstream consumer that does arithmetic (e.g. metric labelling) will silently produce garbage. Either change the return to a discriminated union (`{ fire: true; localDate: string; localHour: number } | { fire: false; reason: "opt_out" | "outside_window" }`) or make `localHour` nullable.

### M-3. `localDate` formatting uses `padStart(4, "0")` on `year` but the YEAR is already 4-digit
File: `src/lib/jobs/mood-reminder.ts:85-87`

Cosmetic. `parts.year` from `getLocalDateParts` is parsed from a 4-digit Intl format. `padStart(4, "0")` is dead defensive code that confused me on read — drop it or replace with `String(parts.year)`.

### M-4. The handler scans every opted-in user on every tick, no hour-aware SQL prefilter
File: `src/lib/jobs/mood-reminder.ts:141-149`

For N opted-in users this is N rows back from Postgres per tick, then a per-user CPU loop to do Intl formatting. Today N is small; once Marc onboards external users this becomes a hot loop running 96 times a day. A pre-filter — even a coarse one such as `WHERE timezone IN (zones where local-hour is 22 right now)` — would shrink the wire payload.

Recommended fix shape: precompute the set of IANA zones whose current local hour equals `MOOD_REMINDER_LOCAL_HOUR` once per tick (≤ ~600 zones, easily cached), then `WHERE timezone = ANY ($1)`. Or push the whole decision down with a raw SQL aggregator á la the rollup readers.

### M-5. Unit tests use a stubbed Prisma; no integration test asserts the unique constraint actually fires
File: `src/lib/jobs/__tests__/mood-reminder.test.ts:320-344`

The "lost P2002 race" test fakes the error by string. There is no testcontainer test that proves the real `mood_reminder_dispatches_user_id_date_key` unique index rejects the second insert. The handler's idempotency claim is therefore unverified end-to-end. Add a Pg-backed integration test that inserts twice in parallel and asserts the second receives `P2002`.

---

## Low

### L-1. Migration is `additive + IF NOT EXISTS` but the `DO $$ ... EXCEPTION WHEN duplicate_object` block ignores other errors
File: `prisma/migrations/0069_v054_mood_reminder/migration.sql:32-39`

The FK creation block catches *only* `duplicate_object`, which is correct. But the `IF NOT EXISTS` on the unique index + table + column makes the whole migration idempotent — except for the FK, which would still throw on any non-duplicate failure. That's the right behaviour, just worth a one-line comment that any error outside `duplicate_object` is intentional and should fail the migration loudly.

### L-2. `MoodReminderDispatch` has no retention / cleanup job
File: `prisma/schema.prisma:1203-1211`

One row per (user, day) — ~365 rows/user/year. There's no nightly cleanup analogous to `auditLogCleanup` or `idempotencyCleanup`. Not urgent (tiny rows, indexed by `userId`), but a 5-year-old row has zero operational value. Add to backlog: prune dispatches older than e.g. 90 days.

### L-3. Timezone-change-mid-day edge case
File: `src/lib/jobs/mood-reminder.ts:83-92`

If a user changes their `timezone` between 22:00-local-old and 22:00-local-new on the same calendar date, they could receive two pushes (one per zone) because `decision.localDate` differs across the two zones. Vanishingly rare; mention in the planning notes only if you hit it in field reports.

---

## What was done well

- Test coverage on the pure helpers (`evaluateMoodReminderWindow`, `buildMoodReminderPayload`) is exactly the right shape — pinned boundary cases (21:59 / 22:00 / 23:00), a cross-timezone case (NY DST), opt-out gating, and locale fallback all covered.
- The choice to put the dedup check **before** the mood-entry check is correctly justified by index cost in the comment at `mood-reminder.ts:168-172`. That kind of reasoning-in-the-code pays back when the next maintainer touches it.
- The APNs `category` / `mutableContent` plumbing is conservative — node-apn's `category` setter is poked via the type-cast escape hatch with a clear comment explaining why, and `mutableContent` ships now as a no-op so the iOS NSE work can land without a server roundtrip. Both are textbook forward-compat decisions.
- The `MOOD_REMINDER_QUEUE` is correctly added to `allQueues` (the W7c lesson) — this is the exact failure mode the W10 multi-agent QA caught in v1.4.37 (drain queue not registered), and the comment at `reminder-worker.ts:1624-1628` calls it out by name.
- New APNs tests for `MOOD_REMINDER` and `MEDICATION_REMINDER` category propagation pin the v0.5.4 iOS contract well (`apns.test.ts:425-467`).
- Migration is additive, defaults are conservative (`mood_reminder_enabled DEFAULT FALSE`, `MOOD_REMINDER` per-event default also `false`), so existing users are byte-identical to v1.4.38 behaviour.

---

## Recommended sequencing

1. **Fix C-1 before any production traffic hits the cron**. The fail-closed-then-silent behaviour is the only finding that affects user trust.
2. Fix H-1 before any non-EN/DE user toggles the opt-in.
3. Address H-2 + M-1 + M-4 together as a perf/observability follow-up; one PR, no behaviour change.
4. H-3 + L-1 can ride a hygiene release.
5. M-5 belongs in the next testcontainer pass.
6. L-2 + L-3 onto the v1.4.39 backlog.
