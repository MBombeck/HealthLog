/**
 * The cycle slice of the backup payload schema.
 *
 * Part of the cycle backup domain, beside its export and restore.
 * Loaded only through `src/lib/validations/backup.ts`, which composes every
 * slice into `backupPayloadSchema` on first use (the schema is ~12 MB of
 * heap; see `backup-schema-lazy-guard.test.ts`).
 */
import { z } from "zod/v4";
import {
  CervicalMucus,
  CervixFirmness,
  CervixOpening,
  CervixPosition,
  ContraceptiveKind,
  CycleTrackingGoal,
  FlowLevel,
  HomeTestResult,
  MeasurementSource,
  OvulationTest,
  SecondarySymptom,
} from "@/generated/prisma/enums";
import { isoDateTime } from "@/lib/export/backup-schema-kit";
import {
  POSTPARTUM_WEEKS_MAX,
  POSTPARTUM_WEEKS_MIN,
} from "@/lib/cycle/pregnancy";

/** A `YYYY-MM-DD` calendar day. */
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── v1.15.0 cycle-tracking backup shapes ──────────────────────────── */

/**
 * One menstrual-cycle span. `startDate` is the natural per-user key
 * (matching the `(userId, startDate)` unique), so a restore upserts on it.
 * Predicted (forecast) rows are excluded from the backup — only observed
 * history round-trips.
 */
