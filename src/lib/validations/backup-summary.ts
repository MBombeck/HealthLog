/**
 * What a backup is, without the schema that checks one.
 *
 * `backupPayloadSchema` (`backup.ts`) is the largest Zod tree in the server:
 * built at import, it holds about 12 MB of heap. Everything here is what the
 * backup paths need besides that check: the schema version, whether a file's
 * version is one this server reads, and the per-section counts of a payload
 * that has already been parsed. Importing this module never builds the
 * schema, so a module on the boot path (the restore job, the stored-backup
 * readers, the export writer) can import it freely and load `backup.ts` with
 * a dynamic `import()` at the moment a file is actually validated.
 */
import type { BackupPayload } from "@/lib/validations/backup";

export const BACKUP_SCHEMA_VERSION = "2" as const;
export const LEGACY_BACKUP_SCHEMA_VERSION = "1" as const;

/**
 * Numeric counts of each backed-up record kind. Returned in the
 * upload + restore API responses so the admin sees what they
 * uploaded/restored without having to download the file again.
 */
export interface BackupSummary {
  schemaVersion: string;
  userId: string;
  exportedAt: string;
  measurements: number;
  medications: number;
  intakeEvents: number;
  /** Side effects recorded against a drug, across every medication. */
  medicationSideEffects: number;
  /** Pinned efficacy targets, across every medication. */
  medicationEfficacyTargets: number;
  /** Archived schedule eras, across every medication. */
  medicationScheduleRevisions: number;
  moodEntries: number;
  /** v1.15.0 — observed cycle spans in the backup. */
  cycles: number;
  /** v1.15.0 — cycle day-logs in the backup. */
  cycleDayLogs: number;
  /** Lab results in the backup. */
  labResults: number;
  nutrientDays: number;
  /** User-scoped biomarker catalog entries in the backup. */
  biomarkers: number;
  /** Illness episodes, including flares/exacerbations. */
  illnessEpisodes: number;
  /** Illness day-logs across every episode. */
  illnessDayLogs: number;
  /** Allergy/intolerance records in the backup. */
  allergies: number;
  /** Family-history entries in the backup. */
  familyHistory: number;
  /** Workout summary records in the backup. */
  workouts: number;
  /** Document records (ciphertext included in canonical DR payloads). */
  documents: number;
  /** Which documents were filed against which condition. */
  documentConditionLinks: number;
  /** Facts staged out of a document, with their review decision. */
  extractedFacts: number;
  /** 1 when the account's durable self-context rides the file, 0 otherwise. */
  healthProfile: number;
  /** Effective-dated structured health-profile revisions. */
  healthProfileFactRevisions: number;
  /** Metrics the account defined itself. */
  customMetrics: number;
  /** Readings across every user-defined metric. */
  customMetricEntries: number;
  /** Persisted accepted correlation identities and dismissal decisions. */
  correlationPatterns: number;
  /** Stored day curves for the cumulative metrics, across every metric. */
  intradayProfiles: number;
  /** Local days whose health score was written down as it was shown. */
  healthScoreRecords: number;
  /** 1 when the record's setup answers ride the file, 0 otherwise. */
  onboardingRecords: number;
  /** v1.37.19 (A6-8) — the visit address book. */
  practitioners: number;
  /** v1.37.19 (A6-8) — doctor visits, planned and past. */
  encounters: number;
  /** v1.37.19 (A6-8) — the three encounter link tables, summed. */
  encounterLinks: number;
  /** v1.37.19 (A6-8) — immunization log entries. */
  vaccinations: number;
  /** v1.37.19 (A6-8) — vaccination↔document links. */
  vaccinationLinks: number;
  /** v1.42 (#1005) — the person's own vaccine definitions. */
  customVaccines: number;
  /** v1.37.20 (#223 / iOS #68) — Vorsorge reminder cadences. */
  measurementReminders: number;
  /** v1.37.20 (#223 / iOS #68) — completion-ledger rows across every reminder. */
  measurementReminderEvents: number;
  /** Coach conversation threads. */
  coachConversations: number;
  /** Coach turns across every thread. */
  coachMessages: number;
  /** Durable facts, agreed plans and things to bring back up. */
  coachFacts: number;
  coachPlans: number;
  coachReminders: number;
  /** Completed screener administrations. Disaster-recovery payloads only. */
  mentalHealthAssessments: number;
  /** Consent records. Disaster-recovery payloads only. */
  consentReceipts: number;
  /** Personal bests across every metric and sport slot. */
  personalRecords: number;
  /** Badges the account has unlocked, each with the day it was earned. */
  userAchievements: number;
  /** Local days with an environmental reading. */
  environmentContexts: number;
  /** Declared stretches spent away from home. */
  environmentTravelLocations: number;
  /** ECG strips, with their rhythm verdict and their trace. */
  ecgRecordings: number;
}

