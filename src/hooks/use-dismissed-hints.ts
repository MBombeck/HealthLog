"use client";

/**
 * The one way a one-time hint asks whether it was put away, and puts itself
 * away: the account's `dismissedHints` on `/api/auth/me`, written through
 * `PATCH /api/auth/me/dismissed-hints`. Registry and rules:
 * `src/lib/hints/dismissible-hints.ts`.
 *
 * Closing is optimistic: the cached account drops the hint at once, and a
 * failed write keeps it hidden for this visit rather than flashing it back.
 * Until the account has loaded every hint reads as dismissed, so nothing
 * shows and then disappears.
 *
 * Dismissals this browser kept in local storage before they moved to the
 * account are carried over once (`adoptLegacyDismissals`), so nobody sees a
 * hint again that they had already closed here.
 */
import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth, type AuthUser } from "@/hooks/use-auth";
import { apiPatch } from "@/lib/api/api-fetch";
import {
  nextDismissedHints,
  type DismissibleHint,
} from "@/lib/hints/dismissible-hints";
import { readLegacyDismissals } from "@/lib/hints/legacy-dismissals";
import { queryKeys } from "@/lib/query-keys";

/** Whether `id`, or the family it belongs to, is in `list`. */
export function isHintDismissed(list: readonly string[], id: string): boolean {
  if (list.includes(id)) return true;
  const dot = id.indexOf(".");
  return dot !== -1 && list.includes(id.slice(0, dot));
}

type Change = { dismiss?: string[]; restore?: string[] };

// One carry-over per page load, however many hints mount.
let legacyAdoptedFor: string | null = null;

export function useDismissedHints() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const list = useMemo(
    () => (user ? (user.dismissedHints ?? []) : null),
    [user],
  );

  const apply = useCallback(
    async (change: Change): Promise<boolean> => {
      queryClient.setQueryData<AuthUser | null>(queryKeys.authMe(), (prev) =>
        prev
          ? {
              ...prev,
              dismissedHints: nextDismissedHints(
                prev.dismissedHints ?? [],
                change,
              ),
            }
          : prev,
      );
      try {
        const saved = await apiPatch<{ dismissedHints: string[] }>(
          "/api/auth/me/dismissed-hints",
          change,
        );
        queryClient.setQueryData<AuthUser | null>(queryKeys.authMe(), (prev) =>
          prev ? { ...prev, dismissedHints: saved.dismissedHints } : prev,
        );
        return true;
      } catch {
        // Not stored: the change holds in this visit's cache only.
        return false;
      }
    },
    [queryClient],
  );

  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId === null || list === null || legacyAdoptedFor === userId) {
      return;
    }
    legacyAdoptedFor = userId;
    const legacy = readLegacyDismissals(userId);
    const missing = legacy.ids.filter((id) => !isHintDismissed(list, id));
    if (missing.length === 0) {
      legacy.forget();
      return;
    }
    void apply({ dismiss: missing }).then((ok) => {
      if (ok) legacy.forget();
    });
  }, [userId, list, apply]);

  return {
    /** False once the account has loaded; until then every hint stays hidden. */
    loading: list === null,
    isDismissed: (family: DismissibleHint, member?: string): boolean =>
      list === null ||
      isHintDismissed(
        list,
        member === undefined ? family : `${family}.${member}`,
      ),
    dismiss: (...ids: string[]) => apply({ dismiss: ids }),
    restore: (...ids: string[]) => apply({ restore: ids }),
    /** The stored ids, `[]` until the account has loaded. */
    ids: list ?? [],
  };
}
