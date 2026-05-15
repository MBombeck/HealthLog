"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe viewport-width hook. Returns `true` once the browser
 * reports a viewport narrower than the Tailwind `md` breakpoint
 * (768 px). The hook always returns `false` on the server and on
 * the first client paint so SSR markup matches the desktop branch
 * of any viewport-conditional render; the hook then flips on the
 * effect tick once `matchMedia` reports the live value.
 *
 * Used by `<ResponsiveSheet>` to switch between bottom-sheet and
 * centred-dialog mounts. Also consumable by any surface that
 * needs the same boolean (e.g. the Coach drawer's bottom-sheet
 * branch on narrow viewports).
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 767.98px)");
    const sync = () => setIsMobile(mql.matches);
    sync();
    // `addEventListener` is the modern API; the older `addListener`
    // is kept around for legacy Safari but every browser we ship to
    // supports the typed event-listener form.
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  return isMobile;
}
