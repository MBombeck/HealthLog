/**
 * v1.42 — the `folded_window` rule and the compaction-tombstone class.
 *
 * Pins what counts as a folded sample (source, type, age, id shape), which
 * `stats:` id covers it (the fold's own hourly or daily id, in the account's
 * zone), and that a tombstone is class A only when it was already past the
 * fold threshold at the moment it was deleted, which is what keeps a
 * person's deletion of a recent sample out of the purge.
 */
import { describe, expect, it, vi } from "vitest";

import {
  coveringStatsExternalId,
  findCompactionTombstones,
  findFoldedWindowDuplicates,
  isFoldedWindowCandidate,
} from "../folded-window";

const DAY = 86_400_000;
const NOW = new Date("2026-10-08T12:00:00.000Z");

function raw(
  type: string,
  measuredAt: Date,
  overrides: Record<string, unknown> = {},
) {
  return {
    type,
    source: "APPLE_HEALTH",
    externalId: "uuid-1",
    measuredAt,
    ...overrides,
  } as Parameters<typeof isFoldedWindowCandidate>[0];
}

describe("isFoldedWindowCandidate", () => {
  it("takes dense samples past 90 days and mean samples past 36 hours", () => {
    expect(
      isFoldedWindowCandidate(
        raw("PULSE", new Date(NOW.getTime() - 91 * DAY)),
        NOW,
      ),
    ).toBe(true);
    expect(
      isFoldedWindowCandidate(
        raw("PULSE", new Date(NOW.getTime() - 89 * DAY)),
        NOW,
      ),
    ).toBe(false);
    expect(
      isFoldedWindowCandidate(
        raw("RESPIRATORY_RATE", new Date(NOW.getTime() - 2 * DAY)),
        NOW,
      ),
    ).toBe(true);
    expect(
      isFoldedWindowCandidate(
        raw("RESPIRATORY_RATE", new Date(NOW.getTime() - DAY)),
        NOW,
      ),
    ).toBe(false);
  });

  it("refuses other sources, other types, `stats:` and `retired:` ids", () => {
    const old = new Date(NOW.getTime() - 200 * DAY);
    expect(
      isFoldedWindowCandidate(raw("PULSE", old, { source: "MANUAL" }), NOW),
    ).toBe(false);
    expect(isFoldedWindowCandidate(raw("WEIGHT", old), NOW)).toBe(false);
    expect(
      isFoldedWindowCandidate(
        raw("PULSE", old, {
          externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-01-01T10",
        }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isFoldedWindowCandidate(
        raw("PULSE", old, { externalId: "retired:m1:uuid-1" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isFoldedWindowCandidate(raw("PULSE", old, { externalId: null }), NOW),
    ).toBe(false);
  });
});

describe("coveringStatsExternalId", () => {
  it("names the local hour for a dense type and the local day for a mean type", () => {
    // 22:30 UTC on 1 Jan is 23:30 in Berlin (UTC+1).
    const at = new Date("2026-01-01T22:30:00.000Z");
    expect(
      coveringStatsExternalId(
        { type: "PULSE", measuredAt: at },
        "Europe/Berlin",
      ),
    ).toBe("stats:HKQuantityTypeIdentifierHeartRate:2026-01-01T23");
    // 23:30 UTC is already 2 Jan in Berlin.
    const late = new Date("2026-01-01T23:30:00.000Z");
    expect(
      coveringStatsExternalId(
        { type: "RESPIRATORY_RATE", measuredAt: late },
        "Europe/Berlin",
      ),
    ).toBe("stats:HKQuantityTypeIdentifierRespiratoryRate:2026-01-02");
    expect(
      coveringStatsExternalId(
        { type: "WEIGHT", measuredAt: at },
        "Europe/Berlin",
      ),
    ).toBeNull();
  });
});

function client(
  live: Array<{ type: string; externalId: string; measuredAt: Date }>,
) {
  const findMany = vi.fn(async () => live);
  return {
    findMany,
    client: {
      measurement: { findMany },
      user: {
        findUnique: vi.fn(async () => ({ timezone: "UTC" })),
      },
    } as unknown as Parameters<typeof findFoldedWindowDuplicates>[0],
  };
}

describe("findFoldedWindowDuplicates", () => {
  const old = new Date("2026-03-01T10:15:00.000Z");

  it("asks nothing when no row is old enough", async () => {
    const { client: c, findMany } = client([]);
    const found = await findFoldedWindowDuplicates(
      c,
      "u1",
      [raw("PULSE", new Date(NOW.getTime() - DAY))],
      { now: NOW },
    );
    expect(found.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the rows a live `stats:` row covers, in live-only reads", async () => {
    const { client: c, findMany } = client([
      {
        type: "PULSE",
        externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10",
        measuredAt: new Date("2026-03-01T10:30:00.000Z"),
      },
    ]);
    const found = await findFoldedWindowDuplicates(
      c,
      "u1",
      [
        raw("PULSE", old),
        raw("PULSE", new Date("2026-03-01T11:15:00.000Z"), {
          externalId: "uuid-2",
        }),
        raw("WEIGHT", old),
      ],
      { now: NOW },
    );
    // The 11:15 sample is 45 minutes from the 10:30 anchor: outside the
    // half hour any zone's hour anchor can be from a sample of its hour.
    expect([...found]).toEqual([0]);
    // One read by externalId, one for the timezone-change reach of the
    // sample it did not cover; both live rows of the sample's own source.
    expect(findMany).toHaveBeenCalledTimes(2);
    for (const call of findMany.mock.calls) {
      const where = (call as unknown as [{ where: Record<string, unknown> }])[0]
        .where;
      expect(where.deletedAt).toBeNull();
      expect(where.source).toBe("APPLE_HEALTH");
    }
  });
});

describe("findCompactionTombstones", () => {
  const measuredAt = new Date("2026-03-01T10:15:00.000Z");
  const covering = [
    {
      type: "PULSE",
      externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10",
      measuredAt: new Date("2026-03-01T10:30:00.000Z"),
    },
  ];

  it("takes a tombstone deleted after the fold threshold under a live `stats:` row", async () => {
    const { client: c } = client(covering);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      {
        ...raw("PULSE", measuredAt),
        deletedAt: new Date(measuredAt.getTime() + 91 * DAY),
      },
    ]);
    expect([...found]).toEqual([0]);
  });

  it("leaves a person's deletion of a then-recent sample alone, even under a `stats:` row", async () => {
    const { client: c } = client(covering);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      {
        ...raw("PULSE", measuredAt),
        deletedAt: new Date(measuredAt.getTime() + 2 * DAY),
      },
    ]);
    expect(found.size).toBe(0);
  });

  it("leaves a dense tombstone alone when only a pre-hourly daily row covers it", async () => {
    const { client: c } = client([
      {
        type: "PULSE",
        externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01",
        measuredAt: new Date("2026-03-01T12:00:00.000Z"),
      },
    ]);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      {
        ...raw("PULSE", measuredAt),
        deletedAt: new Date(measuredAt.getTime() + 91 * DAY),
      },
    ]);
    expect(found.size).toBe(0);
  });

  it("leaves a deletion alone whose day the fold had not finished yet", async () => {
    // Past the 90 days by an hour, but the rest of the local day was still
    // inside them: an older release folded such a day in two runs, and a
    // person deleting a sample of it deleted something the fold had not
    // taken.
    const { client: c, findMany } = client(covering);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      {
        ...raw("PULSE", measuredAt),
        deletedAt: new Date(measuredAt.getTime() + 90 * DAY + 3_600_000),
      },
    ]);
    expect(found.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("leaves a live row alone", async () => {
    const { client: c } = client(covering);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      { ...raw("PULSE", measuredAt), deletedAt: null },
    ]);
    expect(found.size).toBe(0);
  });
});

