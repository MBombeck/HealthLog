/**
 * The sensitive slice of the backup payload schema.
 *
 * Part of the sensitive backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { AssessmentInstrument } from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";
import { ASSESSMENT_WORDINGS } from "@/lib/mental-health/wording/types";

/**
 * A completed screener administration. `responsesEncrypted` is REQUIRED rather
 * than optional, unlike every other ciphertext field in this file: the column
 * is NOT NULL, so a file that omits it describes a row that cannot be written,
 * and saying so at the schema is better than discovering it inside the
 * transaction that has already wiped the account.
 */
export const mentalHealthAssessmentBackupSchema = z
  .object({
    id: z.string().min(1),
    instrument: z.enum(AssessmentInstrument),
    locale: z.string().min(1),
    wording: z.enum(ASSESSMENT_WORDINGS).nullable().optional(),
    version: z.string().optional(),
    responsesEncrypted: base64BytesSchema,
    totalScore: z.number().int(),
    severityBand: z.string().min(1),
    item9Flagged: z.boolean().optional(),
    crisisShownAt: isoDateTime.nullable().optional(),
    takenAt: isoDateTime,
    tz: z.string().nullable().optional(),
    source: z.string().optional(),
    externalId: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();
export const consentReceiptBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    artefact: z.string().min(1),
    signedAt: isoDateTime,
    revokedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
