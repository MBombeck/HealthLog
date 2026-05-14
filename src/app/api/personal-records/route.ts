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

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "personalRecords.list" } });

  const { searchParams } = new URL(request.url);
  const metricTypeParam = searchParams.get("metricType");

  // Defensive parse — drop unknown values rather than 400 so the
  // caller's loosely-typed filter doesn't take the page down.
  const metricType: MeasurementType | null =
    metricTypeParam && measurementTypeEnum.safeParse(metricTypeParam).success
      ? (metricTypeParam as MeasurementType)
      : null;

  const records = await prisma.personalRecord.findMany({
    where: {
      userId: user.id,
      ...(metricType ? { metricType } : {}),
    },
    orderBy: { achievedAt: "desc" },
  });

  return apiSuccess(records);
});
