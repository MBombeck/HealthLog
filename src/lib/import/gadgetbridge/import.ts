/**
 * Import a Gadgetbridge database export onto native measurement types.
 *
 * What a table becomes:
 *
 *   activity samples → ACTIVITY_STEPS, one row per local day. Gadgetbridge
 *                      writes one table per device family and one series per
 *                      device; two devices worn on one day would double the
 *                      day if summed, so each day keeps the device with the
 *                      most steps. A newer export of the same day overwrites
 *                      the total (it holds more of that day).
 *                    → PULSE, one mean per local hour from the samples'
 *                      `HEART_RATE` (30 to 220 bpm; Gadgetbridge writes 0,
 *                      -1 and 255 for "no reading"), overwritten likewise.
 *   SpO2 samples     → OXYGEN_SATURATION, one row per reading.
 *   resting HR       → RESTING_HEART_RATE, one row per reading.
 *   manual HR        → PULSE, one spot row per reading.
 *   sleep sessions   → SLEEP_DURATION in minutes, one ASLEEP row per night,
 *                      at wake-up.
 *   weight samples   → WEIGHT in kilograms.
 *
 * Every row carries a stable identity under the source IMPORT: the bucket
 * (`gb:steps:<day>`, `gb:pulse:<day>T<hh>`) or the table, device and instant
 * of the sample, so a second run of the same file, or a later export, writes
 * nothing twice. Tables the importer does not read are named in the summary
 * with their row counts; nothing from inside a row is ever reported.
 */
import { createHash } from "node:crypto";

import type { MeasurementType } from "@/generated/prisma/client";
import {
  canonicalDailyTimestamp,
  canonicalHourlyTimestamp,
  hourOfDayForUserTz,
} from "@/lib/measurements/consolidation-tz";
import { userDayKey } from "@/lib/tz/format";

import type { RecordFileImportTally } from "../file-import/tally";
import {
  writeImportedMeasurements,
  type ImportedMeasurement,
} from "../file-import/write-measurements";
import { gbNumber, openGadgetbridgeDb, type GbTable } from "./reader";

const HOUR_MS = 3_600_000;
const MIN_BPM = 30;
const MAX_BPM = 220;

/** The table, device and instant of one sample, as a short digest. */
function sampleId(prefix: string, table: string, device: unknown, at: number) {
  const digest = createHash("sha256")
    .update(`${table}\u0000${String(device ?? "")}\u0000${at}`)
    .digest("hex")
    .slice(0, 32);
  return `gb:${prefix}:${digest}`;
}

function instant(table: GbTable, raw: unknown): number | null {
  const n = gbNumber(raw);
  if (n === null || n <= 0) return null;
  const ms = table.millis ? n : n * 1000;
  // Nothing from before 2000 or from the future is a reading.
  if (ms < 946_684_800_000 || ms > Date.now() + 5 * 60_000) return null;
  return ms;
}

export async function importGadgetbridgeExport(input: {
  userId: string;
  dbPath: string;
  tz: string;
  tally: RecordFileImportTally;
}): Promise<void> {
  const { tally } = input;
  const db = await openGadgetbridgeDb(input.dbPath);
  try {
    for (const table of db.unread)
      tally.skip(table.name, "not_read", table.rows);

    const steps = new Map<string, Map<string, number>>(); // day → device → sum
    const pulse = new Map<string, { sum: number; n: number }>(); // day|hour
    for (const table of db.tables) {
      if (tally.outOfTime()) return;
      if (table.kind === "activity") {
        await readActivity(db, table, input.tz, steps, pulse, tally);
      } else {
        await readSamples(db, { ...table, kind: table.kind }, input, tally);
      }
    }
    if (tally.outOfTime()) return;

    const totals: ImportedMeasurement[] = [];
    for (const [day, devices] of steps) {
      const best = Math.max(...devices.values());
      if (best <= 0) continue;
      totals.push({
        type: "ACTIVITY_STEPS",
        value: best,
        measuredAt: canonicalDailyTimestamp(day, input.tz),
        externalId: `gb:steps:${day}`,
      });
    }
    await writeImportedMeasurements(input.userId, totals, tally, {
      overwrite: true,
    });
    const means: ImportedMeasurement[] = [];
    for (const [key, { sum, n }] of pulse) {
      const [day, hour] = key.split("|") as [string, string];
      means.push({
        type: "PULSE",
        value: Math.round(sum / n),
        measuredAt: canonicalHourlyTimestamp(day, Number(hour), input.tz),
        externalId: `gb:pulse:${day}T${hour.padStart(2, "0")}`,
      });
    }
    await writeImportedMeasurements(input.userId, means, tally, {
      overwrite: true,
    });
  } finally {
    await db.close();
  }
}

