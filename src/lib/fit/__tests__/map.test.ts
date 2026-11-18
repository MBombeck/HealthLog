import { describe, expect, it } from "vitest";

import {
  buildBikeComputerActivity,
  buildWatchActivity,
} from "../../../../tests/fixtures/fit/build-fit";
import { FitImportError } from "../errors";
import { fitExternalId, validateFitDrafts } from "../import";
import { buildFitSamples, mapFitActivity } from "../map";
import { decodeFitFile } from "../parse";
import { mapFitSportType } from "../sport-map";

const START = new Date("2026-10-01T08:00:00Z");
const NOW = new Date("2026-10-02T00:00:00Z");

async function mapFile(file: Buffer, keepRoutes = true) {
  const { decoded } = await decodeFitFile(file);
  return mapFitActivity(decoded, {
    externalIdFor: (ms) => fitExternalId("ab".repeat(32), ms),
    keepRoutes,
    now: NOW,
  });
}

describe("mapFitActivity, watch style (full timestamps, GPS)", () => {
  it("maps the session to a workout and the records to a series", async () => {
    const { drafts, sessionsSkipped } = await mapFile(
      buildWatchActivity({ start: START, seconds: 600 }),
    );
    expect(sessionsSkipped).toBe(0);
    expect(drafts).toHaveLength(1);
    const w = drafts[0]!;
    expect(w.sportType).toBe("running");
    expect(w.startedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(w.endedAt).toBe("2026-10-01T08:10:00.000Z");
    expect(w.externalId).toBe(
      `fit:${"ab".repeat(20)}:${START.getTime() / 1000}`,
    );
    expect(w.totalDistanceM).toBeCloseTo(1860, 5);
    expect(w.totalEnergyKcal).toBe(100);
    expect(w.avgHeartRate).toBe(135);
    expect(w.maxHeartRate).toBe(149);
    expect(w.minHeartRate).toBe(120);
    expect(w.elevationM).toBe(42);
    expect(w.pauseDurationSec).toBe(10);
    expect(w.metadata).toMatchObject({
      importFormat: "fit",
      fitManufacturer: "garmin",
      fitSport: "running",
      fitSubSport: "generic",
      fitLaps: 1,
    });
    expect(w.samples).toHaveLength(600);
    expect(w.samples![0]).toEqual({
      t: "2026-10-01T08:00:00.000Z",
      hr: 120,
      speedMs: 3.1,
      cadence: 85,
    });
    expect(w.route?.geometry.coordinates).toHaveLength(600);
    expect(w.route?.geometry.coordinates[0]).toHaveLength(3);
    expect(w.route?.sampleTimestamps).toHaveLength(600);
  });

  it("keeps no track while the account keeps none", async () => {
    const { drafts } = await mapFile(
      buildWatchActivity({ start: START, seconds: 60 }),
      false,
    );
    expect(drafts[0]!.route).toBeUndefined();
    expect(drafts[0]!.samples).toHaveLength(60);
  });

  it("drops implausible heart rates instead of clamping them", async () => {
    const { drafts } = await mapFile(
      buildWatchActivity({
        start: START,
        seconds: 30,
        hr: (i) => (i === 3 ? 254 : i === 4 ? 12 : i === 5 ? null : 130),
      }),
    );
    const hrs = drafts[0]!.samples!.map((s) => s.hr);
    expect(hrs).not.toContain(254);
    expect(hrs).not.toContain(12);
    expect(hrs.filter((v) => v === undefined)).toHaveLength(3);
  });

  it("passes the workout schema", async () => {
    const { drafts } = await mapFile(
      buildWatchActivity({ start: START, seconds: 300 }),
    );
    const { entries, invalid } = validateFitDrafts(drafts);
    expect(invalid).toBe(0);
    expect(entries[0]!.samples).toHaveLength(300);
  });

  it("refuses a FIT file that is not an activity", async () => {
    const file = buildWatchActivity({ start: START, seconds: 10, fileType: 6 });
    await expect(mapFile(file)).rejects.toMatchObject({ code: "not_activity" });
  });
});

describe("mapFitActivity, bike computer style (compressed timestamps, developer fields)", () => {
  it("reads every record of a compressed-timestamp file", async () => {
    const { drafts } = await mapFile(
      buildBikeComputerActivity({ start: START, seconds: 120 }),
    );
    const w = drafts[0]!;
    expect(w.sportType).toBe("cycling");
    expect(w.samples).toHaveLength(120);
    expect(w.samples![1]).toEqual({
      t: "2026-10-01T08:00:01.000Z",
      hr: 111,
      speedMs: 8.201,
      power: 181,
      cadence: 88,
    });
    expect(w.metadata).toMatchObject({
      fitManufacturer: "wahoo_fitness",
      avgPowerW: 200,
    });
    // Session carries no heart rate; the series fills average and peak.
    expect(w.avgHeartRate).toBeGreaterThan(110);
    expect(w.maxHeartRate).toBe(149);
    // No positions in the file: no track.
    expect(w.route).toBeUndefined();
  });

  it("is not polluted by hostile developer field names", async () => {
    const file = buildBikeComputerActivity({
      start: START,
      seconds: 40,
      developerFieldNames: ["__proto__", "constructor"],
    });
    const { decoded } = await decodeFitFile(file);
    const probe: Record<string, unknown> = {};
    expect(probe.polluted).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(({} as { constructor: unknown }).constructor).toBe(Object);
    const { drafts } = mapFitActivity(decoded, {
      externalIdFor: () => "fit:x:1",
      keepRoutes: true,
      now: NOW,
    });
    const sample = drafts[0]!.samples![5]!;
    expect(Object.keys(sample).sort()).toEqual(
      ["cadence", "hr", "power", "speedMs", "t"].sort(),
    );
    expect(Object.getPrototypeOf(sample)).toBe(Object.prototype);
    expect(Object.keys(drafts[0]!.metadata)).not.toContain("constructor");
    expect(validateFitDrafts(drafts).invalid).toBe(0);
  });

  it("reads past a developer field that shadows a profile field name", async () => {
    const file = buildBikeComputerActivity({
      start: START,
      seconds: 20,
      developerFieldNames: ["heart_rate_dev", "hasOwnProperty"],
    });
    const { drafts } = await mapFile(file);
    expect(drafts[0]!.samples).toHaveLength(20);
  });
});

describe("buildFitSamples", () => {
  it("averages a series longer than the cap into equal buckets", () => {
    const points = Array.from({ length: 45_000 }, (_, i) => ({
      t: START.getTime() + i * 1000,
      hr: i % 2 === 0 ? 100 : 110,
      speedMs: null,
      power: i % 2 === 0 ? 200 : 300,
      cadence: null,
      lat: null,
      lon: null,
      ele: null,
    }));
    const samples = buildFitSamples(points);
    expect(samples.length).toBeLessThanOrEqual(30_000);
    expect(samples).toHaveLength(22_500);
    expect(samples[0]).toEqual({
      t: START.toISOString(),
      hr: 105,
      power: 250,
    });
  });

  it("skips records that carry no channel", () => {
    const samples = buildFitSamples([
      {
        t: 0,
        hr: null,
        speedMs: null,
        power: null,
        cadence: null,
        lat: 1,
        lon: 1,
        ele: null,
      },
    ]);
    expect(samples).toEqual([]);
  });
});

describe("mapFitSportType", () => {
  it.each([
    ["running", "treadmill", "running"],
    ["cycling", "indoor_cycling", "cycling"],
    ["e_biking", "generic", "cycling"],
    ["training", "strength_training", "strength"],
    ["training", "yoga", "yoga"],
    ["fitness_equipment", "elliptical", "elliptical"],
    ["fitness_equipment", "indoor_rowing", "rowing"],
    ["racket", "padel", "tennis"],
    ["racket", "badminton", "badminton"],
    ["swimming", "lap_swimming", "swimming"],
    ["hiking", "generic", "hiking"],
    ["alpine_skiing", "resort", "other"],
    [42, 7, "other"],
    [undefined, undefined, "other"],
  ])("%s / %s → %s", (sport, sub, expected) => {
    expect(mapFitSportType(sport, sub)).toBe(expected);
  });
});

describe("decode refusals", () => {
  it("never passes a damaged file to the decoder", async () => {
    const file = Buffer.from(buildWatchActivity({ start: START, seconds: 30 }));
    file[60] ^= 0x10;
    await expect(decodeFitFile(file)).rejects.toBeInstanceOf(FitImportError);
    await expect(decodeFitFile(file)).rejects.toMatchObject({
      code: "crc_mismatch",
    });
  });
});
