/**
 * GET /api/personal-records
 *
 * v1.4.25 W8d — schema-only release of the PersonalRecord feature.
 * The detection worker that actually populates rows lands in a later
 * release (v1.4.26 or v1.5 — TBD). This route exists today so the
 * v1.5 iOS-Swift app can build its query path against a stable
 * contract from day one.
 *
 * Query params:
 *   - metricType: optional MeasurementType filter (e.g. ?metricType=VO2_MAX)
 *   - limit: optional pagination cap (default 100, max 500)
 *
 * Response envelope (matches the project-wide `apiSuccess` contract):
 *   { data: PersonalRecord[], error: null }
 */
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// v1.4.25 W10 reconcile (Sr-M4) — pagination bounds. Matches the
// `listMeasurementsSchema` ceiling (max 500) so every ingest-and-read
// endpoint on the route surface shares the same upper bound. Today
// the worker hasn't populated any rows so even an uncapped findMany is
// harmless, but a power user with multi-year Apple Health history could
// accumulate 50+ PRs per metric × 14 PR-trackable metrics once the
// worker lands. Add the cap now so the v1.5 iOS app's query path is
// bounded from day one.
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "personalRecords.list" } });

  const { searchParams } = new URL(request.url);
  const metricTypeParam = searchParams.get("metricType");
  const limitParam = searchParams.get("limit");

  // Defensive parse — drop unknown values rather than 400 so the
  // caller's loosely-typed filter doesn't take the page down.
  const metricType: MeasurementType | null =
    metricTypeParam && measurementTypeEnum.safeParse(metricTypeParam).success
      ? (metricTypeParam as MeasurementType)
      : null;

  // Limit clamp: parse → clamp [1, MAX_LIMIT] → default fallback. A
  // garbage value (`?limit=abc`, `?limit=-1`, `?limit=999999`) silently
  // clamps to the default rather than 400-ing — same defence-in-depth
  // stance the metricType parse takes.
  let limit = DEFAULT_LIMIT;
  if (limitParam != null) {
    const parsed = Number(limitParam);
    if (Number.isInteger(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  const records = await prisma.personalRecord.findMany({
    where: {
      userId: user.id,
      ...(metricType ? { metricType } : {}),
    },
    orderBy: { achievedAt: "desc" },
    take: limit,
  });

  return apiSuccess(records);
});
