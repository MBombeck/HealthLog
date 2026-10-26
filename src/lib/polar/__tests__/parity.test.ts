import { describe, expect, it } from "vitest";

import { mapExercise } from "@/lib/polar/map";
import { type PolarExercise } from "@/lib/polar/wire-types";
import { mapActivity as mapStravaActivity } from "@/lib/strava/map";
import {
  type StravaSummaryActivity,
  type StravaDetailedActivity,
} from "@/lib/strava/wire-types";

/**
 * Sensitive-cohort parity guard (mirrors the google-parity precedent): the SAME
 * logical workout fed through the Polar mapper and the Strava mapper must land
 * as a downstream-indistinguishable `Workout` row — same canonical sport
 * bucket, same units (metres / kcal / seconds), same HR, same start instant,
 * same null-vs-zero conventions. This pins the contract "a Polar row is
 * indistinguishable downstream from any other provider's row".
 *
 * The logical workout: a 45-minute road run starting 2026-07-01T06:30:00Z,
 * 10 000 m, 500 kcal, avg HR 150, max HR 175.
 */
const START_ISO = "2026-07-01T06:30:00Z";
const DURATION_SEC = 45 * 60;
const DISTANCE_M = 10_000;
const CALORIES = 500;
const AVG_HR = 150;
const MAX_HR = 175;

const polar: PolarExercise = {
  id: 12345,
  // Naive local wall-clock + zero offset === the same UTC instant as START_ISO.
  start_time: "2026-07-01T06:30:00",
  start_time_utc_offset: 0,
  duration: "PT45M",
  sport: "RUNNING",
  detailed_sport_info: "ROAD_RUNNING",
  calories: CALORIES,
  distance: DISTANCE_M,
  heart_rate: { average: AVG_HR, maximum: MAX_HR },
};

const stravaSummary: StravaSummaryActivity = {
  id: 67890,
  sport_type: "Run",
  start_date: START_ISO,
  moving_time: DURATION_SEC,
  elapsed_time: DURATION_SEC,
  distance: DISTANCE_M,
  average_heartrate: AVG_HR,
  max_heartrate: MAX_HR,
};
const stravaDetail: StravaDetailedActivity = {
  ...stravaSummary,
  calories: CALORIES,
};

describe("Polar ↔ Strava mapper parity", () => {
  const p = mapExercise(polar)!;
  const s = mapStravaActivity(stravaSummary, stravaDetail)!;

  it("produces the same canonical sport bucket", () => {
    expect(p.sportType).toBe("running");
    expect(p.sportType).toBe(s.sportType);
  });

  it("produces the same start instant", () => {
    expect(p.startedAt.getTime()).toBe(Date.parse(START_ISO));
    expect(p.startedAt.getTime()).toBe(s.startedAt.getTime());
  });

  it("produces the same duration in seconds and a non-inverted window", () => {
    expect(p.durationSec).toBe(DURATION_SEC);
    expect(p.durationSec).toBe(s.durationSec);
    expect(p.endedAt.getTime()).toBeGreaterThanOrEqual(p.startedAt.getTime());
    expect(s.endedAt.getTime()).toBeGreaterThanOrEqual(s.startedAt.getTime());
  });

  it("produces the same distance in metres", () => {
    expect(p.totalDistanceM).toBe(DISTANCE_M);
    expect(p.totalDistanceM).toBe(s.totalDistanceM);
  });

  it("produces the same energy in kcal", () => {
    expect(p.totalEnergyKcal).toBe(CALORIES);
    expect(p.totalEnergyKcal).toBe(s.totalEnergyKcal);
  });

  it("produces the same heart-rate fields", () => {
    expect(p.avgHeartRate).toBe(AVG_HR);
    expect(p.maxHeartRate).toBe(MAX_HR);
    expect(p.avgHeartRate).toBe(s.avgHeartRate);
    expect(p.maxHeartRate).toBe(s.maxHeartRate);
  });

  it("shares the null-vs-absent convention for a field neither summary carries", () => {
    // Polar has no elevation on the exercise summary → null; a Strava activity
    // with no elevation gain also maps elevation to null. Both use `null`, not
    // 0, for "not present".
    expect(p.elevationM).toBeNull();
    const sNoElev = mapStravaActivity(stravaSummary, stravaDetail)!;
    expect(sNoElev.elevationM).toBeNull();
  });
});
