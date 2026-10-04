/**
 * The illness read's live per-day pulse is the mean of the day's local hours'
 * means, so a workout hour's dense samples do not read as a fever-day pulse
 * spike. Other vitals keep the mean of their readings.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-01-21T12:00:00Z");

const db = vi.hoisted(() => ({
  measurement: { findMany: vi.fn() },
  illnessDayLog: { findMany: vi.fn() },
}));
const engine = vi.hoisted(() => ({ compute: vi.fn() }));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rollups/measurement-coverage", () => ({
  probeRollupCoverage: vi.fn(async () => new Map<string, boolean>()),
}));
vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readBestGranularityRollups: vi.fn(async () => null),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => null),
}));
vi.mock("../correlation", async (orig) => ({
  ...(await orig<typeof import("../correlation")>()),
  computeIllnessCorrelation: (input: unknown) => {
    engine.compute(input);
    return { status: "insufficient" };
  },
}));

import { computeEpisodeCorrelation } from "../correlation-read";

/** A workout hour (six readings at 150) and two resting hours at 60, in Kolkata local time. */
const DAY_ROWS = [
  ...[0, 5, 10, 15, 20, 25].map((m) => ({
    value: 150,
    // 04:45Z + m = 10:15 + m local (one local hour, two UTC hours).
    measuredAt: new Date(Date.parse("2026-01-15T04:45:00Z") + m * 60_000),
  })),
  { value: 60, measuredAt: new Date("2026-01-15T06:30:00Z") },
  { value: 60, measuredAt: new Date("2026-01-15T08:30:00Z") },
];

beforeEach(() => {
  vi.clearAllMocks();
  db.illnessDayLog.findMany.mockResolvedValue([]);
  db.measurement.findMany.mockImplementation(
    async ({ where }: { where: { type: string } }) =>
      where.type === "PULSE" || where.type === "HEART_RATE_VARIABILITY"
        ? DAY_ROWS
        : [],
  );
});

describe("illness read, live per-day means", () => {
  it("makes a pulse day the mean of its local hours' means; HRV keeps the reading mean", async () => {
    await computeEpisodeCorrelation(
      "u1",
      {
        id: "ep",
        onsetAt: new Date("2026-01-16T08:00:00Z"),
        resolvedAt: null,
        lifecycle: "ACUTE",
      },
      "Asia/Kolkata",
      NOW,
    );
    const { series } = engine.compute.mock.calls[0][0] as {
      series: Array<{
        type: string;
        episodeDays: Array<{ day: string; mean: number }>;
        episodeDayMax: Array<{ day: string; mean: number }>;
      }>;
    };
    const pulse = series.find((s) => s.type === "PULSE")!;
    // Hours' means 150, 60, 60 → 90 (the readings average 127.5).
    expect(pulse.episodeDays).toEqual([{ day: "2026-01-15", mean: 90 }]);
    // The day's max stays over every reading.
    expect(pulse.episodeDayMax).toEqual([{ day: "2026-01-15", mean: 150 }]);
    const hrv = series.find((s) => s.type === "HEART_RATE_VARIABILITY")!;
    expect(hrv.episodeDays).toEqual([{ day: "2026-01-15", mean: 127.5 }]);
  });
});
