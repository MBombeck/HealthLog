---
file: .planning/research/v1427-r1-notifications.md
purpose: R1.4 audit — false Withings 3-strike Telegram alert (finding 20) + English-only Telegram copy that ignores User.locale (finding 21)
created: 2026-05-14
target_release: v1.4.27
predecessor_context: v1.4.26 commit fec02aa5 (Withings 403 scope-skip)
scope: read-only
---

# R1.4 — Notifications and Withings classification audit

Two regressions reported on a freshly-deployed v1.4.26 install:

- **Finding 20** — the 3-strike admin Telegram alert ("Withings sync failing for …") still fires for an account where the manual "Synchronisieren" button on `/settings/integrations` returns a non-zero import count. The error-classification path is paging on a benign code path.
- **Finding 21** — every Telegram message the dispatcher emits is English regardless of `User.locale`. Reminder-phase messages localised correctly until v1.4.x; the recently-added paths bypass the translator entirely.

This document traces both chains end-to-end against the v1.4.26 source tree and proposes per-finding fixes for the v1.4.27 implementation round.

---

## Finding 20 — false "Withings error" Telegram alert

### Where the alert is composed

`src/lib/integrations/status.ts` owns the persistent-failure ladder:

- `recordSyncFailure({ kind, … })` (lines 191-271) increments `IntegrationStatus.consecutiveFailures`, writes one `AuditLog` row, then calls `maybeAlertAdmins(…)` if the post-increment count crosses `getPersistentFailureThreshold()` (default 3, env-overridable via `INTEGRATION_FAILURE_ALERT_THRESHOLD`).
- `maybeAlertAdmins` (lines 452-484) resolves every `User.role === "ADMIN"` and calls `dispatchNotification({ eventType: "SYSTEM_ALERT", … })` per admin with the `formatAdminAlertPayload(…)` output (pure English, lines 406-438).
- The re-alert window (`ALERT_REPEAT_WINDOW_MS = 24h`) prevents a second page within 24h **while `alertedAt` is set on the row**. `recordSyncSuccess` clears `alertedAt = null` and `consecutiveFailures = 0`.

### Where the counter is incremented

The counter is keyed `(userId, integration)` where `integration === "withings"` — a **single row** shared by three cron paths and the webhook handler:

| Caller | File | Cron / trigger | Increments counter on |
|---|---|---|---|
| `syncUserMeasurements` (legacy measure) | `src/lib/withings/sync.ts` | `WITHINGS_SYNC_CRON = "0 * * * *"` + webhook `appli=1,2,4` | refresh-token failure, fetch failure |
| `syncUserActivity` (v1.4.25 W17b) | `src/lib/withings/sync-activity.ts` | `WITHINGS_ACTIVITY_CRON = "0 * * * *"` + webhook `appli=16` | scope-skip (v1.4.26 added), fetch failure, 403 catch (v1.4.26 added) |
| `syncUserSleep` (v1.4.25 W17c) | `src/lib/withings/sync-sleep.ts` | `WITHINGS_SLEEP_CRON = "15 * * * *"` + webhook `appli=44` | scope-skip (v1.4.26 added), fetch failure, 403 catch (v1.4.26 added) |

All three routines call the **same** `recordSyncFailure(…, { integration: "withings" })`. Success only flows from the routine that actually succeeded. The cross-routine shape is the root cause.

### Failure-mode reconstructions

The maintainer's report (manual sync succeeds, Telegram still pages) is reproducible from at least three independent paths. The first is the dominant one for a fresh v1.4.26 install:

#### Path A — scope-skip increments the counter even though it's a deliberate no-op

`syncUserActivity` (sync-activity.ts:225-238) and `syncUserSleep` (sync-sleep.ts:172-185) added in v1.4.26 short-circuit when the persisted `WithingsConnection.scope` lacks `user.activity`. Per the commit message that path is supposed to be the silent "park at reauth and stop hammering" branch, BUT the implementation calls:

```ts
await recordSyncFailure({
  userId,
  integration: "withings",
  kind: "reauth_required",
  message: "Withings connection is missing the user.activity scope…",
  errorCode: "scope_missing",
});
```

`recordSyncFailure` unconditionally:
1. `consecutiveFailures += 1`
2. writes one `AuditLog` row
3. checks `consecutiveFailures >= threshold` → fires the admin alert if no `alertedAt` in the last 24h.

