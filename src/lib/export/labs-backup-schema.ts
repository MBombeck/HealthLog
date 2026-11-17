/**
 * The labs slice of the backup payload schema.
 *
 * Part of the labs backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/* ── Structured-record disaster-recovery shapes ─────────────────────
 *
 * These shapes serve both the historical portable export and the canonical
 * weekly/off-host disaster-recovery payload. Portable document entries remain
 * metadata-only. Canonical entries additionally carry encrypted BYTEA values
 * as base64 plus the codec/hash fields required to recreate InboundDocument
 * without decrypting or fabricating content.
 */

export const labResultBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    // The source row's id in a portable file, as on a medication.
    ref: z.string().min(1).optional(),
    panel: z.string().nullable().optional(),
    analyte: z.string().min(1),
    value: z.number().nullable().optional(),
    valueText: z.string().nullable().optional(),
    // A qualitative reading ("positive", "trace") has no unit and is stored
    // under its marker's empty one (`POST /api/labs`); the refine below keeps
    // the unit required for every numeric reading.
    unit: z.string(),
    referenceLow: z.number().nullable().optional(),
    referenceHigh: z.number().nullable().optional(),
    // Optional so a backup written before these columns existed still
    // restores; absent reads as "this reading had no source window on file".
    sourceReferenceLow: z.number().nullable().optional(),
    sourceReferenceHigh: z.number().nullable().optional(),
    sourceReferenceText: z.string().nullable().optional(),
    // The value and unit as printed, kept beside a converted
    // reading. Optional: absent on every file written before the columns.
    sourceValue: z.number().nullable().optional(),
    sourceUnit: z.string().nullable().optional(),
    takenAt: isoDateTime,
    source: z.string().min(1),
    // The identity a reading arrived under from Health Records (a digest).
    // Optional: absent on every file written before the column.
    externalId: z.string().min(1).max(128).nullable().optional(),
    biomarkerName: z.string().nullable().optional(),
    biomarkerId: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough()
  .superRefine((reading, ctx) => {
    const qualitative =
      (reading.value === null || reading.value === undefined) &&
      typeof reading.valueText === "string" &&
      reading.valueText.length > 0;
    if (reading.unit.length === 0 && !qualitative) {
      ctx.addIssue({
        code: "custom",
        path: ["unit"],
        message: "A numeric lab reading needs its unit",
      });
    }
  });
export const biomarkerBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    name: z.string().min(1),
    // Empty for a qualitative marker, minted from a reading with no unit. The
    // payload refine below refuses an empty unit on a marker a numeric
    // reading is filed under.
    unit: z.string(),
    lowerBound: z.number().nullable().optional(),
    upperBound: z.number().nullable().optional(),
    panel: z.string().nullable().optional(),
    hidden: z.boolean().optional(),
    // The catalogue analyte the marker resolves to.
    analyteKey: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    // The context's ciphertext, disaster-recovery files only. A file without
    // it carries the readable context, which the restore seals.
    contextEncrypted: base64BytesSchema.nullable().optional(),
    // The other spellings the marker answers to. Absent on
    // files written before them.
    aliases: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            name: z.string().min(1).max(120),
            source: z.enum(["MERGE", "IMPORT_CHOICE", "MANUAL"]),
            createdAt: isoDateTime.optional(),
          })
          .passthrough(),
      )
      .optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
// The ledger of markers merged into others.
export const biomarkerMergeBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    targetBiomarkerId: z.string().min(1).optional(),
    targetName: z.string().min(1),
    sourceBiomarkerId: z.string().min(1),
    sourceName: z.string().min(1).max(120),
    readingCount: z.number().int().min(0),
    mergedAt: isoDateTime,
  })
  .passthrough();
