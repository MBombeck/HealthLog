/**
 * `POST /api/admin/maintenance/measurements` — queue the operator-triggered
 * `VACUUM (ANALYZE)` / `REINDEX INDEX CONCURRENTLY` pass over `measurements`
 * (v1.42). Cookie-only admin: `requireAdmin()` refuses every Bearer.
 *
 * Contract stub: authenticates as the finished route will, then answers 501.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { notImplemented } from "@/lib/http/not-implemented";

export const POST = apiHandler(async () => {
  await requireAdmin();
  return notImplemented();
});
