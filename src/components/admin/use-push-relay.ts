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
  termsVersion: string;
  termsUrl: string | null;
  privacyUrl: string | null;
  docsUrl: string;
  noticePending: boolean;
}

export function usePushRelayStatus() {
  return useQuery({
    queryKey: queryKeys.adminPushRelay(),
    queryFn: () =>
      apiGet<AdminPushRelayStatus>("/api/admin/push-relay", {
        credentials: "include",
      }),
    staleTime: 30_000,
  });
}

export function useSetPushRelay() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.adminPushRelay(),
    mutationFn: (body: {
      enabled: boolean;
      acceptTerms?: boolean;
      householdOnly?: boolean;
    }) => apiPut<AdminPushRelayStatus>("/api/admin/push-relay", body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.adminPushRelay(), data);
    },
  });
}

export function useDismissPushRelayNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/admin/push-relay/notice"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.adminPushRelay() }),
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
