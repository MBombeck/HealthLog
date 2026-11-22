/**
 * 1.49 — `POST /api/admin/server-setup/notice`: hide the start-page notice
 * that offers the server setup, for this admin. Idempotent; cookie-only
 * (`requireAdmin`). The setup itself stays reachable from Admin → System
 * status.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { dismissServerSetupNotice } from "@/lib/admin/server-setup-store";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async () => {
  const { user } = await requireAdmin();
  await dismissServerSetupNotice(user.id);
  annotate({ action: { name: "admin.server_setup.notice_dismissed" } });
  return apiSuccess({ dismissed: true });
});
