import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return { ...actual, computeDerivedMetric: vi.fn() };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
  },
}));

import { computeDerivedMetric } from "@/lib/insights/derived";
import { prisma } from "@/lib/db";
import { scoreBand } from "@/lib/analytics/score/shared";
import {
  buildDerivedSnapshotBlock,
  deriveTension,
  TENSION_HIGH_SCORE,
  TENSION_LOW_SCORE,
} from "../derived-snapshot";

const compute = computeDerivedMetric as unknown as ReturnType<typeof vi.fn>;
const recoveryFindMany = prisma.measurement.findMany as unknown as ReturnType<
  typeof vi.fn
>;
/**
 * The source of the recovery row the latest night resolves to: a device's
 * own score, or the COMPUTED proxy (HealthLog's readiness blend).
 */
function setCurrentRecoverySource(source: string) {
  recoveryFindMany.mockResolvedValue([
    {
      value: 64,
      measuredAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1000),
      source,
    },
  ]);
}
function setWhoopNativePresent(present: boolean) {
  setCurrentRecoverySource(present ? "WHOOP" : "COMPUTED");
}
const PROFILE = { ageYears: 40, sex: "MALE" as const, heightCm: 180 };
const NOW = new Date("2026-06-02T08:00:00Z");

function ok(value: Record<string, unknown>, historyDays = 14) {
  return {
    status: "ok" as const,
    value,
    coverage: { requiredInputs: 1, presentInputs: 1, historyDays, missing: [] },
    confidence: { score: 88, band: "high" as const },
    provenance: {
      inputs: [],
      source: "DAY" as const,
      windowDays: 14,
      computedAt: "x",
    },
  };
}
const insufficient = {
  status: "insufficient" as const,
  coverage: {
    requiredInputs: 1,
    presentInputs: 0,
    historyDays: 0,
    missing: [],
  },
  provenance: {
    inputs: [],
    source: "none" as const,
    windowDays: 0,
    computedAt: "x",
  },
  reason: "no_score_in_window",
};

beforeEach(() => {
  compute.mockReset();
  recoveryFindMany.mockReset();
  // Default: no WHOOP-native recovery row in the window. Tests that exercise
  // the native-present path flip this explicitly.
  setWhoopNativePresent(false);
});

describe("buildDerivedSnapshotBlock", () => {
  it("returns null when every metric is insufficient", async () => {
    compute.mockResolvedValue(insufficient);
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).toBeNull();
  });

  it("emits compact value + band + confidence per ok metric, omits insufficient", async () => {
    // A WHOOP-native recovery is present, so the recovery line survives
    // alongside readiness (the dedup only drops the COMPUTED proxy).
    setWhoopNativePresent(true);
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({ score: 64, band: "yellow", fresh: true });
      if (args?.metric === "RECOVERY_SCORE")
        return ok({ score: 72, band: "green" });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).not.toBeNull();
    expect(Object.keys(block!).sort()).toEqual(["READINESS", "RECOVERY_SCORE"]);
    expect(block!.READINESS).toEqual({
      value: 64,
      band: "yellow",
      confidence: 88,
      historyDays: 14,
    });
    // No raw series leaked — only the four compact facets.
    expect(Object.keys(block!.READINESS).sort()).toEqual([
      "band",
      "confidence",
      "historyDays",
      "value",
    ]);
  });

  it("drops RECOVERY_SCORE when it is the COMPUTED proxy (no WHOOP-native row)", async () => {
    // No WHOOP-native recovery in the window → the resolved recovery IS the
    // COMPUTED proxy, which equals readiness. Feeding both hands the model the
    // same number twice, so the recovery line is dropped.
    setWhoopNativePresent(false);
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({ score: 64, band: "yellow", fresh: true });
      if (args?.metric === "RECOVERY_SCORE")
        return ok({ score: 64, band: "yellow", fresh: true });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).not.toBeNull();
    expect(block!.READINESS).toBeDefined();
    expect(block!.RECOVERY_SCORE).toBeUndefined();
  });

  it("keeps a WHOOP-native RECOVERY_SCORE that coincidentally equals READINESS (L4)", async () => {
    // A genuine WHOOP recovery happens to match readiness on the nose. The old
    // numeric-equality drop would silence the device's ground-truth number; the
    // source-aware drop keeps it because a WHOOP-native row exists.
    setWhoopNativePresent(true);
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({ score: 64, band: "yellow", fresh: true });
      if (args?.metric === "RECOVERY_SCORE")
        return ok({ score: 64, band: "yellow", fresh: true });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.READINESS?.value).toBe(64);
    expect(block!.RECOVERY_SCORE?.value).toBe(64);
  });

  it("keeps RECOVERY_SCORE when a WHOOP-native value differs from READINESS", async () => {
    setWhoopNativePresent(true);
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({ score: 64, band: "yellow", fresh: true });
      if (args?.metric === "RECOVERY_SCORE")
        return ok({ score: 80, band: "green" });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.READINESS?.value).toBe(64);
    expect(block!.RECOVERY_SCORE?.value).toBe(80);
  });

  it("isolates a per-metric compute failure", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS") throw new Error("boom");
      if (args?.metric === "SLEEP_SCORE")
        return ok({ score: 80, band: "green" });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block).toEqual({
      SLEEP_SCORE: {
        value: 80,
        band: "green",
        confidence: 88,
        historyDays: 14,
      },
    });
  });

  it("attaches a TENSION flag when readiness contributors disagree", async () => {
    // Good sleep (high) but a suppressed HRV-balance + elevated resting pulse
    // (both low) — a genuine internal disagreement the band hides.
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({
          score: 58,
          band: "yellow",
          fresh: true,
          components: [
            { key: "sleep", value: 90, weight: 0.3 },
            { key: "hrv", value: 30, weight: 0.3 },
            { key: "rhr", value: 35, weight: 0.3 },
            { key: "mood", value: 60, weight: 0.1 },
          ],
        });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.TENSION).toBeDefined();
    expect(block!.TENSION!.fired).toBe(true);
    expect(block!.TENSION!.band).toBe("yellow");
    expect(block!.TENSION!.positive).toEqual(["sleep"]);
    expect(block!.TENSION!.negative).toEqual([
      "HRV balance",
      "resting heart rate",
    ]);
    // No coincident flag fired (DB read fails-soft to null), so no red-flag.
    expect(block!.TENSION!.clinicalOverride).toBe(false);
  });

  it("omits TENSION when the contributors agree", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({
          score: 82,
          band: "green",
          fresh: true,
          components: [
            { key: "sleep", value: 90, weight: 0.3 },
            { key: "hrv", value: 85, weight: 0.3 },
            { key: "rhr", value: 80, weight: 0.3 },
          ],
        });
      return insufficient;
    });
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.READINESS).toBeDefined();
    expect(block!.TENSION).toBeUndefined();
  });
});

