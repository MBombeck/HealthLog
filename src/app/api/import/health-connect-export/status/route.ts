/**
 * `GET /api/import/health-connect-export/status` — the caller's most recent
 * Health Connect import job (v1.42, #972).
 *
 * Contract stub: authenticates as the finished route will, then answers 501.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const GET = apiHandler(async () => {
  await requireAuth();
  return notImplemented();
});
