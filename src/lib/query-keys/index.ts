/**
 * Centralized TanStack Query key factory.
 *
 * Every useQuery/invalidateQueries call should go through this factory so that
 * mutations invalidate the right consumers. Hard-coded string arrays drifted in
 * the past (e.g. ["measurements"] didn't invalidate ["analytics"] on the
 * dashboard), so treat this module as the single source of truth.
 *
 * The factory is split into per-feature files under this directory; this
 * index assembles them into the one `queryKeys` object every call site
 * imports (`@/lib/query-keys` resolves here). The dependent-key bundles
 * live here too because they fan out across feature boundaries.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { adminKeys } from "./admin";
import { allergyKeys } from "./allergies";
import { authKeys } from "./auth";
import { coachKeys } from "./coach";
import { familyHistoryKeys } from "./family-history";
import { customMetrics } from "./custom-metrics";
import { cycleKeys } from "./cycle";
import { dailyKeys } from "./daily";
import { dashboardKeys } from "./dashboard";
import { environmentKeys } from "./environment";
import { documentKeys } from "./documents";
import { encounterKeys } from "./encounters";
import { illnessKeys } from "./illness";
import { insightsKeys } from "./insights";
import { integrationKeys } from "./integrations";
import { labKeys } from "./labs";
import { measurementKeys } from "./measurements";
import { measurementReminderKeys } from "./measurement-reminders";
import { medicationKeys } from "./medications";
import { mentalHealthKeys } from "./mental-health";
import { moodKeys } from "./mood";
import { nutrientKeys } from "./nutrients";
import { onboardingKeys } from "./onboarding";
import { recordSettingsKeys } from "./record-settings";
import { profileKeys } from "./profile";
import { settingsKeys } from "./settings";
import { sharingKeys } from "./sharing";
import { vaccinationKeys } from "./vaccinations";
import { workoutKeys } from "./workouts";

export const queryKeys = {
  ...authKeys,
  ...measurementKeys,
  ...moodKeys,
  ...dailyKeys,
  ...dashboardKeys,
  ...insightsKeys,
  ...medicationKeys,
  ...coachKeys,
  ...adminKeys,
  ...integrationKeys,
  ...workoutKeys,
  ...settingsKeys,
  ...cycleKeys,
  ...measurementReminderKeys,
  ...labKeys,
  ...illnessKeys,
  ...mentalHealthKeys,
  ...allergyKeys,
  ...familyHistoryKeys,
  ...environmentKeys,
  ...documentKeys,
  ...encounterKeys,
  ...customMetrics,
  ...nutrientKeys,
  ...onboardingKeys,
  ...recordSettingsKeys,
  ...profileKeys,
  ...sharingKeys,
  ...vaccinationKeys,
};

export { recordSettingsKeys } from "./record-settings";

/**
 * v1.36.0 — every read a grant transition can make stale.
 *
 * Inviting, accepting, revoking and renouncing all change the same three
 * answers: the grant list, the owner's record-activity feed, and
 * `accountAccess` on the account payload — which is what drives the switcher
 * and the banner. A revoke that refreshed the panel but not the payload would
 * leave a switcher entry pointing at a record the server had just closed: the
 * affordance still on screen, the click already refused.
 *
 * v1.37.0 — the managed-profile family joins the bundle as a prefix. A
 * Guardian invitation is accepted through the ordinary
 * `POST /api/account/grants/{id}/accept`, and that acceptance moves a row on a
 * roster the accept route knows nothing about: the invitee stops being PENDING
 * and starts counting toward the last-Guardian floor. Listing the prefix here
 * keeps the roster in step with the act that changed it, rather than asking
 * every future grant transition to remember one more read.
 */
export const grantDependentKeys = [
  queryKeys.accountGrants(),
  queryKeys.accountActivity(),
  queryKeys.authMe(),
  queryKeys.managedProfiles(),
];

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
 *
 * v1.18.9 — `dashboardSnapshot` joins the bundle, mirroring the
 * v1.16.11 medication fix. The dashboard hero band, score ring, and
 * tile strip all read ONE snapshot query configured with
 * refetchOnMount/WindowFocus off and a 120 s poll; without the key here
 * a blood-pressure (or any) reading added in-app stayed invisible on the
 * Startseite until the poll ticked or a hard reload — the reported #38
 * stale-read. The manual create / update / delete routes already
 * hard-evict the server snapshot bucket (`{ evict: true }`), so the
 * refetch this invalidation triggers returns post-write data at once.
 */
