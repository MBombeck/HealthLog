import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import {
  createMeasurementSchema,
  listMeasurementsSchema,
  getUnitForType,
} from "@/lib/validations/measurement";
import { NextRequest } from "next/server";
import type {
  MeasurementType,
  MeasurementSource,
} from "@/generated/prisma/client";

export async function GET(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = listMeasurementsSchema.safeParse(params);
  if (!parsed.success) {
    return apiError(parsed.error.issues[0].message, 422);
  }

  const { type, from, to, limit, offset } = parsed.data;

  const where = {
    userId: sessionData.user.id,
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
      orderBy: { measuredAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.measurement.count({ where }),
  ]);

  return apiSuccess({
    measurements,
    meta: { total, limit, offset },
  });
}

export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const parsed = createMeasurementSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const { type, value, measuredAt, notes, source } = parsed.data;

    const measurement = await prisma.measurement.create({
      data: {
        userId: sessionData.user.id,
        type: type as MeasurementType,
        value,
        unit: getUnitForType(type),
        source: (source ?? "MANUAL") as MeasurementSource,
        measuredAt,
        notes: notes ?? null,
      },
    });

    await auditLog("measurement.create", {
      userId: sessionData.user.id,
      ipAddress: getClientIp(request),
      details: { type, measurementId: measurement.id },
    });

    return apiSuccess(measurement, 201);
  } catch (err) {
    // Handle unique constraint violation
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return apiError("Ein Messwert mit diesen Daten existiert bereits", 409);
    }
    console.error("Create measurement error:", err);
    return apiError("Messwert konnte nicht erstellt werden", 500);
  }
}
