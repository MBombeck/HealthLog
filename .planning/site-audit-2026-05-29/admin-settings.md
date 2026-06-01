# Admin area audit — 2026-05-29

Read-only audit of the HealthLog admin surface. No files edited.

## Admin surface inventory

Routing: `/admin` (overview) + dynamic `/admin/[section]` driven by
`ADMIN_SECTION_SLUGS` (`src/components/admin/section-slugs.ts`). The shell
(`src/components/admin/admin-shell.tsx`) renders sidebar + mobile strip; the
renderer (`src/app/admin/[section]/renderer.tsx`) maps each slug to a section
component. Nav order is the slug-array order.

| # | Slug | Component | What it controls | Backing API |
|---|------|-----------|------------------|-------------|
| — | `/admin` | `system-status-summary` + `recent-audit-preview` | Version/db/worker snapshot + last 10 auth audit rows | `/api/admin/status`, `/api/version`, `/api/admin/audit-log?filter=auth` |
| 1 | `system-status` | `SystemStatusSection` + `HostMetricsChart` | Host load chart (load1/mem/disk), db/worker/counts/integration status, offline-geo | `/api/admin/status`, `/api/admin/host-metrics`, `/api/version` |
| 2 | `general` | `GeneralSettingsSection` | registrationEnabled, defaultLocale, defaultUserTimezone | `/api/admin/settings` |
| 3 | `services` | `ServicesSection` | Global on/off: Telegram, ntfy, webPush, API | `/api/admin/settings` |
| 4 | `integrations` | `IntegrationsGroupSection` (Umami+GlitchTip+WebPushVapid+BugReport) | Analytics/error-monitoring/VAPID keys/bug-report repo + test buttons | `/api/admin/settings`, `/api/admin/monitoring/{umami,glitchtip}-test` |
| 5 | `ai-quality` | `AiQualitySection` | Read-only helpful-rate table per severity×provider×prompt | `/api/admin/ai-quality` |
| 6 | `assistant` | `AssistantSection` | Master + 5 sub feature flags | `/api/admin/settings/assistant-flags` |
| 7 | `coach-feedback` | `CoachFeedbackSection` | Read-only Coach helpful-rate table | `/api/admin/ai-quality` (coachBuckets slice) |
| 8 | `feedback` | `FeedbackInboxSection` | In-app feedback triage + GitHub issue link | `/api/admin/feedback*` |
| 9 | `reminders` | `RemindersSection` | late/missed minutes + test-notification + reminder-check dry run | `/api/admin/settings`, `/api/admin/notifications/{test,reminder-check}` |
| 10 | `users` | `UserManagementSection` | User list, reset-password, force-logout, delete | `/api/admin/users*` |
| 11 | `api-tokens` | `ApiTokenOverviewSection` | Read-only token list (all users) | `/api/admin/tokens` (GET-only) |
| 12 | `login-overview` | `LoginOverviewSection` | Auth audit log w/ filter/pagination/CSV | `/api/admin/audit-log`, `/api/admin/audit-log/actions` |
| 13 | `app-logs` | `AppLogPreviewSection` | Recent app-log preview | `/api/admin/app-logs` |
| 14 | `backups` | `BackupsSection` | List/run/upload/download/restore backups | `/api/admin/backups*` |
| 15 | `danger-zone` | `DangerZoneSection` | Wipe-all-data | `/api/admin/data` (DELETE) |
| 16 | `about` | `AboutSection` (from settings surface) | Version/update info | — |

Admin API routes with NO UI consumer (curl/CLI-only, documented in `docs/ops`):
`status-overview`, `backup/test`, `import-apple-health-export`,
`rollups/recompute`, `drain-per-sample-cumulative`, `ai-settings`,
`notifications/diagnostic`, `monitoring/*-test` (test routes are wired; listed
where bare).

---

## Findings

### 1. IA / arrangement

