/**
 * Centralized TanStack Query key factory.
 *
 * Every useQuery/invalidateQueries call should go through this factory so that
 * mutations invalidate the right consumers. Hard-coded string arrays drifted in
 * the past (e.g. ["measurements"] didn't invalidate ["analytics"] on the
 * dashboard), so treat this file as the single source of truth.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

export const queryKeys = {
  auth: () => ["auth"] as const,
  /**
   * v1.4.40 W-RSC — the `useAuth` hook's `["auth", "me"]` shape was a
   * recurring source of factory drift (audit H1 — "`useAuth` uses
   * `["auth", "me"]` but `queryKeys.auth()` returns `["auth"]`"). Both
   * shapes share the `["auth"]` prefix so existing prefix-invalidations
   * still match, but the centralised name makes the call site
   * obviously factory-routed.
   */
  authMe: () => ["auth", "me"] as const,
  authRegistrationStatus: () => ["auth", "registration-status"] as const,
  /**
   * v1.4.40 W-RSC — Settings → AI surfaces and the targets editor
   * subscribe to the user-thresholds API. Centralise the key so a
   * future rename (e.g. `["user","limits"]`) doesn't drift across the
   * three call sites (settings/thresholds-editor-section,
   * settings/ai-section, targets/target-edit-sheet).
   */
  userThresholds: () => ["user", "thresholds"] as const,

  measurements: () => ["measurements"] as const,
  moodEntries: () => ["mood-entries"] as const,

  /**
   * v1.4.33 IW2 — the analytics queryKey now optionally carries a
   * `slice` discriminator so the dashboard tile-strip can subscribe to
   * the slim `?slice=summaries` server slice (IW1 / C1) without
   * colliding with the thick-payload consumers on the Insights tree.
   * Calling `queryKeys.analytics()` without a slice keeps the legacy
   * shape `["analytics"]` so mutation invalidations and the bulk-key
   * lists below stay byte-identical.
   */
  analytics: (slice?: "summaries") =>
    (slice ? (["analytics", slice] as const) : (["analytics"] as const)),
  moodAnalytics: () => ["mood-analytics"] as const,

  insightsRoot: () => ["insights"] as const,
  insightsComprehensive: () => ["insights", "comprehensive"] as const,
  insightsTargets: () => ["insights", "targets"] as const,
  /**
   * Shared cache key for the rich `/api/insights/generate` advisor
   * payload. Every surface that subscribes under this key shares the
   * same cache so a regenerate on one surface refreshes the others
   * without a second LLM round-trip.
   */
  insightsAdvisor: () => ["insights", "advisor"] as const,
  insightsBpStatus: (locale: string) =>
    ["insights", "blood-pressure-status", locale] as const,
  insightsWeightStatus: (locale: string) =>
    ["insights", "weight-status", locale] as const,
  insightsPulseStatus: (locale: string) =>
    ["insights", "pulse-status", locale] as const,
  insightsBmiStatus: (locale: string) =>
    ["insights", "bmi-status", locale] as const,
  insightsMoodStatus: (locale: string) =>
    ["insights", "mood-status", locale] as const,
  insightsMedicationComplianceStatus: (locale: string) =>
    ["insights", "medication-compliance-status", locale] as const,

  medications: () => ["medications"] as const,
  medicationDetail: (id: string) => ["medications", id] as const,
  medicationComplianceChart: (medicationId: string) =>
    ["compliance-chart-inline", medicationId] as const,
  /**
   * v1.4.40 W-RSC — the dashboard-level compliance chart (aggregate
   * across every scheduled medication) was a bare `["medication-
   * compliance-chart", days]` key; route it through the factory so
   * `medicationDependentKeys` invalidates it on intake-mutation just
   * like the per-medication compliance-chart-inline tile. `days` is the
   * range (7 / 30 / 90); kept as the only param so the prefix
   * `["dashboard-medication-compliance"]` invalidates every range at
   * once.
   */
  dashboardMedicationCompliance: (days: number) =>
    ["dashboard-medication-compliance", days] as const,
  medicationPhaseConfig: (medicationId: string) =>
    ["phase-config", medicationId] as const,

  gamificationAchievements: () => ["gamification", "achievements"] as const,

  passkeys: () => ["passkeys"] as const,

  notificationsPreferences: () => ["notifications", "preferences"] as const,
  notificationsStatus: () => ["notifications", "status"] as const,

  settingsGlobalServices: () => ["settings", "global-services"] as const,
  settingsNtfy: () => ["settings", "ntfy"] as const,
  settingsReminderThresholds: () =>
    ["settings", "reminder-thresholds"] as const,

  /**
   * v1.4.41 W-FRONTEND-FACTORY — Settings → AI surfaces (provider chain,
   * insights settings, user provider preference) and the targets editor
   * all read these endpoints; centralising the keys keeps invalidation
   * symmetrical with the user-thresholds + auth surfaces.
   */
  insightsSettings: () => ["insights", "settings"] as const,
  insightsProviderChain: () => ["insights", "provider-chain"] as const,
  insightsGlp1Timeline: (limit: number | string) =>
    ["insights", "glp1-timeline", limit] as const,
  userAiProvider: () => ["user", "ai-provider"] as const,
  userProfile: () => ["user", "profile"] as const,

  apiVersion: () => ["api", "version"] as const,
  publicVersion: () => ["public", "version"] as const,
  researchMode: () => ["research-mode"] as const,
  moodlogStatus: () => ["moodlog-status"] as const,
  integrationsStatus: () => ["integrations", "status"] as const,
  featureFlags: () => ["feature-flags"] as const,
  coachPrefs: () => ["coach-prefs"] as const,

  /**
   * v1.4.41 — admin surfaces. Pre-fix every admin section declared its
   * own bare-literal `["admin", "<name>"]`. Routing through the factory
   * lets a single rename change every consumer in lockstep.
   */
  adminAiQuality: () => ["admin", "ai-quality"] as const,
  adminAppLogs: (
    traceId: string | undefined,
    action: string | undefined,
    level: string | undefined,
    range: string | undefined,
  ) =>
    ["admin", "app-logs", traceId, action, level, range] as const,
  adminAssistantFlags: () => ["admin", "settings", "assistant-flags"] as const,
  adminBackups: () => ["admin", "backups"] as const,
  adminCoachFeedback: () => ["admin", "coach-feedback"] as const,
  adminFeedback: (status: string) => ["admin", "feedback", status] as const,
  adminFeedbackRoot: () => ["admin", "feedback"] as const,
  adminHostMetrics: (window: string) =>
    ["admin", "host-metrics", window] as const,
  adminAuditActions: () => ["admin", "audit-log", "actions"] as const,
  adminAuditOverview: () => ["admin", "audit-log", "overview-preview"] as const,

  tokens: () => ["tokens"] as const,
  telegram: () => ["telegram"] as const,
  telegramSettings: () => ["telegram", "settings"] as const,
  withings: () => ["withings"] as const,

  // v1.4.32 — workout list + detail caches. `workouts()` is the
  // root key invalidated by the batch-ingest mutation; the recent +
  // detail sub-keys ride underneath so the dashboard tile and the
  // detail page share a cache slot with the list page.
  workouts: () => ["workouts"] as const,
  workoutsRecent: () => ["workouts", "recent"] as const,
  workoutDetail: (id: string) => ["workouts", id] as const,

  adminSettings: () => ["admin", "settings"] as const,
  adminStatus: () => ["admin", "status"] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminTokens: () => ["admin", "tokens"] as const,
  adminAuditLog: (filter: unknown) => ["admin", "audit-log", filter] as const,

  bugreportStatus: () => ["bugreport", "status"] as const,

  /**
   * v1.4.22 W5 reconcile (Code-LOW-5) — `["user", "dashboardWidgets"]`
   * was duplicated as a literal at three call sites (dashboard,
   * insights, settings/dashboard-layout). One typo turns into a
   * silent cache miss + extra fetch; the centralised key defends
   * against the same query-key-collision class as `analytics()`.
   */
  dashboardWidgets: () => ["user", "dashboardWidgets"] as const,

  /**
   * v1.4.25 W5e — per-user, per-metric-class source priority. The
   * Settings → Sources surface reads + writes this key; saving
   * invalidates `analytics()` because the cumulative-metric aggregator
   * folds the new priority into the SLEEP_DURATION daily total
   * immediately.
   */
  sourcePriority: () => ["auth", "source-priority"] as const,

  /**
   * v1.4.40 W-RSC — per-chart daily-aggregate fetch from the dashboard
   * + insights chart row. Pre-fix the key was bare `["chart-data", …]`
   * across the codebase, which excluded it from
   * `measurementDependentKeys` and left chart caches stale for up to
   * 60 s after a measurement save (audit-C2). Routing through the
   * factory pulls every variant under a single
   * `["chart-data"]` invalidation prefix so a mutation refreshes the
   * tile strip + the chart row in lockstep.
   *
   * The shape carries the heavy parameter list because the chart query
   * is bounded by metric set, value mode, BMI divisor, timezone, and
   * fetch window; the factory packs those into a single tuple to keep
   * the cache layout byte-identical with the pre-v1.4.40 layout.
   */
  chartData: (
    types: string,
    valueMode: string,
    bmiDivisor: string | number,
    timezone: string,
    fromIso: string,
    toIso: string,
  ) =>
    [
      "chart-data",
      types,
      valueMode,
      bmiDivisor,
      timezone,
      fromIso,
      toIso,
    ] as const,
};

