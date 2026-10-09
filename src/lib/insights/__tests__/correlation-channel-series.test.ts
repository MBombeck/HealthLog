import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SleepStage } from "@/generated/prisma/client";

const measurementFindMany = vi.fn();
const moodFindMany = vi.fn();
const customMetricFindMany = vi.fn();
const environmentFindMany = vi.fn();
const userFindUnique = vi.fn(async () => ({
  environmentAirQualityEnabled: true,
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: () => userFindUnique() },
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    moodEntry: { findMany: (a: unknown) => moodFindMany(a) },
    customMetric: { findMany: (a: unknown) => customMetricFindMany(a) },
    environmentContext: {
      findMany: (a: unknown) => environmentFindMany(a),
    },
  },
}));

import { ENVIRONMENT_FIELDS, POLLEN_COLUMNS } from "@/lib/environment/fields";
import {
  averageWithPreviousDay,
  fetchEnvironmentSeries,
  buildMeasurementDailySeries,
  fetchMeasurementWindowSeries,
  fetchCustomMetricBehaviourSeries,
  MAX_CUSTOM_CORRELATION_CHANNELS,
  fetchMoodWindowSeries,
  toDailyMeans,
  type MeasurementSeriesRow,
} from "@/lib/insights/correlation-channel-series";

/** Build a raw measurement row for `buildMeasurementDailySeries`. */
function row(
  iso: string,
  value: number,
  source: MeasurementSeriesRow["source"] = "APPLE_HEALTH",
  sleepStage: SleepStage | null = null,
  deviceType: string | null = null,
): MeasurementSeriesRow {
  return { at: new Date(iso), value, source, deviceType, sleepStage };
}