So a single legacy-scope connection produces:
- :00 measure-cron — `syncUserMeasurements` succeeds → `recordSyncSuccess` → counter = 0, `alertedAt = null`.
- :00 activity-cron (same minute) — scope-skip → `recordSyncFailure({kind:"reauth_required"})` → counter = 1, state = `error_reauth`.
- :15 sleep-cron — `isReauthRequired(userId, "withings")` returns `true` at the top of `syncUserSleep` (sync-sleep.ts:161-167) → short-circuit BEFORE the scope-skip, return 0. Counter stays at 1.
- :00 next hour — measure-sync hits `isReauthRequired` (sync.ts:156-161) → returns 0 → **no `recordSyncSuccess` call** → counter stays at 1.
- :00 next hour activity-sync hits `isReauthRequired` → returns 0 → counter still at 1.

So by itself path A only gets to 1. It can never reach 3.

#### Path B — webhook deliveries land in the activity / sleep queues before the cron measure tick

`src/lib/withings/webhook-handler.ts:184-198` enqueues per-user jobs for `appli=16` (activity) and `appli=44` (sleep) the moment Withings POSTs a webhook. For a legacy-scope user every appli-16 / appli-44 delivery fires `recordSyncFailure({kind:"reauth_required"})` — and Withings can deliver several per hour. Three webhook deliveries before the next measure-cron success → counter hits 3 → admin alert.

Webhook deliveries don't go through the `isReauthRequired` short-circuit because the activity / sleep routines check it inline (sync-activity.ts:196-201, sync-sleep.ts:161-167), so once the state lands at `error_reauth` subsequent calls correctly no-op without incrementing. But **the FIRST scope-skip on a freshly-deployed v1.4.26** can land in any order — three quick webhook deliveries before the first measure-cron success can run the counter from 0 → 3 within seconds.

#### Path C — the previous `error_transient` streak isn't cleared until measure succeeds

Pre-v1.4.26, every `getactivity` / `getsleep` call on a legacy-scope connection raised a 403 that the catch-block in sync-activity.ts:233-241 / sync-sleep.ts:185-193 classified as `kind: "transient"`. pg-boss retries kicked in (configured retry policy on the queues), and the counter blew past 3 quickly. That state survived the v1.4.26 deploy: `IntegrationStatus.consecutiveFailures` is anchored in Postgres, `alertedAt` is anchored in Postgres. After the deploy:

- the scope-skip path correctly no-ops the upstream call, but
- the **first** scope-skip after deploy hits `recordSyncFailure` with `kind: "reauth_required"` → counter = (previous value + 1, e.g. 87 + 1 = 88) → page fires immediately (24h has elapsed since the last `alertedAt` stamp).

Path C reproduces the report verbatim: the maintainer hits "Synchronisieren" → measure-route succeeds → counter resets to 0 → activity-cron fires → scope-skip → counter = 1, alertedAt set. Then maintainer believes it's quiet. Twelve hours later the per-user webhook fires → counter = 2. Twenty-four hours after `alertedAt` was stamped → window closes. Two more scope-skips → counter = 3 → page fires again.

### Why the v1.4.26 defence-in-depth makes path B worse

The v1.4.26 catch-block tweak (sync-activity.ts:267-269) classifies a 403 reaching the catch as `reauth_required` instead of `transient`. This **does** stop pg-boss retries (good — fewer hits) but it also means the alert ladder now treats every 403 the same as a deliberate scope-skip: one upstream call = one counter increment with `kind: "reauth_required"`. The threshold is still 3, the alert still pages.

### Root cause

**Calling `recordSyncFailure(…)` from a deliberate scope-skip short-circuit is wrong.** The scope-skip path is the v1.4.26 design for "do not hit upstream because we already know the user has to reconnect"; it should set the connection state to `error_reauth` **without** incrementing the failure counter or writing an audit row. The 3-strike ladder exists for unexpected transient bursts (5xx, network blips, upstream outages) — a known scope gap is not a burst. The counter is per-integration (not per-route), so any single route's "deliberate park" silently steals counter slots from the other two routes' future genuine bursts.

