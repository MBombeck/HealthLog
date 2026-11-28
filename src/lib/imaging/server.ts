/**
 * Imaging exams (#1672): what the routes share. The include, the sealing of
 * the free text, the DTO, and the filing of vault documents.
 *
 * Free text is sealed through the shared Bytes codec and opened fail-soft: a
 * key gap on one row reads `null` and warns on the wide event rather than
 * failing the list.
 */
import type { Prisma } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import { replaceTargets } from "@/lib/links";
import { getEvent } from "@/lib/logging/context";
import type { ShareDomain } from "@/lib/sharing/scope";

import type {
  ImagingExamDTO,
  ImagingExamDocumentDTO,
  ImagingModality,
  ImagingSide,
} from "./shared";

/** The filed documents, live ones only, with what a row needs to name them. */
export const IMAGING_EXAM_INCLUDE = {
  documentLinks: {
    where: { document: { deletedAt: null } },
    orderBy: { createdAt: "asc" },
    select: {
      document: {
        select: {
          id: true,
          title: true,
          filename: true,
          mimeType: true,
          documentDate: true,
          reportDate: true,
          createdAt: true,
        },
      },
    },
  },
} as const satisfies Prisma.ImagingExamInclude;

export type ImagingExamRow = Prisma.ImagingExamGetPayload<{
  include: typeof IMAGING_EXAM_INCLUDE;
}>;

/** Seal a text field; `undefined` leaves it alone, empty or null clears it. */
export function sealImagingText(
  value: string | null | undefined,
): Uint8Array<ArrayBuffer> | null | undefined {
  if (value === undefined) return undefined;
  return value ? encryptToBytes(value) : null;
}

/** Open a sealed text; null on a missing or unreadable value. */
export function openImagingText(
  buf: Uint8Array | null,
  field: string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptFromBytes(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `imaging ${field} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * The DTO. A grant that opened the labs section but not the vault learns that
 * a document is filed, not what it is called: the filename is often the
 * sensitive part. `label: null` with `redacted: true` says which null it is.
 */
export function toImagingExamDTO(
  row: ImagingExamRow,
  visible: (domain: ShareDomain) => boolean,
): ImagingExamDTO {
  const showDocuments = visible("documents");
  const documents: ImagingExamDocumentDTO[] = row.documentLinks.map(
    ({ document }) =>
      showDocuments
        ? {
            id: document.id,
            label: document.title || document.filename || document.id,
            date: (
              document.documentDate ??
              document.reportDate ??
              document.createdAt
            ).toISOString(),
            mimeType: document.mimeType,
            redacted: false,
          }
        : {
            id: document.id,
            label: null,
            date: null,
            mimeType: null,
            redacted: true,
          },
  );
  return {
    id: row.id,
    modality: row.modality as ImagingModality,
    performedAt: row.performedAt.toISOString(),
    side: (row.side as ImagingSide | null) ?? null,
    bodyPart: openImagingText(row.bodyPartEncrypted, "bodyPart"),
    facility: openImagingText(row.facilityEncrypted, "facility"),
    requestingDoctor: openImagingText(
      row.requestingDoctorEncrypted,
      "requestingDoctor",
    ),
    conclusion: openImagingText(row.conclusionEncrypted, "conclusion"),
    documents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * File the named documents against the exam, replacing what was there. An
 * absent array leaves the links alone. Ids the account does not own, or has
 * deleted, are dropped by the link service and returned, never written.
 */
export async function applyImagingExamDocuments(
  tx: Prisma.TransactionClient,
  userId: string,
  examId: string,
  documentIds: string[] | undefined,
): Promise<string[]> {
  if (documentIds === undefined) return [];
  const result = await replaceTargets(tx, {
    userId,
    sourceKind: "imagingExam",
    sourceId: examId,
    targetKind: "document",
    targetIds: documentIds,
  });
  return result.unknownTargetIds;
}

/** Normalise an ISO instant to the UTC midnight of its calendar day. */
export function examDayAtUtcMidnight(iso: string): Date {
  const at = new Date(iso);
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}
