/**
 * The one persistence body for an ECG recording, whichever door it came
 * through.
 *
 * Three writers put rows in `ecg_recordings`: the Withings OAuth sync, the
 * Apple Health `export.zip` importer, and the live `POST /api/insights/ecg`
 * ingest. They disagree about where a recording comes from and about how it
 * is identified, and about nothing else — so encryption, the derived
 * `sampleCount` / `durationSeconds`, the upsert, and the duplicate rule live
 * here and only here.
 *
 * Two identities, one row:
 *
 *   - `(userId, source, externalRecordingId)` is the SOURCE's own idea of a
 *     recording. The archive importer derives it from the recording's
 *     content (a hash), the live ingest sends the device's stable sample
 *     uuid, Withings sends its `signalid`. A re-post under the same id
 *     overwrites in place.
 *   - `(userId, source, recordedAt, samplingFrequency)` is what the recording
 *     actually IS. One device does not produce two different recordings for
 *     the same instant at the same sampling rate, so this catches the same
 *     physical strip arriving under two different source ids — the archive's
 *     content hash and the live sync's sample uuid for one Apple Watch ECG.
 *     The second arrival is reported as `duplicate` and writes nothing.
 *
 * The duplicate is resolved by an explicit lookup rather than by reading the
 * shape of a Prisma unique-violation error: the database index is the
 * structural backstop for a concurrent race, not the thing the outcome is
 * derived from. A race that slips past the lookup still cannot create a twin
 * — it raises `P2002`, and the handler below re-resolves it to the same
 * `duplicate` verdict.
 *
 * The waveform is encrypted BEFORE the transaction opens, so a crypto failure
 * fails closed without a write transaction ever existing. Both the ciphertext
 * buffer and the caller's plaintext sample array are zero-filled afterwards;
 * callers must not reuse `samples` after the call.
 */
import { Prisma } from "@/generated/prisma/client";
import type {
  MeasurementSource,
  PrismaClient,
  RhythmClassification,
} from "@/generated/prisma/client";
import { encryptWaveformToBytes } from "@/lib/withings/ecg-waveform-codec";

/**
 * What the write did.
 *
 * - `inserted` — a new row.
 * - `updated` — a row with this source id already existed and was overwritten.
 * - `duplicate` — this exact recording is already stored under a DIFFERENT
 *   source id (the other door). Nothing was written; `id` names the row that
 *   already holds it.
 */
export type EcgPersistOutcome = "inserted" | "updated" | "duplicate";

export interface EcgRecordingWrite {
  userId: string;
  source: MeasurementSource;
  /** The source's own stable id for this recording. */
  externalRecordingId: string;
  recordedAt: Date;
  /** Integer micro-volt samples. Zero-filled by this function. */
  samples: number[];
  /** Signal sampling rate in Hz; 0 when the source omitted it. */
  samplingFrequency: number;
  lead?: string | null;
  averageHeartRate?: number | null;
  /** The DEVICE's own verdict, verbatim. Never derived from the waveform. */
  rhythmClassification?: RhythmClassification | null;
  /** FK to the paired EVENT measurement row, when the writer knows it. */
  measurementId?: string | null;
}

export interface EcgPersistResult {
  outcome: EcgPersistOutcome;
  /** The row holding this recording — the written one, or the twin. */
  id: string;
  sampleCount: number;
  durationSeconds: number | null;
}

/**
 * `sampleCount / samplingFrequency`, or null when the source omitted the
 * frequency — a strip with no sampling rate has no knowable duration, and
 * dividing by zero would store Infinity.
 */
export function ecgDurationSeconds(
  sampleCount: number,
  samplingFrequency: number,
): number | null {
  return samplingFrequency > 0 ? sampleCount / samplingFrequency : null;
}

type TransactionalClient = Pick<PrismaClient, "$transaction">;

export async function persistEcgRecording(
  input: EcgRecordingWrite,
  db: TransactionalClient,
): Promise<EcgPersistResult> {
  const {
    userId,
    source,
    externalRecordingId,
    recordedAt,
    samples,
    samplingFrequency,
  } = input;

  const sampleCount = samples.length;
  const durationSeconds = ecgDurationSeconds(sampleCount, samplingFrequency);

  // Encryption happens before the transaction opens. A crypto failure
  // therefore fails closed without a write transaction ever existing, and
  // plaintext never reaches the row.
  const waveformEncrypted = encryptWaveformToBytes(samples);

  const sourceKey = {
    userId_source_externalRecordingId: {
      userId,
      source,
      externalRecordingId,
    },
  };
  const recordingKey = {
    userId_source_recordedAt_samplingFrequency: {
      userId,
      source,
      recordedAt,
      samplingFrequency,
    },
  };

  // Built field-by-field from the typed input; the parsed request object is
  // never spread into `data`.
  const columns = {
    recordedAt,
    waveformEncrypted,
    samplingFrequency,
    sampleCount,
    durationSeconds,
    lead: input.lead ?? null,
    averageHeartRate: input.averageHeartRate ?? null,
    rhythmClassification: input.rhythmClassification ?? null,
    measurementId: input.measurementId ?? null,
  };

  try {
    return await db.$transaction(async (tx) => {
      const existing = await tx.ecgRecording.findUnique({
        where: sourceKey,
        select: { id: true },
      });

      if (!existing) {
        const twin = await tx.ecgRecording.findUnique({
          where: recordingKey,
          select: { id: true },
        });
        if (twin) {
          return {
            outcome: "duplicate" as const,
            id: twin.id,
            sampleCount,
            durationSeconds,
          };
        }
      }

      const row = await tx.ecgRecording.upsert({
        where: sourceKey,
        create: { userId, source, externalRecordingId, ...columns },
        update: columns,
        select: { id: true },
      });

      return {
        outcome: existing ? ("updated" as const) : ("inserted" as const),
        id: row.id,
        sampleCount,
        durationSeconds,
      };
    });
  } catch (err) {
    // A concurrent writer claimed the recording between the lookup and the
    // write. The index held; re-resolve to the same honest verdict rather
    // than surfacing a constraint violation to a client that did nothing
    // wrong.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const twin = await db.$transaction(async (tx) =>
        tx.ecgRecording.findUnique({
          where: recordingKey,
          select: { id: true },
        }),
      );
      if (twin) {
        return {
          outcome: "duplicate",
          id: twin.id,
          sampleCount,
          durationSeconds,
        };
      }
    }
    throw err;
  } finally {
    waveformEncrypted.fill(0);
    samples.fill(0);
  }
}
