/**
 * PUT /api/auth/me/timezone
 *
 * v1.4.25 W7 — per-user timezone setter. Lifts the timezone write
 * out of `PUT /api/auth/profile` so the picker UI can post the
 * single field without round-tripping email/heightCm/etc, and so
 * the change pipeline (validate → write → invalidate-cache) is
 * isolated from the heavier profile patch.
 *
 * Auth: cookie session OR Bearer token.
 * Audit: `user.timezone.update` with the old + new zone.
 *
 * Validation: the body is `{ "timezone": "Europe/Berlin" }`. We
 * accept any string the runtime's `Intl.DateTimeFormat` constructor
 * accepts — i.e. every IANA zone the active Node engine knows about.
 * Rejecting unknown zones at the API surface stops a malformed
 * client from poisoning the column with a value the resolver
 * would later have to defend against.
 */
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { invalidateUserTimezone, isValidTimezone } from "@/lib/tz/resolver";

export const PUT = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "user.timezone.update" } });

  const { data: body, error: jsonError } = await safeJson(request);
  if (jsonError) return jsonError;

  const tz =
    body && typeof (body as { timezone?: unknown }).timezone === "string"
      ? ((body as { timezone: string }).timezone || "").trim()
      : "";

  if (!isValidTimezone(tz)) {
    return apiError("Not a valid IANA timezone.", 422);
  }

  const before = await prisma.user.findUnique({
    where: { id: user.id },
    select: { timezone: true },
  });

  await prisma.user.update({
    where: { id: user.id },
    data: { timezone: tz },
  });

  invalidateUserTimezone(user.id);

  await auditLog("user.timezone.update", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: {
      previous: before?.timezone ?? null,
      next: tz,
    },
  });

  annotate({
    meta: {
      timezone_previous: before?.timezone ?? null,
      timezone_next: tz,
    },
  });

  return apiSuccess({ timezone: tz });
});
