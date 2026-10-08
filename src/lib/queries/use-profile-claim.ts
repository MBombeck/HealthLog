"use client";

/**
 * v1.42 (#959) — the anonymous side of a managed-profile handover: the
 * preview of a link and the claim itself.
 *
 * The token travels in request BODIES only, never in a query key: a cache key
 * is somewhere a credential must not be written, and the preview key is one
 * fixed value because one claim page reads one link.
 */
import { useMutation, useQuery } from "@tanstack/react-query";

import { apiPost } from "@/lib/api/api-fetch";
import type { HandoverAccess } from "@/lib/managed-profiles/handover-access";
import { queryKeys } from "@/lib/query-keys";

export interface ProfileClaimPreview {
  displayName: string | null;
  expiresAt: string;
  guardians: {
    displayName: string | null;
    proposal: HandoverAccess;
  }[];
}

export function useProfileClaimPreview(token: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.profileClaimPreview(),
    queryFn: () =>
      apiPost<ProfileClaimPreview>("/api/auth/claim/preview", { token }),
    enabled: enabled && token !== null,
    // A 404 is an answer, not a blip, and a retry would only spend the
    // per-address budget the claim itself needs.
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/** Exactly the body `POST /api/auth/claim` accepts. */
export interface ProfileClaimInput {
  token: string;
  username: string;
  email: string;
  password: string;
}

export function claimBody(input: ProfileClaimInput): ProfileClaimInput {
  return {
    token: input.token,
    username: input.username,
    email: input.email,
    password: input.password,
  };
}

export function useClaimProfile() {
  return useMutation({
    mutationKey: queryKeys.profileClaim(),
    mutationFn: (input: ProfileClaimInput) =>
      apiPost<{ userId: string; username: string }>(
        "/api/auth/claim",
        claimBody(input),
      ),
  });
}
