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
 * The documents are the other one: a stored document is up to a hundred
 * megabytes, and a vault of 190 MB held whole cost more heap than a 524 MB
 * process has (#1239). The first read keeps each document without its stored
 * bytes (`DOCUMENT_CONTENT_LEFT_OUT` in their place), and
 * `forEachDocumentContent` reads them again one document at a time.
 *
 * The other sections that grow with a record (`BACKUP_STREAMED_SECTIONS`) are
 * read an element at a time too and kept as they are, so no section of the
 * file is ever one string of its own. That string, and the parse beside it,
 * is what a reader that takes a section whole pays twice over.
 *
 * Every reader of a backup file goes through `readStreamedBackup`, or, where
 * it only counts and checks keys, through `BACKUP_STREAM_KEYS`: the sections
 * read element by element are named here and nowhere else.
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
import { BackupKeyIdCollector } from "@/lib/export/backup-key-ids";
import { scanBackupJson } from "@/lib/export/backup-json-scan";
import type {
  BackupMeasurement,
  backupMeasurementSchema,
} from "@/lib/validations/backup";
import { BACKUP_SCHEMA_VERSION } from "@/lib/validations/backup-summary";

type MeasurementSchema = typeof backupMeasurementSchema;

/**
 * The element schema, loaded with the rest of `backup.ts` on the first read
 * rather than at import: the module sits on the boot path of the restore job
 * and the schema is ~12 MB of heap (`backup-summary.ts`).
 */
async function loadMeasurementSchema(): Promise<MeasurementSchema> {
  return (await import("@/lib/validations/backup")).backupMeasurementSchema;
}

/** The file's bytes, from the start, every time it is called. */
export type BackupSource = () => AsyncIterable<Uint8Array>;

const MEASUREMENTS = "measurements";
const DOCUMENTS = "documents";

/**
 * The sections a backup reader takes an element at a time, never whole: the
 * ones that grow with a record, in rows (measurements, intake events, mood
 * entries) or in stored bytes (documents, ECG traces). How the first read
 * treats each: the measurements are checked and counted, not kept; the
 * documents are kept without their stored bytes; the rest are kept element
 * by element.
 */
export const BACKUP_STREAMED_SECTIONS = [
  MEASUREMENTS,
  "intakeEvents",
  "moodEntries",
  DOCUMENTS,
  "ecgRecordings",
] as const;

/** `BACKUP_STREAMED_SECTIONS` as `scanBackupJson` takes it. */
export const BACKUP_STREAM_KEYS: ReadonlySet<string> = new Set(
  BACKUP_STREAMED_SECTIONS,
);

const MEASUREMENTS_ONLY = new Set([MEASUREMENTS]);
const DOCUMENTS_ONLY = new Set([DOCUMENTS]);

/**
 * What a document's `contentEncrypted` reads as in `raw`, where the stored
 * bytes are left out (#1239): valid base64, so the whole-file schema still
 * sees a document that carries content, and too short to be ciphertext, so
 * nothing could mistake it for some. The restore writes the real value, from
 * `forEachDocumentContent`.
 */
const DOCUMENT_CONTENT_LEFT_OUT = "AA==";

/** Base64, as the backup schema accepts it for stored bytes. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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
   * The application key ids the file's inner ciphertext was written under,
   * gathered on the first read (`assessBackupKeys` holds them against this
   * host's keys).
   */
  keys: BackupKeyIdCollector;
  /**
   * Read the file again and hand its measurements over in file order, in
   * batches of at most `size`, each row parsed by the element schema.
   * Awaits `fn` before reading further.
   */
  forEachMeasurementBatch(
    size: number,
    fn: (batch: BackupMeasurement[]) => Promise<void>,
  ): Promise<void>;
  /**
   * Read the file again and hand over each document's `contentEncrypted`
   * (the base64 the first read left out of `raw`, or undefined where the
   * file carries none) with the document's position, one document at a time.
   * Awaits `fn` before reading further.
   */
  forEachDocumentContent(
    fn: (content: string | undefined, index: number) => Promise<void>,
  ): Promise<void>;
}

