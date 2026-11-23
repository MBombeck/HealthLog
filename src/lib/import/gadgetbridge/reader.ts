/**
 * Read-only access to a Gadgetbridge database export (Gadgetbridge → Data
 * management → Export database: one SQLite file named `Gadgetbridge`).
 *
 * The file is the uploader's and is opened as untrusted input, with the same
 * posture as the Health Connect reader (`../health-connect/reader.ts`):
 * `immutable=1`, `trusted_schema=OFF`, `query_only`, no memory map, and any
 * name the importer reads must be a real table, never a view.
 *
 * Gadgetbridge's schema is generated per device family and grows with every
 * release (greenDAO, one `*_SAMPLE` table per device and kind), so nothing
 * here names a fixed list of tables. The reader classifies what the file
 * holds by the table's name shape and its columns, found by name:
 *
 *   - activity samples: `*_ACTIVITY_SAMPLE` with `TIMESTAMP` and `STEPS`
 *     (`HEART_RATE` read when present);
 *   - oxygen saturation: `*_SPO2_SAMPLE` with `TIMESTAMP` and `SPO2`;
 *   - resting heart rate: `*HEART_RATE_RESTING*` with `HEART_RATE`;
 *   - spot heart rate: `*HEART_RATE_MANUAL*` with `HEART_RATE`;
 *   - sleep sessions: `*SLEEP*` with `TIMESTAMP` and `WAKEUP_TIME`;
 *   - weight: `*WEIGHT*` with `TIMESTAMP` and `WEIGHT_KG`.
 *
 * Every other table with rows is reported as skipped, by name, so the person
 * can see what the file held that HealthLog did not read.
 *
 * The file is read on its own thread (`../sqlite-off-thread.ts`): counting a
 * table, or grouping a year of minute samples by hour, is one synchronous
 * SQLite call that took seconds on a file at the upload cap, and the import
 * worker shares its process with the web server by default.
 */
import type { SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { RecordFileImportError } from "@/lib/import/file-import/kinds";
import {
  openSqliteOffThread,
  type OffThreadSqlite,
} from "@/lib/import/sqlite-off-thread";

export const GB_BATCH_SIZE = 1000;

export type GbTableKind =
  | "activity"
  | "spo2"
  | "restingHeartRate"
  | "spotHeartRate"
  | "sleep"
  | "weight";

export interface GbTable {
  name: string;
  kind: GbTableKind;
  columns: ReadonlySet<string>;
  /** `TIMESTAMP` is in milliseconds rather than seconds. */
  millis: boolean;
}

export interface GadgetbridgeDb {
  readonly tables: readonly GbTable[];
  /** Tables with rows the importer does not read, with their row counts. */
  readonly unread: ReadonlyArray<{ name: string; rows: number }>;
  batches(
    sql: string,
    params?: readonly SQLInputValue[],
    size?: number,
  ): AsyncGenerator<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

/** A schema name the importer may splice: greenDAO's upper snake case. */
const SAFE_NAME = /^[A-Z][A-Z0-9_]{0,80}$/;

/** Bookkeeping tables of greenDAO and Android; never health data. */
const IGNORED = new Set([
  "android_metadata",
  "sqlite_sequence",
  "DEVICE",
  "DEVICE_ATTRIBUTES",
  "USER",
  "USER_ATTRIBUTES",
  "ALARM",
  "REMINDER",
  "WORLD_CLOCK",
  "NOTIFICATION_FILTER",
  "NOTIFICATION_FILTER_ENTRY",
  "CALENDAR_SYNC_STATE",
  "AUDIO_RECORDING",
  "APP_SPECIFIC_NOTIFICATION_SETTING",
  "CONTACT",
  "TAG",
  "ACTIVITY_DESCRIPTION",
  "ACTIVITY_DESC_TAG_LINK",
  "BATTERY_LEVEL",
]);

function classify(
  name: string,
  columns: ReadonlySet<string>,
): GbTableKind | null {
  const has = (...c: string[]) => c.every((x) => columns.has(x));
  if (!has("TIMESTAMP")) return null;
  if (name.endsWith("_ACTIVITY_SAMPLE") && has("STEPS")) return "activity";
  if (name.endsWith("_SPO2_SAMPLE") && has("SPO2")) return "spo2";
  if (name.includes("HEART_RATE_RESTING") && has("HEART_RATE")) {
    return "restingHeartRate";
  }
  if (name.includes("HEART_RATE_MANUAL") && has("HEART_RATE")) {
    return "spotHeartRate";
  }
  if (name.includes("SLEEP") && has("WAKEUP_TIME")) return "sleep";
  if (name.includes("WEIGHT") && has("WEIGHT_KG")) return "weight";
  return null;
}

/**
 * Open `path` read-only and check that it is a Gadgetbridge database. Throws
 * {@link RecordFileImportError} when it is not; the database is closed again
 * in that case.
 */
export async function openGadgetbridgeDb(
  path: string,
): Promise<GadgetbridgeDb> {
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  let db: OffThreadSqlite;
  try {
    db = await openSqliteOffThread(
      url,
      "PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA cell_size_check = ON; PRAGMA mmap_size = 0;",
    );
  } catch {
    throw new RecordFileImportError(
      "not_gadgetbridge",
      "the file could not be opened as a database",
    );
  }
  try {
    return await inspect(db);
  } catch (err) {
    await db.close();
    if (err instanceof RecordFileImportError) throw err;
    throw new RecordFileImportError(
      "not_gadgetbridge",
      "the file is not a readable database",
    );
  }
}

async function inspect(db: OffThreadSqlite): Promise<GadgetbridgeDb> {
  const schema = (await db.all(
    "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view')",
  )) as Array<{ type: string; name: string }>;
  const names = new Map(schema.map((row) => [row.name, row.type]));
  if (names.get("DEVICE") !== "table") {
    throw new RecordFileImportError(
      "not_gadgetbridge",
      "the database has no DEVICE table",
    );
  }

  const tables: GbTable[] = [];
  const unread: Array<{ name: string; rows: number }> = [];
  for (const [name, type] of names) {
    if (IGNORED.has(name) || name.startsWith("sqlite_")) continue;
    if (!SAFE_NAME.test(name)) continue;
    const columns = new Set(
      (
        (await db.all(`PRAGMA table_info("${name}")`)) as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    const kind = classify(name, columns);
    if (kind && type !== "table") {
      // A view under a sample table's name would run the file's own query in
      // place of the one written here.
      throw new RecordFileImportError(
        "unsafe_schema",
        `${name} is a ${type}, not a table`,
      );
    }
    if (type !== "table") continue;
    // `name` matched SAFE_NAME, so it can be quoted into the statement.
    const count = Number(
      (await db.get(`SELECT COUNT(*) AS n FROM "${name}"`))?.n,
    );
    if (count === 0) continue;
    if (!kind) {
      unread.push({ name, rows: count });
      continue;
    }
    const max = Number(
      (await db.get(`SELECT MAX(TIMESTAMP) AS t FROM "${name}"`))?.t,
    );
    tables.push({ name, kind, columns, millis: max > 100_000_000_000 });
  }

  return {
    tables,
    unread,
    batches: (sql, params = [], size = GB_BATCH_SIZE) =>
      db.batches(sql, params, size),
    close: () => db.close(),
  };
}

/** A finite number from a SQLite value, or null. */
export function gbNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  return null;
}