Additionally, the counter has no per-route attribution: a `getmeas` success cannot clear a `getactivity` scope-skip streak because the success path resets the row state to `connected` and `consecutiveFailures` to 0 — which is exactly what we want when measure runs first, but when activity/sleep run first (webhook-driven), measure-cron then short-circuits on `isReauthRequired` without ever calling `recordSyncSuccess`. The connection sits parked indefinitely.

### Proposed fix (v1.4.27)

Three layers — apply all three:

1. **Introduce a silent reauth-park helper.** Extract the "set state to `error_reauth`, do not increment, do not audit-log, do not alert" path into a new helper next to `markReauthRequired` (lines 279-304 of `integrations/status.ts`) — call it `parkIntegrationAtReauth(userId, integration, message, errorCode)`. The existing `markReauthRequired` already does most of this but it writes an audit row (`integrations.reauth_required`) which is fine; the key is the counter does NOT increment, the threshold check does NOT run, the alert does NOT fire. Swap the two scope-skip call-sites (sync-activity.ts:229-236, sync-sleep.ts:175-184) to call the new helper. The defence-in-depth 403 catch-block remains on `recordSyncFailure` because a 403 reaching the catch IS unexpected once the scope-skip lands.

2. **Per-route counter attribution.** Add a fourth column `IntegrationStatus.subPath String?` (nullable, "measure" | "activity" | "sleep" | null) and key the unique index on `(userId, integration, subPath)` instead of `(userId, integration)`. Each routine increments / resets its own slot. The Settings UI aggregates by integration (max state across slots). Trade-off: one migration, three call-site touches, more accurate failure semantics. Defer-acceptable to v1.4.28 if migration window is tight — layer 1 alone fixes the maintainer's report.

3. **Idempotent re-alert window guard.** Today `previouslyAlerted` is checked AFTER the counter increments, which is correct. But `recordSyncSuccess` resets `alertedAt = null` — so a flapping integration that succeeds once a day then fails three times the same day re-pages every day. Replace the 24h fixed window with "do not page again until the user has been reconnected (`markReconnected` runs) OR `INTEGRATION_FAILURE_ALERT_REPEAT_HOURS` has elapsed AND the state has bounced through `connected` at least once". The repeat-hours env default stays 24h.

### Test plan

- New unit test in `src/lib/integrations/__tests__/admin-alert.test.ts` covering: scope-skip path calls `parkIntegrationAtReauth`, NOT `recordSyncFailure`. Asserts `consecutiveFailures` stays at 0 and `dispatchNotification` is not invoked.
- New unit test asserting: pre-existing `consecutiveFailures = 87` row survives the deploy, first scope-skip call no longer pages (because new helper does not enter the threshold ladder).
- Regression test: a real transient burst (3 × `recordSyncFailure({kind:"transient"})`) still trips the alert ladder.
- Regression test: a `recordSyncSuccess` between two transient failures still resets the counter.

---

## Finding 21 — Telegram copy is English regardless of `User.locale`

### Where the locale plumbing already works

`src/lib/i18n/server-translator.ts` defines `getServerTranslator(locale)` returning `{ locale, t(key, params) }`. The `resolveServerLocale(…)` helper (`src/lib/i18n/server-locale.ts`) cascades override → cookie → `User.locale` → Accept-Language → `defaultLocale ("en")`. Six locale bundles ship at `messages/{de,en,fr,es,it,pl}.json`.

Several call-sites already use this for Telegram output:
- `src/lib/jobs/reminder-phases.ts:142, 199` — `getPhaseMessage(phase, name, dose, window, minutesLeft, user.locale)` translates medication-reminder bodies before passing them to `dispatchNotification(…)`.
- `src/app/api/telegram/webhook/route.ts:128, 182, 424` — `resolveBotLocale(user.locale)` for every command reply.
- `src/lib/auth/password.ts:36` — password-reset emails.
- `src/app/api/doctor-report/pdf/route.ts:84` — PDF labels.
- `src/app/api/dashboard/summary/route.ts:348-349` — dashboard summary text.

### Where the regression lives

The dispatcher (`src/lib/notifications/dispatcher.ts:39-212`) accepts a `NotificationPayload` with `title: string` and `message: string` that are already-composed strings. The Telegram sender (`src/lib/notifications/senders/telegram.ts:62-166`) does no translation step — it forwards `payload.message` verbatim. Same for ntfy, web-push, APNs. The dispatcher is locale-agnostic by design — the contract is "the caller composes the localised body".

