/**
 * `POST /api/admin/push-relay/notice`: dismiss the one-time notice that the
 * push relay exists, for this admin account. It never comes back.
 *
 * Cookie-only (`requireAdmin()`).
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import { RELAY_NOTICE_ID } from "@/lib/push-relay/admin-status";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireAdmin();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { adminNoticesDismissed: true },
  });
  if (!(row?.adminNoticesDismissed ?? []).includes(RELAY_NOTICE_ID)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { adminNoticesDismissed: { push: RELAY_NOTICE_ID } },
    });
  }
  annotate({ action: { name: "admin.push_relay.notice_dismissed" } });
  return apiSuccess({ dismissed: true });
});
