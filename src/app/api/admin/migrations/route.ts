/**
 * `GET /api/admin/migrations` — the database migrations this image ships,
 * how many the database applied, which are pending and which failed
 * (`loadMigrationStatus`). Admin-only, cookie-only, read-only.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { loadMigrationStatus } from "@/lib/admin/migration-status";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  const status = await loadMigrationStatus();
  annotate({
    action: { name: "admin.migrations.read" },
    meta: {
      pending: status.pending,
      failed: status.failedNames.length,
    },
  });
  return apiSuccess(status);
});
