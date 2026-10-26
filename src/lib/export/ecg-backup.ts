/**
 * The ECG strips, with both backup ends in one file.
 *
 * Same arrangement as `reminders-backup.ts`, `visits-backup.ts` and
 * `coach-backup.ts`, for the same reason: a reader asking "is this carried at
 * both ends?" answers it here, and a reader who greps only the restore ROUTE
 * gets a false negative because the route delegates.
 *
 * One model rides. Its register entry read "ECG traces and their rhythm
 * classification. The originating device may still hold them, but a
 * self-hoster who exported and wiped has nothing to re-sync from." That is the
 * whole case: a watch keeps a strip only as long as the phone beside it does,
 * and the Withings signal id stops resolving the moment the connection is
 * revoked.
 *
 * ## The trace and the verdict are different losses
 *
 * A recording is three things at once: WHEN a heart was recorded, WHAT the
 * device concluded about the rhythm, and the micro-volt series behind that
 * conclusion. A restore that returned the row with a defaulted
 * `rhythmClassification` would hand back a strip nobody has read a verdict off,
 * and a restore that returned it with a defaulted `recordedAt` would hand back
 * a strip that belongs to no day. Both are carried verbatim, and both are
 * asserted in `tests/integration/backup-round-trip.test.ts` rather than counted.
 *
 * ## The waveform follows the note contract, with one exception
 *
 * A disaster-recovery payload carries the stored ciphertext verbatim as base64,
 * because the same instance's key reads it back unchanged. A portable export
 * decrypts it, because a portable export exists to be readable by the person
 * who owns it, exactly as it already decrypts medication notes and mood notes.
 *
 * The exception is what happens when a strip cannot be decrypted at all — a row
 * written under a key the instance has since dropped. The Coach substitutes a
 * placeholder sentence for a turn in that state, because the other nine hundred
 * turns are still the person's and a thrown error would cost them all of it.
 * There is no placeholder for a waveform: `waveformEncrypted` is a required
 * column, so the choice is between writing a recording that describes a strip
 * nothing can draw and leaving it out. The unreadable recording is left OUT of
 * a portable file and a warning is raised on the wide event, so the number of
 * strips in the file is the number of strips that can be shown. A
 * disaster-recovery payload never decrypts and is therefore never affected.
 *
 * ## The one reference that needs care
 *
 * `measurementId` addresses the IRREGULAR_RHYTHM_NOTIFICATION event row the
 * strip was filed against, and unlike the Coach's `sourceConversationId` it is
 * a REAL foreign key. A value pointing at nothing does not quietly stop meaning
 * anything here: it violates the constraint and rolls the WHOLE restore back,
 * which hands the operator an empty account over one dangling id. That is not
 * hypothetical in this section — a portable export omits soft-deleted
 * measurements, so a strip filed against a measurement the account has since
 * deleted names a row the file does not carry.
 *
 * So the reference is resolved against the measurements the restore actually
 * wrote, and a miss is NULLED and reported rather than written. Nulling rather
 * than dropping is deliberate: the strip is the record, the event row is a
 * cross-reference, and losing the recording to save the pointer would be the
 * wrong way round.
 */
import { Buffer } from "node:buffer";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type {
  MeasurementSource,
  RhythmClassification,
} from "@/generated/prisma/client";

import { getEvent } from "@/lib/logging/context";
import {
  decryptWaveformFromBytes,
  encryptWaveformToBytes,
} from "@/lib/withings/ecg-waveform-codec";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";
import type { EcgTrace } from "@/lib/export/streamed-backup";

