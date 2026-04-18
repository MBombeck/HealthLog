import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import {
  createMeasurementSchema,
  createBatchMeasurementSchema,
  listMeasurementsSchema,
  getUnitForType,
} from "@/lib/validations/measurement";
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

  const { type, from, to, limit, offset, sortBy, sortDir } = parsed.data;

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

export const POST = apiHandler(async (request: NextRequest) => {
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

  const { type, value, measuredAt, notes, source, glucoseContext } =
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
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
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
});
