/**
 * #1280 — "End course": end the running course now.
 *
 *   POST /api/medications/{id}/courses/end — no body. The course's last day
 *        becomes today on the person's clock and the moment is recorded as
 *        its `endedAt`, so a dose later today is not due, not reminded and
 *        not expected, while one taken earlier today still counts. The
 *        medication reads as ENDED at once.
 *
 * An action of its own rather than `PUT { endsOn }`: an end date set through
 * the PUT or the course editor keeps meaning the whole day. Refused with 409
 * `medications.course.notRunning` while no course is running, the same rule
 * the reads publish as `canEndCourse`.
 *
 * MANAGE over the record's medications, the level the medication's own PUT
 * (which used to carry the end date) is written at: a manager running
 * somebody's regimen may end a course they could already end through the
 * edit. Starting, editing and removing courses stay owner-only. The reads
 * publish `canEndCourse` false to a caller below that level
 * (`course-authority.ts`), so no client offers the button this refuses.
 */
import { NextRequest } from "next/server";

import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { withIdempotency } from "@/lib/idempotency";
import { annotate } from "@/lib/logging/context";
import {
  CourseWriteError,
  courseRefusalResponse,
  endCurrentCourse,
} from "@/lib/medications/courses";
import { dayKeyOfDate } from "@/lib/medications/course-window";
import { overwriteDetails } from "@/lib/sharing/audit-details";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  withIdempotency<[NextRequest, RouteParams]>(postEndCourse),
);

async function postEndCourse(
  request: NextRequest,
  { params }: RouteParams,
): Promise<Response> {
  const { user } = await requireRecordAuth("manage", "medications");
  const { id } = await params;

  try {
    const { window, previous, droppedPlaceholders } = await endCurrentCourse({
      userId: user.id,
      medicationId: id,
      timeZone: user.timezone || DEFAULT_TIMEZONE,
    });
    invalidateUserMedications(user.id, { evict: true });
    const body = {
      startsOn: window.startsOn ? dayKeyOfDate(window.startsOn) : null,
      endsOn: window.endsOn ? dayKeyOfDate(window.endsOn) : null,
      endedAt: window.endedAt ? window.endedAt.toISOString() : null,
    };
    await auditLog("medication.course.end", {
      userId: user.id,
      ipAddress: getClientIp(request),
      // C4: the end the course had before, so a manager's End reads back
      // out of the trail; and how many pending slots it took with it.
      details: {
        medicationId: id,
        ...overwriteDetails({
          before: { endsOn: previous.endsOn, endedAt: previous.endedAt },
          after: { endsOn: window.endsOn, endedAt: window.endedAt },
        }),
        droppedPlaceholders,
      },
    });
    annotate({
      action: { name: "medication.course.end" },
      meta: { medicationId: id },
    });
    return apiSuccess(body);
  } catch (err) {
    if (err instanceof CourseWriteError) {
      const r = courseRefusalResponse(err.refusal);
      annotate({ meta: { "medication.course.refused": err.refusal } });
      return apiError(r.message, r.status, { errorCode: r.errorCode });
    }
    throw err;
  }
}