**1a. AI-related sections are scattered across three non-adjacent concepts but
three different icons collide.** `ai-quality` (#5), `assistant` (#6),
`coach-feedback` (#7) are adjacent (good) but all three use the same `Sparkles`
icon in `admin-shell.tsx:77,82,87`. Three identical icons in the sidebar make
them visually indistinguishable.
Fix: give `assistant` a distinct icon (e.g. `SlidersHorizontal`/`ToggleRight`)
and `coach-feedback` a `MessageSquare`/`ThumbsUp` icon; keep `Sparkles` only on
`ai-quality`.

**1b. `integrations` slug uses the `AlertTriangle` icon**
(`admin-shell.tsx:73`). AlertTriangle reads as "warning/danger", but the
section is benign config (Umami/GlitchTip/WebPush/BugReport). `danger-zone`
correctly uses `ShieldAlert`, so two destructive-looking icons compete.
Fix: use `Plug`/`Boxes` for `integrations` (note `services` already uses
`Plug` at line 67 — pick distinct ones, e.g. `services`→`Radio`,
`integrations`→`Plug`).

**1c. Two overlapping audit views.** The `/admin` overview shows
`RecentAuditPreview` (last 10 auth rows from `/api/admin/audit-log?filter=auth`)
and `login-overview` (#12) shows the same auth audit log with filters. This is
intentional (preview vs full), but the overview preview and the login-overview
both label themselves around "auth/login" with no cross-link.
Fix: add a "View all" link from the overview preview to `/admin/login-overview`
(low priority — functional, just a discoverability gap).

### 2. Duplicates

**2a. Duplicated `/api/version` fetch hook.** `useOfflineGeoState()` in
`system-status-section.tsx:35-45` and `useVersion()` in
`system-status-summary.tsx:38-48` are byte-identical (same queryKey
`publicVersion()`, same shape). Two copies of the same hook.
Fix: extract one `usePublicVersion()` into `_shared.tsx` and import in both.
(They share the queryKey so the cache is already deduped — this is code
duplication, not a runtime bug.)

**2b. `ai-quality` and `coach-feedback` both fetch `/api/admin/ai-quality`** and
render near-identical helpful-rate tables (`ai-quality-section.tsx:69`,
`coach-feedback-section.tsx:61`) with copy-pasted `helpfulRateColour()`
helpers (`ai-quality-section.tsx:56`, `coach-feedback-section.tsx:48`). Same
endpoint, two query keys, duplicated colour logic.
Fix: hoist `helpfulRateColour` to `_shared.tsx`. Functionally fine (different
slices of one payload) but consolidate the helper.

### 3. Removed / dead

**3a. `moodLogGlobal` is a fully-wired backend setting with NO admin
control.** It is read+written+returned by `/api/admin/settings/route.ts`
(lines 58, 92, 272) and enforced by the reminder worker
(`src/lib/jobs/reminder-worker.ts:1219-1221`), and it sits in the
`AdminSettings` type (`_shared.tsx:88`), but no section renders a toggle for
it. `ServicesSection` (`services-section.tsx`) exposes Telegram/ntfy/webPush/API
globals but omits moodLog. An operator cannot turn the global mood-log reminder
off from the UI.
Fix: add a `moodLogGlobal` `SettingsToggle` to `ServicesSection` (alongside the
other four globals), defaulting `settings?.moodLogGlobal ?? true`.

**3b. `/api/admin/status-overview` is an orphaned endpoint.** No component
fetches it (confirmed: only its own route + test reference it; the one apparent
match in `backups/route.ts:42` is a comment, plus stale docs in
`docs/migration/v1.3-to-v1.4.md:115` and `docs/audit/v1425-summary.md:427`).
The live overview uses `/api/admin/status` instead. Dead admin endpoint
carrying its own probe logic (`status-overview/route.ts` ~230 LOC).
Fix: either delete the route + test (if `/api/admin/status` fully supersedes
it) or wire it into the overview if its richer probe data is wanted. Confirm no
external monitor/uptime check hits it before removing.

### 4. Hallucinated content

**4a. `host-metrics` route comment promises a tooltip that doesn't exist.**
`host-metrics/route.ts:135-143` computes and returns `meta.memTotalBytes` with
the comment "so the chart can render an absolute label ('4.2 GiB / 8 GiB') in
the tooltip". The chart (`host-metrics-chart.tsx`) never reads
`meta.memTotalBytes` — the memory tooltip only shows the percentage
(`host-metrics-chart.tsx:284-285`). The promised "4.2 GiB / 8 GiB" label does
not exist anywhere.
Fix: either implement the absolute-bytes label in the tooltip formatter (the
data is already on the wire) or drop the misleading comment and the unused
`memTotalBytes` payload field. Not user-facing (comment only), but the label
was promised to the maintainer.

**4b. (Verified NOT hallucinated, noted for the maintainer):** AI-quality,
coach-feedback, host-metrics, danger-zone wipe counts, umami/glitchtip test
buttons, assistant flags, and the system-status grid all render real
backend-sourced data with honest empty states. No fake/placeholder data found
in the rendering paths.

---

## No-issue confirmations

- Every admin section component is reachable from the shell nav and the
  renderer switch is exhaustive (`slug satisfies never`).
- Danger-zone wipe (`/api/admin/data` DELETE) deletes exactly the entities its
  result message reports — counts match (`data/route.ts:51-95`).
- `requireAdmin()` gates every admin route checked; `tokens` route is GET-only
  by design (admin token view is read-only — revocation lives in user
  settings, intentional separation, not a dead control).
- Empty states are honest (ai-quality/coach-feedback show "no data yet" rather
  than zero rows; host-metrics shows a "sampler warming up" hint).
