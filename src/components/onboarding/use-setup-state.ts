"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { SetupStateDto } from "@/lib/setup/types";

/** `GET /api/setup`: the resolved setup state (1.50). */
export function useSetupState(enabled = true) {
  return useQuery({
    queryKey: queryKeys.setupState(),
    queryFn: () => apiGet<SetupStateDto>("/api/setup"),
    enabled,
    staleTime: 30_000,
  });
}

/** `PATCH /api/setup`: hide the setup card, or show it again. */
export function useSetupCardDismissal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.setupCardMutation(),
    mutationFn: (cardDismissed: boolean) =>
      apiPatch<SetupStateDto>("/api/setup", { cardDismissed }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.setupState(), data);
    },
  });
}
