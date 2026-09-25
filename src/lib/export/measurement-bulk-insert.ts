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
 * The Apple Health export import writes its spot rows through the same
 * statement (`insertNewMeasurementRows`), for the same reason. There the cost
 * was per call rather than per shape: every `createManyAndReturn` of a
 * 650-row flush left about 5 MB behind until roughly two dozen calls had
 * accumulated, so a 300 000-record import settled at about 53 MB of retained
 * heap and a run of back-to-back flushes reached well over 100 MB. Through
 * this statement the same import holds a few megabytes.
 *
 * `COLUMNS` maps every field of `MeasurementInsertRow` to its column and
 * type. It is typed as a complete record over the row's keys, so a field
 * added to the row without a column here does not compile, and the restore
 * builds its rows as `MeasurementInsertRow`, so a field it starts writing has
 * to be added to the row first.
 */
import { randomInt } from "node:crypto";
import { hostname } from "node:os";

import type {
  MeasurementType,
  Prisma,
  PrismaClient,
} from "@/generated/prisma/client";

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

/**
 * The same statement, skipping any row that collides with an existing one on
 * either unique identity, and answering with the rows it did insert.
 *
 * `ON CONFLICT DO NOTHING` with no target is what Prisma emits for
 * `createMany({ skipDuplicates: true })`: a row that meets either
 * `(user_id, type, source, external_id)` or
 * `(user_id, type, measured_at, source, sleep_stage)` is left out, a row that
 * meets another row of the same statement is left out after the first, and
 * nothing throws for either.
 */
export const MEASUREMENT_BULK_INSERT_SKIP_DUPLICATES_SQL = `${MEASUREMENT_BULK_INSERT_SQL}
  ON CONFLICT DO NOTHING
  RETURNING id, type::text AS "type", measured_at AS "measuredAt", external_id AS "externalId"
`;

/** One row `insertNewMeasurementRows` wrote. */
export interface InsertedMeasurementRow {
  id: string;
  type: MeasurementType;
  measuredAt: Date;
  externalId: string | null;
}

/** A row for {@link insertNewMeasurementRows}: the id and the defaults are filled in. */
export type NewMeasurementRow = Omit<
  MeasurementInsertRow,
  | "id"
  | "valueMin"
  | "valueMax"
  | "notes"
  | "notesEncrypted"
  | "aggregationProvenance"
  | "glucoseContext"
  | "rhythmClassification"
  | "syncVersion"
  | "deletedAt"
  | "createdAt"
  | "updatedAt"
> &
  Partial<
    Pick<
      MeasurementInsertRow,
      | "valueMin"
      | "valueMax"
      | "notesEncrypted"
      | "aggregationProvenance"
      | "glucoseContext"
      | "rhythmClassification"
    >
  >;

/**
 * Insert brand-new rows in one statement, skipping duplicates, and return the
 * rows that landed. The replacement for
 * `measurement.createManyAndReturn({ data, skipDuplicates: true })`.
 *
 * Every column the schema defaults is written with that default: a fresh
 * cuid-shaped id, `sync_version` 1, not deleted, created and updated at the
 * moment of the call, and null for every optional column the row does not
 * carry.
 */
export async function insertNewMeasurementRows(
  db: Pick<PrismaClient, "$queryRawUnsafe"> | Prisma.TransactionClient,
  rows: readonly NewMeasurementRow[],
): Promise<InsertedMeasurementRow[]> {
  if (rows.length === 0) return [];
  // Stamped here, as the Prisma client stamps `@default(now())` and
  // `@updatedAt`, rather than left to the database clock.
  const now = new Date();
  const full: MeasurementInsertRow[] = rows.map((row) => ({
    id: newMeasurementId(),
    userId: row.userId,
    type: row.type,
    value: row.value,
    valueMin: row.valueMin ?? null,
    valueMax: row.valueMax ?? null,
    unit: row.unit,
    source: row.source,
    measuredAt: row.measuredAt,
    notes: null,
    notesEncrypted: row.notesEncrypted ?? null,
    externalId: row.externalId,
    externalSourceVersion: row.externalSourceVersion,
    aggregationProvenance: row.aggregationProvenance ?? null,
    glucoseContext: row.glucoseContext ?? null,
    sleepStage: row.sleepStage,
    rhythmClassification: row.rhythmClassification ?? null,
    deviceType: row.deviceType,
    syncVersion: 1,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  const arrays = FIELDS.map((field) => {
    const kind = COLUMNS[field][1];
    return full.map((row) => cell(row[field], kind));
  });
  return db.$queryRawUnsafe<InsertedMeasurementRow[]>(
    MEASUREMENT_BULK_INSERT_SKIP_DUPLICATES_SQL,
    ...arrays,
  );
}

// ── Ids ──────────────────────────────────────────────────────────────────
//
// Prisma mints `@default(cuid())` in the client, so a row written around the
// client needs one minted here. Same shape as Prisma's own (cuid v1): `c`, the
// time in base 36, a rolling counter, a host fingerprint, and eight random
// characters, 25 characters in all. Ids stay roughly time-ordered, which the
// list reads rely on only as a tiebreaker.

const BLOCK = 4;
const BLOCK_SPACE = 36 ** BLOCK;
let counter = randomInt(BLOCK_SPACE);

function block(n: number): string {
  return n.toString(36).padStart(BLOCK, "0").slice(-BLOCK);
}

const FINGERPRINT = (() => {
  const host = hostname();
  let sum = host.length + 36;
  for (let i = 0; i < host.length; i++) sum += host.charCodeAt(i);
  return (
    (process.pid % 1296).toString(36).padStart(2, "0") +
    (sum % 1296).toString(36).padStart(2, "0")
  );
})();

/** A fresh id in the shape Prisma's `cuid()` default produces. */
export function newMeasurementId(): string {
  counter = (counter + 1) % BLOCK_SPACE;
  return (
    "c" +
    Date.now().toString(36).padStart(8, "0") +
    block(counter) +
    FINGERPRINT +
    block(randomInt(BLOCK_SPACE)) +
    block(randomInt(BLOCK_SPACE))
  );
}
