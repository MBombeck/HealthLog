/**
 * Structured records, workouts, and document backup section.
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
 * nothing (see `readForExport` below).
 */
import { Buffer } from "node:buffer";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { decryptNoteFromBytes } from "@/lib/labs/store";
import { decryptContextFromBytes } from "@/lib/labs/biomarker-store";
import { UNREADABLE_EXPORT_MARKER } from "./unreadable-marker";
import { decryptDocumentSummary } from "@/lib/documents/store";
import { getEvent } from "@/lib/logging/context";
import {
  toIllnessEpisodeDTO,
  toIllnessDayLogDTO,
  dayLogSymptomInclude,
  type IllnessEpisodeDTO,
  type IllnessDayLogDTO,
} from "@/lib/illness/dto";
import {
  toAllergyDTO,
  toFamilyHistoryEntryDTO,
  type AllergyDTO,
  type FamilyHistoryEntryDTO,
} from "@/lib/records/dto";

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

/**
 * Decrypt an encrypted free-text column for a portable export, or say plainly
 * that this one could not be read.
 *
 * A fail-soft decrypt answers `null` on a wrong or dropped key. In a list view
 * that is right — one bad row must not take the page down. In an export it is
 * not: `null` is exactly what a column that was never written looks like, so
 * the restore importer writes nothing and a note the person did write
 * disappears without anyone being told. The Coach transcript and the doctor
 * report both refuse that trade, one with a placeholder sentence and one with
 * a rendered flag; this follows the same rule.
 *
 * The warning the soft helpers emitted is kept, so a systemic key gap still
 * shows up in the wide event rather than only in the file.
 */
