"use client";

import { useEffect } from "react";

/**
 * v1.4.33 IW9 — single source of truth for the "scroll to top on
 * route mount" affordance.
 *
 * The pre-v1.4.33 wiring had `<SubPageShell>` AND the insights mother
 * page each firing their own `requestAnimationFrame → scrollTo({top:0})`
 * on mount. Two consumers doing the same trick is the kind of
 * duplication that drifts; the second `scrollTo` lands ~16 ms after the
 * first and re-snaps the viewport once the chart skeleton has inflated.
 * On slow hydrates the user sees a visible "jump" — exactly the
 * complaint in `.planning/round-v1433-audit-polish.md` §2.1.
 *
 * This hook is the single owner of that reset. Both the shell and the
 * mother page call into it; the effect is mount-only and uses
 * `requestAnimationFrame` so the scroll lands after the first paint
 * (chart skeleton heights have settled, no double-snap).
 *
 * `behavior: "auto"` is intentional — `prefers-reduced-motion` users
 * get the same instant reset everyone else does. A smooth scroll on
 * a route change is itself a motion that some users opt out of.
 */
export function useScrollResetOnRoute() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handle = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(handle);
  }, []);
}
