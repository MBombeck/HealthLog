/**
 * v1.37.20 — restore preview: what a backup file contains, BEFORE the
 * operator confirms a restore.
 *
 * The restore dialog used to ask for the typed confirmation on nothing but
 * a filename and a date; the counts only appeared in the audit row after
 * the rows were already replaced. This answers with the `summarizeBackup`
 * counts of the stored copy, and refuses the way the restore would refuse:
 * a schema version this release cannot restore, or a key the copy's inner
 * ciphertext needs and this server does not have.
 *
 * The counts are worked out while the copy is written and kept on its row
 * (`DataBackup.preview`, `src/lib/export/backup-preview.ts`), so this answers
 * without opening the copy. Reading the copy here took two minutes for an
 * account of 1.8 million readings on slow hardware, long after the dialog had
 * given up (#1031). Both verdicts are taken again on every read, from what
 * the preview keeps, because the release and the server's keys can both
 * change after the copy was written. The copy's pieces are still counted
 * against the row (no piece is read), so a copy that lost one since is
 * refused here, as the restore and the download refuse it.
 *
 * A copy written before previews existed has none. That one is read whole,
 * once: the preview worked out from it is stored on the row, so the next
 * request answers at once, and concurrent requests for the same copy share
 * the one read.
 */
import { NextRequest } from "next/server";
import { ZodError } from "zod/v4";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { apiHandler, HttpError, requireAdmin } from "@/lib/api-handler";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  checkStoredBackupShape,
  isStoredBackupReadError,
  openStoredBackup,
  storedBackupRefusal,
  STORED_BACKUP_SELECT,
  type StoredBackupRef,
} from "@/lib/export/stored-backup";
import {
  assessBackupKeys,
  BACKUP_KEY_MISSING_CODE,
  BackupKeyIdCollector,
  describeBackupKeyProblem,
} from "@/lib/export/backup-key-ids";
import { BackupJsonError } from "@/lib/export/backup-json-scan";
import {
  buildBackupPreview,
  storedCopyIdentity,
  storedPreviewFor,
  type BackupPreview,
} from "@/lib/export/backup-preview";
import {
  readStreamedBackup,
  StreamedBackupInvalidError,
} from "@/lib/export/streamed-backup";
import { annotate } from "@/lib/logging/context";
import {
  isCompatibleSchemaVersion,
  summarizeBackup,
} from "@/lib/validations/backup-summary";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ id: string }> };

/** Why a copy could not be summarised, as the route answers it. */
type Refusal = { status: number; message: string; code?: string };

type ReadOutcome = { preview: BackupPreview } | { refusal: Refusal };

/**
 * Reads of a copy without a preview that are running now, by copy. A second
 * request for the same copy (the dialog opened again while the first read is
 * still going) waits for the first instead of reading it all again.
 */
const inFlight = new Map<string, Promise<ReadOutcome>>();

/** Whether a failure is the file itself not being a backup this reads. */
function isPayloadInvalid(err: unknown): boolean {
  return (
    err instanceof BackupJsonError ||
    err instanceof StreamedBackupInvalidError ||
    err instanceof ZodError
  );
}

/**
 * Read a copy whole and work out its preview: the way every preview was
 * taken before previews were stored. Throws for anything that is neither a
 * read refusal nor a file that fails the schema, which the handler answers
 * as a server fault.
 */
async function readPreview(
  backup: StoredBackupRef,
  copy: string,
): Promise<ReadOutcome> {
  const refused = (err: unknown): ReadOutcome => {
    const refusal = storedBackupRefusal(err);
    return {
      refusal: {
        status: refusal.status,
        message: refusal.message,
        code: refusal.code,
      },
    };
  };

  // Opened and read as a stream: a large record's JSON is longer than any
  // string V8 can hold (#1031).
  let source;
  try {
    source = await openStoredBackup(prisma, backup);
  } catch (err) {
    // Same refusal the restore and the download give, for the same reason:
    // a copy this instance cannot open is bad stored input, and the preview
    // is the first place an operator meets it.
    return refused(err);
  }

  try {
    const streamed = await readStreamedBackup(source);
    // Loaded on first use, not at import (see `backup-summary.ts`).
    const { parseBackupPayload } = await import("@/lib/validations/backup");
    const payload = parseBackupPayload(streamed.raw);
    const summary = {
      ...summarizeBackup(payload),
      measurements: streamed.measurementCount,
    };
    return { preview: buildBackupPreview(copy, summary, streamed.keys) };
  } catch (err) {
    if (isStoredBackupReadError(err)) return refused(err);
    // Only a file that is not a backup this release reads is a 422. Anything
    // else is this server failing, not the file, and is answered as such.
    if (isPayloadInvalid(err)) {
      return {
        refusal: {
          status: 422,
          message: "Backup payload failed schema validation",
        },
      };
    }
    throw err;
  }
}