/**
 * Keys that should be invalidated when a measurement is created, updated or
 * deleted. Kept here so dashboards, insights, and targets always stay in sync.
 *
 * v1.4.40 W-RSC — `["chart-data"]` prefix now lives in the bundle so a
 * fresh measurement evicts every per-chart daily-aggregate cache. The
 * prefix matches every key returned from `queryKeys.chartData(…)` via
 * TanStack's hierarchical-prefix semantics — adding a measurement now
 * refreshes the tile strip *and* the chart row in lockstep instead of
 * leaving the chart row 60 s stale (audit C2).
 */
export const measurementDependentKeys = [
  queryKeys.measurements(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  ["chart-data"] as const,
];

/**
 * Keys that should be invalidated when a mood entry is created, updated or
 * deleted.
 */
export const moodDependentKeys = [
  queryKeys.moodEntries(),
  queryKeys.moodAnalytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
];

/**
 * Keys invalidated when medications change (CRUD or intake).
 *
 * v1.4.40 W-RSC — the dashboard's aggregate compliance chart now
 * rides the factory under `dashboardMedicationCompliance`. The prefix
 * `["dashboard-medication-compliance"]` lands in the bundle so an
 * intake POST refreshes the chart immediately rather than waiting for
 * `staleTime` (audit L4).
 */
export const medicationDependentKeys = [
  queryKeys.medications(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  ["dashboard-medication-compliance"] as const,
];

/**
 * Invalidate every key in the bundle in parallel. Use this from mutation
 * `onSuccess` handlers so the call site stays a one-liner instead of repeating
 * `Promise.all(keys.map(...))` everywhere.
 *
 * Uses `allSettled` so one transient network failure doesn't abort subsequent
 * invalidations (cache would otherwise be left half-stale) and so the `void
 * invalidateKeys(...)` fire-and-forget pattern in delete handlers never
 * surfaces an unhandled rejection.
 */
export function invalidateKeys(
  queryClient: QueryClient,
  keys: readonly QueryKey[],
): Promise<PromiseSettledResult<unknown>[]> {
  return Promise.allSettled(
    keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );
}
