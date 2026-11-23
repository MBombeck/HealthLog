/**
 * Pair guard binding `prisma/schema.prisma`'s `Medication` model to the
 * medication backup and its restore (#1430).
 *
 * The class it closes: a medication column is added, the write routes and the
 * reads carry it, and the backup is "the follow-up". Nothing fails: the export
 * keeps building, the restore keeps parsing, and the column comes back NULL on
 * every restored medication. The saved leaflet link is the latest column; the
 * note (#1371) before it was carried only because its change remembered to.
 *
 * Both ends are literal code: the model block, the drug's own serialiser
 * (`serialiseMedicationRow`, every `m.<column>` it reads) and the restore's
 * row builder (`medicationRowData`, every key it writes). A column that is in
 * neither, and not in the exclusion lists below with its reason, fails here
 * by name.
 *
 * Mutation check: drop `leafletUrl: m.leafletUrl` from the serialiser, or
 * `leafletUrl:` from the restore, and the matching case goes red naming it;
 * add a scalar to the model and both go red until it is carried or excluded.
 */
import { describe, expect, it } from "vitest";

import { readSource } from "./helpers/source-files";

const SCHEMA = "prisma/schema.prisma";
const BACKUP_MODULE = "src/lib/export/medications-backup.ts";
const RESTORE_MODULE = "src/lib/export/medications-restore.ts";

/** Columns the file is right not to carry, each with the reason. */
const NOT_SERIALISED: Record<string, string> = {
  userId:
    "user-scoped backup; the owner is re-derived from the restoring account",
  endedAt:
    "the projection of the courses' own `endedAt`, which the file carries per course; the restore re-projects it (`projectCourseWindow`)",
};

/** Columns the row builder is right not to write, each with the reason. */
const NOT_RESTORED_BY_ROW: Record<string, string> = {
  id: "written beside the row data from the file's own id (disaster recovery) or minted fresh (portable)",
  endedAt:
    "re-projected from the restored courses by the course pass right after the row is created",
  createdAt:
    "written beside the row data by `restoredMedicationCreatedAt`, which falls back to the earliest dose for an older file",
  updatedAt:
    "written beside the row data from the file's own stamp when it carries one",
};

function modelBlock(schema: string, model: string): string {
  const start = schema.indexOf(`model ${model} {`);
  expect(start, `model ${model} not found`).toBeGreaterThan(-1);
  const end = schema.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return schema.slice(start, end);
}

function declaredModels(schema: string): Set<string> {
  return new Set(
    [...schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)].map((m) => m[1]),
  );
}

/** Column-backed fields of a model block: everything but relations. */
function scalarFields(block: string, models: Set<string>): string[] {
  const fields: string[] = [];
  for (const rawLine of block.split("\n").slice(1)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
    if (!m) continue;
    const [, name, type] = m;
    if (models.has(type) || line.includes("@relation")) continue;
    fields.push(name);
  }
  return fields;
}

function functionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  expect(start, `${declaration} not found`).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("medication backup completeness", () => {
  const schema = readSource(SCHEMA, ["model Medication {"]);
  const columns = scalarFields(
    modelBlock(schema, "Medication"),
    declaredModels(schema),
  );
  const serialiser = functionBody(
    readSource(BACKUP_MODULE, ["function serialiseMedicationRow("]),
    "function serialiseMedicationRow(",
  );
  const rowBuilder = functionBody(
    readSource(RESTORE_MODULE, ["function medicationRowData("]),
    "function medicationRowData(",
  );
  const serialised = new Set(
    [...serialiser.matchAll(/\bm\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]),
  );
  const restored = new Set(
    [...rowBuilder.matchAll(/^ {4}([a-zA-Z_$][\w$]*):/gm)].map((m) => m[1]),
  );

  it("parses all three ends into a plausible shape", () => {
    expect(columns.length).toBeGreaterThan(25);
    expect(columns).toContain("leafletUrl");
    expect(columns).toContain("noteEncrypted");
    expect(columns).not.toContain("schedules");
    expect(serialised.size).toBeGreaterThan(25);
    expect(restored.size).toBeGreaterThan(25);
  });

  it("the backup carries every Medication column", () => {
    const missing = columns.filter(
      (c) => !serialised.has(c) && !(c in NOT_SERIALISED),
    );
    expect(
      missing,
      "Medication columns the backup never reads. Carry each in serialiseMedicationRow (and the backup schema and the restore), or add it to NOT_SERIALISED with the reason.",
    ).toEqual([]);
  });

  it("the restore writes every Medication column back", () => {
    const missing = columns.filter(
      (c) => !restored.has(c) && !(c in NOT_RESTORED_BY_ROW),
    );
    expect(
      missing,
      "Medication columns the restore never writes. Write each in medicationRowData, or add it to NOT_RESTORED_BY_ROW with the reason.",
    ).toEqual([]);
  });

  it("the exclusion lists carry no stale entry", () => {
    for (const [column, reason] of [
      ...Object.entries(NOT_SERIALISED),
      ...Object.entries(NOT_RESTORED_BY_ROW),
    ]) {
      expect(columns, `${column} is no longer a Medication column`).toContain(
        column,
      );
      expect(reason.length).toBeGreaterThan(20);
    }
    for (const column of Object.keys(NOT_SERIALISED)) {
      expect(
        serialised.has(column),
        `${column} is excluded but serialised`,
      ).toBe(false);
    }
  });
});
