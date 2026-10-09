/**
 * Synthetic Health Connect export database for the importer's tests.
 *
 * The schema (`schema.sql`) is reconstructed from the AOSP HealthFitness
 * module: the tables the Health Connect app copies into
 * `health_connect_export.db`, with the column names, units and the TEXT enum
 * columns as the platform writes them. No real export is checked in; every
 * test builds the file it needs, a few days by default, a year or more for the
 * memory measurement.
 *
 * What the data deliberately contains, so the mapping can be checked against
 * it:
 *   - weight from a scale app that has its own HealthLog integration
 *     (`com.withings.wiscale2`) and from the Health Connect app itself;
 *   - blood pressure with the location and body position stored as TEXT;
 *   - steps, active energy and distance from two apps on the same day, with a
 *     priority list that names one of them;
 *   - a heart-rate series, one sample per minute, inside and outside the
 *     90-day raw window;
 *   - sleep sessions with stages, one with only "unknown" stages, one with no
 *     stages at all, and stages of type "out of bed";
 *   - an exercise session, menstruation flow and a period, hydration and a
 *     meal with micronutrients.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { crc32, deflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const FIXTURE_SCHEMA_PATH = fileURLToPath(
  new URL("./schema.sql", import.meta.url),
);

/** Application rows the fixture writes. */
export const FIXTURE_APPS = {
  withings: { id: 1, pkg: "com.withings.wiscale2", name: "Withings" },
  fitbit: { id: 2, pkg: "com.fitbit.FitbitMobile", name: "Fitbit" },
  samsung: {
    id: 3,
    pkg: "com.sec.android.app.shealth",
    name: "Samsung Health",
  },
  hc: {
    id: 4,
    pkg: "com.google.android.apps.healthdata",
    name: "Health Connect",
  },
} as const;

