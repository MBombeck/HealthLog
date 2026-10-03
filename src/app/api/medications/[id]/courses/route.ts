/**
 * v1.40 (#1024) — a medication's courses.
 *
 *   GET  /api/medications/{id}/courses — the resolved course fields, the same
 *        ones the list and detail reads carry.
 *   POST /api/medications/{id}/courses — start a course (`{ startsOn,
 *        endsOn?, note? }`). The medication's `startsOn`/`endsOn` are
 *        rewritten to the latest course in the same transaction, so reminders
 *        and the dose actions follow without another write.
 *
 * Owner-only for now: a delegate edits the current window through the
 * medication's own PUT, as before.
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
import { prisma } from "@/lib/db";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  CourseWriteError,
  courseRefusalResponse,
  createCourse,
  resolveCourseFields,
} from "@/lib/medications/courses";
import { dayKeyOfDate } from "@/lib/medications/course-window";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { createMedicationCourseSchema } from "@/lib/validations/medication";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;
    const medication = await prisma.medication.findFirst({
      where: { id, userId: user.id },
      select: { id: true, active: true, oneShot: true },
    });
    if (!medication) return apiError("Medication not found", 404);
    const fields = (
      await resolveCourseFields(
        [medication],
        new Date(),
        user.timezone || DEFAULT_TIMEZONE,
      )
    ).get(id);
    return apiSuccess(fields);
  },
);

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postCourse),
);

async function postCourse(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user } = await requireAuth();
  const { id } = await params;

  const { data: raw, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;
  const parsed = createMedicationCourseSchema.safeParse(raw);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "medications.course.invalid",
    });
  }

  try {
    const created = await createCourse({
      userId: user.id,
      medicationId: id,
      timeZone: user.timezone || DEFAULT_TIMEZONE,
      startsOn: parsed.data.startsOn,
      endsOn: parsed.data.endsOn ?? null,
      note: parsed.data.note,
    });
    invalidateUserMedications(user.id, { evict: true });
    await auditLog("medication.course.create", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        medicationId: id,
        courseId: created.id,
        startsOn: dayKeyOfDate(created.startsOn),
        endsOn: created.endsOn ? dayKeyOfDate(created.endsOn) : null,
      },
    });
    annotate({
      action: { name: "medication.course.create" },
      meta: { medicationId: id },
    });
    return apiSuccess(
      {
        id: created.id,
        startsOn: dayKeyOfDate(created.startsOn),
        endsOn: created.endsOn ? dayKeyOfDate(created.endsOn) : null,
      },
      201,
    );
  } catch (err) {
    if (err instanceof CourseWriteError) {
      const r = courseRefusalResponse(err.refusal);
      annotate({ meta: { "medication.course.refused": err.refusal } });
      return apiError(r.message, r.status, { errorCode: r.errorCode });
    }
    throw err;
  }
}
