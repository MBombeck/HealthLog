/**
 * The measurements slice of the backup payload schema.
 *
 * Part of the measurements backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  GlucoseContext,
  MeasurementAggregationProvenance,
  MeasurementSource,
  MeasurementType,
  RhythmClassification,
  SleepStage,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

export const measurementSchema = z
  .object({
    id: z.string().min(1).optional(),
    type: z.enum(MeasurementType),
    value: z.number(),
    valueMin: z.number().nullable().optional(),
    valueMax: z.number().nullable().optional(),
    unit: z.string().min(1),
    measuredAt: isoDateTime,
    source: z.enum(MeasurementSource).optional(),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    externalId: z.string().nullable().optional(),
    externalSourceVersion: z.string().nullable().optional(),
    // Authority of a `stats:` aggregate. `.optional()` keeps every backup
    // written before this field rode the payload parseable.
    aggregationProvenance: z
      .enum(MeasurementAggregationProvenance)
      .nullable()
      .optional(),
    glucoseContext: z.enum(GlucoseContext).nullable().optional(),
    sleepStage: z.enum(SleepStage).nullable().optional(),
    rhythmClassification: z.enum(RhythmClassification).nullable().optional(),
    deviceType: z.string().nullable().optional(),
    // The token that carried an EXTERNAL reading (#1272). Kept on restore
    // only when the restoring account still holds that token.
    ingestTokenId: z.string().max(64).nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
