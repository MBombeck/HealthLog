/**
 * Per-metric-type last-value freshness.
 *
 * Pins that the helper distinguishes a silently-dead metric (its newest reading
 * frozen in the past) from a genuinely-current one, keyed by integration, from
 * grouped reads over the live rows — the honest signal the per-integration
 * "connected · 5 min ago" pill cannot carry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fixtures keep the grouped-row shape (`source`, `type`, `_max`) the read
 * used to take. Since v1.42 the module asks `listLiveMeasurementTypes` per
 * source and then probes each type's newest row in one raw query; the two
 * mocks below answer both from the same fixture rows.
 */
type GroupedRow = {
  source: string;
  type: string;
  _max: { measuredAt: Date | null };
};
let measurementRows: GroupedRow[] = [];
const groupByMock = {
  mockResolvedValue(rows: GroupedRow[]) {
    measurementRows = rows;
  },
};
const liveTypesMock = vi.hoisted(() => vi.fn());
const queryRawMock = vi.hoisted(() => vi.fn());
const workoutGroupByMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: queryRawMock,
    workout: { groupBy: workoutGroupByMock },
  },
}));
vi.mock("@/lib/measurements/live-types", () => ({
  listLiveMeasurementTypes: liveTypesMock,
}));

import {
  getSourceFreshness,
  getSourceMetricFreshness,
  INTEGRATION_MEASUREMENT_SOURCE,
} from "../metric-freshness";
import {
  classifyMetricFreshness,
  METRIC_QUIET_AFTER_MS,
} from "../sync-verdict";

beforeEach(() => {
  measurementRows = [];
  liveTypesMock.mockReset();
  liveTypesMock.mockImplementation(
    async (_userId: string, options: { source: string }) =>
      measurementRows
        .filter((row) => row.source === options.source)
        .map((row) => row.type),
  );
  queryRawMock.mockReset();
  queryRawMock.mockImplementation(
    async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const types = values.find(Array.isArray) as string[];
      const source = values.find(
        (value) =>
          typeof value === "string" &&
          measurementRows.some((row) => row.source === value),
      );
      return types.map((type) => ({
        type,
        last_seen:
          measurementRows.find(
            (row) => row.source === source && row.type === type,
          )?._max.measuredAt ?? null,
      }));
    },
  );
  workoutGroupByMock.mockReset();
  workoutGroupByMock.mockResolvedValue([]);
});

