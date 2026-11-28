import { describe, expect, it } from "vitest";

import { mapHourlyPulse, mapLiveRecord } from "../records";
import { hcRecordSchema } from "@/lib/validations/health-connect-sync";

const ID = "6b1f0c2e-1a2b-4c3d-8e9f-0123456789ab";

function record(raw: unknown) {
  return hcRecordSchema.parse(raw);
}

describe("mapLiveRecord", () => {
  it("maps a spot reading through the export's own spec", () => {
    const mapped = mapLiveRecord(
      record({
        id: ID.toUpperCase(),
        type: "WeightRecord",
        deviceType: 3,
        time: "2026-11-30T06:12:00Z",
        fields: { weight: 81_250 },
      }),
    );
    expect(mapped).toEqual({
      kind: "rows",
      sameReadingCheck: true,
      skipped: [],
      rows: [
        {
          type: "WEIGHT",
          value: 81.25,
          valueMin: undefined,
          valueMax: undefined,
          measuredAt: new Date("2026-11-30T06:12:00Z"),
          externalId: `hc:${ID}`,
          sleepStage: null,
          glucoseContext: null,
          deviceType: "scale",
        },
      ],
    });
  });

  it("keeps a blood pressure pair together and drops half of one", () => {
    const pair = mapLiveRecord(
      record({
        id: ID,
        type: "BloodPressureRecord",
        time: "2026-11-30T06:12:00Z",
        fields: { systolic: 121, diastolic: 79 },
      }),
    );
    expect(pair.kind === "rows" && pair.rows.map((r) => r.type)).toEqual([
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
    const half = mapLiveRecord(
      record({
        id: ID,
        type: "BloodPressureRecord",
        time: "2026-11-30T06:12:00Z",
        fields: { systolic: 121 },
      }),
    );
    expect(half).toMatchObject({ rows: [], skipped: ["no_value"] });
  });

  it("converts glucose to mg/dL and reads the meal relation as the export does", () => {
    const mapped = mapLiveRecord(
      record({
        id: ID,
        type: "BloodGlucoseRecord",
        time: "2026-11-30T06:12:00Z",
        fields: { level: 5.5, relation_to_meal: "2" },
      }),
    );
    expect(mapped.kind === "rows" && mapped.rows[0]).toMatchObject({
      type: "BLOOD_GLUCOSE",
      glucoseContext: "FASTING",
    });
  });

  it("writes one row per heart-rate sample keyed by its instant", () => {
    const mapped = mapLiveRecord(
      record({
        id: ID,
        type: "HeartRateRecord",
        start: "2026-11-30T07:00:00Z",
        end: "2026-11-30T07:01:00Z",
        samples: [
          { time: "2026-11-30T07:00:10Z", bpm: 62 },
          { time: "2026-11-30T07:00:40Z", bpm: 64 },
        ],
      }),
    );
    expect(
      mapped.kind === "rows" && mapped.rows.map((r) => r.externalId),
    ).toEqual([
      `hc:${ID}:${Date.parse("2026-11-30T07:00:10Z")}`,
      `hc:${ID}:${Date.parse("2026-11-30T07:00:40Z")}`,
    ]);
  });

  it("maps sleep stages, leaves out unknown and out-of-bed beside real ones", () => {
    const at = (h: number) =>
      new Date(Date.UTC(2026, 10, 29, 22 + h)).toISOString();
    const mapped = mapLiveRecord(
      record({
        id: ID,
        type: "SleepSessionRecord",
        start: at(0),
        end: at(4),
        stages: [
          { start: at(0), end: at(1), stage: 4 },
          { start: at(1), end: at(2), stage: 0 },
          { start: at(2), end: at(3), stage: 3 },
          { start: at(3), end: at(4), stage: 6 },
        ],
      }),
    );
    expect(mapped).toMatchObject({
      kind: "rows",
      skipped: ["unknown_stage", "out_of_bed"],
    });
    expect(
      mapped.kind === "rows" && mapped.rows.map((r) => [r.sleepStage, r.value]),
    ).toEqual([
      ["CORE", 60],
      ["REM", 60],
    ]);
  });

  it("makes a session without stages one asleep stretch", () => {
    const mapped = mapLiveRecord(
      record({
        id: ID,
        type: "SleepSessionRecord",
        start: "2026-11-29T23:00:00Z",
        end: "2026-11-30T06:00:00Z",
      }),
    );
    expect(mapped.kind === "rows" && mapped.rows).toMatchObject([
      { sleepStage: "ASLEEP", value: 420, externalId: `hc:${ID}` },
    ]);
  });
});

describe("mapHourlyPulse", () => {
  it("puts the mean in the middle of the local hour, as the export's fold does", () => {
    const row = mapHourlyPulse({
      metric: "HEART_RATE_BPM",
      hour: "2026-03-01T07",
      zoneOffsetSeconds: 3600,
      avg: 64.26,
      min: 51,
      max: 92,
    });
    expect(row).toMatchObject({
      type: "PULSE",
      value: 64.3,
      valueMin: 51,
      valueMax: 92,
      // 07:30 local at UTC+1 is 06:30Z.
      measuredAt: new Date("2026-03-01T06:30:00Z"),
      externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T07",
    });
  });
});
