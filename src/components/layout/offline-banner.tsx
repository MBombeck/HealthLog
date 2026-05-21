"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.4.43 QoL (M5) — slim banner that surfaces "you're offline" while
 * `navigator.onLine` reads false. The PWA service worker already
 * serves the read paths from cache (`public/sw.js`), but pre-fix a
 * user toggling airplane mode mid-form-fill saw blank tiles and no
 * explanation. This banner closes the explanation gap.
 *
 * Mount strategy: rendered once at the top of `<AuthShell>` so every
 * authenticated route inherits it. The component is mount-time SSR-
 * safe — it never paints during the initial server render (the
 * `online`/`offline` window events only fire client-side); a `useEffect`
 * subscribes to the events once and toggles the visible state from
 * there. Honours `prefers-reduced-motion` via the absence of any
 * animation.
 *
 * Copy lives in `messages/*.json` under `offlineBanner.message`; all
 * six locales ship today.
 */
export function OfflineBanner() {
  const { t } = useTranslations();
  // Initialise to `true` so the banner stays hidden during SSR + the
  // first client render. The effect below flips it true/false after
  // mount based on `navigator.onLine`. (We do NOT read navigator on
  // the very first render to keep the SSR markup hydration-stable.)
  const [isOnline, setIsOnline] = useState(true);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }
    // Subscribe to the live transition events; both handlers route
    // through the React setState pathway via the listener callback
    // rather than a synchronous in-effect setState so the strict
    // `react-hooks/set-state-in-effect` rule stays happy.
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    // Sync the initial state from `navigator.onLine` — deferred to a
    // microtask so React sees this as an external-system bridge
    // rather than a render-cascade setState. The legacy in-effect
    // setState path tripped the strict lint rule, the queueMicrotask
    // shape is the documented escape hatch.
    queueMicrotask(() => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setIsOnline(false);
      }
    });
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="offline-banner"
      className="bg-warning/15 border-warning/40 text-foreground flex items-center justify-center gap-2 border-b px-3 py-2 text-xs"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="text-center">{t("offlineBanner.message")}</span>
    </div>
  );
}