describe("buildMeasurementDailySeries — grain consistency (v1.29.6)", () => {
  it("sums (not averages) a cumulative type across mixed per-sample-chunk and drained daily-total rows", () => {
    const rows: MeasurementSeriesRow[] = [
      // 2026-06-04: two ~mid-morning / afternoon per-sample chunks — the
      // "not-yet-drained" shape.
      row("2026-06-04T08:00:00.000Z", 350),
      row("2026-06-04T14:00:00.000Z", 300),
      // 2026-06-05: a single drained `stats:` daily total.
      row("2026-06-05T12:00:00.000Z", 8400),
    ];

    const points = buildMeasurementDailySeries(
      "ACTIVITY_STEPS",
      rows,
      "UTC",
      null,
    );

    expect(points).toEqual([
      { day: "2026-06-04", value: 650 },
      { day: "2026-06-05", value: 8400 },
    ]);

    // The old `toDailyMeans` reduction would have produced meaningless
    // blended figures — pin that the two grains disagree, so a future
    // regression that reverts to `toDailyMeans` for this type is caught.
    const meanPoints = toDailyMeans(
      rows.map((r) => ({ value: r.value, at: r.at })),
      "UTC",
    );
    expect(meanPoints.find((p) => p.day === "2026-06-04")?.value).toBe(325); // mean of 350/300
    expect(meanPoints.find((p) => p.day === "2026-06-05")?.value).toBe(8400); // single row, coincides
  });

  it("collapses overlapping sources to the ladder-canonical reading before summing a cumulative type", () => {
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T08:00:00.000Z", 9000, "APPLE_HEALTH"),
      row("2026-06-04T08:05:00.000Z", 8800, "WITHINGS"),
    ];

    const points = buildMeasurementDailySeries(
      "ACTIVITY_STEPS",
      rows,
      "UTC",
      null,
    );

    // Default `steps` ladder ranks APPLE_HEALTH above WITHINGS — the
    // Withings row must drop out of the sum entirely, not add on top.
    expect(points).toEqual([{ day: "2026-06-04", value: 9000 }]);
  });

  it("sums a night's per-stage segments into one total instead of averaging them", () => {
    // One night: CORE 240 + DEEP 90 + REM 80 = 410 minutes asleep.
    // `measuredAt` is the END of each segment; the reconstructor derives
    // the start from `measuredAt - value minutes` (mirrors sleep-night.test.ts).
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T04:00:00.000Z", 240, "APPLE_HEALTH", "CORE"),
      row("2026-06-04T05:30:00.000Z", 90, "APPLE_HEALTH", "DEEP"),
      row("2026-06-04T07:00:00.000Z", 80, "APPLE_HEALTH", "REM"),
    ];

    const points = buildMeasurementDailySeries(
      "SLEEP_DURATION",
      rows,
      "UTC",
      null,
    );

    expect(points).toHaveLength(1);
    // The pre-fix `toDailyMeans` reduction would have averaged the three
    // segment durations (240 + 90 + 80) / 3 ≈ 137 — a number with no
    // clinical meaning. The correct grain is the night's TOTAL.
    expect(points[0].value).toBe(410);
    expect(points[0].value).not.toBeCloseTo((240 + 90 + 80) / 3, 0);
  });

  it("collapses an overlapping-source night (WHOOP + Apple Health) to one canonical total, never double-counted", () => {
    // Same night, two writers: WHOOP (wins the default `sleep` ladder)
    // reports a shorter granular breakdown; Apple Health separately
    // reports its own (different) total for the same night. Without the
    // writer-dedup a naive per-row collapse could blend or double both.
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T04:00:00.000Z", 200, "WHOOP", "CORE"),
      row("2026-06-04T05:00:00.000Z", 60, "WHOOP", "DEEP"),
      row("2026-06-04T04:30:00.000Z", 300, "APPLE_HEALTH", "CORE"),
    ];

    const points = buildMeasurementDailySeries(
      "SLEEP_DURATION",
      rows,
      "UTC",
      null,
    );

    expect(points).toHaveLength(1);
    // WHOOP wins the default `sleep` ladder — the night's total is the
    // WHOOP-only sum (260), not a blend with Apple Health's 300 and not
    // the two summed together (560).
    expect(points[0].value).toBe(260);
  });

  it("keeps the MEAN grain for spot metrics (unchanged behaviour)", () => {
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T08:00:00.000Z", 60),
      row("2026-06-04T20:00:00.000Z", 64),
    ];

    const points = buildMeasurementDailySeries("PULSE", rows, "UTC", null);

    expect(points).toEqual([{ day: "2026-06-04", value: 62 }]);
  });

  it("makes a pulse day the mean of its local hours' means, not of its readings", () => {
    // A dense workout hour (six readings at 150) and two resting hours at 60.
    // The plain mean would be (6 * 150 + 120) / 8 = 127.5; each hour once
    // gives (150 + 60 + 60) / 3 = 90.
    const rows: MeasurementSeriesRow[] = [
      ...[0, 10, 20, 30, 40, 50].map((m) =>
        row(`2026-06-04T10:${String(m).padStart(2, "0")}:00.000Z`, 150),
      ),
      row("2026-06-04T12:00:00.000Z", 60),
      row("2026-06-04T14:00:00.000Z", 60),
    ];
    expect(buildMeasurementDailySeries("PULSE", rows, "UTC", null)).toEqual([
      { day: "2026-06-04", value: 90 },
    ]);
    // HRV keeps the plain mean of its readings.
    expect(
      buildMeasurementDailySeries("HEART_RATE_VARIABILITY", rows, "UTC", null),
    ).toEqual([{ day: "2026-06-04", value: 127.5 }]);
  });

  it("reads the pulse hours on the profile zone's own clock", () => {
    // Asia/Kolkata (UTC+05:30): 10:20Z and 10:40Z are 15:50 and 16:10 local,
    // two local hours (100 and 40), though one UTC hour.
    const rows: MeasurementSeriesRow[] = [
      row("2026-06-04T10:20:00.000Z", 100),
      row("2026-06-04T10:25:00.000Z", 100),
      row("2026-06-04T10:40:00.000Z", 40),
    ];
    expect(
      buildMeasurementDailySeries("PULSE", rows, "Asia/Kolkata", null),
    ).toEqual([{ day: "2026-06-04", value: 70 }]);
  });
});

describe("fetchMeasurementWindowSeries — desc+cap+resort (v1.30.3 QA F1/F2/F3)", () => {
  beforeEach(() => {
    measurementFindMany.mockReset();
    moodFindMany.mockReset();
  });

  it("orders the read DESC so a capped window keeps the NEWEST rows, then resorts ASC before grouping", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    // Simulate a dense account hitting the cap: the mocked DESC read
    // returns exactly MEASUREMENT_READ_CAP (20000) rows, newest first —
    // the shape a real `orderBy: desc, take: 20000` would produce once the
    // in-window count crosses the cap.
    const CAP = 20000;
    const rowsDesc = Array.from({ length: CAP }, (_, i) => ({
      type: "PULSE",
      value: 60 + (i % 5),
      // i=0 is the NEWEST (closest to now); i=CAP-1 is the oldest kept row.
      measuredAt: new Date(Date.now() - i * 60_000),
      source: "APPLE_HEALTH",
      deviceType: null,
      sleepStage: null,
    }));
    measurementFindMany.mockResolvedValue(rowsDesc);

    const { byType, measurementsCapped } = await fetchMeasurementWindowSeries(
      "u1",
      since,
      ["PULSE"],
    );

    expect(measurementsCapped).toBe(true);
    expect(measurementFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { measuredAt: "desc" }, take: CAP }),
    );
    const pulseRows = byType.get("PULSE")!;
    expect(pulseRows).toHaveLength(CAP);
    // Resorted ASCENDING before being handed to callers — the oldest row
    // in the (capped, most-recent) window comes first.
    for (let i = 1; i < pulseRows.length; i++) {
      expect(pulseRows[i].at.getTime()).toBeGreaterThanOrEqual(
        pulseRows[i - 1].at.getTime(),
      );
    }
    // The NEWEST row (i=0 in the desc mock) must have survived the cap —
    // a naive `orderBy: asc, take: N` would have dropped it instead.
    const newest = pulseRows[pulseRows.length - 1];
    expect(newest.at.getTime()).toBe(rowsDesc[0].measuredAt.getTime());
  });

  it("reports measurementsCapped:false when the read comes in under the cap", async () => {
    measurementFindMany.mockResolvedValue([
      {
        type: "PULSE",
        value: 60,
        measuredAt: new Date(),
        source: "MANUAL",
        deviceType: null,
        sleepStage: null,
      },
    ]);
    const { measurementsCapped } = await fetchMeasurementWindowSeries(
      "u1",
      new Date(),
      ["PULSE"],
    );
    expect(measurementsCapped).toBe(false);
  });
});

