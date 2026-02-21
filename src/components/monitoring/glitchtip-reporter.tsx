"use client";

import { useEffect } from "react";

interface GlitchtipReporterProps {
  enabled: boolean;
}

function sendClientError(payload: {
  message: string;
  stack?: string;
  level?: "error" | "warning" | "info";
  type?: string;
}) {
  fetch("/api/monitoring/glitchtip", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...payload,
      url: window.location.href,
      userAgent: navigator.userAgent,
    }),
    keepalive: true,
  }).catch(() => {});
}

export function GlitchtipReporter({ enabled }: GlitchtipReporterProps) {
  useEffect(() => {
    if (!enabled) return;

    function onError(event: ErrorEvent) {
      sendClientError({
        message: event.message || "Unhandled client error",
        stack: event.error?.stack,
        level: "error",
        type: event.error?.name ?? "Error",
      });
    }

    function onUnhandledRejection(event: PromiseRejectionEvent) {
      const reason = event.reason as unknown;
      if (reason instanceof Error) {
        sendClientError({
          message: reason.message || "Unhandled promise rejection",
          stack: reason.stack,
          level: "error",
          type: reason.name || "UnhandledRejection",
        });
        return;
      }

      sendClientError({
        message:
          typeof reason === "string"
            ? reason
            : "Unhandled promise rejection (non-error value)",
        level: "error",
        type: "UnhandledRejection",
      });
    }

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [enabled]);

  return null;
}
