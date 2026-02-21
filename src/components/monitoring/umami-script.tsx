"use client";

import { useEffect } from "react";

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
    // Force same-origin tracking endpoint so CSP stays strict.
    script.setAttribute("data-host-url", window.location.origin);

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
