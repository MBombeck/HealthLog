/**
 * Zod schemas + helpers for the per-user `DataBackup` JSON payload.
 *
 * Single source of truth shared by:
 *   - the pg-boss `data-backup` worker that writes a backup,
 *   - `GET /api/admin/backups/[id]/download` that streams it back as JSON,
 *   - `POST /api/admin/backups/upload` that ingests an admin-supplied file,
 *   - `POST /api/admin/backups/[id]/restore` that re-creates DB rows from it.
 *
 * The schema is intentionally permissive about *extra* fields (`.passthrough`)
 * so older snapshots written before a column was added still parse and so
 * future minor additions don't break old admins. Required fields are
 * deliberately tight — any drift surfaces as a validation error rather than
 * a silent data-loss restore.
 *
 * `schemaVersion` is the migration handle. Bump when the on-disk shape
 * changes incompatibly. The current writer (worker) historically did NOT
 * include this field; `parseBackupPayload()` defaults it to "1" so legacy
 * blobs continue to round-trip and the upload validator can still produce
 * a useful summary for them.
 *
 * Each section's element schema lives with its domain, in
 * `<domain>-backup-schema.ts` beside the domain's export and restore
 * (`src/lib/export/`, and `src/lib/cycle/backup-schema.ts` for the cycle).
 * This file composes them into the payload, in the file's key order, with
 * each section's default and the checks that span sections. Every slice is
 * loaded through here and nowhere else, so the whole schema is still built
 * only when a backup is first validated.
 */
import { z } from "zod/v4";
import {
  customCycleSymptomSchema,
  cycleDayLogSchema,
  cycleProfileSchema,
  cycleSpanSchema,
} from "@/lib/cycle/backup-schema";
import { accountSettingsBackupSchema } from "@/lib/export/account-settings-backup-schema";
import { allergyBackupSchema } from "@/lib/export/allergies-backup-schema";
import { appSettingsBackupSchema } from "@/lib/export/app-settings-backup-schema";
import {
  personalRecordBackupSchema,
  userAchievementBackupSchema,
} from "@/lib/export/awards-backup-schema";
import { isoDateTime } from "@/lib/export/backup-schema-kit";
import {
  coachConversationBackupSchema,
  coachFactBackupSchema,
  coachPlanBackupSchema,
  coachReminderBackupSchema,
} from "@/lib/export/coach-backup-schema";
import {
  documentConditionLinkBackupSchema,
  extractedFactBackupSchema,
  documentImportKeyBackupSchema,
} from "@/lib/export/document-filing-backup-schema";
import { documentBackupSchema } from "@/lib/export/documents-backup-schema";
import { ecgRecordingBackupSchema } from "@/lib/export/ecg-backup-schema";
import {
  dawarichDayBackupSchema,
  environmentContextBackupSchema,
  environmentTravelLocationBackupSchema,
} from "@/lib/export/environment-backup-schema";
import { familyHistoryBackupSchema } from "@/lib/export/family-history-backup-schema";
import { healthScoreRecordBackupSchema } from "@/lib/export/health-score-backup-schema";
import { illnessEpisodeBackupSchema } from "@/lib/export/illness-backup-schema";
import { intradayProfileBackupSchema } from "@/lib/export/intraday-profile-backup-schema";
import {
  biomarkerBackupSchema,
  biomarkerMergeBackupSchema,
  labResultBackupSchema,
} from "@/lib/export/labs-backup-schema";
import { lifeEventBackupSchema } from "@/lib/export/life-events-backup-schema";
import { measurementSchema } from "@/lib/export/measurements-backup-schema";
import {
  customMedicationCategorySchema,
  intakeEventSchema,
  medicationSchema,
} from "@/lib/export/medications-backup-schema";
import {
  customMoodTagCategorySchema,
  customMoodTagSchema,
  hiddenMoodTagSchema,
  moodEntrySchema,
} from "@/lib/export/mood-backup-schema";
import { nutrientDaySchema } from "@/lib/export/nutrients-backup-schema";
import { onboardingRecordBackupSchema } from "@/lib/export/onboarding-backup-schema";
import {
  correlationPatternBackupSchema,
  customMetricBackupSchema,
  healthProfileBackupSchema,
  healthProfileFactBackupSchema,
} from "@/lib/export/profile-backup-schema";
import { relationLinkBackupSchema } from "@/lib/export/relation-links-backup-schema";
import {
  measurementReminderBackupSchema,
  measurementReminderEventBackupSchema,
} from "@/lib/export/reminders-backup-schema";
import {
  consentReceiptBackupSchema,
  mentalHealthAssessmentBackupSchema,
} from "@/lib/export/sensitive-backup-schema";
import { symptomDefinitionBackupSchema } from "@/lib/export/symptoms-backup-schema";
import {
  customVaccineBackupSchema,
  vaccinationBackupSchema,
  vaccinationLinkBackupSchema,
} from "@/lib/export/vaccinations-backup-schema";
import {
  encounterBackupSchema,
  encounterLinkBackupSchema,
  practitionerBackupSchema,
} from "@/lib/export/visits-backup-schema";
import { workoutBackupSchema } from "@/lib/export/workouts-backup-schema";
import {
  BACKUP_SCHEMA_VERSION,
  LEGACY_BACKUP_SCHEMA_VERSION,
} from "@/lib/validations/backup-summary";

