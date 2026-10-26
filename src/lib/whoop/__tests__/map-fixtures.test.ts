/**
 * What each WHOOP mapper makes of a fixed set of payloads, pinned in
 * `__golden__/`.
 *
 * The fixtures under `__fixtures__/` are synthetic payloads in the documented
 * v2 wire shape: scored and unscored records, naps, absent optional fields,
 * zero values, offsets other than UTC, and body values that must be refused.
 * The goldens were written while the mappers still lived in `client.ts`, so a
 * green run after they move proves the move changed nothing.
 *
 * The workout row is built inside `upsertWhoopWorkout`, next to the database
 * write, so only its pure sport lookup (`mapWhoopSportType`) is pinned here.
 */
import { format } from "prettier";
import { describe, expect, it } from "vitest";

import { mapBody, mapCycle, mapRecovery, mapSleep } from "@/lib/whoop/map";
import {
  type WhoopBodyMeasurement,
  type WhoopCycle,
  type WhoopRecovery,
  type WhoopSleep,
} from "@/lib/whoop/wire-types";
import { mapWhoopSportType } from "../sport-map";
import bodyFixture from "./__fixtures__/body.json";
import cycleFixture from "./__fixtures__/cycle.json";
import recoveryFixture from "./__fixtures__/recovery.json";
import sleepFixture from "./__fixtures__/sleep.json";

const recoveries: readonly WhoopRecovery[] = recoveryFixture;
const sleeps: readonly WhoopSleep[] = sleepFixture;
const cycles: readonly WhoopCycle[] = cycleFixture;
const bodies: readonly WhoopBodyMeasurement[] = bodyFixture;

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

describe("WHOOP mappers against the fixture payloads", () => {
  it("maps recoveries", async () => {
    const output = recoveries.map((record) => ({
      sleep_id: record.sleep_id,
      rows: mapRecovery(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-recovery.json",
    );
  });

  it("maps sleeps", async () => {
    const output = sleeps.map((record) => ({
      id: record.id,
      rows: mapSleep(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sleep.json",
    );
  });

  it("maps cycles", async () => {
    const output = cycles.map((record) => ({
      id: record.id,
      rows: mapCycle(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-cycle.json",
    );
  });

  it("maps body measurements", async () => {
    const output = bodies.map((record) => ({
      input: record,
      mapped: mapBody(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-body.json",
    );
  });

  it("resolves workout sports", async () => {
    const inputs: Array<[number | undefined, string | undefined]> = [
      [0, "Running"],
      [1, undefined],
      [52, "ignored when the id resolves"],
      [9999, "Hiking/Rucking"],
      [undefined, "hiking_rucking"],
      [undefined, "  Track & Field  "],
      [undefined, "Functional Fitness"],
      [undefined, "whoop_sport_63"],
      [undefined, "Underwater Basket Weaving"],
      [undefined, "   "],
      [9999, undefined],
      [-1, undefined],
      [undefined, undefined],
    ];
    const output = inputs.map(([sportId, sportName]) => ({
      sportId: sportId ?? null,
      sportName: sportName ?? null,
      sportType: mapWhoopSportType(sportId, sportName),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sport.json",
    );
  });
});
