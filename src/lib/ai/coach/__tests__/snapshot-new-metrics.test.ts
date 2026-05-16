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
 * v1.4.23 W4 F6 — pins the Apple Health timeline blocks the Coach
 * snapshot must ship when the user has HealthKit data and explicitly
 * scopes the new sources.
 *
 * Defensive design: web-only accounts that omit the new scope tokens
 * keep paying zero extra SQL, and accounts that toggle the scope on
 * but have no rows still produce a `general` snapshot — the block is
 * only emitted when at least one row exists.
 */
function daysAgo(
  n: number,
  value: number,
  type: string,
): { type: string; value: number; measuredAt: Date } {
  const ms = Date.now() - n * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  d.setUTCHours(9, 0, 0, 0);
  return { type, value, measuredAt: d };
}

describe("buildCoachSnapshot — Apple Health additive metrics (v1.4.23)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // v1.4.33 — `buildCoachSnapshot` now memoises results in-process
    // for 60 s; reset between tests so each fixture is read fresh.
    __resetCoachSnapshotCacheForTests();
    prismaMock.moodEntry.findMany.mockResolvedValue([]);
    prismaMock.medicationIntakeEvent.findMany.mockResolvedValue([]);
    // v1.4.23 H4 — snapshot now reads `User.coachPrefsJson`. Default
    // null = legacy defaults so the existing test fixtures stay
    // representative of the v1.4.22 behaviour.
    prismaMock.user.findUnique.mockResolvedValue({ coachPrefsJson: null });
    featuresMock.mockResolvedValue({
      bloodPressure: undefined,
      weight: undefined,
      pulse: undefined,
      mood: undefined,
    });
  });

  it("emits an hrv timeline block when scope.sources includes 'hrv' and rows exist", async () => {
    const rows = [
      daysAgo(2, 64, "HEART_RATE_VARIABILITY"),
      daysAgo(5, 71, "HEART_RATE_VARIABILITY"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeDefined();
    expect(out.provenance.metrics).toContain("hrv");
    expect(out.provenance.counts?.hrv).toBe(2);
  });

  it("emits a sleep timeline block on SLEEP_DURATION rows", async () => {
    const rows = [
      daysAgo(1, 420, "SLEEP_DURATION"),
      daysAgo(3, 510, "SLEEP_DURATION"),
      daysAgo(7, 480, "SLEEP_DURATION"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["sleep"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.sleep).toBeDefined();
    expect(out.provenance.metrics).toContain("sleep");
    expect(out.provenance.counts?.sleep).toBe(3);
  });

  it("emits both hrv + sleep blocks when scope toggles both", async () => {
    const rows = [
      daysAgo(2, 64, "HEART_RATE_VARIABILITY"),
      daysAgo(3, 510, "SLEEP_DURATION"),
    ];
    prismaMock.measurement.findMany.mockResolvedValue(rows);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv", "sleep"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeDefined();
    expect(snapshot.sleep).toBeDefined();
    expect(out.provenance.metrics).toEqual(
      expect.arrayContaining(["hrv", "sleep"]),
    );
  });

  it("omits the apple-health block entirely when rows are absent", async () => {
    // Scope says we want HRV, but the SQL fetch returned nothing.
    prismaMock.measurement.findMany.mockResolvedValue([]);

    const out = await buildCoachSnapshot("user-1", {
      sources: ["hrv"],
      window: "last30days",
    });
    const snapshot = JSON.parse(out.snapshotJson) as Record<string, unknown>;

    expect(snapshot.heartRateVariability).toBeUndefined();
    // Empty snapshot folds back to the `general` sentinel so the
    // Coach surface stays useful for an iOS user mid-onboarding.
    expect(out.provenance.metrics).toContain("general");
  });

  it("does not query the new types when scope omits them (web default)", async () => {
    // Default scope = bp, weight, pulse, mood, compliance. The
    // implementation only requests the new types when they're scoped
    // in — sanity-check the SQL parameters land that way.
    await buildCoachSnapshot("user-1");

    const callArgs = prismaMock.measurement.findMany.mock.calls[0]?.[0];
    const types = (callArgs?.where?.type?.in ?? []) as string[];
    expect(types).not.toContain("HEART_RATE_VARIABILITY");
    expect(types).not.toContain("SLEEP_DURATION");
    expect(types).not.toContain("ACTIVE_ENERGY_BURNED");
  });
});
