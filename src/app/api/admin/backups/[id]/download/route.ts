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
import { Readable } from "node:stream";

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  isStoredBackupReadError,
  openStoredBackup,
  storedBackupRefusal,
  STORED_BACKUP_SELECT,
} from "@/lib/export/stored-backup";
import {
  readStreamedBackup,
  type BackupSource,
  type StreamedBackup,
} from "@/lib/export/streamed-backup";
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
      select: {
        ...STORED_BACKUP_SELECT,
        type: true,
        createdAt: true,
        user: { select: { id: true, username: true } },
      },
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

    // Opened and streamed, never unpacked into one string: a large record's
    // JSON is longer than any string V8 can hold (#1031). Opening checks
    // every stored piece first.
    let source: BackupSource;
    try {
      source = await openStoredBackup(prisma, backup);
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
      const refusal = storedBackupRefusal(err);
      return apiError(refusal.message, refusal.status, {
        errorCode: refusal.code,
      });
    }

    // Validate the payload BEFORE handing it back. This catches the
    // pathological case where the worker wrote something the upload
    // route would later reject — better to fail loudly here than to ship
    // a junk file that breaks an admin's restore plan.
    let streamed: StreamedBackup;
    try {
      streamed = await readStreamedBackup(source);
      parseBackupPayload(streamed.raw);
    } catch (err) {
      const readFailure = isStoredBackupReadError(err);
      await auditLog("admin.backups.download.failed", {
        userId: admin.id,
        ipAddress: getClientIp(request),
        details: {
          backupId: id,
          ownerId: backup.userId,
          reason: readFailure ? "read_failed" : "schema_invalid",
          message: err instanceof Error ? err.message : String(err),
        },
      });
      if (readFailure) {
        // The copy changed between opening and reading (replaced by the
        // weekly run, or altered): the same answer the open gives.
        const refusal = storedBackupRefusal(err);
        return apiError(refusal.message, refusal.status, {
          errorCode: refusal.code,
        });
      }
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
        sizeBytes: streamed.bytes,
      },
    });

    // Returning the stored bytes as-is keeps the response a faithful copy of
    // what the worker wrote (formatting, key order). The file is the
    // canonical artefact admins will store / re-upload.
    return new NextResponse(
      Readable.toWeb(Readable.from(source())) as ReadableStream<Uint8Array>,
      {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          // Backups contain sensitive health data — keep them out of any
          // shared cache (CDN, browser disk cache).
          "cache-control": "no-store, max-age=0",
          "content-length": String(streamed.bytes),
        },
      },
    );
  },
);