function parseMeasurement(
  schema: MeasurementSchema,
  element: unknown,
  index: number,
): BackupMeasurement {
  const parsed = schema.safeParse(element);
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
export interface ReadStreamedBackupOptions {
  /**
   * Called after each measurement passes the element schema, with how many
   * have so far and the parsed row. For a caller that reports progress or
   * gathers a small index over the rows (the restore collects the live
   * `stats:` ids it classifies compaction tombstones against); keep it cheap.
   */
  onMeasurementChecked?: (checked: number, row: BackupMeasurement) => void;
}

export async function readStreamedBackup(
  source: BackupSource,
  options: ReadStreamedBackupOptions = {},
): Promise<StreamedBackup> {
  const schema = await loadMeasurementSchema();
  let firstWithoutId: number | null = null;
  let bytes = 0;
  const keys = new BackupKeyIdCollector();
  // Every streamed section but the measurements, as `raw` keeps it.
  const kept = new Map<string, unknown[]>();
  async function* counted() {
    for await (const chunk of source()) {
      bytes += chunk.byteLength;
      yield chunk;
    }
  }
  const { document, streamedCounts } = await scanBackupJson(counted(), {
    streamKeys: BACKUP_STREAM_KEYS,
    onElement: (key, element, index) => {
      if (key === MEASUREMENTS) {
        const row = parseMeasurement(schema, element, index);
        if (!row.id && firstWithoutId === null) firstWithoutId = index;
        keys.visit(element, MEASUREMENTS);
        options.onMeasurementChecked?.(index + 1, row);
        return;
      }
      let section = kept.get(key);
      if (!section) kept.set(key, (section = []));
      section.push(
        key === DOCUMENTS ? withoutContent(element, index, keys) : element,
      );
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

  // A section the file carries holds what was kept of it (an empty one kept
  // nothing); one it does not carry stays absent.
  for (const [key, elements] of kept) document[key] = elements;
  keys.visit(document);

  const skipKeys = new Set(
    Object.keys(document).filter((key) => key !== MEASUREMENTS),
  );
  const documentSkipKeys = new Set(
    Object.keys(document).filter((key) => key !== DOCUMENTS),
  );

  return {
    raw: document,
    measurementCount: streamedCounts[MEASUREMENTS] ?? 0,
    bytes,
    keys,
    async forEachMeasurementBatch(size, fn) {
      let batch: BackupMeasurement[] = [];
      await scanBackupJson(source(), {
        streamKeys: MEASUREMENTS_ONLY,
        skipKeys,
        onElement: async (_key, element, index) => {
          batch.push(parseMeasurement(schema, element, index));
          if (batch.length >= size) {
            const full = batch;
            batch = [];
            await fn(full);
          }
        },
      });
      if (batch.length > 0) await fn(batch);
    },
    async forEachDocumentContent(fn) {
      await scanBackupJson(source(), {
        streamKeys: DOCUMENTS_ONLY,
        skipKeys: documentSkipKeys,
        onElement: async (_key, element, index) => {
          const content = (element as { contentEncrypted?: unknown })
            ?.contentEncrypted;
          await fn(typeof content === "string" ? content : undefined, index);
        },
      });
    },
  };
}

/**
 * A document as `raw` keeps it: its stored bytes replaced by
 * `DOCUMENT_CONTENT_LEFT_OUT`, after the key they were written under is
 * recorded and their form is checked, since the whole-file schema only sees
 * the stand-in.
 */
function withoutContent(
  element: unknown,
  index: number,
  keys: BackupKeyIdCollector,
): unknown {
  if (!element || typeof element !== "object") return element;
  const { contentEncrypted, ...rest } = element as Record<string, unknown>;
  if (typeof contentEncrypted !== "string") return element;
  if (contentEncrypted.length % 4 !== 0 || !BASE64.test(contentEncrypted)) {
    throw new StreamedBackupInvalidError(
      `${DOCUMENTS}.${index}.contentEncrypted`,
      "Expected base64-encoded encrypted bytes",
    );
  }
  keys.add(DOCUMENTS, contentEncrypted, "contentEncrypted");
  return { ...rest, contentEncrypted: DOCUMENT_CONTENT_LEFT_OUT };
}
