"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import {
  DEFAULT_COACH_PREFS,
  type CoachPrefs,
} from "@/lib/validations/coach-prefs";

/**
 * v1.4.23 W6 (S-03) — shared accessor for the per-user Coach
 * preferences row. Both the Coach drawer's settings sheet and the
 * message-thread evidence-disclosure default consume the same
 * `/api/auth/me/coach-prefs` payload; before the extraction the two
 * call sites duplicated the same `useQuery` block with subtly
 * different fallback semantics (one threw on `!ok`, the other returned
 * defaults). The hook centralises the cache key, the envelope unwrap,
 * and the "treat fetch failure as defaults" stance so the next surface
 * (insights cog, settings tab) inherits a single source of truth.
 *
 * The query is gated on `enabled` so the settings sheet can defer the
 * fetch until the sheet actually opens. Callers that always want the
 * row (message thread) leave it unset (defaults to true).
 */
export function useCoachPrefs(opts?: { enabled?: boolean }) {
  return useQuery<CoachPrefs>({
    queryKey: queryKeys.coachPrefs(),
    queryFn: async () => {
      const res = await fetch("/api/auth/me/coach-prefs");
      if (!res.ok) return DEFAULT_COACH_PREFS;
      const env = (await res.json()) as { data: CoachPrefs };
      return env.data;
    },
    enabled: opts?.enabled,
  });
}

/**
 * v1.7.2 — shared writer for the Coach preferences row. Both the
 * settings sheet and the chat-side sources rail persist the same
 * `coachPrefsJson` through `PUT /api/auth/me/coach-prefs`, so the write
 * path lives here next to the reader. On success the canonical defaulted
 * shape the route echoes back is seeded into the `coachPrefs()` cache so
 * every surface that reads the hook re-renders against one source of
 * truth — the rail and the cog can never drift.
 */
export function useSaveCoachPrefs(opts?: { onSuccess?: () => void }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachPrefs(),
    mutationFn: async (next: CoachPrefs) => {
      const res = await fetch("/api/auth/me/coach-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) throw new Error("coach-prefs.save_failed");
      return (await res.json()) as { data: CoachPrefs };
    },
    onSuccess: (envelope) => {
      queryClient.setQueryData<CoachPrefs>(
        queryKeys.coachPrefs(),
        envelope.data,
      );
      opts?.onSuccess?.();
    },
  });
}
