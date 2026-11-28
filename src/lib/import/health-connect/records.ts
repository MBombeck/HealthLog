/**
 * One Health Connect record, as the live sync sends it, onto the rows the
 * export import would write for the same record.
 *
 * A spot reading's `fields` hold the export's column names and units, so the
 * row handed to `spec.map` is the export row and the mapping function is the
 * export's own (`INSTANT_SPECS`). Identities are the export's too: `hc:<uuid>`
 * for the record, `hc:<uuid>:<epoch ms>` for a heart-rate sample and for a
 * sleep stage. A record therefore lands on the row an export of it already
 * wrote, and an export after the sync finds the rows the sync wrote.
 *
 * What the export import decides across records (one app per hour for heart
 * rate, one per day for totals, overlapping sessions by the app ranking)
 * needs Health Connect's priority list, which the live API does not expose.
 * The phone sends day totals already deduplicated by Health Connect
 * (`aggregateGroupByPeriod`), and the rest is left to the read-time source
 * ladder.
 */
import { HC_INSTANT_RECORD_TABLES } from "@/lib/validations/health-connect-sync";
import type {
  HcAggregate,
  HcRecord,
} from "@/lib/validations/health-connect-sync";
import type { MeasurementType } from "@/generated/prisma/client";
import { ownRecord } from "@/lib/own-key";
import { importValue } from "@/lib/integrations/import-value";

import {
  INSTANT_SPECS,
  deviceClassFromHc,
  hcExternalId,
  hcHourlyPulseExternalId,
} from "./mapper";
import {
  isKnownSleepStage,
  mapHealthConnectSleepStage,
} from "./sleep-stage-map";
import { roundPendingRow, type PendingRow, type PendingWorkout } from "./sink";

const HOUR_MS = 3_600_000;

/** What one record becomes. */
export type MappedRecord =
  | {
      kind: "rows";
      rows: PendingRow[];
      /** Whether the rows take the cross-source same-reading check. */
      sameReadingCheck: boolean;
      /** Parts of the record left out by the mapping, with why. */
      skipped: string[];
    }
  | { kind: "workout"; workout: PendingWorkout };

const SPEC_BY_TABLE = new Map(INSTANT_SPECS.map((s) => [s.table, s]));

/** Map one validated record. */
export function mapLiveRecord(record: HcRecord): MappedRecord {
  const deviceType = deviceClassFromHc(record.deviceType ?? null);
  switch (record.type) {
    case "HeartRateRecord":
      return {
        kind: "rows",
        sameReadingCheck: false,
        skipped: [],
        rows: record.samples.map((s) => {
          const t = Date.parse(s.time);
          return roundPendingRow({
            type: "PULSE",
            value: s.bpm,
            measuredAt: new Date(t),
            externalId: hcExternalId(record.id, t),
            sleepStage: null,
            deviceType,
          });
        }),
      };
    case "SleepSessionRecord": {
      const start = Date.parse(record.start);
      const end = Date.parse(record.end);
      if (record.stages.length === 0) {
        // A session with no stages is one stretch of sleep.
        return {
          kind: "rows",
          sameReadingCheck: false,
          skipped: end > start ? [] : ["malformed"],
          rows:
            end > start
              ? [
                  roundPendingRow({
                    type: "SLEEP_DURATION",
                    value: (end - start) / 60_000,
                    measuredAt: new Date(end),
                    externalId: hcExternalId(record.id),
                    sleepStage: "ASLEEP",
                    deviceType,
                  }),
                ]
              : [],
        };
      }
      const known = record.stages.some((s) => isKnownSleepStage(s.stage));
      const rows: PendingRow[] = [];
      const skipped: string[] = [];
      for (const stage of record.stages) {
        const s = Date.parse(stage.start);
        const e = Date.parse(stage.end);
        if (e <= s) {
          skipped.push("malformed");
          continue;
        }
        const mapped = mapHealthConnectSleepStage(stage.stage, known);
        if ("skip" in mapped) {
          skipped.push(mapped.skip);
          continue;
        }
        rows.push(
          roundPendingRow({
            type: "SLEEP_DURATION",
            value: (e - s) / 60_000,
            measuredAt: new Date(e),
            externalId: hcExternalId(record.id, s),
            sleepStage: mapped.stage,
            deviceType,
          }),
        );
      }
      return { kind: "rows", sameReadingCheck: false, skipped, rows };
    }
    case "ExerciseSessionRecord":
      return {
        kind: "workout",
        workout: {
          uuid: record.id,
          start: Date.parse(record.start),
          end: Date.parse(record.end),
          exerciseType: record.exerciseType,
          externalId: hcExternalId(record.id),
        },
      };
    default: {
      const spec = SPEC_BY_TABLE.get(HC_INSTANT_RECORD_TABLES[record.type])!;
      // The export row: the columns the spec reads, under their own names.
      const row = ownRecord<unknown>();
      for (const [key, value] of Object.entries(record.fields)) {
        row[key] = value;
      }
      const measuredAt = new Date(Date.parse(record.time));
      const mapped = spec.map(row);
      return {
        kind: "rows",
        sameReadingCheck: true,
        skipped: mapped.length === 0 ? ["no_value"] : [],
        rows: mapped.map((m) =>
          roundPendingRow({
            type: m.type,
            value: m.value,
            measuredAt,
            externalId: hcExternalId(record.id),
            sleepStage: null,
            glucoseContext: m.glucoseContext ?? null,
            deviceType,
          }),
        ),
      };
    }
  }
}

/** The measurement type a day-total metric writes. */
export const DAILY_METRIC_TYPE = {
  STEPS_COUNT_TOTAL: { type: "ACTIVITY_STEPS", factor: 1 },
  // Small calories to kcal, as the export's `energy` column.
  ACTIVE_CALORIES_TOTAL: { type: "ACTIVE_ENERGY_BURNED", factor: 1 / 1000 },
  DISTANCE_TOTAL: { type: "WALKING_RUNNING_DISTANCE", factor: 1 },
} as const satisfies Record<string, { type: MeasurementType; factor: number }>;

/**
 * An hourly heart-rate aggregate onto the row the export's hourly fold
 * writes: the mean at the middle of the local hour, min and max beside it.
 */
export function mapHourlyPulse(
  agg: Extract<HcAggregate, { metric: "HEART_RATE_BPM" }>,
): PendingRow {
  const dayKey = agg.hour.slice(0, 10);
  const hour = Number(agg.hour.slice(11, 13));
  // The local wall clock counted on the UTC axis, as the export's hourly
  // fold counts `epoch + offset`; the offset is taken off below.
  // eslint-disable-next-line healthlog/no-utc-day-key -- wall-clock arithmetic, not a day boundary
  const localHourStart = Date.parse(`${dayKey}T00:00:00Z`) + hour * HOUR_MS;
  return roundPendingRow({
    type: "PULSE",
    value: importValue(agg.avg, 1),
    valueMin: agg.min,
    valueMax: agg.max,
    measuredAt: new Date(
      localHourStart + HOUR_MS / 2 - agg.zoneOffsetSeconds * 1000,
    ),
    externalId: hcHourlyPulseExternalId(dayKey, hour),
    sleepStage: null,
    deviceType: null,
  });
}
