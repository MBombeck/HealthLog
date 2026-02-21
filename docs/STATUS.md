# Project Status

Last updated: 2026-02-21

## Completed Milestones

All core milestones are complete:

| Milestone | Scope                                                                                      | Status |
| --------- | ------------------------------------------------------------------------------------------ | ------ |
| M0        | Skeleton, Prisma, Docker, Dracula theme, docs                                              | Done   |
| M1        | Auth (passkeys + password fallback, sessions, profile)                                     | Done   |
| M2        | Measurements CRUD with pagination/filtering                                                | Done   |
| M3        | Charts (Recharts) + analytics (trends, anomalies, moving averages)                         | Done   |
| M4        | Medications (CRUD, intake, compliance, external ingest API, pg-boss reminders, API tokens) | Done   |
| M5        | Withings OAuth (connect/disconnect, webhook, sync, encrypted tokens)                       | Done   |
| M6        | Export (CSV/JSON), rate limiting, audit log viewer, security hardening                     | Done   |

## Completed Post-Milestone Work

| Task                               | Description                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| i18n system                        | Custom context-based i18n with `useTranslations()` hook. All pages converted. `messages/de.json` + `messages/en.json`.                                                                                                    |
| Notification DB + dispatcher       | `NotificationChannel`, `NotificationPreference`, `PushSubscription` models. Dispatcher at `src/lib/notifications/dispatcher.ts`. Telegram + ntfy senders.                                                                 |
| Notification preferences page      | `/notifications` page with matrix grid (event types x channels). API at `/api/notifications/preferences`.                                                                                                                 |
| ntfy channel                       | Settings UI section + API for ntfy push notifications. Test endpoint.                                                                                                                                                     |
| Admin panel                        | User table, service toggles, API overview, deploy timestamp.                                                                                                                                                              |
| Sidebar redesign                   | User section at bottom, three-dot menu, right-opening dropdown, settings mode with scroll-to + highlight.                                                                                                                 |
| Measurements polish                | Sortable columns, table header alignment, pagination, delete confirm.                                                                                                                                                     |
| Medications polish                 | Three-dot menu for secondary actions, dose split into number + unit, scheduling with specific days, active toggle, delete confirms, more medication types.                                                                |
| Medication recurrence UX           | Time windows now default to simple daily mode; per-window `...` menu reveals advanced recurrence (weekdays + every 1/2/3/4 weeks) with compact recurrence summary.                                                        |
| Per-medication notification toggle | Each medication can now mute reminder notifications individually via edit menu (`Benachrichtigungen deaktivieren/aktivieren`), with paused-state tag (`Pausiert seit …`).                                                 |
| Charts polish                      | Year in date labels when span > 365d, compliance chart equal width, time ranges, BP legend/target row.                                                                                                                    |
| Insights/Zielwerte                 | Links, labels, BMI metric, scaling, tooltips, compressed recommendations, more target value metrics.                                                                                                                      |
| Pulse target personalization       | Resting pulse targets now profile-based (age/gender) using CDC/NCHS NHANES 1999-2008 percentile references, with AHA fallback when profile context is missing.                                                            |
| Insights correlations              | Dracula-themed scatter charts with proper axis/tick/dot colors.                                                                                                                                                           |
| Security audit                     | Encryption review, data leak check, auth hardening.                                                                                                                                                                       |
| Code quality review                | Dead code cleanup, legacy removal.                                                                                                                                                                                        |
| Bug report                         | `/bugreport` page creates GitHub issues with optional screenshot.                                                                                                                                                         |
| Bugreport admin config             | GitHub issue token/repository can now be configured in Admin settings (`/admin`) and are stored in `app_settings` (token encrypted). Bugreport API still supports env fallback for existing deployments.                  |
| Password visibility                | Eye icon toggle on password/token fields.                                                                                                                                                                                 |
| Settings text visibility           | Neutralized muted text color globally (less blue tint) for better readability while keeping Dracula aesthetics.                                                                                                           |
| Medication card UI                 | Fixed dialog three-dot menu overlapping close X (`pr-8`), unified form field heights to `h-9`.                                                                                                                            |
| Collapsible sidebar                | Sidebar collapses to icons-only (`w-16`), localStorage-persisted, tooltips on hover, works in settings mode. Toggle moved to subtle icon in top corner.                                                                   |
| Reminder worker refactor           | Replaced direct Telegram sending with `dispatchNotification()`. Now uses all channels (Telegram, ntfy, Web Push) and respects user preferences.                                                                           |
| Web Push channel                   | Service worker (`public/sw.js`), VAPID API (`/api/notifications/vapid`), subscription API (`/api/notifications/web-push`), settings UI section in settings page.                                                          |
| Sidebar three-dot fix              | Restored MoreVertical three-dot menu to right side of user section (was misplaced during collapsible sidebar rewrite).                                                                                                    |
| Gravatar avatar                    | Server-side SHA-256 hash of email (`src/lib/gravatar.ts`), included in `/api/auth/me` response. Sidebar uses `AvatarImage` with fallback to initials.                                                                     |
| Gamification v1                    | Dynamic achievement system with streak/compliance metrics, API (`/api/gamification/achievements`), UI page (`/achievements`), sidebar + mobile nav integration.                                                           |
| Gamification v2                    | 30 achievements across intake, on-time windows, rolling 30-day compliance, BMI/BP/pulse green streaks; evaluation starts at feature rollout and excludes imports.                                                         |
| Gamification v2.1                  | Added auth/engagement achievements (Passkey created/login, password login "Oldschool", login streak 7/30 days, bugreport submission) with completion dates.                                                               |
| Gamification v2.2                  | Added adverse-intake achievements for over-intake and skipped-intake events (source != IMPORT, rollout/account start boundary).                                                                                           |
| Gamification v2.3                  | Added global Sonner unlock notifications (bottom-right) for newly unlocked achievements with title + description and per-user local dedupe cache.                                                                         |
| Stability polish                   | Hardened medication loading fallback (category enrichment failures no longer hide meds), explicit medications load-error UI with retry, reduced gamification polling load.                                                |
| Dialog consistency polish          | Unified modal header/close alignment and standardized key form-dialog footers (options menu left, cancel/save actions right) for medication and measurement flows.                                                        |
| Admin access UX                    | Admin entry removed from three-dot user menus; admin console now discoverable from the settings page for admin users.                                                                                                     |
| Verlauf migration                  | Moved complete `/charts` content (compliance + all health charts incl. BMI) into `/insights`; removed `/charts` route and navigation entries from sidebar/mobile nav.                                                     |
| General health AI summary          | Added “Allgemeiner Zustand” block below top insight cards, generated from last 30 daily aggregated points via OpenAI with nightly pg-boss refresh and locale-aware cache.                                                 |
| Blood pressure AI summary          | Added dedicated “Blutdruck” section in `/insights` (BP chart + both correlation charts + BP medication compliance list) with OpenAI summary from last 30 daily points and nightly pg-boss refresh/cache.                  |
| Weight AI summary                  | Added dedicated “Gewicht” section in `/insights` (weight chart + weight vs BP chart) with OpenAI summary focused on latest day + last 30 daily points and nightly pg-boss refresh/cache.                                  |
| Insights AI expansion              | Added daily cached AI summaries for pulse, BMI, and medication compliance (overall + per-medication text), moved section texts before charts, embedded per-medication compliance calendars, removed legacy Verlauf block. |
| Security: password change          | Added self-service password change in Settings > Security (`/api/auth/password`, strength check, audit-log action, localized UI).                                                                                         |
| Global service gating + API master switch | Added global service availability API for user settings visibility, introduced admin `apiGlobal` toggle, and enforced backend API shutdown (`/api/tokens`, `/api/ingest/medication`, per-medication API endpoint). |
| Monitoring integrations               | Added configurable Umami + Glitchtip integrations in Admin settings, app-level runtime activation, Umami script proxy endpoint, and Glitchtip client error forwarding endpoint. |
| Auth upgrade compatibility            | Hardened update path for older deployments: login supports email/username again, passkey origin accepts APP_URL/NEXT_PUBLIC_APP_URL variants, and startup compatibility guard auto-adds critical legacy DB columns/tables. |
| Monitoring test tooling               | Added admin-side one-click test endpoints/buttons for Umami and Glitchtip plus anti-autofill guards on monitoring config fields.                                                                 |
| Legacy DB compatibility expansion     | Extended runtime compatibility migration with `medication_schedules.days_of_week`, `medication_schedules.dose`, and enum value `intake_source.IMPORT` to keep medications/insights/achievements working on older DB states. |
| Chart date consistency                | Standardized chart x-axis date labels to always include full year across health/compliance charts.                                                                                                       |
| Web Push without env                  | Added DB-backed VAPID configuration (public/private/subject) in Admin settings with encrypted private key storage, so Browser Push works without mandatory environment variables.                              |

