/**
 * The seizure-diary slice of the backup payload schema (#1368).
 *
 * Part of the seizures backup domain, beside its export and restore. Loaded
 * only through `src/lib/validations/backup.ts`, which composes every slice
 * into `backupPayloadSchema` on first use (see
 * `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  SeizureCertainty,
  SeizureDurationSource,
  SeizureEmergency,
  SeizureEventSource,
  SeizureFunctionState,
  SeizureIlaeType,
  SeizureInjury,
  SeizureObservation,
  SeizureObserverRole,
  SeizureOnsetPrecision,
  SeizurePostictal,
  SeizureRescueEffect,
  SeizureRescueRoute,
  SeizureSemiology,
  SeizureSleepState,
  SeizureTrigger,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

const text = z.string().nullable().optional();
const sealed = base64BytesSchema.nullable().optional();

/**
 * One of the person's seizure types. `label` / `labelEncrypted` and
 * `rescuePlan` / `rescuePlanEncrypted` are the two ends of the free-text
 * contract. `id` (disaster recovery) or `ref` (portable) is the source row's
 * id, which the events reference.
 */
export const seizureTypeBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    labelEncrypted: base64BytesSchema.optional(),
    ilaeType: z.enum(SeizureIlaeType),
    usualDurationSec: z.number().int().nullable().optional(),
    rescuePlan: text,
    rescuePlanEncrypted: sealed,
    rescueMedicationId: z.string().min(1).nullable().optional(),
    rescueDoseAmount: z.number().nullable().optional(),
    rescueDoseUnit: z.string().nullable().optional(),
    rescueRoute: z.enum(SeizureRescueRoute).nullable().optional(),
    sortOrder: z.number().int(),
    archivedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough()
  .refine((d) => d.label !== undefined || d.labelEncrypted !== undefined, {
    message: "A seizure type needs a label or its ciphertext",
  });

export const seizureRescueDoseBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    medicationId: z.string().min(1).nullable().optional(),
    medicationName: z.string(),
    doseAmount: z.number().nullable().optional(),
    doseUnit: z.string().nullable().optional(),
    route: z.enum(SeizureRescueRoute).nullable().optional(),
    givenAt: isoDateTime,
    givenBy: z.enum(SeizureObserverRole).nullable().optional(),
    effect: z.enum(SeizureRescueEffect),
    seizureEndedAt: isoDateTime.nullable().optional(),
    intakeEventId: z.string().min(1).nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();

/** One recorded seizure with its rescue doses nested inside. */
export const seizureEventBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    typeProfileId: z.string().min(1).nullable().optional(),
    ilaeType: z.enum(SeizureIlaeType).nullable().optional(),
    // The type's class when the seizure was logged; absent from older files.
    ilaeTypeAtLog: z.enum(SeizureIlaeType).nullable().optional(),
    onsetAt: isoDateTime,
    onsetPrecision: z.enum(SeizureOnsetPrecision),
    durationSec: z.number().int().nullable().optional(),
    durationSource: z.enum(SeizureDurationSource),
    count: z.number().int().min(1),
    certainty: z.enum(SeizureCertainty),
    sleepState: z.enum(SeizureSleepState),
    observableManifestations: z.enum(SeizureObservation).nullable().optional(),
    responsiveness: z.enum(SeizureFunctionState).nullable().optional(),
    recall: z.enum(SeizureFunctionState).nullable().optional(),
    semiology: z.array(z.enum(SeizureSemiology)).default([]),
    semiologyNote: text,
    semiologyNoteEncrypted: sealed,
    aura: text,
    auraEncrypted: sealed,
    triggers: z.array(z.enum(SeizureTrigger)).default([]),
    postictalMinutes: z.number().int().nullable().optional(),
    postictal: z.array(z.enum(SeizurePostictal)).default([]),
    injuries: z.array(z.enum(SeizureInjury)).default([]),
    incontinence: z.boolean().nullable().optional(),
    emergency: z.enum(SeizureEmergency),
    witnessed: z.boolean().nullable().optional(),
    witnessRole: z.enum(SeizureObserverRole).nullable().optional(),
    witnessNote: text,
    witnessNoteEncrypted: sealed,
    loggedBy: z.enum(["owner", "delegate", "unknown"]).optional(),
    loggedByUserId: z.string().min(1).nullable().optional(),
    source: z.enum(SeizureEventSource),
    note: text,
    noteEncrypted: sealed,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    rescueDoses: z.array(seizureRescueDoseBackupSchema).default([]),
  })
  .passthrough();

export const seizureSettingsBackupSchema = z
  .object({
    clusterCount: z.number().int().min(2).max(20),
    clusterWindowHours: z.number().int().min(1).max(168),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