describe("fetchMoodWindowSeries — desc+cap+resort", () => {
  beforeEach(() => {
    measurementFindMany.mockReset();
    moodFindMany.mockReset();
  });

  it("orders the mood read DESC so a capped window keeps the NEWEST entries", async () => {
    const CAP = 5000;
    const rowsDesc = Array.from({ length: CAP }, (_, i) => ({
      score: 3 + (i % 3),
      moodLoggedAt: new Date(Date.now() - i * 60_000),
    }));
    moodFindMany.mockResolvedValue(rowsDesc);

    const { moodCapped } = await fetchMoodWindowSeries(
      "u1",
      "UTC",
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(moodCapped).toBe(true);
    expect(moodFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { moodLoggedAt: "desc" }, take: CAP }),
    );
  });
});

describe("fetchCustomMetricBehaviourSeries", () => {
  beforeEach(() => {
    customMetricFindMany.mockReset();
  });

  it("reads only active opted-in owner metrics with a deterministic cap", async () => {
    customMetricFindMany.mockResolvedValue([]);

    await fetchCustomMetricBehaviourSeries(
      "owner-1",
      "Europe/Berlin",
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(customMetricFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "owner-1",
          deletedAt: null,
          correlationEnabled: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: MAX_CUSTOM_CORRELATION_CHANNELS,
      }),
    );
  });

  it("keeps metric identity, drops historical units, and averages same-local-day values", async () => {
    customMetricFindMany.mockResolvedValue([
      {
        id: "grip-id",
        name: "Grip strength",
        unit: "kg",
        entries: [
          {
            value: 40,
            unit: "kg",
            measuredAt: new Date("2026-07-01T08:00:00.000Z"),
          },
          {
            value: 44,
            unit: "kg",
            measuredAt: new Date("2026-07-01T18:00:00.000Z"),
          },
          {
            value: 100,
            unit: "lb",
            measuredAt: new Date("2026-07-01T20:00:00.000Z"),
          },
        ],
      },
    ]);

    const result = await fetchCustomMetricBehaviourSeries(
      "owner-1",
      "UTC",
      new Date("2026-01-01T00:00:00.000Z"),
    );

    expect(result).toEqual([
      {
        key: "CUSTOM_METRIC:grip-id",
        label: "Grip strength",
        role: "behaviour",
        points: [{ day: "2026-07-01", value: 42 }],
      },
    ]);
  });
});