export function summarizeBackup(payload: BackupPayload): BackupSummary {
  return {
    schemaVersion: payload.schemaVersion,
    userId: payload.userId,
    exportedAt: payload.exportedAt,
    measurements: payload.measurements.length,
    medications: payload.medications.length,
    intakeEvents: payload.intakeEvents.length,
    medicationSideEffects: payload.medications.reduce(
      (sum, medication) => sum + medication.sideEffects.length,
      0,
    ),
    medicationEfficacyTargets: payload.medications.reduce(
      (sum, medication) => sum + medication.efficacyTargets.length,
      0,
    ),
    medicationScheduleRevisions: payload.medications.reduce(
      (sum, medication) => sum + medication.scheduleRevisions.length,
      0,
    ),
    moodEntries: payload.moodEntries.length,
    cycles: payload.cycles.length,
    cycleDayLogs: payload.cycleDayLogs.length,
    nutrientDays: payload.nutrientDays.length,
    labResults: payload.labResults.length,
    biomarkers: payload.biomarkers.length,
    illnessEpisodes: payload.illnessEpisodes.length,
    illnessDayLogs: payload.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: payload.allergies.length,
    familyHistory: payload.familyHistory.length,
    workouts: payload.workouts.length,
    documents: payload.documents.length,
    // Counted from the release that carries them, so the admin's "what did I
    // just restore" answer never under-counts a filed vault the way it once
    // did for visits.
    documentConditionLinks: payload.documentConditionLinks.length,
    extractedFacts: payload.extractedFacts.length,
    healthProfile: payload.healthProfile ? 1 : 0,
    healthProfileFactRevisions: payload.healthProfileFacts.length,
    customMetrics: payload.customMetrics.length,
    customMetricEntries: payload.customMetrics.reduce(
      (sum, metric) => sum + metric.entries.length,
      0,
    ),
    correlationPatterns: payload.correlationPatterns.length,
    intradayProfiles: payload.intradayProfiles.length,
    healthScoreRecords: payload.healthScoreRecords.length,
    onboardingRecords: payload.onboardingRecord ? 1 : 0,
    // v1.37.19 (A6-8) — the sections restored since 08-01 were written and
    // restored but absent from this report, so the admin's "what did I just
    // restore" answer silently under-counted a file that carried visits or
    // an Impfpass.
    practitioners: payload.practitioners.length,
    encounters: payload.encounters.length,
    encounterLinks:
      payload.encounterDocumentLinks.length +
      payload.encounterLabLinks.length +
      payload.encounterConditionLinks.length,
    vaccinations: payload.vaccinations.length,
    vaccinationLinks: payload.vaccinationDocumentLinks.length,
    customVaccines: payload.customVaccines.length,
    // v1.37.20 (#223 / iOS #68) — counted from the release that carries them,
    // so the admin's "what did I just restore" answer never under-counts a
    // file with reminders the way it once did for visits.
    measurementReminders: payload.measurementReminders.length,
    measurementReminderEvents: payload.measurementReminderEvents.length,
    coachConversations: payload.coachConversations.length,
    coachMessages: payload.coachConversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    ),
    coachFacts: payload.coachFacts.length,
    coachPlans: payload.coachPlans.length,
    coachReminders: payload.coachReminders.length,
    mentalHealthAssessments: payload.mentalHealthAssessments.length,
    consentReceipts: payload.consentReceipts.length,
    // Counted from the release that carries them, so the admin's "what did I
    // just restore" answer never under-counts a file with bests, badges or an
    // environmental history the way it once did for visits.
    personalRecords: payload.personalRecords.length,
    userAchievements: payload.userAchievements.length,
    environmentContexts: payload.environmentContexts.length,
    environmentTravelLocations: payload.environmentTravelLocations.length,
    ecgRecordings: payload.ecgRecordings.length,
  };
}

/**
 * The schemaVersion the system understands today. Used by the upload
 * route to reject inbound files written by a *future* HealthLog instance
 * — restoring them under the current code might silently drop data the
 * new shape carried.
 */
export function isCompatibleSchemaVersion(version: string): boolean {
  return (
    version === LEGACY_BACKUP_SCHEMA_VERSION ||
    version === BACKUP_SCHEMA_VERSION
  );
}
