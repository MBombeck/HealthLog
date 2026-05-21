"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { queryKeys } from "@/lib/query-keys";

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  role: string;
  heightCm: number | null;
  dateOfBirth: string | null;
  gender: string | null;
  timezone: string;
  onboardingCompletedAt: string | null;
  /**
   * v1.4.15 Phase B5: whether the user has finished or dismissed
   * the spotlight tour overlaid on the dashboard. Distinct from
   * `onboardingCompletedAt` (the wizard at /onboarding) — see the
   * `<TourLauncher>` component for the gating logic.
   */
  onboardingTourCompleted: boolean;
  gravatarUrl: string | null;
  glucoseUnit: string | null;
}

async function fetchMe(): Promise<AuthUser> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) throw new Error("Not authenticated");
  const json = await res.json();
  return json.data;
}

export function useAuth() {
  const query = useQuery({
    // v1.4.40 W-RSC — factory-routed to `queryKeys.authMe()`. Pre-fix
    // the literal `["auth", "me"]` was the canonical example in
    // audit-H1 of factory drift. The prefix `["auth"]` still matches
    // `queryKeys.auth()` invalidations.
    queryKey: queryKeys.authMe(),
    queryFn: fetchMe,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data,
    error: query.error,
    refetch: query.refetch,
  };
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();

  return useMutation({
    mutationFn: async () => {
      await fetch("/api/auth/logout", { method: "POST" });
    },
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.authMe(), null);
      queryClient.invalidateQueries({ queryKey: queryKeys.auth() });
      router.push("/auth/login");
    },
  });
}
