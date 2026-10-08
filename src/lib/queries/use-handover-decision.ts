"use client";

/**
 * v1.42 (#959) — the decision a new owner owes about their former Guardians,
 * after claiming a managed profile.
 *
 * Read by the decision screen the claim lands on (`/onboarding/handover`) and
 * by the card at the top of Settings → Shared access, which keeps offering it
 * until it is made. Deciding refreshes the grant reads as well, because every
 * change it makes is an ordinary grant row the sharing panel lists.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost } from "@/lib/api/api-fetch";
import type { HandoverAccess } from "@/lib/managed-profiles/handover-access";
import { invalidateGrantReads } from "@/lib/queries/use-account-grants";
import { queryKeys } from "@/lib/query-keys";

export interface PendingHandoverGuardian {
  grantId: string;
  displayName: string;
  proposal: HandoverAccess;
  current: HandoverAccess;
  decidable: boolean;
}

export interface HandoverDecisionState {
  pending: {
    claimedAt: string;
    guardians: PendingHandoverGuardian[];
  } | null;
}

export function useHandoverDecision(enabled = true) {
  return useQuery({
    queryKey: queryKeys.handoverDecision(),
    queryFn: () =>
      apiGet<HandoverDecisionState>("/api/account/handover-decision"),
    enabled,
  });
}

/** The wire body, composed once and exported for the integration suite. */
export function handoverDecisionBody(
  decisions: { grantId: string; access: HandoverAccess }[],
): { decisions: { grantId: string; access: HandoverAccess }[] } {
  return {
    decisions: decisions.map((d) => ({ grantId: d.grantId, access: d.access })),
  };
}

export function useDecideHandover() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.handoverDecide(),
    mutationFn: (decisions: { grantId: string; access: HandoverAccess }[]) =>
      apiPost<{ decided: true; changed: number }>(
        "/api/account/handover-decision",
        handoverDecisionBody(decisions),
      ),
    onSuccess: () => {
      invalidateGrantReads(queryClient);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.handoverDecision(),
      });
    },
  });
}
