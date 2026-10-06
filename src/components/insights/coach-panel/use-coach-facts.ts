"use client";

/**
 * v1.41 — what the Coach remembers, as `GET /api/insights/coach/facts` lists
 * it: the one read behind the memory list in Settings → Coach, the memory
 * link's count in the Coach's quick settings and the memory note under an
 * answer. One query function for the one key, so the surfaces share a cache
 * entry and never poison it with two shapes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import type { CoachMemoryCategory } from "@/lib/ai/coach/types";
import type { CoachFactSource } from "@/lib/ai/coach/memory/shared";

export interface CoachFactDTO {
  id: string;
  /** A v1.41 category, or an older extraction's. */
  category: CoachMemoryCategory;
  text: string;
  confidence: number;
  /** Absent on a server older than v1.41. */
  source?: CoachFactSource;
  sourceConversationId?: string | null;
  sourceMessageId?: string | null;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

export async function fetchCoachFacts(): Promise<CoachFactDTO[]> {
  const data = await apiGet<{ facts?: CoachFactDTO[] } | undefined>(
    "/api/insights/coach/facts",
  );
  return data?.facts ?? [];
}

export function useCoachFacts(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.coachFacts(),
    queryFn: fetchCoachFacts,
    enabled: opts.enabled ?? true,
  });
}

/** Forget one fact (soft delete); the list refetches. */
export function useForgetCoachFact(
  opts: {
    onSuccess?: () => void;
    onError?: () => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async (id: string) => {
      await apiDelete(`/api/insights/coach/facts/${encodeURIComponent(id)}`);
      return id;
    },
    onSuccess: () => {
      opts.onSuccess?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => opts.onError?.(),
  });
}

/** Rewrite one fact's wording; the category and the source stay. */
export function useEditCoachFact(
  opts: {
    onSuccess?: () => void;
    onError?: () => void;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async (input: { id: string; fact: string }) =>
      apiPatch(`/api/insights/coach/facts/${encodeURIComponent(input.id)}`, {
        fact: input.fact,
      }),
    onSuccess: () => {
      opts.onSuccess?.();
      void queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => opts.onError?.(),
  });
}
