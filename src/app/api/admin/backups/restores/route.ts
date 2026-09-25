/**
 * GET /api/admin/backups/restores — the restores the backups console shows.
 *
 * Every queued or running restore, and those that finished in the last day,
 * newest first. The console reads it when it opens, so a reload during a
 * restore picks the progress up again, and a restore that finished while
 * nobody was looking still says how it ended.
 */
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  evictAfterRestore,
  listRecentBackupRestoreJobs,
} from "@/lib/jobs/backup-restore";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.backups.restores.list" } });
  const jobs = await listRecentBackupRestoreJobs();
  for (const job of jobs) evictAfterRestore(job);
  return apiSuccess({ jobs });
});
