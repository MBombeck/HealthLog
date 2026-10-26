/**
 * Documented-payload tests for the Google Health data-point mappers.
 *
 * Fixtures follow the official v4 response shapes: the DataPoint value is a
 * camelCase union keyed by the camelCase type name (`bodyFat`,
 * `dailyRestingHeartRate`, …) with camelCase nested times
 * (`sampleTime.physicalTime`, `interval.startTime`), proto3 int64 fields arrive
 * as JSON strings (`"8500"`), daily-summary `date` fields are `{year,month,day}`
 * objects, and the cumulative activity totals come from `:dailyRollUp`
 * aggregate windows (`civilStartTime.date` + `*Sum` fields). The tests pin the
 * MeasurementType, unit, value (incl. gram/millimetre conversions), the
 * resolved `measuredAt`, and the externalId `fieldTag` grain (spot anchor vs
 * the `stats:`-style daily-total overwrite key vs per-sleep-stage).
 */
import { describe, expect, it } from "vitest";

import { chunkCivilRange } from "../client";
import { mapVo2Max } from "@/lib/google-health/mappers";
import {
  formatCivilBound,
  incrementalFilter,
} from "@/lib/google-health/request";
import {
  GOOGLE_HEALTH_DATA_TYPES,
  mapActiveEnergy,
  mapBloodGlucose,
  mapBodyFat,
  mapCoreBodyTemperature,
  mapDistance,
  mapFloors,
  mapGoogleHealthSleepStage,
  mapGoogleHealthSportType,
  mapHeartRate,
  mapHeartRateVariability,
  mapHeight,
  mapOxygenSaturation,
  mapRespiratoryRate,
  mapRestingHeartRate,
  mapSleepSession,
  mapSleepSessionDetailed,
  mapSteps,
  mapWeight,
  mapWorkout,
  mapWristTemperature,
} from "@/lib/google-health/mappers";

describe("mapGoogleHealthSportType", () => {
  it("keeps Badminton as a first-class workout sport", () => {
    expect(mapGoogleHealthSportType("BADMINTON")).toBe("badminton");
    expect(mapGoogleHealthSportType("Badminton")).toBe("badminton");
  });
});

