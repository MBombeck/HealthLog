/**
 * The imaging slice of the backup payload schema.
 *
 * Part of the imaging backup domain, beside its export and restore. Loaded
 * only through `src/lib/validations/backup.ts`, which composes every slice
 * into `backupPayloadSchema` on first use.
 */
import { z } from "zod/v4";
import { ImagingModality, ImagingSide } from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * One imaging exam (v1.50, #1672). Each text field travels as ciphertext on a
 * disaster-recovery file (`*Encrypted`) and readable on a portable one.
 */
export const imagingExamBackupSchema = z
  .object({
    id: z.string().min(1),
    modality: z.enum(ImagingModality),
    performedAt: isoDateTime,
    side: z.enum(ImagingSide).nullable().optional(),
    bodyPart: z.string().nullable().optional(),
    bodyPartEncrypted: base64BytesSchema.nullable().optional(),
    facility: z.string().nullable().optional(),
    facilityEncrypted: base64BytesSchema.nullable().optional(),
    requestingDoctor: z.string().nullable().optional(),
    requestingDoctorEncrypted: base64BytesSchema.nullable().optional(),
    conclusion: z.string().nullable().optional(),
    conclusionEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

/** An exam's filed document, by id. */
export const imagingExamLinkBackupSchema = z
  .object({
    examId: z.string().min(1),
    targetId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();
