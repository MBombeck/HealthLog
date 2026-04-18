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
  authRegistrationStatus: () => ["auth", "registration-status"] as const,

  measurements: () => ["measurements"] as const,
  moodEntries: () => ["mood-entries"] as const,

  analytics: () => ["analytics"] as const,
  moodAnalytics: () => ["mood-analytics"] as const,

  insightsRoot: () => ["insights"] as const,
  insightsComprehensive: () => ["insights", "comprehensive"] as const,
  insightsTargets: () => ["insights", "targets"] as const,
  insightsGeneralStatus: (locale: string) =>
    ["insights", "general-status", locale] as const,
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
  medicationPhaseConfig: (medicationId: string) =>
    ["phase-config", medicationId] as const,
  medicationIntakeSummary: () => ["medications", "intake-summary"] as const,

  gamificationAchievements: () => ["gamification", "achievements"] as const,

  passkeys: () => ["passkeys"] as const,

  notificationsPreferences: () => ["notifications", "preferences"] as const,

  settingsGlobalServices: () => ["settings", "global-services"] as const,
  settingsNtfy: () => ["settings", "ntfy"] as const,

  tokens: () => ["tokens"] as const,
  telegram: () => ["telegram"] as const,
  telegramSettings: () => ["telegram", "settings"] as const,
  withings: () => ["withings"] as const,

  adminSettings: () => ["admin", "settings"] as const,
  adminStatus: () => ["admin", "status"] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminTokens: () => ["admin", "tokens"] as const,
  adminAuditLog: (filter: unknown) => ["admin", "audit-log", filter] as const,

  bugreportStatus: () => ["bugreport", "status"] as const,
};

/**
 * Keys that should be invalidated when a measurement is created, updated or
 * deleted. Kept here so dashboards, insights, and targets always stay in sync.
 */
export const measurementDependentKeys = [
  queryKeys.measurements(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
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
 */
export const medicationDependentKeys = [
  queryKeys.medications(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.medicationIntakeSummary(),
  queryKeys.gamificationAchievements(),
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