export const measurementDependentKeys = [
  queryKeys.measurements(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  queryKeys.dashboardSnapshot(),
  // v1.29.x — the Today digest reads the same snapshot ingredients a
  // manual measurement write already hard-evicts server-side; joins the
  // bundle so the digest's score / rail items refresh in lockstep with
  // the tile strip. Call sites also force an inactive refetch (see
  // `refetchInactiveDailyReads` below) since a default invalidation only
  // refetches MOUNTED queries and the digest is typically unmounted
  // while the user is on the measurement surface.
  queryKeys.dailyDigest(),
  ["chart-data"] as const,
  // v1.8.5 — re-run the diversity-nudge clustering when readings change.
  ["measurement-diversity"] as const,
  // v1.11.4 item J — refresh the Trends-row deterministic caption series
  // when a reading changes, in lockstep with the chart row above it.
  ["trend-series"] as const,
  // v1.11.5 — refresh the last-night hypnogram when sleep rows change.
  ["sleep-night"] as const,
  // v1.17.0 — refresh the sleep-debt + chronotype read when sleep rows change.
  ["sleep-rhythm"] as const,
];

/**
 * Keys that should be invalidated when a mood entry is created, updated or
 * deleted.
 *
 * v1.28.42 (M2) — `dashboardSnapshot` joins the bundle, mirroring the
 * measurement (v1.18.9) and medication (v1.16.11) fixes for the same #38
 * stale-read class. The dashboard snapshot embeds a mood block and feeds the
 * score ring, but `moodDependentKeys` omitted the key, so a mood logged from
 * the Startseite quick-entry sheet (or on `/mood`) left the dashboard tile /
 * score showing the pre-write value for up to ~120 s (the snapshot query runs
 * refetchOnMount/WindowFocus off with a 120 s poll). The server snapshot bucket
 * is already hard-evicted on a mood write (`invalidateUserMood` sweeps
 * `${userId}|`), so the refetch this invalidation triggers returns post-write
 * data at once.
 */
export const moodDependentKeys = [
  queryKeys.moodEntries(),
  queryKeys.moodAnalytics(),
  queryKeys.moodInsights(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  queryKeys.dashboardSnapshot(),
  // v1.29.x — mirrors the measurement fix above: the Today digest reads
  // the same snapshot mood block a mood write already hard-evicts
  // server-side. Call sites force an inactive refetch too (see
  // `refetchInactiveDailyReads`).
  queryKeys.dailyDigest(),
];

/**
 * Keys invalidated when medications change (CRUD or intake).
 *
 * v1.4.40 W-RSC — the dashboard's aggregate compliance chart now
 * rides the factory under `dashboardMedicationCompliance`. The prefix
 * `["dashboard-medication-compliance"]` lands in the bundle so an
 * intake POST refreshes the chart immediately rather than waiting for
 * `staleTime` (audit L4).
 *
 * v1.5.5 D-3 §10 invariant 20 (was C-E2-1 / H-cluster-G) — the
 * per-medication inline compliance chart used to mount under
 * `queryKeys.medicationComplianceChart(medicationId)` which expands to
 * `["compliance-chart-inline", id]`. The prefix `["compliance-chart-inline"]`
 * lands in the bundle so every detail-page mutation (today's-dose,
 * Pausieren, end, purge, edit) evicts the inline compliance tile in
 * one tick. The TanStack hierarchical-prefix semantics catch every
 * per-medication slot under that prefix.
 *
 * `queryKeys.medicationDetail(id)` rides under the
 * `["medications"]` prefix already so a single medication invalidation
 * also evicts its detail-page read.
 *
 * v1.16.11 — `dashboardSnapshot` joins the bundle. The hero band, dose
 * tally, verdict and checklist all read ONE snapshot query configured
 * with refetchOnMount/WindowFocus off and a 120 s poll; without the key
 * here a dose taken from the dashboard stayed visibly due for up to two
 * minutes. The intake routes already hard-evict the server-side
 * snapshot bucket, so the refetch this triggers returns post-write data
 * immediately.
 *
 * v1.29.1 — `dailyDigest` joins the bundle. The Today hero's digest reads
 * `medsToday` from the same server snapshot the intake routes hard-evict,
 * but nothing invalidated the client query, so the digest's "dose due"
 * rail item lingered until a hard reload. Like the snapshot, the digest
 * query runs with refetchOnMount/WindowFocus tuned off, so the intake
 * seam ALSO forces an inactive refetch (it is unmounted while the user is
 * on the medication card); this bundle membership covers the case where
 * the dashboard is the active surface.
 */
export const medicationDependentKeys = [
  queryKeys.medications(),
  queryKeys.analytics(),
  queryKeys.insightsRoot(),
  queryKeys.insightsTargets(),
  queryKeys.gamificationAchievements(),
  queryKeys.dashboardSnapshot(),
  queryKeys.dailyDigest(),
  ["dashboard-medication-compliance"] as const,
  ["compliance-chart-inline"] as const,
];

/**
 * Keys invalidated when cycle data changes (a day-log capture, a period
 * boundary, a day-log delete). The `["cycle"]` prefix catches the calendar
 * windows, the history stats, and the profile read in one tick so the
 * calendar/wheel and predictions panel never read stale rows after a quick
 * log. `insightsRoot()` rides along because phase-correlation cards depend
 * on the same rows.
 */
export const cycleDependentKeys = [queryKeys.cycle(), queryKeys.insightsRoot()];

/**
 * Keys invalidated when an illness episode starts, ends, is edited, deleted,
 * restored, or a day-log lands. Rest Mode derives from the active-episode set
 * and both daily reads annotate from it (the hero band's "unwell since" frame,
 * the digest's paused nudges), so an episode write must reach the snapshot and
 * digest keys, not only the `["illness"]` tree. Pair every call site with
 * `refetchInactiveDailyReads` — the daily reads are typically unmounted while
 * the user is on the illness surface, and a bare invalidation would mark them
 * stale without refetching (the recurring v1.16.11/v1.29.1/v1.32.19 class).
 */
export const illnessDependentKeys = [
  queryKeys.illness(),
  queryKeys.dashboardSnapshot(),
  queryKeys.dailyDigest(),
];

/**
 * Keys invalidated when a visit or an address-book entry changes.
 *
 * Both roots ride together in one bundle rather than two, because the two
 * writes reach each other: renaming a practice changes the label every visit
 * that names it renders, and deleting one nulls the reference on visits that
 * stay. A bundle that evicted only the surface being written would leave the
 * other showing the pre-write name.
 *
 * `useEncounterMutations` and `usePractitionerMutations` are its consumers.
 * It briefly had none — the roots landed a release before the surfaces that
 * read them — and was removed on trunk for that reason; it is back here
 * together with the writes that need it.
 */
export const encounterDependentKeys = [
  queryKeys.encounters(),
  queryKeys.practitioners(),
  // A booked / rescheduled / removed appointment is a row the Today digest
  // surfaces, so it must appear on the rail in the same tick as the visit
  // list. Pair call sites with `refetchInactiveDailyReads` (or the
  // `invalidateReminderReads` helper, which carries it) — the digest is
  // typically unmounted while the user is on the visits surface.
  queryKeys.dailyDigest(),
];

/**
 * Keys invalidated when a dose is logged, edited, deleted, restored, linked or
 * a booster is minted.
 *
 * The immunization root and the preventive-care root ride together, and that
 * pairing is the whole reason the bundle exists rather than a bare
 * `queryKeys.vaccinations()` eviction: logging a dose runs the satisfy matcher,
 * which re-anchors any booster reminder the dose answers. The checkups list
 * reads that reminder from `["measurement-reminders"]`, so evicting only the
 * dose list would leave a booster on screen the server had already moved a
 * decade out. Both surfaces change on one write; both roots evict on one call.
 *
 * `useVaccinations`' mutations and the booster mint are its consumers.
 */
export const vaccinationDependentKeys = [
  queryKeys.vaccinations(),
  queryKeys.measurementReminders(),
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

/**
 * Force the dashboard snapshot AND the Today digest to refetch even while
 * unmounted. `invalidateKeys` (and every `*DependentKeys` bundle above) marks
 * a query stale with the default `refetchType: "active"`, which only
 * refetches MOUNTED queries — so a write made from the measurement / mood /
 * medication surface leaves the dashboard hero and the Today digest (both
 * typically unmounted while the user is elsewhere) stale until a manual
 * remount re-fetches under `refetchOnMount: false`.
 *
 * Originates from the v1.16.11 dashboard-snapshot fix and the v1.29.1
 * medication-intake fix (`invalidateMedicationReads` in
 * `components/medications/use-medication-intake.ts`, which predates this
 * shared helper and keeps its own inline copy). Call this alongside
 * `invalidateKeys(queryClient, xDependentKeys)` from any write whose server
 * route already hard-evicts the snapshot bucket — the forced refetch then
 * returns post-write data immediately, no server change needed.
 */
export async function refetchInactiveDailyReads(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.dashboardSnapshot(),
      refetchType: "inactive",
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.dailyDigest(),
      refetchType: "inactive",
    }),
  ]);
}

