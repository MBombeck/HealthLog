/**
 * GET /api/personal-records
 *
 * v1.4.25 — schema-only release of the PersonalRecord feature.
 * The detection worker that actually populates rows lands in a later
 * release (v1.4.26 or v1.5 — TBD). This route exists today so the
 * v1.5 iOS-Swift app can build its query path against a stable
 * contract from day one.
 *
 * Query params (validated against `listPersonalRecordsSchema`; a bad value
 * is a 422, not a shrug):
 *   - metricType: optional MeasurementType filter (e.g. ?metricType=VO2_MAX)
 *   - limit: optional pagination cap (default 100, max 500)
 *
 * Both were parsed defensively until this release — an unknown `metricType`
 * was dropped and a garbage `limit` reverted to the default. That read as
 * robustness and behaved as silence, and in one direction it was worse than
 * silence: dropping the filter WIDENS the read to every metric, so a typo
 * returned more rows than the caller asked for and nothing said so. The 500
 * ceiling refuses rather than clamps, for the same reason.
 *
 * Response envelope (the capped-list contract, `src/lib/api/list-cap.ts`):
 *   { data: PersonalRecord[], error: null, meta: { truncated, limit } }
 *
 * v1.43 (ios #116 item 5) — the route projects each row instead of passing the
 * Prisma result through. Every stored field stays on the wire, and each row
 * gains `benchmark`: the cited age- and sex-aware band for the age the record
 * was set at (`resolveRecordBenchmark`), or null.
 */
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { prisma } from "@/lib/db";
import type { NextRequest } from "next/server";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { returnAllZodIssues } from "@/lib/api-response";
import { listPersonalRecordsSchema } from "@/lib/validations/measurement";
import {
  mayCarryBenchmark,
  resolveRecordBenchmark,
} from "@/lib/personal-records/record-benchmark";
import { toProfileSex } from "@/lib/profile/sex";
import { apiListSuccess } from "@/lib/api/list-cap";
import { listPage } from "@/lib/http/list-query";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "measurements");
  annotate({ action: { name: "personalRecords.list" } });

  const parsed = listPersonalRecordsSchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    annotate({
      action: { name: "personalRecords.list" },
      meta: {
        outcome: "validation_failed",
        issue_count: parsed.error.issues.length,
      },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "personal_records.invalid_query",
    });
  }
  const { metricType, limit } = parsed.data;

  const { rows: records, cap } = await listPage(limit, (take) =>
    prisma.personalRecord.findMany({
      where: {
        userId: user.id,
        ...(metricType ? { metricType } : {}),
      },
      orderBy: [{ achievedAt: "desc" }, { id: "desc" }],
      take,
    }),
  );

  const wantsBand = records.some((r) => mayCarryBenchmark(r.metricType));
  const profile = wantsBand
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          timezone: true,
        },
      })
    : null;
  // Only the six-minute-walk equation needs a weight.
  const weight =
    profile && records.some((r) => r.metricType === "SIX_MINUTE_WALK_DISTANCE")
      ? await prisma.measurement.findFirst({
          where: { userId: user.id, type: "WEIGHT", deletedAt: null },
          orderBy: { measuredAt: "desc" },
          select: { value: true },
        })
      : null;
  const benchmarkProfile = {
    dateOfBirth: profile?.dateOfBirth ?? null,
    sex: toProfileSex(profile?.gender) ?? undefined,
    heightCm: profile?.heightCm ?? null,
    weightKg: weight?.value ?? null,
    timezone: profile?.timezone ?? DEFAULT_TIMEZONE,
  };

  return apiListSuccess(
    records.map((r) => ({
      id: r.id,
      userId: r.userId,
      metricType: r.metricType,
      metricSlot: r.metricSlot,
      direction: r.direction,
      value: r.value,
      unit: r.unit,
      achievedAt: r.achievedAt,
      sourceMeasurementId: r.sourceMeasurementId,
      source: r.source,
      externalId: r.externalId,
      createdAt: r.createdAt,
      benchmark: profile ? resolveRecordBenchmark(r, benchmarkProfile) : null,
    })),
    cap,
  );
});
