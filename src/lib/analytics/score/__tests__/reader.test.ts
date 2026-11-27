import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

import {
  computeUserHealthScore,
  readActivityDays,
  readFastingGlucoseMeasurements,
} from "../reader";

function dbWithRows(rows: unknown[]) {
  return {
    measurement: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as PrismaClient;
}

function stepRow(
  measuredAt: string,
  value: number,
  deviceType: "watch" | "phone" = "watch",
  source: "APPLE_HEALTH" | "WITHINGS" = "APPLE_HEALTH",
) {
  return {
    id: `${measuredAt}-${deviceType}`,
    type: "ACTIVITY_STEPS" as const,
    value,
    unit: "count",
    source,
    measuredAt: new Date(measuredAt),
    deviceType,
    glucoseContext: null,
    sleepStage: null,
  };
}

describe("score reader bounds and source parity", () => {
  it("reads only fasting glucose across the 90-day window plus two comparisons", async () => {
    const db = dbWithRows([]);
    const now = new Date("2026-07-28T12:00:00.000Z");

    await readFastingGlucoseMeasurements(db, "user-1", now);

    expect(db.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          type: { in: ["BLOOD_GLUCOSE"] },
          glucoseContext: "FASTING",
          measuredAt: {
            gte: new Date(now.getTime() - 104 * 86_400_000),
          },
        }),
      }),
    );
    const where = vi.mocked(db.measurement.findMany).mock.calls[0]?.[0]?.where;
    expect(where).not.toHaveProperty("source");
  });

  it("retains a HealthKit glucose row when the client supplied fasting provenance", async () => {
    const appleFasting = {
      type: "BLOOD_GLUCOSE",
      value: 96,
      unit: "mg/dL",
      source: "APPLE_HEALTH",
      measuredAt: new Date("2026-07-27T07:00:00.000Z"),
      deviceType: "watch",
      glucoseContext: "FASTING",
      sleepStage: null,
    };
    const rows = await readFastingGlucoseMeasurements(
      dbWithRows([appleFasting]),
      "user-1",
      new Date("2026-07-28T12:00:00.000Z"),
    );
    expect(rows).toEqual([appleFasting]);
  });

  it("aggregates activity by the user's local day rather than a UTC rollup day", async () => {
    const db = dbWithRows([
      stepRow("2026-07-01T22:30:00.000Z", 1_000),
      stepRow("2026-07-02T21:30:00.000Z", 2_000),
    ]);

    const result = await readActivityDays({
      db,
      userId: "user-1",
      since: new Date("2026-07-01T00:00:00.000Z"),
      priority: null,
      timezone: "Europe/Berlin",
      asOf: new Date("2026-07-03T12:00:00.000Z"),
    });

    expect(result.path).toBe("live");
    expect(result.days).toEqual([{ day: "2026-07-02", value: 3_000 }]);
  });

  it("keeps the canonical device instead of summing Watch and phone steps", async () => {
    const db = dbWithRows([
      stepRow("2026-07-02T09:00:00.000Z", 1_000, "watch"),
      stepRow("2026-07-02T09:00:00.000Z", 5_000, "phone"),
    ]);

    const result = await readActivityDays({
      db,
      userId: "user-1",
      since: new Date("2026-07-01T00:00:00.000Z"),
      priority: null,
      timezone: "Europe/Berlin",
      asOf: new Date("2026-07-03T12:00:00.000Z"),
    });

    expect(result.days).toEqual([{ day: "2026-07-02", value: 1_000 }]);
  });

  it("reads an empty labs set as not_tracked, never read_failed", async () => {
    // A labs-enabled account with no lab rows has honestly recorded
    // nothing: the read SUCCEEDED and found an empty set. `read_failed`
    // is reserved for a read that threw — showing it here would offer a
    // Retry that can never help.
    const db = {
      measurement: { findMany: vi.fn().mockResolvedValue([]) },
      mentalHealthAssessment: { findMany: vi.fn().mockResolvedValue([]) },
      labResult: { findMany: vi.fn().mockResolvedValue([]) },
      dismissedPriorityItem: { findUnique: vi.fn().mockResolvedValue(null) },
      // v1.38 — the reader compares today's composition against the last
      // stored day. No stored day here, so there is nothing to compare and
      // no note to raise.
      healthScoreRecord: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    const report = await computeUserHealthScore({
      prisma: db,
      userId: "user-1",
      now: new Date("2026-07-28T12:00:00.000Z"),
      profile: {
        dateOfBirth: new Date("1985-07-09"),
        heightCm: 178,
        timezone: "Europe/Berlin",
        sourcePriorityJson: null,
        thresholdsJson: null,
        glucoseUnit: "mg/dL" as const,
      },
      modules: {
        glucose: true,
        labs: true,
        sleep: true,
        mentalHealth: true,
      },
      healthScoreConfigJson: null,
      bpTargets: null,
      bpEnvelope: null,
    });

    for (const id of ["GLYCAEMIA", "LIPIDS"] as const) {
      const pillar = report.pillars.find((p) => p.id === id)!;
      expect(pillar.result.status).toBe("insufficient");
      expect(
        pillar.result.status === "insufficient" && pillar.result.reason,
      ).toBe("not_tracked");
    }
  });

  it("excludes source writers outside the current 28-day score window", async () => {
    const db = dbWithRows([
      stepRow("2026-06-15T09:00:00.000Z", 8_000, "watch", "APPLE_HEALTH"),
      stepRow("2026-05-31T09:00:00.000Z", 8_000, "watch", "WITHINGS"),
    ]);
    const result = await readActivityDays({
      db,
      userId: "user-1",
      since: new Date("2026-05-20T00:00:00.000Z"),
      asOf: new Date("2026-07-01T12:00:00.000Z"),
      priority: null,
      timezone: "Europe/Berlin",
    });
    expect(result.sources).toEqual(["APPLE_HEALTH"]);
  });
});
