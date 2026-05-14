---
file: 11-web-ui-tour.md
purpose: Page-by-page walkthrough of the HealthLog web UI so the iOS native build can mirror layout, data dependencies, and user actions screen-for-screen (or make conscious deviations where the iOS HIG demands it).
when_to_read: Before building any iOS screen. Re-read the matching section every time you port a new surface.
prerequisites: 02-server-architecture.md, 12-design-system.md, 13-state-management.md
estimated_tokens: 7900
version_anchor: v1.4.25 / sha 49f71c92
---

# Web UI Tour — Every Route, Every Query, Every Action

## TL;DR

The web app is a Next.js App Router project. Each top-level URL is a discrete page module in `src/app/`. Below is a deep walk through every page that has an iOS analogue, including what queries fire, what local state exists, what mutations are possible, and which components compose the screen. iOS may consolidate some web screens (e.g. Settings sub-tabs collapse into a single iOS `Form`) but should preserve the data contracts.

---

## Route Map

```
/                              → DashboardPage
/auth/login                    → Login form
/auth/register                 → Register form
/onboarding                    → redirect to current step
/onboarding/[step]             → 0=welcome 1=goals 2=source 3=baseline 4=done
/dashboard                     → (same as /, alias for backward compat)
/insights                      → mother page (hero + briefing + advisor + correlations)
/insights/blutdruck            → BP sub-page
/insights/gewicht              → Weight sub-page
/insights/puls                 → Pulse sub-page
/insights/bmi                  → BMI sub-page
/insights/stimmung             → Mood sub-page
/insights/schlaf               → Sleep sub-page
/insights/medikamente          → Medication compliance sub-page
/insights/report/[week]        → Weekly report view (ISO week slug)
/measurements                  → List + filters + bulk edit
/mood                          → Mood entry list + chart
/medications                   → Medication list (active + archived)
/medications/[id]/history      → Detail stack (GLP-1 chart, side-effects, schedule, titration, intake list)
/targets                       → Per-metric target editor
/notifications                 → Push/email/Telegram pref management
/achievements                  → Gamification surface
/bugreport                     → User-facing feedback form
/settings                      → redirect to /settings/profile
/settings/[section]            → Profile / Account / Dashboard / Sources / Thresholds / Notifications / Integrations / Advanced / etc.
/admin                         → redirect to /admin/overview
/admin/[section]               → Users / Tokens / Backups / Feedback / AI quality / etc. (role-gated)
```

---

