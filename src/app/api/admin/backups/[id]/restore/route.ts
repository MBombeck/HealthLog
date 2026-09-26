/**
 * POST /api/admin/backups/[id]/restore — admin-only disaster recovery.
 *
 * Queues the restore of one stored backup over its owner's record and answers
 * 202 with the job's id. The restore itself (`restoreBackup` in
 * `src/lib/export/restore-backup.ts`) runs on the `backup-restore` queue: on a
 * large account it takes longer than a reverse proxy lets a request live, and
 * an operator who saw the proxy's error could not tell that the restore went
 * on to finish. `GET /api/admin/backups/restores/{jobId}` reports how it went.
 *
 * What this request still decides on the spot, because each is quick and each
 * is the operator's to fix: the typed confirmation, that the backup exists,
 * and that its stored copy opens under the keys this host holds. A copy that
 * will not open is refused here, before anything is queued. The file's own
 * checks (schema, owner, manifest, documents) read all of it and so run in the
 * job, still before the first delete.
 *
 * One restore per account at a time: a second request while one is queued or
 * running answers 409 and names the running job.
 */
import { NextRequest } from "next/server";

import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import {
  openStoredBackup,
  storedBackupRefusal,
  STORED_BACKUP_SELECT,
  storedBackupIdentity,
} from "@/lib/export/stored-backup";
import { defaultUserIdResolver, withIdempotency } from "@/lib/idempotency";
import {
  admitBackupRestore,
  backupDigest,
  BACKUP_RESTORE_ACTIVE_CODE,
} from "@/lib/jobs/backup-restore";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

const handler = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({ action: { name: "admin.backups.restore" }, meta: { id } });

    let body: { confirm?: string; restoreInstanceSettings?: boolean } = {};
    try {
      const raw = await request.text();
      if (raw.length > 64 * 1024) {
        return apiError(`Request body exceeds ${64 * 1024} bytes`, 413);
      }
      body = JSON.parse(raw) as {
        confirm?: string;
        restoreInstanceSettings?: boolean;
      };
    } catch {
      return apiError("Invalid JSON body", 400);
    }

    // Restoring one account's data and reconfiguring the whole host are two
    // different decisions, so they are two different answers. Anything but a
    // literal `true` restores the account alone.
    const restoreInstanceSettings = body.restoreInstanceSettings === true;
    annotate({ meta: { restore_instance_settings: restoreInstanceSettings } });

    if (body.confirm !== "RESTORE") {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "missing_confirmation", backupId: id },
      });
      return apiError(
        "Confirmation token missing — replacing an account's data requires confirm: 'RESTORE'",
        422,
      );
    }

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      select: STORED_BACKUP_SELECT,
    });
    if (!backup) {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "not_found", backupId: id },
      });
      throw new HttpError(404, "Backup not found");
    }

    // Opening authenticates every stored piece (and decompresses nothing), so
    // a copy written under a key this host no longer holds, or one whose
    // pieces do not add up, is refused now, in the answer the operator is
    // looking at, rather than minutes later in a job. Bad stored input, not a
    // broken server: 422, nothing queued.
    try {
      await openStoredBackup(prisma, backup);
    } catch (err) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: err instanceof Error ? err.message : "decrypt_failed",
        },
      });
      const refusal = storedBackupRefusal(err);
      return apiError(refusal.message, refusal.status, {
        errorCode: refusal.code,
      });
    }

    const admission = await admitBackupRestore({
      userId: backup.userId,
      actorUserId: admin.id,
      backupId: backup.id,
      backupDigest: backupDigest(storedBackupIdentity(backup)),
      restoreInstanceSettings,
    });

    if (!admission.admitted && admission.reason === "active") {
      await auditLog("admin.backups.restore.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          reason: "restore_active",
          backupId: id,
          ownerId: backup.userId,
          activeJobId: admission.activeJobId,
        },
      });
      return apiError(
        "A restore of this account is already running. Wait for it to finish before starting another.",
        409,
        { errorCode: BACKUP_RESTORE_ACTIVE_CODE, jobId: admission.activeJobId },
      );
    }
    if (!admission.admitted) {
      await auditLog("admin.backups.restore.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          reason: "enqueue_failed",
          backupId: id,
          ownerId: backup.userId,
          jobId: admission.jobId,
        },
      });
      return apiError(
        "The restore could not be handed to the background worker. Nothing was changed.",
        503,
      );
    }

    await auditLog("admin.backups.restore.queued", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId: backup.userId,
        jobId: admission.jobId,
        restoreInstanceSettings,
      },
    });
    annotate({ meta: { restore_job_id: admission.jobId } });

    return apiSuccess(
      {
        jobId: admission.jobId,
        status: "queued" as const,
        statusUrl: `/api/admin/backups/restores/${admission.jobId}`,
      },
      202,
    );
  },
);

// `withIdempotency` wraps the apiHandler so a duplicate retry with the same
// `Idempotency-Key` replays the original 202 and its job id instead of queuing
// a second restore. The default resolver picks up either the cookie session
// OR a Bearer token; for an admin endpoint only cookie sessions ever get past
// `requireAdmin()` upstream, but keeping the default keeps the contract
// uniform.
export const POST = withIdempotency(handler, async () => {
  return defaultUserIdResolver();
});
