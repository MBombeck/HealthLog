/**
 * GET /api/admin/backups/[id]/download — admin-only download of a single
 * `DataBackup` snapshot as JSON.
 *
 * The encrypted blob in the DB is decrypted, parsed, then streamed back
 * with `Content-Disposition: attachment` so the browser saves it as
 * `healthlog-backup-<userId>-<isoDate>.json`. Auth gate mirrors the rest
 * of the `/api/admin/backups` family — `requireAdmin()` (cookie session
 * only; bearer tokens never elevate).
 *
 * Phase B1 / criterion 1 of the v1.4.15 backup-completeness work: today
 * admins can list backups and trigger a manual run, but never see the
 * payload. This endpoint closes the loop without breaking the encryption-
 * at-rest contract: the ciphertext stays in the DB, the plaintext is only
 * materialised inside the request handler and streamed to the admin.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  BACKUP_UNDECRYPTABLE_CODE,
  BACKUP_UNDECRYPTABLE_ERROR,
  unpackBackupBlob,
} from "@/lib/export/backup-blob";
import { annotate } from "@/lib/logging/context";
import { parseBackupPayload } from "@/lib/validations/backup";

export const dynamic = "force-dynamic";

export const GET = apiHandler(
  async (
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> },
  ) => {
    const { user: admin } = await requireAdmin();
    const { id } = await params;
    annotate({ action: { name: "admin.backups.download" }, meta: { id } });

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      include: { user: { select: { id: true, username: true } } },
    });

    if (!backup) {
      // Audit the denied attempt — an admin trying to download a
      // backup that no longer exists is interesting on its own.
      await auditLog("admin.backups.download.denied", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: { reason: "not_found", backupId: id },
      });
      throw new HttpError(404, "Backup not found");
    }

    let plaintext: string;
    try {
      plaintext = unpackBackupBlob(backup.data);
    } catch (err) {
      // A rotated or dropped key, or a stored copy that is no longer the one
      // that was written. Both are bad stored input rather than a fault in
      // this process, so the answer is 422 with a reason the operator can act
      // on — and the audit row keeps the underlying message.
      await auditLog("admin.backups.download.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: err instanceof Error ? err.message : "decrypt_failed",
        },
      });
      return apiError(BACKUP_UNDECRYPTABLE_ERROR, 422, {
        errorCode: BACKUP_UNDECRYPTABLE_CODE,
      });
    }

    // Validate the payload BEFORE handing it back. This catches the
    // pathological case where the worker wrote something the upload
    // route would later reject — better to fail loudly here than to ship
    // a junk file that breaks an admin's restore plan.
    try {
      parseBackupPayload(plaintext);
    } catch (err) {
      await auditLog("admin.backups.download.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: "schema_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return apiError("Backup payload failed schema validation", 500);
    }

    const isoDate = backup.createdAt.toISOString().slice(0, 10); // YYYY-MM-DD
    const filename = `healthlog-backup-${backup.userId}-${isoDate}.json`;

    await auditLog("admin.backups.download", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: {
        backupId: id,
        ownerId: backup.userId,
        ownerUsername: backup.user.username,
        type: backup.type,
        sizeBytes: Buffer.byteLength(plaintext, "utf8"),
      },
    });

    // Returning the plaintext as-is keeps the response a faithful copy of
    // what the worker wrote (formatting, key order). The file is the
    // canonical artefact admins will store / re-upload.
    return new NextResponse(plaintext, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        // Backups contain sensitive health data — keep them out of any
        // shared cache (CDN, browser disk cache).
        "cache-control": "no-store, max-age=0",
      },
    });
  },
);