export const cycleSpanSchema = z
  .object({
    id: z.string().min(1).optional(),
    startDate: z.string().min(1),
    endDate: z.string().nullable().optional(),
    periodEndDate: z.string().nullable().optional(),
    lengthDays: z.number().int().nullable().optional(),
    ovulationDate: z.string().nullable().optional(),
    ovulationConfirmed: z.boolean().optional(),
    isPredicted: z.boolean().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    absorbedIntoId: z.string().min(1).nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * One cycle day-log. `notesEncrypted` is carried as the AES-256-GCM
 * ciphertext envelope verbatim — the backup never decrypts it, so the
 * owner's free-text note round-trips encrypted (and a wrong-surface leak is
 * impossible). `symptomKeys` carries the seeded catalogue keys so the
 * restore can re-link without exporting internal join ids, and
 * `symptomSeverities` carries how hard each of them hit.
 */
/**
 * The intensity recorded against one of a day's symptoms.
 *
 * A sparse annotation over `symptomKeys`, not a replacement for it: the keys
 * still say which symptoms the day had, this says how hard the ones that were
 * rated hit. Only rated links appear, so a missing entry means the person never
 * put a number on it. `severity` is left as a plain integer here on purpose —
 * the 1-4 range is checked when the row is written, so a file carrying a value
 * outside it loses that one intensity instead of failing to restore at all.
 */
export const cycleSymptomSeveritySchema = z
  .object({
    key: z.string().min(1),
    severity: z.number().int().nullable().optional(),
  })
  .passthrough();
/** The sensitive-category envelope's five fields, as a portable file carries them. */
export const cycleSensitiveFieldsSchema = z.object({
  sexualActivity: z.boolean().optional(),
  protectedSex: z.boolean().nullable().optional(),
  pregnancyTest: z.enum(HomeTestResult).nullable().optional(),
  progesteroneTest: z.enum(HomeTestResult).nullable().optional(),
  contraceptive: z.enum(ContraceptiveKind).nullable().optional(),
});
export const cycleDayLogSchema = z
  .object({
    id: z.string().min(1).optional(),
    date: z.string().min(1),
    cycleId: z.string().nullable().optional(),
    flow: z.enum(FlowLevel).nullable().optional(),
    intermenstrualBleeding: z.boolean().optional(),
    basalBodyTempC: z.number().nullable().optional(),
    temperatureExcluded: z.boolean().optional(),
    ovulationTest: z.enum(OvulationTest).nullable().optional(),
    cervicalMucus: z.enum(CervicalMucus).nullable().optional(),
    cervixPosition: z.enum(CervixPosition).nullable().optional(),
    cervixFirmness: z.enum(CervixFirmness).nullable().optional(),
    cervixOpening: z.enum(CervixOpening).nullable().optional(),
    sexualActivity: z.boolean().optional(),
    protectedSex: z.boolean().nullable().optional(),
    pregnancyTest: z.enum(HomeTestResult).nullable().optional(),
    progesteroneTest: z.enum(HomeTestResult).nullable().optional(),
    contraceptive: z.enum(ContraceptiveKind).nullable().optional(),
    // Free text travels like every other note: a disaster-recovery file
    // carries the ciphertext (`*Encrypted`), a portable file the readable
    // value (`note`, `sensitive`), which the restore seals under the
    // receiving host's key. A portable file written before v1.40 carries the
    // ciphertext too; the restore keeps only what this host can open.
    sensitiveEncrypted: z.string().nullable().optional(),
    notesEncrypted: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    // The five intent fields the sensitive-category envelope holds, or the
    // unreadable marker when the writing host could not open the envelope.
    sensitive: z
      .union([cycleSensitiveFieldsSchema, z.string()])
      .nullable()
      .optional(),
    source: z.enum(MeasurementSource).optional(),
    externalId: z.string().nullable().optional(),
    tz: z.string().nullable().optional(),
    syncVersion: z.number().int().optional(),
    deletedAt: isoDateTime.nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
    symptomKeys: z.array(z.string()).default([]),
    symptomSeverities: z.array(cycleSymptomSeveritySchema).default([]),
    symptomLinkCreatedAt: z
      .array(z.object({ key: z.string().min(1), createdAt: isoDateTime }))
      .optional(),
  })
  .passthrough();
/** Cycle-tracking preferences (one row per user). */
export const cycleProfileSchema = z
  .object({
    id: z.string().min(1).optional(),
    goal: z.enum(CycleTrackingGoal).optional(),
    cycleTrackingEnabled: z.boolean().nullable().optional(),
    typicalCycleLength: z.number().int().nullable().optional(),
    typicalPeriodLength: z.number().int().nullable().optional(),
    lutealPhaseLength: z.number().int().nullable().optional(),
    secondarySymptom: z.enum(SecondarySymptom).nullable().optional(),
    predictionEnabled: z.boolean().optional(),
    rawChartMode: z.boolean().optional(),
    discreetNotifications: z.boolean().optional(),
    sensitiveCategoryEncryption: z.boolean().optional(),
    reproductiveState: z.enum(["PREGNANT", "POSTPARTUM"]).nullable().optional(),
    pregnancyStartDate: dateKey.nullable().optional(),
    pregnancyDueDate: dateKey.nullable().optional(),
    deliveryDate: dateKey.nullable().optional(),
    postpartumWeeks: z
      .number()
      .int()
      .min(POSTPARTUM_WEEKS_MIN)
      .max(POSTPARTUM_WEEKS_MAX)
      .optional(),
    // The owner set or cleared the state at least once, so an import does
    // not set it behind them. Absent in files written before v1.49.0.
    pregnancyOwnerDecided: z.boolean().optional(),
    // A disaster-recovery file's sealed pregnancy state, verbatim. Absent in
    // a portable file and in files written before v1.49.0.
    pregnancyEncrypted: z.string().min(1).nullable().optional(),
    createdAt: isoDateTime.optional(),
    updatedAt: isoDateTime.optional(),
  })
  .passthrough();
/**
 * A symptom the account created, as opposed to the seeded catalogue.
 *
 * Carried because a day-log's symptom link resolves by key: without the
 * definition the key resolves to nothing on the restoring instance, and the
 * link is lost. The seeded rows are deliberately NOT carried — every instance
 * already has them, and shipping them would mean a restore could rewrite
 * another instance's reference data.
 */
export const customCycleSymptomSchema = z
  .object({
    id: z.string().min(1).optional(),
    key: z.string().min(1),
    labelKey: z.string().min(1),
    categoryId: z.string().min(1),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().default(0),
    isActive: z.boolean().default(true),
    // Same reasoning as the mood tag's: the user's own words live here.
    // Ciphertext on a disaster-recovery file, readable `label` on a portable
    // one (the day-log note's split).
    labelEncrypted: z.string().nullable().optional(),
    label: z.string().nullable().optional(),
  })
  .passthrough();
