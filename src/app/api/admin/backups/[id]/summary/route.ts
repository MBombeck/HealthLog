/**
 * v1.37.20 — restore preview: what a backup file contains, BEFORE the
 * operator confirms a restore.
 *
 * The restore dialog used to ask for the typed confirmation on nothing but
 * a filename and a date; the counts only appeared in the audit row after
 * the rows were already replaced. This read decrypts and schema-validates
 * the stored file exactly the way the restore itself does (same decrypt,
 * same `parseBackupPayload`, same compatibility gate) and answers with the
 * `summarizeBackup` counts — so what the operator confirms is what the
 * restore will write, derived from the same code path. Read-only; nothing
 * is touched.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  isStoredBackupReadError,
  openStoredBackup,
  storedBackupRefusal,
  STORED_BACKUP_SELECT,
} from "@/lib/export/stored-backup";
import {
  readStreamedBackup,
  type BackupSource,
} from "@/lib/export/streamed-backup";
import { annotate } from "@/lib/logging/context";
import {
  isCompatibleSchemaVersion,
  parseBackupPayload,
  summarizeBackup,
} from "@/lib/validations/backup";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user: admin } = await requireAdmin();
    void admin;
    const { id } = await params;

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      select: {
        ...STORED_BACKUP_SELECT,
        createdAt: true,
        user: { select: { id: true, username: true } },
      },
    });
    if (!backup) {
      throw new HttpError(404, "Backup not found");
    }

    // Opened and read as a stream: a large record's JSON is longer than any
    // string V8 can hold (#1031).
    let source: BackupSource;
    try {
      source = await openStoredBackup(prisma, backup);
    } catch (err) {
      // Same refusal the restore and the download give, for the same reason:
      // a copy this instance cannot open is bad stored input, and the preview
      // is the first place an operator meets it.
      const refusal = storedBackupRefusal(err);
      return apiError(refusal.message, refusal.status, {
        errorCode: refusal.code,
      });
    }

    let payload;
    let measurementCount: number;
    try {
      const streamed = await readStreamedBackup(source);
      measurementCount = streamed.measurementCount;
      payload = parseBackupPayload(streamed.raw);
    } catch (err) {
      if (isStoredBackupReadError(err)) {
        const refusal = storedBackupRefusal(err);
        return apiError(refusal.message, refusal.status, {
          errorCode: refusal.code,
        });
      }
      return apiError("Backup payload failed schema validation", 422);
    }

    if (!isCompatibleSchemaVersion(payload.schemaVersion)) {
      return apiError(
        `Backup schema version ${payload.schemaVersion} is not restorable by this release`,
        422,
      );
    }

    const summary = {
      ...summarizeBackup(payload),
      measurements: measurementCount,
    };

    annotate({
      action: { name: "admin.backups.summary" },
      meta: { backupId: id, ownerId: backup.userId },
    });

    return apiSuccess({
      summary,
      owner: backup.user?.username ?? null,
      createdAt: backup.createdAt.toISOString(),
    });
  },
);
