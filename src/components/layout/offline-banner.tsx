"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { isOfflineNavigationClick } from "@/lib/pwa/offline-navigation";

/**
 * The strip that says the connection is down, and the guard that keeps the
 * open page while it is.
 *
 * Signed-in pages are never cached, so a navigation without a connection ends
 * on the service worker's offline page and drops the page that was still
 * readable. While the browser is offline, a tap on a link to another page of
 * the app stays where it is and repeats the hint in a toast.
 *
 * Rendered once at the top of `<AuthShell>`. Hidden during SSR and the first
 * client render (no hydration mismatch); the effect reads `navigator.onLine`
 * after mount.
 */
export function OfflineBanner() {
  const { t } = useTranslations();
  const [isOnline, setIsOnline] = useState(true);
  const stayOnPage = t("offlineBanner.stayOnPage");

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    // Deferred so the initial read is an external-system bridge, not a
    // synchronous setState in the effect body.
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

  useEffect(() => {
    // Capture phase on `window`: runs before React's handlers on the
    // document, so `next/link` sees the prevented default and stays put.
    function keepOpenPage(event: MouseEvent) {
      if (!isOfflineNavigationClick(event, window.location, navigator.onLine)) {
        return;
      }
      event.preventDefault();
      toast(stayOnPage, { id: "offline-navigation" });
    }
    window.addEventListener("click", keepOpenPage, true);
    return () => window.removeEventListener("click", keepOpenPage, true);
  }, [stayOnPage]);

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="offline-banner"
      className="bg-warning/15 border-warning/40 text-foreground flex items-center justify-center gap-2 border-b px-3 py-2 text-xs"
    >
      <WifiOff className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-center">
        {t("offlineBanner.message")} {stayOnPage}
      </span>
    </div>
  );
}
