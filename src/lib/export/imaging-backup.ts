/**
 * Imaging exams (#1672), with both backup ends in one file.
 *
 * A disaster-recovery payload carries the four sealed text fields verbatim as
 * base64; a portable export opens them, because a portable file exists to be
 * readable by its owner and to restore under another instance's key. A value
 * this host cannot open travels as the visible unreadable marker.
 *
 * The document links travel by id, the vaccination shape: the exam first,
 * then the link, written only when the document came back in the same
 * restore. A link whose document did not come back is dropped and named under
 * `relationLink`; the exam restores either way.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ImagingModality, ImagingSide } from "@/generated/prisma/client";

import {
  encodeSealedBytes,
  openSealedBytesForExport,
  sealBytesForRestore,
} from "@/lib/export/sealed-text";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface ImagingBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** The four sealed text fields, in column order. */
const TEXT_FIELDS = [
  "bodyPart",
  "facility",
  "requestingDoctor",
  "conclusion",
] as const;
type TextField = (typeof TEXT_FIELDS)[number];
type SealedField = `${TextField}Encrypted`;

export type ImagingExamBackupEntry = {
  id: string;
  modality: ImagingModality;
  performedAt: string;
  side: ImagingSide | null;
  createdAt: string;
  updatedAt: string;
} & Partial<Record<TextField, string | null>> &
  Partial<Record<SealedField, string | null>>;

export interface ImagingExamLinkBackupEntry {
  examId: string;
  targetId: string;
  createdAt: string;
}

export interface ImagingBackupSection {
  imagingExams: ImagingExamBackupEntry[];
  imagingExamDocumentLinks: ImagingExamLinkBackupEntry[];
}

export interface ImagingBackupCounts {
  imagingExams: number;
  imagingExamDocumentLinks: number;
}

/** Build the imaging slice of a user's full backup. */
export async function buildImagingBackupSection(
  prisma: Pick<PrismaClient, "imagingExam" | "imagingExamDocumentLink">,
  userId: string,
  options: ImagingBackupOptions = {},
): Promise<ImagingBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [rows, links] = await Promise.all([
    prisma.imagingExam.findMany({
      where: { userId },
      orderBy: [{ performedAt: "desc" }, { id: "asc" }],
    }),
    prisma.imagingExamDocumentLink.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { examId: true, documentId: true, createdAt: true },
    }),
  ]);

  return {
    imagingExams: rows.map((row) => {
      const text: Partial<Record<TextField | SealedField, string | null>> = {};
      for (const field of TEXT_FIELDS) {
        const sealed = row[`${field}Encrypted`];
        if (disasterRecovery) {
          text[`${field}Encrypted`] = encodeSealedBytes(sealed);
        } else {
          text[field] = openSealedBytesForExport(sealed, `imaging ${field}`);
        }
      }
      return {
        id: row.id,
        modality: row.modality,
        performedAt: row.performedAt.toISOString(),
        side: row.side,
        ...text,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    imagingExamDocumentLinks: links.map((link) => ({
      examId: link.examId,
      targetId: link.documentId,
      createdAt: link.createdAt.toISOString(),
    })),
  };
}

export function countImagingBackupSection(
  section: ImagingBackupSection,
): ImagingBackupCounts {
  return {
    imagingExams: section.imagingExams.length,
    imagingExamDocumentLinks: section.imagingExamDocumentLinks.length,
  };
}

/** Counts the imaging restore wiped, for the audit trail. */
export interface ImagingRestoreCleared {
  imagingExams: number;
}

/** What the parser hands over; a file from before v1.50 carries no key. */
export interface ImagingRestoreInput {
  imagingExams: Array<
    {
      id: string;
      modality: ImagingModality;
      performedAt: string;
      side?: ImagingSide | null | undefined;
      createdAt: string;
      updatedAt: string;
    } & Partial<Record<TextField | SealedField, string | null | undefined>>
  >;
  imagingExamDocumentLinks: Array<{
    examId: string;
    targetId: string;
    createdAt: string;
  }>;
}

/**
 * Re-create the account's imaging exams and their document links.
 *
 * MUST run after the documents are restored: a link is written only when its
 * document came back.
 */
export async function restoreImagingData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: ImagingRestoreInput,
  skips: RestoreSkipLog,
): Promise<ImagingRestoreCleared> {
  // The links cascade from the exam; deleting the exams clears both.
  const cleared = await tx.imagingExam.deleteMany({
    where: { userId: ownerId },
  });

  const unopened: string[] = [];
  if (payload.imagingExams.length > 0) {
    await tx.imagingExam.createMany({
      data: payload.imagingExams.map((entry) => {
        const seal = (field: TextField) =>
          sealBytesForRestore(
            entry[`${field}Encrypted`],
            entry[field],
            `imagingExams.${entry.id}.${field}Encrypted`,
            unopened,
          );
        return {
          id: entry.id,
          userId: ownerId,
          modality: entry.modality,
          performedAt: new Date(entry.performedAt),
          side: entry.side ?? null,
          bodyPartEncrypted: seal("bodyPart"),
          facilityEncrypted: seal("facility"),
          requestingDoctorEncrypted: seal("requestingDoctor"),
          conclusionEncrypted: seal("conclusion"),
          createdAt: new Date(entry.createdAt),
          updatedAt: new Date(entry.updatedAt),
        };
      }),
    });
  }
  recordUnknownKeys(skips, "imagingCiphertext", unopened, unopened);

  const restoredExams = new Set(payload.imagingExams.map((entry) => entry.id));
  const documents = await tx.inboundDocument.findMany({
    where: { userId: ownerId },
    select: { id: true },
  });
  const restoredDocuments = new Set(documents.map((row) => row.id));

  const writable: Array<{
    examId: string;
    documentId: string;
    createdAt: Date;
  }> = [];
  const dropped: string[] = [];
  for (const link of payload.imagingExamDocumentLinks) {
    if (
      restoredExams.has(link.examId) &&
      restoredDocuments.has(link.targetId)
    ) {
      writable.push({
        examId: link.examId,
        documentId: link.targetId,
        createdAt: new Date(link.createdAt),
      });
    } else {
      dropped.push(link.targetId);
    }
  }
  if (writable.length > 0) {
    await tx.imagingExamDocumentLink.createMany({
      data: writable.map((row) => ({
        userId: ownerId,
        examId: row.examId,
        documentId: row.documentId,
        createdAt: row.createdAt,
      })),
      skipDuplicates: true,
    });
  }
  recordUnknownKeys(skips, "relationLink", [...new Set(dropped)], dropped);

  return { imagingExams: cleared.count };
}
