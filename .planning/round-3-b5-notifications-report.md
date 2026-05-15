---
file: .planning/round-3-b5-notifications-report.md
purpose: B5 implementation report — Notifications hardening + locale-aware Telegram
created: 2026-05-15
target_release: v1.4.27
parent_plan: .planning/v1427-fix-plan.md (bucket B5)
---

# Bucket B5 — implementation report

Three atomic commits on `develop`, all green on typecheck + lint +
relevant tests (96 tests across 8 files). All commits pushed.

## Commits

1. `e060ab33` — `fix(integrations): silence the Withings scope-skip path from the 3-strike alert ladder`
2. `2c9d17c3` — `feat(notifications): add a translator-aware dispatch helper`
3. `3e930e68` — `feat(notifications): localise admin and user Telegram messages to the recipient locale`

## What landed

### F20 — false 3-strike admin alert

New `parkIntegrationAtReauth(opts)` helper in `src/lib/integrations/status.ts`:
- sets the row to `state=error_reauth`
- does NOT increment `consecutiveFailures` (preserves existing value)
- does NOT call `recordSyncFailure` (no `integrations.sync.failed` audit row)
- does NOT enter the threshold ladder (no admin Telegram page)
- writes one `integrations.reauth_required` audit row, idempotent on
  the encrypted message (re-parking same scope-skip writes no extra
  audit row)
- on a brand-new (user, integration) row, creates at counter=0 so a
  later genuine transient burst still has the full 3-strike runway

Call-site swaps:
- `src/lib/withings/sync-activity.ts` — scope-skip branch
  (lines 225-238) now uses `parkIntegrationAtReauth`. The defence-in-depth
  403 catch-block stays on `recordSyncFailure`.
- `src/lib/withings/sync-sleep.ts` — same swap (lines 172-185).
  BL-P3-2 parity verified — sleep mirrors activity exactly: silent park
  on deliberate scope-skip, loud `recordSyncFailure` on the catch
  block.

### F21 — locale-aware notifications

New `src/lib/notifications/dispatch-localised.ts` exposing
`dispatchLocalisedNotification`:
- resolves `User.locale` from Prisma (falls back to project default
  on null / unsupported value / DB throw — logs a wide-event warning
  on the throw path)
- calls `getServerTranslator(locale).t(titleKey, params)` and
  `.t(messageKey, params)`
- delegates to the base `dispatchNotification` with composed strings
- logs a wide-event warning when a translation key falls back to its
  own raw string (signals missing-bundle drift)
- accepts an optional `channel` selector and forwards it as
  `metadata.preferredChannel` — forward-compat scaffolding for a
  future per-channel routing pass

The base `dispatchNotification` was NOT touched; legacy callers
(reminder-phases, etc.) continue to work unchanged.

### Call-site swap list (commit 3)

| Surface | File | Strategy |
|---|---|---|
| Deploy-webhook admin alert | `src/app/api/internal/deploy-webhook/route.ts` | `dispatchLocalisedNotification` per admin |
| Admin "test notification" button | `src/app/api/admin/notifications/test/route.ts` | `getServerTranslator(adminLocale)` once at top; route still uses per-channel senders for UI feedback |
| User "test Telegram" button | `src/app/api/settings/telegram/test/route.ts` | `getServerTranslator(userLocale)` once at top; route still calls `sendTelegramMessage` directly for UI feedback |
| Admin reminder-check diagnostic | `src/app/api/admin/notifications/reminder-check/route.ts` | `dispatchLocalisedNotification` per row, resolving the **affected user's** locale (not the admin's) |

### Call-sites left alone (with rationale)

- `src/lib/jobs/reminder-worker.ts` — already localised via
  `getPhaseMessage(phase, name, dose, window, minutesLeft, user.locale)`
  (R1.4 audit, lines 126-130). Re-running through `dispatchLocalisedNotification`
  would double-translate.
