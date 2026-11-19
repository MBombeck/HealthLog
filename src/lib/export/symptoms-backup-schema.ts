/**
 * The symptoms slice of the backup payload schema.
 *
 * Part of the symptoms backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * A person-defined symptom (v1.40) with every occurrence of it nested inside,
 * the way a medication carries its side effects. `label` / `labelEncrypted`
 * and `note` / `noteEncrypted` are the two ends of the free-text contract: a
 * portable file carries the plaintext, a disaster-recovery file the ciphertext.
 * An occurrence's `episodeId` is the exported episode's own id; the restore
 * nulls one that names an episode the file does not carry.
 */
export const symptomEventBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    occurredAt: isoDateTime,
    intensity: z.number().int().min(0).max(10),
    note: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    episodeId: z.string().min(1).nullable().optional(),
    // Apple Health provenance (v1.48.2). Absent on an older file: a manual
    // occurrence with no end and no tombstone.
    endAt: isoDateTime.nullable().optional(),
    source: z.string().min(1).max(40).optional(),
    externalId: z.string().min(1).max(120).nullable().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .passthrough();
export const symptomDefinitionBackupSchema = z
  .object({
    id: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    labelEncrypted: base64BytesSchema.optional(),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    // The built-in code (v1.48.2); absent on an older file, null for a
    // symptom the person named.
    code: z.string().min(1).max(80).nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    events: z.array(symptomEventBackupSchema).default([]),
  })
  .passthrough()
  .refine((d) => d.label !== undefined || d.labelEncrypted !== undefined, {
    message: "A symptom definition needs a label or its ciphertext",
  });
