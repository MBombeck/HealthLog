"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiPatch, apiPost } from "@/lib/api/api-fetch";
import type { OnboardingStateDto } from "@/lib/onboarding/needs";
import { queryKeys } from "@/lib/query-keys";
import type { OnboardingAnswerInput } from "@/lib/validations/onboarding-needs";

interface OnboardingStateEnvelope {
  onboarding: OnboardingStateDto;
}

/**
 * The three writes the setup screens make, as mutations that hand back the
 * published state.
 *
 * Every one of them returns the flow's state after the write, and every
 * screen navigates from THAT rather than from what it thinks it just did —
 * the step machine reads the same ledger the server wrote, so "where next"
 * is never a client-side guess. `authMe` is invalidated because the account
 * payload carries the same state and the checklist reads it from there.
 */
export function useOnboardingAnswer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.onboardingAnswerMutation(),
    mutationFn: async (input: OnboardingAnswerInput) => {
      const { onboarding } = await apiPatch<OnboardingStateEnvelope>(
        "/api/onboarding/answers",
        input,
      );
      return onboarding;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });
}

interface CompleteEnvelope {
  completed: true;
  onboarding?: OnboardingStateDto;
}

/**
 * `POST /api/onboarding/complete` — the confirm screen, and "skip for now".
 *
 * Profile values never ride this body: they go through `PUT /api/auth/profile`
 * (the canonical write, with its per-field refusals). The one field the
 * screen sends is `managedRecordId`, after "someone I look after" created the
 * profile, so the derivation lands on that record and not on the caller's.
 */
export function useOnboardingComplete() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.onboardingCompleteMutation(),
    mutationFn: async (input?: { managedRecordId: string }) =>
      apiPost<CompleteEnvelope>("/api/onboarding/complete", input ?? {}),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });
}

/** `POST /api/onboarding/restart` — "Set up again". */
export function useOnboardingRestart() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.onboardingRestartMutation(),
    mutationFn: async () => {
      const { onboarding } = await apiPost<OnboardingStateEnvelope>(
        "/api/onboarding/restart",
        {},
      );
      return onboarding;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    },
  });
}

/** The route of one setup screen. */
export function screenHref(screen: string): string {
  return screen === "welcome" ? "/onboarding" : `/onboarding/${screen}`;
}
