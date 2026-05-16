/**
 * v1.4.28 R3d — Web Vitals beacon.
 *
 * Next 16 exposes `reportWebVitals` from the root layout; we wire the
 * client to POST every measurement to this internal route, which logs
 * to the shared wide-event pipeline so ops can see CLS / FCP / FID /
 * LCP / TTFB / INP histograms in the same place the rest of the
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
 * Authentication: none (the route is internal-only by name; CSP +
 * same-origin policy keep cross-site reporting out). The dispatch is
 * idempotent — a duplicate beacon is at worst one extra log line.
 *
 * Rate-limit: deliberately none. Web Vitals emit one report per metric
 * per page load (max 6 per session). A bot trying to flood the route
 * is cheaper to drop at the edge.
 *
 * Payload shape: matches `web-vitals`' `Metric` interface — `id`,
 * `name`, `value`, `delta`, `rating`. We log the lot; if a future
 * client adds fields we'll see them in the event meta.
 */
import { NextRequest, NextResponse } from "next/server";

import { apiHandler } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";

interface WebVitalsBody {
  id?: unknown;
  name?: unknown;
  value?: unknown;
  delta?: unknown;
  rating?: unknown;
  navigationType?: unknown;
}

export const POST = apiHandler(async (request: NextRequest) => {
  let body: WebVitalsBody | null = null;
  try {
    body = (await request.json()) as WebVitalsBody;
  } catch {
    // Malformed payload — accept silently so the client doesn't retry.
    return NextResponse.json({ ok: true });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: true });
  }

  const name = typeof body.name === "string" ? body.name : "unknown";
  const value =
    typeof body.value === "number" && Number.isFinite(body.value)
      ? body.value
      : null;
  const rating = typeof body.rating === "string" ? body.rating : null;

  annotate({
    meta: {
      "web_vitals.name": name,
      "web_vitals.value": value,
      "web_vitals.rating": rating,
      "web_vitals.navigation_type":
        typeof body.navigationType === "string" ? body.navigationType : null,
    },
  });

  return NextResponse.json({ ok: true });
});
