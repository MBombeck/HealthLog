import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  listMeasurementsSchema,
  getUnitForType,
} from "@/lib/validations/measurement";
import {
  BUCKET_CAP,
  type AggregateGrain,
} from "@/lib/measurements/range-aggregation";
import { withIdempotency } from "@/lib/idempotency";
import { NextRequest } from "next/server";
import type {
  MeasurementType,
  MeasurementSource,
  GlucoseContext,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMeasurementsSchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { type, from, to, limit, offset, sortBy, sortDir, aggregate } =
    parsed.data;

  const where = {
    userId: user.id,
    ...(type && { type: type as MeasurementType }),
    ...(from || to
      ? {
          measuredAt: {
            ...(from && { gte: from }),
            ...(to && { lte: to }),
          },
        }
      : {}),
  };

  // v1.4.28 FB-D2 — server-side aggregation. Gated on an explicit
  // `aggregate` param so the iOS contract (raw `MeasurementWireDTO`
  // shape on `GET /api/measurements`) is byte-stable for any caller
  // that omits the new query parameter. The chart-data client opts
  // in; iOS does not.
  //
  // R4-CODE-C1 — `take` no longer applies BEFORE bucketising. The
  // aggregation runs in Postgres via `date_trunc`, the bucket cap is
  // applied AFTER, so a 1-year `aggregate=daily` window walks every
  // row in the window and returns up to 365 buckets per type instead
  // of truncating to the first N raw rows.
  //
  // SD-H1 — "All time" range semantics. When the chart's "All" tab
  // is active, the client passes `from` = the user's earliest
  // measurement (or a sentinel like 1970-01-01) plus `to` = now plus
  // `aggregate=monthly` (or `weekly` when full history < 2 years).
  // The route's response is bounded by the `BUCKET_CAP` ceiling per
  // grain (monthly: 24, weekly: 105, daily: 365) so a multi-decade
  // account never paints an unbounded series.
  if (aggregate && aggregate !== "raw" && from && to) {
    const grain: AggregateGrain = aggregate;
    const cap = Math.min(limit, BUCKET_CAP[grain]);
    const truncUnit = grain === "daily" ? "day" : grain;
    const buckets = await prisma.$queryRaw<
      Array<{ type: string; bucket_start: Date; avg: number; cnt: number }>
    >`
      SELECT
        m."type"::text AS type,
        date_trunc(${truncUnit}, m."measured_at") AS bucket_start,
        AVG(m."value")::double precision AS avg,
        COUNT(*)::int AS cnt
      FROM measurements m
      WHERE m."user_id" = ${user.id}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        ${type ? Prisma.sql`AND m."type" = ${type}::"MeasurementType"` : Prisma.empty}
      GROUP BY m."type", bucket_start
      ORDER BY bucket_start ASC
      LIMIT ${cap}
    `;

    const measurements = buckets.map((b) => ({
      type: b.type,
      value: Number(b.avg),
      measuredAt: b.bucket_start.toISOString(),
      count: Number(b.cnt),
    }));
    annotate({
      action: { name: "measurement.list" },
      meta: { total: measurements.length, type, aggregate: grain },
    });
    return apiSuccess({
      measurements,
      meta: {
        total: measurements.length,
        limit: cap,
        offset: 0,
        aggregate: grain,
      },
    });
  }

  const [measurements, total] = await Promise.all([
    prisma.measurement.findMany({
      where,
      orderBy: { [sortBy]: sortDir },
      take: limit,
      skip: offset,
    }),
    prisma.measurement.count({ where }),
  ]);

  annotate({ action: { name: "measurement.list" }, meta: { total, type } });

  return apiSuccess({
    measurements,
    meta: { total, limit, offset },
  });
});

export const POST = apiHandler(withIdempotency<[NextRequest]>(postMeasurement));

async function postMeasurement(request: NextRequest) {
  const { user } = await requireAuth();

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;

  // Batch mode (array of measurements, e.g. combined BP + Pulse)
  if (Array.isArray(body)) {
    const parsed = createBatchMeasurementSchema.safeParse({
      measurements: body,
    });
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const results = await prisma.$transaction(
      parsed.data.measurements.map((m) =>
        prisma.measurement.create({
          data: {
            userId: user.id,
            type: m.type as MeasurementType,
            value: m.value,
            unit: getUnitForType(m.type),
            source: (m.source ?? "MANUAL") as MeasurementSource,
            measuredAt: m.measuredAt,
            notes: m.notes ?? null,
            glucoseContext:
              (m.glucoseContext as GlucoseContext | undefined) ?? null,
            // v1.4.25 W10 reconcile (code-review M4): mirror the
            // single-entry path so the multi-entry batch persists
            // `deviceType` instead of silently dropping it.
            deviceType: m.deviceType ?? null,
          },
        }),
      ),
    );

    await auditLog("measurement.create.batch", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    annotate({
      action: { name: "measurement.create.batch" },
      meta: {
        count: results.length,
        types: parsed.data.measurements.map((m) => m.type),
      },
    });

    return apiSuccess(results, 201);
  }

  // Single mode (existing behavior)
  const parsed = createMeasurementSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { type, value, measuredAt, notes, source, glucoseContext, deviceType } =
    parsed.data;

  // Handle unique constraint violation
  let measurement;
  try {
    measurement = await prisma.measurement.create({
      data: {
        userId: user.id,
        type: type as MeasurementType,
        value,
        unit: getUnitForType(type),
        source: (source ?? "MANUAL") as MeasurementSource,
        measuredAt,
        notes: notes ?? null,
        glucoseContext: (glucoseContext as GlucoseContext | undefined) ?? null,
        // v1.4.25 W10 reconcile (code-review M4): the deviceType column
        // already accepts client metadata from the batch route. Mirror
        // the behaviour here so single-entry POST persists the tag
        // instead of silently dropping it.
        deviceType: deviceType ?? null,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return apiError("A measurement with this data already exists", 409);
    }
    throw err;
  }

  await auditLog("measurement.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { type, measurementId: measurement.id },
  });

  annotate({
    action: {
      name: "measurement.create",
      entity_type: "measurement",
      entity_id: measurement.id,
    },
  });

  return apiSuccess(measurement, 201);
}