describe("mapWeight — spot sample", () => {
  it("maps a weightGrams sample to a WEIGHT reading in kg anchored on its physical time", () => {
    const rows = mapWeight({
      weight: {
        weightGrams: 72530,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("WEIGHT");
    expect(r.unit).toBe("kg");
    expect(r.value).toBe(72.53);
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T08:00:00.000Z");
    // Spot readings anchor on the instant → first-write-wins immutable externalId.
    expect(r.fieldTag).toBe("2026-06-01T08:00:00.000Z:weight");
    expect(r.cumulativeDaily).toBeUndefined();
  });

  it("returns nothing when no value parses", () => {
    expect(mapWeight({ weight: { sampleTime: {} } })).toEqual([]);
  });
});

describe("imported values round half away from zero (importValue)", () => {
  // Each of these sits on a half at the third decimal whose double lies just
  // below it, where `toFixed(2)` rounded down.
  it("rounds a gram-precise weight up on the half", () => {
    const [r] = mapWeight({
      weight: {
        weightGrams: 72345,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(r!.value).toBe(72.35);
  });

  it("rounds a daily distance total up on the half", () => {
    const [r] = mapDistance({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      distance: { millimetersSum: "1000005" },
    });
    expect(r!.value).toBe(1000.01);
  });

  it("rounds a session distance up on the half", () => {
    const w = mapWorkout({
      name: "users/me/dataTypes/exercise/dataPoints/half",
      exercise: {
        exerciseType: "RUNNING",
        interval: {
          startTime: "2026-06-03T07:00:00.000Z",
          endTime: "2026-06-03T07:45:00.000Z",
        },
        metricsSummary: { distanceMillimeters: "8000025" },
      },
    });
    expect(w!.totalDistanceM).toBe(8000.03);
  });
});

describe("mapBodyFat — camelCase union key", () => {
  it("reads the percentage under the camelCase bodyFat key", () => {
    const rows = mapBodyFat({
      bodyFat: {
        percentage: 21.7,
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "BODY_FAT",
      unit: "%",
      value: 21.7,
      fieldTag: "2026-06-01T08:00:00.000Z:body_fat",
    });
  });
});

describe("mapOxygenSaturation — daily-oxygen-saturation summary", () => {
  it("maps averagePercentage anchored on the {year,month,day} civil date", () => {
    const rows = mapOxygenSaturation({
      dailyOxygenSaturation: {
        averagePercentage: 97.4,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("OXYGEN_SATURATION");
    expect(r.unit).toBe("%");
    expect(r.value).toBe(97.4);
    // Civil-date summaries anchor at UTC midday (tz-shift-proof) and key per-day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
    expect(r.fieldTag).toBe("2026-06-01:spo2");
  });
});

describe("mapHeartRateVariability — daily-heart-rate-variability summary", () => {
  it("maps the RMSSD daily average to HRV_RMSSD in ms", () => {
    const rows = mapHeartRateVariability({
      dailyHeartRateVariability: {
        averageHeartRateVariabilityMilliseconds: 42.5,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "HRV_RMSSD",
      unit: "ms",
      value: 42.5,
      fieldTag: "2026-06-01:hrv",
    });
  });
});

describe("mapRestingHeartRate — int64-string coercion", () => {
  it("coerces the beatsPerMinute int64 JSON string", () => {
    const rows = mapRestingHeartRate({
      dailyRestingHeartRate: {
        beatsPerMinute: "54",
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "RESTING_HEART_RATE",
      unit: "bpm",
      value: 54,
      fieldTag: "2026-06-01:rhr",
    });
  });
});

describe("mapRespiratoryRate — daily-respiratory-rate summary", () => {
  it("reads the documented breathsPerMinute number", () => {
    // Documented schema: `{ date, breathsPerMinute }` — a plain number.
    const rows = mapRespiratoryRate({
      dailyRespiratoryRate: {
        breathsPerMinute: 14.2,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "RESPIRATORY_RATE",
      unit: "breaths/min",
      value: 14.2,
      fieldTag: "2026-06-01:resp_rate",
    });
  });

  it("returns nothing for the leaf name that does not exist in the schema", () => {
    expect(
      mapRespiratoryRate({
        dailyRespiratoryRate: {
          dailyRespiratoryRateBpm: "14",
          date: { year: 2026, month: 6, day: 1 },
        },
      }),
    ).toEqual([]);
  });
});

describe("mapBloodGlucose — spot sample", () => {
  it("reads bloodGlucoseMilligramsPerDeciliter in the canonical mg/dL unit", () => {
    const rows = mapBloodGlucose({
      bloodGlucose: {
        bloodGlucoseMilligramsPerDeciliter: 104,
        measurementSource: "GLUCOMETER",
        sampleTime: { physicalTime: "2026-06-01T07:45:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "BLOOD_GLUCOSE",
      unit: "mg/dL",
      value: 104,
      fieldTag: "2026-06-01T07:45:00.000Z:glucose",
    });
  });
});

describe("mapCoreBodyTemperature — spot sample", () => {
  it("reads temperatureCelsius into the core BODY_TEMPERATURE slot", () => {
    const rows = mapCoreBodyTemperature({
      coreBodyTemperature: {
        temperatureCelsius: 36.9,
        measurementLocation: "BODY",
        sampleTime: { physicalTime: "2026-06-01T19:00:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "BODY_TEMPERATURE",
      unit: "celsius",
      value: 36.9,
      fieldTag: "2026-06-01T19:00:00.000Z:core_temp",
    });
  });
});

describe("mapWristTemperature — daily-sleep-temperature-derivations", () => {
  it("reads the ABSOLUTE nightlyTemperatureCelsius into WRIST_TEMPERATURE", () => {
    // `nightlyTemperatureCelsius` is the mean absolute skin temperature over
    // the night — NOT a signed deviation. Baseline/stddev siblings are ignored.
    const rows = mapWristTemperature({
      dailySleepTemperatureDerivations: {
        nightlyTemperatureCelsius: 33.4,
        baselineTemperatureCelsius: 33.1,
        relativeNightlyStddev30dCelsius: 0.4,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "WRIST_TEMPERATURE",
      unit: "celsius",
      value: 33.4,
      fieldTag: "2026-06-01:wrist_temp",
    });
  });
});

describe("mapHeartRate — intraday spot sample", () => {
  it("coerces the beatsPerMinute int64 JSON string and anchors on the instant", () => {
    const rows = mapHeartRate({
      heartRate: {
        beatsPerMinute: "62",
        sampleTime: { physicalTime: "2026-06-01T09:15:00.000Z" },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "PULSE",
      unit: "bpm",
      value: 62,
      fieldTag: "2026-06-01T09:15:00.000Z:hr",
    });
  });
});

describe("mapHeight — profile seed", () => {
  it("converts the heightMillimeters int64 string to cm and surfaces the sample instant", () => {
    // Documented field: `heightMillimeters` (string, int64) — millimetres.
    const sample = mapHeight({
      height: {
        heightMillimeters: "1820",
        sampleTime: { physicalTime: "2026-06-01T08:00:00.000Z" },
      },
    });
    expect(sample).not.toBeNull();
    expect(sample!.cm).toBe(182);
    expect(sample!.sampledAt?.toISOString()).toBe("2026-06-01T08:00:00.000Z");
  });

  it("returns null when no value parses (incl. the nonexistent heightMeters leaf)", () => {
    expect(mapHeight({ height: {} })).toBeNull();
    expect(mapHeight({ height: { heightMeters: 1.82 } })).toBeNull();
  });
});

describe("mapSteps — dailyRollUp aggregate window", () => {
  it("maps countSum (int64 string) keyed on civilStartTime.date", () => {
    const rows = mapSteps({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      civilEndTime: { date: { year: 2026, month: 6, day: 2 } },
      steps: { countSum: "8500" },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("ACTIVITY_STEPS");
    expect(r.unit).toBe("steps");
    expect(r.value).toBe(8500);
    // Daily totals carry the overwrite-in-place grain (cumulativeDaily flag +
    // per-day fieldTag) so a re-fetched day replaces rather than duplicates.
    expect(r.cumulativeDaily).toBe(true);
    expect(r.fieldTag).toBe("steps:2026-06-01");
    // Anchored at UTC-midday so a tz shift can't roll the civil day.
    expect(r.measuredAt.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("drops a window with no parseable civil day (it cannot be keyed)", () => {
    expect(mapSteps({ steps: { countSum: "1200" } })).toEqual([]);
  });
});

describe("mapDistance — millimetre conversion", () => {
  it("converts millimetersSum (int64 string) to metres", () => {
    const rows = mapDistance({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      distance: { millimetersSum: "5200000" },
    });
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.type).toBe("WALKING_RUNNING_DISTANCE");
    expect(r.unit).toBe("m");
    expect(r.value).toBe(5200); // 5 200 000 mm → 5200 m
    expect(r.cumulativeDaily).toBe(true);
    expect(r.fieldTag).toBe("distance:2026-06-01");
  });
});

describe("mapActiveEnergy — preserves a legitimate zero", () => {
  it("keeps a rest-day 0 kcalSum (a real reading, not a gap)", () => {
    const rows = mapActiveEnergy({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      activeEnergyBurned: { kcalSum: 0 },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "ACTIVE_ENERGY_BURNED",
      unit: "kcal",
      value: 0,
      cumulativeDaily: true,
      fieldTag: "active_energy:2026-06-01",
    });
  });
});

describe("mapFloors — dailyRollUp aggregate window", () => {
  it("maps countSum (int64 string) to FLIGHTS_CLIMBED", () => {
    const rows = mapFloors({
      civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
      floors: { countSum: "3" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "FLIGHTS_CLIMBED",
      unit: "flights",
      value: 3,
      cumulativeDaily: true,
      fieldTag: "floors:2026-06-01",
    });
  });
});

describe("mapVo2Max — daily-vo2-max summary", () => {
  it("maps vo2Max keyed per civil day (latest-wins overwrite grain)", () => {
    const rows = mapVo2Max({
      dailyVo2Max: {
        vo2Max: 41.2,
        estimated: true,
        date: { year: 2026, month: 6, day: 1 },
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "VO2_MAX",
      unit: "mL/(kg·min)",
      value: 41.2,
      cumulativeDaily: true,
      fieldTag: "vo2_max:2026-06-01",
    });
  });

  it("drops a zero (VO2 max is strictly positive)", () => {
    expect(
      mapVo2Max({
        dailyVo2Max: { vo2Max: 0, date: { year: 2026, month: 6, day: 1 } },
      }),
    ).toEqual([]);
  });
});

describe("mapSleepSessionDetailed — unknown stage labels are counted", () => {
  it("reports how many segments it skipped and which labels they carried", () => {
    const session = mapSleepSessionDetailed({
      sleep: {
        stages: [
          {
            type: "DEEP",
            startTime: "2026-06-02T02:00:00.000Z",
            endTime: "2026-06-02T02:45:00.000Z",
          },
          {
            type: "SLEEP_STAGE_TYPE_UNSPECIFIED",
            startTime: "2026-06-02T04:00:00.000Z",
            endTime: "2026-06-02T04:10:00.000Z",
          },
          {
            type: "SLEEP_STAGE_TYPE_UNSPECIFIED",
            startTime: "2026-06-02T04:10:00.000Z",
            endTime: "2026-06-02T04:20:00.000Z",
          },
        ],
      },
    });
    expect(session.rows).toHaveLength(1);
    expect(session.unknownStageSegments).toBe(2);
    expect(session.unknownStageLabels).toEqual([
      "SLEEP_STAGE_TYPE_UNSPECIFIED",
    ]);
  });
});

describe("mapSleepSession — per-stage segments", () => {
  it("emits one SLEEP_DURATION row per known stage, skipping unknown labels", () => {
    const rows = mapSleepSession({
      sleep: {
        interval: {
          startTime: "2026-06-01T22:30:00.000Z",
          endTime: "2026-06-02T06:30:00.000Z",
        },
        type: "STAGES",
        stages: [
          {
            type: "DEEP",
            startTime: "2026-06-02T02:00:00.000Z",
            endTime: "2026-06-02T02:45:00.000Z",
          },
          {
            type: "REM",
            startTime: "2026-06-02T03:00:00.000Z",
            endTime: "2026-06-02T03:30:00.000Z",
          },
          {
            type: "SLEEP_STAGE_TYPE_UNSPECIFIED",
            startTime: "2026-06-02T04:00:00.000Z",
            endTime: "2026-06-02T04:10:00.000Z",
          },
        ],
      },
    });
    expect(rows).toHaveLength(2);

    const deep = rows[0]!;
    expect(deep.type).toBe("SLEEP_DURATION");
    expect(deep.unit).toBe("minutes");
    expect(deep.value).toBe(45);
    expect(deep.sleepStage).toBe("DEEP");
    expect(deep.measuredAt.toISOString()).toBe("2026-06-02T02:45:00.000Z");
    // Segments key off the session anchor (here the fallback session-END, since
    // this fixture carries no resource `name`) plus the segment's own START —
    // NOT a positional index and NOT the stage label.
    expect(deep.fieldTag).toBe(
      "2026-06-02T06:30:00.000Z:sleep:2026-06-02T02:00:00.000Z",
    );

    const rem = rows[1]!;
    expect(rem.value).toBe(30);
    expect(rem.sleepStage).toBe("REM");
    expect(rem.fieldTag).toBe(
      "2026-06-02T06:30:00.000Z:sleep:2026-06-02T03:00:00.000Z",
    );
  });

  it("keeps stable per-segment externalIds across a re-score (anchor = resource name)", () => {
    // Two fetches of the SAME night. Google carries a stable resource `name`
    // and, on the re-score, refines the session END and RE-CLASSIFIES the first
    // block (LIGHT→DEEP) while keeping the segment START instants. The stable
    // anchor + start-keyed fieldTag must yield the SAME externalIds, so the
    // upsert overwrites in place rather than minting parallel duplicates.
    const name = "users/me/dataTypes/sleep/dataPoints/night-42";
    const first = mapSleepSession({
      name,
      sleep: {
        interval: {
          startTime: "2026-06-01T22:30:00.000Z",
          endTime: "2026-06-02T06:30:00.000Z",
        },
        stages: [
          {
            type: "LIGHT",
            startTime: "2026-06-02T02:00:00.000Z",
            endTime: "2026-06-02T02:45:00.000Z",
          },
          {
            type: "REM",
            startTime: "2026-06-02T03:00:00.000Z",
            endTime: "2026-06-02T03:30:00.000Z",
          },
        ],
      },
    });
    const rescored = mapSleepSession({
      name,
      sleep: {
        interval: {
          startTime: "2026-06-01T22:30:00.000Z",
          // Google refined the wake instant — the OLD anchor would have shifted.
          endTime: "2026-06-02T06:42:00.000Z",
        },
        stages: [
          {
            // Re-classified block, SAME start — must map to the same externalId.
            type: "DEEP",
            startTime: "2026-06-02T02:00:00.000Z",
            endTime: "2026-06-02T02:45:00.000Z",
          },
          {
            type: "REM",
            startTime: "2026-06-02T03:00:00.000Z",
            endTime: "2026-06-02T03:30:00.000Z",
          },
        ],
      },
    });

    expect(first.map((r) => r.fieldTag)).toEqual([
      `${name}:sleep:2026-06-02T02:00:00.000Z`,
      `${name}:sleep:2026-06-02T03:00:00.000Z`,
    ]);
    // Identical externalIds across the re-score → overwrite, not duplicate.
    expect(rescored.map((r) => r.fieldTag)).toEqual(
      first.map((r) => r.fieldTag),
    );
    // The re-classification is reflected in the stage axis (in-place update).
    expect(first[0]!.sleepStage).toBe("CORE"); // LIGHT → shallow-NREM band
    expect(rescored[0]!.sleepStage).toBe("DEEP");
  });

  it("maps the documented SLEEP_STAGE_TYPE enum onto the shared bands", () => {
    expect(mapGoogleHealthSleepStage("LIGHT")).toBe("CORE"); // shallow-NREM band
    expect(mapGoogleHealthSleepStage("REM")).toBe("REM");
    expect(mapGoogleHealthSleepStage("RESTLESS")).toBe("AWAKE");
    expect(mapGoogleHealthSleepStage("ASLEEP")).toBe("ASLEEP");
    expect(
      mapGoogleHealthSleepStage("SLEEP_STAGE_TYPE_UNSPECIFIED"),
    ).toBeNull();
    expect(mapGoogleHealthSleepStage("nonsense")).toBeNull();
  });
});

describe("mapWorkout — exercise session", () => {
  it("maps a RUNNING session with metricsSummary fields and the top-level name id", () => {
    const w = mapWorkout({
      name: "users/me/dataTypes/exercise/dataPoints/abc123",
      exercise: {
        exerciseType: "RUNNING",
        interval: {
          startTime: "2026-06-03T07:00:00.000Z",
          endTime: "2026-06-03T07:45:00.000Z",
          civilStartTime: {
            date: { year: 2026, month: 6, day: 3 },
            time: { hours: 9 },
          },
        },
        metricsSummary: {
          caloriesKcal: 420,
          distanceMillimeters: 8000000,
          averageHeartRateBeatsPerMinute: "150",
          steps: "7600",
        },
      },
    });
    expect(w).not.toBeNull();
    expect(w).toMatchObject({
      externalId: "users/me/dataTypes/exercise/dataPoints/abc123",
      sportType: "running",
      durationSec: 2700, // 45 min
      totalEnergyKcal: 420,
      totalDistanceM: 8000, // 8 000 000 mm → 8000 m
      avgHeartRate: 150,
      // metricsSummary carries no max/min heart rate.
      maxHeartRate: null,
      minHeartRate: null,
    });
    expect(w!.startedAt.toISOString()).toBe("2026-06-03T07:00:00.000Z");
    expect(w!.endedAt.toISOString()).toBe("2026-06-03T07:45:00.000Z");
    // Provenance rides along even when the mapping succeeded.
    expect(w!.sportTypeRaw).toBe("RUNNING");
  });

  it("falls back to a start-anchored externalId when the resource name is absent", () => {
    const w = mapWorkout({
      exercise: {
        exerciseType: "WALKING",
        interval: {
          startTime: "2026-06-03T09:00:00.000Z",
          endTime: "2026-06-03T09:30:00.000Z",
        },
      },
    });
    expect(w!.externalId).toBe("exercise:2026-06-03T09:00:00.000Z");
    expect(w!.sportType).toBe("walking");
  });

  it("returns null for a session with no usable time span", () => {
    expect(mapWorkout({ exercise: {} })).toBeNull();
    expect(
      mapWorkout({
        exercise: {
          interval: {
            startTime: "2026-06-03T09:00:00.000Z",
            endTime: "2026-06-03T09:00:00.000Z", // zero-length
          },
        },
      }),
    ).toBeNull();
  });

  it("keeps the raw exerciseType when the sport falls back to 'other'", () => {
    // The whole point of the provenance field: `sportType` alone cannot say
    // whether Google reported a sport the map has never heard of or a genuine
    // OTHER_WORKOUT, and the answer is not recoverable from anywhere else.
    const w = mapWorkout({
      name: "users/me/dataTypes/exercise/dataPoints/kite1",
      exercise: {
        exerciseType: " KITESURFING ",
        interval: {
          startTime: "2026-06-04T10:00:00.000Z",
          endTime: "2026-06-04T11:00:00.000Z",
        },
      },
    });
    expect(w!.sportType).toBe("other");
    expect(w!.sportTypeRaw).toBe("KITESURFING");
  });

  it("reports a missing or blank exerciseType as null, not an empty string", () => {
    const noType = mapWorkout({
      exercise: {
        interval: {
          startTime: "2026-06-04T12:00:00.000Z",
          endTime: "2026-06-04T12:30:00.000Z",
        },
      },
    });
    expect(noType!.sportType).toBe("other");
    expect(noType!.sportTypeRaw).toBeNull();

    const blankType = mapWorkout({
      exercise: {
        exerciseType: "   ",
        interval: {
          startTime: "2026-06-04T13:00:00.000Z",
          endTime: "2026-06-04T13:30:00.000Z",
        },
      },
    });
    expect(blankType!.sportTypeRaw).toBeNull();
  });

  it("resolves the UPPERCASE ExerciseType enum, with a generic fallback", () => {
    expect(mapGoogleHealthSportType("STRENGTH_TRAINING")).toBe("strength");
    expect(mapGoogleHealthSportType("HIGH_INTENSITY_INTERVAL_TRAINING")).toBe(
      "hiit",
    );
    expect(mapGoogleHealthSportType("CYCLING")).toBe("cycling");
    // Lossy by design — `Workout.metadata.googleExerciseType` is what carries
    // the original (see the mapWorkout provenance cases above).
    expect(mapGoogleHealthSportType("KITESURFING")).toBe("other");
    expect(mapGoogleHealthSportType("")).toBe("other");
  });

  it("resolves the documented multi-word ExerciseType values (catalogue audit)", () => {
    // Values verbatim from the Exercise.ExerciseType enum in the v4 reference.
    expect(mapGoogleHealthSportType("MOUNTAIN_BIKE")).toBe("cycling");
    expect(mapGoogleHealthSportType("STATIONARY_BIKE")).toBe("cycling");
    expect(mapGoogleHealthSportType("TRAIL_RUN")).toBe("running");
    expect(mapGoogleHealthSportType("TREADMILL_WALK")).toBe("walking");
    expect(mapGoogleHealthSportType("NORDIC_WALKING")).toBe("walking");
    expect(mapGoogleHealthSportType("SWIMMING_POOL")).toBe("swimming");
    expect(mapGoogleHealthSportType("SWIMMING_OPEN_WATER")).toBe("swimming");
    expect(mapGoogleHealthSportType("ROWING_MACHINE")).toBe("rowing");
    expect(mapGoogleHealthSportType("FREE_WEIGHTS")).toBe("strength");
    expect(mapGoogleHealthSportType("FUNCTIONAL_STRENGTH_TRAINING")).toBe(
      "strength",
    );
    expect(mapGoogleHealthSportType("CROSSFIT")).toBe("crossTraining");
    expect(mapGoogleHealthSportType("CARDIO_WORKOUT")).toBe("mixedCardio");
    expect(mapGoogleHealthSportType("TABATA_WORKOUT")).toBe("hiit");
    expect(mapGoogleHealthSportType("TAI_CHI")).toBe("mindAndBody");
  });
});

describe("incrementalFilter — per-shape filter grammar", () => {
  const start = new Date("2026-06-01T15:30:00.000Z");

  it("filters samples on sample_time.physical_time (RFC-3339)", () => {
    expect(incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.weight, start)).toEqual({
      field: "weight.sample_time.physical_time",
      bound: "2026-06-01T15:30:00.000Z",
    });
  });

  it("filters daily summaries on .date (YYYY-MM-DD) with the camelCase worked-example prefix", () => {
    // The list reference's only worked daily example is
    // `dailyHeartRateVariability.date < "2024-08-15"` — camelCase, unlike the
    // snake_case sample/session prefixes. Camel is the default.
    expect(
      incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation, start),
    ).toEqual({
      field: "dailyOxygenSaturation.date",
      bound: "2026-06-01",
    });
    expect(
      incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.heartRateVariability, start),
    ).toEqual({
      field: "dailyHeartRateVariability.date",
      bound: "2026-06-01",
    });
  });

  it("builds the snake_case daily prefix for the fallback style", () => {
    expect(
      incrementalFilter(
        GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
        start,
        undefined,
        "snake",
      ),
    ).toEqual({
      field: "daily_resting_heart_rate.date",
      bound: "2026-06-01",
    });
  });

  it("filters sleep on interval.end_time — the only legal sleep time field", () => {
    expect(incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.sleep, start)).toEqual({
      field: "sleep.interval.end_time",
      bound: "2026-06-01T15:30:00.000Z",
    });
  });

  it("filters exercise on interval.civil_start_time with an offset-less civil bound in the user's zone", () => {
    expect(
      incrementalFilter(
        GOOGLE_HEALTH_DATA_TYPES.exercise,
        start,
        "Europe/Berlin",
      ),
    ).toEqual({
      field: "exercise.interval.civil_start_time",
      // 15:30Z = 17:30 Berlin wall clock (CEST) — no Z, no offset.
      bound: "2026-06-01T17:30:00",
    });
  });

  it("refuses to build a list filter for a rollup type", () => {
    expect(() =>
      incrementalFilter(GOOGLE_HEALTH_DATA_TYPES.steps, start),
    ).toThrow(/dailyRollUp/);
  });
});

describe("formatCivilBound", () => {
  it("forms the bound in UTC when no zone is known", () => {
    expect(formatCivilBound(new Date("2026-06-01T15:30:45.000Z"))).toBe(
      "2026-06-01T15:30:45",
    );
  });
});

describe("chunkCivilRange — dailyRollUp 90-day slicing", () => {
  it("returns a single chunk for a range under the cap", () => {
    expect(
      chunkCivilRange(
        { year: 2026, month: 6, day: 1 },
        { year: 2026, month: 6, day: 8 },
      ),
    ).toEqual([
      {
        start: { year: 2026, month: 6, day: 1 },
        end: { year: 2026, month: 6, day: 8 },
      },
    ]);
  });

  it("slices a long range into closed-open ≤90-day chunks with no gap or overlap", () => {
    const chunks = chunkCivilRange(
      { year: 2026, month: 1, day: 1 },
      { year: 2026, month: 8, day: 1 },
    );
    expect(chunks.length).toBe(3); // 212 days → 90 + 90 + 32
    expect(chunks[0]!.start).toEqual({ year: 2026, month: 1, day: 1 });
    // Each chunk starts exactly where the previous one ends (closed-open).
    expect(chunks[1]!.start).toEqual(chunks[0]!.end);
    expect(chunks[2]!.start).toEqual(chunks[1]!.end);
    expect(chunks[2]!.end).toEqual({ year: 2026, month: 8, day: 1 });
  });

  it("returns nothing for an empty or inverted range", () => {
    expect(
      chunkCivilRange(
        { year: 2026, month: 6, day: 8 },
        { year: 2026, month: 6, day: 1 },
      ),
    ).toEqual([]);
  });
});

describe("daily anchors in the user's zone", () => {
  it.each([
    ["Pacific/Tongatapu", "2026-05-31T23:00:00.000Z"],
    ["Pacific/Auckland", "2026-06-01T00:00:00.000Z"],
    ["America/New_York", "2026-06-01T16:00:00.000Z"],
    ["Europe/Berlin", "2026-06-01T10:00:00.000Z"],
  ])(
    "anchors a daily total and a daily summary at local noon in %s",
    (tz, iso) => {
      const [steps] = mapSteps(
        {
          civilStartTime: { date: { year: 2026, month: 6, day: 1 } },
          steps: { countSum: "8500" },
        },
        tz,
      );
      expect(steps!.measuredAt.toISOString()).toBe(iso);
      // The externalId stays on the civil date whatever the zone.
      expect(steps!.fieldTag).toBe("steps:2026-06-01");
      const [spo2] = mapOxygenSaturation(
        {
          dailyOxygenSaturation: {
            averagePercentage: 97.4,
            date: { year: 2026, month: 6, day: 1 },
          },
        },
        tz,
      );
      expect(spo2!.measuredAt.toISOString()).toBe(iso);
      expect(spo2!.fieldTag).toBe("2026-06-01:spo2");
    },
  );
});