## Open Tasks

### Medium Priority

### Low Priority

#### 1. Achievements / Gamification (v3)

- Optional DB persistence for unlocked state/history
- Seasonal/level-based reward loops
- Additional goal families (sleep, activity, body fat) if desired

## Architecture Notes for New Contributors

### Page Pattern (Client Component)

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";

export default function MyPage() {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();

  const { data, isLoading } = useQuery({
    queryKey: ["my-data"],
    queryFn: async () => {
      const res = await fetch("/api/my-endpoint");
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();
      return json.data;
    },
    enabled: isAuthenticated,
  });

  // Loading / not-authenticated / render...
}
```

### API Route Pattern

```tsx
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";

export async function GET() {
  const session = await getSession();
  if (!session) return apiError("Nicht angemeldet", 401);

  const data = await prisma.someModel.findMany({
    where: { userId: session.user.id },
  });

  return apiSuccess(data);
}
```

### i18n Pattern

All user-facing text uses translation keys. Add keys to both `messages/de.json` (German, primary) and `messages/en.json` (English).

```tsx
const { t } = useTranslations();

// Simple
t("section.key");

// With parameters
t("section.key", { count: 5, name: "test" });
```

### Dracula Theme Colors

Use CSS variables for consistent theming, especially in charts:

- `var(--dracula-purple)` → #bd93f9
- `var(--dracula-pink)` → #ff79c6
- `var(--dracula-green)` → #50fa7b
- `var(--dracula-cyan)` → #8be9fd
- `var(--dracula-orange)` → #ffb86c
- `var(--dracula-red)` → #ff5555
- `var(--dracula-yellow)` → #f1fa8c
- `var(--dracula-fg)` → #f8f8f2 (foreground text)
- `var(--dracula-comment)` → #6272a4 (muted text, axis lines)
- `var(--dracula-bg)` → #282a36 (background)
- `var(--dracula-current)` → #44475a (current line / subtle bg)
