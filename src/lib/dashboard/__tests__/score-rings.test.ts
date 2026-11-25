/**
 * v1.27.7 — unit tests for the hero score-ring resolver.
 *
 * The resolver is tested in isolation with the derived dispatcher
 * mocked, pinning:
 *   - module gating (the owning module, from the surface map; the insights
 *     key, AI analysis, gates no ring);
 *   - the pass-through contract for derived scores (same resolvers the
 *     batch route calls, no recomputation, non-`ok` → no ring);
 *   - the dose ring: today's taken/scheduled progress off the shared
 *     medsToday block (no ring when nothing is scheduled today, never a
 *     red band — pending doses are not an alert state);
 *   - per-ring fail-softness (one throwing engine drops only its ring).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const computeDerivedMetric = vi.fn();
const loadBaselineProfile = vi.fn();

vi.mock("@/lib/insights/derived", () => ({
  computeDerivedMetric: (...a: unknown[]) => computeDerivedMetric(...a),
  loadBaselineProfile: (...a: unknown[]) => loadBaselineProfile(...a),
  isDerivedOk: (d: { status: string }) => d.status === "ok",
}));

import { buildScoreRingsBlock, resolveDoseRing } from "../score-rings";
import type { ModuleKey } from "@/lib/modules/gate";

const NOW = new Date("2026-07-01T10:00:00.000Z");

function moduleMap(
  overrides: Partial<Record<ModuleKey, boolean>> = {},
): Record<ModuleKey, boolean> {
  return {
    recovery: true,
    sleep: true,
    medications: true,
    insights: true,
    ...overrides,
  } as Record<ModuleKey, boolean>;
}

// The dose ring reads the pre-computed medsToday block — no queries. The
// recovery ring reads the source of the row it rests on.
let recoveryRows: Array<{ value: number; measuredAt: Date; source: string }> =
  [];
function setRecoverySource(source: string) {
  recoveryRows = [
    { value: 38, measuredAt: new Date("2026-07-01T05:00:00.000Z"), source },
  ];
}
const fakePrisma = {
  measurement: { findMany: vi.fn(async () => recoveryRows) },
  user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function medsToday(taken: number, scheduled: number) {
  return { takenToday: taken, scheduledToday: scheduled };
}

beforeEach(() => {
  vi.clearAllMocks();
  setRecoverySource("WHOOP");
  loadBaselineProfile.mockResolvedValue({ userId: "user-1" });
});

describe("resolveDoseRing()", () => {
  it("renders today's progress with the taken/scheduled pair", () => {
    expect(resolveDoseRing(medsToday(1, 3))).toEqual({
      id: "MED_COMPLIANCE",
      score: 33,
      band: "yellow",
      doses: { taken: 1, scheduled: 3 },
    });
  });

  it("goes green only when every scheduled dose is taken — never red", () => {
    expect(resolveDoseRing(medsToday(3, 3))?.band).toBe("green");
    expect(resolveDoseRing(medsToday(0, 3))?.band).toBe("yellow");
  });

  it("no doses scheduled today → no ring (never a hollow 100%)", () => {
    expect(resolveDoseRing(medsToday(0, 0))).toBeNull();
    expect(resolveDoseRing(null)).toBeNull();
  });

  it("clamps a taken overshoot (extra manual logs) to the scheduled count", () => {
    expect(resolveDoseRing(medsToday(5, 3))).toEqual({
      id: "MED_COMPLIANCE",
      score: 100,
      band: "green",
      doses: { taken: 3, scheduled: 3 },
    });
  });
});

describe("buildScoreRingsBlock() — selection + module gating", () => {
  it("returns [] for an empty selection without touching any engine", async () => {
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      [],
      moduleMap(),
      NOW,
      medsToday(1, 3),
    );
    expect(rings).toEqual([]);
    expect(loadBaselineProfile).not.toHaveBeenCalled();
    expect(computeDerivedMetric).not.toHaveBeenCalled();
  });

  it("drops rings whose owning module is disabled", async () => {
    computeDerivedMetric.mockResolvedValue({
      status: "ok",
      value: { score: 80, band: "green" },
    });
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["READINESS", "SLEEP_SCORE"],
      moduleMap({ recovery: false }),
      NOW,
      null,
    );
    expect(rings).toEqual([{ id: "SLEEP_SCORE", score: 80, band: "green" }]);
    expect(computeDerivedMetric).toHaveBeenCalledTimes(1);
    expect(computeDerivedMetric).toHaveBeenCalledWith(
      expect.objectContaining({ metric: "SLEEP_SCORE", userId: "user-1" }),
    );
  });

  it("keeps derived rings with AI analysis off: the scores are data", async () => {
    computeDerivedMetric.mockResolvedValue({
      status: "ok",
      value: { score: 70, band: "yellow" },
    });
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["READINESS", "MED_COMPLIANCE"],
      moduleMap({ insights: false }),
      NOW,
      medsToday(2, 2),
    );
    expect(rings.map((r) => r.id)).toEqual(["READINESS", "MED_COMPLIANCE"]);
  });

  it("drops the dose ring with the medications module off", async () => {
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["MED_COMPLIANCE"],
      moduleMap({ medications: false }),
      NOW,
      medsToday(2, 2),
    );
    expect(rings).toEqual([]);
  });
});

describe("buildScoreRingsBlock() — derived rings", () => {
  it("passes through the engine's score + band (rounded) in selection order", async () => {
    computeDerivedMetric.mockImplementation(
      async ({ metric }: { metric: string }) =>
        metric === "READINESS"
          ? {
              status: "ok",
              value: {
                score: 71.6,
                band: "green",
                fresh: true,
                asOfDay: "2026-07-01",
              },
            }
          : { status: "ok", value: { score: 38, band: "red" } },
    );
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["RECOVERY_SCORE", "READINESS"],
      moduleMap(),
      NOW,
      null,
    );
    expect(rings).toEqual([
      { id: "RECOVERY_SCORE", score: 38, band: "red", source: "WHOOP" },
      {
        id: "READINESS",
        score: 72,
        band: "green",
        fresh: true,
        asOfDay: "2026-07-01",
      },
    ]);
    // Profile loaded exactly once (the batch-route pattern).
    expect(loadBaselineProfile).toHaveBeenCalledTimes(1);
  });

  it("a non-ok compute yields no ring (self-gating, never a fabricated value)", async () => {
    computeDerivedMetric.mockResolvedValue({
      status: "insufficient",
      reason: "not_enough_history",
    });
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["SLEEP_SCORE"],
      moduleMap(),
      NOW,
      null,
    );
    expect(rings).toEqual([]);
  });

  it("a throwing engine drops only its own ring (fail-soft)", async () => {
    computeDerivedMetric.mockImplementation(
      async ({ metric }: { metric: string }) => {
        if (metric === "READINESS") throw new Error("engine down");
        return { status: "ok", value: { score: 55, band: "yellow" } };
      },
    );
    const rings = await buildScoreRingsBlock(
      fakePrisma,
      "user-1",
      ["READINESS", "SLEEP_SCORE"],
      moduleMap(),
      NOW,
      null,
    );
    expect(rings).toEqual([{ id: "SLEEP_SCORE", score: 55, band: "yellow" }]);
  });
});

describe("buildScoreRingsBlock() — 1.50 freshness and the proxy rule", () => {
  function engine(readiness: Record<string, unknown> | null) {
    computeDerivedMetric.mockImplementation(
      async ({ metric }: { metric: string }) => {
        if (metric === "READINESS")
          return readiness
            ? { status: "ok", value: readiness }
            : { status: "insufficient", reason: "insufficient_components" };
        return { status: "ok", value: { score: 38, band: "red" } };
      },
    );
  }
  const build = (ids: Array<"READINESS" | "RECOVERY_SCORE">) =>
    buildScoreRingsBlock(fakePrisma, "user-1", ids, moduleMap(), NOW, null);

  it("a readiness that is not fresh keeps its score and day but has no band", async () => {
    engine({ score: 81, band: "green", fresh: false, asOfDay: "2026-06-30" });
    expect(await build(["READINESS"])).toEqual([
      {
        id: "READINESS",
        score: 81,
        band: null,
        fresh: false,
        asOfDay: "2026-06-30",
      },
    ]);
  });

  it("drops the proxy recovery ring beside a READINESS ring", async () => {
    setRecoverySource("COMPUTED");
    engine({ score: 70, band: "green", fresh: true, asOfDay: "2026-07-01" });
    const rings = await build(["RECOVERY_SCORE", "READINESS"]);
    expect(rings.map((r) => r.id)).toEqual(["READINESS"]);
  });

  it("keeps the proxy ring when READINESS is not selected (until 1.51)", async () => {
    setRecoverySource("COMPUTED");
    engine({ score: 70, band: "green", fresh: true, asOfDay: "2026-07-01" });
    expect(await build(["RECOVERY_SCORE"])).toEqual([
      { id: "RECOVERY_SCORE", score: 38, band: "red", source: "COMPUTED" },
    ]);
  });

  it("keeps the proxy ring when READINESS is selected but has no ring", async () => {
    setRecoverySource("COMPUTED");
    engine(null);
    const rings = await build(["RECOVERY_SCORE", "READINESS"]);
    expect(rings.map((r) => r.id)).toEqual(["RECOVERY_SCORE"]);
  });

  it("keeps a device's recovery ring beside READINESS: Oura and Polar are device scores", async () => {
    for (const source of ["WHOOP", "OURA", "POLAR"]) {
      setRecoverySource(source);
      engine({ score: 70, band: "green", fresh: true, asOfDay: "2026-07-01" });
      const rings = await build(["RECOVERY_SCORE", "READINESS"]);
      expect(rings.map((r) => [r.id, r.source])).toEqual([
        ["RECOVERY_SCORE", source],
        ["READINESS", undefined],
      ]);
    }
  });
});
