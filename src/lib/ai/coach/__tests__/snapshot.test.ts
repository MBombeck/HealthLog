import { describe, expect, it, vi, beforeEach } from "vitest";

import { buildCoachSnapshot } from "../snapshot";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/insights/features", () => ({
  extractFeatures: vi.fn(),
}));

import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";

const prismaMock = prisma as unknown as {
  measurement: { findMany: ReturnType<typeof vi.fn> };
  moodEntry: { findMany: ReturnType<typeof vi.fn> };
  medicationIntakeEvent: { findMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};
const featuresMock = extractFeatures as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper: produce a measurement row N days before "now" at 09:00 UTC.
 */
function daysAgo(
  n: number,
  value: number,
  type: string,
): {
  type: string;
  value: number;
  measuredAt: Date;
} {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(9, 0, 0, 0);
  return { type, value, measuredAt: d };
}

describe("buildCoachSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.measurement.findMany.mockResolvedValue([]);
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    // v1.4.23 H4 — snapshot now reads `User.coachPrefsJson` to apply
    // per-user excludeMetrics. Default null = use legacy defaults.
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  it("returns a 'general'-only provenance when nothing is in the log", async () => {
    const out = await buildCoachSnapshot("user-1");
    expect(out.provenance.metrics).toContain("general");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("last30days");
  });

  it("includes day-level BP rows with weekday labels for the recent window", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: {
        avgSys30: 138,
        avgDia30: 85,
        coverage: { count: 4 },
      },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 142, "BLOOD_PRESSURE_SYS"),
      daysAgo(2, 92, "BLOOD_PRESSURE_DIA"),
      daysAgo(5, 130, "BLOOD_PRESSURE_SYS"),
      daysAgo(5, 80, "BLOOD_PRESSURE_DIA"),
    ]);

    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    const recent = parsed.bloodPressure.timeline.recent as Array<{
      date: string;
      weekday: string;
      sys: number;
      dia: number;
    }>;
    expect(recent.length).toBe(2);
    expect(recent[0]).toMatchObject({ sys: expect.any(Number) });
    expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).toContain(
      recent[0].weekday,
    );
    expect(out.provenance.metrics).toContain("bp");
  });

  it("respects the scope.sources filter — excluded metrics drop out", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avgSys30: 138, coverage: { count: 4 } },
      weight: { latest: 80, coverage: { count: 4 } },
    });

    const out = await buildCoachSnapshot("user-1", {
      sources: ["weight"],
      window: "last30days",
    });
    expect(out.provenance.metrics).toContain("weight");
    expect(out.provenance.metrics).not.toContain("bp");
    // Snapshot shouldn't mention BP either
    expect(out.snapshotJson).not.toContain("bloodPressure");
  });

  it("respects the scope.window — last7days yields a tighter window", async () => {
    featuresMock.mockResolvedValue({
      pulse: { avg7: 70, coverage: { count: 4 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 70, "PULSE"),
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["pulse"],
      window: "last7days",
    });
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("last7days");
    expect(parsed.pulse.timeline.recent.length).toBe(1);
  });

  it("respects the scope.window — lastYear flags the year-in-review window", async () => {
    featuresMock.mockResolvedValue({
      bloodPressure: { avg30Sys: 124, coverage: { count: 50 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(120, 124, "BLOOD_PRESSURE_SYS"),
      daysAgo(120, 81, "BLOOD_PRESSURE_DIA"),
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["bp"],
      window: "lastYear",
    });
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.window).toBe("lastYear");
    expect(out.provenance.windows).toContain("lastYear");
  });

  it("defaults to all-source last30days when no scope is provided", async () => {
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.scope.sources).toEqual([
      "bp",
      "weight",
      "pulse",
      "mood",
      "compliance",
    ]);
    expect(parsed.scope.window).toBe("last30days");
  });

  it("scope-only-mood pulls just mood data, no measurements query", async () => {
    featuresMock.mockResolvedValue({
      mood: { avg30: 4.2, coverage: { count: 12 } },
    });
    prismaMock.moodEntry.findMany.mockResolvedValue([
      {
        moodLoggedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        score: 4,
      },
    ]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["mood"],
    });
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(out.provenance.metrics).toContain("mood");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.mood.timeline.recent.length).toBe(1);
  });
});
