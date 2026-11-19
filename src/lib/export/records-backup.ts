/**
 * The structured-records section: labs, illness history, allergies, family
 * history, workout summaries and the document vault, with the manifest that
 * discloses what each of them leaves out.
 *
 * Each record kind is a domain of its own, with its export and its restore in
 * one module (`labs-backup.ts`, `illness-backup.ts`, `allergies-backup.ts`,
 * `family-history-backup.ts`, `workouts-backup.ts`, `documents-backup.ts`).
 * This file lays their slices out in the order the file has always had.
 *
 * Portable exports keep the historical v1.28 metadata-only document shape.
 * The weekly disaster-recovery writer opts into the canonical mode, which
 * carries the encrypted document bytes and their persistence metadata
 * verbatim. The DR path never decrypts document content or summaries.
 *
 * Every read is scoped to the owner. Soft-deleted rows are excluded so a
 * restore cannot resurrect tombstones. Other encrypted free-text fields are
 * carried as plaintext and re-encrypted by the restore importer; one this
 * instance cannot decrypt is carried as a visible marker rather than as
 * nothing.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { FamilyHistoryEntryDTO } from "@/lib/records/dto";
import {
  buildAllergiesBackupSlice,
  type CanonicalAllergy,
} from "@/lib/export/allergies-backup";
import {
  buildDocumentsBackupSlice,
  type DocumentBackupEntry,
} from "@/lib/export/documents-backup";
import { buildFamilyHistoryBackupSlice } from "@/lib/export/family-history-backup";
import {
  buildIllnessBackupSlice,
  type CanonicalIllnessEpisode,
} from "@/lib/export/illness-backup";
import {
  buildLabsBackupSlice,
  type BiomarkerBackupEntry,
  type BiomarkerMergeBackupEntry,
  type LabResultBackupEntry,
  type LabResultImportKeyBackupEntry,
} from "@/lib/export/labs-backup";
import {
  buildWorkoutsBackupSlice,
  type AppleHealthTombstoneBackupEntry,
  type WorkoutBackupEntry,
} from "@/lib/export/workouts-backup";

/** Disclosed in the payload manifest AND mirrored in the export UI copy. */
export const DOCUMENTS_MANIFEST_NOTE =
  "Document metadata (title, filename, type, dates, and the AI-generated " +
  "summary if one was generated) is included. The original uploaded files " +
  "are NOT included in this export — download them individually from " +
  "Settings → Documents, or via the document API.";

/** Disclosed in the payload manifest AND mirrored in the export UI copy. */
export const WORKOUTS_MANIFEST_NOTE =
  "Workout summary records (duration, distance, heart rate, calories, " +
  "steps) are included. GPS routes and per-sample heart-rate/pace time " +
  "series are not included in this export.";

export interface RecordsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
  /**
   * Leave the documents unread (`documents: []`): the streaming writer pulls
   * them through `iterateBackupDocuments` itself, one at a time.
   */
  deferDocuments?: boolean;
}

export interface RecordsBackupSection {
  labResults: LabResultBackupEntry[];
  biomarkers: BiomarkerBackupEntry[];
  biomarkerMerges: BiomarkerMergeBackupEntry[];
  labResultImportKeys: LabResultImportKeyBackupEntry[];
  illnessEpisodes: CanonicalIllnessEpisode[];
  allergies: CanonicalAllergy[];
  familyHistory: FamilyHistoryEntryDTO[];
  workouts: WorkoutBackupEntry[];
  /** Disaster-recovery files only: the Apple Health deletion ledger. */
  appleHealthTombstones?: AppleHealthTombstoneBackupEntry[];
  documents: DocumentBackupEntry[];
  manifest: {
    documents: {
      included: "metadata-only" | "encrypted-content";
      note: string;
    };
    workouts: { included: "summary-only"; note: string };
  };
}

export interface RecordsBackupCounts {
  labResults: number;
  labResultImportKeys: number;
  biomarkers: number;
  illnessEpisodes: number;
  illnessDayLogs: number;
  allergies: number;
  familyHistory: number;
  workouts: number;
  documents: number;
}

/**
 * Build the structured-records slice. The default is the established portable
 * export. Only the weekly DR writer passes `purpose: "disaster-recovery"`.
 */
export async function buildRecordsBackupSection(
  prisma: Pick<
    PrismaClient,
    | "labResult"
    | "biomarker"
    | "biomarkerAlias"
    | "biomarkerMerge"
    | "labResultImportKey"
    | "illnessEpisode"
    | "allergy"
    | "familyHistoryEntry"
    | "workout"
    | "appleHealthTombstone"
    | "inboundDocument"
  >,
  userId: string,
  options: RecordsBackupOptions = {},
): Promise<RecordsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const [labs, illness, allergies, family, workouts, documents] =
    await Promise.all([
      buildLabsBackupSlice(prisma, userId, disasterRecovery),
      buildIllnessBackupSlice(prisma, userId, disasterRecovery),
      buildAllergiesBackupSlice(prisma, userId, disasterRecovery),
      buildFamilyHistoryBackupSlice(prisma, userId, disasterRecovery),
      buildWorkoutsBackupSlice(prisma, userId, disasterRecovery),
      buildDocumentsBackupSlice(
        prisma,
        userId,
        disasterRecovery,
        options.deferDocuments === true,
      ),
    ]);

  return {
    ...labs,
    ...illness,
    ...allergies,
    ...family,
    ...workouts,
    ...documents,
    manifest: {
      documents: disasterRecovery
        ? {
            included: "encrypted-content",
            note: "Document metadata and encrypted stored bytes are included for disaster recovery.",
          }
        : { included: "metadata-only", note: DOCUMENTS_MANIFEST_NOTE },
      workouts: { included: "summary-only", note: WORKOUTS_MANIFEST_NOTE },
    },
  };
}

/** Row counts for the audit trail / annotate() meta, mirroring `FullBackupCounts`. */
export function countRecordsBackupSection(
  section: RecordsBackupSection,
): RecordsBackupCounts {
  return {
    labResults: section.labResults.length,
    labResultImportKeys: section.labResultImportKeys.length,
    biomarkers: section.biomarkers.length,
    illnessEpisodes: section.illnessEpisodes.length,
    illnessDayLogs: section.illnessEpisodes.reduce(
      (sum, e) => sum + e.dayLogs.length,
      0,
    ),
    allergies: section.allergies.length,
    familyHistory: section.familyHistory.length,
    workouts: section.workouts.length,
    documents: section.documents.length,
  };
}
