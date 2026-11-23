/**
 * v1.32.36 — pair guard binding `prisma/schema.prisma`'s `Measurement` model to
 * the disaster-recovery backup select.
 *
 * The failure it exists to catch: a column is added to the model in one release
 * and the backup select is "the follow-up". Nothing fails — the backup keeps
 * building, the restore keeps parsing (the payload schema is `.passthrough()`),
 * and the column simply comes back NULL on every restored row. That is how the
 * aggregation provenance was silently dropped from every disaster-recovery
 * backup between the release that added it and the one that noticed.
 *
 * Both ends of this comparison are literals — a Prisma model block and a named
 * select object — so the matcher is exact. No grep heuristics, no fuzzy name
 * matching, nothing that can quietly over-accept. That soundness is the reason
 * this guard is worth having as a gate while the broader "does any column have
 * a reader" question is only worth a release-battery script.
 *
 * Scoped to `Measurement` on purpose. Extend it model by model as each becomes
 * backup-relevant; converting every model at once buys exclusion-list churn
 * rather than safety.
 *
 * Both backup ends of the measurements live in the measurements domain
 * (`src/lib/export/measurements-backup.ts` out, `measurements-restore.ts`
 * back), so the guard checks the restore half too: every carried column is
 * written back by `toRestoredMeasurementData`.
 *
 * Mutation check: comment out `sleepStage: true` in `MEASUREMENT_BACKUP_SELECT`
 * and this goes red naming that column; add a scalar to the model without
 * adding it to the select and it goes red naming the new one; drop a key from
 * `toRestoredMeasurementData` and the restore case goes red naming it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { readSource } from "./helpers/source-files";

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const BACKUP_MODULE = "src/lib/export/measurements-backup.ts";
const RESTORE_MODULE = "src/lib/export/measurements-restore.ts";
const PROFILE_BACKUP_BUILDER = join(
  ROOT,
  "src",
  "lib",
  "export",
  "profile-backup.ts",
);

/**
 * Columns the backup is correct to omit, each with the reason.
 *  - `userId`: the backup is user-scoped. The owner is implicit in the query
 *    and re-derived from the restoring account; carrying it would let a
 *    payload claim a different owner.
 */
const EXCLUDED_COLUMNS: Record<string, string> = {
  userId: "user-scoped backup; owner is re-derived from the restoring account",
};

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

/** Names of every `model` / `type` block, so relation fields can be told apart. */
function declaredModels(schema: string): Set<string> {
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)) {
    out.add(m[1]);
  }
  return out;
}

/**
 * Scalar (column-backed) fields of a model block: everything that is not a
 * relation to another model. Enums and native scalars both map to columns and
 * therefore both belong in a backup.
 */
function scalarFields(block: string, models: Set<string>): string[] {
  const fields: string[] = [];
  for (const rawLine of block.split("\n").slice(1)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
    if (!m) continue;
    const [, name, type, isList] = m;
    if (isList) continue;
    if (models.has(type)) continue;
    if (line.includes("@relation")) continue;
    fields.push(name);
  }
  return fields;
}

/** Keys of the named `MEASUREMENT_BACKUP_SELECT` literal. */
function selectFields(source: string): string[] {
  const start = source.indexOf("const MEASUREMENT_BACKUP_SELECT = {");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^ {2}([a-zA-Z_$][\w$]*): true,$/gm)].map(
    (m) => m[1],
  );
}

/** The text of one top-level function, from its declaration to its end. */
function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Fields either serialization arm actually emits. The two arms share one
 * restorable wire format, so this is a union and therefore a weaker claim than
 * the select comparison: it catches a column that is selected and then written
 * to neither payload, not a column carried by only one arm. Read from the
 * serialiser alone, because the restore beside it spells its rows the same
 * way and would answer for a column the export dropped.
 */
function serialisedFields(source: string): Set<string> {
  const body = functionBody(source, "function serialiseMeasurement(");
  return new Set(
    [...body.matchAll(/([a-zA-Z_$][\w$]*):\s+measurement\./g)].map((m) => m[1]),
  );
}

