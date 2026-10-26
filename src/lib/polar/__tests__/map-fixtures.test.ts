/**
 * What each Polar mapper makes of a fixed set of payloads, pinned in
 * `__golden__/`.
 *
 * The fixtures under `__fixtures__/` are synthetic payloads in the documented
 * AccessLink wire shape: complete and sparse records, zero and negative
 * values, missing or unparseable dates and sleep windows, offsets other than
 * UTC, and exercise ids of either type. The date-keyed mappers run once per
 * zone (none, Europe/Berlin, America/New_York), because the zone decides
 * where a day's noon anchor lands. The goldens were written while the mappers
 * still lived in `client.ts`, so a green run after they move proves the move
 * changed nothing.
 */
import { format } from "prettier";
import { describe, expect, it } from "vitest";

import {
  combinePolarStart,
  mapActivity,
  mapCardioLoad,
  mapExercise,
  mapNightlyRecharge,
  mapSleep,
  mapSpo2,
  normaliseExerciseList,
  parseIsoDuration,
} from "@/lib/polar/map";
import {
  type PolarActivity,
  type PolarCardioLoad,
  type PolarExercise,
  type PolarNightlyRecharge,
  type PolarSleep,
  type PolarSpo2,
} from "@/lib/polar/wire-types";
import activityFixture from "./__fixtures__/activity.json";
import cardioLoadFixture from "./__fixtures__/cardio-load.json";
import exercisesFixture from "./__fixtures__/exercises.json";
import nightlyRechargeFixture from "./__fixtures__/nightly-recharge.json";
import sleepFixture from "./__fixtures__/sleep.json";
import spo2Fixture from "./__fixtures__/spo2.json";

const recharges: readonly PolarNightlyRecharge[] = nightlyRechargeFixture;
const sleeps: readonly PolarSleep[] = sleepFixture;
const activities: readonly PolarActivity[] = activityFixture;
const cardioLoads: readonly PolarCardioLoad[] = cardioLoadFixture;
const spo2Tests: readonly PolarSpo2[] = spo2Fixture;
const exercises: readonly PolarExercise[] = exercisesFixture;

const ZONES = [undefined, "Europe/Berlin", "America/New_York"] as const;

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

/**
 * A mapper's result, or the error it throws. An unparseable date throws once
 * a zone is in play (the noon anchor is computed through `Intl`), and that
 * behaviour is part of what the golden pins.
 */
function attempt(run: () => unknown): unknown {
  try {
    return run();
  } catch (err) {
    return {
      threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/** Every record mapped once per zone, labelled so a diff names its input. */
function perZone<T>(
  records: readonly T[],
  label: (record: T) => string,
  map: (record: T, tz?: string) => unknown,
) {
  return records.map((record) => ({
    record: label(record),
    byZone: ZONES.map((tz) => ({
      tz: tz ?? null,
      rows: attempt(() => map(record, tz)),
    })),
  }));
}

describe("Polar mappers against the fixture payloads", () => {
  it("maps nightly recharges", async () => {
    const output = perZone(recharges, (r) => r.date, mapNightlyRecharge);
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-nightly-recharge.json",
    );
  });

  it("maps sleeps", async () => {
    const output = perZone(sleeps, (s) => s.date, mapSleep);
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sleep.json",
    );
  });

  it("maps daily activity", async () => {
    const output = perZone(
      activities,
      (a) => a.start_time ?? "(no start_time)",
      mapActivity,
    );
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-activity.json",
    );
  });

  it("maps cardio load", async () => {
    const output = perZone(cardioLoads, (c) => c.date, mapCardioLoad);
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-cardio-load.json",
    );
  });

  it("maps SpO2 tests", async () => {
    const output = spo2Tests.map((record) => ({
      test_time: record.test_time ?? null,
      rows: mapSpo2(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-spo2.json",
    );
  });

  it("maps exercises", async () => {
    const output = exercises.map((record) => ({
      id: record.id ?? null,
      row: mapExercise(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-exercises.json",
    );
  });

  it("normalises exercise list bodies, combines start times and parses durations", async () => {
    const one = { id: "exercise-0001" };
    const bodies: Array<[string, unknown]> = [
      ["bare array", [one]],
      ["exercises key", { exercises: [one] }],
      ["data key", { data: [one] }],
      ["items key", { items: [one] }],
      ["records key", { records: [one] }],
      ["first known key wins", { records: [{ id: "b" }], exercises: [one] }],
      ["empty known key", { exercises: [] }],
      ["unknown key", { results: [one] }],
      ["known key not an array", { exercises: one }],
      ["null", null],
      ["empty string", ""],
      ["number", 42],
    ];
    const starts: Array<
      [string | null | undefined, number | null | undefined]
    > = [
      ["2026-03-02T07:00:00", 60],
      ["2026-03-02T07:00:00", -300],
      ["2026-03-02T07:00:00", 0],
      ["2026-03-02T07:00:00", null],
      ["2026-03-02T07:00:00", Number.NaN],
      ["2026-03-02T07:00:00.500", 330],
      ["2026-03-02T07:00:00Z", 120],
      ["2026-03-02T07:00:00+02:00", 120],
      ["2026-03-02T07:00:00-0500", -300],
      ["  2026-03-02T07:00:00  ", 60],
      ["garbled", 60],
      ["", 60],
      ["   ", 60],
      [null, 60],
      [undefined, undefined],
    ];
    const durations: Array<string | null | undefined> = [
      "PT2H44M30S",
      "PT45S",
      "PT45M",
      "P1DT2H",
      "P2D",
      "PT30M15.6S",
      "PT0.4S",
      "pt1h",
      " PT10M ",
      "PT",
      "P",
      "PT-5M",
      "1:02:30",
      "",
      null,
      undefined,
    ];
    const output = {
      normaliseExerciseList: bodies.map(([label, body]) => ({
        label,
        result: normaliseExerciseList(body),
      })),
      combinePolarStart: starts.map(([startTime, offset]) => ({
        startTime: startTime ?? null,
        offset: offset === undefined ? "(undefined)" : String(offset),
        result: combinePolarStart(startTime, offset),
      })),
      parseIsoDuration: durations.map((raw) => ({
        raw: raw === undefined ? "(undefined)" : raw,
        seconds: parseIsoDuration(raw),
      })),
    };
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-helpers.json",
    );
  });
});