/**
 * The ONE blessed entry point for any intake-affecting medication write. It
 * pairs the dependent-key bundle invalidation with the forced inactive
 * refetch so a taken / skipped / edited / deleted / imported dose clears the
 * Today hero and the dashboard the instant it is recorded — never after the
 * 120 s poll or a hard reload.
 *
 * Route EVERY medication mutation through this instead of calling
 * `invalidateKeys(queryClient, medicationDependentKeys)` directly. The bundle
 * cannot express `refetchType`, so a bare invalidation only refetches MOUNTED
 * queries; the digest and snapshot are typically unmounted while the user is
 * on the medications page (the "Take all due" repro) or a detail page, so
 * they were marked stale but never refetched. This helper closes that gap in
 * one call. The class it closes — a bundle invalidation that never refetches
 * the unmounted daily reads — has recurred three times (v1.16.11, v1.29.1,
 * v1.32.19); `daily-reads-refetch-guard.test.ts` now fails CI if a new site
 * invalidates the bundle without the paired refetch.
 *
 * The server intake routes already hard-evict the `${userId}|` analytics
 * prefix, so the refetch this triggers returns post-write data immediately —
 * no server change is needed at any call site.
 *
 * Sites that need to invalidate an EXTRA key alongside the bundle (the
 * dose-history ledger's own window key) keep their `invalidateKeys([...bundle,
 * localKey])` call and add `refetchInactiveDailyReads(queryClient)` directly;
 * the guard accepts either form.
 */
export async function invalidateMedicationReads(
  queryClient: QueryClient,
): Promise<void> {
  await invalidateKeys(queryClient, medicationDependentKeys);
  await refetchInactiveDailyReads(queryClient);
}
