/**
 * POST /api/integrations/fitbit-removal-notice/dismiss
 *
 * Hide the note that tells a formerly connected account the Fitbit
 * integration is gone (Google turned the Fitbit Web API off on 2026-10-30).
 * Migration 0503 set `User.fitbitRemovalNoticeAt` for every account that still
 * held a Fitbit connection; this clears it. Cookie-only, takes no body,
 * idempotent.
 */
import { apiHandler, requireCookieAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireCookieAuth();

  await prisma.user.update({
    where: { id: user.id },
    data: { fitbitRemovalNoticeAt: null },
  });

  annotate({ action: { name: "integrations.fitbit_removal_notice.dismiss" } });
  return apiSuccess({ dismissed: true });
});
