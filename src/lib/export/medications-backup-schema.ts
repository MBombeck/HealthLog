/**
 * The medications slice of the backup payload schema.
 *
 * Part of the medications backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  InjectionSite,
  IntakeAttributionSource,
  IntakeSource,
  MeasurementType,
  MedicationCategory,
  MedicationContainerType,
  MedicationDeliveryForm,
  MedicationInventoryState,
  MedicationScheduleType,
  MedicationSideEffectCategory,
  MedicationSideEffectEntry,
  PhaseMode,
} from "@/generated/prisma/enums";
import { base64BytesSchema, isoDateTime } from "@/lib/export/backup-schema-kit";
import {
  UNITS_PER_DOSE_MESSAGE,
  isSupportedUnitsPerDose,
} from "@/lib/medications/units-per-dose";

// #1034 — the restore applies the write routes' units-per-dose rule. A
// backup carries the Decimal column as a string ("1.5"); a hand-authored
// file may carry a number. `Number("")` is 0, so an empty string fails too.
export const unitsPerDoseValue = z
  .union([z.string(), z.number()])
  .refine((v) => isSupportedUnitsPerDose(Number(v)), {
    message: UNITS_PER_DOSE_MESSAGE,
  });
export const medicationScheduleSchema = z
  .object({
    id: z.string().min(1).optional(),
    windowStart: z.string().min(1),
    windowEnd: z.string().min(1),
    label: z.string().nullable().optional(),
    dose: z.string().nullable().optional(),
    // #219 — per-schedule units per dose. Serialised as a Decimal string in a
    // DR file (or a number in a hand-authored one); NULL means inherit.
    unitsPerDose: unitsPerDoseValue.nullable().optional(),
    daysOfWeek: z.string().nullable().optional(),
    timesOfDay: z.array(z.string()).optional(),
    reminderGraceMinutes: z.number().int().nullable().optional(),
    rrule: z.string().nullable().optional(),
    rollingIntervalDays: z.number().int().nullable().optional(),
    scheduleType: z.enum(MedicationScheduleType).optional(),
    cyclicOnWeeks: z.number().int().nullable().optional(),
    cyclicOffWeeks: z.number().int().nullable().optional(),
    doseWindows: z.unknown().nullable().optional(),
  })
  .passthrough();
/**
 * One recorded side effect, carried inside its medication.
 *
 * `notes` is the decrypted note in a portable export and the row's legacy
 * plaintext column in a canonical DR file; `notesEncrypted` is the base64
 * ciphertext and rides only in the DR case. The restore prefers the ciphertext
 * and encrypts the plaintext when that is all the file has, so neither shape
 * loses the note and neither writes plaintext back into the column.
 */