describe("the one proxy rule in the Coach snapshot", () => {
  function readinessAndRecovery(recoveryScore: number) {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS")
        return ok({ score: 64, band: "yellow", fresh: true });
      if (args?.metric === "RECOVERY_SCORE")
        return ok({ score: recoveryScore, band: "yellow" });
      return insufficient;
    });
  }

  it("keeps an Oura or Polar recovery beside readiness, named after the device", async () => {
    for (const [source, name] of [
      ["OURA", "Oura Readiness"],
      ["POLAR", "Polar Nightly Recharge"],
      ["WHOOP", "WHOOP Recovery"],
    ]) {
      setCurrentRecoverySource(source);
      readinessAndRecovery(64);
      const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
      expect(block!.RECOVERY_SCORE?.value).toBe(64);
      expect(block!.RECOVERY_SCORE?.label).toBe(`${name} (device score)`);
    }
  });

  it("drops the proxy beside readiness even when an older night was WHOOP's", async () => {
    // The latest night resolves to the proxy; a WHOOP row from days ago does
    // not make today's recovery a device score.
    recoveryFindMany.mockResolvedValue([
      {
        value: 64,
        measuredAt: new Date(NOW.getTime() - 20 * 60 * 60 * 1000),
        source: "COMPUTED",
      },
      {
        value: 80,
        measuredAt: new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000),
        source: "WHOOP",
      },
    ]);
    readinessAndRecovery(64);
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.READINESS).toBeDefined();
    expect(block!.RECOVERY_SCORE).toBeUndefined();
  });

  it("keeps the proxy when there is no readiness line to repeat it", async () => {
    setCurrentRecoverySource("COMPUTED");
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "RECOVERY_SCORE"
        ? ok({ score: 64, band: "yellow" })
        : insufficient,
    );
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.RECOVERY_SCORE?.value).toBe(64);
    expect(block!.RECOVERY_SCORE?.label).toBeUndefined();
  });

  it("names stress and strain as HealthLog's estimates", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "STRESS_SCORE" || args?.metric === "STRAIN_SCORE"
        ? ok({ score: 80, band: "red" })
        : insufficient,
    );
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.STRESS_SCORE?.label).toBe("stress (HealthLog estimate)");
    expect(block!.STRAIN_SCORE?.label).toBe("strain (HealthLog estimate)");
  });

  it("gives a readiness that is not fresh no band, its day, and no tension", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "READINESS"
        ? ok({
            score: 58,
            band: "yellow",
            fresh: false,
            asOfDay: "2026-06-01",
            components: [
              { key: "sleep", value: 90, weight: 0.5 },
              { key: "hrv", value: 20, weight: 0.5 },
            ],
          })
        : insufficient,
    );
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW);
    expect(block!.READINESS).toEqual({
      value: 58,
      confidence: 88,
      historyDays: 14,
      asOfDay: "2026-06-01",
    });
    expect(block!.TENSION).toBeUndefined();
  });
});