export interface FixtureOptions {
  /** Days of data, counted back from `endUtc`. Default 4. */
  days?: number;
  /** Midnight UTC of the day after the last fixture day. Default: today. */
  endUtc?: number;
  /** Zone offset of every record, in seconds. Default 7200 (CEST). */
  zoneOffsetSec?: number;
  /** `PRAGMA user_version`. Default 20. */
  userVersion?: number;
  /** Heart-rate samples per hour (one per minute by default). */
  hrSamplesPerHour?: number;
  /** Write the database in WAL mode. */
  wal?: boolean;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A name-based UUID blob, stable across runs for the same inputs. */
export function stableUuidBlob(seed: string): Buffer {
  const h = createHash("md5").update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x30;
  h[8] = (h[8] & 0x3f) | 0x80;
  return h;
}

/**
 * Write a fixture database to `path` and answer the instants it used. Record
 * UUIDs are name-based (stable), so two files built with the same options
 * describe the same records, which is what a re-import test needs.
 */
export function buildHealthConnectFixture(
  path: string,
  options: FixtureOptions = {},
): { startUtc: number; endUtc: number; days: number } {
  const days = options.days ?? 4;
  const endUtc =
    options.endUtc ?? Math.floor(Date.now() / DAY) * DAY; /* today 00:00Z */
  const startUtc = endUtc - days * DAY;
  const off = options.zoneOffsetSec ?? 7200;
  const perHour = options.hrSamplesPerHour ?? 60;
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(readFileSync(FIXTURE_SCHEMA_PATH, "utf8"));
  db.exec(`PRAGMA user_version = ${options.userVersion ?? 20}`);
  if (options.wal) db.exec("PRAGMA journal_mode = WAL");

  const epochDay = (ms: number) => Math.floor((ms + off * 1000) / DAY);
  const id = (table: string, key: string) => stableUuidBlob(`${table}|${key}`);

  const apps = Object.values(FIXTURE_APPS);
  const app = db.prepare(
    "INSERT INTO application_info_table(row_id, package_name, app_name) VALUES (?, ?, ?)",
  );
  for (const a of apps) app.run(a.id, a.pkg, a.name);
  db.exec(`INSERT INTO device_info_table(row_id, manufacturer, model, device_type) VALUES
    (1, 'Withings', 'Body+', 3), (2, 'Google', 'Pixel Watch', 1), (3, 'Samsung', 'Galaxy', 2)`);
  // ACTIVITY (1): Samsung first, then Fitbit. SLEEP (5) and VITALS (6): Fitbit first.
  db.exec(`INSERT INTO health_data_category_priority_table(health_data_category, app_id_priority_order)
    VALUES (1, '3,2'), (5, '2,3'), (6, '2,3')`);

  const instant = (table: string, cols: string[]) =>
    db.prepare(
      `INSERT INTO ${table}(uuid, last_modified_time, device_info_id, app_info_id, recording_method, time, zone_offset, local_date, ${cols.join(", ")}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${cols.map(() => "?").join(", ")})`,
    );
  const interval = (table: string, cols: string[]) =>
    db.prepare(
      `INSERT INTO ${table}(uuid, last_modified_time, device_info_id, app_info_id, recording_method, start_time, start_zone_offset, end_time, end_zone_offset, local_date${cols.length ? ", " + cols.join(", ") : ""}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?${cols.map(() => ", ?").join("")})`,
    );

  const weight = instant("weight_record_table", ["weight"]);
  const fat = instant("body_fat_record_table", ["percentage"]);
  const lean = instant("lean_body_mass_record_table", ["mass"]);
  const bp = instant("blood_pressure_record_table", [
    "measurement_location",
    "systolic",
    "diastolic",
    "body_position",
  ]);
  const rhr = instant("resting_heart_rate_record_table", ["beats_per_minute"]);
  const hrv = instant("heart_rate_variability_rmssd_record_table", [
    "heart_rate_variability_millis",
  ]);
  const spo2 = instant("oxygen_saturation_record_table", ["percentage"]);
  const resp = instant("respiratory_rate_record_table", ["rate"]);
  const glucose = instant("blood_glucose_record_table", [
    "specimen_source",
    "level",
    "relation_to_meal",
    "meal_type",
  ]);
  const temp = instant("body_temperature_record_table", [
    "measurement_location",
    "temperature",
  ]);
  const vo2 = instant("vo2_max_record_table", [
    "measurement_method",
    "vo2_milliliters_per_minute_kilogram",
  ]);
  const flow = instant("menstruation_flow_record_table", ["flow"]);
  const steps = interval("steps_record_table", ["count"]);
  const energy = interval("active_calories_burned_record_table", ["energy"]);
  const distance = interval("distance_record_table", ["distance"]);
  const hydration = interval("hydration_record_table", ["volume"]);
  const nutrition = interval("nutrition_record_table", [
    "energy",
    "protein",
    "vitamin_c",
    "vitamin_d",
    "magnesium",
    "caffeine",
  ]);
  const period = interval("menstruation_period_record_table", []);
  const hrParent = interval("heart_rate_record_table", []);
  const hrSample = db.prepare(
    "INSERT INTO heart_rate_record_series_table(parent_key, beats_per_minute, epoch_millis) VALUES (?, ?, ?)",
  );
  const sleep = interval("sleep_session_record_table", []);
  const stage = db.prepare(
    "INSERT INTO sleep_stages_table(parent_key, stage_start_time, stage_end_time, stage_type) VALUES (?, ?, ?, ?)",
  );
  const exercise = interval("exercise_session_record_table", [
    "exercise_type",
    "title",
    "has_route",
  ]);

  db.exec("BEGIN");
  for (let d = 0; d < days; d++) {
    const day = startUtc + d * DAY; // 00:00 UTC = 02:00 local
    const at = (h: number, m = 0) => day + h * HOUR + m * 60_000;
    const ld = epochDay(at(6));

    // Withings scale (skipped when the integration is connected) and a
    // manual entry in the Health Connect app the same morning.
    weight.run(
      id("w", `withings-${d}`),
      at(5),
      1,
      1,
      2,
      at(5),
      off,
      ld,
      80_000 - d * 20,
    );
    weight.run(
      id("w", `hc-${d}`),
      at(5, 30),
      null,
      4,
      3,
      at(5, 30),
      off,
      ld,
      79_500 - d * 20,
    );
    fat.run(id("bf", `${d}`), at(5), 1, 1, 2, at(5), off, ld, 21.5);
    lean.run(
      id("lbm", `${d}`),
      at(5, 30),
      null,
      4,
      3,
      at(5, 30),
      off,
      ld,
      61_000,
    );
    // TEXT-affinity enum columns: the platform writes ints, SQLite keeps '3'.
    bp.run(
      id("bp", `${d}`),
      at(6),
      3,
      3,
      3,
      at(6),
      off,
      ld,
      "3",
      125 + (d % 7),
      82,
      "2",
    );
    rhr.run(id("rhr", `${d}`), at(6), 2, 2, 2, at(6), off, ld, 58);
    hrv.run(id("hrv", `${d}`), at(4), 2, 2, 2, at(4), off, ld, 42.5);
    spo2.run(id("spo2", `${d}`), at(4), 2, 2, 2, at(4), off, ld, 96);
    resp.run(id("resp", `${d}`), at(4), 2, 2, 2, at(4), off, ld, 14.5);
    glucose.run(
      id("glu", `${d}`),
      at(7),
      null,
      4,
      3,
      at(7),
      off,
      ld,
      "2",
      5.5,
      "2",
      "1",
    );
    temp.run(id("temp", `${d}`), at(7), null, 4, 3, at(7), off, ld, 1, 36.6);
    vo2.run(id("vo2", `${d}`), at(18), 2, 2, 2, at(18), off, ld, 2, 44.2);

    // Steps, energy and distance from two apps on the same local day.
    for (let h = 6; h < 22; h++) {
      const s = at(h);
      steps.run(
        id("st", `fitbit-${d}-${h}`),
        s,
        2,
        2,
        2,
        s,
        off,
        s + HOUR,
        off,
        ld,
        400,
      );
      steps.run(
        id("st", `samsung-${d}-${h}`),
        s,
        3,
        3,
        2,
        s,
        off,
        s + HOUR,
        off,
        ld,
        350,
      );
      energy.run(
        id("en", `fitbit-${d}-${h}`),
        s,
        2,
        2,
        2,
        s,
        off,
        s + HOUR,
        off,
        ld,
        20_000,
      );
      distance.run(
        id("di", `samsung-${d}-${h}`),
        s,
        3,
        3,
        2,
        s,
        off,
        s + HOUR,
        off,
        ld,
        250,
      );
    }
    hydration.run(
      id("hy", `${d}-a`),
      at(8),
      null,
      4,
      3,
      at(8),
      off,
      at(8),
      off,
      ld,
      0.25,
    );
    hydration.run(
      id("hy", `${d}-b`),
      at(12),
      null,
      4,
      3,
      at(12),
      off,
      at(12),
      off,
      ld,
      0.5,
    );
    nutrition.run(
      id("nu", `${d}`),
      at(12),
      null,
      4,
      3,
      at(12),
      off,
      at(12, 30),
      off,
      ld,
      650_000,
      30,
      0.06,
      0.00001,
      0.12,
      0.08,
    );

    // Heart rate: one series parent per hour, `perHour` samples.
    for (let h = 0; h < 24; h++) {
      const s = at(h);
      const { lastInsertRowid } = hrParent.run(
        id("hr", `${d}-${h}`),
        s,
        2,
        2,
        2,
        s,
        off,
        s + HOUR,
        off,
        epochDay(s),
      );
      const step = Math.floor(HOUR / perHour);
      for (let m = 0; m < perHour; m++) {
        hrSample.run(lastInsertRowid, 55 + ((h * 7 + m) % 40), s + m * step);
      }
    }

    // Sleep: the night before this day, 22:00-05:30 UTC, with stages.
    const sStart = day - 2 * HOUR;
    const { lastInsertRowid: sid } = sleep.run(
      id("sl", `${d}`),
      day,
      2,
      2,
      2,
      sStart,
      off,
      sStart + 7.5 * HOUR,
      off,
      epochDay(sStart),
    );
    const seq = [7, 4, 5, 3, 4, 6, 1, 4, 5, 0];
    seq.forEach((type, i) =>
      stage.run(
        sid,
        sStart + i * 45 * 60_000,
        sStart + (i + 1) * 45 * 60_000,
        type,
      ),
    );
  }

  // One night with only unknown stages, one without stages, both from Samsung
  // on days the Fitbit night does not cover (afternoon naps).
  const nap1 = startUtc + 13 * HOUR;
  const { lastInsertRowid: n1 } = sleep.run(
    id("sl", "nap-unknown"),
    nap1,
    3,
    3,
    2,
    nap1,
    off,
    nap1 + HOUR,
    off,
    epochDay(nap1),
  );
  stage.run(n1, nap1, nap1 + 30 * 60_000, 0);
  stage.run(n1, nap1 + 30 * 60_000, nap1 + HOUR, 0);
  const nap2 = startUtc + DAY + 13 * HOUR;
  sleep.run(
    id("sl", "nap-bare"),
    nap2,
    3,
    3,
    2,
    nap2,
    off,
    nap2 + 40 * 60_000,
    off,
    epochDay(nap2),
  );
  // A Samsung night overlapping the first Fitbit night: Fitbit ranks first
  // for SLEEP, so this one is left out.
  const dupStart = startUtc - 2 * HOUR + 10 * 60_000;
  const { lastInsertRowid: dup } = sleep.run(
    id("sl", "dup"),
    dupStart,
    3,
    3,
    2,
    dupStart,
    off,
    dupStart + 7 * HOUR,
    off,
    epochDay(dupStart),
  );
  stage.run(dup, dupStart, dupStart + 7 * HOUR, 2);

  // A run (exercise_type 33) and an unknown type (999).
  const run = startUtc + 17 * HOUR;
  exercise.run(
    id("ex", "run"),
    run,
    2,
    2,
    1,
    run,
    off,
    run + 45 * 60_000,
    off,
    epochDay(run),
    33,
    "Evening run",
    0,
  );
  const odd = startUtc + DAY + 17 * HOUR;
  exercise.run(
    id("ex", "odd"),
    odd,
    2,
    2,
    1,
    odd,
    off,
    odd + 30 * 60_000,
    off,
    epochDay(odd),
    999,
    null,
    0,
  );

  // Cycle: flow on the first two days, a period spanning the first three.
  flow.run(
    id("fl", "0"),
    startUtc + 8 * HOUR,
    null,
    4,
    3,
    startUtc + 8 * HOUR,
    off,
    epochDay(startUtc + 8 * HOUR),
    3,
  );
  flow.run(
    id("fl", "1"),
    startUtc + DAY + 8 * HOUR,
    null,
    4,
    3,
    startUtc + DAY + 8 * HOUR,
    off,
    epochDay(startUtc + DAY + 8 * HOUR),
    1,
  );
  period.run(
    id("pe", "0"),
    startUtc + 7 * HOUR,
    null,
    4,
    3,
    startUtc + 7 * HOUR,
    off,
    startUtc + 2 * DAY + 20 * HOUR,
    off,
    epochDay(startUtc + 7 * HOUR),
  );
  db.exec("COMMIT");
  db.close();
  return { startUtc, endUtc, days };
}

/**
 * Wrap `dbPath` into a one-member ZIP at `zipPath`, the shape the Health
 * Connect app writes. `memberName` and `declaredSize` let a test forge the
 * archive (a wrong member, a header that lies about the inflated size).
 */
export function zipHealthConnectDb(
  dbPath: string,
  zipPath: string,
  options: { memberName?: string; declaredSize?: number } = {},
): void {
  const payload = readFileSync(dbPath);
  const compressed = deflateRawSync(payload);
  const name = Buffer.from(options.memberName ?? "health_connect_export.db");
  const size = options.declaredSize ?? payload.length;
  const crc = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + compressed.length;
  const cdSize = central.length + name.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  writeFileSync(
    zipPath,
    Buffer.concat([local, name, compressed, central, name, eocd]),
  );
}
