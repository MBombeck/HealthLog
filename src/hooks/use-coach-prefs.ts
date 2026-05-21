"use client";

import { useQuery } from "@tanstack/react-query";

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