- `src/lib/integrations/status.ts` — out of scope per the brief
  ("DO NOT touch `src/lib/integrations/status.ts` lines outside the
  new helper extraction"). The `formatAdminAlertPayload` admin-alert
  surface is left for a later symmetry-sweep (B7 / v1.4.28).

## Translation keys for B6 to add

All keys land under all six locale bundles
(`messages/{de,en,fr,es,it,pl}.json`):

### `notifications.admin.*`

| Key | Params | Notes |
|---|---|---|
| `deployFailedTitle` | `application` | Coolify deploy-webhook admin alert title |
| `deployFailedBody` | `application`, `error`, `deployment`, `logsUrl` | The body composes all four into a single template; locales may rearrange / omit lines for blank params (e.g. when `deployment` is `""`). Recommend a multi-line template with `{error}` / `{deployment}` lines that simply render empty when blank. |
| `testNotificationTitle` | — | Admin "test notification" button title |
| `testNotificationBody` | — | Admin "test notification" button body (was English-ish hardcoded HTML) |
| `reminderCheckMissedTitle` | `medication` | Admin reminder-check "missed" path title |
| `reminderCheckMissedBody` | `medication`, `dose`, `window` | Admin reminder-check "missed" path body |
| `reminderCheckOverdueTitle` | `medication` | Admin reminder-check "overdue" path title |
| `reminderCheckOverdueBody` | `medication`, `dose`, `window`, `minutes` | Admin reminder-check "overdue" path body |

### `notifications.user.*`

| Key | Params | Notes |
|---|---|---|
| `telegramTestBody` | — | Per-user "Test Telegram" button body |

(R1.4 audit also enumerates the `syncFailing*` admin keys; those are
intentionally NOT added in this round because the integrations/status.ts
formatter is out of scope per the brief.)

## Tests

Extended:
- `src/lib/integrations/__tests__/admin-alert.test.ts` — new
  `parkIntegrationAtReauth` block (3 cases): counter stays put, audit
  idempotency on re-park, fresh-row creation at counter=0.
- `src/lib/withings/__tests__/sync-activity.test.ts` — scope-skip
  assertions swapped to `parkIntegrationAtReauth`; 403 catch-block
  still asserts `recordSyncFailure` (defence-in-depth alert path).
- `src/lib/withings/__tests__/sync-sleep.test.ts` — same swap, BL-P3-2
  parity comment added.
- `src/app/api/internal/deploy-webhook/__tests__/route.test.ts` —
  swaps admin-alert assertion from `dispatchNotification` to
  `dispatchLocalisedNotification`, asserting per-admin translation
  keys and param shapes.

New:
- `src/lib/notifications/__tests__/admin-locale.test.ts` — 9 cases
  covering de / fr / null / unsupported / missing-row locale paths,
  missing-translation-key fallback, event-type pass-through, metadata
  + channel pass-through, and a Prisma-throws path that must not
  propagate.
- `src/app/api/settings/__tests__/telegram-test-locale.test.ts` — 7
  cases covering de / fr / null / unsupported locale paths plus
  rate-limit, missing-token, and send-failed error branches.

All 96 tests across 8 files green.

## Deviations from the brief

None on substance. Two minor implementation notes:

1. `dispatchLocalisedNotification` does NOT call `resolveServerLocale`
   (the cookie/Accept-Language cascade). The audit suggested it could,
   but the helper runs from background jobs and webhook handlers where
   the request context may not belong to the recipient — an admin
   alert resolves the admin's locale, not the request issuer's. The
   only authoritative source is the persisted `User.locale` column,
   and that is what the helper reads. Documented at the helper's
   docstring.

2. The deploy-webhook body template now composes the `Error: {error}`
   and `Deployment: {deployment}` lines from a single
   `notifications.admin.deployFailedBody` key with param substitution,
   instead of the old line-by-line null-filtered concatenation. The
   per-locale body strings should keep an empty-param-safe shape; B6
   should template the body so the surrounding text doesn't break when
   `error` or `deployment` is `""`. Recommended pattern:

   ```jsonc
   "deployFailedBody": "The Coolify deploy for {application} reported a failure.\nError: {error}\nDeployment: {deployment}\nLogs: {logsUrl}"
   ```

   The empty-string params will render as the prefix without any
   value — acceptable for an admin diagnostic message. If the team
   prefers fully-conditional lines, B6 can split into separate keys
   and have the call-site pick.

## Notes on workspace race conditions

During the implementation pass, the workspace was being mutated by
parallel agents in other buckets, which caused several `git commit`
operations to capture the wrong set of files. Each commit was
verified post-push via `git show <hash> --stat` and re-run when the
set was incorrect. Final state: three commits, each containing exactly
the files listed in this report — no foreign content slipped through.
