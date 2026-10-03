/**
 * v1.40 (#1024) — edit or delete one course. Both re-project the
 * medication's window in the same transaction. Deleting the only course
 * makes the medication chronic again; the UI asks first. Owner-only.
 */
import { NextRequest } from "next/server";

import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { annotate } from "@/lib/logging/context";
import {
  CourseWriteError,
  courseRefusalResponse,
  deleteCourse,
  updateCourse,
} from "@/lib/medications/courses";
import { dayKeyOfDate } from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { updateMedicationCourseSchema } from "@/lib/validations/medication";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string; courseId: string }> };

function refused(err: unknown): Response {
  if (err instanceof CourseWriteError) {
    const r = courseRefusalResponse(err.refusal);
    annotate({ meta: { "medication.course.refused": err.refusal } });
    return apiError(r.message, r.status, { errorCode: r.errorCode });
  }
  throw err;
}

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, courseId } = await params;

    const { data: raw, error: jsonError } = await safeJson(request, {
      maxBytes: 16 * 1024,
    });
    if (jsonError) return jsonError;
    const parsed = updateMedicationCourseSchema.safeParse(raw);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "medications.course.invalid",
      });
    }

    try {
      const updated = await updateCourse({
        userId: user.id,
        medicationId: id,
        courseId,
        timeZone: user.timezone || DEFAULT_TIMEZONE,
        startsOn: parsed.data.startsOn,
        endsOn: parsed.data.endsOn,
        note: parsed.data.note,
      });
      invalidateUserMedications(user.id, { evict: true });
      await auditLog("medication.course.update", {
        userId: user.id,
        ipAddress: getClientIp(request),
        details: {
          medicationId: id,
          courseId,
          fields: Object.keys(parsed.data),
        },
      });
      annotate({
        action: { name: "medication.course.update" },
        meta: { medicationId: id },
      });
      return apiSuccess({
        id: updated.id,
        startsOn: dayKeyOfDate(updated.startsOn),
        endsOn: updated.endsOn ? dayKeyOfDate(updated.endsOn) : null,
      });
    } catch (err) {
      return refused(err);
    }
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id, courseId } = await params;
    try {
      await deleteCourse({
        userId: user.id,
        medicationId: id,
        courseId,
        timeZone: user.timezone || DEFAULT_TIMEZONE,
      });
    } catch (err) {
      return refused(err);
    }
    invalidateUserMedications(user.id, { evict: true });
    await auditLog("medication.course.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, courseId },
    });
    annotate({
      action: { name: "medication.course.delete" },
      meta: { medicationId: id },
    });
    return apiSuccess({ id: courseId, deleted: true });
  },
);