## 1. `/` — Dashboard

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  Dashboard                                  [+ Add ▾]    │ ← page title + quick-add dropdown
│  Good morning, Marc                                       │
├──────────────────────────────────────────────────────────┤
│  GettingStartedChecklist (self-gates for new users)       │
├──────────────────────────────────────────────────────────┤
│  Tile strip — CSS grid auto-fit min(9rem)                 │
│  [Weight] [BP-Sys] [BP-Dia] [Pulse] [BodyFat] [Mood] …    │
├──────────────────────────────────────────────────────────┤
│  InsightsCardPreview (pinned above charts, self-hides)    │
├──────────────────────────────────────────────────────────┤
│  Glp1Tile (self-gates; mounts unconditionally)           │
├──────────────────────────────────────────────────────────┤
│  Chart row — Weight chart                                 │
│  Chart row — BMI chart (derived from Weight when height)  │
│  Chart row — BP chart                                     │
│  Chart row — Pulse chart                                  │
│  Chart row — BodyFat / Mood / Sleep / Steps charts        │
│  RecentAchievementsCard                                   │
└──────────────────────────────────────────────────────────┘
```

### Queries that fire

| Key | Endpoint | Use |
|-----|----------|-----|
| `["analytics"]` | `/api/analytics` | Every tile + chart's summary data |
| `["user", "dashboardWidgets"]` | `/api/dashboard/widgets` | Layout (which tiles + order + visibility) |
| `["mood-analytics"]` | `/api/mood/analytics` | Mood tile + chart |
| `["insights", "advisor"]` | `/api/insights/generate` | InsightsCardPreview payload (shared cache with /insights) |
| `["dashboard", "glp1"]` | `/api/dashboard/glp1` | Glp1Tile content |
| `["auth", "me"]` | `/api/auth/me` | Greeting, timezone, glucose unit |

### Local state

| State | Type | Purpose |
|-------|------|---------|
| `quickEntryDialog` | `"measurement" \| "mood" \| null` | Which quick-add dialog is open |

### User actions

1. **Quick-add measurement** — opens `<MeasurementForm>` in a Dialog. On success: invalidate `["measurements"]`, `["analytics"]`, `["insights"]`.
2. **Quick-add mood** — opens `<MoodForm>` in a Dialog. On success: invalidate `["mood-entries"]`, `["mood-analytics"]`, `["analytics"]`, `["insights"]`.
3. **Click tile** — navigate to matching `/insights/<slug>` sub-page.
4. **Spotlight tour** — first-time users get `<TourLauncher>` (Shepherd.js) anchored to tile strip.

### iOS mirror

The iOS dashboard collapses to a single scroll view:

- Top: greeting + plus-button in the nav bar.
- Section 1: tile strip as a `LazyVGrid` (`adaptive(minimum: 144)`).
- Section 2: `InsightPreviewCard` if data exists.
- Section 3: GLP-1 status card if user has an active GLP-1 med.
- Section 4..N: charts (one per active widget).

Pull-to-refresh invalidates all five cache keys above.

---

## 2. `/insights` — Mother Page

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  [InsightsTabStrip — sticky at top]                       │
│  Overview · BD · Gewicht · Puls · BMI · Stimmung · Schlaf │
├──────────────────────────────────────────────────────────┤
│  HeroStrip (Health Score gauge + delta + provenance)      │
├──────────────────────────────────────────────────────────┤
│  DailyBriefing (regenerable, AI-authored prose)           │
├──────────────────────────────────────────────────────────┤
│  CorrelationRow (3 cards — BP-Compliance, Mood-Pulse,…)   │
├──────────────────────────────────────────────────────────┤
│  TrendsRow (mini-spark lines for every metric)            │
├──────────────────────────────────────────────────────────┤
│  InsightAdvisorCard (full recommendation grid)            │
└──────────────────────────────────────────────────────────┘
  ↑ CoachDrawer can slide up from any of these CTAs
```

### Queries

| Key | Endpoint |
|-----|----------|
| `["insights", "comprehensive"]` | `/api/insights/comprehensive` (analytics rollup + correlations + Health Score) |
| `["insights", "advisor"]` | `/api/insights/generate` (recommendations + confidence) |
| `["insights", "targets"]` | `/api/insights/targets` |
| `["analytics"]` | `/api/analytics` (cross-referenced for trends row) |
| `["user", "dashboardWidgets"]` | layout-derived tab visibility |

### Local state

| State | Type | Purpose |
|-------|------|---------|
| `coachOpen` | `boolean` | Coach drawer visibility |
| `coachPrefill` | `string \| null` | Pre-filled prompt from suggested-prompt chip |

### Comprehensive vs Generate

Two distinct endpoints with different purposes:

| Endpoint | Caching | Purpose | Triggered by |
|----------|---------|---------|--------------|
| `/api/insights/comprehensive` | Per-user, per-day | Analytics rollup, correlations, Health Score components — no LLM call | Page load |
| `/api/insights/generate` | Per-user, per-day, per-locale | Full AI advisor payload — provider chain, severity-ordered recommendations | Explicit regenerate, or stale > 24 h |

iOS: hit `comprehensive` on screen mount for the deterministic data; hit `generate` lazily when the user opens the advisor card or pulls to refresh.

### Sub-pages

Each `/insights/<slug>` is a dedicated route under `src/app/insights/<slug>/page.tsx` (slugs are German for legacy reasons — see route map). They share a common layout `<InsightsLayoutShell>` mounted from `src/app/insights/layout.tsx`, which holds the tab strip.

