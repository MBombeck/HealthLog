/**
 * The workouts slice of the backup payload schema.
 *
 * Part of the workouts backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { MeasurementSource } from "@/generated/prisma/enums";
import { isoDateTime } from "@/lib/export/backup-schema-kit";

export const workoutBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    sportType: z.string().min(1),
    startedAt: isoDateTime,
    endedAt: isoDateTime,
    durationSec: z.number().int(),
    totalEnergyKcal: z.number().nullable().optional(),
    totalDistanceM: z.number().nullable().optional(),
    avgHeartRate: z.number().int().nullable().optional(),
    maxHeartRate: z.number().int().nullable().optional(),
    minHeartRate: z.number().int().nullable().optional(),
    stepCount: z.number().int().nullable().optional(),
    elevationM: z.number().nullable().optional(),
    pauseDurationSec: z.number().int().nullable().optional(),
    source: z.enum(MeasurementSource),
    externalId: z.string().nullable().optional(),
    externalSourceVersion: z.string().nullable().optional(),
    metadata: z.json().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
