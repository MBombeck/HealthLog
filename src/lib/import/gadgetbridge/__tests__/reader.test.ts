import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RecordFileImportError } from "@/lib/import/file-import/kinds";

import { openGadgetbridgeDb } from "../reader";
import { buildGadgetbridgeFixture } from "./fixture";

const made: string[] = [];
afterEach(() => {
  for (const path of made.splice(0)) {
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

function fixture() {
  const path = buildGadgetbridgeFixture();
  made.push(path);
  return path;
}

describe("openGadgetbridgeDb", () => {
  it("classifies the sample tables by name and columns", () => {
    const db = openGadgetbridgeDb(fixture());
    try {
      const kinds = Object.fromEntries(
        db.tables.map((t) => [t.name, [t.kind, t.millis]]),
      );
      expect(kinds).toEqual({
        MI_BAND_ACTIVITY_SAMPLE: ["activity", false],
        XIAOMI_ACTIVITY_SAMPLE: ["activity", true],
        HUAMI_SPO2_SAMPLE: ["spo2", false],
        HUAMI_HEART_RATE_RESTING_SAMPLE: ["restingHeartRate", false],
        XIAOMI_SLEEP_TIME_SAMPLE: ["sleep", true],
        MI_SCALE_WEIGHT_SAMPLE: ["weight", false],
      });
      // A table with rows the importer does not read is named, with its rows;
      // an empty one and the bookkeeping tables are not.
      expect(db.unread).toEqual([{ name: "HUAMI_STRESS_SAMPLE", rows: 1 }]);
    } finally {
      db.close();
    }
  });

  it("refuses a file that is not a Gadgetbridge database", () => {
    const path = join(dirname(fixture()), "not-a-db");
    writeFileSync(path, "hello");
    expect(() => openGadgetbridgeDb(path)).toThrow(RecordFileImportError);
  });

  it("refuses a view in place of a sample table", () => {
    const path = fixture();
    const { DatabaseSync } = process.getBuiltinModule(
      "node:sqlite",
    ) as typeof import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE VIEW FAKE_ACTIVITY_SAMPLE AS SELECT TIMESTAMP, STEPS FROM MI_BAND_ACTIVITY_SAMPLE",
    );
    db.close();
    expect(() => openGadgetbridgeDb(path)).toThrow(/unsafe_schema/);
  });
});
