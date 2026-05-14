"use client";

import { useCallback, useState } from "react";

import type { CoachScope } from "@/lib/ai/coach/types";

/**
 * v1.4.25 W3e — controlled state for the Coach drawer when mounted
 * outside the `/insights` page (currently `/targets`, future
 * `/insights/<metric>` sub-pages).
 *
 * Encapsulates the open / prefill / scope triple so each new surface
 * only has to mount `<CoachDrawer>` and wire the page-level CTAs to
 * the returned `askCoach()` callback. The drawer itself owns no
 * cross-surface state; this hook is the binding point.
 *
 * Reset behaviour mirrors the v1.4.20 Insights pattern: closing the
 * drawer clears prefill so the next open starts blank unless a CTA
 * supplies a fresh prefill.
 */
export interface CoachHandoffApi {
  coachOpen: boolean;
  setCoachOpen: (next: boolean) => void;
  coachPrefill: string | null;
  coachScope: CoachScope | null;
  askCoach: (payload: { prefill: string; scope: CoachScope }) => void;
}

export function useCoachHandoff(): CoachHandoffApi {
  const [coachOpen, setOpen] = useState(false);
  const [coachPrefill, setPrefill] = useState<string | null>(null);
  const [coachScope, setScope] = useState<CoachScope | null>(null);

  const setCoachOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setPrefill(null);
      setScope(null);
    }
  }, []);

  const askCoach = useCallback(
    ({ prefill, scope }: { prefill: string; scope: CoachScope }) => {
      setPrefill(prefill);
      setScope(scope);
      setOpen(true);
    },
    [],
  );

  return { coachOpen, setCoachOpen, coachPrefill, coachScope, askCoach };
}
