/**
 * A backup file read as a stream: every section but the measurements in
 * memory, the measurements handed over in batches.
 *
 * Why. The measurements are the one section that grows with a record without
 * bound. For an account with 1.25 million of them the disaster-recovery JSON
 * is 662 MB, which cannot exist as one JavaScript string, and the parsed rows
 * alone would not fit a 1 GB container beside the running app (#1031). Every
 * other section of the same file is a few megabytes.
 *
 * So the file is read twice. The first read keeps everything except the
 * measurements, and checks each measurement against the same element schema
 * the whole-file schema uses, counting them. Nothing is written on the
 * strength of an unchecked row: a restore reads the file this way before it
 * deletes anything. The second read, from `forEachMeasurementBatch`, hands
 * the measurements over in order, in batches, for the writer.
 *
 * `raw` is the file exactly as `JSON.parse` would give it, with
 * `measurements` replaced by an empty array when the file has that section
 * (and still absent when it does not, which is what the section-presence
 * check reads). Run it through `parseBackupPayload` for the rest of the
 * validation; together that is the whole-file check.
 */
import { scanBackupJson } from "@/lib/export/backup-json-scan";
import {
  BACKUP_SCHEMA_VERSION,
  backupMeasurementSchema,
  type BackupMeasurement,
} from "@/lib/validations/backup";

/** The file's bytes, from the start, every time it is called. */
export type BackupSource = () => AsyncIterable<Uint8Array>;

const MEASUREMENTS = "measurements";
const STREAMED = new Set([MEASUREMENTS]);

/** A measurement the element schema refused, with where it is in the file. */
export class StreamedBackupInvalidError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "StreamedBackupInvalidError";
    this.path = path;
  }
}

export interface StreamedBackup {
  /** The file without its measurements (see the module comment). */
  raw: Record<string, unknown>;
  /** How many measurements the file carries. */
  measurementCount: number;
  /** The file's size in bytes. */
  bytes: number;
  /**
   * Read the file again and hand its measurements over in file order, in
   * batches of at most `size`, each row parsed by the element schema.
   * Awaits `fn` before reading further.
   */
  forEachMeasurementBatch(
    size: number,
    fn: (batch: BackupMeasurement[]) => Promise<void>,
  ): Promise<void>;
}

function parseMeasurement(element: unknown, index: number): BackupMeasurement {
  const parsed = backupMeasurementSchema.safeParse(element);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new StreamedBackupInvalidError(
      [MEASUREMENTS, index, ...(issue?.path ?? [])].join("."),
      issue?.message ?? "invalid measurement",
    );
  }
  return parsed.data;
}

/**
 * First read of a backup file. Rejects with `BackupJsonError` for input that
 * is not a JSON object and with `StreamedBackupInvalidError` for a
 * measurement the schema refuses.
 */
export async function readStreamedBackup(
  source: BackupSource,
): Promise<StreamedBackup> {
  let firstWithoutId: number | null = null;
  let bytes = 0;
  async function* counted() {
    for await (const chunk of source()) {
      bytes += chunk.byteLength;
      yield chunk;
    }
  }
  const { document, streamedCounts } = await scanBackupJson(counted(), {
    streamKeys: STREAMED,
    onElement: (_key, element, index) => {
      const row = parseMeasurement(element, index);
      if (!row.id && firstWithoutId === null) firstWithoutId = index;
    },
  });

  // The whole-file schema's cross-row rule, applied the same way: a canonical
  // v2 file must give every measurement a stable id.
  if (
    document.schemaVersion === BACKUP_SCHEMA_VERSION &&
    firstWithoutId !== null
  ) {
    throw new StreamedBackupInvalidError(
      `${MEASUREMENTS}.${firstWithoutId}.id`,
      "Canonical v2 measurements require a stable id",
    );
  }

  const skipKeys = new Set(
    Object.keys(document).filter((key) => key !== MEASUREMENTS),
  );

  return {
    raw: document,
    measurementCount: streamedCounts[MEASUREMENTS] ?? 0,
    bytes,
    async forEachMeasurementBatch(size, fn) {
      let batch: BackupMeasurement[] = [];
      await scanBackupJson(source(), {
        streamKeys: STREAMED,
        skipKeys,
        onElement: async (_key, element, index) => {
          batch.push(parseMeasurement(element, index));
          if (batch.length >= size) {
            const full = batch;
            batch = [];
            await fn(full);
          }
        },
      });
      if (batch.length > 0) await fn(batch);
    },
  };
}