Per sub-page contents:

```
┌──────────────────────────────────────────────────────────┐
│  Tab strip (inherited from layout)                        │
├──────────────────────────────────────────────────────────┤
│  Page hero — metric name + latest value + slope arrow     │
├──────────────────────────────────────────────────────────┤
│  Status card (uses `useInsightStatus(metric)`)            │
│  ← localised AI-authored status sentence                  │
├──────────────────────────────────────────────────────────┤
│  Full chart with traffic-light bands                      │
├──────────────────────────────────────────────────────────┤
│  Range bar (Dracula opacity stops)                        │
├──────────────────────────────────────────────────────────┤
│  Recommendations grid (advisor-scoped to metric)          │
└──────────────────────────────────────────────────────────┘
```

### iOS mirror

Tab bar at the top of the Insights tab; each tab is a sub-view that mirrors the layout. CoachDrawer becomes a half-sheet modal triggered from a navigation-bar button or a CTA in the hero.

---

## 3. `/coach` — Conversational Surface

> Note: there is no literal `/coach` route. The Coach is a **drawer** mounted on `/insights` only. iOS may surface it as its own tab — a small, deliberate deviation.

### Structure

```
┌───────────────────────────────────────────────┐
│  CoachDrawer (sheet, slides from right)       │
│  ┌──────────────────────┬──────────────────┐  │
│  │ HistoryRail          │ MessageThread    │  │
│  │ (conv. list)         │ (active conv.)   │  │
│  │ • Today's chat       │ ┌──────────────┐ │  │
│  │ • Yesterday          │ │ User bubble  │ │  │
│  │ • Last week          │ ├──────────────┤ │  │
│  │ • [New conversation] │ │ Assistant…   │ │  │
│  │                      │ │ (streaming)  │ │  │
│  │                      │ ├──────────────┤ │  │
│  │                      │ │ Sources rail │ │  │
│  │                      │ └──────────────┘ │  │
│  │                      ├──────────────────┤  │
│  │                      │ CoachInput       │  │
│  │                      │ ┌──────────────┐ │  │
│  │                      │ │ […textarea…] │ │  │
│  │                      │ │ [Settings ⚙][Send →] │ │  │
│  │                      │ └──────────────┘ │  │
│  └──────────────────────┴──────────────────┘  │
└───────────────────────────────────────────────┘
```

### Queries

| Key | Endpoint |
|-----|----------|
| `["coachConversations"]` | `GET /api/insights/chat` — list (cursor-paginated) |
| `["coachConversation", id]` | `GET /api/insights/chat/[id]` — single conversation with messages |

### Mutations

| Action | Endpoint | Optimistic? |
|--------|----------|-------------|
| Send message | `POST /api/insights/chat` (SSE) | Yes — optimistic user bubble; assistant streams |
| Delete conversation | `DELETE /api/insights/chat/[id]` | Yes — remove from rail, rollback on error |
| Provide feedback | `POST /api/insights/chat/messages/[id]/feedback` | No |
| Update coach prefs | `PUT /api/auth/me/coach-prefs` | No, invalidate prefs key |

### Coach Snapshot model

When the user sends a message, the server pulls a **CoachSnapshot** — a structured summary of the user's recent data — and prepends it to the system prompt. Source: `src/lib/ai/coach/snapshot.ts` (`buildCoachSnapshot`).

Snapshot shape (controlled by `CoachScope`):

```ts
{
  sources: ["bp", "weight", "pulse", "mood", "compliance",
            "hrv", "sleep", "resting_hr", "steps", "active_energy",
            "flights", "distance", "vo2_max", "body_temp"]
  window: "last7days" | "last30days" | "last90days" | "allTime"
}
```

The sources-rail in the drawer lets the user toggle per-source inclusion + window. Default window: `last30days`. Default sources: BP, weight, pulse, mood, compliance (the core 5). The Apple Health additions (HRV, sleep, etc.) are opt-in via the rail.

### iOS mirror

