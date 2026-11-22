/**
 * 1.49 — `GET /api/admin/setup-health`: the read-only check list of the
 * server's setup (encryption keys present, the secure-cookie setting against
 * how this request arrived, the database dump schedule, the public URL).
 * Shown on Admin → System status and in the server setup's last step.
 *
 * Cookie-only (`requireAdmin`); answers closed reason codes and key ids or
 * counts, never a secret.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { readSetupHealth } from "@/lib/admin/setup-health";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async (request: Request) => {
  await requireAdmin();
  const health = readSetupHealth(request);
  annotate({
    action: { name: "admin.setup_health.get" },
    meta: { state: health.state },
  });
  return apiSuccess(health);
});