/**
 * Keep a preview worked out by reading the copy, so the next request answers
 * without reading it. Written only while the row still holds the copy it was
 * read from; a failure here costs the next request the same read, nothing
 * more, so it is noted and not raised.
 */
async function keepPreview(
  backup: StoredBackupRef,
  preview: BackupPreview,
): Promise<void> {
  try {
    await prisma.dataBackup.updateMany({
      where: {
        id: backup.id,
        chunkStreamId: backup.chunkStreamId,
        chunkCount: backup.chunkCount,
      },
      data: { preview: preview as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    annotate({
      action: { name: "admin.backups.summary.keep_failed" },
      meta: {
        backupId: backup.id,
        error: err instanceof Error ? err.name : "unknown",
      },
    });
  }
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user: admin } = await requireAdmin();
    void admin;
    const { id } = await params;

    const backup = await prisma.dataBackup.findUnique({
      where: { id },
      select: {
        ...STORED_BACKUP_SELECT,
        preview: true,
        createdAt: true,
        user: { select: { id: true, username: true } },
      },
    });
    if (!backup) {
      throw new HttpError(404, "Backup not found");
    }

    let preview = storedPreviewFor(backup.preview, backup);
    const fromStore = preview !== null;
    if (preview) {
      // The counts were kept; the copy's pieces are still counted, so a copy
      // that lost one since is refused here as the restore would refuse it.
      // Tampering inside a piece is found by the restore's own open, before
      // it deletes anything.
      try {
        await checkStoredBackupShape(prisma, backup);
      } catch (err) {
        if (!isStoredBackupReadError(err)) throw err;
        const refusal = storedBackupRefusal(err);
        return refusalResponse({
          status: refusal.status,
          message: refusal.message,
          code: refusal.code,
        });
      }
    }
    if (!preview) {
      const copy = storedCopyIdentity(backup);
      if (copy === null) {
        // A row holding both forms, or neither: the open refuses it, with
        // the reason.
        const outcome = await readPreview(backup, "");
        if ("refusal" in outcome) return refusalResponse(outcome.refusal);
        throw new Error("A stored backup with no nameable copy was read");
      }
      const flight = `${backup.id}:${copy}`;
      let pending = inFlight.get(flight);
      if (!pending) {
        pending = readPreview(backup, copy).finally(() => {
          inFlight.delete(flight);
        });
        inFlight.set(flight, pending);
        // Kept whatever the verdicts below say: they are taken again on
        // every read, and the counts do not change.
        void pending.then(
          (outcome) =>
            "preview" in outcome ? keepPreview(backup, outcome.preview) : null,
          () => null,
        );
      }
      const outcome = await pending;
      if ("refusal" in outcome) return refusalResponse(outcome.refusal);
      preview = outcome.preview;
    }

    const { summary } = preview;
    if (!isCompatibleSchemaVersion(summary.schemaVersion)) {
      return apiError(
        `Backup schema version ${summary.schemaVersion} is not restorable by this release`,
        422,
      );
    }

    // The preview is where the operator decides, so it says what the restore
    // would refuse: a key the file's inner ciphertext needs and this host
    // does not have. The instance settings are left out here, as the restore
    // leaves them out unless asked; the restore itself checks them when they
    // are asked for.
    const keyVerdict = assessBackupKeys(
      BackupKeyIdCollector.fromStored(preview.keys),
      { ignoreSections: new Set(["appSettings"]) },
    );
    const keyProblem = describeBackupKeyProblem(keyVerdict);
    if (keyProblem) {
      return apiError(keyProblem, 422, {
        errorCode: BACKUP_KEY_MISSING_CODE,
        keyIds: [...keyVerdict.missing, ...keyVerdict.unreadable],
      });
    }

    annotate({
      action: { name: "admin.backups.summary" },
      meta: { backupId: id, ownerId: backup.userId, fromStore },
    });

    return apiSuccess({
      summary,
      owner: backup.user?.username ?? null,
      createdAt: backup.createdAt.toISOString(),
    });
  },
);

function refusalResponse(refusal: Refusal) {
  return apiError(
    refusal.message,
    refusal.status,
    refusal.code ? { errorCode: refusal.code } : undefined,
  );
}
