/**
 * What every step of a restore is handed, and what the steps hand each other.
 *
 * A restore runs as one transaction made of steps, one or a few per domain
 * (`backup-domains.ts` lists them in the order they run). Each step reads its
 * own part of the file and writes its own tables. Where one domain points
 * into another (an intake event at its medication, a lab result at its
 * marker, a personal best at the reading it was found in), the step that
 * writes the target records what it wrote in `links`, and the step that
 * points reads it there. Nothing else passes between steps.
 */
import { Buffer } from "node:buffer";

import type { Prisma } from "@/generated/prisma/client";
import type {
  BackupMeasurement,
  BackupPayload,
} from "@/lib/validations/backup";
import type { StreamedBackup } from "@/lib/export/streamed-backup";
import type { RestoreSkipLog } from "@/lib/export/restore-skips";
import type { AccountSettingsRestoreResult } from "@/lib/export/account-settings-restore";

/**
 * The steps after the measurements that report as sections, in order. The
 * restore names each one as it starts it (`reportSection`), so the count the
 * status shows is the count the transaction walks.
 */
export const RESTORE_SECTION_STEPS = [
  "medications",
  "mood",
  "cycles",
  "profile",
  "labs",
  "illness",
  "allergies",
  "familyHistory",
  "documents",
  "reminders",
  "visits",
  "vaccinations",
  "coach",
  "sensitive",
  "awards",
  "ecg",
  "environment",
] as const;

export type RestoreSectionStep = (typeof RESTORE_SECTION_STEPS)[number];

/**
 * How many rows of each kind the restore removed from the account before
 * writing the file's, in the order the report lists them.
 */
export const RESTORE_CLEARED_KEYS = [
  "measurements",
  "medications",
  "intakeEvents",
  "moodEntries",
  "notificationChannels",
  "pushSubscriptions",
  "telegramScheduledDeletions",
  "cycles",
  "cycleDayLogs",
  "cycleProfile",
  "labResults",
  "biomarkers",
  "nutrientDays",
  "illnessEpisodes",
  "allergies",
  "familyHistory",
  "workouts",
  "documents",
  "documentConditionLinks",
  "extractedFacts",
  "documentImportKeys",
  "healthProfile",
  "healthProfileFactRevisions",
  "customMetrics",
  "correlationPatterns",
  "intradayProfiles",
  "healthScoreRecords",
  "onboardingRecords",
  "practitioners",
  "encounters",
  "encounterLinks",
  "vaccinations",
  "vaccinationLinks",
  "relationLinks",
  "customVaccines",
  "measurementReminders",
  "measurementReminderEvents",
  "coachConversations",
  "coachMessages",
  "coachConversationDocuments",
  "coachFacts",
  "coachPlans",
  "coachReminders",
  "mentalHealthAssessments",
  "consentReceipts",
  "personalRecords",
  "userAchievements",
  "environmentContexts",
  "environmentTravelLocations",
  "dawarichDays",
  "ecgRecordings",
  "symptomDefinitions",
  "lifeEvents",
] as const;

export type RestoreClearedKey = (typeof RESTORE_CLEARED_KEYS)[number];
export type RestoreCleared = Record<RestoreClearedKey, number>;

/** A drug's efficacy target, held until the markers it names exist. */
export interface PendingEfficacyTarget {
  medicationId: string;
  target: BackupPayload["medications"][number]["efficacyTargets"][number];
}

/**
 * What one domain wrote that a later one points at. Each field is filled by
 * the step named beside it and read only after that step has run.
 */
export interface RestoreLinks {
  /**
   * Measurement ids a personal best or an ECG strip references, among the
   * ones the measurement step actually wrote. Only those are collected.
   */
  writtenReferencedMeasurementIds: Set<string>;
  /** Medications: every id the step wrote. */
  restoredMedicationIds: Set<string>;
  /**
   * Medications: the id each one had in the source account (its id, or a
   * portable file's `ref`) to the id it got here.
   */
  medicationIdBySourceId: Map<string, string>;
  /** Medications: targets written once the markers exist (labs step). */
  pendingEfficacyTargets: PendingEfficacyTarget[];
  /** Labs: marker name to the id it got. */
  biomarkerByName: Map<string, string>;
  /** Labs: every marker id the step wrote. */
  restoredBiomarkerIds: Set<string>;
  /** Labs: every lab result id the step wrote. */
  restoredLabResultIds: Set<string>;
  /** Labs: source id (or `ref`) of each lab result to the id it got. */
  labResultIdBySourceId: Map<string, string>;
  /** Illness: the episode ids the file carries, all of which are written. */
  episodeIds: Set<string>;
}

/**
 * What the file's first read noted about its readings as a whole, for the
 * measurement step (`createMeasurementRestorePrepass` in
 * `measurements-restore.ts` builds it). Declared here so a module that only
 * names the restore context does not import the restore itself.
 */
export interface MeasurementRestorePrepass {
  /** Called for every reading as the first read checks it. */
  note(row: BackupMeasurement): void;
  /** The live `stats:` ids of the folded types, keyed by source and type. */
  readonly liveFoldStatsIds: ReadonlySet<string>;
  /** A row the migration's rule leaves out under either type. */
  isShadowedLegacyRmssd(row: BackupMeasurement): boolean;
}

/** What the steps report back to the orchestrator once they are done. */
export interface RestoreOutputs {
  /** Measurement tombstones left out (expired or folded). */
  expiredTombstonesSkipped: number;
  /** Whether the fold repair marker was taken away and must be queued. */
  foldRepairReset: boolean;
  accountSettings: AccountSettingsRestoreResult;
}

export interface RestoreContext {
  readonly tx: Prisma.TransactionClient;
  readonly ownerId: string;
  readonly payload: BackupPayload;
  readonly streamed: StreamedBackup;
  /** Declared inside the transaction, so a rollback takes the report with it. */
  readonly skips: RestoreSkipLog;
  readonly restoreInstanceSettings: boolean;
  /** What the file's first read noted about its readings. */
  readonly measurementPrepass: MeasurementRestorePrepass;
  readonly links: RestoreLinks;
  readonly outputs: RestoreOutputs;
  readonly cleared: Partial<RestoreCleared>;
  /** Name the section that starts now, for the status. */
  reportSection(step: RestoreSectionStep): void;
  /** The measurement pass: one more batch of the file's readings handled. */
  reportMeasurements(written: number): void;
}

export function emptyRestoreLinks(): RestoreLinks {
  return {
    writtenReferencedMeasurementIds: new Set(),
    restoredMedicationIds: new Set(),
    medicationIdBySourceId: new Map(),
    pendingEfficacyTargets: [],
    biomarkerByName: new Map(),
    restoredBiomarkerIds: new Set(),
    restoredLabResultIds: new Set(),
    labResultIdBySourceId: new Map(),
    episodeIds: new Set(),
  };
}

/** The report's cleared counts, in report order, from what the steps set. */
export function orderedCleared(
  cleared: Partial<RestoreCleared>,
): RestoreCleared {
  return Object.fromEntries(
    RESTORE_CLEARED_KEYS.map((key) => [key, cleared[key]]),
  ) as RestoreCleared;
}

/** Base64 of stored ciphertext back to the bytes a `Bytes` column takes. */
export function decodeEncryptedBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}
