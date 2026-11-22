/**
 * The record-file imports (Gadgetbridge, FHIR Bundle) as staged uploads
 * (`../staged-upload.ts`): one queue for both, the kind in the payload.
 */
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import type { StagedUploadSpec } from "@/lib/import/staged-upload";

import {
  RECORD_FILE_IMPORT_PARSER_REVISION,
  RECORD_FILE_IMPORT_QUEUE,
  RECORD_FILE_IMPORT_SEND_OPTIONS,
  RECORD_FILE_IMPORT_TMP_PREFIX,
  type RecordFileImportKind,
} from "./kinds";

/** What the worker receives. */
export interface RecordFileImportPayload {
  kind: RecordFileImportKind;
  userId: string;
  importJobId: string;
  /** Absolute path on the worker filesystem where the upload landed. */
  uploadPath: string;
}

/** The upload route of one record-file kind. */
export function recordFileUploadSpec(
  kind: RecordFileImportKind,
  maxBytes: number,
  /** "512 MB", for the refusal. */
  capLabel: string,
): StagedUploadSpec {
  return {
    action: `import.${kind}.kickoff`,
    maxBytes,
    capLabel,
    tmpPrefix: RECORD_FILE_IMPORT_TMP_PREFIX[kind],
    import: {
      kind,
      parserRevision: RECORD_FILE_IMPORT_PARSER_REVISION[kind],
      queue: RECORD_FILE_IMPORT_QUEUE,
      sendOptions: RECORD_FILE_IMPORT_SEND_OPTIONS,
      payload: ({
        userId,
        importJobId,
        uploadPath,
      }): RecordFileImportPayload => ({
        kind,
        userId,
        importJobId,
        uploadPath,
      }),
    },
  };
}

/** The caller's latest job of one kind, as the status routes answer it. */
export async function recordFileImportStatus(
  kind: RecordFileImportKind,
): Promise<Response> {
  const { user } = await requireAuth();
  annotate({ action: { name: `import.${kind}.status` } });
  const row = await prisma.importJob.findFirst({
    where: { userId: user.id, kind },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      startedAt: true,
      completedAt: true,
      uploadBytes: true,
      result: true,
      failureReason: true,
    },
  });
  return apiSuccess({
    job: row
      ? {
          jobId: row.id,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
          uploadBytes: row.uploadBytes,
          result: (row.result as Record<string, unknown> | null) ?? null,
          failureReason: row.failureReason,
        }
      : null,
  });
}
