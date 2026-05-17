# V054 PR #190 — UX Review of Notification Surfaces

**Reviewer scope.** Squash-merge `4049c6c7` + version bump `c4f2e0bc` on `main`.
**Files in scope.** `messages/{de,en,es,fr,it,pl}.json`,
`src/lib/notifications/senders/apns.ts`, `src/lib/notifications/types.ts`.
**Audience.** Opted-in personal-health tracker user, iPhone lock-screen or
Notification Center, DE canonical / EN/ES/FR/IT/PL translated.

---

## Severity counts

| Severity | Count |
| --- | --- |
| Critical | **2** |
| High     | **3** |
| Medium   | **3** |
| Low      | **2** |

---

## Critical

### C1 — French body has spelling bug `aujourdhui` (missing apostrophe)
**File.** `messages/fr.json:2993`
```
"dailyBody": "Comment vous sentez-vous aujourdhui ?"
```
Correct French is `aujourd'hui`. This is a hard typo that ships on the
lock-screen and reads aloud through VoiceOver. Native FR users will see
this as carelessness on a *health* product. The same string in DE/EN/ES/IT
is spelled correctly. Either the apostrophe was stripped because the
contributor avoided embedding `'` inside the JSON string, or it was simply
missed during the wave.

**Fix.** `"Comment vous sentez-vous aujourd'hui ?"` (the curly apostrophe
`’` is also acceptable and is what Apple typography expects, but the
straight `'` is what the rest of the FR file uses — keep it consistent).

### C2 — No Settings surface to toggle `mood_reminder_enabled`
**Files.**
- `src/components/settings/notifications-section.tsx` (the natural home)
- `src/app/settings/[section]/page.tsx`
- DB column `users.mood_reminder_enabled` exists, default `false`
- `NotificationsState` has a `moodLogGlobal` field but it is **unwired**
  (`grep -n moodLog notifications-section.tsx` returns only the type
  declaration on line 19; no `<Switch>` / `<Checkbox>` renders it, and the
  field is *not* the new `moodReminderEnabled` flag — it's pre-existing
  unrelated state).

A user who installs iOS HealthLog v0.5.4 and grants notification permission
**cannot turn the daily 22:00 mood push on**, because the only way to flip
`User.moodReminderEnabled = true` today is via raw SQL or the Prisma
console. The feature ships as a dead opt-in.

**Fix.** Add a single `<Switch>` to `notifications-section.tsx` bound to
`/api/me` (or wherever profile prefs are PATCHed), with the
`notifications.moodReminder.toggleLabel` /
`notifications.moodReminder.toggleDescription` strings added to all six
locale files. Without this, ship the server foundation as "iOS-only" in
the release notes or pull the cron registration until a UI exists.

---

## High

### H1 — 22:00 fire-time ignores user sleep / quiet hours
**File.** `src/lib/jobs/mood-reminder.ts:37`
```
export const MOOD_REMINDER_LOCAL_HOUR = 22;
```
Hard-coded to 22:00 local. `grep -in "quiet\|sleep\|do.?not.?disturb"
src/lib/jobs/mood-reminder.ts` returns nothing. A user whose
`Settings → Sleep` schedule has them in bed at 22:00 (early sleepers,
shift workers, parents) gets buzzed during wind-down on a product that
otherwise tracks sleep as a first-class metric. iOS Focus modes will
suppress the banner, but the badge + lock-screen flash still happen, and
on Android (web push fallback) Focus modes don't apply.

**Fix.** Either (a) make the hour user-configurable in the same Settings
row as C2, or (b) cross-reference the user's average bedtime from the
Sleep series and skip the push if `22:00 ≥ avg_bedtime - 30min`. (a) is
the minimum viable fix.

### H2 — DE title `Stimmung erfassen` reads as a task instruction, not a nudge
**File.** `messages/de.json:2992`

The DE title imitates the EN imperative `Log your mood`, but Marc's
existing DE notification copy (see `medicationReminders` block,
`messages/de.json:2976-2989`) uses *event-status* phrasing — `🟢
Erinnerung: …`, `🟡 Bald fällig: …`. The new title breaks pattern and
sounds like a task on a TODO list rather than a soft check-in. The body
`Wie geht es dir heute?` already carries the conversational tone the
title is missing; the title should match the warmth.

**Suggested DE.** `Kurzer Stimmungs-Check` or `Tagescheck Stimmung` —
mirrors the noun-led, status-flavoured style of the rest of the file. A
two-word title also keeps it well under the iOS 50-char truncation in any
locale.

### H3 — `category = payload.eventType` is forwarded indiscriminately
**File.** `src/lib/notifications/senders/apns.ts:399`
```ts
category: payload.eventType,
```
The comment claims "iOS ignores categories it doesn't know about, so adding
the key here is safe". That is true for *unknown* categories. But the iOS
app currently registers two known categories (`MEDICATION_REMINDER`,
`MOOD_REMINDER`); every *other* event type — `MEDICATION_MISSED`,
`WITHINGS_SYNC_FAILED`, `SYSTEM_ALERT`, `PERSONAL_RECORD` — now ships with
a category identifier that iOS will look up, find nothing for, and silently
drop. That's not a UX bug today, but the moment the iOS team registers a
3rd category they will inherit accidental wiring (e.g. registering
`SYSTEM_ALERT` with destructive actions automatically routes existing
server pushes through it). UX-wise: silent surface-coupling between
back-end event-types and iOS UI categories.