/** Steps per device and local day, heart rate per local hour, in SQLite. */
async function readActivity(
  db: Awaited<ReturnType<typeof openGadgetbridgeDb>>,
  table: GbTable,
  tz: string,
  steps: Map<string, Map<string, number>>,
  pulse: Map<string, { sum: number; n: number }>,
  tally: RecordFileImportTally,
): Promise<void> {
  const unit = table.millis ? HOUR_MS : 3600;
  const device = table.columns.has("DEVICE_ID") ? "DEVICE_ID" : "0";
  const hr = table.columns.has("HEART_RATE");
  // `table.name` passed the reader's SAFE_NAME check; the columns are fixed.
  const sql = `SELECT CAST(TIMESTAMP / ${unit} AS INTEGER) AS h, ${device} AS d,
      SUM(CASE WHEN STEPS > 0 AND STEPS < 100000 THEN STEPS ELSE 0 END) AS s,
      ${
        hr
          ? `SUM(CASE WHEN HEART_RATE BETWEEN ${MIN_BPM} AND ${MAX_BPM} THEN HEART_RATE ELSE 0 END) AS hs,
      SUM(CASE WHEN HEART_RATE BETWEEN ${MIN_BPM} AND ${MAX_BPM} THEN 1 ELSE 0 END) AS hn`
          : "0 AS hs, 0 AS hn"
      }
    FROM "${table.name}" WHERE TIMESTAMP > 0 GROUP BY h, d`;
  for await (const batch of db.batches(sql)) {
    for (const row of batch) {
      const hourIndex = gbNumber(row.h);
      if (hourIndex === null) continue;
      const at = new Date(hourIndex * HOUR_MS);
      if (at.getTime() < 946_684_800_000 || at.getTime() > Date.now()) {
        tally.skip(table.name, "invalid_time");
        continue;
      }
      const day = userDayKey(at, tz);
      const s = gbNumber(row.s) ?? 0;
      if (s > 0) {
        const perDevice = steps.get(day) ?? new Map<string, number>();
        const key = String(row.d ?? "");
        perDevice.set(key, (perDevice.get(key) ?? 0) + s);
        steps.set(day, perDevice);
      }
      const hn = gbNumber(row.hn) ?? 0;
      if (hn > 0) {
        const key = `${day}|${hourOfDayForUserTz(at, tz)}`;
        const entry = pulse.get(key) ?? { sum: 0, n: 0 };
        entry.sum += gbNumber(row.hs) ?? 0;
        entry.n += hn;
        pulse.set(key, entry);
      }
    }
  }
}

const SPOT: Record<
  Exclude<GbTable["kind"], "activity" | "sleep">,
  { type: MeasurementType; column: string; prefix: string }
> = {
  spo2: { type: "OXYGEN_SATURATION", column: "SPO2", prefix: "spo2" },
  restingHeartRate: {
    type: "RESTING_HEART_RATE",
    column: "HEART_RATE",
    prefix: "rhr",
  },
  spotHeartRate: { type: "PULSE", column: "HEART_RATE", prefix: "hr" },
  weight: { type: "WEIGHT", column: "WEIGHT_KG", prefix: "weight" },
};

/** One row per sample for the spot kinds, one per night for sleep. */
async function readSamples(
  db: Awaited<ReturnType<typeof openGadgetbridgeDb>>,
  table: GbTable & { kind: Exclude<GbTable["kind"], "activity"> },
  input: { userId: string },
  tally: RecordFileImportTally,
): Promise<void> {
  const device = table.columns.has("DEVICE_ID") ? "DEVICE_ID" : "NULL";
  const value =
    table.kind === "sleep" ? "WAKEUP_TIME" : SPOT[table.kind].column;
  const sql = `SELECT TIMESTAMP AS t, ${device} AS d, ${value} AS v FROM "${table.name}" ORDER BY TIMESTAMP`;
  for await (const batch of db.batches(sql)) {
    if (tally.outOfTime()) return;
    const rows: ImportedMeasurement[] = [];
    for (const row of batch) {
      const at = instant(table, row.t);
      if (at === null) {
        tally.skip(table.name, "invalid_time");
        continue;
      }
      if (table.kind === "sleep") {
        const end = instant(table, row.v);
        if (end === null || end <= at || end - at > 24 * HOUR_MS) {
          tally.skip(table.name, "invalid_value");
          continue;
        }
        rows.push({
          type: "SLEEP_DURATION",
          value: Math.round((end - at) / 60_000),
          measuredAt: new Date(end),
          externalId: sampleId("sleep", table.name, row.d, at),
          sleepStage: "ASLEEP",
        });
        continue;
      }
      const spec = SPOT[table.kind];
      const v = gbNumber(row.v);
      if (v === null || v <= 0) {
        tally.skip(table.name, "invalid_value");
        continue;
      }
      rows.push({
        type: spec.type,
        value: v,
        measuredAt: new Date(at),
        externalId: sampleId(spec.prefix, table.name, row.d, at),
      });
    }
    await writeImportedMeasurements(input.userId, rows, tally, {
      skipKey: table.name,
    });
  }
}
