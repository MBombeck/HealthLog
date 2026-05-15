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
  aggregateRows,
  pickAggregateGrain,
  rangeLengthDays,
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

  // v1.4.28 FB-D2 — when the caller supplies a from/to window AND asks
  // for an aggregated grain (or the window is wide enough that the
  // default grain should downsample), collapse to one row per bucket
  // per type before returning. Raw mode keeps the historical wire shape
  // so existing callers and the iOS client (which does not pass
  // `aggregate`) see no change.
  if (from && to) {
    const grain = pickAggregateGrain(rangeLengthDays(from, to), aggregate);
    if (grain !== "raw") {
      const rows = await prisma.measurement.findMany({
        where,
        orderBy: { measuredAt: "asc" },
        take: limit,
        skip: offset,
        select: { type: true, value: true, measuredAt: true },
      });
      const buckets = aggregateRows(
        rows.map((r) => ({
          type: r.type as string,
          value: r.value,
          measuredAt: r.measuredAt,
        })),
        grain,
      );
      const measurements = buckets.map((b) => ({
        type: b.type,
        value: b.avg,
        measuredAt: b.bucketStart.toISOString(),
        count: b.count,
      }));
      annotate({
        action: { name: "measurement.list" },
        meta: { total: measurements.length, type, aggregate: grain },
      });
      return apiSuccess({
        measurements,
        meta: { total: measurements.length, limit, offset, aggregate: grain },
      });
    }
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
