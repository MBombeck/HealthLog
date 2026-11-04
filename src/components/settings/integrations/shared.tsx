"use client";

/**
 * Shared types + status plumbing for the Settings → Integrations cards.
 * Extracted from the former 1.6k-LOC `integrations-section.tsx`
 * monolith; one card per integration lives next to this module under
 * `src/components/settings/integrations/`.
 */

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import type { GoogleHealthBackfillEndedEntry } from "@/lib/google-health/backfill-progress";
import type { ConnectionHealth } from "@/lib/integrations/connection-health";
import type { MetricFreshnessEntry } from "@/lib/integrations/sync-verdict";
import { queryKeys } from "@/lib/query-keys";
import type { PublishedFitbitRetirement } from "@/lib/fitbit/retirement";
import type { GarminKeyExpiry } from "@/lib/garmin/key-expiry";
import type { GarminBackfillStep } from "@/lib/garmin/backfill-progress";

export type IntegrationKey =
  | "withings"
  | "whoop"
  | "fitbit"
  | "polar"
  | "oura"
  // v1.27.0 — Google Health (Fitbit + Pixel Watch + Fitbit Air).
  | "google-health"
  // v1.28.x — Strava OAuth workout source.
  | "strava"
  // Nightscout folds onto the envelope so the card stops fetching its own
  // status and inherits the shared verdict.
  | "nightscout"
  // v1.43 — Dawarich movement context; publishes `health` only.
  | "dawarich"
  // Garmin Personal API; a pasted key, like Nightscout.
  | "garmin";
/**
 * One envelope entry as the cards read it. Since v1.42.4 the cards render
 * `health` alone; the older health-shaped fields (ledger `state`, `lastError`,
 * `syncHealth`, token expiry, plan and scope lists, `needsReauth`) stay on the
 * wire for one transition release and are deliberately not declared here, so
 * the compiler refuses a card that starts reading them again.
 */
export interface IntegrationStatusViewModel {
  integration: IntegrationKey;
  /**
   * The one server-resolved state (ok / limited / degraded / action_required),
   * null while the provider is not connected.
   */
  health?: ConnectionHealth | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  /** Client-side copy of the envelope threshold, attached by `pickStatus`. */
  failureThreshold?: number;
  configured?: boolean;
  connected?: boolean;
  /** WHOOP / Fitbit / Google Health / Garmin: older history still loading. */
  backfillCompleted?: boolean | null;
  /**
   * Google Health: data types whose history backfill ended before the start
   * of their history, with where and why.
   */
  backfillEnded?: GoogleHealthBackfillEndedEntry[];
  /**
   * Polar / Oura / Strava: usable credentials resolve (BYO or the shared
   * app). Greys out "Connect" when false.
   */
  available?: boolean;
  /** Polar / Oura / Strava: the person stored their own client id/secret. */
  hasOwnCredentials?: boolean;
  /** Nightscout: a stored token. */
  hasToken?: boolean;
  /** Garmin: when the stored key stops working, resolved on the server. */
  keyExpiry?: GarminKeyExpiry | null;
  /** Garmin: resources Garmin refuses for this account, for the details. */
  unavailableResources?: GarminBackfillStep[] | null;
  /** Per-metric last-seen timestamps with the server-computed stale flag. */
  metricFreshness?: MetricFreshnessEntry[];
  /** Fitbit: the end of the legacy Web API, resolved on the server. */
  retirement?: PublishedFitbitRetirement;
}

export interface IntegrationStatusEnvelope {
  threshold: number;
  integrations: IntegrationStatusViewModel[];
}

/**
 * Shared status fetch for the Settings → Integrations cards. Returns the
 * per-integration view-model and the global failure threshold.
 */
export function useIntegrationStatuses(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.integrationsStatus(),
    queryFn: async () => {
      return apiGet<IntegrationStatusEnvelope>("/api/integrations/status");
    },
    enabled,
    refetchOnWindowFocus: true,
  });
}

export function pickStatus(
  envelope: IntegrationStatusEnvelope | undefined,
  integration: IntegrationKey,
): IntegrationStatusViewModel | undefined {
  const status = envelope?.integrations.find(
    (entry) => entry.integration === integration,
  );
  return status
    ? { ...status, failureThreshold: envelope?.threshold }
    : undefined;
}

/**
 * The current failure streak paired with the server-owned alert threshold, for
 * the card's copied diagnostics. The card itself shows no counter: whether a
 * streak matters is already in `health`. The alert ladder uses the same
 * maximum, so the ratio cannot disagree with when a notification goes out.
 */
export function failureStreakFor(
  status:
    | Pick<
        IntegrationStatusViewModel,
        "consecutiveFailuresByKind" | "failureThreshold"
      >
    | undefined,
): { count: number; threshold: number } | null {
  const buckets = status?.consecutiveFailuresByKind;
  const threshold = status?.failureThreshold;
  if (!buckets || threshold === undefined) return null;
  const count = Math.max(
    buckets.transient,
    buckets.reauth_required,
    buckets.persistent,
  );
  return count > 0 ? { count, threshold } : null;
}
