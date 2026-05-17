# V0.5.4 — Product-Lead QA Findings (PR #190, v1.4.38.1)

**Scope:** `4049c6c7^..c4f2e0bc` on `main` — APNs category + MOOD_REMINDER
event + CHANGELOG v1.4.38.1.
**Reviewer lens:** Product-Lead (positioning, UX coherence, Marc-Voice,
PII gate, iOS / self-hoster split, v1.5 carry-forward).
**Verdict:** GO with **2 High-severity follow-ups** scheduled into v1.5
P1 (UI surface + locale parity). No Strategic-block.

---

## Severity scale

- **Strategic-block** — must not ship / must roll back.
- **High** — ship is OK; close inside the next release window (v1.5 P1).
- **Medium** — schedule for the next polishing slot; no urgency.
- **Low** — note, opportunistic fix.

---

## Findings

### 1. Positioning fit — Mood reminder vs. existing Coach / Insights / Briefing surfaces

**Severity:** Low (positioning is sound).

The MOOD_REMINDER feature is a **capture-prompt**, not an **insight**.
It nudges the user to enter raw data into the Stimmung tab so the
existing AI Coach + daily-briefing + correlations have inputs to chew
on. That's the *opposite* of duplication — without a daily capture
event the mood column on the correlations grid stays sparse, which
directly degrades the Coach's "evidence-grounded, multi-signal"
positioning (`feedback_ai_insights_differentiator.md`).

Overlap checked against the three adjacent surfaces:

| Surface | Trigger | Output | Overlap? |
|---|---|---|---|
| Daily briefing (`/insights`) | Request-time on page load | AI narrative | No — pulls *from* mood entries; doesn't request them |
| Med-reminder push | Per-schedule windows | Action buttons (Take / Snooze / Skip) | No — different event payload, different category |
| Compliance / anomaly pushes | Threshold-driven | Alert | No — reactive vs. the proactive 22:00 prompt |

The Coach + Insights are unchanged. This release ships a **capture
funnel**, not a new differentiator-class feature.

---

### 2. Daily 22:00 slot — conflict analysis

**Severity:** Low.

Existing scheduled windows reviewed in `reminder-worker.ts:118–193`:

