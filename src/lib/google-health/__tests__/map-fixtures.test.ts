/**
 * What each Google Health mapper makes of a fixed set of payloads, pinned in
 * `__golden__/map-*.json`.
 *
 * The fixtures under `__fixtures__/` are synthetic data points in the
 * documented v4 wire shape (spot samples, daily summaries, dailyRollUp
 * windows, sleep sessions, exercise sessions), chosen to walk every branch the
 * mappers have: int64 values as strings, zeros and negatives, missing or
 * unparseable anchors, offset-less local times, unknown stage and sport
 * labels. Every mapper that takes a zone runs once without one and once each
 * for `Europe/Berlin` and `America/New_York`. The pure request helpers from
 * `client.ts` run over small input tables in the test itself.
 *
 * The goldens were written before the mappers moved out of `client.ts` and
 * `mappers.ts` into their own modules, so a green run proves the move changed
 * no output. The clock is pinned because a sample without a parseable anchor
 * falls back to the current time.
 */
import { format } from "prettier";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_HEALTH_DATA_TYPES,
  googleHealthSampleInstant,
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
  mapVo2Max,
  mapWeight,
  mapWorkout,
  mapWristTemperature,
  type GoogleHealthDataPoint,
  type GoogleHealthDataType,
  type GoogleHealthRollupPoint,
} from "../mappers";
import {
  buildDailyRollUpBody,
  chunkCivilRange,
  civilDateInTz,
  resolveGoogleHealthUserId,
} from "../client";
import { refusesEdgeFilter } from "@/lib/google-health/data-points";
import {
  extractGoogleApiErrorDetail,
  formatCivilBound,
  googleHealthRetryDelayMs,
  incrementalFilter,
} from "@/lib/google-health/request";
import dailySummariesJson from "./__fixtures__/daily-summaries.json";
import exerciseJson from "./__fixtures__/exercise.json";
import rollupsJson from "./__fixtures__/rollups.json";
import samplesJson from "./__fixtures__/samples.json";
import sleepJson from "./__fixtures__/sleep.json";

/** The golden is written in the repository's JSON format, so the format check passes on it unchanged. */
async function golden(value: unknown): Promise<string> {
  return format(JSON.stringify(value), { parser: "json" });
}