Three call-sites compose bodies in **English** without consulting `User.locale`:

1. `src/lib/integrations/status.ts:406-438` — `formatAdminAlertPayload` (the 3-strike admin alert from finding 20). Pure English template:
   - `"{integration} sync failing for {subject}"`
   - `"{integration} sync has failed {n} times in a row for {subject}."`
   - `"Last error: {reason}{code} — {trimmed}"`
   - `"Action: {ask the user to reconnect | investigate the upstream service}"`

2. `src/app/api/internal/deploy-webhook/route.ts:122-130` — Coolify deploy-webhook admin notification. Pure English:
   - `"Deploy failed: {applicationName}"`
   - `"The Coolify deploy for {applicationName} reported a failure."`
   - `"Error: {err}"`, `"Deployment: {uuid}"`, `"Logs: https://apps-01.bombeck.io"`.

3. `src/app/api/admin/notifications/test/route.ts:90-93` — admin "test notification" button. Pure English:
   - `"Test-Notification"` (title is German-ish, body is English)
   - `"<b>HealthLog Test:</b> If you see this message, your notifications are working!"`

4. `src/app/api/settings/telegram/test/route.ts:30-34` — Settings "test Telegram" button (per-user, not admin). Pure English:
   - `"HealthLog: Connection successful! Telegram notifications are active."`

5. `src/app/api/admin/notifications/reminder-check/route.ts:142-156` — admin reminder-check diagnostic. Pure German hardcoded:
   - `"Verpasst: {name}"`, `"Erinnerung: {name}"`, etc. Wrong for an EN-locale admin.

### Root cause

