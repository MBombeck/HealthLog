"use client";

/**
 * Shared types + status plumbing for the Settings → Integrations cards.
 * Extracted from the former 1.6k-LOC `integrations-section.tsx`
 * monolith; one card per integration lives next to this module under
 * `src/components/settings/integrations/`.
 */

import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";

import type { IntegrationPillState } from "@/components/settings/integration-status-pill";
import { apiGet } from "@/lib/api/api-fetch";
import type {
  MetricFreshnessEntry,
  SyncHealth,
  SyncVerdict,
} from "@/lib/integrations/sync-verdict";
import { queryKeys } from "@/lib/query-keys";

// v1.4.15 Phase B2: shared status payload for both integration cards.
// v1.4.19 Phase A5: the redundant in-card status banner is gone — the
// IntegrationStatusPill now owns state + last-sync presentation, and
// the actionable error message is shown inline above the action row.
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
  | "nightscout";
/** Mirrors `IntegrationState` in `src/lib/integrations/status.ts`. */
export type IntegrationState =
  | "connected"
  | "error_transient"
  | "error_reauth"
  | "disconnected"
  | "parked"
  // v1.38.19 — no ledger row: the ledger has no history for this provider.
  // Read like `disconnected`; `syncHealth.verdict` owns liveness.
  | "unknown";

export interface IntegrationStatusViewModel {
  integration: IntegrationKey;
  state: IntegrationState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  consecutiveFailuresByKind?: {
    transient: number;
    reauth_required: number;
    persistent: number;
  } | null;
  /** Client-side copy of the envelope threshold, attached by `pickStatus`. */
  failureThreshold?: number;
  configured?: boolean;
  connected?: boolean;
  connectedAt?: string | null;
  legacyLastSyncedAt?: string | null;
  tokenExpiresAt?: string | null;
  tokenExpired?: boolean | null;
  enabled?: boolean;
  // Withings activity-scope reconnect banner.
  scope?: string | null;
  hasActivityScope?: boolean;
  // WHOOP / Fitbit backfill-in-progress note.
  backfillCompleted?: boolean | null;
  // v1.27.0 — Google Health surfaces `needsReauth` when the refresh token has
  // lapsed (the 7-day "Testing"-mode expiry, or a revoked grant). The card
  // paints a distinct re-consent CTA off this flag, separate from the parked
  // state. Server-populated on the `/api/integrations/status` envelope.
  needsReauth?: boolean;
  // Polar / Oura OAuth card: usable-credentials + BYO-key flags. `available`
  // greys out the connect button when no credentials resolve; `hasOwnCredentials`
  // drives the saved-placeholder UI.
  available?: boolean;
  hasOwnCredentials?: boolean;
  // Nightscout: a stored token, and the private-network opt-in.
  hasToken?: boolean;
  allowPrivateHost?: boolean;
  /**
   * The server-resolved liveness verdict. Present on every envelope entry;
   * `undefined` only while the envelope is still loading.
   */
  syncHealth?: SyncHealth;
  /** Per-metric last-seen timestamps with the server-computed stale flag. */
  metricFreshness?: MetricFreshnessEntry[];
}

export interface IntegrationStatusEnvelope {
  threshold: number;
  integrations: IntegrationStatusViewModel[];
}

/**
 * Shared status fetch for the Settings → Integrations card. Returns
 * the per-integration view-model AND the global threshold so the
 * "{n}/{threshold} consecutive failures" string in the UI is single-
 * sourced from the server.
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
 * The one verdict→pill mapping in the tree.
 *
 * There used to be three of these, one per card family, and they disagreed:
 * the same ledger state painted red on one card and orange on the next, on the
 * same page. The server now resolves the verdict once and this projects it once
 * — a fourth dialect cannot be minted without the structural guard noticing.
 *
 * `failing` deliberately lands on the warning tone, not the destructive one:
 * **red is reserved for "your action fixes this"** (reconnect, resume). Telling
 * a user to reconnect against a 503 sends them clicking at something they
 * cannot repair; the streak detail survives in the inline error line and the
 * "{n}/{threshold} consecutive failures" string the envelope single-sources.
 */
export function pillStateForVerdict(
  verdict: SyncVerdict | undefined,
): IntegrationPillState {
  switch (verdict) {
    case "fresh":
      return "connected";
    case "stale":
      return "stale";
    case "stalled":
      return "stalled";
    case "failing":
      return "warning";
    case "reauth_required":
      return "error";
    case "parked":
      return "parked";
    case "pending_first_sync":
      return "pending-setup";
    case "disconnected":
    case undefined:
      return "disconnected";
  }
}

/** Project a view-model onto its pill state. Undefined = still loading. */
export function pillStateFor(
  status: IntegrationStatusViewModel | undefined,
): IntegrationPillState {
  return pillStateForVerdict(status?.syncHealth?.verdict);
}

export interface IntegrationPillFailureProps {
  failureCount?: number;
  failureThreshold?: number;
}

/**
 * Pair the largest per-kind streak with the server-owned alert threshold. The
 * alert ladder uses the same maximum, so the ratio cannot disagree with when a
 * notification becomes eligible.
 */
export function pillFailurePropsFor(
  status:
    | Pick<
        IntegrationStatusViewModel,
        "consecutiveFailuresByKind" | "failureThreshold"
      >
    | undefined,
): IntegrationPillFailureProps {
  const buckets = status?.consecutiveFailuresByKind;
  const failureThreshold = status?.failureThreshold;
  if (!buckets || failureThreshold === undefined) return {};

  const failureCount = Math.max(
    buckets.transient,
    buckets.reauth_required,
    buckets.persistent,
  );
  return failureCount > 0 ? { failureCount, failureThreshold } : {};
}

/**
 * The timestamp the pill shows inline. `connected` reads the last success (a
 * connection row's own `lastSyncedAt` wins when it is newer, which is what
 * repaints a fresh "just now" straight after a manual sync); the aging and
 * failing states read the instant that triggered the verdict.
 *
 * `failing` must NOT fall through to the `legacyLastSyncedAt` arm below. That
 * field is a connection row's own clock, kept fresh by the very sync that is
 * erroring, so a provider that had delivered nothing for a fortnight painted a
 * "just now" beside its warning.
 */
export function pillTimestampFor(
  status: IntegrationStatusViewModel | undefined,
): string | null {
  const verdict = status?.syncHealth?.verdict;
  if (verdict === "stale" || verdict === "stalled" || verdict === "failing") {
    return status?.syncHealth?.since ?? null;
  }
  return status?.legacyLastSyncedAt ?? status?.lastSuccessAt ?? null;
}

/**
 * Inline actionable error message that surfaces under the pill when a
 * sync attempt failed. The pill conveys "something is wrong"; this
 * line tells the user *what* is wrong so they can act on it. Keeping
 * it deliberately small (one icon + one line) so it doesn't recreate
 * the v1.4.18 redundant banner the maintainer removed.
 */
export function IntegrationErrorMessage({ message }: { message: string }) {
  return (
    <p
      data-testid="integration-error-message"
      className="text-destructive flex items-start gap-1.5 text-sm"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}