/** Captures a thrown error as data, so a refusal is part of the golden too. */
function outcome<T>(fn: () => T): T | { threw: string } {
  try {
    return fn();
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

const samples: GoogleHealthDataPoint[] = samplesJson;
const dailySummaries: GoogleHealthDataPoint[] = dailySummariesJson;
const rollups: GoogleHealthRollupPoint[] = rollupsJson;
const sleepSessions: GoogleHealthDataPoint[] = sleepJson;
const exercises: GoogleHealthDataPoint[] = exerciseJson;

const ZONES = [undefined, "Europe/Berlin", "America/New_York"] as const;

type ZonedMapper<P, R> = (point: P, tz?: string) => R;

/** Each fixture point through the mapper for the union key it carries, in every zone. */
function mapByKey<P extends Record<string, unknown>, R>(
  points: P[],
  mappers: Record<string, ZonedMapper<P, R>>,
): Array<{ index: number; key: string; tz: string | null; output: R }> {
  const out: Array<{
    index: number;
    key: string;
    tz: string | null;
    output: R;
  }> = [];
  points.forEach((point, index) => {
    for (const [key, mapper] of Object.entries(mappers)) {
      if (!(key in point)) continue;
      for (const tz of ZONES) {
        out.push({ index, key, tz: tz ?? null, output: mapper(point, tz) });
      }
    }
  });
  if (out.length !== points.length * ZONES.length) {
    throw new Error("a fixture point matched no mapper, or more than one");
  }
  return out;
}

const FIXED_NOW = new Date("2026-07-01T09:00:00.000Z");

beforeAll(() => {
  vi.useFakeTimers({ now: FIXED_NOW, toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe("Google Health mapper goldens", () => {
  it("maps spot samples", async () => {
    const output = {
      measurements: mapByKey<GoogleHealthDataPoint, unknown>(samples, {
        weight: mapWeight,
        bodyFat: mapBodyFat,
        heartRate: mapHeartRate,
        bloodGlucose: mapBloodGlucose,
        coreBodyTemperature: mapCoreBodyTemperature,
        height: (point) => mapHeight(point),
      }),
      sampleInstants: samples.flatMap((point, index) =>
        Object.entries(GOOGLE_HEALTH_DATA_TYPES)
          .filter(([, dt]) => dt.key in point)
          .flatMap(([name, dt]) =>
            ZONES.map((tz) => ({
              index,
              dataType: name,
              tz: tz ?? null,
              instant: googleHealthSampleInstant(point, dt, tz),
            })),
          ),
      ),
      sampleInstantOfDailyType: googleHealthSampleInstant(
        dailySummaries[0]!,
        GOOGLE_HEALTH_DATA_TYPES.oxygenSaturation,
      ),
    };
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-samples.json",
    );
  });

  it("maps daily summaries", async () => {
    const output = mapByKey(dailySummaries, {
      dailyOxygenSaturation: mapOxygenSaturation,
      dailyHeartRateVariability: mapHeartRateVariability,
      dailyRestingHeartRate: mapRestingHeartRate,
      dailyRespiratoryRate: mapRespiratoryRate,
      dailySleepTemperatureDerivations: mapWristTemperature,
      dailyVo2Max: mapVo2Max,
    });
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-daily-summaries.json",
    );
  });

  it("maps dailyRollUp windows", async () => {
    const output = mapByKey(rollups, {
      steps: mapSteps,
      distance: mapDistance,
      activeEnergyBurned: mapActiveEnergy,
      floors: mapFloors,
    });
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-rollups.json",
    );
  });

  it("maps sleep sessions", async () => {
    const output = sleepSessions.flatMap((point, index) =>
      ZONES.map((tz) => ({
        index,
        tz: tz ?? null,
        detailed: mapSleepSessionDetailed(point, tz),
        rows: mapSleepSession(point, tz),
      })),
    );
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-sleep.json",
    );
  });

  it("maps exercise sessions", async () => {
    const output = exercises.flatMap((point, index) =>
      ZONES.map((tz) => ({
        index,
        tz: tz ?? null,
        workout: mapWorkout(point, tz),
      })),
    );
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-exercise.json",
    );
  });

  it("resolves sleep stage and sport labels", async () => {
    const stageLabels: unknown[] = [
      "AWAKE",
      "wake",
      "LIGHT",
      " core ",
      "Deep",
      "REM",
      "ASLEEP",
      "RESTLESS",
      "in bed",
      "IN-BED",
      "inbed",
      "SLEEP_STAGE_TYPE_UNSPECIFIED",
      "",
      42,
      null,
    ];
    const sportLabels: unknown[] = [
      "RUNNING",
      "TREADMILL_RUNNING",
      "STRENGTH_TRAINING",
      "strength training",
      "Mountain-Biking",
      "STAIR_CLIMBER",
      "STAIRCLIMBER",
      "HIGH INTENSITY INTERVAL TRAINING",
      "FOOTBALL",
      "PILATES",
      "OTHER_WORKOUT",
      "KITESURFING",
      "",
      "   ",
      null,
      7,
    ];
    const output = {
      sleepStages: stageLabels.map((raw) => ({
        raw,
        stage: mapGoogleHealthSleepStage(raw),
      })),
      sportTypes: sportLabels.map((raw) => ({
        raw,
        sportType: mapGoogleHealthSportType(raw),
      })),
    };
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-labels.json",
    );
  });

  it("builds request values with the pure client helpers", async () => {
    const instants = [
      new Date("2026-06-01T21:59:59.000Z"),
      new Date("2026-06-01T22:00:00.000Z"),
      new Date("2026-03-29T00:30:00.000Z"),
      new Date("2026-12-31T23:30:15.500Z"),
    ];
    const listTypes: GoogleHealthDataType[] = [
      GOOGLE_HEALTH_DATA_TYPES.weight,
      GOOGLE_HEALTH_DATA_TYPES.heartRateVariability,
      GOOGLE_HEALTH_DATA_TYPES.sleep,
      GOOGLE_HEALTH_DATA_TYPES.exercise,
      GOOGLE_HEALTH_DATA_TYPES.steps,
    ];
    const errorBodies: unknown[] = [
      {
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message:
            "Invalid filter for https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints?filter=weight.date",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.BadRequest",
              fieldViolations: [
                { field: "filter", description: "Unknown field weight.date" },
                { field: "page_size" },
                { description: "Authorization: Bearer abc.def.ghi rejected" },
                { field: "fourth", description: "dropped past the third" },
              ],
            },
          ],
        },
      },
      { error: { status: "RESOURCE_EXHAUSTED" } },
      { error: { message: "x".repeat(260) } },
      { error: { details: [null, { fieldViolations: [{}, 5] }] } },
      { error: "invalid_grant" },
      { error: {} },
      null,
      "plain text",
    ];
    const retryCases: Array<{
      headers: Record<string, string>;
      body: unknown;
    }> = [
      { headers: { "retry-after": "30" }, body: null },
      { headers: { "retry-after": "1.5" }, body: null },
      {
        headers: { "retry-after": "Wed, 01 Jul 2026 09:00:45 GMT" },
        body: null,
      },
      { headers: { "retry-after": "-3" }, body: null },
      {
        headers: {},
        body: {
          error: {
            details: [
              { "@type": "type.googleapis.com/google.rpc.ErrorInfo" },
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "12.5s",
              },
            ],
          },
        },
      },
      {
        headers: {},
        body: { error: { details: [{ retryDelay: "soon" }] } },
      },
      { headers: {}, body: null },
    ];
    const output = {
      resolveGoogleHealthUserId: [
        { name: "users/1234567890" },
        { name: "users/", id: "id-0002" },
        { name: "plain-0003" },
        { id: "id-0004" },
        {},
      ].map((profile) => ({
        profile,
        userId: resolveGoogleHealthUserId(profile),
      })),
      formatCivilBound: instants.flatMap((instant) =>
        ZONES.map((tz) => ({
          instant,
          tz: tz ?? null,
          bound: formatCivilBound(instant, tz),
        })),
      ),
      civilDateInTz: instants.flatMap((instant) =>
        ZONES.map((tz) => ({
          instant,
          tz: tz ?? null,
          date: civilDateInTz(instant, tz),
        })),
      ),
      incrementalFilter: listTypes.flatMap((dataType) =>
        (["camel", "snake"] as const).flatMap((style) =>
          ZONES.map((tz) => ({
            dataType: dataType.path,
            style,
            tz: tz ?? null,
            filter: outcome(() =>
              incrementalFilter(dataType, instants[1]!, tz, style),
            ),
          })),
        ),
      ),
      incrementalFilterDefaultStyle: incrementalFilter(
        GOOGLE_HEALTH_DATA_TYPES.restingHeartRate,
        instants[0]!,
      ),
      chunkCivilRange: [
        {
          start: { year: 2026, month: 1, day: 1 },
          end: { year: 2026, month: 7, day: 1 },
        },
        {
          start: { year: 2026, month: 2, day: 20 },
          end: { year: 2026, month: 3, day: 10 },
          maxDays: 14,
        },
        {
          start: { year: 2026, month: 6, day: 1 },
          end: { year: 2026, month: 6, day: 1 },
        },
        {
          start: { year: 2026, month: 6, day: 2 },
          end: { year: 2026, month: 6, day: 1 },
        },
      ].map(({ start, end, maxDays }) => ({
        start,
        end,
        maxDays: maxDays ?? null,
        chunks: chunkCivilRange(start, end, maxDays),
      })),
      buildDailyRollUpBody: [
        {
          chunk: {
            start: { year: 2026, month: 1, day: 1 },
            end: { year: 2026, month: 4, day: 1 },
          },
        },
        {
          chunk: {
            start: { year: 2026, month: 2, day: 20 },
            end: { year: 2026, month: 3, day: 1 },
          },
          pageToken: "page-token-0002",
        },
        {
          chunk: {
            start: { year: 2026, month: 12, day: 31 },
            end: { year: 2027, month: 1, day: 1 },
          },
          pageToken: "",
        },
      ].map(({ chunk, pageToken }) => ({
        chunk,
        pageToken: pageToken ?? null,
        body: buildDailyRollUpBody(chunk, pageToken),
      })),
      extractGoogleApiErrorDetail: errorBodies.map((body) => ({
        body,
        detail: extractGoogleApiErrorDetail(body) ?? null,
      })),
      refusesEdgeFilter: [
        undefined,
        "INVALID_ARGUMENT",
        "INVALID_ARGUMENT: Invalid filter",
        "INVALID_ARGUMENT: Invalid page token",
        "INVALID_ARGUMENT: page_size out of range",
        "INVALID_ARGUMENT: pageSize too large",
        "UNAUTHENTICATED: access token expired",
        "FAILED_PRECONDITION: something else",
        "Bad filter and bad token",
      ].map((detail) => ({
        detail: detail ?? null,
        refuses: refusesEdgeFilter(detail),
      })),
      googleHealthRetryDelayMs: retryCases.map(({ headers, body }) => ({
        headers,
        body,
        delayMs:
          googleHealthRetryDelayMs(
            new Response(null, { status: 429, headers }),
            body,
            FIXED_NOW.getTime(),
          ) ?? null,
      })),
    };
    await expect(await golden(output)).toMatchFileSnapshot(
      "./__golden__/map-client-helpers.json",
    );
  });
});
