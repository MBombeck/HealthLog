"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe viewport-width hook. Returns `true` once the browser
 * reports a viewport narrower than the requested Tailwind
 * breakpoint. The hook always returns `false` on the server and
 * on the first client paint so SSR markup matches the desktop
 * branch of any viewport-conditional render; the hook then flips
 * on the effect tick once `matchMedia` reports the live value.
 *
 * Defaults to the `md` breakpoint (768 px) because that matches
 * the existing dashboard `md:hidden` / `md:block` switches and
 * the `<ResponsiveSheet>` primitive's bottom-sheet branch.
 * Consumers that need a tighter cut (e.g. the Coach drawer, which
 * flips to a bottom-sheet only below `sm` / 640 px) pass an
 * explicit breakpoint.
 */
export function useIsMobile(breakpoint: "sm" | "md" = "md"): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const maxWidth = breakpoint === "sm" ? "639.98px" : "767.98px";
    const mql = window.matchMedia(`(max-width: ${maxWidth})`);
    const sync = () => setIsMobile(mql.matches);
    sync();
    // `addEventListener` is the modern API; the older `addListener`
    // is kept around for legacy Safari but every browser we ship to
    // supports the typed event-listener form.
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, [breakpoint]);

  return isMobile;
}
