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

function client(live: Array<{ type: string; externalId: string }>) {
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

  it("returns the rows a live `stats:` row covers, in one live-only read", async () => {
    const { client: c, findMany } = client([
      {
        type: "PULSE",
        externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10",
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
    expect([...found]).toEqual([0]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = (
      findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.source).toBe("APPLE_HEALTH");
  });
});

describe("findCompactionTombstones", () => {
  const measuredAt = new Date("2026-03-01T10:15:00.000Z");
  const covering = [
    {
      type: "PULSE",
      externalId: "stats:HKQuantityTypeIdentifierHeartRate:2026-03-01T10",
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

  it("leaves a live row alone", async () => {
    const { client: c } = client(covering);
    const found = await findCompactionTombstones(c, "u1", "UTC", [
      { ...raw("PULSE", measuredAt), deletedAt: null },
    ]);
    expect(found.size).toBe(0);
  });
});