export const medicationSideEffectSchema = z
  .object({
    id: z.string().min(1).optional(),
    occurredAt: isoDateTime,
    category: z.enum(MedicationSideEffectCategory),
    entry: z.enum(MedicationSideEffectEntry),
    severity: z.number().int().min(1).max(5),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * A span during which the drug was deliberately not taken.
 *
 * `resumedAt` is nullable rather than optional, and the writer always emits
 * it. An absent key and an explicit `null` would otherwise both have to mean
 * "still paused", and a file that simply forgot the field would assert an open
 * era that never existed. Readers run an open era to `now`.
 */
export const medicationPauseEraSchema = z
  .object({
    id: z.string().min(1).optional(),
    pausedAt: isoDateTime,
    resumedAt: isoDateTime.nullable(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * One ingredient of a medication's composition per unit, in the
 * catalogue's canonical unit. The code stays a string: a file from a newer
 * server may name a nutrient this one does not know, and the row is still
 * the person's.
 */
export const medicationIngredientSchema = z
  .object({
    id: z.string().min(1).optional(),
    nutrient: z.string().min(1).max(40),
    amountPerUnit: z.number().finite().positive(),
    unit: z.string().min(1).max(8),
    enteredAmount: z.number().finite().nullable().optional(),
    enteredUnit: z.string().max(8).nullable().optional(),
    source: z.enum(["MANUAL", "LABEL_AI"]).default("MANUAL"),
    createdAt: isoDateTime.optional(),
    // The row's last write. Disaster-recovery files only; a file without it
    // restores the row stamped with the restore, as before.
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * One course of a medication: a calendar span (both ends
 * inclusive, `YYYY-MM-DD`). The note travels decrypted in both purposes and
 * is sealed again on restore, like the custom category label.
 */
export const medicationCourseSchema = z
  .object({
    startsOn: z.iso.date(),
    endsOn: z.iso.date().nullable(),
    // #1280 — the instant "End course" ended the course, on its `endsOn`
    // day. A file without it (any written before) restores the full-day end.
    endedAt: isoDateTime.nullable().optional(),
    note: z.string().max(280).nullable().optional(),
    // The note's ciphertext, disaster-recovery files only. A file without it
    // (any written before) carries the readable note, which the restore seals.
    noteEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * One step of a titration: when the dose moved and to what.
 *
 * The note follows the side-effect contract — decrypted prose in a portable
 * file, ciphertext plus any legacy plaintext in a recovery one.
 */
export const medicationDoseChangeSchema = z
  .object({
    id: z.string().min(1).optional(),
    effectiveFrom: isoDateTime,
    doseValue: z.number(),
    doseUnit: z.string().min(1),
    note: z.string().nullable().optional(),
    noteEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * A pack on the shelf. `unitsTotal` / `unitsRemaining` cross the wire as
 * STRINGS: the columns are `Decimal(12,4)` because half tablets are a real
 * prescription, and a JSON number would round them on the way through.
 */
export const medicationInventoryItemSchema = z
  .object({
    id: z.string().min(1).optional(),
    state: z.enum(MedicationInventoryState).optional(),
    containerType: z.enum(MedicationContainerType).optional(),
    unitsTotal: z.string().min(1),
    unitsRemaining: z.string().min(1),
    firstUseAt: isoDateTime.nullable().optional(),
    expiresAt: isoDateTime.nullable().optional(),
    printedExpiry: isoDateTime.nullable().optional(),
    purchasedAt: isoDateTime.nullable().optional(),
    manufacturer: z.string().nullable().optional(),
    doseStrength: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    notesEncrypted: base64BytesSchema.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
export const medicationInventoryEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    delta: z.number().int(),
    reason: z.string().min(1),
    occurredAt: isoDateTime,
  })
  .passthrough();
/**
 * The four reminder thresholds a drug was tuned to. Every field optional, so a
 * file written before a threshold existed restores the schema default rather
 * than refusing — but the OBJECT is nullable rather than absent, because "no
 * tuning" and "this file does not say" are different claims.
 */
export const reminderPhaseConfigSchema = z
  .object({
    id: z.string().min(1).optional(),
    greenValue: z.number().int().optional(),
    greenMode: z.enum(PhaseMode).optional(),
    yellowValue: z.number().int().optional(),
    yellowMode: z.enum(PhaseMode).optional(),
    orangeValue: z.number().int().optional(),
    orangeMode: z.enum(PhaseMode).optional(),
    redValue: z.number().int().optional(),
    redMode: z.enum(PhaseMode).optional(),
  })
  .passthrough();
/**
 * One archived schedule era.
 *
 * `supersededByIndex` is the self-reference, and it is a POSITION in the
 * drug's own `scheduleRevisions` array rather than an id: a portable restore
 * mints fresh ids, so an id would address nothing. It stays a plain integer
 * with no range check here on purpose — the file is the wrong place to learn
 * that a position is out of range, because the array it indexes into is the
 * array being parsed. The restore does that check, against the rows it
 * actually wrote, and reports what it cannot resolve.
 *
 * `payload` is the snapshot of the superseded schedule rows, carried as
 * written. Unknown on purpose rather than typed: it is an era's frozen copy of
 * a shape that has changed several times, and a restore must not refuse a file
 * because a five-release-old snapshot spells a field the current form does not.
 */
export const medicationScheduleRevisionSchema = z
  .object({
    id: z.string().min(1).optional(),
    validFrom: isoDateTime,
    validUntil: isoDateTime,
    payload: z.unknown(),
    source: z.string().min(1).optional(),
    supersededByIndex: z.number().int().nullable().optional(),
    createdAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * What a medication was supposed to move.
 *
 * The lab arm is a biomarker NAME rather than an id, the way a lab result's
 * cross-reference is: the id is fresh on a portable restore, and `Biomarker`
 * is unique on `(userId, name)`. Both arms are nullable because the live
 * schema produces a row with neither — deleting a biomarker sets the column
 * NULL and leaves the override behind as an orphan the resolver reads as "no
 * override".
 */
export const medicationEfficacyTargetSchema = z
  .object({
    id: z.string().min(1).optional(),
    measurementType: z.enum(MeasurementType).nullable().optional(),
    biomarkerName: z.string().min(1).nullable().optional(),
    primary: z.boolean().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * A medication category the account named itself. Carried
 * with its decrypted label (the label is re-encrypted on restore under the
 * restoring instance's key) and restored BEFORE the medications, whose
 * `category` names it by `key`.
 */
export const customMedicationCategorySchema = z
  .object({
    key: z.string().regex(/^custom:[0-9a-f-]{36}$/),
    // The readable label: a portable file, and every disaster-recovery file
    // written before the label travelled as ciphertext.
    label: z.string().trim().min(1).max(40).nullable().optional(),
    // The label's ciphertext, as a disaster-recovery file carries it now.
    labelEncrypted: base64BytesSchema.optional(),
    sortOrder: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough()
  .refine((c) => c.labelEncrypted !== undefined || (c.label ?? "") !== "", {
    message: "a custom category needs its label or its ciphertext",
    path: ["label"],
  });
export const medicationSchema = z
  .object({
    id: z.string().min(1).optional(),
    // The source row's id in a portable file, which carries no `id`: the
    // relation links name the medication by it, and the restore re-points
    // them at the row it writes (`relation-links-backup.ts`).
    ref: z.string().min(1).optional(),
    name: z.string().min(1),
    dose: z.string(),
    treatmentClass: z.enum(MedicationCategory).optional(),
    dosesPerUnit: z.number().int().nullable().optional(),
    unitsPerDose: z
      .string()
      .min(1)
      .refine((v) => isSupportedUnitsPerDose(Number(v)), {
        message: UNITS_PER_DOSE_MESSAGE,
      })
      .optional(),
    active: z.boolean().optional(),
    notificationsEnabled: z.boolean().optional(),
    pausedAt: isoDateTime.nullable().optional(),
    snoozedUntil: isoDateTime.nullable().optional(),
    startsOn: isoDateTime.nullable().optional(),
    endsOn: isoDateTime.nullable().optional(),
    oneShot: z.boolean().optional(),
    asNeeded: z.boolean().optional(),
    // Absent in a backup written before the field existed;
    // the restore defaults it to tracking on, the behaviour those had.
    trackIntake: z.boolean().optional(),
    // Absent in a backup written before the option existed; the
    // restore defaults it off, the behaviour those had.
    autoMarkTaken: z.boolean().optional(),
    autoMarkTakenSince: isoDateTime.nullable().optional(),
    // The clinical category. Absent in older files. A string, not
    // the enum: a file from a newer server may name a category this one does
    // not know, and the restore reads that as OTHER rather than refusing the
    // whole file. Since v1.40 it may be `custom:<uuid>`, the key of an entry
    // in `customMedicationCategories`.
    category: z.string().max(64).optional(),
    // When the category was last set. Disaster-recovery files only; without
    // it the restored assignment is stamped with the restore, as before.
    categoryUpdatedAt: isoDateTime.nullable().optional(),
    deliveryForm: z.enum(MedicationDeliveryForm).optional(),
    trackInjectionSites: z.boolean().optional(),
    allowedInjectionSites: z.array(z.enum(InjectionSite)).optional(),
    liveActivityEnabled: z.boolean().optional(),
    criticalAlarmEnabled: z.boolean().optional(),
    atcCode: z.string().nullable().optional(),
    rxNormCode: z.string().nullable().optional(),
    lowStockNotifiedAt: isoDateTime.nullable().optional(),
    lowStockNotifiedThresholdDays: z.number().int().nullable().optional(),
    reorderLeadDays: z.number().int().nullable().optional(),
    externalSource: z.enum(IntakeSource).nullable().optional(),
    externalId: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    schedules: z.array(medicationScheduleSchema).default([]),
    // Defaulted so a file written before side effects rode the wire still
    // parses, and a drug with none writes [].
    sideEffects: z.array(medicationSideEffectSchema).default([]),
    // Defaulted for the same reason: a file written before pause eras rode the
    // wire still parses, and a drug that was never paused writes [].
    pauseEras: z.array(medicationPauseEraSchema).default([]),
    // Defaulted: a file written before compositions travelled, or a
    // drug without one, writes [].
    ingredients: z.array(medicationIngredientSchema).default([]),
    // Same default, same reason: an older file parses, a drug never titrated
    // writes [].
    doseChanges: z.array(medicationDoseChangeSchema).default([]),
    inventoryItems: z.array(medicationInventoryItemSchema).default([]),
    inventoryEvents: z.array(medicationInventoryEventSchema).default([]),
    phaseConfig: reminderPhaseConfigSchema.nullable().optional(),
    // Same default, same reason: an older file parses, and a drug whose
    // target the resolver derives rather than the person pinning it writes [].
    efficacyTargets: z.array(medicationEfficacyTargetSchema).default([]),
    // Same default again. A drug whose plan has never been replaced has no
    // archived era, and a file written before the eras travelled has no key.
    scheduleRevisions: z.array(medicationScheduleRevisionSchema).default([]),
    // NOT defaulted: absent means a file written before
    // courses existed, and the restore then derives the one course the
    // medication's own window describes, exactly as the migration did.
    courses: z.array(medicationCourseSchema).optional(),
  })
  .passthrough();
export const intakeEventSchema = z
  .object({
    id: z.string().min(1).optional(),
    medicationId: z.string().min(1).optional(),
    medication: z.string().min(1),
    scheduledFor: isoDateTime,
    takenAt: isoDateTime.nullable().optional(),
    skipped: z.boolean().optional(),
    autoMissed: z.boolean().optional(),
    // Absent in older files: every dose there was confirmed.
    autoRecorded: z.boolean().optional(),
    attributionSource: z.enum(IntakeAttributionSource).optional(),
    source: z.enum(IntakeSource).optional(),
    idempotencyKey: z.string().nullable().optional(),
    createdAt: isoDateTime.optional(),
    injectionSite: z.enum(InjectionSite).nullable().optional(),
    doseTaken: z.string().nullable().optional(),
    inventoryConsumption: z.unknown().nullable().optional(),
    externalId: z.string().nullable().optional(),
    updatedAt: isoDateTime.optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
  })
  .passthrough();