/**
 * Health Connect folds its raw heart-rate history the way Apple Health does:
 * past the 90-day window into one `stats:` row per local hour, under its own
 * source. The mean-day rule stays Apple Health only, because the nightly
 * mean consolidation never reads another source.
 */
describe("Health Connect", () => {
  const old = new Date("2026-03-01T10:15:00.000Z");
  const hc = (
    type: string,
    at: Date,
    overrides: Record<string, unknown> = {},
  ) =>
    raw(type, at, {
      source: "HEALTH_CONNECT",
      externalId: "hc:00000000-0000-0000-0000-000000000001:1",
      ...overrides,
    });

  /** A lookup that answers per source, as the database does. */
  function sourceAwareClient(
    live: Array<{ type: string; source: string; externalId: string }>,
  ) {
    const findMany = vi.fn(async (args: { where: { source: string } }) =>
      live.filter((row) => row.source === args.where.source),
    );
    return {
      findMany,
      client: {
        measurement: { findMany },
      } as unknown as Parameters<typeof findFoldedWindowDuplicates>[0],
    };
  }

  it("takes a raw dense sample past the window, and not a mean-type one", () => {
    expect(isFoldedWindowCandidate(hc("PULSE", old), NOW)).toBe(true);
    expect(
      isFoldedWindowCandidate(
        hc("PULSE", new Date(NOW.getTime() - 89 * DAY)),
        NOW,
      ),
    ).toBe(false);
    expect(isFoldedWindowCandidate(hc("RESPIRATORY_RATE", old), NOW)).toBe(
      false,
    );
    expect(
      isFoldedWindowCandidate(
        hc("PULSE", old, {
          externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10",
        }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is covered only by a `stats:` row of its own source", async () => {
    const hour = "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10";
    const { client: c, findMany } = sourceAwareClient([
      { type: "PULSE", source: "HEALTH_CONNECT", externalId: hour },
    ]);
    const found = await findFoldedWindowDuplicates(
      c,
      "u1",
      [hc("PULSE", old), raw("PULSE", old)],
      { now: NOW, tz: "UTC" },
    );
    // The Health Connect sample is a duplicate; the Apple Health sample of
    // the same hour is not, because no Apple Health `stats:` row covers it.
    expect([...found]).toEqual([0]);
    const sources = findMany.mock.calls.map(
      (call) =>
        (call as unknown as [{ where: { source: string } }])[0].where.source,
    );
    expect([...new Set(sources)].sort()).toEqual([
      "APPLE_HEALTH",
      "HEALTH_CONNECT",
    ]);
  });
});
