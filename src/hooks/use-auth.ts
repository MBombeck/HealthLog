"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

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
    queryKey: ["auth", "me"],
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
      queryClient.setQueryData(["auth", "me"], null);
      queryClient.invalidateQueries({ queryKey: ["auth"] });
      router.push("/auth/login");
    },
  });
}
