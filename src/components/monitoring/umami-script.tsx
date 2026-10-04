"use client";

import { useEffect } from "react";

import { UMAMI_PROXY_PREFIX } from "@/lib/monitoring/umami-paths";

interface UmamiScriptProps {
  enabled: boolean;
  websiteId: string | null;
}

const SCRIPT_ID = "healthlog-umami-script";

export function UmamiScript({ enabled, websiteId }: UmamiScriptProps) {
  useEffect(() => {
    const existing = document.getElementById(SCRIPT_ID);
    if (!enabled || !websiteId) {
      existing?.remove();
      return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.defer = true;
    script.src = "/api/monitoring/umami-script";
    script.setAttribute("data-website-id", websiteId);
    // Send events to the same-origin proxy so CSP stays strict. The tracker
    // appends its own collect path (`/api/send`, or whatever the operator's
    // Umami build renamed it to), and every path under the prefix reaches
    // the proxy route.
    script.setAttribute(
      "data-host-url",
      `${window.location.origin}${UMAMI_PROXY_PREFIX}`,
    );

    if (existing) {
      existing.replaceWith(script);
    } else {
      document.head.appendChild(script);
    }

    return () => {
      const current = document.getElementById(SCRIPT_ID);
      current?.remove();
    };
  }, [enabled, websiteId]);

  return null;
}