describe("deriveTension (pure)", () => {
  it("reads favourable and unfavourable with the one band rule", () => {
    expect(scoreBand(TENSION_HIGH_SCORE)).toBe("green");
    expect(scoreBand(TENSION_HIGH_SCORE - 1)).not.toBe("green");
    expect(scoreBand(TENSION_LOW_SCORE)).toBe("red");
    expect(scoreBand(TENSION_LOW_SCORE + 1)).not.toBe("red");
  });

  it("fires only when at least one contributor sits on each side", () => {
    const fired = deriveTension(
      [
        { key: "sleep", value: TENSION_HIGH_SCORE },
        { key: "rhr", value: TENSION_LOW_SCORE },
      ],
      "yellow",
      false,
    );
    expect(fired).not.toBeNull();
    expect(fired!.positive).toEqual(["sleep"]);
    expect(fired!.negative).toEqual(["resting heart rate"]);
  });

  it("returns null when every contributor is favourable", () => {
    expect(
      deriveTension(
        [
          { key: "sleep", value: 90 },
          { key: "hrv", value: 85 },
        ],
        "green",
        false,
      ),
    ).toBeNull();
  });

  it("returns null when every contributor is unfavourable", () => {
    expect(
      deriveTension(
        [
          { key: "sleep", value: 20 },
          { key: "hrv", value: 30 },
        ],
        "red",
        false,
      ),
    ).toBeNull();
  });

  it("ignores neutral-band contributors (neither side)", () => {
    // A mid-range contributor (between the low and high cuts) is neither
    // favourable nor unfavourable, so on its own it cannot make a tension.
    const mid = Math.floor((TENSION_HIGH_SCORE + TENSION_LOW_SCORE) / 2);
    expect(
      deriveTension(
        [
          { key: "sleep", value: mid },
          { key: "hrv", value: mid },
        ],
        "yellow",
        false,
      ),
    ).toBeNull();
  });

  it("ignores null (absent) contributors", () => {
    expect(
      deriveTension(
        [
          { key: "sleep", value: 90 },
          { key: "rhr", value: null },
        ],
        "yellow",
        false,
      ),
    ).toBeNull();
  });

  it("carries the clinical-override bit through unchanged", () => {
    const fired = deriveTension(
      [
        { key: "sleep", value: 90 },
        { key: "rhr", value: 20 },
      ],
      "red",
      true,
    );
    expect(fired!.clinicalOverride).toBe(true);
  });
});

describe("buildDerivedSnapshotBlock under the lookback limit", () => {
  it("leaves out a metric whose own window does not fit, never shortening it", async () => {
    // Readiness reads 30 days. Under a 14-day limit it is left out rather
    // than computed over 14 days, where it would disagree with the ring.
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "READINESS" || args?.metric === "STRESS_SCORE"
        ? ok({ score: 60, band: "yellow" })
        : insufficient,
    );
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW, "UTC", {
      window: "last30days",
      days: 14,
    });
    const computed = compute.mock.calls.map(
      ([args]) => (args as { metric: string }).metric,
    );
    expect(computed).not.toContain("READINESS");
    expect(computed).not.toContain("SLEEP_SCORE");
    expect(computed).not.toContain("VASCULAR_AGE_DELTA");
    expect(computed).toContain("STRESS_SCORE");
    for (const [args] of compute.mock.calls) {
      const windowDays = (args as { windowDays?: number }).windowDays;
      expect(windowDays === undefined || windowDays >= 14).toBe(true);
    }
    expect(block?.READINESS).toBeUndefined();
    expect(block?.STRESS_SCORE).toBeDefined();
  });

  it("computes nothing under a 7-day limit, where no metric fits", async () => {
    compute.mockResolvedValue(ok({ score: 60, band: "yellow" }));
    const block = await buildDerivedSnapshotBlock("u1", PROFILE, NOW, "UTC", {
      window: "last7days",
      days: 7,
    });
    expect(compute).not.toHaveBeenCalled();
    expect(block).toBeNull();
  });
});
