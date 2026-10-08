/**
 * Opening an uploaded Health Connect database. The file is untrusted input:
 * a version the importer cannot read, a view standing in for a record table
 * and a file that is not a Health Connect database at all are refused before
 * a row is read; a schema that drifted (a missing column, an extra table) is
 * read as far as it goes, and a database last written in WAL mode opens in a
 * directory the importer cannot write to.
 */
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { buildHealthConnectFixture } from "../../../../../tests/fixtures/health-connect/build-fixture";
import {
  HealthConnectImportError,
  hcInt,
  hcUuid,
  openHealthConnectDb,
} from "../reader";

const dirs: string[] = [];
function fixture(
  options: Parameters<typeof buildHealthConnectFixture>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "hc-reader-"));
  dirs.push(dir);
  const path = join(dir, "health_connect_export.db");
  buildHealthConnectFixture(path, options);
  return { dir, path };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // gone already
    }
  }
});

function refusal(fn: () => unknown): HealthConnectImportError {
  try {
    fn();
  } catch (err) {
    if (err instanceof HealthConnectImportError) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("openHealthConnectDb", () => {
  it("opens the fixture read-only and finds its tables by name", () => {
    const { path } = fixture();
    const hc = openHealthConnectDb(path);
    try {
      expect(hc.userVersion).toBe(20);
      expect(hc.warnings).toEqual([]);
      expect(hc.usable("weight_record_table", ["uuid", "time", "weight"])).toBe(
        true,
      );
      expect(hc.columns("weight_record_table")?.has("weight")).toBe(true);
      // query_only: the importer cannot write to the upload even by mistake.
      expect(() => hc.all("DELETE FROM weight_record_table")).toThrow();
    } finally {
      hc.close();
    }
  });

  it("refuses a database older than schema version 9", () => {
    const { path } = fixture({ userVersion: 8 });
    expect(refusal(() => openHealthConnectDb(path)).code).toBe(
      "unsupported_version",
    );
  });

  it("reads a newer schema version than it knows, with a warning", () => {
    const { path } = fixture({ userVersion: 31 });
    const hc = openHealthConnectDb(path);
    expect(hc.warnings).toContain("user_version_newer:31");
    hc.close();
  });

  it("refuses a view standing in for a record table", () => {
    const { path } = fixture();
    const db = new DatabaseSync(path);
    db.exec(
      "DROP TABLE weight_record_table; CREATE VIEW weight_record_table AS SELECT 1 AS uuid, 2 AS time, 3 AS weight, 4 AS app_info_id",
    );
    db.close();
    const err = refusal(() => openHealthConnectDb(path));
    expect(err.code).toBe("unsafe_schema");
    expect(err.message).toContain("weight_record_table is a view");
  });

  it("skips a table whose required column is missing and keeps the rest", () => {
    const { path } = fixture();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE body_fat_record_table DROP COLUMN percentage");
    db.exec(
      "CREATE TABLE some_future_record_table (row_id INTEGER, uuid BLOB)",
    );
    db.close();
    const hc = openHealthConnectDb(path);
    try {
      expect(hc.usable("body_fat_record_table", ["uuid", "percentage"])).toBe(
        false,
      );
      expect(hc.usable("weight_record_table", ["uuid", "weight"])).toBe(true);
      expect(hc.warnings).toEqual([
        "column_missing:body_fat_record_table.percentage",
      ]);
    } finally {
      hc.close();
    }
  });

  it("refuses a database without the application table", () => {
    const { path } = fixture();
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys = OFF; DROP TABLE application_info_table");
    db.close();
    expect(refusal(() => openHealthConnectDb(path)).code).toBe(
      "not_health_connect",
    );
  });

  it("refuses a file that is not a SQLite database", () => {
    const dir = mkdtempSync(join(tmpdir(), "hc-reader-"));
    const path = join(dir, "health_connect_export.db");
    writeFileSync(path, "PK this is not a database");
    expect(refusal(() => openHealthConnectDb(path)).code).toBe(
      "not_health_connect",
    );
  });

  it("opens a WAL-mode database in a read-only directory and leaves no companion files", () => {
    const { dir, path } = fixture({ wal: true });
    const ro = join(dir, "ro");
    mkdirSync(ro);
    copyFileSync(path, join(ro, "health_connect_export.db"));
    chmodSync(ro, 0o555);
    const hc = openHealthConnectDb(join(ro, "health_connect_export.db"));
    try {
      const [row] = hc.all("SELECT COUNT(*) AS n FROM weight_record_table");
      expect(Number(row.n)).toBeGreaterThan(0);
    } finally {
      hc.close();
    }
    expect(readdirSync(ro)).toEqual(["health_connect_export.db"]);
  });

  it("hands rows out in batches of at most the batch size", () => {
    const { path } = fixture({ days: 3 });
    const hc = openHealthConnectDb(path);
    try {
      const sizes = [
        ...hc.batches("SELECT * FROM steps_record_table", [], 40),
      ].map((b) => b.length);
      expect(sizes.every((n) => n <= 40)).toBe(true);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(3 * 16 * 2);
    } finally {
      hc.close();
    }
  });
});

describe("column helpers", () => {
  it("reads an enum stored in a TEXT column as its number", () => {
    expect(hcInt("3")).toBe(3);
    expect(hcInt(3)).toBe(3);
    expect(hcInt("left arm")).toBeNull();
    expect(hcInt(2.5)).toBeNull();
  });

  it("spells a 16-byte blob as an 8-4-4-4-12 UUID", () => {
    const blob = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    expect(hcUuid(new Uint8Array(blob))).toBe(
      "01234567-89ab-cdef-0123-456789abcdef",
    );
    expect(hcUuid(new Uint8Array(15))).toBeNull();
    expect(hcUuid("01234567")).toBeNull();
  });
});