A dedicated Coach tab is acceptable on iOS — phone screens are too narrow for a side-drawer pattern. Layout: a navigation stack with `ConversationListView` → `ConversationDetailView`. The `ConversationDetailView` is a `ScrollView` of bubbles plus a fixed-position `CoachInputView` at the bottom respecting the keyboard inset.

Streaming uses `URLSession.bytes(for:)` per `13-state-management.md` §8.

---

## 4. `/medications` — List

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  Medications                            [+ Add]           │
├──────────────────────────────────────────────────────────┤
│  Active (3)                                               │
│  ┌────────────────────────────────────────────────────┐   │
│  │ Mounjaro 7.5 mg          Last dose: 2 days ago     │   │
│  │ [GLP-1 badge]            Next: tomorrow 08:00      │   │
│  │                          [Log intake] [⋮]          │   │
│  └────────────────────────────────────────────────────┘   │
│  Archived (1)                                             │
│  ┌────────────────────────────────────────────────────┐   │
│  │ Ramipril 5 mg            Discontinued 2026-03-12   │   │
│  └────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### Queries

| Key | Endpoint |
|-----|----------|
| `["medications"]` | `GET /api/medications` |
| `["medications", "intake-summary"]` | `GET /api/medications/intake?scope=summary` |

### Actions

- **Add** — opens `<MedicationForm>` dialog. POST `/api/medications`.
- **Log intake** — opens intake dialog. POST `/api/medications/:id/intake`.
- **Click row** — navigate to `/medications/[id]/history`.

---

## 5. `/medications/[id]/history` — Detail Stack

The richest single page in the app. Composes 5 stacked sections, all gated on `treatmentClass === "GLP1"`.

### Composition

```tsx
// from src/app/medications/[id]/history/page.tsx:94-130
{medication?.treatmentClass === "GLP1" && (
  <DrugLevelChart medication={…} />          // ← cycle/curve visualisation
)}
{medication?.treatmentClass === "GLP1" && (
  <SideEffectsSection medicationId={id} />   // ← symptom logbook
)}
{medication?.treatmentClass === "GLP1" && (
  <SchedulingSection medicationId={id} />    // ← cadence + compliance chips
)}
{medication?.treatmentClass === "GLP1" && (
  <TitrationSection medicationId={id} />     // ← dose-ladder display
)}
<IntakeHistoryList medicationId={id} />      // ← always shown
```

Order matters: cycle context → symptom record → cadence → ladder → dose-by-dose timeline. Drug-level chart first so the user sees "where am I in the curve" before logging a side effect.

### Per-section queries

| Section | Key | Endpoint |
|---------|-----|----------|
| `DrugLevelChart` | `["compliance-chart-inline", id]` | `/api/medications/:id/drug-level` |
| `SideEffectsSection` | `["medications", id, "side-effects"]` | `/api/medications/:id/side-effects` |
| `SchedulingSection` | `["phase-config", id]` | `/api/medications/:id/scheduling` |
| `TitrationSection` | `["medications", id, "titration"]` | `/api/medications/:id/titration` |
| `IntakeHistoryList` | `["medications", id, "intakes"]` | `/api/medications/:id/intakes` |
| Page-level | `["medications", id]` | `/api/medications/:id` |

### Chrome contract

Every detail section wraps in `<MedicationDetailSection>` (locked since Fix-N). Border `border-border/60`, radius `rounded-md`, header `px-3 py-2.5`, body `px-3 py-3`, hairline divider. See `12-design-system.md` §5.2.

### Research Mode gate

The `DrugLevelChart` is gated on **Research Mode**, version-aligned. The user must:

1. Visit Settings → Advanced and toggle Research Mode on.
2. Read + acknowledge the version-stamped disclaimer (`ResearchModeAcknowledgmentDialog`).
3. Until the user acknowledges the current version, the chart shows a CTA banner.

When Marc bumps the disclaimer version (e.g. after a regulatory update) the chart re-collapses and the user re-acknowledges. State persisted in `User.researchModeAcknowledgedAt` + `User.researchModeAcknowledgedVersion`.

