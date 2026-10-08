/**
 * Read-only access to a Health Connect export database
 * (`health_connect_export.db`, the file the Android Health Connect app copies
 * into its export ZIP).
 *
 * The file comes from an upload, so it is opened as untrusted input:
 *
 *   - `immutable=1` in the URI. The export is a byte copy of the live
 *     database, and a database last written in WAL mode refuses a plain
 *     read-only open in a directory it cannot create the `-wal` / `-shm`
 *     companions in. Immutable tells SQLite the file cannot change, so it
 *     neither looks for nor creates them, and takes no locks.
 *   - `trusted_schema=OFF`, so a view, trigger or generated column in a
 *     crafted file cannot call a function with side effects; `query_only`,
 *     `cell_size_check` and no memory map on top.
 *   - Every table the importer reads must be a real table. A view under a
 *     record table's name is refused outright rather than read: it would
 *     let the file run its own query in place of the one written here.
 *   - Columns are found by name (`PRAGMA table_info`), never by position.
 *     The platform adds columns with `ALTER TABLE` as its schema version
 *     moves, so their order differs between devices.
 *   - `PRAGMA user_version` below 9 (the first version with 16-byte UUID
 *     blobs) is refused; above 27 (the newest the AOSP source defines) is
 *     read with a warning, because new versions have so far only added
 *     columns and tables.
 *
 * Nothing here holds a whole table in memory. Statements are walked with
 * `iterate()` and handed out in batches; the aggregations (daily sums, hourly
 * means) run inside SQLite.
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

/** First schema version with 16-byte UUID blobs (`DatabaseVersions.MIN_SUPPORTED`). */
export const HC_MIN_USER_VERSION = 9;
/** Newest schema version the AOSP source defines at the time of writing. */
export const HC_MAX_KNOWN_USER_VERSION = 27;

/** Rows handed out per batch. */
export const HC_BATCH_SIZE = 500;

/** Machine-readable reasons an export is refused before anything is read. */
export type HealthConnectRefusal =
  "unsupported_version" | "not_health_connect" | "unsafe_schema";

/** A refusal the worker turns into the job's failure reason. */
export class HealthConnectImportError extends Error {
  readonly code: HealthConnectRefusal;

  constructor(code: HealthConnectRefusal, message: string) {
    super(`${code}: ${message}`);
    this.name = "HealthConnectImportError";
    this.code = code;
  }
}

/** The tables the importer reads. Anything else in the file is ignored. */
export const HC_TABLES = [
  "application_info_table",
  "device_info_table",
  "health_data_category_priority_table",
  "weight_record_table",
  "body_fat_record_table",
  "lean_body_mass_record_table",
  "blood_pressure_record_table",
  "resting_heart_rate_record_table",
  "heart_rate_variability_rmssd_record_table",
  "oxygen_saturation_record_table",
  "respiratory_rate_record_table",
  "blood_glucose_record_table",
  "body_temperature_record_table",
  "vo2_max_record_table",
  "steps_record_table",
  "active_calories_burned_record_table",
  "distance_record_table",
  "hydration_record_table",
  "nutrition_record_table",
  "heart_rate_record_table",
  "heart_rate_record_series_table",
  "sleep_session_record_table",
  "sleep_stages_table",
  "exercise_session_record_table",
  "menstruation_flow_record_table",
  "menstruation_period_record_table",
] as const;

export type HcTable = (typeof HC_TABLES)[number];

/** One row as `node:sqlite` returns it. */
export type HcRow = Record<string, unknown>;

/** An opened export. */
export interface HealthConnectDb {
  readonly userVersion: number;
  /** Codes for what the importer could not read; never row content. */
  readonly warnings: string[];
  /**
   * The columns of `table` when it is present, `null` when it is not. A
   * missing table is ordinary (an app that never wrote that type), so it is
   * not a warning.
   */
  columns(table: HcTable): ReadonlySet<string> | null;
  /**
   * Whether `table` is present with every column in `required`. A table that
   * is present but lacks one is noted in `warnings` once and treated as
   * absent, so a schema drift skips that type instead of failing the import.
   */
  usable(table: HcTable, required: readonly string[]): boolean;
  /** Every row of `sql`, in batches of at most `size`. */
  batches(
    sql: string,
    params?: readonly SQLInputValue[],
    size?: number,
  ): Generator<HcRow[]>;
  /** Every row of `sql` at once. For small, bounded results only. */
  all(sql: string, params?: readonly SQLInputValue[]): HcRow[];
  close(): void;
}

