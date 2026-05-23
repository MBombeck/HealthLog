import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
  sanitiseZodIssues,
} from "@/lib/api-response";
import { updateMeasurementSchema } from "@/lib/validations/measurement";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";
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
      // v1.4.43 W6 — measurement edit hot path; multi-issue 422 +
      // audit breadcrumb keyed `measurements.update.validation-failed`.
      const issues = sanitiseZodIssues(parsed.error.issues);
      annotate({
        action: { name: "measurements.update.validation-failed" },
        meta: { issue_count: issues.length, measurement_id: id },
      });
      // v1.4.49 — strip `message` from the audit-ledger row; the
      // update schema carries free-text `notes`.
      const auditIssues = sanitiseZodIssues(parsed.error.issues, {
        stripValuesFromMessage: true,
      });
      prisma.auditLog
        .create({
          data: {
            userId: user.id,
            action: "measurements.update.validation-failed",
            details: JSON.stringify({
              issues: auditIssues,
              measurementId: id,
            }),
          },
        })
        .catch(() => {
          /* swallow — 422 response is the contract */
        });
      return returnAllZodIssues(parsed.error, 422);
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

    // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
    // caches so subsequent reads reflect the edited row.
    invalidateUserMeasurements(user.id);

    // v1.5.0 — refresh the rollup row for the affected day. When the
    // measuredAt moved across day boundaries (or the row was re-typed)
    // both the old and the new bucket need a recompute. Best-effort
    // — a populator hiccup never fails the user's edit.
    try {
      await recomputeBucketsForMeasurement(
        user.id,
        measurement.type,
        measurement.measuredAt,
      );
      if (
        existing.measuredAt.getTime() !== measurement.measuredAt.getTime() ||
        existing.type !== measurement.type
      ) {
        await recomputeBucketsForMeasurement(
          user.id,
          existing.type,
          existing.measuredAt,
        );
      }
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }

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

    // v1.4.34 IW-G — bust per-user analytics + achievements + workouts
    // caches so subsequent reads reflect the deletion.
    invalidateUserMeasurements(user.id);

    // v1.5.0 — refresh the rollup row for the affected day (the
    // recompute drops the row when the day's measurement count goes
    // to zero). Best-effort — a populator hiccup never fails the
    // user's delete.
    try {
      await recomputeBucketsForMeasurement(
        user.id,
        existing.type,
        existing.measuredAt,
      );
    } catch (err) {
      console.warn("[measurements] rollup recompute failed", err);
    }

    return apiSuccess({ deleted: true });
  },
);