describe("environment exposure: the averaged lag 0–1 window (v1.42)", () => {
  it("averages each day with the day before, and only where both exist", () => {
    const out = averageWithPreviousDay([
      { day: "2026-05-03", value: 14 },
      { day: "2026-05-01", value: 10 },
      { day: "2026-05-02", value: 12 },
      // 05-04 missing: neither 05-04 nor 05-05 gets a point.
      { day: "2026-05-05", value: 20 },
      { day: "2026-05-06", value: 22 },
    ]);
    expect(out).toEqual([
      { day: "2026-05-02", value: 11 },
      { day: "2026-05-03", value: 13 },
      { day: "2026-05-06", value: 21 },
    ]);
  });

  it("crosses a month and a year boundary on calendar days", () => {
    expect(
      averageWithPreviousDay([
        { day: "2025-12-31", value: 2 },
        { day: "2026-01-01", value: 4 },
      ]),
    ).toEqual([{ day: "2026-01-01", value: 3 }]);
  });

  it("tags every environment channel lagDays 0 over averaged points", async () => {
    environmentFindMany.mockResolvedValueOnce([
      { date: "2026-05-01", tempMin: 8, tempMean: 12, sunshineSec: 3600 },
      { date: "2026-05-02", tempMin: 10, tempMean: 14, sunshineSec: 7200 },
    ]);
    const series = await fetchEnvironmentSeries(
      "u1",
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(series.length).toBeGreaterThan(0);
    for (const s of series) {
      expect(s.lagDays, s.key).toBe(0);
      expect(s.role).toBe("behaviour");
    }
    const tMin = series.find((s) => s.key === "ENV_TEMP_MIN")!;
    // The night before 05-02 and its morning: (8 + 10) / 2, keyed on 05-02.
    expect(tMin.points).toEqual([{ day: "2026-05-02", value: 9 }]);
    const sun = series.find((s) => s.key === "ENV_SUNSHINE")!;
    expect(sun.points).toEqual([{ day: "2026-05-02", value: 1.5 }]);
  });
});

describe("environment exposure: the air-quality channels (v1.42, #615)", () => {
  beforeEach(() => {
    environmentFindMany.mockReset();
    userFindUnique.mockReset();
    userFindUnique.mockResolvedValue({ environmentAirQualityEnabled: true });
    vi.unstubAllEnvs();
  });

  it("selects every column a channel reads (an unselected column reads as never covered)", async () => {
    environmentFindMany.mockResolvedValueOnce([]);
    await fetchEnvironmentSeries("u1", new Date("2026-04-01T00:00:00Z"));
    const select = (
      environmentFindMany.mock.calls[0][0] as {
        select: Record<string, boolean>;
      }
    ).select;
    const read = ENVIRONMENT_FIELDS.flatMap((f) =>
      f.column === "pollenMax" ? [...POLLEN_COLUMNS] : [f.column],
    );
    for (const column of read) expect(select[column], column).toBe(true);
  });

  it("adds exactly three air-quality channels", () => {
    expect(
      ENVIRONMENT_FIELDS.filter((f) => f.airQuality).map((f) => f.key),
    ).toEqual(["ENV_PM25", "ENV_OZONE_8H", "ENV_POLLEN_MAX"]);
  });

  it("takes the pollen high over the covered kinds, never a zero for the uncovered", async () => {
    environmentFindMany.mockResolvedValueOnce([
      {
        date: "2026-05-01",
        pm25Mean: 10,
        o3Max8h: 80,
        pollenBirchMax: 40,
        pollenGrassMax: null,
        pollenAlderMax: null,
      },
      {
        date: "2026-05-02",
        pm25Mean: 14,
        o3Max8h: null,
        pollenBirchMax: null,
        pollenGrassMax: 20,
        pollenAlderMax: 2,
      },
      // A day the feed did not cover at all: no point, not a zero.
      { date: "2026-05-03", pm25Mean: null, o3Max8h: null },
    ]);
    const series = await fetchEnvironmentSeries(
      "u1",
      new Date("2026-04-01T00:00:00Z"),
    );
    const by = (key: string) => series.find((s) => s.key === key)!.points;
    expect(by("ENV_POLLEN_MAX")).toEqual([{ day: "2026-05-02", value: 30 }]);
    expect(by("ENV_PM25")).toEqual([{ day: "2026-05-02", value: 12 }]);
    // Ozone is missing on 05-02, so no averaged point anywhere.
    expect(by("ENV_OZONE_8H")).toEqual([]);
  });

  it("leaves the air-quality channels empty when the account turned air quality off", async () => {
    userFindUnique.mockResolvedValue({ environmentAirQualityEnabled: false });
    environmentFindMany.mockResolvedValueOnce([
      { date: "2026-05-01", pm25Mean: 10, tempMin: 5 },
      { date: "2026-05-02", pm25Mean: 14, tempMin: 7 },
    ]);
    const series = await fetchEnvironmentSeries(
      "u1",
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(series.find((s) => s.key === "ENV_PM25")!.points).toEqual([]);
    expect(series.find((s) => s.key === "ENV_TEMP_MIN")!.points).toEqual([
      { day: "2026-05-02", value: 6 },
    ]);
  });

  it("leaves them empty when the operator turned air quality off", async () => {
    vi.stubEnv("ENVIRONMENT_AIR_QUALITY_DISABLED", "1");
    environmentFindMany.mockResolvedValueOnce([
      { date: "2026-05-01", pm25Mean: 10 },
      { date: "2026-05-02", pm25Mean: 14 },
    ]);
    const series = await fetchEnvironmentSeries(
      "u1",
      new Date("2026-04-01T00:00:00Z"),
    );
    expect(series.find((s) => s.key === "ENV_PM25")!.points).toEqual([]);
  });
});