/**
 * Open `path` read-only and check that it is a Health Connect export this
 * importer can read. Throws {@link HealthConnectImportError} when it is not;
 * the database is closed again in that case.
 */
export function openHealthConnectDb(path: string): HealthConnectDb {
  const url = pathToFileURL(path);
  url.searchParams.set("immutable", "1");
  let db: DatabaseSync;
  try {
    // Loaded on first use rather than at import: the routes that share this
    // module graph (upload, status) never open a database, and `node:sqlite`
    // prints an experimental-feature warning the moment it loads.
    const { DatabaseSync: Database } = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    db = new Database(url, { readOnly: true });
  } catch (err) {
    throw new HealthConnectImportError(
      "not_health_connect",
      `the export database could not be opened (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  try {
    // Before the first statement reads the schema.
    db.exec(
      "PRAGMA trusted_schema = OFF; PRAGMA query_only = ON; PRAGMA cell_size_check = ON; PRAGMA mmap_size = 0;",
    );
    return inspect(db);
  } catch (err) {
    db.close();
    if (err instanceof HealthConnectImportError) throw err;
    throw new HealthConnectImportError(
      "not_health_connect",
      `the export database could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

function inspect(db: DatabaseSync): HealthConnectDb {
  const versionRow = db.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  const userVersion = Number(versionRow?.user_version ?? 0);
  if (!Number.isSafeInteger(userVersion) || userVersion < HC_MIN_USER_VERSION) {
    throw new HealthConnectImportError(
      "unsupported_version",
      `database version ${userVersion} is older than ${HC_MIN_USER_VERSION}`,
    );
  }
  const warnings: string[] = [];
  if (userVersion > HC_MAX_KNOWN_USER_VERSION) {
    warnings.push(`user_version_newer:${userVersion}`);
  }

  // What each name the importer reads actually is in this file.
  const kinds = new Map<string, string>();
  const names = new Set<string>(HC_TABLES);
  for (const row of db
    .prepare(
      "SELECT type, name FROM sqlite_schema WHERE type IN ('table', 'view')",
    )
    .all() as Array<{ type: string; name: string }>) {
    if (names.has(row.name)) kinds.set(row.name, row.type);
  }
  for (const [name, type] of kinds) {
    if (type !== "table") {
      throw new HealthConnectImportError(
        "unsafe_schema",
        `${name} is a ${type}, not a table`,
      );
    }
  }
  if (!kinds.has("application_info_table")) {
    throw new HealthConnectImportError(
      "not_health_connect",
      "the database has no application_info_table",
    );
  }

  const columnCache = new Map<string, ReadonlySet<string>>();
  const columns = (table: HcTable): ReadonlySet<string> | null => {
    if (!kinds.has(table)) return null;
    const cached = columnCache.get(table);
    if (cached) return cached;
    // `table` is one of the closed HC_TABLES names, never input.
    const set = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    columnCache.set(table, set);
    return set;
  };

  const appInfo = columns("application_info_table");
  if (!appInfo?.has("row_id") || !appInfo.has("package_name")) {
    throw new HealthConnectImportError(
      "not_health_connect",
      "application_info_table lacks row_id or package_name",
    );
  }

  const warned = new Set<string>();
  const usable = (table: HcTable, required: readonly string[]): boolean => {
    const cols = columns(table);
    if (!cols) return false;
    const missing = required.filter((c) => !cols.has(c));
    if (missing.length === 0) return true;
    for (const column of missing) {
      const code = `column_missing:${table}.${column}`;
      if (!warned.has(code)) {
        warned.add(code);
        warnings.push(code);
      }
    }
    return false;
  };

  return {
    userVersion,
    warnings,
    columns,
    usable,
    *batches(sql, params = [], size = HC_BATCH_SIZE) {
      let batch: HcRow[] = [];
      for (const row of db.prepare(sql).iterate(...params)) {
        batch.push(row as HcRow);
        if (batch.length >= size) {
          yield batch;
          batch = [];
        }
      }
      if (batch.length > 0) yield batch;
    },
    all(sql, params = []) {
      return db.prepare(sql).all(...params) as HcRow[];
    },
    close() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

/** The 8-4-4-4-12 string of a 16-byte UUID blob, or null for anything else. */
export function hcUuid(value: unknown): string | null {
  if (!(value instanceof Uint8Array) || value.length !== 16) return null;
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A number from a column Health Connect declares as an enum. Several of them
 * are TEXT columns the platform writes integers into, so SQLite hands back
 * `'3'` rather than `3`; both read as 3. Anything that is not an integer
 * reads as null.
 */
export function hcInt(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

/** A finite number, or null. */
export function hcNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
