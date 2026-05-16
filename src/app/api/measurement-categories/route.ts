/**
 * `GET /api/measurement-categories` — public categorisation overlay.
 *
 * Exposes the UI-side `MEASUREMENT_CATEGORIES` map at
 * `src/lib/measurements/categories.ts` as an HTTP contract. iOS reads
 * this on cold start to drive the HealthKit permission picker
 * (one consent screen per category instead of a flat enum list) and
 * caches the response client-side; the web Insights nav and the Coach
 * evidence shelf will read the same shape post-v1.5.
 *
 * Response envelope:
 *
 *   {
 *     "data": {
 *       "version": 1,
 *       "categories": [
 *         { "id": "vitals", "labelKey": "categories.vitals", "order": 0 },
 *         …
 *       ],
 *       "assignments": {
 *         "BLOOD_PRESSURE_SYS": "vitals",
 *         "WEIGHT": "body",
 *         …
 *       }
 *     },
 *     "error": null
 *   }
 *
 * - `requireAuth()` — any logged-in user. No admin gate; no PII.
 * - `Cache-Control: public, max-age=600` — the overlay is stable across
 *   a 10-minute window. Clients that need a forced refresh can bypass
 *   their HTTP cache.
 * - `version: 1` is an additive marker; the categorisation shape will
 *   evolve additively, never by reshuffling existing assignments.
 *
 * Locked contract per `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R1.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  MEASUREMENT_CATEGORIES,
  type MeasurementCategory,
} from "@/lib/measurements/categories";
import { annotate } from "@/lib/logging/context";

/**
 * Stable category ordering for the iOS picker. Mirrors the
 * insertion order of `MEASUREMENT_CATEGORIES` so the UX is identical
 * across clients that read the canonical map directly and clients
 * that consume this endpoint.
 */
const CATEGORY_ORDER: readonly MeasurementCategory[] = [
  "vitals",
  "body",
  "activity",
  "sleep",
  "hearing",
  "environment",
  "cardiovascular",
  "metabolic",
] as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const GET = apiHandler(async (_request: NextRequest) => {
  await requireAuth();

  const categories = CATEGORY_ORDER.map((id, order) => ({
    id,
    labelKey: `categories.${id}`,
    order,
  }));

  const assignments: Record<string, MeasurementCategory> = {};
  for (const [type, category] of MEASUREMENT_CATEGORIES) {
    assignments[type] = category;
  }

  annotate({ action: { name: "measurement-categories.read" } });

  const response = apiSuccess({
    version: 1 as const,
    categories,
    assignments,
  });
  response.headers.set("Cache-Control", "public, max-age=600");
  return response;
});