The "regression" framing in the brief understates the scope — these admin-facing strings were composed in English at introduction and never went through the translator. Marc-Voice English everywhere outside the user-facing surface is the project convention, BUT a user-facing surface like Telegram (where `User.locale` defines the recipient's language preference) qualifies as user-facing. Per-user surfaces 4 and 5 should localise to `User.locale`. Admin-facing surfaces 1, 2, 3 should localise to **the admin recipient's** `User.locale`, not the affected user's locale.

### Proposed fix (v1.4.27)

Two layers:

1. **Translator-aware dispatch helper.** Add a new helper next to `dispatchNotification` — `dispatchLocalisedNotification({ userId, eventType, titleKey, messageKey, params, metadata })` that:
   - reads `User.locale` for the resolved user inside the helper,
   - calls `resolveServerLocale({ userLocale })` to honour the priority cascade,
   - calls `getServerTranslator(locale).t(titleKey, params)` and `.t(messageKey, params)`,
   - then delegates to `dispatchNotification(…)` with the resolved strings.
   - The existing `dispatchNotification` stays untouched so legacy callers and already-localised callers (reminder-phases) don't churn.

2. **Add translation keys for every offending surface and swap call-sites.** New keys under `notifications.admin.*` and `notifications.user.*` in all six `messages/{locale}.json` bundles:

   ```jsonc
   "notifications": {
     "admin": {
       "syncFailingTitle": "{integration} sync failing for {subject}",
       "syncFailingBody": "{integration} sync has failed {count} times in a row for {subject}.\nLast error: {reasonLabel}{codeLabel} — {trimmed}\nAction: {action}",
       "syncFailingActionReauth": "ask the user to reconnect the integration.",
       "syncFailingActionInvestigate": "investigate the upstream service.",
       "syncFailingReauthLabel": "re-auth required",
       "syncFailingTransientLabel": "transient error",
       "deployFailedTitle": "Deploy failed: {application}",
       "deployFailedBody": "The Coolify deploy for {application} reported a failure.",
       "testNotificationTitle": "Test notification",
       "testNotificationBody": "<b>HealthLog test:</b> if you see this message, your notifications are working.",
       "reminderCheckMissedTitle": "Missed: {medication}",
       "reminderCheckMissedBody": "<b>{medication}</b> ({dose}, {window}) was flagged as missed.",
       "reminderCheckOverdueTitle": "Reminder: {medication}",
       "reminderCheckOverdueBody": "Reminder: <b>{medication}</b> ({dose}, {window}) hasn't been recorded yet. {minutes} min overdue."
     },
     "user": {
       "telegramTestBody": "HealthLog: connection successful. Telegram notifications are active."
     }
   }
   ```

   Each offending call-site:
   - `integrations/status.ts:406-438` — replace `formatAdminAlertPayload` template literals with `t("notifications.admin.syncFailing*", …)`. The function takes a new `t: ServerTranslator["t"]` argument so its unit tests can keep asserting byte-identical output without standing up Prisma. `maybeAlertAdmins` resolves each admin recipient's locale before composing, so each admin sees the alert in their own language.
   - `internal/deploy-webhook/route.ts:122-130` — same pattern, per-admin locale resolution.
   - `admin/notifications/test/route.ts:90-93` — `getServerTranslator(adminLocale)` once at the top.
   - `settings/telegram/test/route.ts:30-34` — `getServerTranslator(userLocale)` once at the top.
   - `admin/notifications/reminder-check/route.ts:142-156` — `getServerTranslator(med.user.locale)` (recipient = the user whose dose is overdue).

3. **Locale source priority for admin alerts.** Cross-user admin alerts (finding 20) compose one body per admin. Each admin's locale resolves independently from `admin.locale`. The affected user's email + locale are part of the metadata, not the recipient. This is consistent with finding 20's per-recipient model and explicit in the helper signature.

### Test plan

- New unit test in `src/lib/integrations/__tests__/admin-alert.test.ts` covering `formatAdminAlertPayload(input, tDe)` vs `formatAdminAlertPayload(input, tEn)` — assert title and body change accordingly.
- Snapshot tests for each of the six locales of the `notifications.admin.*` keys (catches mistakenly-skipped translation bundles).
- Regression test: existing reminder-phases.ts call-sites still produce identical output for `locale = "de"`.
- E2E (Playwright) for finding 21: change a user's `User.locale` to `fr`, fire `/api/settings/telegram/test`, assert the Telegram send payload contains the French string.

---

## Cross-finding observations

Both findings boil down to **dispatcher inputs**, not the dispatcher itself. The dispatcher is correctly locale-agnostic (it just forwards). The fix-surface for finding 21 is the set of callers that compose the body. The fix-surface for finding 20 is the set of callers that decide whether to invoke `recordSyncFailure` vs a silent park. Both fixes are touch-disjoint from the dispatcher — they should land in separate commits to keep blast radius small.

### Suggested fix-surface buckets for Round 2

- **N1: silent reauth park** — `integrations/status.ts` (new helper `parkIntegrationAtReauth`), `withings/sync-activity.ts` (scope-skip call-site swap), `withings/sync-sleep.ts` (scope-skip call-site swap). Tests in `integrations/__tests__/admin-alert.test.ts` and the two withings sync-*.test.ts files. Closes finding 20.
- **N2: localised admin alerts** — `integrations/status.ts` (`formatAdminAlertPayload` accepts `t`), `internal/deploy-webhook/route.ts`, `admin/notifications/test/route.ts`, `admin/notifications/reminder-check/route.ts`. Tests in `integrations/__tests__/admin-alert.test.ts`, new `notifications/__tests__/admin-locale.test.ts`. Closes finding 21 admin surface.
- **N3: localised per-user Telegram** — `settings/telegram/test/route.ts`, future per-user Telegram call-sites. Tests in a new `settings/__tests__/telegram-test-locale.test.ts`. Closes finding 21 user surface.
- **N4: per-route counter attribution (optional, defer-acceptable to v1.4.28)** — Prisma migration + `IntegrationStatus.subPath` + Settings UI aggregation. Defer if migration window is tight; N1 alone fixes the maintainer's report.

### Out of scope for this audit

- Web-push / APNs / ntfy senders also forward `payload.message` verbatim. Once the dispatch-helper from finding 21 lands the fix automatically covers all four channels. No sender-specific work.
- The `WITHINGS_SYNC_FAILED` event type (`notifications/types.ts:14`) is currently emitted by the per-user Settings UI flow, not by the cron path. Out of scope unless we wire it into the cron, which we should NOT — `SYSTEM_ALERT` is the right event type for admin pages.

---

## Conventions adhered to in this document

- Marc-Voice English throughout.
- No project-meta vocabulary ("AI", "Claude", "agent", "marathon", "wave", "phase", "session", "subagent").
- No personal data (no maintainer name, no health figures, no target-range values).
- Read-only audit — no source changes proposed inline; every proposal lands in Round 3 implementation buckets.
