/**
 * What each Oura mapper makes of a fixed set of payloads, pinned in
 * `__golden__/map-<resource>.json`.
 *
 * The fixtures under `__fixtures__/` are synthetic records in the documented
 * Oura v2 wire shape, chosen to walk every branch the mappers have: a missing
 * or zero score, a rejected or deleted sleep period, a nap beside the main
 * sleep, a hypnogram with unknown digits, a record without its instant, an
 * unparseable timestamp, an out-of-band heart rate, an unknown activity. Every
 * mapper that takes a zone runs without one and under two explicit zones, so
 * the date-only anchors are recorded where they land.
 *
 * The golden was written before the mappers moved out of `client.ts`, so a
 * green run is the proof that the move changed nothing.
 */
import { describe, expect, it } from "vitest";
import { format } from "prettier";

import {
  derivePeriodDaysFromCyclePhases,
  isRetiredOuraSleepPeriod,
  mapCardiovascularAge,
  mapDailyActivity,
  mapDailySleep,
  mapDailySpo2,
  mapHeartRateSample,
  mapReadiness,
  mapResilience,
  mapSleep,
  mapVo2Max,
  type MappedMeasurement,
} from "@/lib/oura/map";
import {
  type OuraCardiovascularAge,
  type OuraCyclePhase,
  type OuraDailyActivity,
  type OuraDailySleep,
  type OuraDailySpo2,
  type OuraHeartRateSample,
  type OuraReadiness,
  type OuraResilience,
  type OuraSleep,
  type OuraVo2Max,
  type OuraWorkout,
} from "@/lib/oura/wire-types";
import { mapOuraWorkout } from "../sync-workouts";

import cardiovascularAgeFixture from "./__fixtures__/cardiovascular-age.json";
import cyclePhasesFixture from "./__fixtures__/cycle-phases.json";
import dailyActivityFixture from "./__fixtures__/daily-activity.json";
import dailySleepFixture from "./__fixtures__/daily-sleep.json";
import dailySpo2Fixture from "./__fixtures__/daily-spo2.json";
import heartRateFixture from "./__fixtures__/heartrate.json";
import readinessFixture from "./__fixtures__/readiness.json";
import resilienceFixture from "./__fixtures__/resilience.json";
import sleepFixture from "./__fixtures__/sleep.json";
import vo2MaxFixture from "./__fixtures__/vo2-max.json";
import workoutsFixture from "./__fixtures__/workouts.json";

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

/** No zone (the mapper's own default), then two zones on either side of UTC. */
const ZONES = [undefined, "Europe/Berlin", "America/New_York"] as const;

/** Runs a zone-aware mapper over every record under every zone. */
function acrossZones<T extends { id?: string; day: string }>(
  records: readonly T[],
  map: (record: T, tz?: string) => MappedMeasurement[],
) {
  return records.flatMap((record) =>
    ZONES.map((zone) => ({
      id: record.id ?? null,
      day: record.day,
      zone: zone ?? null,
      rows: map(record, zone),
    })),
  );
}

describe("Oura mappers against the golden fixtures", () => {
  it("maps daily readiness", async () => {
    const records: OuraReadiness[] = readinessFixture;
    await expect(
      await golden(acrossZones(records, mapReadiness)),
    ).toMatchFileSnapshot("./__golden__/map-readiness.json");
  });

  it("maps sleep periods and flags retired ones", async () => {
    const records: OuraSleep[] = sleepFixture;
    const output = acrossZones(records, mapSleep).map((entry) => ({
      ...entry,
      retired: isRetiredOuraSleepPeriod(
        records.find((r) => r.id === entry.id) ?? {},
      ),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sleep.json",
    );
  });

  it("classifies every sleep type as retired or kept", async () => {
    const types = [
      "long_sleep",
      "sleep",
      "late_nap",
      "rest",
      "deleted",
      "REST",
      "",
      null,
      undefined,
    ];
    const output = types.map((type) => ({
      type: type ?? null,
      retired: isRetiredOuraSleepPeriod({ type }),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sleep-retired.json",
    );
  });

  it("maps the daily sleep score", async () => {
    const records: OuraDailySleep[] = dailySleepFixture;
    await expect(
      await golden(acrossZones(records, mapDailySleep)),
    ).toMatchFileSnapshot("./__golden__/map-daily-sleep.json");
  });

  it("maps daily SpO2", async () => {
    const records: OuraDailySpo2[] = dailySpo2Fixture;
    await expect(
      await golden(acrossZones(records, mapDailySpo2)),
    ).toMatchFileSnapshot("./__golden__/map-daily-spo2.json");
  });

  it("maps daily activity", async () => {
    const records: OuraDailyActivity[] = dailyActivityFixture;
    await expect(
      await golden(acrossZones(records, mapDailyActivity)),
    ).toMatchFileSnapshot("./__golden__/map-daily-activity.json");
  });

  it("maps VO2 max", async () => {
    const records: OuraVo2Max[] = vo2MaxFixture;
    await expect(
      await golden(acrossZones(records, mapVo2Max)),
    ).toMatchFileSnapshot("./__golden__/map-vo2-max.json");
  });

  it("maps cardiovascular age", async () => {
    const records: OuraCardiovascularAge[] = cardiovascularAgeFixture;
    await expect(
      await golden(acrossZones(records, mapCardiovascularAge)),
    ).toMatchFileSnapshot("./__golden__/map-cardiovascular-age.json");
  });

  it("maps the resilience level", async () => {
    const records: OuraResilience[] = resilienceFixture;
    await expect(
      await golden(acrossZones(records, mapResilience)),
    ).toMatchFileSnapshot("./__golden__/map-resilience.json");
  });

  it("maps heart-rate samples", async () => {
    const samples: OuraHeartRateSample[] = heartRateFixture;
    const output = samples.map((sample) => ({
      timestamp: sample.timestamp ?? null,
      bpm: sample.bpm ?? null,
      row: mapHeartRateSample(sample),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-heartrate.json",
    );
  });

  it("derives period days from cycle phases", async () => {
    const scenarios: Array<{ scenario: string; records: OuraCyclePhase[] }> =
      cyclePhasesFixture;
    const output = scenarios.map(({ scenario, records }) => ({
      scenario,
      periodDays: derivePeriodDaysFromCyclePhases(records),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-cycle-phases.json",
    );
  });

  it("maps workouts", async () => {
    const records: OuraWorkout[] = workoutsFixture;
    const output = records.map((record) => ({
      id: record.id,
      row: mapOuraWorkout(record),
    }));
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-workouts.json",
    );
  });
});
