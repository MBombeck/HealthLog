/**
 * The document filing slice of the backup payload schema.
 *
 * Part of the document filing backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  ExtractedFactStatus,
  ExtractedFactType,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";
import {
  DOCUMENT_SOURCE_ID_MAX,
  DOCUMENT_SOURCE_INSTANCE_MAX,
  DOCUMENT_SOURCE_SYSTEMS,
} from "@/lib/validations/inbound-documents";

/** One document filed against one condition episode. */
export const documentConditionLinkBackupSchema = z
  .object({
    documentId: z.string().min(1),
    episodeId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();
/**
 * One fact the extraction pass staged against a document.
 *
 * `status`, `confidence` and `needsReview` are REQUIRED rather than defaulted,
 * unlike most optional-looking fields in this file. Each has a schema default
 * that means "nobody has looked at this yet", and the confirm endpoint acts on
 * a PENDING fact by committing it into the structured store — so a file that
 * does not state the review decision must fail to parse rather than have one
 * invented for it and let an already-committed reading be approved twice.
 *
 * `dataEncrypted` / `data` and their provenance siblings are the two ends of
 * the same contract, so all four are optional and exactly one pair arrives: a
 * disaster-recovery file carries the ciphertext, a portable file carries the
 * decrypted JSON.
 */
export const extractedFactBackupSchema = z
  .object({
    id: z.string().min(1),
    documentId: z.string().min(1),
    factType: z.enum(ExtractedFactType),
    status: z.enum(ExtractedFactStatus),
    confidence: z.number(),
    needsReview: z.boolean(),
    committedRecordId: z.string().nullable().optional(),
    committedRecordType: z.string().nullable().optional(),
    dataEncrypted: base64BytesSchema.optional(),
    provenanceEncrypted: base64BytesSchema.optional(),
    data: z.json().optional(),
    provenance: z.json().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

/**
 * One import source key the person deleted the document of (the import
 * ledger). Closed and bounded like the upload's own fields, so a restore
 * cannot write a key the upload could never have stored.
 */
export const documentImportKeyBackupSchema = z
  .object({
    sourceSystem: z.enum(DOCUMENT_SOURCE_SYSTEMS),
    sourceId: z.string().min(1).max(DOCUMENT_SOURCE_ID_MAX),
    sourceInstance: z
      .string()
      .max(DOCUMENT_SOURCE_INSTANCE_MAX)
      .nullable()
      .optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