### iOS mirror

Same five sections in the same order. Each section is a SwiftUI subview returning an `EmptyView` if `medication.treatmentClass != "GLP1"`. The `MedicationDetailSection` wrapper becomes a `SectionContainer` view with identical paddings.

Research Mode gate → Settings → Advanced toggle → acknowledgment sheet. Acknowledgement state lives in `User` JSON and is fetched on app launch.

---

## 6. `/onboarding/[step]` — Wizard

### Steps

```
0 — Welcome      WelcomeCarousel       value-prop + screenshots
1 — Goals        GoalsChipPicker       multi-select "what to track"
2 — Source       SourceCardGrid        Withings · Apple Health · manual
3 — Baseline    BaselineForm          first weight + height (or sync confirmation)
4 — Done         DoneScreen            "Open dashboard" CTA
```

Each step renders inside `<OnboardingShell>` which provides:

- Step pager (5 dots, current step highlighted)
- Back/Next nav (Back is non-destructive; Next is gated on the step's validation)
- Skip link (Marc-only; surfaced for power users)

### Gating

Server-side `redirect()` in the layout:

1. Unauthenticated → `/auth/login`.
2. Completed user hitting steps 1/2/3 → `/` (no replay).
3. Forward-jump (user on step 1 hits `/onboarding/3` by URL) → redirect to current step.
4. Backwards navigation allowed (the shell's Back button uses it).

### Source

`src/app/onboarding/[step]/page.tsx` — RSC; the step body components are client components mounted inside.

### iOS mirror

A modal `OnboardingFlow` view presented on first launch (or first launch after a re-install). Step state lives in a `@StateObject OnboardingViewModel`; on completion, POST `/api/onboarding/complete` and dismiss.

For step 2 ("Source"), iOS has the unique privilege of offering **Apple HealthKit** as the primary source. Withings + manual remain options; this is where iOS deviates from web most.

---

## 7. `/settings/[section]` — Settings Sub-Pages

### Sections

```
profile           → name, email, password, gravatar
account           → DOB, gender, height, timezone, locale
dashboard         → tile + chart visibility, comparison baseline
sources           → source-priority editor (per-metric)
thresholds        → personalised target ranges
notifications     → web-push, email, Telegram, ntfy
integrations      → Withings, Telegram bot, Apple Health (iOS)
api               → personal access tokens
advanced          → Research Mode toggle + data-wipe (irreversible)
export            → CSV / JSON / doctor-report PDF
```

### Layout

```
┌──────────────────────────────────────────────────────────┐
│  ◄ Settings                                                │
│  ┌───────────────┬──────────────────────────────────────┐ │
│  │ Profile       │  Profile                              │ │
│  │ Account       │  ┌──────────────────────────────────┐ │ │
│  │ Dashboard     │  │ Name      [Marc]                │ │ │
│  │ Sources       │  │ Email     [marc@…]              │ │ │
│  │ Thresholds    │  │ Password  [Change]              │ │ │
│  │ Notifications │  │ Avatar    [Gravatar preview]    │ │ │
│  │ Integrations  │  └──────────────────────────────────┘ │ │
│  │ API           │                                        │ │
│  │ Advanced      │                                        │ │
│  │ Export        │                                        │ │
│  └───────────────┴──────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Two-pane on `≥ md`; single-pane stack on mobile (the rail collapses into the section heading + a "« Back" link).

### Advanced section

```
ResearchModeCard      → toggle + acknowledgment dialog + version-mismatch banner
DangerZone            → "Wipe all my data" (irreversible)
```

Marc's mobile rule: provider dropdown drives form below dynamically; never split same concept across the page. The Advanced section honours this — toggle → acknowledgment dialog → status pill, all in one column.

### iOS mirror

Each section becomes a `Form` row in a single `SettingsView`. Tapping a row pushes the section's detail view. Profile/Account/Dashboard/etc. are 9 detail views; Apple Health is the iOS-only section under Integrations.

---

## 8. `/admin/[section]` — Admin Surfaces (role-gated)

> Optional for v1.5 iOS. Skip if iOS doesn't ship admin scope; otherwise mirror.

### Sections

```
overview         → system-status summary
users            → user-management table
tokens           → API-token overview (system-level)
backups          → manual + scheduled backups
feedback         → feedback inbox
ai-quality       → AI usage metrics + cost tracking
reminders        → notification job overview
services         → integration health (Glitchtip, Umami, ntfy)
audit-log        → admin audit trail
danger           → admin-only data ops
```

Gating: every request runs through `requireAdmin()` in the API route, plus the page itself short-circuits to `/` if `user.role !== "ADMIN"`.

### iOS

If iOS gets admin scope, present as a single `AdminView` `Form` with sections. Otherwise return an `accessDenied` screen with a CTA back to the dashboard.

---

## 9. Auxiliary Surfaces

### `/measurements`

List + filter + bulk-edit table for raw measurements. Useful for power users / debugging. Queries `["measurements"]`. iOS: a flat list filtered by metric chips at the top, infinite scroll.

### `/mood`

Mood entry list + chart. Mirrors `/measurements` but for `MoodEntry` rows. iOS: similar list.

### `/targets`

Per-metric target editor — let the user override the default green/orange/red bands. PUT `/api/insights/targets`. iOS: a per-metric detail view with three numeric inputs.

### `/notifications`

Notification preferences (web-push, email, Telegram, ntfy). iOS: drop ntfy + Telegram if not configured; surface APNs as the primary path.

### `/achievements`

Gamification surface — unlocked badges grid + locked teasers. Read-only. iOS: a grid view.

### `/bugreport`

User-facing feedback form. Posts to `/api/bugreport`. iOS: a sheet from `Settings → Help → Send feedback`.

---

## 10. Page-Level Heuristics for iOS

| Web pattern | iOS adoption rule |
|-------------|-------------------|
| Top-bar quick-add dropdown | iOS nav-bar `+` button → `ActionSheet` |
| Sticky tab strip on `/insights` | iOS `Picker(.segmented)` pinned under nav bar |
| Side-drawer Coach | iOS bottom-sheet half-modal OR its own tab |
| Modal Dialog for quick-add | iOS `.sheet()` |
| Inline Sheet from bottom | iOS `.sheet(detents: [.medium, .large])` |
| Two-pane Settings shell | iOS single-pane navigation stack |
| Spotlight Tour (Shepherd.js) | Skip on iOS v1.5 — the Onboarding wizard covers first-time discovery |
| Toast (Sonner) | iOS `UIKit` toast or SwiftUI `.alert(isPresented:)` — keep duration 4 s |

---

## 11. Page-by-Page Self-Test

For each web page you port, confirm:

- [ ] Same query keys / endpoints as the web page hits.
- [ ] Same mutation → invalidation chain.
- [ ] Page title text matches (translated via the same i18n key).
- [ ] EmptyState used for zero-data branches.
- [ ] Recharts series colours preserved if a chart is on the page.
- [ ] Touch targets ≥ 44 pt.
- [ ] Pull-to-refresh re-fires the page's queries.
- [ ] 401 routes to login through the global handler.
- [ ] Loading state uses `ProgressView` / spinner; never a frozen empty screen.

---

## 12. STOP HERE markers

- STOP HERE if iOS wants to merge `/insights` and the per-metric sub-pages into one scroll. Marc decided sub-pages so each metric has its own URL; tab switching is the discovery model. Don't undo it for iOS.
- STOP HERE if iOS wants to combine `/medications` and `/medications/:id/history` into one screen. The detail stack is dense; collapsing it costs scroll real estate.
- STOP HERE if iOS wants to skip the Onboarding wizard. The wizard is the only place where the user enables Apple HealthKit, and the dashboard relies on baseline data being present.
- STOP HERE if iOS wants to expose Advanced (Research Mode) without the acknowledgment dialog. The dialog is the legal gate.
