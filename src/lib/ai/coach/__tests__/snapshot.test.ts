import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  __resetCoachSnapshotCacheForTests,
  buildCoachSnapshot,
} from "../snapshot";

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
    // v1.4.33 — `buildCoachSnapshot` now memoises results in-process
    // for 60 s. Reset the cache between tests so each test sees its
    // own freshly-mocked Prisma fixture.
    __resetCoachSnapshotCacheForTests();
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

  // v1.4.36 W3 T2 — `medications` exclusion drops the GLP-1 weeklyContext
  // block + the compliance source so no medication data reaches the
  // prompt. Empty-data behaviour: when the user has no GLP-1 medication
  // the block is absent anyway (this test only proves the toggle path).
  it("omits weeklyContext.glp1 when excludeMetrics contains 'medications'", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { excludeMetrics: ["medications"] },
      timezone: "Europe/Berlin",
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.weeklyContext).toBeUndefined();
    expect(parsed.compliance).toBeUndefined();
    expect(parsed.scope.sources).not.toContain("compliance");
  });

  // v1.4.36 W3 T2 — `anthropometrics` exclusion drops the profile
  // block even when features.context has populated fields.
  it("omits anthropometrics when excludeMetrics contains 'anthropometrics'", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: 180, ageYears: 45, gender: "MALE" },
    });
    prismaMock.user.findUnique.mockResolvedValue({
      coachPrefsJson: { excludeMetrics: ["anthropometrics"] },
      timezone: "Europe/Berlin",
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toBeUndefined();
  });

  // v1.4.36 W3 T2 — anthropometrics block is added when features.context
  // has at least one non-null field AND the exclusion is off.
  it("includes anthropometrics when context has data and exclusion is off", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: 180, ageYears: 45, gender: "MALE" },
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toEqual({
      heightCm: 180,
      ageYears: 45,
      gender: "MALE",
    });
  });

  // v1.4.36 W3 T2 — empty-block omit: when every anthropometric field
  // is null the block is dropped entirely, not emitted as a labelled
  // null-trio that would render as `Hier sind die Profildaten: [keine]`
  // in the eventual prompt.
  it("drops anthropometrics when every field is null", async () => {
    featuresMock.mockResolvedValue({
      context: { heightCm: null, ageYears: null, gender: null },
    });
    const out = await buildCoachSnapshot("user-1");
    const parsed = JSON.parse(out.snapshotJson);
    expect(parsed.anthropometrics).toBeUndefined();
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

  // v1.4.33 — 60 s in-process snapshot cache. A chat conversation
  // sends 2-4 turns within a minute and rebuilding the snapshot from
  // ~10 measurement reads on every turn is wasteful. Cache hits skip
  // every persistent read; cache misses on a different scope (window
  // or sources) compute fresh.
  it("memoises the result for repeated (userId, scope) within the 60 s window", async () => {
    featuresMock.mockResolvedValue({
      weight: { avg30: 82.1, coverage: { count: 5 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(2, 82.0, "WEIGHT"),
      daysAgo(5, 82.4, "WEIGHT"),
    ]);

    const first = await buildCoachSnapshot("user-1", { sources: ["weight"] });
    const second = await buildCoachSnapshot("user-1", { sources: ["weight"] });

    // Same JSON shape on both calls.
    expect(second.snapshotJson).toBe(first.snapshotJson);
    // Prisma reads ran once for the first call; the second call short-
    // circuits on the cache so the count is still 1.
    expect(prismaMock.measurement.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("recomputes when the scope window or sources change", async () => {
    featuresMock.mockResolvedValue({
      weight: { avg30: 82.1, coverage: { count: 5 } },
    });
    prismaMock.measurement.findMany.mockResolvedValue([
      daysAgo(3, 82.0, "WEIGHT"),
    ]);

    await buildCoachSnapshot("user-1", {
      window: "last7days",
      sources: ["weight"],
    });
    await buildCoachSnapshot("user-1", {
      window: "last30days",
      sources: ["weight"],
    });

    // Two distinct window keys → two cache slots → two Prisma reads.
    expect(prismaMock.measurement.findMany).toHaveBeenCalledTimes(2);
  });
});