export interface EcgBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/** One recorded strip. */
export interface EcgRecordingBackupEntry {
  /** Present in a disaster-recovery payload; a portable file mints a fresh id
   *  because nothing else in the file addresses a recording. */
  id?: string;
  source: MeasurementSource;
  externalRecordingId: string;
  /** When the strip was taken on-device. Never the export time: a recording
   *  without its own instant belongs to no day. */
  recordedAt: string;
  /** Ciphertext as base64. Present on a disaster-recovery payload only. */
  waveformEncrypted?: string;
  /** The micro-volt sample array. Present on a portable payload only. */
  waveform?: number[];
  samplingFrequency: number;
  sampleCount: number;
  durationSeconds: number | null;
  lead: string | null;
  averageHeartRate: number | null;
  /** The device's own rhythm verdict. Carried verbatim — nothing can re-derive
   *  a conclusion a device reached about a strip. */
  rhythmClassification: RhythmClassification | null;
  /** The paired EVENT measurement, remapped on the way back. */
  measurementId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EcgBackupSection {
  ecgRecordings: EcgRecordingBackupEntry[];
}

export interface EcgBackupCounts {
  ecgRecordings: number;
}

/**
 * Every restorable `EcgRecording` scalar.
 *
 * Named rather than inlined so a column added to the model shows up as a diff
 * here rather than as a silent omission from the file.
 */
const ECG_RECORDING_BACKUP_SELECT = {
  id: true,
  source: true,
  externalRecordingId: true,
  recordedAt: true,
  waveformEncrypted: true,
  samplingFrequency: true,
  sampleCount: true,
  durationSeconds: true,
  lead: true,
  averageHeartRate: true,
  rhythmClassification: true,
  measurementId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EcgRecordingSelect;

type EcgRecordingBackupRow = Prisma.EcgRecordingGetPayload<{
  select: typeof ECG_RECORDING_BACKUP_SELECT;
}>;

/**
 * The order both readers below walk the strips in. Total, with the id after
 * the instant, because the paged reader's cursor needs a total order and two
 * strips recorded in the same second must not swap places between two
 * exports of the same account.
 */
const ECG_RECORDING_ORDER = [
  { recordedAt: "asc" },
  { id: "asc" },
] as const satisfies Prisma.EcgRecordingOrderByWithRelationInput[];

/**
 * One strip as it rides the wire, or null for a portable export of a strip
 * that will not decrypt (see the file header). Shared by both readers, so the
 * paged one and the materialising one cannot drift.
 */
function serialiseEcgRecording(
  row: EcgRecordingBackupRow,
  disasterRecovery: boolean,
): EcgRecordingBackupEntry | null {
  const common = {
    source: row.source,
    externalRecordingId: row.externalRecordingId,
    recordedAt: row.recordedAt.toISOString(),
    samplingFrequency: row.samplingFrequency,
    sampleCount: row.sampleCount,
    durationSeconds: row.durationSeconds,
    lead: row.lead,
    averageHeartRate: row.averageHeartRate,
    rhythmClassification: row.rhythmClassification,
    measurementId: row.measurementId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  if (disasterRecovery) {
    return {
      id: row.id,
      waveformEncrypted: Buffer.from(row.waveformEncrypted).toString("base64"),
      ...common,
    };
  }

  // See the file header: a strip that will not decrypt is left out rather
  // than written as a recording with no trace behind it.
  try {
    return {
      waveform: decryptWaveformFromBytes(row.waveformEncrypted),
      ...common,
    };
  } catch (err) {
    getEvent()?.addWarning(
      `ECG waveform decrypt failed, recording omitted from portable export: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

/**
 * How many strips one page of the paged reader carries. A strip's trace is
 * tens of kilobytes of ciphertext, so a page is a few megabytes.
 */
const ECG_PAGE_SIZE = 50;

/**
 * Every strip of the account, one serialised row at a time, read a page at a
 * time. For the streaming backup writer, which must not hold every trace of a
 * long-lived account at once (#1239).
 */
export async function* iterateBackupEcgRecordings(
  prisma: Pick<PrismaClient, "ecgRecording">,
  userId: string,
  options: EcgBackupOptions = {},
): AsyncGenerator<EcgRecordingBackupEntry, void, void> {
  const disasterRecovery = options.purpose === "disaster-recovery";
  let cursorId: string | null = null;
  for (;;) {
    const page: EcgRecordingBackupRow[] = await prisma.ecgRecording.findMany({
      where: { userId },
      orderBy: ECG_RECORDING_ORDER,
      take: ECG_PAGE_SIZE,
      ...(cursorId !== null ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: ECG_RECORDING_BACKUP_SELECT,
    });
    if (page.length === 0) return;
    for (const row of page) {
      const entry = serialiseEcgRecording(row, disasterRecovery);
      if (entry) yield entry;
    }
    if (page.length < ECG_PAGE_SIZE) return;
    cursorId = page[page.length - 1]!.id;
  }
}

/**
 * Build the ECG slice of a user's full backup.
 *
 * Takes the delegate it uses rather than a whole client, matching the other
 * section builders. The table carries no tombstone column, so both purposes
 * read the same rows; they differ only in how the waveform travels.
 *
 * With `defer`, nothing is read and the slice comes back empty: the streaming
 * writer pulls the strips through `iterateBackupEcgRecordings` itself.
 */
export async function buildEcgBackupSection(
  prisma: Pick<PrismaClient, "ecgRecording">,
  userId: string,
  options: EcgBackupOptions & { defer?: boolean } = {},
): Promise<EcgBackupSection> {
  if (options.defer) return { ecgRecordings: [] };
  const disasterRecovery = options.purpose === "disaster-recovery";

  const rows = await prisma.ecgRecording.findMany({
    where: { userId },
    orderBy: ECG_RECORDING_ORDER,
    select: ECG_RECORDING_BACKUP_SELECT,
  });

  const ecgRecordings: EcgRecordingBackupEntry[] = [];
  for (const row of rows) {
    const entry = serialiseEcgRecording(row, disasterRecovery);
    if (entry) ecgRecordings.push(entry);
  }
  return { ecgRecordings };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countEcgBackupSection(
  section: EcgBackupSection,
): EcgBackupCounts {
  return { ecgRecordings: section.ecgRecordings.length };
}

/** Hands over each strip's trace from a second read of the file. */
export type EcgTraceSource = (
  fn: (trace: EcgTrace, index: number) => Promise<void>,
) => Promise<void>;

/** Counts the ECG restore wiped, for the audit trail. */
export interface EcgRestoreCleared {
  ecgRecordings: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults the key, so every
 * caller already satisfies this, and one that stops satisfying it fails to
 * compile instead of restoring nothing and reporting success.
 */
export interface EcgRestoreInput {
  ecgRecordings: RestoredEcgRecording[];
}

/**
 * What the parser hands over, which is looser than what the builder writes: an
 * older file carries no ECG key at all, and every optional column arrives as
 * `undefined` rather than `null`.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredEcgRecording = Pick<
  EcgRecordingBackupEntry,
  | "source"
  | "externalRecordingId"
  | "recordedAt"
  | "samplingFrequency"
  | "sampleCount"
  | "createdAt"
  | "updatedAt"
> &
  OptionalNullable<
    Pick<
      EcgRecordingBackupEntry,
      | "id"
      | "waveformEncrypted"
      | "waveform"
      | "durationSeconds"
      | "lead"
      | "averageHeartRate"
      | "rhythmClassification"
      | "measurementId"
    >
  >;

/**
 * Re-create the account's ECG recordings.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. The wipe at the top of the restore does NOT reach these: an ECG row
 * hangs off the account, not off a measurement, so deleting the measurements
 * only nulls its `measurementId` and leaves the strip behind. Without the
 * delete here a restore would stack a second copy of every recording on top of
 * the first, and the `(userId, source, recordedAt, samplingFrequency)` unique
 * would fail the whole transaction on the first duplicate.
 *
 * MUST be called AFTER the measurements are restored: `measurementId` is a real
 * foreign key against them, so running earlier would make every reference
 * unresolvable — and, worse than unresolvable, would take the restore down with
 * a constraint violation if it were written anyway.
 *
 * `measurementIds` is the set of measurements the restore actually put back,
 * passed in rather than re-queried so this stays a pure function of the
 * transaction it was handed.
 */
export async function restoreEcgData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: EcgRestoreInput,
  measurementIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
  forEachTrace: EcgTraceSource,
): Promise<EcgRestoreCleared> {
  const cleared = await tx.ecgRecording.deleteMany({
    where: { userId: ownerId },
  });

  const droppedMeasurementRefs: string[] = [];
  // The traces come from a second read of the file, one strip at a time
  // (`forEachEcgTrace`): the first read kept each strip without its trace,
  // because a long ECG history held whole is a vault of its own. The strips
  // are in file order on both reads.
  let traces = 0;
  if (payload.ecgRecordings.length > 0) {
    await forEachTrace(async (trace, index) => {
      traces++;
      const listed = payload.ecgRecordings[index];
      if (!listed) {
        throw new Error(
          `ECG recording ${index} of the backup is missing from the first read`,
        );
      }
      await writeRecording({ ...listed, ...trace });
    });
  }
  if (traces !== payload.ecgRecordings.length) {
    throw new Error(
      `The backup lists ${payload.ecgRecordings.length} ECG recordings and the second read found ${traces}`,
    );
  }

  async function writeRecording(recording: RestoredEcgRecording) {
    let measurementId = recording.measurementId ?? null;
    if (measurementId && !measurementIds.has(measurementId)) {
      droppedMeasurementRefs.push(measurementId);
      measurementId = null;
    }
    await tx.ecgRecording.create({
      data: {
        ...(recording.id ? { id: recording.id } : {}),
        userId: ownerId,
        source: recording.source,
        externalRecordingId: recording.externalRecordingId,
        recordedAt: new Date(recording.recordedAt),
        waveformEncrypted: resolveWaveformBytes(recording),
        samplingFrequency: recording.samplingFrequency,
        sampleCount: recording.sampleCount,
        durationSeconds: recording.durationSeconds ?? null,
        lead: recording.lead ?? null,
        averageHeartRate: recording.averageHeartRate ?? null,
        // Verbatim, never re-derived. The verdict is what a device concluded
        // looking at the signal, and this instance is not that device.
        rhythmClassification: recording.rhythmClassification ?? null,
        measurementId,
        createdAt: new Date(recording.createdAt),
        updatedAt: new Date(recording.updatedAt),
      },
    });
  }

  recordUnknownKeys(
    skips,
    "ecgReference",
    [...new Set(droppedMeasurementRefs)],
    droppedMeasurementRefs,
  );

  return { ecgRecordings: cleared.count };
}

/**
 * A strip's stored bytes, whichever end of the contract the file came from.
 *
 * A disaster-recovery file carries ciphertext that decodes straight back into
 * the column. A portable file carries the sample array, which is encrypted on
 * the way in under the TARGET instance's key — the whole point of a portable
 * file being portable.
 */
function resolveWaveformBytes(
  recording: RestoredEcgRecording,
): Uint8Array<ArrayBuffer> {
  if (recording.waveformEncrypted !== undefined) {
    const decoded = Buffer.from(recording.waveformEncrypted, "base64");
    const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
    bytes.set(decoded);
    return bytes;
  }
  return encryptWaveformToBytes(recording.waveform ?? []);
}
