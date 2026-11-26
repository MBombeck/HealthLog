"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/** `GET /api/admin/push-relay`. */
export interface AdminPushRelayStatus {
  allowed: boolean;
  available: boolean;
  unavailableReason: "mode_off" | "invalid_url" | "keys_unpinned" | null;
  relayHost: string | null;
  offered: boolean;
  state: "ok" | "degraded" | "down" | "off";
  since: string | null;
  reason: string | null;
  instanceId: string | null;
  tier: string | null;
  notice: { id: string; level: string | null } | null;
  lastSuccessAt: string | null;
  devices: { bound: number; consented: number };
  /** Absent on a response from a build before the field. */
  usage?: {
    windowDays: number;
    accepted: number;
    pending: number;
    dropped: number;
    failed: number;
    lastFailure: { reason: string | null; at: string } | null;
  };
  /**
   * From queueing a push on this server to the relay's `accepted`, over the
   * pushes accepted in the window. Absent on a response from a build before
   * the field.
   */
  handoff?: {
    windowHours: number;
    count: number;
    /** Whole milliseconds; null when `count` is 0. */
    p50Ms: number | null;
    p95Ms: number | null;
    /** How many of them waited for at least one retry on this server. */
    retried: number;
  };
  /**
   * The hourly signed `GET /v1/status`: when it was asked and what the relay
   * last answered. Null before the first check; absent on a response from a
   * build before the field.
   */
  relayCheck?: {
    checkedAt: string | null;
    answeredAt: string | null;
    state: "ok" | "degraded" | "maintenance" | "misconfigured" | null;
    devices: { active: number; provisional: number; limit: number } | null;
  } | null;
  termsVersion: string;
  /** The relay is on and its accepted terms text is older than `termsVersion`. */
  termsConfirmationNeeded: boolean;
  /** Device unbinds owed to the relay that it has not confirmed yet. */
  unbindsPending: number;
  /** Relay hosts still registered that the current settings cannot reach. */
  unreachableRegistrations: string[];
  termsUrl: string | null;
  privacyUrl: string | null;
  docsUrl: string;
  /**
   * An APNs key of this server's own is in use: every push goes directly to
   * Apple and the relay is not used while it is set.
   */
  ownApnsKey: boolean;
  /**
   * The one state the card's status pill shows, resolved on the server
   * (`relaySummaryState`): the own APNs key first, then a relay this server
   * cannot use, then the relay's health.
   */
  summaryState:
    "own_apns_key" | "unavailable" | "ok" | "degraded" | "down" | "off";
  /** The operator's one answer to the relay question (`operator-decision.ts`). */
  operatorDecision: "undecided" | "on" | "off";
}

/**
 * The relay status. Admin only: a surface that non-admins see too passes
 * `enabled: false` for them, so their session never asks.
 */
export function usePushRelayStatus({
  enabled = true,
}: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.adminPushRelay(),
    queryFn: () =>
      apiGet<AdminPushRelayStatus>("/api/admin/push-relay", {
        credentials: "include",
      }),
    staleTime: 30_000,
    enabled,
  });
}

/** The devices of `GET /api/admin/notifications/diagnostic`, as far as read here. */
export interface AdminDiagnosticDevices {
  devices: Array<{
    /** Absent on a response from a build before the field. */
    liveActivityStart?:
      | "ready"
      | "switch_off"
      | "not_bound"
      | "no_consent"
      | "no_start_token"
      | null;
  }>;
}

/** The calling admin's own devices from the notification diagnostic. */
export function useAdminDiagnosticDevices({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: queryKeys.adminNotificationDiagnostic(),
    queryFn: () =>
      apiGet<AdminDiagnosticDevices>("/api/admin/notifications/diagnostic", {
        credentials: "include",
      }),
    staleTime: 60_000,
    enabled,
  });
}

/** The body the switch and the relay question's answer both take. */
export interface PushRelaySwitchBody {
  enabled: boolean;
  acceptTerms?: boolean;
  householdOnly?: boolean;
  invite?: string;
}

/**
 * The status both mutations answer with, adopted; `/api/auth/me` carries the
 * decision too (`push.relay.operatorDecision`), so it is read again.
 */
function useAdoptRelayStatus() {
  const queryClient = useQueryClient();
  return (data: AdminPushRelayStatus) => {
    queryClient.setQueryData(queryKeys.adminPushRelay(), data);
    void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
  };
}

export function useSetPushRelay() {
  const adopt = useAdoptRelayStatus();
  return useMutation({
    mutationKey: queryKeys.adminPushRelay(),
    mutationFn: (body: PushRelaySwitchBody) =>
      apiPut<AdminPushRelayStatus>("/api/admin/push-relay", body),
    onSuccess: adopt,
  });
}

/** `POST /api/admin/push-relay/decision`: the answer to the relay question. */
export function useAnswerPushRelayQuestion() {
  const adopt = useAdoptRelayStatus();
  return useMutation({
    mutationFn: (body: PushRelaySwitchBody) =>
      apiPost<AdminPushRelayStatus>("/api/admin/push-relay/decision", body),
    onSuccess: adopt,
  });
}

export interface PushRelayTestResult {
  outcome: "accepted" | "failed" | "waiting" | "no_device";
  results: Array<{
    deviceId: string;
    model: string | null;
    relayStatus: number;
    relayResult: string;
    relayReason: string | null;
    delivery: string;
  }>;
}

export function useSendPushRelayTest() {
  return useMutation({
    mutationFn: () =>
      apiPost<PushRelayTestResult>("/api/admin/push-relay/test"),
  });
}

export function useRotatePushRelayKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{
        outcome: "rotated" | "refused" | "unreachable" | "not_registered";
      }>("/api/admin/push-relay/rotate-key"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.adminPushRelay() }),
  });
}
