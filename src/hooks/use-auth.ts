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
  /**
   * v1.5.5 — relative URL of the user's self-hosted avatar, served
   * from `/api/user/avatar/{id}?v={updatedAtMs}`. Replaces the
   * Gravatar leak; null when the user has not uploaded an avatar
   * yet (clients paint the username-initials fallback).
   */
  avatarUrl: string | null;
  glucoseUnit: string | null;
  /**
   * v1.7.0 — global metric/imperial display preference. Canonical
   * storage stays SI; this selects the display-time transform branch
   * (km/h vs mph, km vs mi). Null on a stale /me payload coerces to
   * "metric" in `fetchMe`.
   */
  unitPreference: "metric" | "imperial";
  /**
   * v1.4.47 W3 — per-user Coach opt-out. When `true`, every Coach
   * mount point (`<LayoutCoachFab>`, `<LayoutCoachMount>`, the
   * inline `<CoachLaunchButton>` pill, the `/targets` page CTA)
   * renders nothing. The gate sits BELOW the operator-level
   * `flags.coach` short-circuit — both must agree to render the
   * affordance. Defaults to `false` when the field is absent (e.g.
   * stale /me payload from a partial-deploy rollback).
   */
  disableCoach: boolean;
  /**
   * v1.7.0 — optional patient-identity fields used by the health-record
   * export (PDF cover + FHIR Patient). All optional; `insuranceNumber`
   * is the German KVNR, decrypted server-side for the form prefill.
   */
  fullName: string | null;
  insurerName: string | null;
  insuranceNumber: string | null;
}

async function fetchMe(): Promise<AuthUser> {
  const res = await fetch("/api/auth/me");
  if (!res.ok) throw new Error("Not authenticated");
  const json = await res.json();
  // v1.4.47 W3 — coerce `disableCoach` against `undefined` so a stale
  // /me payload from a partial-deploy rollback (older server image
  // without the field) keeps the Coach surface visible by default.
  const data = json.data as Partial<AuthUser> & {
    id: string;
    username: string;
    role: string;
    timezone: string;
  };
  return {
    ...(data as AuthUser),
    disableCoach: data.disableCoach ?? false,
    // v1.7.0 — coerce against a stale /me payload (older server image
    // without the field) so the display defaults to metric.
    unitPreference: data.unitPreference === "imperial" ? "imperial" : "metric",
  };
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
