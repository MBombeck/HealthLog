import { describe, expect, it } from "vitest";

import { resolveRecordBenchmark } from "../record-benchmark";

const DOB_1981 = new Date("1981-06-15T00:00:00.000Z");
const at = (iso: string) => new Date(iso);

const profile = {
  dateOfBirth: DOB_1981,
  sex: "MALE" as const,
  heightCm: 180,
  weightKg: 80,
  timezone: "UTC",
};

function record(
  metricType: Parameters<typeof resolveRecordBenchmark>[0]["metricType"],
  unit: string,
  achievedAt = "2026-07-01T08:00:00.000Z",
  metricSlot: string | null = null,
) {
  return { metricType, unit, metricSlot, achievedAt: at(achievedAt) };
}

describe("resolveRecordBenchmark", () => {
  it("gives a 45-year-old man's VO2 max record the FRIEND band in its unit", () => {
    const band = resolveRecordBenchmark(
      record("VO2_MAX", "mL/(kg·min)"),
      profile,
    );
    expect(band).not.toBeNull();
    expect(band!.unit).toBe("mL/(kg·min)");
    expect(band!.source).toBe("friend_2015");
    expect(band!.sourceLabel).toContain("Kaminsky");
    // Between the 40s (35–45) and 50s (31–41) bands.
    expect(band!.low).toBeGreaterThanOrEqual(31);
    expect(band!.low).toBeLessThanOrEqual(35);
    expect(band!.high).toBeGreaterThanOrEqual(41);
    expect(band!.high).toBeLessThanOrEqual(45);
  });

  it("uses the age the record was set at, not today's", () => {
    const old = resolveRecordBenchmark(
      record("VO2_MAX", "mL/(kg·min)", "2004-07-01T08:00:00.000Z"),
      profile,
    );
    // 23 then: below the 20s bracket centre, so the 20s male band itself.
    expect(old).toMatchObject({ low: 42, high: 53 });
  });

  it("returns null for a metric without a cited norm", () => {
    expect(
      resolveRecordBenchmark(record("ACTIVITY_STEPS", "steps"), profile),
    ).toBeNull();
  });

  it("returns null without a date of birth", () => {
    expect(
      resolveRecordBenchmark(record("VO2_MAX", "mL/(kg·min)"), {
        ...profile,
        dateOfBirth: null,
      }),
    ).toBeNull();
  });

  it("returns null for a sex-split table without a sex", () => {
    expect(
      resolveRecordBenchmark(record("VO2_MAX", "mL/(kg·min)"), {
        ...profile,
        sex: undefined,
      }),
    ).toBeNull();
  });

  it("returns null for a record stored in another unit, never converted on a guess", () => {
    expect(
      resolveRecordBenchmark(record("GRIP_STRENGTH", "lb"), profile),
    ).toBeNull();
  });

  it("accepts a spelling of the canonical unit", () => {
    expect(
      resolveRecordBenchmark(record("RESPIRATORY_RATE", "count/min"), profile),
    ).toMatchObject({ unit: "count/min", source: "who_pals" });
  });

  it("returns null for a per-sport slot", () => {
    expect(
      resolveRecordBenchmark(
        record("WALKING_RUNNING_DISTANCE", "m", undefined, "running_5km_time"),
        profile,
      ),
    ).toBeNull();
  });

  it("places a six-minute walk between 80 % of the predicted distance and the prediction", () => {
    const band = resolveRecordBenchmark(
      record("SIX_MINUTE_WALK_DISTANCE", "m"),
      profile,
    );
    // Enright & Sherrill, man, 45 y, 180 cm, 80 kg.
    const predicted = 7.57 * 180 - 5.02 * 45 - 1.76 * 80 - 309;
    expect(band).toEqual({
      low: Math.round(predicted * 0.8),
      high: Math.round(predicted),
      unit: "m",
      source: "enright_sherrill_1998",
      sourceLabel: "Enright & Sherrill 1998",
    });
    expect(
      resolveRecordBenchmark(record("SIX_MINUTE_WALK_DISTANCE", "m"), {
        ...profile,
        weightKg: null,
      }),
    ).toBeNull();
  });
});
