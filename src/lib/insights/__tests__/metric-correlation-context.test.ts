import { describe, expect, it, vi, beforeEach } from "vitest";

// The per-type measurement read is raw SQL; serve it from the findMany mock.
vi.mock("@/lib/measurements/newest-per-type", async () =>
  (
    await import("@/__tests__/helpers/newest-per-type-mock")
  ).newestPerTypeMock(),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    // v1.44 — the extended channel families (intake, training, room climate).
    nutrientIntakeDay: { findMany: async () => [] },
    workout: { findMany: async () => [] },
    strainTrimpCache: { findMany: async () => [] },
    $queryRaw: async () => [],
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    illnessDayLog: { findMany: vi.fn() },
    environmentContext: { findMany: vi.fn() },
    dawarichDay: { findMany: vi.fn(async () => []) },
    customMetric: { findMany: vi.fn() },
    symptomDefinition: { findMany: vi.fn(async () => []) },
  },
}));

// The record's module map; every module on unless a test switches one off.
const moduleMap = vi.hoisted(() => ({ value: {} as Record<string, boolean> }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: vi.fn(async () => moduleMap.value),
}));

vi.mock("@/lib/insights/correlation-patterns", () => ({
  PATTERN_FAMILIES: { discoveryRetrospective: "DISCOVERY_RETROSPECTIVE" },
  syncAcceptedPatterns: vi.fn().mockResolvedValue(new Map()),
  decisionForEvidence: vi.fn().mockReturnValue(null),
}));

import { prisma } from "@/lib/db";
import { getRelevantCorrelationsForMetric } from "../metric-correlation-context";

beforeEach(() => {
  vi.resetAllMocks();
  moduleMap.value = {};
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    timezone: "Europe/Berlin",
  } as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.illnessDayLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.environmentContext.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.customMetric.findMany).mockResolvedValue([] as never);
});

describe("getRelevantCorrelationsForMetric", () => {
  it("returns [] without any DB read for a non-discovery metric", async () => {
    // VO2_MAX is not part of the curated discovery matrix.
    const out = await getRelevantCorrelationsForMetric("u-1", "VO2_MAX", "en");
    expect(out).toEqual([]);
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
  });

  it("surfaces only FDR-surviving pairs that involve the metric's channel", async () => {
    // Two strong, INDEPENDENT lag-1 relationships over 60 days:
    //   TIME_IN_DAYLIGHT → next-day RESTING_HEART_RATE  (involves the metric)
    //   BLOOD_GLUCOSE    → next-day WEIGHT              (does not)
    //
    // The second pair is what makes this test say anything. With one
    // correlated pair in the fixture, "every returned relation mentions the
    // metric" is satisfied by a function that returns the whole matrix — which
    // is what this one did for four releases while the assertion stayed green.
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    const base = new Date("2026-01-01T12:00:00Z");
    for (let d = 0; d < 60; d++) {
      const day = new Date(base.getTime() + d * 86_400_000);
      const next = new Date(base.getTime() + (d + 1) * 86_400_000);
      const daylight = 30 + (d % 10) * 6; // varies 30..84
      rows.push({ type: "TIME_IN_DAYLIGHT", value: daylight, measuredAt: day });
      // next-day RHR moves opposite to today's daylight (lag-1 anti-corr).
      rows.push({
        type: "RESTING_HEART_RATE",
        value: 90 - daylight * 0.4,
        measuredAt: next,
      });
      const glucose = 80 + (d % 7) * 5; // varies 80..110
      rows.push({ type: "BLOOD_GLUCOSE", value: glucose, measuredAt: day });
      rows.push({
        type: "WEIGHT",
        value: 60 + glucose * 0.1,
        measuredAt: next,
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    const out = await getRelevantCorrelationsForMetric(
      "u-1",
      "RESTING_HEART_RATE",
      "en",
    );
    expect(out.length).toBeGreaterThan(0);
    // Every surfaced relation mentions resting heart rate (the metric's channel).
    for (const c of out) {
      expect(c.interpretation.toLowerCase()).toContain("resting heart rate");
      expect(Number.isFinite(c.r)).toBe(true);
      expect(c.n).toBeGreaterThanOrEqual(20);
    }
    // And the glucose → weight pair, which the same scan certainly found, is
    // not in a resting-heart-rate card's grounded context.
    for (const c of out) {
      expect(c.interpretation.toLowerCase()).not.toContain("weight");
    }
  });

  it("never grounds a card on a module that is switched off", async () => {
    // Blood glucose today tracks tomorrow's weight. With the glucose module on,
    // the weight card cites the pair (the positive control); with it off, the
    // glucose channel never enters the scan and the card cites nothing.
    const rows: Array<{ type: string; value: number; measuredAt: Date }> = [];
    const base = new Date("2026-01-01T12:00:00Z");
    for (let d = 0; d < 60; d++) {
      const glucose = 80 + (d % 7) * 5;
      rows.push({
        type: "BLOOD_GLUCOSE",
        value: glucose,
        measuredAt: new Date(base.getTime() + d * 86_400_000),
      });
      rows.push({
        type: "WEIGHT",
        value: 60 + glucose * 0.1,
        measuredAt: new Date(base.getTime() + (d + 1) * 86_400_000),
      });
    }
    vi.mocked(prisma.measurement.findMany).mockResolvedValue(rows as never);

    const on = await getRelevantCorrelationsForMetric("u-1", "WEIGHT", "en");
    expect(on.length).toBeGreaterThan(0);

    moduleMap.value = { glucose: false };
    const off = await getRelevantCorrelationsForMetric("u-1", "WEIGHT", "en");
    expect(off).toEqual([]);
  });

  it("is best-effort: a DB failure resolves to [] rather than throwing", async () => {
    vi.mocked(prisma.measurement.findMany).mockRejectedValue(
      new Error("db down"),
    );
    const out = await getRelevantCorrelationsForMetric(
      "u-1",
      "RESTING_HEART_RATE",
      "en",
    );
    expect(out).toEqual([]);
  });
});
