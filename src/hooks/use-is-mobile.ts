"use client";

import { useSyncExternalStore } from "react";

/**
 * Viewport-width hook seeded from a SSR-safe snapshot.
 *
 * v1.4.27 R4 RC3 — the previous `useEffect`-driven flavour returned
 * `false` on the server AND on the first client paint, then flipped to
 * the live value on the effect tick. Two consumers
 * (`<ResponsiveSheet>`, `<CoachDrawer>`) branch their render tree off
 * the value, so a phone-class viewport painted the desktop branch for
 * one frame before swapping. The Coach drawer's `side` flipped from
 * `right` to `bottom` between paints; sheet contents re-mounted and
 * controlled inputs flashed through the wrong layout.
 *
 * The new implementation uses `useSyncExternalStore` with a
 * `matchMedia(...).matches` client snapshot. SSR still resolves to
 * `false` (no `window`), but the very first client render reads the
 * live media-query state synchronously, so the first paint already
 * matches the runtime viewport.
 *
 * Trade-off: SSR markup for phone-class viewports still paints the
 * desktop branch (no React hydration mismatch — both server and the
 * client's first render under the SSR boundary use `false`), then the
 * first client render after hydration flips to the live value. For the
 * two consumers above this is acceptable because both gate visibility
 * on `open`/`isOpen` state — the desktop branch never paints until the
 * user actually opens the sheet/drawer, by which point hydration has
 * already settled and the hook reads the live value on the very first
 * render of the open tree.
 *
 * Defaults to the `md` breakpoint (768 px) because that matches the
 * existing dashboard `md:hidden` / `md:block` switches and the
 * `<ResponsiveSheet>` primitive's bottom-sheet branch. Consumers that
 * need a tighter cut (e.g. the Coach drawer, which flips to a
 * bottom-sheet only below `sm` / 640 px) pass an explicit breakpoint.
 */
function getMediaQuery(breakpoint: "sm" | "md"): string {
  const maxWidth = breakpoint === "sm" ? "639.98px" : "767.98px";
  return `(max-width: ${maxWidth})`;
}

function subscribe(query: string): (callback: () => void) => () => void {
  return (callback) => {
    if (typeof window === "undefined") return () => {};
    const mql = window.matchMedia(query);
    mql.addEventListener("change", callback);
    return () => mql.removeEventListener("change", callback);
  };
}

function getClientSnapshot(query: string): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(query).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useIsMobile(breakpoint: "sm" | "md" = "md"): boolean {
  const query = getMediaQuery(breakpoint);
  return useSyncExternalStore(
    subscribe(query),
    () => getClientSnapshot(query),
    getServerSnapshot,
  );
}
