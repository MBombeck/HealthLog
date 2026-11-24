/**
 * A small synthetic Gadgetbridge database, built with `node:sqlite` in the
 * shape greenDAO writes: a DEVICE table, one activity sample table in
 * seconds, one in milliseconds (the Xiaomi family), SpO2, resting heart
 * rate, a sleep table, a weight table and one table the importer does not
 * read. Every value is invented.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/** 2026-03-02T08:00:00Z and the hour after it, in seconds. */
export const GB_T0 = Date.UTC(2026, 2, 2, 8, 0, 0) / 1000;

export function buildGadgetbridgeFixture(
  options: { extraSteps?: number; heartRateSentinels?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "gb-fixture-"));
  const path = join(dir, "Gadgetbridge");
  const { DatabaseSync: Database } = process.getBuiltinModule(
    "node:sqlite",
  ) as typeof import("node:sqlite");
  const db: DatabaseSync = new Database(path);
  db.exec(`
    CREATE TABLE DEVICE (_id INTEGER PRIMARY KEY, NAME TEXT, MANUFACTURER TEXT, IDENTIFIER TEXT);
    INSERT INTO DEVICE VALUES (1, 'Band', 'Vendor', 'AA:BB'), (2, 'Watch', 'Vendor', 'CC:DD');
    CREATE TABLE MI_BAND_ACTIVITY_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, RAW_INTENSITY INTEGER, STEPS INTEGER, RAW_KIND INTEGER, HEART_RATE INTEGER, PRIMARY KEY (TIMESTAMP, DEVICE_ID));
    CREATE TABLE XIAOMI_ACTIVITY_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, STEPS INTEGER, HEART_RATE INTEGER, PRIMARY KEY (TIMESTAMP, DEVICE_ID));
    CREATE TABLE HUAMI_SPO2_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, TYPE_NUM INTEGER, SPO2 INTEGER);
    CREATE TABLE HUAMI_HEART_RATE_RESTING_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, HEART_RATE INTEGER);
    CREATE TABLE XIAOMI_SLEEP_TIME_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, WAKEUP_TIME INTEGER, IS_AWAKE INTEGER, TOTAL_DURATION INTEGER);
    CREATE TABLE MI_SCALE_WEIGHT_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, WEIGHT_KG REAL);
    CREATE TABLE HUAMI_STRESS_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, STRESS INTEGER);
    CREATE TABLE EMPTY_ACTIVITY_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, STEPS INTEGER);
  `);
  const band = db.prepare(
    "INSERT INTO MI_BAND_ACTIVITY_SAMPLE VALUES (?, 1, 1, 10, ?, 1, ?)",
  );
  // Sixty minutes of 100 steps; heart rate 70 with one "no reading" (255).
  for (let m = 0; m < 60; m += 1) {
    band.run(
      GB_T0 + m * 60,
      100 + (m === 0 ? (options.extraSteps ?? 0) : 0),
      m === 5 ? 255 : 70,
    );
  }
  // The second device that day, in milliseconds, with fewer steps.
  const watch = db.prepare(
    "INSERT INTO XIAOMI_ACTIVITY_SAMPLE VALUES (?, 2, 1, ?, ?)",
  );
  for (let m = 0; m < 30; m += 1) {
    watch.run((GB_T0 + m * 60) * 1000, 50, 0);
  }
  db.prepare("INSERT INTO HUAMI_SPO2_SAMPLE VALUES (?, 1, 1, 0, 97)").run(
    GB_T0,
  );
  db.prepare("INSERT INTO HUAMI_SPO2_SAMPLE VALUES (?, 1, 1, 0, 0)").run(
    GB_T0 + 60,
  );
  db.prepare(
    "INSERT INTO HUAMI_HEART_RATE_RESTING_SAMPLE VALUES (?, 1, 1, 58)",
  ).run(GB_T0);
  // A night: 23:00 to 07:00, in milliseconds.
  db.prepare(
    "INSERT INTO XIAOMI_SLEEP_TIME_SAMPLE VALUES (?, 2, 1, ?, 0, 480)",
  ).run((GB_T0 - 9 * 3600) * 1000, (GB_T0 - 3600) * 1000);
  db.prepare("INSERT INTO MI_SCALE_WEIGHT_SAMPLE VALUES (?, 1, 1, 72.4)").run(
    GB_T0,
  );
  db.prepare("INSERT INTO HUAMI_STRESS_SAMPLE VALUES (?, 1, 1, 40)").run(GB_T0);
  if (options.heartRateSentinels) {
    // Spot and resting readings beside the "no reading" values 255 and 1.
    db.exec(
      "CREATE TABLE HUAMI_HEART_RATE_MANUAL_SAMPLE (TIMESTAMP INTEGER, DEVICE_ID INTEGER, USER_ID INTEGER, HEART_RATE INTEGER)",
    );
    const manual = db.prepare(
      "INSERT INTO HUAMI_HEART_RATE_MANUAL_SAMPLE VALUES (?, 1, 1, ?)",
    );
    manual.run(GB_T0, 72);
    manual.run(GB_T0 + 60, 255);
    manual.run(GB_T0 + 120, 1);
    const resting = db.prepare(
      "INSERT INTO HUAMI_HEART_RATE_RESTING_SAMPLE VALUES (?, 1, 1, ?)",
    );
    resting.run(GB_T0 + 60, 255);
  }
  db.close();
  return path;
}