/** Keys the restore writes for each row, the same file's other half. */
function restoredFields(source: string): Set<string> {
  const body = functionBody(source, "function toRestoredMeasurementData(");
  return new Set(
    [
      ...body.matchAll(
        /^ {4}(?:\.\.\.\(measurement\.([a-zA-Z_$][\w$]*)|([a-zA-Z_$][\w$]*):)/gm,
      ),
    ].map((m) => m[1] ?? m[2]),
  );
}

/**
 * Selected columns the per-row restore data does not write, with the reason.
 * `id` is written beside it, from the file's id, by the batch insert.
 */
const RESTORED_ELSEWHERE: Record<string, string> = {
  id: "written beside the row data by the batch insert, from the file's own id",
};

function interfaceFields(source: string, name: string): Set<string> {
  const start = source.indexOf(`export interface ${name} {`);
  expect(start, `interface ${name} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return new Set(
    [...source.slice(start, end).matchAll(/^ {2}([a-zA-Z_$][\w$]*)[?:]/gm)].map(
      (match) => match[1],
    ),
  );
}

function emittedModelFields(source: string, variable: string): Set<string> {
  return new Set(
    [
      ...source.matchAll(new RegExp(`${variable}\\.([a-zA-Z_$][\\w$]*)`, "g")),
    ].map((match) => match[1]),
  );
}

describe("measurement backup completeness", () => {
  const schema = readFileSync(SCHEMA, "utf8");
  const source = readSource(BACKUP_MODULE, [
    "const MEASUREMENT_BACKUP_SELECT = {",
    "function serialiseMeasurement(",
  ]);
  const restoreSource = readSource(RESTORE_MODULE, [
    "function toRestoredMeasurementData(",
  ]);
  const models = declaredModels(schema);
  const columns = scalarFields(modelBlock(schema, "Measurement"), models);
  const selected = selectFields(source);

  it("parses both ends into a plausible shape", () => {
    expect(models.size).toBeGreaterThan(50);
    expect(columns.length).toBeGreaterThan(15);
    expect(columns).toContain("aggregationProvenance");
    expect(columns).not.toContain("user");
    expect(columns).not.toContain("ecgRecordings");
    expect(selected.length).toBeGreaterThan(15);
  });

  it("the backup select covers every Measurement column", () => {
    const missing = columns.filter(
      (c) => !selected.includes(c) && !(c in EXCLUDED_COLUMNS),
    );

    if (missing.length > 0) {
      const report = missing.map((c) => `  ❌ ${c}`).join("\n");
      throw new Error(
        `MEASUREMENT_BACKUP_SELECT omits ${missing.length} column(s) of the Measurement model:\n${report}\n\n` +
          "A disaster-recovery restore brings these back NULL. Add each to the " +
          "select and to both serialization arms, extend the backup validation " +
          "schema and the restore create — or add it to EXCLUDED_COLUMNS with " +
          "the reason the backup is correct to drop it.",
      );
    }
  });

  it("every selected column reaches a serialized payload", () => {
    const emitted = serialisedFields(source);
    const dropped = selected.filter((c) => !emitted.has(c));
    expect(
      dropped,
      `selected but serialized by neither arm: ${dropped}`,
    ).toHaveLength(0);
  });

  it("the restore writes every carried column back", () => {
    const restored = restoredFields(restoreSource);
    expect(restored.size).toBeGreaterThan(15);
    const unwritten = selected.filter(
      (c) => !restored.has(c) && !(c in RESTORED_ELSEWHERE),
    );
    expect(
      unwritten,
      `carried in the file but never written back: ${unwritten}`,
    ).toEqual([]);
  });

  it("the exclusion list carries no stale entry", () => {
    for (const [column, reason] of Object.entries(EXCLUDED_COLUMNS)) {
      expect(
        columns,
        `${column} is excluded but is no longer a Measurement column`,
      ).toContain(column);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

describe("health profile backup completeness", () => {
  const schema = readFileSync(SCHEMA, "utf8");
  const source = readFileSync(PROFILE_BACKUP_BUILDER, "utf8");
  const models = declaredModels(schema);
  // `aboutMeRevisedAt` is the about-me lock token (migration 0554): a restore
  // creates the row afresh and the token starts there, so carrying one would
  // hand the restored account a token nobody read.
  const excluded = new Set(["userId", "aboutMeRevisedAt"]);

  it.each([
    ["UserHealthProfile", "HealthProfileBackupEntry", "profileRow"],
    ["HealthProfileFactRevision", "HealthProfileFactBackupEntry", "fact"],
  ])(
    "%s columns are represented and emitted by the profile backup",
    (model, wireInterface, variable) => {
      const columns = scalarFields(modelBlock(schema, model), models).filter(
        (column) => !excluded.has(column),
      );
      const wire = interfaceFields(source, wireInterface);
      const emitted = emittedModelFields(source, variable);

      expect(
        columns.filter((column) => !wire.has(column)),
        `${wireInterface} omits stored ${model} columns`,
      ).toEqual([]);
      expect(
        columns.filter((column) => !emitted.has(column)),
        `${model} columns never reach either serialized arm`,
      ).toEqual([]);
    },
  );
});
