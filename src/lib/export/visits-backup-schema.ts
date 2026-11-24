/**
 * The visits slice of the backup payload schema.
 *
 * Part of the visits backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  EncounterKind,
  EncounterStatus,
  Laterality,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";

/**
 * A practitioner, an encounter, and the edges between an encounter and the
 * things it produced.
 *
 * `id` is required on both records, unlike the lab result above: a link
 * addresses an encounter and its far side by id and nothing else on either row
 * is unique enough to rebuild the reference from. Free text follows the note
 * contract: ciphertext as base64 on a disaster-recovery file, the readable
 * value on a portable one (sealed under the receiving host's key on restore).
 */
export const practitionerBackupSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    specialty: z.string().nullable().optional(),
    practice: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    /// The address and phone ciphertext, DR payloads only.
    locationEncrypted: base64BytesSchema.nullable().optional(),
    phoneEncrypted: base64BytesSchema.nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();
export const encounterBackupSchema = z
  .object({
    id: z.string().min(1),
    occurredAt: isoDateTime,
    status: z.enum(EncounterStatus),
    kind: z.enum(EncounterKind),
    practitionerId: z.string().nullable().optional(),
    reasonEncrypted: base64BytesSchema.nullable().optional(),
    outcomeEncrypted: base64BytesSchema.nullable().optional(),
    // The procedure's body site and side. Optional so a file written
    // before they existed still parses; the visit restores with neither.
    bodySiteEncrypted: base64BytesSchema.nullable().optional(),
    // The readable reason, outcome and body site of a portable file.
    reason: z.string().nullable().optional(),
    outcome: z.string().nullable().optional(),
    bodySite: z.string().nullable().optional(),
    laterality: z.enum(Laterality).nullable().optional(),
    // Remapped against the restored reminders (they travel since v1.37.20);
    // dropped to NULL, with the drop named, only when the file lacks the row.
    reminderId: z.string().nullable().optional(),
    // The series this visit is a session of; absent in older files.
    seriesId: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();
export const encounterLinkBackupSchema = z
  .object({
    encounterId: z.string().min(1),
    targetId: z.string().min(1),
    createdAt: isoDateTime,
  })
  .passthrough();

/** A course of several visits. Absent in a file written before it. */
export const treatmentSeriesBackupSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(EncounterKind),
    plannedSessions: z.number().int().nullable().optional(),
    startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    validUntil: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    endedOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    prescriberId: z.string().nullable().optional(),
    performerId: z.string().nullable().optional(),
    episodeId: z.string().nullable().optional(),
    titleEncrypted: base64BytesSchema.nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    title: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();
