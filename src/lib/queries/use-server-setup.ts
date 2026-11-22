"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type {
  ServerSetupState,
  ServerSetupStepId,
} from "@/lib/admin/server-setup";
import type { SetupHealth } from "@/lib/admin/setup-health-model";
import { apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/** `GET /api/admin/server-setup`; admin-only and cookie-only. */
export function useServerSetup({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.adminServerSetup(),
    queryFn: () =>
      apiGet<ServerSetupState>("/api/admin/server-setup", {
        credentials: "include",
      }),
    staleTime: 30_000,
    enabled,
  });
}

/** `PATCH /api/admin/server-setup`: one step done or skipped. */
export function useServerSetupStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.adminServerSetup(),
    mutationFn: (body: {
      step: ServerSetupStepId;
      status: "done" | "skipped";
    }) => apiPatch<ServerSetupState>("/api/admin/server-setup", body),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.adminServerSetup(), data);
    },
  });
}

export function useDismissServerSetupNotice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost("/api/admin/server-setup/notice"),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminServerSetup(),
      }),
  });
}

/** `GET /api/admin/setup-health`; admin-only and cookie-only. */
export function useSetupHealth() {
  return useQuery({
    queryKey: queryKeys.adminSetupHealth(),
    queryFn: () =>
      apiGet<SetupHealth>("/api/admin/setup-health", {
        credentials: "include",
      }),
    staleTime: 60_000,
  });
}
