"use client";

import { useEffect, useRef } from "react";
import { useReportWebVitals } from "next/web-vitals";

/**
 * v1.4.28 R3d — client-side mount that pipes Web Vitals measurements
 * to `/api/internal/web-vitals`.
 *
 * Next 16 ships `useReportWebVitals` as the supported hook for
 * capturing CLS / FCP / FID / LCP / TTFB / INP from the live
 * navigation. The hook fires once per metric per page load, so a
 * heavy navigation can produce up to six beacons per route change.
 *
 * v1.4.33 F19 — the reporter previously posted EVERY measurement on
 * EVERY page-load. In production the runtime audit captured
 * `POST /api/internal/web-vitals 429` for almost every metric after
 * the first navigation: six beacons × N navigations burned through
 * the per-IP 60/min route-side rate-limit in seconds, so most samples
 * were dropped before they reached the wide-event sink. Telemetry
 * was self-throttled.
 *
 * Switch to client-side sampling at SAMPLE_RATE: each page-load
 * decides ONCE (memoised via `useMemo`) whether to report and either
 * sends every metric for that load or sends none. Per-load all-or-
 * none keeps a sampled session's vitals coherent (the LCP from one
 * page must be comparable to the CLS from the same page) while
 * cutting traffic by an order of magnitude. The route-side rate-limit
 * stays in place as a backstop against runaway sampling.
 *
 * Delivery transport: `navigator.sendBeacon` when available (queues
 * the POST without blocking the page lifecycle, survives the
 * `pagehide` event) with a `fetch({ keepalive: true })` fallback.
 * The route accepts the payload best-effort and returns 204 even on
 * malformed bodies — beacons must never delay or fail the navigation.
 */
const SAMPLE_RATE = 0.1;

export function WebVitalsReporter() {
  // Decide once per mount whether this page-load reports its vitals.
  // Math.random() is impure, so we deferred the draw to `useEffect`
  // (React's purity contract forbids running impure work inside
  // useMemo / the render body). The ref keeps the decision stable
  // across every metric callback inside the same navigation —
  // partial sampling would mix LCP-without-CLS noise into the wide-
  // event aggregates. SSR initialises the ref to `null` (no sample
  // decision yet); the first reportWebVitals callback fires post-
  // hydration once the effect has filled the slot.
  const sampledRef = useRef<boolean | null>(null);
  useEffect(() => {
    sampledRef.current = Math.random() < SAMPLE_RATE;
  }, []);

  useReportWebVitals((metric) => {
    // If the effect hasn't yet seeded the sample decision (very first
    // pre-hydration measurement), drop the beacon — over-sampling at
    // first paint would defeat the rate-limit relief.
    if (sampledRef.current !== true) return;

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
