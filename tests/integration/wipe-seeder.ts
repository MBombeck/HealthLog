/**
 * Schema-driven seeding + counting for the two wipe integration guards.
 *
 * The whole defect class here is about rows that SURVIVE, so a mocked Prisma
 * proves nothing: it can only show that the calls a route makes were made.
 * Both guards therefore seed a row into every table in the schema, run their
 * wipe against real Postgres, and then ask the database what is left.
 *
 * The seeding is driven by `information_schema` and `pg_constraint` rather
 * than a hand-written fixture, for the same reason the wipe list is derived
 * rather than hand-written: a fixture written today covers the schema of
 * today. A table added next year is seeded automatically and therefore
 * asserted automatically.
 *
 * It lives here rather than in either test file because the account wipe and
 * the admin wipe have to be measured with the same ruler. Two copies would
 * drift, and the copy that drifted would be the one whose route was wrong.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrismaClient } from "@/generated/prisma/client";
import { WIPE_OWNER_FIELDS } from "@/lib/data-wipe/wipe-plan";

// ── schema.prisma model → table name ────────────────────────────────────────

export function modelTableMap(): Map<string, string> {
  const schema = readFileSync(
    join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  );
  const map = new Map<string, string>();
  for (const block of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(block[2]);
    map.set(block[1], mapped ? mapped[1] : block[1]);
  }
  return map;
}

// ── generic seeder ──────────────────────────────────────────────────────────

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_nullable: string;
  column_default: string | null;
  udt_name: string;
}

interface ForeignKeyRow {
  table_name: string;
  column_name: string;
  ref_table: string;
  ref_column: string;
  cascades: boolean;
}

/** Tables the seeder never writes: Prisma's own ledger, and the account row. */
const SEED_SKIP = new Set(["_prisma_migrations", "users"]);

function synthesise(udt: string, enums: Map<string, string>, tag: string) {
  if (udt.startsWith("_")) return `'{}'::${udt.slice(1)}[]`;
  switch (udt) {
    case "text":
    case "varchar":
    case "bpchar":
      return `'${tag}'`;
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return "1";
    case "bool":
      return "false";
    case "timestamp":
    case "timestamptz":
    case "date":
      return "now()";
    case "bytea":
      return "'\\x00'::bytea";
    case "json":
    case "jsonb":
      return `'{}'::${udt}`;
    case "uuid":
      return "gen_random_uuid()";
    default: {
      const label = enums.get(udt);
      if (label) return `'${label}'::"${udt}"`;
      throw new Error(`seeder has no value for column type "${udt}"`);
    }
  }
}

/**
 * Insert one row into every table in `public`, parents first, wiring every
 * foreign key to the row already created for its target and every `user_id` to
 * the account under test.
 */
