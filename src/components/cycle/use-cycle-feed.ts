"use client";

/**
 * #1350 — the calendar subscription's read and write hooks.
 *
 * Every value the card shows is the server's: the status read carries the
 * options, the fetch statistics as a calendar-app family, and the projection
 * state that explains a shorter feed. The URL exists in the client only in
 * the one mint or rotate response that returns it, held in the card's state
 * and gone when the card unmounts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

import type { ProjectionState } from "./types";

export type FeedTitleMode = "DISCREET" | "DESCRIPTIVE";
export type FeedFetcher = "GOOGLE" | "APPLE" | "MICROSOFT" | "OTHER";

export interface CycleFeedSummary {
  tokenPrefix: string;
  createdAt: string;
  lastFetchedAt: string | null;
  fetchCount: number;
  lastFetcher: FeedFetcher | null;
  horizonCycles: number;
  historyCycles: number;
  includeFertile: boolean;
  titleMode: FeedTitleMode;
}

export interface CycleFeedStatus {
  feed: CycleFeedSummary | null;
  projectionState: ProjectionState | null;
  fertileAvailable: boolean;
}

export interface CycleFeedMinted {
  url: string;
  webcalUrl: string;
  feed: CycleFeedSummary;
}

export type CycleFeedOptionsPatch = Partial<
  Pick<
    CycleFeedSummary,
    "horizonCycles" | "historyCycles" | "includeFertile" | "titleMode"
  >
>;

const PATH = "/api/cycle/feed-subscription";

export function useCycleFeedStatus(enabled = true) {
  return useQuery({
    queryKey: queryKeys.cycleFeedSubscription(),
    queryFn: () => apiGet<CycleFeedStatus>(PATH),
    staleTime: 60_000,
    enabled,
  });
}

function useInvalidateStatus() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({ queryKey: queryKeys.cycleFeedSubscription() });
}

/**
 * Turn the subscription on, or rotate its link. `proof` is the recent-proof
 * flow: both answer 401 `auth.reproof.required` without a fresh proof, and
 * `proof.run` opens the re-proof dialog and retries.
 */
export function useMintCycleFeed(proof: {
  run: <T>(action: () => Promise<T>) => Promise<T>;
}) {
  const invalidate = useInvalidateStatus();
  return useMutation({
    mutationKey: queryKeys.cycleFeedSubscription(),
    mutationFn: (kind: "create" | "rotate") =>
      kind === "create"
        ? proof.run(() =>
            apiPost<CycleFeedMinted>("/api/cycle/feed-subscription"),
          )
        : proof.run(() =>
            apiPost<CycleFeedMinted>("/api/cycle/feed-subscription/rotate"),
          ),
    onSettled: () => invalidate(),
  });
}

export function useUpdateCycleFeed() {
  const invalidate = useInvalidateStatus();
  return useMutation({
    mutationKey: queryKeys.cycleFeedSubscription(),
    mutationFn: (patch: CycleFeedOptionsPatch) =>
      apiPatch<CycleFeedStatus>(PATH, patch),
    onSettled: () => invalidate(),
  });
}

export function useRevokeCycleFeed() {
  const invalidate = useInvalidateStatus();
  return useMutation({
    mutationKey: queryKeys.cycleFeedSubscription(),
    mutationFn: () => apiDelete<{ revoked: true }>(PATH),
    onSettled: () => invalidate(),
  });
}
