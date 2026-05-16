/**
 * v1.4.28 R3d — Web Vitals beacon.
 *
 * Next 16 exposes `reportWebVitals` from the root layout; the client
 * POSTs every measurement to this internal route, which logs to the
 * shared wide-event pipeline so ops can see CLS / FCP / FID / LCP /
 * TTFB / INP / FCP histograms in the same place the rest of the
 * request flow surfaces.
 *
 * Why a route + not the front-end alone:
 *
 *   - `console.log` from the client is invisible to the server-side
 *     observability stack (HealthLog ships logs through the
 *     `WideEventBuilder` in `src/lib/logging/context.ts`). Funnelling
 *     metrics through a thin route reuses the existing pipeline.
 *   - Persisting elsewhere (Postgres, S3) would be a wasted spend —
 *     this is a beacon. We log and forget.
 *
 * Authentication: none. Web Vitals fire from the document lifecycle
 * (including the very first navigation that pre-dates auth), so an
 * auth gate would silently drop the most informative samples. The
 * route compensates by gating on:
 *
 *   1. Same-origin Referer header (when `NEXT_PUBLIC_APP_URL` is
 *      configured) — fails closed on cross-site dispatch.
 *   2. Per-IP `checkRateLimit` (60 req / minute) — same shape as the
 *      deploy-webhook. A real client sends ≤ 7 beacons per page;
 *      anything past 60 is a flood.
 *   3. Zod schema — `name` is locked to the documented web-vitals
 *      identifier set; `value` / `delta` / `id` are size-bounded.
 *      Only validated fields enter the wide-event meta — the raw
 *      payload is NEVER logged, so a hostile client cannot inject
 *      arbitrary text into the observability sink.
 *
 * Always returns 204 No Content on a successful enqueue (no body so
 * `sendBeacon` never retries). 400 on schema reject; 429 on rate-limit
 * hit. The client never reads either — the beacon is fire-and-forget.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod/v4";

import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { getClientIp } from "@/lib/api-response";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";

const webVitalsBodySchema = z.object({
  // Locked to the web-vitals library's documented metric identifiers.
  // FCP is included for parity with the iOS WebView client; INP super-
  // sedes FID under the new Core Web Vitals contract.
  name: z.enum(["CLS", "LCP", "FID", "INP", "TTFB", "FCP"]),
  value: z.number().finite(),
  // Web Vitals client builds `id` from `${navigation-uuid}-${index}`
  // — bounded length keeps a hostile peer from logging arbitrary text
  // under the identifier slot.
  id: z.string().max(50),
  delta: z.number().finite().optional(),
  rating: z.enum(["good", "needs-improvement", "poor"]).optional(),
  navigationType: z
    .enum(["navigate", "reload", "back-forward", "back-forward-cache", "prerender"])
    .optional(),
});

function isSameOriginReferer(request: NextRequest): boolean {
  // When `NEXT_PUBLIC_APP_URL` is unset (test / unconfigured dev) skip
  // the check — the rate-limit + schema still bound the surface, and
  // gating on a missing env would dead-lock the beacon in dev.
  const expectedOrigin = process.env.NEXT_PUBLIC_APP_URL;
  if (!expectedOrigin) return true;

  const referer = request.headers.get("referer");
  if (!referer) return false;

  try {
    const refererOrigin = new URL(referer).origin;
    const expected = new URL(expectedOrigin).origin;
    return refererOrigin === expected;
  } catch {
    return false;
  }
}

export const POST = apiHandler(async (request: NextRequest) => {
  // Same-origin gate. Fails closed on cross-site dispatch.
  if (!isSameOriginReferer(request)) {
    return new NextResponse(null, { status: 204 });
  }

  // Per-IP rate-limit. 60 req / minute is well above a real client's
  // ≤ 7 beacons / page-load and well below a flood. 429 on hit; the
  // beacon contract still accepts 4xx without retry on the client.
  const ip = getClientIp(request);
  const rl = await checkRateLimit(
    `web-vitals:${ip ?? "unknown"}`,
    60,
    60_000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: rateLimitHeaders(rl) },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // Malformed payload — 400 so the beacon never retries. Crucially:
    // we do NOT log the raw body (log-injection defence).
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = webVitalsBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // Log only the validated fields. The raw payload never enters the
  // observability pipeline, so a hostile peer cannot smuggle text
  // into the wide-event log via unrecognised keys.
  const { name, value, id, delta, rating, navigationType } = parsed.data;
  annotate({
    meta: {
      "web_vitals.name": name,
      "web_vitals.value": value,
      "web_vitals.id": id,
      "web_vitals.delta": delta ?? null,
      "web_vitals.rating": rating ?? null,
      "web_vitals.navigation_type": navigationType ?? null,
    },
  });

  return new NextResponse(null, { status: 204 });
});
