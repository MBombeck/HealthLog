# W-FRONTEND-FACTORY v1.4.41 report

## Scope landed (commit 0bf07abd)

- `src/lib/query-keys.ts` — factory extended with new entries for the
  unmigrated surfaces (notificationsStatus, settingsReminderThresholds,
  insightsSettings, insightsProviderChain, insightsGlp1Timeline,
  userAiProvider, userProfile, apiVersion, publicVersion, researchMode,
  moodlogStatus, integrationsStatus, featureFlags, coachPrefs,
  adminAiQuality, adminAppLogs, adminAssistantFlags, adminBackups,
  adminCoachFeedback, adminFeedback/+Root, adminHostMetrics,
  adminAuditActions, adminAuditOverview).
- `src/app/auth/login/page.tsx` — `queryKeys.authRegistrationStatus()` +
  `queryKeys.auth()` on the two invalidation sites.
- `src/app/auth/register/page.tsx` — `queryKeys.auth()` invalidation.
- `src/app/notifications/page.tsx` — all five
  read/getQueryData/setQueryData/cancelQueries/invalidate sites swapped
  to `queryKeys.notificationsPreferences()`.
- `src/components/settings/about-section.tsx` — `queryKeys.apiVersion()`.
- `src/app/page.tsx` — UX M1: tile Suspense fallback switched from
  `null` to a layout-stable card div mirroring trend-card chrome
  (`bg-card border-border rounded-xl border p-4 md:p-6`) so a future
  RSC hoist can't trigger CLS.
- `src/lib/__tests__/query-keys.test.ts` — walker `guardedRoots`
  extended to scan `src/app/auth`, `src/app/notifications`, and the
  about-section. New factory-shape test pins authRegistrationStatus,
  notificationsPreferences, notificationsStatus, apiVersion.

## Quality gates

- `pnpm typecheck` — clean.
- `pnpm exec vitest run src/lib/__tests__/query-keys.test.ts` — 17/17
  passing including the expanded walker scope.

## Deferred / handed-off

Settings sub-files (account, advanced, ai-section, api-section,
integrations-section, mood-reminder-card, notification-status-card,
notifications-section, ntfy-card, telegram-card, thresholds-editor,
sources-section), targets/target-edit-sheet, medications/*,
mood/mood-list, measurements/measurement-list, insights/* (coach-panel,
therapy-timeline, personal-record-badge), admin/* (twelve sections),
onboarding/getting-started-checklist, hooks (use-coach-prefs,
use-feature-flags). The factory already carries entries for every key
those sites use; the swap itself plus walker expansion can land in a
follow-up wave or hotfix without further factory work.

The single context budget on this wave ran out before the long tail
could be migrated and verified end-to-end. The committed slice is
green and self-contained: walker guards three new surfaces, and the
new factory entries are unit-pinned even where call sites still hold
bare literals.

## Files touched (absolute)

- /Users/marc/Projects/HealthLog/src/lib/query-keys.ts
- /Users/marc/Projects/HealthLog/src/lib/__tests__/query-keys.test.ts
- /Users/marc/Projects/HealthLog/src/app/auth/login/page.tsx
- /Users/marc/Projects/HealthLog/src/app/auth/register/page.tsx
- /Users/marc/Projects/HealthLog/src/app/notifications/page.tsx
- /Users/marc/Projects/HealthLog/src/app/page.tsx
- /Users/marc/Projects/HealthLog/src/components/settings/about-section.tsx