**Fix.** Maintain an explicit allow-list (`KNOWN_IOS_CATEGORIES`) inside
the sender. Only forward `category` for event-types in the list. The cost
is one line; the safety is significant.

---

## Medium

### M1 — Inconsistent register across locales
| Locale | Form | Note |
| --- | --- | --- |
| DE | informal `du` (`Wie geht es dir heute?`) | matches AI Coach / app convention |
| EN | imperative + casual | OK |
| ES | informal `tú` (`¿Cómo te sientes hoy?`) | matches |
| FR | **formal `vous`** (`Comment vous sentez-vous`) | breaks pattern — rest of FR coach copy uses informal `tu` per recent v1.4.38 wave |
| IT | informal `tu` (`Come ti senti oggi?`) | matches |
| PL | informal `ty` (`Jak się dzisiaj czujesz?`) | matches |

FR is the outlier. A health-tracker daily nudge is exactly the kind of
intimate, single-user surface where French apps drop `vous`. Re-check
against the rest of `messages/fr.json` and align.

### M2 — Mood title `Registrar el ánimo` (ES) is jargon-y
**File.** `messages/es.json:2993`
`Registrar el ánimo` is grammatically fine but lands as form-filling
language ("register the mood"). More natural-feeling alternatives that
match the EN/IT softness: `Registra tu ánimo` or `¿Cómo te sientes hoy?`
(as title, dropping the body) or `Tu chequeo de ánimo`. Same observation
applies to PL `Zapisz nastrój` (literally "save mood").

### M3 — Title + body together are tautological
All six locales pair title="Log/Record your mood" + body="How are you
feeling today?". On the iOS lock-screen these stack vertically with the
body in lighter weight directly under the title, and the two-line read
becomes *"Log your mood — How are you feeling today?"* — the body answers
its own title. A better split: keep the question as the title (it's the
verb), use the body for the *why* (e.g. `Trag deine Stimmung ein, es
dauert nur 5 Sekunden.` / `Takes 5 seconds.`). Today the body is
load-bearing zero.

---

## Low

### L1 — `mutableContent = true` enabled before NSE exists
**File.** `src/lib/notifications/senders/apns.ts:407`
The comment is honest that no NSE ships today. UX impact: zero. But
shipping the flag now means any later NSE bug (image-download failure,
decryption stall) will block notification delivery for v0.5.4 users
*after* the iOS team adds an NSE in v0.5.5, with no server-side opt-out
path. Recommend a feature-flag gate so the flag can be turned off without
a backend redeploy.

### L2 — No `threadId` thinking for MOOD_REMINDER
**File.** `src/lib/notifications/senders/apns.ts:395`
`threadId: payload.eventType` groups all mood reminders under one thread —
on iOS Notification Center this is correct (don't pile up 30 identical
"How are you feeling today?" rows). Confirm with iOS team that the same
identifier is treated as a thread for grouping; if not, today's behaviour
is fine but worth a one-line comment on the sender that the grouping is
intentional for MOOD_REMINDER specifically.

---

## Per-locale roll-up

| Locale | Title | Body | Verdict |
| --- | --- | --- | --- |
| **DE** | `Stimmung erfassen` | `Wie geht es dir heute?` | Body strong; title robotic (H2). |
| **EN** | `Log your mood` | `How are you feeling today?` | Adequate; tautological pair (M3). |
| **ES** | `Registrar el ánimo` | `¿Cómo te sientes hoy?` | Title jargon-y (M2); body strong. |
| **FR** | `Enregistrer votre humeur` | `Comment vous sentez-vous aujourdhui ?` | **Critical typo C1**, register break (M1). |
| **IT** | `Registra il tuo umore` | `Come ti senti oggi?` | Cleanest pair of the six. |
| **PL** | `Zapisz nastrój` | `Jak się dzisiaj czujesz?` | Title slightly imperative (M2); body strong. |

---

## Settings-surface flag

**MISSING** — the new `User.moodReminderEnabled` field has **no UI
control anywhere in the app**. PR #190 must not be considered
user-complete until either
1. a Switch lands in `src/components/settings/notifications-section.tsx`
   bound to a PATCH endpoint, **or**
2. the cron registration in `reminder-worker.ts` is gated behind a
   build-time `ENABLE_MOOD_REMINDER` flag and the release notes mark the
   feature as "iOS-team-only preview".

Without one of those, the merged code silently expands the schema and
worker plumbing but ships zero observable behaviour to end users.

---

## Cross-reference: existing notification copy patterns

`medicationReminders` (de.json:2976-2989) uses:
- title pattern: `🟢 Erinnerung: {medName}` — emoji + status noun + colon
- body pattern: `<b>{medName}</b> (…)\n{detail}` — bolded subject + meta

`moodReminders` uses **no emoji**, **no status noun**, **no rich
formatting** — it stands out as a different surface. That's defensible
for APNs (rich HTML doesn't render on the lock-screen), but the emoji
absence is unexplained. A single matching emoji (🌤 / 💭 / 🫶) in the
title would unify the visual language at zero copy cost. Worth raising
with Marc as a design call, not a hard finding.
