/**
 * The documents slice of the backup payload schema.
 *
 * Part of the documents backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  DocumentSummaryState,
  InboundDocumentKind,
  InboundDocumentStatus,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";
import {
  DOCUMENT_SOURCE_ID_MAX,
  DOCUMENT_SOURCE_INSTANCE_MAX,
  DOCUMENT_SOURCE_SYSTEMS,
} from "@/lib/validations/inbound-documents";

export const documentBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(InboundDocumentKind),
    title: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    mimeType: z.string().min(1),
    byteSize: z.number().int(),
    status: z.enum(InboundDocumentStatus),
    reportDate: z.string().nullable().optional(),
    documentDate: z.string().nullable().optional(),
    contentEncrypted: base64BytesSchema.optional(),
    contentSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    contentCodec: z.string().min(1).optional(),
    providerType: z.string().nullable().optional(),
    errorReason: z.string().nullable().optional(),
    summaryEncrypted: base64BytesSchema.nullable().optional(),
    summaryGeneratedAt: isoDateTime.nullable().optional(),
    summaryState: z.enum(DocumentSummaryState).optional(),
    // Refs #776 — the index-attempt record (canonical DR payloads only).
    // Free string on purpose: a future outcome value must not fail a restore.
    lastIndexAttemptAt: isoDateTime.nullable().optional(),
    lastIndexOutcome: z.string().nullable().optional(),
    // Import provenance. Closed like the upload field, so a
    // restore cannot write a system the detail sheet has no name for.
    sourceSystem: z.enum(DOCUMENT_SOURCE_SYSTEMS).nullable().optional(),
    sourceId: z.string().max(DOCUMENT_SOURCE_ID_MAX).nullable().optional(),
    // The source instance (an origin). Length-bounded here and
    // normalised on restore; a value that is not an origin restores as null
    // (matches any instance) rather than failing the restore.
    sourceInstance: z
      .string()
      .max(DOCUMENT_SOURCE_INSTANCE_MAX)
      .nullable()
      .optional(),
    aiReadDeferred: z.boolean().optional(),
    extractionIncomplete: z.boolean().optional(),
    summary: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