const backupManifestSchema = z
  .object({
    documents: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
    workouts: z
      .object({ included: z.string().min(1), note: z.string().min(1) })
      .passthrough(),
  })
  .passthrough();

/**
 * Wire shape — exactly what the pg-boss worker writes today, plus a
 * `schemaVersion` field that newer writers stamp explicitly. Older blobs
 * without the field default to v1 in `parseBackupPayload`.
 */
export const backupPayloadSchema = z
  .object({
    schemaVersion: z.string().min(1).default(LEGACY_BACKUP_SCHEMA_VERSION),
    exportedAt: isoDateTime,
    userId: z.string().min(1),
    appSettings: appSettingsBackupSchema.nullable().default(null),
    // The account's own settings. Null in every file written before the
    // section existed, and a null restores by leaving the account row alone.
    accountSettings: accountSettingsBackupSchema.nullable().default(null),
    measurements: z.array(measurementSchema).default([]),
    medications: z.array(medicationSchema).default([]),
    // v1.40 — absent in older files, which carry no custom category either.
    customMedicationCategories: z
      .array(customMedicationCategorySchema)
      .default([]),
    intakeEvents: z.array(intakeEventSchema).default([]),
    moodEntries: z.array(moodEntrySchema).default([]),
    // v1.15.0 — cycle-tracking tables. Default to empty arrays / null so a
    // pre-v1.15 backup (no cycle keys) still round-trips unchanged.
    cycleProfile: cycleProfileSchema.nullable().default(null),
    cycles: z.array(cycleSpanSchema).default([]),
    cycleDayLogs: z.array(cycleDayLogSchema).default([]),
    // Defaulted rather than required: files written before this field existed
    // are still valid, and an account with no custom symptoms writes [].
    customSymptoms: z.array(customCycleSymptomSchema).default([]),
    customMoodTagCategories: z.array(customMoodTagCategorySchema).default([]),
    hiddenMoodTags: z.array(hiddenMoodTagSchema).default([]),
    customMoodTags: z.array(customMoodTagSchema).default([]),
    // Structured records default to empty arrays so older backups remain
    // parseable. Canonical DR writers add stable ids and encrypted document
    // fields; portable exports retain the metadata-only subset.
    labResults: z.array(labResultBackupSchema).default([]),
    biomarkers: z.array(biomarkerBackupSchema).default([]),
    // Defaulted: a file written before v1.43 carries no key.
    biomarkerMerges: z.array(biomarkerMergeBackupSchema).default([]),
    illnessEpisodes: z.array(illnessEpisodeBackupSchema).default([]),
    // Defaulted: a file written before v1.40 carries no key.
    symptomDefinitions: z.array(symptomDefinitionBackupSchema).default([]),
    // Defaulted: a file written before v1.42 carries no key.
    lifeEvents: z.array(lifeEventBackupSchema).default([]),
    allergies: z.array(allergyBackupSchema).default([]),
    familyHistory: z.array(familyHistoryBackupSchema).default([]),
    workouts: z.array(workoutBackupSchema).default([]),
    documents: z.array(documentBackupSchema).default([]),
    // What a document was filed against, and what was read out of it. Defaulted
    // for the same reason as the sections below: a file written before the
    // vault filing travelled carries no key, and an unsorted vault writes [].
    documentConditionLinks: z
      .array(documentConditionLinkBackupSchema)
      .default([]),
    extractedFacts: z.array(extractedFactBackupSchema).default([]),
    // The source keys of imported documents the person deleted. Defaulted:
    // a file written before the import ledger travelled carries no key.
    documentImportKeys: z.array(documentImportKeyBackupSchema).default([]),
    nutrientDays: z.array(nutrientDaySchema).default([]),
    // Durable self-context and user-defined series. Defaulted so files written
    // before either rode the wire still parse; an account with neither writes
    // `null` / `[]`.
    healthProfile: healthProfileBackupSchema.nullable().default(null),
    healthProfileFacts: z.array(healthProfileFactBackupSchema).default([]),
    customMetrics: z.array(customMetricBackupSchema).default([]),
    correlationPatterns: z.array(correlationPatternBackupSchema).default([]),
    // The hourly shape of a cumulative day. Defaulted for the same reason as
    // the pair above: a file written before the table existed carries no key.
    intradayProfiles: z.array(intradayProfileBackupSchema).default([]),
    // The score as it was shown, day by day. Defaulted for the same reason as
    // the sections above: a file written before the table existed carries no
    // key, and an account whose score never resolved writes [].
    healthScoreRecords: z.array(healthScoreRecordBackupSchema).default([]),
    // The needs-based setup answers. Defaulted to null for the same reason as
    // the sections above: a file written before the table existed carries no
    // key, and a record that never entered the flow has no row.
    onboardingRecord: onboardingRecordBackupSchema.nullable().default(null),
    // Visits, the address book behind them, and the three link tables.
    // Defaulted for the same reason as the sections above: a file written
    // before the tables existed carries no key, and an account that has never
    // filed a visit writes [].
    practitioners: z.array(practitionerBackupSchema).default([]),
    encounters: z.array(encounterBackupSchema).default([]),
    encounterDocumentLinks: z.array(encounterLinkBackupSchema).default([]),
    encounterLabLinks: z.array(encounterLinkBackupSchema).default([]),
    encounterConditionLinks: z.array(encounterLinkBackupSchema).default([]),
    // The immunization log and the pages it was transcribed from. Defaulted
    // for the same reason as the sections above: a file written before the
    // tables existed carries no key, and an account with an empty Impfpass
    // writes [].
    // v1.42 (#1005) — defaulted: a file written before definitions
    // travelled carries no key, and its doses name none.
    customVaccines: z.array(customVaccineBackupSchema).default([]),
    vaccinations: z.array(vaccinationBackupSchema).default([]),
    vaccinationDocumentLinks: z.array(vaccinationLinkBackupSchema).default([]),
    // v1.43 — the five relation links that close the relation matrix.
    // Defaulted: a file written before v1.43 carries no key.
    labResultDocumentLinks: z
      .array(relationLinkBackupSchema("labResultId", "documentId"))
      .default([]),
    encounterMedicationLinks: z
      .array(relationLinkBackupSchema("encounterId", "medicationId"))
      .default([]),
    encounterVaccinationLinks: z
      .array(relationLinkBackupSchema("encounterId", "vaccinationId"))
      .default([]),
    medicationDocumentLinks: z
      .array(relationLinkBackupSchema("medicationId", "documentId"))
      .default([]),
    medicationConditionLinks: z
      .array(relationLinkBackupSchema("medicationId", "episodeId"))
      .default([]),
    // The Vorsorge reminders and their completion ledger (v1.37.20, #223 /
    // iOS #68). Defaulted for the same reason as the sections above: a file
    // written before the reminders travelled carries no key, and an account
    // with none writes [].
    coachConversations: z.array(coachConversationBackupSchema).default([]),
    mentalHealthAssessments: z
      .array(mentalHealthAssessmentBackupSchema)
      .default([]),
    consentReceipts: z.array(consentReceiptBackupSchema).default([]),
    coachFacts: z.array(coachFactBackupSchema).default([]),
    coachPlans: z.array(coachPlanBackupSchema).default([]),
    coachReminders: z.array(coachReminderBackupSchema).default([]),
    measurementReminders: z.array(measurementReminderBackupSchema).default([]),
    measurementReminderEvents: z
      .array(measurementReminderEventBackupSchema)
      .default([]),
    // The bests and the badges. Defaulted for the same reason as the sections
    // above: a file written before they travelled carries no key, and an
    // account that has earned neither writes [].
    personalRecords: z.array(personalRecordBackupSchema).default([]),
    userAchievements: z.array(userAchievementBackupSchema).default([]),
    // The per-day readings and the location periods that explain them. Two
    // keys rather than one because they are two tables, but they are written
    // and restored as a pair: readings whose periods are missing get rewritten
    // to the home location by the next refresh.
    environmentContexts: z.array(environmentContextBackupSchema).default([]),
    environmentTravelLocations: z
      .array(environmentTravelLocationBackupSchema)
      .default([]),
    // v1.43 — the Dawarich movement days, restored with the environment
    // section. A file written before them carries no key.
    dawarichDays: z.array(dawarichDayBackupSchema).default([]),
    // The ECG strips. Defaulted for the same reason as the sections above: a
    // file written before the recordings travelled carries no key, and an
    // account whose watch has never taken one writes [].
    ecgRecordings: z.array(ecgRecordingBackupSchema).default([]),
    manifest: backupManifestSchema.nullable().default(null),
    // v1.37.19 — field paths a PORTABLE export could not decrypt
    // (fail-soft nulls). Disclosed in the file so a nulled field is
    // distinguishable from one never written. Empty/absent on DR payloads.
    decryptFailures: z.array(z.string()).default([]),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    // A marker without a unit is a qualitative one. A numeric reading filed
    // under it would restore as a number with no unit, so the file is refused
    // naming the marker rather than restored into that.
    const numericByMarker = new Set<string>();
    for (const reading of payload.labResults) {
      if (reading.value === null || reading.value === undefined) continue;
      if (reading.biomarkerId) numericByMarker.add(`id:${reading.biomarkerId}`);
      if (reading.biomarkerName) {
        numericByMarker.add(`name:${reading.biomarkerName}`);
      }
    }
    payload.biomarkers.forEach((marker, index) => {
      if (marker.unit.length > 0) return;
      if (
        (marker.id && numericByMarker.has(`id:${marker.id}`)) ||
        numericByMarker.has(`name:${marker.name}`)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["biomarkers", index, "unit"],
          message: `Biomarker "${marker.name}" has numeric readings and needs its unit`,
        });
      }
    });
    if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) return;
    payload.measurements.forEach((measurement, index) => {
      if (!measurement.id) {
        ctx.addIssue({
          code: "custom",
          path: ["measurements", index, "id"],
          message: "Canonical v2 measurements require a stable id",
        });
      }
    });
  });

export type BackupPayload = z.infer<typeof backupPayloadSchema>;

/**
 * One element of `measurements`, validated on its own. The streamed readers
 * (`src/lib/export/streamed-backup.ts`) check a large file's measurements
 * one at a time with this, and the rest of the file with
 * `backupPayloadSchema` over a document whose measurements are empty, which
 * together is the same check `backupPayloadSchema` makes of the whole file.
 */
export const backupMeasurementSchema = measurementSchema;
export type BackupMeasurement = z.infer<typeof measurementSchema>;

/**
 * Parse a JSON blob (string or already-parsed object) against
 * `backupPayloadSchema`, returning a typed payload. Throws ZodError on
 * mismatch — the admin route catches it and turns it into a 422 with a
 * field-level error list.
 *
 * Accepts both forms because:
 *   - the upload route hands us the parsed object after `await req.text()`
 *   - the restore route reads `DataBackup.data` (decrypted) which is
 *     always a JSON string straight from the worker.
 */
export function parseBackupPayload(input: string | unknown): BackupPayload {
  const raw = typeof input === "string" ? JSON.parse(input) : input;
  return backupPayloadSchema.parse(raw);
}
