/**
 * v1.42 (#615) — pair guard binding the two environment models in
 * `prisma/schema.prisma` to the backup that carries them
 * (`src/lib/export/environment-backup.ts`), on the pattern of
 * `measurement-backup-completeness.test.ts`.
 *
 * Twenty-two air-quality columns and three sealed locations arrived in one
 * release, and nothing failed when a column was missing from the backup: the
 * export kept building, the restore kept parsing (the section schema is
 * `.passthrough()`), and the column came back NULL on every restored day. So
 * both ends are compared as literals:
 *
 *   - every scalar column of `EnvironmentContext` and
 *     `EnvironmentTravelLocation` is in the named backup select (or excluded
 *     here with a reason);
 *   - every selected `EnvironmentContext` column is written by the export
 *     (`row.<column>`, or the location helper for the location columns);
 *   - every selected column is written back by the restore (`<column>:` in
 *     `restoreEnvironmentData`, or listed in `AIR_QUALITY_COLUMNS`, which the
 *     restore maps over).
 *
 * Mutation check: delete `pm25Mean: true` from the context select and the
 * first case names it; delete `"pm25Mean",` from `AIR_QUALITY_COLUMNS` and the
 * restore case names it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
const source = readFileSync(
  join(ROOT, "src", "lib", "export", "environment-backup.ts"),
  "utf8",
);

/** Columns the backup is right to leave out, with the reason. */
const EXCLUDED: Record<string, string> = {
  id: "nothing in the file or the database addresses one of these rows; a day is identified by its date",
  userId:
    "user-scoped backup; the owner is re-derived from the restoring account",
};

/** Columns written through the location helper rather than `row.<column>`. */
const LOCATION_COLUMNS = new Set([
  "lat",
  "lon",
  "locationLabel",
  "label",
  "locationEncrypted",
]);

function block(text: string, start: string, end = "\n}"): string {
  const from = text.indexOf(start);
  expect(from, `${start} not found`).toBeGreaterThan(-1);
  const to = text.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

function scalarColumns(model: string): string[] {
  const models = new Set(
    [...schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)].map((m) => m[1]),
  );
  const out: string[] = [];
  for (const raw of block(schema, `model ${model} {`).split("\n").slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
    const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?/.exec(line);
    if (!m || m[3] || models.has(m[2]) || line.includes("@relation")) continue;
    out.push(m[1]);
  }
  return out;
}

function selectKeys(name: string): string[] {
  return [
    ...block(source, `const ${name} = {`).matchAll(/^ {2}(\w+): true,$/gm),
  ].map((m) => m[1]);
}

const restoreBody = block(
  source,
  "export async function restoreEnvironmentData(",
  "\n}\n",
);
const airQualityList = block(source, "const AIR_QUALITY_COLUMNS = [", "]");

describe.each([
  ["EnvironmentContext", "ENVIRONMENT_CONTEXT_BACKUP_SELECT"],
  ["EnvironmentTravelLocation", "ENVIRONMENT_TRAVEL_LOCATION_BACKUP_SELECT"],
])("%s backup completeness", (model, selectName) => {
  const columns = scalarColumns(model);
  const selected = selectKeys(selectName);

  it("parses both ends into a plausible shape", () => {
    expect(columns.length).toBeGreaterThan(8);
    expect(columns).toContain("locationEncrypted");
    expect(selected.length).toBeGreaterThan(5);
  });

  it("the backup select covers every column", () => {
    const missing = columns.filter(
      (c) => !selected.includes(c) && !(c in EXCLUDED),
    );
    expect(
      missing,
      `${selectName} omits these ${model} columns; a restore brings them back NULL`,
    ).toEqual([]);
  });

  it("the restore writes every selected column back", () => {
    const unwritten = selected.filter(
      (c) =>
        !new RegExp(`\\b${c}:`).test(restoreBody) &&
        !airQualityList.includes(`"${c}"`) &&
        // The day key and the source are written under their own names.
        !["date", "startDate", "endDate"].includes(c),
    );
    expect(unwritten, "selected but never restored").toEqual([]);
  });
});

describe("EnvironmentContext export", () => {
  it("writes every selected column into the entry", () => {
    const selected = selectKeys("ENVIRONMENT_CONTEXT_BACKUP_SELECT");
    const unwritten = selected.filter(
      (c) =>
        !LOCATION_COLUMNS.has(c) && !new RegExp(`row\\.${c}\\b`).test(source),
    );
    expect(unwritten, "selected but never exported").toEqual([]);
  });

  it("covers all twenty-two air-quality columns and the sealed location", () => {
    const selected = selectKeys("ENVIRONMENT_CONTEXT_BACKUP_SELECT");
    for (const column of [
      "apparentMax",
      "pm25Mean",
      "o3Max8h",
      "pollenRagweedMax",
      "aqDomain",
      "aqHours",
      "aqFetchedAt",
      "locationEncrypted",
    ]) {
      expect(selected, column).toContain(column);
    }
  });

  it("carries no stale exclusion", () => {
    const all = new Set([
      ...scalarColumns("EnvironmentContext"),
      ...scalarColumns("EnvironmentTravelLocation"),
    ]);
    for (const [column, reason] of Object.entries(EXCLUDED)) {
      expect(all.has(column), column).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
