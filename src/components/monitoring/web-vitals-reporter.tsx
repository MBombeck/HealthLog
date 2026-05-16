"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * v1.4.28 R3d — client-side mount that pipes every Web Vitals
 * measurement to `/api/internal/web-vitals`.
 *
 * Next 16 ships `useReportWebVitals` as the supported hook for
 * capturing CLS / FCP / FID / LCP / TTFB / INP from the live
 * navigation. The hook fires once per metric per page load, so even a
 * heavy navigation produces at most six beacons.
 *
 * Delivery transport: `navigator.sendBeacon` when available (queues
 * the POST without blocking the page lifecycle, survives the
 * `pagehide` event) with a `fetch({ keepalive: true })` fallback.
 * The route accepts the payload best-effort and returns 200 even on
 * malformed bodies — beacons must never delay or fail the navigation.
 */
export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    const body = JSON.stringify({
      id: metric.id,
      name: metric.name,
      value: metric.value,
      delta: metric.delta,
      rating: metric.rating,
      navigationType: metric.navigationType,
    });
    const url = "/api/internal/web-vitals";

    if (
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }

    // Fallback for non-`sendBeacon` browsers — `keepalive` keeps the
    // request alive past navigation. We deliberately ignore the
    // response (it's a beacon, not a transaction).
    void fetch(url, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      keepalive: true,
    }).catch(() => undefined);
  });

  return null;
}