describe("getSourceMetricFreshness", () => {
  it("maps grouped source/type rows to per-integration last-seen entries", async () => {
    groupByMock.mockResolvedValue([
      {
        source: "OURA",
        type: "RESPIRATORY_RATE",
        _max: { measuredAt: new Date("2026-01-01T00:00:00.000Z") },
      },
      {
        source: "OURA",
        type: "RECOVERY_SCORE",
        _max: { measuredAt: new Date("2026-07-07T00:00:00.000Z") },
      },
      {
        source: "WITHINGS",
        type: "WEIGHT",
        _max: { measuredAt: new Date("2026-07-06T00:00:00.000Z") },
      },
    ]);

    const result = await getSourceMetricFreshness("u1");

    // The dead metric (respiratory rate, frozen in January) is visible as a
    // distinct, older timestamp next to the current recovery score — exactly
    // the "broken pipe vs healthy-idle" distinction the pill can't express.
    expect(result.oura).toEqual([
      { type: "RECOVERY_SCORE", lastSeenAt: "2026-07-07T00:00:00.000Z" },
      { type: "RESPIRATORY_RATE", lastSeenAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(result.withings).toEqual([
      { type: "WEIGHT", lastSeenAt: "2026-07-06T00:00:00.000Z" },
    ]);
    // Only the sync sources are asked about, one live-type walk each.
    expect(
      liveTypesMock.mock.calls.map((call) => call[1].source).sort(),
    ).toEqual([...Object.values(INTEGRATION_MEASUREMENT_SOURCE)].sort());
  });

  it("skips rows with no reading and unmapped sources", async () => {
    groupByMock.mockResolvedValue([
      { source: "OURA", type: "VO2_MAX", _max: { measuredAt: null } },
      {
        source: "MANUAL",
        type: "WEIGHT",
        _max: { measuredAt: new Date("2026-07-01T00:00:00.000Z") },
      },
    ]);

    const result = await getSourceMetricFreshness("u1");
    // A null max (no rows) yields no entry; MANUAL isn't a sync integration.
    expect(result.oura).toBeUndefined();
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns an empty map when the user has no synced measurements", async () => {
    groupByMock.mockResolvedValue([]);
    expect(await getSourceMetricFreshness("u1")).toEqual({});
  });

  it("carries the workout leg for a source that writes no measurements", async () => {
    // Strava writes Workout rows only; without this leg its freshness list is
    // permanently empty and its one real pipe is invisible.
    groupByMock.mockResolvedValue([]);
    workoutGroupByMock.mockResolvedValue([
      {
        source: "STRAVA",
        _max: { startedAt: new Date("2026-07-20T06:00:00.000Z") },
      },
    ]);

    const result = await getSourceMetricFreshness("u1");
    expect(result.strava).toEqual([
      { type: "WORKOUTS", lastSeenAt: "2026-07-20T06:00:00.000Z" },
    ]);
  });

  it("appends the workout leg beside a source's own measurements", async () => {
    groupByMock.mockResolvedValue([
      {
        source: "POLAR",
        type: "SLEEP_DURATION",
        _max: { measuredAt: new Date("2026-07-24T04:00:00.000Z") },
      },
    ]);
    workoutGroupByMock.mockResolvedValue([
      {
        source: "POLAR",
        _max: { startedAt: new Date("2026-07-19T17:00:00.000Z") },
      },
    ]);

    expect((await getSourceMetricFreshness("u1")).polar).toEqual([
      { type: "SLEEP_DURATION", lastSeenAt: "2026-07-24T04:00:00.000Z" },
      { type: "WORKOUTS", lastSeenAt: "2026-07-19T17:00:00.000Z" },
    ]);
  });

  it.each(["whoop", "fitbit", "google-health"] as const)(
    "carries the workout leg for %s, which writes workouts too",
    async (integration) => {
      const source = {
        whoop: "WHOOP",
        fitbit: "FITBIT",
        "google-health": "GOOGLE_HEALTH",
      }[integration];

      // These three were missing from the workout table, so a card could
      // report every measurement type fresh while the workout leg had been
      // silent for weeks — the disclosure had no row that could go quiet.
      groupByMock.mockResolvedValue([
        {
          source,
          type: "SLEEP_DURATION",
          _max: { measuredAt: new Date("2026-07-24T04:00:00.000Z") },
        },
      ]);
      workoutGroupByMock.mockResolvedValue([
        { source, _max: { startedAt: new Date("2026-06-01T09:00:00.000Z") } },
      ]);

      expect((await getSourceMetricFreshness("u1"))[integration]).toEqual([
        { type: "SLEEP_DURATION", lastSeenAt: "2026-07-24T04:00:00.000Z" },
        { type: "WORKOUTS", lastSeenAt: "2026-06-01T09:00:00.000Z" },
      ]);
    },
  );
});

describe("getSourceFreshness — one source, for Apple Health", () => {
  it("reads only the requested source", async () => {
    groupByMock.mockResolvedValue([
      {
        source: "APPLE_HEALTH",
        type: "RESPIRATORY_RATE",
        _max: { measuredAt: new Date("2026-07-01T00:00:00.000Z") },
      },
    ]);

    expect(await getSourceFreshness("u1", "APPLE_HEALTH")).toEqual([
      { type: "RESPIRATORY_RATE", lastSeenAt: "2026-07-01T00:00:00.000Z" },
    ]);
    expect(liveTypesMock).toHaveBeenCalledTimes(1);
    expect(liveTypesMock.mock.calls[0][1]).toEqual({ source: "APPLE_HEALTH" });
  });

  it("issues no per-type probe when the source has no live types", async () => {
    expect(await getSourceFreshness("u1", "APPLE_HEALTH")).toEqual([]);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("probes live rows of the one source only", async () => {
    groupByMock.mockResolvedValue([
      {
        source: "APPLE_HEALTH",
        type: "PULSE",
        _max: { measuredAt: new Date("2026-07-01T00:00:00.000Z") },
      },
    ]);
    await getSourceFreshness("u1", "APPLE_HEALTH");
    const sql = (queryRawMock.mock.calls[0][0] as TemplateStringsArray).join(
      "?",
    );
    expect(sql).toContain('"deleted_at" IS NULL');
    expect(sql).toContain('"source" = ?::"measurement_source"');
    expect(sql).toContain("LIMIT 1");
  });
});

describe("classifyMetricFreshness — the stale flag", () => {
  const NOW = new Date("2026-07-25T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const DAY = 24 * 60 * 60 * 1000;

  it("flags a quiet metric only while the provider itself reads healthy", () => {
    const samples = [{ type: "WEIGHT", lastSeenAt: ago(20 * DAY) }];

    // Healthy pipe, one silent metric: the dead-pipe signature.
    expect(classifyMetricFreshness(samples, "fresh", NOW)[0].stale).toBe(true);

    // The whole connection has stopped: every metric ages together, so tinting
    // them would only restate what the pill already says.
    expect(classifyMetricFreshness(samples, "stalled", NOW)[0].stale).toBe(
      false,
    );
    expect(classifyMetricFreshness(samples, "failing", NOW)[0].stale).toBe(
      false,
    );
    expect(classifyMetricFreshness(samples, "stale", NOW)[0].stale).toBe(false);
  });

  it("exempts the types that are irregular by nature", () => {
    // A VO2 max estimate every few weeks is normal; a workout gap is a rest
    // week, not a broken pipe.
    for (const type of [
      "VO2_MAX",
      "IRREGULAR_RHYTHM_NOTIFICATION",
      "WORKOUTS",
    ]) {
      const [entry] = classifyMetricFreshness(
        [{ type, lastSeenAt: ago(60 * DAY) }],
        "fresh",
        NOW,
      );
      expect(entry.stale, type).toBe(false);
      // The honest timestamp still renders — exempt means untinted, not hidden.
      expect(entry.lastSeenAt).toBe(ago(60 * DAY));
    }
  });

  it("draws the quiet line at fourteen days", () => {
    // Deliberately generous: a weekly weigher must not be warned after a
    // holiday, and a false "this is broken" costs more trust than a few days
    // of latency on a real one.
    expect(METRIC_QUIET_AFTER_MS).toBe(14 * DAY);

    const at = (ms: number) =>
      classifyMetricFreshness(
        [{ type: "PULSE", lastSeenAt: ago(ms) }],
        "fresh",
        NOW,
      )[0].stale;
    expect(at(13 * DAY)).toBe(false);
    expect(at(15 * DAY)).toBe(true);
  });
});
