import { describe, expect, it } from "vitest";

import { mapActivity, summaryHasHeartRate } from "@/lib/strava/map";
import {
  type StravaSummaryActivity,
  type StravaDetailedActivity,
} from "@/lib/strava/wire-types";
import { classifyStravaResponse } from "../response-classifier";

const baseSummary: StravaSummaryActivity = {
  id: 123456,
  name: "Morning Run",
  distance: 5000,
  moving_time: 1500,
  elapsed_time: 1600,
  total_elevation_gain: 42,
  type: "Run",
  sport_type: "TrailRun",
  start_date: "2026-07-01T06:30:00Z",
};

describe("mapActivity", () => {
  it("maps a summary-only activity (no detail → no calories)", () => {
    const row = mapActivity({
      ...baseSummary,
      average_heartrate: 148,
      max_heartrate: 171,
    });
    expect(row).not.toBeNull();
    expect(row!.externalId).toBe("123456");
    // sport_type "TrailRun" maps to the canonical "running" bucket.
    expect(row!.sportType).toBe("running");
    expect(row!.startedAt.toISOString()).toBe("2026-07-01T06:30:00.000Z");
    // endedAt = start + elapsed_time (clock window), not moving_time.
    expect(row!.endedAt.toISOString()).toBe("2026-07-01T06:56:40.000Z");
    // durationSec prefers moving_time.
    expect(row!.durationSec).toBe(1500);
    expect(row!.totalDistanceM).toBe(5000);
    expect(row!.elevationM).toBe(42);
    expect(row!.avgHeartRate).toBe(148);
    expect(row!.maxHeartRate).toBe(171);
    // No detail → calories null.
    expect(row!.totalEnergyKcal).toBeNull();
  });

  it("fills calories + HR from the DetailedActivity when the summary lacks them", () => {
    const summary: StravaSummaryActivity = { ...baseSummary };
    delete (summary as unknown as Record<string, unknown>).average_heartrate;
    const detail: StravaDetailedActivity = {
      ...baseSummary,
      average_heartrate: 150,
      max_heartrate: 175,
      calories: 480,
    };
    const row = mapActivity(summary, detail);
    expect(row!.totalEnergyKcal).toBe(480);
    expect(row!.avgHeartRate).toBe(150);
    expect(row!.maxHeartRate).toBe(175);
  });

  it("keeps the activity name in metadata as data, never surfaced as a field", () => {
    const row = mapActivity(baseSummary);
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.stravaName).toBe("Morning Run");
    // The row shape has no top-level name/description — free-text stays in meta.
    expect((row as unknown as Record<string, unknown>).name).toBeUndefined();
  });

  it("falls back to `type` then a generic label for the sport, always canonical", () => {
    const noSport: StravaSummaryActivity = { ...baseSummary };
    delete (noSport as unknown as Record<string, unknown>).sport_type;
    // Falls back to `type: "Run"` → canonical "running".
    expect(mapActivity(noSport)!.sportType).toBe("running");
    const meta = mapActivity(noSport)!.metadata as Record<string, unknown>;
    expect(meta.stravaType).toBe("Run");

    const noneAtAll: StravaSummaryActivity = { ...baseSummary };
    delete (noneAtAll as unknown as Record<string, unknown>).sport_type;
    delete (noneAtAll as unknown as Record<string, unknown>).type;
    // No sport info at all → generic "Workout" fallback → canonical "other".
    expect(mapActivity(noneAtAll)!.sportType).toBe("other");
    const noneMeta = mapActivity(noneAtAll)!.metadata as Record<
      string,
      unknown
    >;
    expect(noneMeta.stravaType).toBe("Workout");
  });

  it("keeps the raw sport_type label in metadata even though sportType is canonical", () => {
    const row = mapActivity(baseSummary); // sport_type: "TrailRun"
    const meta = row!.metadata as Record<string, unknown>;
    expect(row!.sportType).toBe("running");
    expect(meta.stravaType).toBe("TrailRun");
  });

  it("never writes a raw Strava sport label into sportType, even for an unrecognised value", () => {
    const row = mapActivity({ ...baseSummary, sport_type: "SomeNewSport" });
    expect(row!.sportType).toBe("other");
    const meta = row!.metadata as Record<string, unknown>;
    expect(meta.stravaType).toBe("SomeNewSport");
  });

  it("returns null for an activity with no id or no start instant", () => {
    expect(
      mapActivity({ ...baseSummary, id: undefined as unknown as number }),
    ).toBeNull();
    const noStart: StravaSummaryActivity = { ...baseSummary };
    delete (noStart as unknown as Record<string, unknown>).start_date;
    expect(mapActivity(noStart)).toBeNull();
  });

  it("drops negative / non-finite numeric fields rather than storing them", () => {
    const row = mapActivity({
      ...baseSummary,
      distance: -1,
      average_heartrate: -5,
    });
    expect(row!.totalDistanceM).toBeNull();
    expect(row!.avgHeartRate).toBeNull();
  });
});

describe("summaryHasHeartRate", () => {
  it("detects HR presence via flag or values", () => {
    expect(summaryHasHeartRate({ id: 1, has_heartrate: true })).toBe(true);
    expect(summaryHasHeartRate({ id: 1, average_heartrate: 140 })).toBe(true);
    expect(summaryHasHeartRate({ id: 1 })).toBe(false);
  });
});

describe("classifyStravaResponse", () => {
  it("classifies the status classes the sync depends on", () => {
    expect(classifyStravaResponse(200).classification).toBe("success");
    expect(classifyStravaResponse(401).classification).toBe("reauth_required");
    expect(classifyStravaResponse(429).classification).toBe("transient");
    expect(classifyStravaResponse(500).classification).toBe("transient");
  });
});
