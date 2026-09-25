/**
 * Insert many measurements in one statement, as column arrays.
 *
 * Why not `createMany`. Prisma compiles and caches a query plan per query
 * shape, and a `createMany` of N rows is its own shape: measured, one
 * 1 000-row `createMany` of measurements leaves about 145 MB of retained
 * heap behind, a 2 000-row one about 290 MB, and the smaller last batch of a
 * restore adds its own plan on top. In a 1 GB container that alone took a
 * restore of 1.25 million measurements past the heap limit (#1031). One
 * `INSERT … SELECT FROM unnest(…)` with an array per column is a single small
 * statement whatever the batch size, and about four times faster.
 *
 * `COLUMNS` maps every field of `MeasurementInsertRow` to its column and
 * type. It is typed as a complete record over the row's keys, so a field
 * added to the row without a column here does not compile, and the restore
 * builds its rows as `MeasurementInsertRow`, so a field it starts writing has
 * to be added to the row first.
 */
import type { Prisma } from "@/generated/prisma/client";

/** One measurement as the restore writes it. */
export interface MeasurementInsertRow {
  id: string;
  userId: string;
  type: string;
  value: number;
  valueMin: number | null;
  valueMax: number | null;
  unit: string;
  source: string;
  measuredAt: Date;
  notes: string | null;
  notesEncrypted: Uint8Array | null;
  externalId: string | null;
  externalSourceVersion: string | null;
  aggregationProvenance: string | null;
  glucoseContext: string | null;
  sleepStage: string | null;
  rhythmClassification: string | null;
  deviceType: string | null;
  syncVersion: number;
  deletedAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type Kind =
  "text" | "float8" | "int4" | "timestamp" | "bytea" | `enum:${string}`;

/** Column and element type per field. Complete by construction. */
const COLUMNS: { [K in keyof MeasurementInsertRow]-?: [string, Kind] } = {
  id: ["id", "text"],
  userId: ["user_id", "text"],
  type: ["type", "enum:measurement_type"],
  value: ["value", "float8"],
  valueMin: ["value_min", "float8"],
  valueMax: ["value_max", "float8"],
  unit: ["unit", "text"],
  source: ["source", "enum:measurement_source"],
  measuredAt: ["measured_at", "timestamp"],
  notes: ["notes", "text"],
  notesEncrypted: ["notes_encrypted", "bytea"],
  externalId: ["external_id", "text"],
  externalSourceVersion: ["external_source_version", "text"],
  aggregationProvenance: [
    "aggregation_provenance",
    "enum:measurement_aggregation_provenance",
  ],
  glucoseContext: ["glucose_context", "enum:glucose_context"],
  sleepStage: ["sleep_stage", "enum:sleep_stage"],
  rhythmClassification: ["rhythm_classification", "enum:rhythm_classification"],
  deviceType: ["device_type", "text"],
  syncVersion: ["sync_version", "int4"],
  deletedAt: ["deleted_at", "timestamp"],
  createdAt: ["created_at", "timestamp"],
  updatedAt: ["updated_at", "timestamp"],
};

const FIELDS = Object.keys(COLUMNS) as Array<keyof MeasurementInsertRow>;

/** How each array travels, and how its element is turned back into a value. */
function arrayType(kind: Kind): string {
  if (kind === "float8" || kind === "int4") return `${kind}[]`;
  return "text[]"; // timestamps as ISO text, bytes as hex, enums as labels
}

function selectExpression(
  field: keyof MeasurementInsertRow,
  kind: Kind,
): string {
  const ref = `u."${field}"`;
  if (kind === "timestamp") {
    // Stored as UTC in `timestamp(3)`. ISO text with a `Z` casts to the same
    // wall-clock instant; the zone suffix is ignored by the cast.
    const cast = `${ref}::timestamp(3)`;
    // Prisma fills both on create when the row does not carry them.
    return field === "createdAt" || field === "updatedAt"
      ? `COALESCE(${cast}, CURRENT_TIMESTAMP)`
      : cast;
  }
  if (kind === "bytea") return `decode(${ref}, 'hex')`;
  if (kind.startsWith("enum:")) return `${ref}::${kind.slice(5)}`;
  return ref;
}

/**
 * The statement, built once. Its text depends on nothing but `COLUMNS`, a
 * compile-time table: no input reaches it, and every value travels as a bound
 * array parameter.
 */
export const MEASUREMENT_BULK_INSERT_SQL = `
  INSERT INTO measurements (${FIELDS.map((f) => COLUMNS[f][0]).join(", ")})
  SELECT ${FIELDS.map((f) => selectExpression(f, COLUMNS[f][1])).join(", ")}
  FROM unnest(${FIELDS.map((f, i) => `$${i + 1}::${arrayType(COLUMNS[f][1])}`).join(", ")})
    AS u(${FIELDS.map((f) => `"${f}"`).join(", ")})
`;

function cell(value: unknown, kind: Kind): unknown {
  if (value === null || value === undefined) return null;
  if (kind === "timestamp") return (value as Date).toISOString();
  if (kind === "bytea") return Buffer.from(value as Uint8Array).toString("hex");
  return value;
}

/** Insert `rows` in one statement. Resolves to the number inserted. */
export async function insertMeasurementRows(
  tx: Prisma.TransactionClient,
  rows: readonly MeasurementInsertRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const arrays = FIELDS.map((field) => {
    const kind = COLUMNS[field][1];
    return rows.map((row) => cell(row[field], kind));
  });
  return tx.$executeRawUnsafe(MEASUREMENT_BULK_INSERT_SQL, ...arrays);
}
