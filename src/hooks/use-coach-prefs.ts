"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import {
  readUpdatedAtToken,
  withBaseToken,
  isConflict,
} from "@/lib/api/optimistic-token";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";

/**
 * v1.32.22 — the cached Coach-prefs row carries the optimistic-
 * concurrency token (`User.updatedAt`) alongside its payload so the writer
 * can echo it. The read query and the save mutation both speak this shape;
 * the token is opaque (the client only ever echoes a server-returned value).
 */
type CoachPrefsWithToken = CoachPrefs & { updatedAt?: string };

/**
 * v1.4.23 — shared accessor for the per-user Coach
 * preferences row. Both the Coach drawer's settings sheet and the
 * message-thread evidence-disclosure default consume the same
 * `/api/auth/me/coach-prefs` payload; before the extraction the two
 * call sites duplicated the same `useQuery` block with subtly
 * different fallback semantics. The hook centralises the cache key and the
 * envelope unwrap so the next surface (insights cog, settings tab) inherits
 * a single source of truth. A failed read is an error state: no surface may
 * save over a document it never loaded.
 *
 * The query is gated on `enabled` so the settings sheet can defer the
 * fetch until the sheet actually opens. Callers that always want the
 * row (message thread) leave it unset (defaults to true).
 */
export function useCoachPrefs(opts?: { enabled?: boolean }) {
  return useQuery<CoachPrefsWithToken>({
    queryKey: queryKeys.coachPrefs(),
    // A failed read is an error, not the defaults. Every writer spreads the
    // cached document into a whole-document PUT and gates on having one; a
    // read that answered the defaults (with no revision token to send) let
    // the next switch replace every stored preference unconditionally. The
    // readers fall back to the defaults themselves.
    queryFn: () => apiGet<CoachPrefsWithToken>("/api/auth/me/coach-prefs"),
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
export function useSaveCoachPrefs(opts?: {
  onSuccess?: () => void;
  /** Fired when a write 409s because the row advanced since it was loaded. */
  onConflict?: () => void;
  /** Fired for every non-conflict write error, if the caller wants to surface it. */
  onError?: (err: unknown) => void;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.coachPrefs(),
    // v1.32.22 — echo the base token this edit was based on so a
    // concurrent write to the same row (another tab, the chat sources rail)
    // 409s instead of silently overwriting the newer state. Read straight from
    // the cache at mutate time so it reflects the latest settled write.
    mutationFn: async (next: CoachPrefs) =>
      apiPut<CoachPrefsWithToken>(
        "/api/auth/me/coach-prefs",
        withBaseToken(
          next,
          readUpdatedAtToken(queryClient, queryKeys.coachPrefs()),
        ),
      ),
    onSuccess: (data) => {
      queryClient.setQueryData<CoachPrefsWithToken>(
        queryKeys.coachPrefs(),
        data,
      );
      opts?.onSuccess?.();
    },
    onError: (err) => {
      // v1.32.22 — a 409 means the stored prefs advanced since this edit
      // was based. Refetch so the token advances and the form re-syncs to the
      // fresh server state, then let the caller nudge gently — nothing was
      // clobbered. Every other error is handed back to the caller.
      if (isConflict(err)) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.coachPrefs(),
        });
        opts?.onConflict?.();
        return;
      }
      opts?.onError?.(err);
    },
  });
}
