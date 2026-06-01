/**
 * Shared client refetch cadence for the live dashboard / analytics
 * surfaces.
 *
 * An open page (dashboard tile strip, Insights charts) polls its data
 * source on this interval so freshly-synced Withings / HealthKit
 * readings appear without a manual reload. The poll is backgrounded
 * while the tab is hidden and never touches the LLM surfaces (those
 * stay daily / pre-generated).
 *
 * The server-side dashboard-snapshot cache TTL is keyed off this value
 * (see `src/app/api/dashboard/snapshot/route.ts`) so a scheduled
 * refetch lands on a warm cache entry rather than a guaranteed miss.
 */
export const DASHBOARD_REFETCH_INTERVAL_MS = 120_000;