export async function seedEveryTable(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const columns = await prisma.$queryRaw<ColumnRow[]>`
    SELECT table_name, column_name, is_nullable, column_default, udt_name
    FROM information_schema.columns
    WHERE table_schema = 'public'`;

  const foreignKeys = await prisma.$queryRaw<ForeignKeyRow[]>`
    SELECT con.conrelid::regclass::text  AS table_name,
           att.attname                   AS column_name,
           con.confrelid::regclass::text AS ref_table,
           ratt.attname                  AS ref_column,
           con.confdeltype = 'c'         AS cascades
    FROM pg_constraint con
    JOIN LATERAL unnest(con.conkey)  WITH ORDINALITY AS ck(attnum, ord) ON true
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord)
      ON rk.ord = ck.ord
    JOIN pg_attribute att  ON att.attrelid  = con.conrelid  AND att.attnum = ck.attnum
    JOIN pg_attribute ratt ON ratt.attrelid = con.confrelid AND ratt.attnum = rk.attnum
    WHERE con.contype = 'f' AND con.connamespace = 'public'::regnamespace`;

  const enumRows = await prisma.$queryRaw<
    Array<{ typname: string; enumlabel: string }>
  >`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    ORDER BY t.typname, e.enumsortorder`;
  const enums = new Map<string, string>();
  for (const row of enumRows) {
    if (!enums.has(row.typname)) enums.set(row.typname, row.enumlabel);
  }

  // A column fenced by a single-column `CHECK (col IN (...))` takes the first
  // value the fence admits; a synthesised tag would be refused before the wipe
  // ever ran. Postgres stores the IN list as `col = ANY (ARRAY['a'::text, ...])`.
  const checkRows = await prisma.$queryRaw<
    Array<{ table_name: string; column_name: string; def: string }>
  >`
    SELECT con.conrelid::regclass::text AS table_name,
           att.attname                  AS column_name,
           pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'c'
      AND con.connamespace = 'public'::regnamespace
      AND cardinality(con.conkey) = 1`;
  // A day-key column is fenced by `CHECK (col ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`
  // (`<table>_<column>_day_key_shape`) and takes a calendar day.
  const DAY_KEY_FENCE = "~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'";
  const admitted = new Map<string, string>();
  for (const row of checkRows) {
    const key = `${row.table_name}.${row.column_name}`;
    const first = /=\s*ANY\s*\(\s*\(?ARRAY\['((?:[^']|'')*)'/.exec(row.def);
    if (first) admitted.set(key, first[1]);
    else if (row.def.includes(DAY_KEY_FENCE)) admitted.set(key, "2026-01-01");
  }

  const byTable = new Map<string, ColumnRow[]>();
  for (const column of columns) {
    if (SEED_SKIP.has(column.table_name)) continue;
    const bucket = byTable.get(column.table_name) ?? [];
    bucket.push(column);
    byTable.set(column.table_name, bucket);
  }

  const fkByTable = new Map<string, ForeignKeyRow[]>();
  for (const fk of foreignKeys) {
    const bucket = fkByTable.get(fk.table_name) ?? [];
    bucket.push(fk);
    fkByTable.set(fk.table_name, bucket);
  }

  // Parents before children. A self-reference or an optional cycle is skipped
  // by only ordering on the columns the insert actually fills.
  const pending = new Set(byTable.keys());
  const ordered: string[] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const table of [...pending]) {
      const blocked = (fkByTable.get(table) ?? []).some(
        (fk) => fk.ref_table !== table && pending.has(fk.ref_table),
      );
      if (blocked) continue;
      ordered.push(table);
      pending.delete(table);
      progressed = true;
    }
    if (!progressed) {
      throw new Error(
        `foreign-key cycle among: ${[...pending].sort().join(", ")}`,
      );
    }
  }

  const insertedId = new Map<string, string>();
  let tag = 0;

  for (const table of ordered) {
    const tableColumns = byTable.get(table)!;
    const fks = fkByTable.get(table) ?? [];
    const names: string[] = [];
    const values: string[] = [];

    for (const column of tableColumns) {
      const fk = fks.find((f) => f.column_name === column.column_name);
      const required =
        column.is_nullable === "NO" && column.column_default === null;
      const isUserColumn = column.column_name === "user_id";

      if (fk?.ref_table === "users") {
        // Always bind to the account under test, nullable or not — a NULL
        // owner would put the row outside the wipe and make the assertion
        // vacuous.
        names.push(column.column_name);
        values.push(`'${userId}'`);
        continue;
      }
      if (!required && !isUserColumn) continue;
      if (fk) {
        const parent = insertedId.get(fk.ref_table);
        if (!parent) {
          throw new Error(
            `${table}.${column.column_name} references ${fk.ref_table}, which was not seeded`,
          );
        }
        names.push(column.column_name);
        values.push(`'${parent}'`);
        continue;
      }
      names.push(column.column_name);
      const fenced = admitted.get(`${table}.${column.column_name}`);
      values.push(
        fenced !== undefined
          ? `'${fenced}'`
          : synthesise(column.udt_name, enums, `seed-${tag++}`),
      );
    }

    const sql =
      names.length === 0
        ? `INSERT INTO "${table}" DEFAULT VALUES ON CONFLICT DO NOTHING`
        : `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${values.join(", ")}) ON CONFLICT DO NOTHING`;
    await prisma.$executeRawUnsafe(sql);

    const hasId = tableColumns.some((c) => c.column_name === "id");
    if (hasId) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "${table}" LIMIT 1`,
      );
      if (rows[0]) insertedId.set(table, rows[0].id);
    }
  }

  return ordered;
}

/**
 * The columns that bind a row of `model` to an account, as SQL identifiers.
 *
 * `user_id` is the convention. A model that relates two accounts cannot use
 * it, and the wipe plan already declares its columns — read them from there
 * rather than keeping a second list here, or the two would answer differently
 * and this file would be asserting against its own idea of ownership instead
 * of the one the route uses.
 */
export function ownerColumns(model: string | undefined): string[] {
  const declared = model ? WIPE_OWNER_FIELDS[model] : undefined;
  if (!declared) return ["user_id"];
  return declared.map((field) =>
    field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
  );
}

export async function countRows(
  prisma: PrismaClient,
  table: string,
  userId?: string,
  model?: string,
): Promise<number> {
  const predicate = ownerColumns(model)
    .map((column) => `"${column}" = $1`)
    .join(" OR ");
  const rows = userId
    ? await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}" WHERE ${predicate}`,
        userId,
      )
    : await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}"`,
      );
  return Number(rows[0].n);
}
