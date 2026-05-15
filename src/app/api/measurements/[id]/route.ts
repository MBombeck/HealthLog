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
import { updateMeasurementSchema } from "@/lib/validations/measurement";
import { Prisma } from "@/generated/prisma/client";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const measurement = await prisma.measurement.findUnique({
      where: { id },
    });

    if (!measurement || measurement.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    annotate({
      action: {
        name: "measurement.get",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    return apiSuccess(measurement);
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const existing = await prisma.measurement.findUnique({
      where: { id },
    });

    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request);

    if (jsonError) return jsonError;
    const parsed = updateMeasurementSchema.safeParse(body);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 422);
    }

    const data = parsed.data;
    let measurement;
    try {
      measurement = await prisma.measurement.update({
        where: { id },
        data: {
          ...(data.value !== undefined && { value: data.value }),
          ...(data.measuredAt !== undefined && { measuredAt: data.measuredAt }),
          ...(data.notes !== undefined && { notes: data.notes }),
        },
      });
    } catch (err) {
      // v1.4.28 FB-B1 — re-pointing `measuredAt` onto an existing
      // `(userId, type, measuredAt, source, sleepStage)` tuple raises
      // `P2002`. Mirror the POST handler's catch so the row-edit Sheet
      // surfaces a clean 409 with a translatable `errorCode` instead of
      // the bare 500 the UI used to render as the generic save-error
      // toast.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return apiError(
          "A measurement with this timestamp already exists",
          409,
          { errorCode: "measurement.duplicate_timestamp" },
        );
      }
      throw err;
    }

    await auditLog("measurement.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { measurementId: id },
    });

    annotate({
      action: {
        name: "measurement.update",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    return apiSuccess(measurement);
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;

    const existing = await prisma.measurement.findUnique({
      where: { id },
    });

    if (!existing || existing.userId !== user.id) {
      return apiError("Measurement not found", 404);
    }

    await prisma.measurement.delete({ where: { id } });

    await auditLog("measurement.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { measurementId: id, type: existing.type },
    });

    annotate({
      action: {
        name: "measurement.delete",
        entity_type: "measurement",
        entity_id: id,
      },
    });

    return apiSuccess({ deleted: true });
  },
);