function readForExport(
  buf: Uint8Array | null,
  label: string,
  decode: (bytes: Uint8Array) => string,
): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decode(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `${label} decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return UNREADABLE_EXPORT_MARKER;
  }
}

export interface LabResultBackupEntry {
  /** Present in canonical DR payloads so rows keep a stable identity. */
  id?: string;
  panel: string | null;
  analyte: string;
  value: number | null;
  valueText: string | null;
  unit: string;
  referenceLow: number | null;
  referenceHigh: number | null;
  /** The window the reading's own source report printed, verbatim + derived. */
  sourceReferenceLow: number | null;
  sourceReferenceHigh: number | null;
  sourceReferenceText: string | null;
  takenAt: string;
  source: string;
  /** Human-readable cross-reference into `biomarkers` below, not an id. */
  /** Stable canonical FK; legacy portable payloads use biomarkerName. */
  biomarkerId?: string | null;
  biomarkerName: string | null;
  note: string | null;
  /** Base64 ciphertext in canonical DR payloads. */
  noteEncrypted?: string | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface BiomarkerBackupEntry {
  /** Present in canonical DR payloads; name remains the natural key. */
  id?: string;
  name: string;
  unit: string;
  lowerBound: number | null;
  upperBound: number | null;
  panel: string | null;
  hidden: boolean;
  context: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkoutBackupEntry {
  /** Present in canonical DR payloads for manual workouts without externalId. */
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  sportType: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  stepCount: number | null;
  elevationM: number | null;
  pauseDurationSec: number | null;
  source: string;
  externalId: string | null;
  /** Canonical DR only; portable workout summaries keep their existing shape. */
  metadata?: Prisma.JsonValue;
}

export interface DocumentBackupEntry {
  id: string;
  kind: string;
  title: string | null;
  filename: string | null;
  mimeType: string;
  byteSize: number;
  status: string;
  reportDate: string | null;
  documentDate: string | null;
  /** Portable export only; canonical DR carries summaryEncrypted instead. */
  summary?: string | null;
  createdAt: string;
  updatedAt?: string;
  /** Base64 of the already-encrypted BYTEA value; never plaintext. */
  contentEncrypted?: string;
  contentSha256?: string | null;
  contentCodec?: string;
  providerType?: string | null;
  errorReason?: string | null;
  /** Base64 of the already-encrypted summary BYTEA value. */
  summaryEncrypted?: string | null;
  summaryGeneratedAt?: string | null;
  summaryState?: string;
  /** Refs #776 — the index-attempt record, carried verbatim (canonical DR). */
  lastIndexAttemptAt?: string | null;
  lastIndexOutcome?: string | null;
  /**
   * v1.39.2 (#1038) — where an imported document came from, both payload
   * kinds. Optional so a file written before the fields existed still parses.
   */
  sourceSystem?: string | null;
  sourceId?: string | null;
}

export interface RecordsBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

interface DisasterRecoveryDocumentRow {
  contentEncrypted: Uint8Array;
  contentSha256: string | null;
  contentCodec: string;
  providerType: string | null;
  errorReason: string | null;
  summaryEncrypted: Uint8Array | null;
  summaryGeneratedAt: Date | null;
  summaryState: string;
  lastIndexAttemptAt: Date | null;
  lastIndexOutcome: string | null;
  updatedAt: Date;
}

type CanonicalIllnessDayLog = IllnessDayLogDTO & {
  noteEncrypted?: string | null;
  tz?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
};

type CanonicalIllnessEpisode = IllnessEpisodeDTO & {
  noteEncrypted?: string | null;
  /** The body site's ciphertext, disaster-recovery purpose only (v1.39.2). */
  bodySiteEncrypted?: string | null;
  deletedAt?: string | null;
  dayLogs: CanonicalIllnessDayLog[];
};

type CanonicalAllergy = AllergyDTO & {
  reactionEncrypted?: string | null;
  notesEncrypted?: string | null;
  deletedAt?: string | null;
};

export interface RecordsBackupSection {
  labResults: LabResultBackupEntry[];
  biomarkers: BiomarkerBackupEntry[];
  illnessEpisodes: CanonicalIllnessEpisode[];
  allergies: CanonicalAllergy[];
  familyHistory: FamilyHistoryEntryDTO[];
  workouts: WorkoutBackupEntry[];
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
  biomarkers: number;
  illnessEpisodes: number;
  illnessDayLogs: number;
  allergies: number;
  familyHistory: number;
  workouts: number;
  documents: number;
}

/** Decrypt a document's optional AI summary fail-soft (null on any error). */
function decryptSummarySoft(buf: Uint8Array | null): string | null {
  if (!buf || buf.byteLength === 0) return null;
  try {
    return decryptDocumentSummary(buf);
  } catch (err) {
    getEvent()?.addWarning(
      `document summary decrypt failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
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
    | "illnessEpisode"
    | "allergy"
    | "familyHistoryEntry"
    | "workout"
    | "inboundDocument"
  >,
  userId: string,
  options: RecordsBackupOptions = {},
): Promise<RecordsBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  const documentQuery = disasterRecovery
    ? prisma.inboundDocument.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          title: true,
          filename: true,
          mimeType: true,
          byteSize: true,
          contentEncrypted: true,
          contentSha256: true,
          contentCodec: true,
          status: true,
          providerType: true,
          reportDate: true,
          documentDate: true,
          errorReason: true,
          summaryEncrypted: true,
          summaryGeneratedAt: true,
          summaryState: true,
          lastIndexAttemptAt: true,
          lastIndexOutcome: true,
          sourceSystem: true,
          sourceId: true,
          createdAt: true,
          updatedAt: true,
        },
      })
    : prisma.inboundDocument.findMany({
        where: { userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          title: true,
          filename: true,
          mimeType: true,
          byteSize: true,
          status: true,
          reportDate: true,
          documentDate: true,
          summaryEncrypted: true,
          sourceSystem: true,
          sourceId: true,
          createdAt: true,
        },
      });
  const [
    labResultRows,
    biomarkerRows,
    episodeRows,
    allergyRows,
    familyRows,
    workoutRows,
    documentRows,
  ] = await Promise.all([
    prisma.labResult.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { takenAt: "desc" },
      include: { biomarker: { select: { name: true } } },
    }),
    prisma.biomarker.findMany({
      where: { userId },
      orderBy: { name: "asc" },
    }),
    prisma.illnessEpisode.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { onsetAt: "desc" },
      include: {
        dayLogs: {
          ...(disasterRecovery ? {} : { where: { deletedAt: null } }),
          orderBy: { date: "asc" },
          include: dayLogSymptomInclude,
        },
      },
    }),
    prisma.allergy.findMany({
      where: disasterRecovery ? { userId } : { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.familyHistoryEntry.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    prisma.workout.findMany({
      where: { userId },
      orderBy: { startedAt: "desc" },
    }),
    documentQuery,
  ]);

  const labResults: LabResultBackupEntry[] = labResultRows.map((r) => ({
    ...(disasterRecovery
      ? {
          id: r.id,
          biomarkerId: r.biomarkerId,
          noteEncrypted: r.noteEncrypted
            ? Buffer.from(r.noteEncrypted).toString("base64")
            : null,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
          deletedAt: r.deletedAt?.toISOString() ?? null,
          note: null,
        }
      : {
          note: readForExport(
            r.noteEncrypted,
            "lab note",
            decryptNoteFromBytes,
          ),
        }),
    panel: r.panel,
    analyte: r.analyte,
    value: r.value,
    valueText: r.valueText,
    unit: r.unit,
    referenceLow: r.referenceLow,
    referenceHigh: r.referenceHigh,
    sourceReferenceLow: r.sourceReferenceLow,
    sourceReferenceHigh: r.sourceReferenceHigh,
    sourceReferenceText: r.sourceReferenceText,
    takenAt: r.takenAt.toISOString(),
    source: r.source,
    biomarkerName: r.biomarker?.name ?? null,
  }));

  const biomarkers: BiomarkerBackupEntry[] = biomarkerRows.map((b) => ({
    ...(disasterRecovery
      ? {
          id: b.id,
          createdAt: b.createdAt.toISOString(),
          updatedAt: b.updatedAt.toISOString(),
        }
      : {}),
    name: b.name,
    unit: b.unit,
    lowerBound: b.lowerBound,
    upperBound: b.upperBound,
    panel: b.panel,
    hidden: b.hidden,
    context: readForExport(
      b.contextEncrypted,
      "biomarker context",
      decryptContextFromBytes,
    ),
  }));

  const illnessEpisodes: CanonicalIllnessEpisode[] = disasterRecovery
    ? episodeRows.map((row) => ({
        id: row.id,
        label: row.label,
        type: row.type,
        lifecycle: row.lifecycle,
        onsetAt: row.onsetAt.toISOString(),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        parentConditionId: row.parentConditionId,
        note: null,
        noteEncrypted: row.noteEncrypted
          ? Buffer.from(row.noteEncrypted).toString("base64")
          : null,
        // Ciphertext verbatim, like the note: the disaster-recovery file never
        // carries the site in the clear.
        bodySite: null,
        bodySiteEncrypted: row.bodySiteEncrypted
          ? Buffer.from(row.bodySiteEncrypted).toString("base64")
          : null,
        laterality: row.laterality,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
        dayLogs: row.dayLogs.map((dayLog) => ({
          id: dayLog.id,
          episodeId: dayLog.episodeId,
          date: dayLog.date,
          functionalImpact: dayLog.functionalImpact,
          feverC: dayLog.feverC,
          note: null,
          noteEncrypted: dayLog.noteEncrypted
            ? Buffer.from(dayLog.noteEncrypted).toString("base64")
            : null,
          tz: dayLog.tz,
          createdAt: dayLog.createdAt.toISOString(),
          updatedAt: dayLog.updatedAt.toISOString(),
          deletedAt: dayLog.deletedAt?.toISOString() ?? null,
          symptoms: dayLog.symptomLinks.map((link) => ({
            key: link.symptom.key,
            severity: link.severity,
          })),
        })),
      }))
    : episodeRows.map((row) => ({
        ...toIllnessEpisodeDTO(row),
        dayLogs: row.dayLogs.map(toIllnessDayLogDTO),
      }));

  const allergies: CanonicalAllergy[] = disasterRecovery
    ? allergyRows.map((row) => ({
        id: row.id,
        substance: row.substance,
        category: row.category,
        type: row.type,
        severity: row.severity,
        status: row.status,
        onsetAt: row.onsetAt?.toISOString() ?? null,
        reaction: null,
        note: null,
        reactionEncrypted: row.reactionEncrypted
          ? Buffer.from(row.reactionEncrypted).toString("base64")
          : null,
        notesEncrypted: row.notesEncrypted
          ? Buffer.from(row.notesEncrypted).toString("base64")
          : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        deletedAt: row.deletedAt?.toISOString() ?? null,
      }))
    : allergyRows.map(toAllergyDTO);
  const familyHistory = familyRows.map(toFamilyHistoryEntryDTO);

  const workouts: WorkoutBackupEntry[] = workoutRows.map((w) => ({
    ...(disasterRecovery
      ? {
          id: w.id,
          createdAt: w.createdAt.toISOString(),
          updatedAt: w.updatedAt.toISOString(),
          ...(w.metadata == null ? {} : { metadata: w.metadata }),
        }
      : {}),
    sportType: w.sportType,
    startedAt: w.startedAt.toISOString(),
    endedAt: w.endedAt.toISOString(),
    durationSec: w.durationSec,
    totalEnergyKcal: w.totalEnergyKcal,
    totalDistanceM: w.totalDistanceM,
    avgHeartRate: w.avgHeartRate,
    maxHeartRate: w.maxHeartRate,
    minHeartRate: w.minHeartRate,
    stepCount: w.stepCount,
    elevationM: w.elevationM,
    pauseDurationSec: w.pauseDurationSec,
    source: w.source,
    externalId: w.externalId,
  }));

  const documents: DocumentBackupEntry[] = documentRows.map((d) => {
    const metadata = {
      id: d.id,
      kind: d.kind,
      title: d.title,
      filename: d.filename,
      mimeType: d.mimeType,
      byteSize: d.byteSize,
      status: d.status,
      reportDate: d.reportDate ? d.reportDate.toISOString().slice(0, 10) : null,
      documentDate: d.documentDate
        ? d.documentDate.toISOString().slice(0, 10)
        : null,
      sourceSystem: d.sourceSystem,
      sourceId: d.sourceId,
      createdAt: d.createdAt.toISOString(),
    };

    if (disasterRecovery && "contentEncrypted" in d) {
      const dr = d as typeof d & DisasterRecoveryDocumentRow;
      return {
        ...metadata,
        reportDate: dr.reportDate?.toISOString() ?? null,
        documentDate: dr.documentDate?.toISOString() ?? null,
        updatedAt: dr.updatedAt.toISOString(),
        contentEncrypted: Buffer.from(dr.contentEncrypted).toString("base64"),
        contentSha256: dr.contentSha256,
        contentCodec: dr.contentCodec,
        providerType: dr.providerType,
        errorReason: dr.errorReason,
        summaryEncrypted: dr.summaryEncrypted
          ? Buffer.from(dr.summaryEncrypted).toString("base64")
          : null,
        summaryGeneratedAt: dr.summaryGeneratedAt?.toISOString() ?? null,
        summaryState: dr.summaryState,
        lastIndexAttemptAt: dr.lastIndexAttemptAt?.toISOString() ?? null,
        lastIndexOutcome: dr.lastIndexOutcome,
      };
    }

    return {
      ...metadata,
      summary: decryptSummarySoft(d.summaryEncrypted),
    };
  });

  return {
    labResults,
    biomarkers,
    illnessEpisodes,
    allergies,
    familyHistory,
    workouts,
    documents,
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