| Slot (Europe/Berlin) | Job |
|---|---|
| every 15 min | `medication-reminder-check` (per-user schedule windows; user's own med times decide actual fires) |
| every 60 min | Withings sync |
| 02:00 / 02:05 / 02:10 / 02:15 / 02:20 / 02:25 | Insights status jobs |
| 03:00 (Sun) | Data backup |
| 03:00 / 03:15 / 03:45 / 04:00 | Cleanup + drain + feedback aggregator |
| **22:00 local-tz (user-individual)** | **NEW** MOOD_REMINDER |

22:00 is a clean choice:

- **No collision** with the medication-reminder cron — that one is
  schedule-driven (windows the user defined), not wall-clock-driven.
  A user with a med slot at 22:00 *and* mood opt-in receives two
  pushes that thread differently (`threadId = MEDICATION_REMINDER` vs.
  `threadId = MOOD_REMINDER`), so iOS groups them separately. No
  perceived noise.
- **No collision** with the daily briefing — briefing is request-time
  on `/insights` page-mount, not push-triggered.
- **Wind-down slot** is research-aligned (Apple Health, Withings, Oura
  all default mood / sleep prompts into the 21:00–22:30 window). The
  inline comment captures this rationale (`mood-reminder.ts:30–35`).

**One subtle item to flag for v1.5:** the 22:00 boundary is hard-coded
(`MOOD_REMINDER_LOCAL_HOUR = 22`). Some users will want 20:00 or
21:30. Add to v1.5 backlog as a Medium item (see §7).

---

### 3. Opt-in default — "user controls everything" check

**Severity:** none — fully respected.

The feature is **double-gated**:

- `EVENT_DEFAULT_ENABLED.MOOD_REMINDER = false` (per-event policy in
  `types.ts:51`).
- `User.mood_reminder_enabled = false` by default (migration
  `0069_v054_mood_reminder/migration.sql:16`).

Either gate suffices to block dispatch. A fresh user gets **zero**
mood pushes until they explicitly opt in. This matches the
`PERSONAL_RECORD` pattern set in v1.4.25 and respects the
"user-controls-everything" instinct without forcing an onboarding
roadblock.

The double-gate also means there is **no rollback risk**: if the
v1.5 UI ships broken, the worst case is "the toggle does nothing"
— the dispatcher stays silent.

---

### 4. Marc-Voice review of DE/EN copy (and the four sibling locales)

**Severity:** Low (DE/EN ship-ready; one weak FR string).

| Locale | Title | Body | Verdict |
|---|---|---|---|
| de | "Stimmung erfassen" | "Wie geht es dir heute?" | **Marc-Voice clean** — direct, du-form, no AI mention, reads as Marc's authorship |
| en | "Log your mood" | "How are you feeling today?" | **Marc-Voice clean** — imperative title, conversational body |
| es | "Registrar el ánimo" | "¿Cómo te sientes hoy?" | OK |
| fr | "Enregistrer votre humeur" | "Comment vous sentez-vous aujourdhui ?" | **Typo: `aujourdhui` missing apostrophe** — should be `aujourd'hui`. Low-severity copy bug, fix in next release |
| it | "Registra il tuo umore" | "Come ti senti oggi?" | OK |
| pl | "Zapisz nastrój" | "Jak się dzisiaj czujesz?" | OK |

No AI / Claude / agent / wave / phase language anywhere. No PII. No
jargon. All six locales pass the `feedback_marc_voice_english.md`
test.

**Low-severity fix-list:** correct French apostrophe (`aujourd'hui`)
in `messages/fr.json` line 2994.

---

### 5. CHANGELOG v1.4.38.1 entry

**Severity:** Medium (one user-facing-jargon nit).

Reviewed against `feedback_marc_voice_english.md` +
`feedback_no_pii_in_user_facing.md`:

- **PII:** clean. No personal name, no health figures, no medication
  references, no measurement counts.
- **Marc-Voice:** clean — reads as Marc's authorship, English, no
  AI/agent/phase/wave language.
- **User-readability:** generally good. Two technical-jargon
  spots that a self-hoster who hasn't read the schema diff won't
  parse:
  - `EVENT_DEFAULT_ENABLED` (line 27) — implementation symbol leaking
    into release notes. Reword to "default-off at the event-policy
    layer" or similar.
  - `aps.mutable-content = 1` (line 14) — operator-facing detail;
    fine to keep since the rest of the bullet is operator-scoped, but
    flag it.
- **Self-hoster context:** the "iOS v0.5.4 push-notification
  coordination" header tells self-hosters who don't run the iOS app
  that this release is iOS-coordination scaffolding. The
  Compatibility section adds the "older iOS builds render plain
  alert" sentence which closes the loop. **Sufficient — no action
  needed** for non-iOS self-hosters.

**Medium fix:** swap the one identifier-leak in §Added for a
plain-English phrasing in the next release notes (v1.5 entry).

---

### 6. iOS v0.5.4 dependency boundary

**Severity:** Medium (documentation gap for self-hosters running
the server *without* the iOS app).

What self-hosters need to know:

- **Server-only operators:** the migration runs and the cron entry
  registers, but with no APNs config + no iOS devices paired, every
  cron tick is a no-op and the new event surface stays silent. **Zero
  behavioural change.** ✅ Captured in CHANGELOG "Compatibility" +
  the `loadApnsConfig` all-or-none guard already shipped in v1.4.23.
- **Mixed operators (server + iOS):** need the iOS app to register
  `UNNotificationCategory` identifiers `MEDICATION_REMINDER` and
  `MOOD_REMINDER` at launch. Without that, iOS renders plain alerts.
  Captured in PR report (`V054-server-apns-mood-report.md:104–108`)
  but **not** in CHANGELOG.
- **The `scheduledAt` ISO field** on med-reminder metadata is now
  always emitted. Older iOS builds that don't read the field ignore
  it. **No documentation needed** (additive metadata is the existing
  iOS-coord contract).

**Medium fix for v1.5 release notes:** add a one-liner that calls
out the iOS app must register the new category identifier to
surface the mood reminder as actionable. Self-hosters running
HealthLog headless (no iOS, only web) get no change and need no
action — that's the safe default but worth saying explicitly once.

---

### 7. Strategic gap — v1.5 carry-forward

**Severity:** **High** — must land in v1.5 P1, otherwise the feature
is invisible to end users.

The server side ships **fully wired**, but there is **no UI to flip
`User.mood_reminder_enabled`**. Confirmed by grep:

- `moodReminderEnabled` appears only in: `prisma/schema.prisma`, the
  worker handler, the test suite, and the auto-generated Prisma
  client. **Zero references in `src/app/**` (no Settings page, no
  API write route, no iOS HTTP endpoint).**
- The existing notifications-preferences API
  (`src/app/api/notifications/preferences/route.ts`) covers the
  per-channel × per-event matrix only — it doesn't surface a
  per-user boolean flag like `moodReminderEnabled`. This is the
  same gap the PR report calls out at line 109–114.
- The `/notifications` page renders the per-channel matrix from
  `EVENT_TYPES`, so MOOD_REMINDER will appear there as an event
  row — but ticking it on a channel won't help: the worker also
  requires `User.moodReminderEnabled = true`. Two-toggle confusion
  is the predictable end-user failure mode.

**v1.5 carry-forward (must-have for the iOS sprint):**

1. **iOS-side:** Settings → Notifications toggle for "Daily mood
   reminder" that PATCHes a new endpoint
   (`PATCH /api/me/preferences` or extend
   `/api/notifications/preferences` with a per-user-flag branch).
2. **Web parity:** mirror the same toggle on
   `/settings/notifications` so non-iOS self-hosters can opt their
   Telegram / ntfy / Web-Push channels into the daily nudge. The
   server is channel-agnostic — withholding the toggle from web
   would be a regression vs. the dispatcher's actual capability.
3. **Translation key parity:** add
   `notifications.eventMoodReminder` label key in all six locales
   so the `/notifications` matrix row has a human-readable label
   (the function at `src/app/notifications/page.tsx:73` will derive
   `notifications.eventMoodReminder` and fall through to the raw
   key if missing — currently missing for MOOD_REMINDER in *all
   six* `messages/*.json` files).
4. **Configurable hour:** lift `MOOD_REMINDER_LOCAL_HOUR = 22` to
   a per-user preference (default 22) so users in shift-work or
   different cultural wind-down rhythms can move the slot.
   Medium-priority — server-side default is already opinionated;
   v1.5 P2 is fine.

---

## Missing-for-next-release list

Listed in priority order for the v1.5 P1 iOS sprint:

1. **[High] iOS Settings toggle** for `moodReminderEnabled` + the
   matching server PATCH route. Without this the feature is dead
   code for end users.
2. **[High] Web Settings parity toggle** at
   `/settings/notifications` so self-hosters without an iPhone can
   opt their existing channels into the daily nudge. Same PATCH
   route as #1.
3. **[High] Translation key** `notifications.eventMoodReminder` in
   all six `messages/*.json` so the matrix row on
   `/notifications` shows a label rather than the camel-cased key.
4. **[Medium] Configurable reminder hour** — lift `22` to a
   per-user preference.
5. **[Medium] French typo** `aujourdhui` → `aujourd'hui` in
   `messages/fr.json:2994`.
6. **[Medium] CHANGELOG language clean-up** — drop the
   `EVENT_DEFAULT_ENABLED` identifier leak from future entries that
   touch the same surface.
7. **[Low] Operator note in v1.5 release notes** explicitly calling
   out that headless self-hosters (web-only, no iOS app) need no
   action — the feature is silent without paired devices.

---

## Sign-off

**Verdict:** GO. The release is strategically coherent (capture
funnel that feeds the existing differentiator), respects the opt-in
default pattern, ships Marc-Voice-clean copy, leaks no PII, and
documents the iOS dependency adequately in the PR report (with a
small CHANGELOG gap noted in §6).

**Conditions:**

- The four items marked **[High]** above MUST land in v1.5 P1.
  Until then the user-visible footprint of v1.4.38.1 is zero on the
  iOS side and exactly one un-labelled row in the web matrix that
  doesn't actually flip the dispatcher.
- The migration is additive + idempotent — rollback path is "leave
  the column at default false; the cron remains a no-op". No
  rollback risk.
