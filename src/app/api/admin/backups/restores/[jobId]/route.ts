/**
 * GET /api/admin/backups/restores/[jobId] — how one restore is going.
 *
 * The status, the phase and the counts while it runs; what it wrote, cleared
 * and skipped once it succeeded; a stable code and a sentence an operator can
 * act on once it failed.
 */
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  evictAfterRestore,
  readBackupRestoreJob,
} from "@/lib/jobs/backup-restore";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (
    _request: Request,
    { params }: { params: Promise<{ jobId: string }> },
  ) => {
    await requireAdmin();
    const { jobId } = await params;
    annotate({
      action: { name: "admin.backups.restores.read" },
      meta: { jobId },
    });
    const job = await readBackupRestoreJob(jobId);
    if (!job) throw new HttpError(404, "Restore job not found");
    evictAfterRestore(job);
    return apiSuccess(job);
  },
);
