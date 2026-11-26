import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/insights/derived", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/derived")>();
  return { ...actual, computeDerivedMetric: vi.fn() };
});

let recoverySource = "WHOOP";
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(async () => [
        {
          value: 30,
          measuredAt: new Date("2026-06-02T05:00:00Z"),
          source: recoverySource,
        },
      ]),
    },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
  },
}));

import { computeDerivedMetric } from "@/lib/insights/derived";
import {
  detectDerivedBriefingSignals,
  buildDerivedBriefingPrompt,
} from "../derived-briefing";

const compute = computeDerivedMetric as unknown as ReturnType<typeof vi.fn>;
const PROFILE = { ageYears: 40, sex: "MALE" as const, heightCm: 180 };
const NOW = new Date("2026-06-02T08:00:00Z");

function ok(score: number, band: string, confidence: number, fresh = true) {
  return {
    status: "ok" as const,
    value: { score, band, fresh },
    coverage: {
      requiredInputs: 1,
      presentInputs: 1,
      historyDays: 14,
      missing: [],
    },
    confidence: { score: confidence, band: "medium" as const },
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
  reason: "x",
};

beforeEach(() => {
  compute.mockReset();
  recoverySource = "WHOOP";
});

describe("detectDerivedBriefingSignals", () => {
  it("returns null when nothing is notable", async () => {
    // green band → not notable even at high confidence
    compute.mockResolvedValue(ok(82, "green", 90));
    expect(await detectDerivedBriefingSignals("u1", PROFILE, NOW)).toBeNull();
  });

  it("gates out low-confidence signals", async () => {
    compute.mockResolvedValue(ok(35, "red", 30));
    expect(await detectDerivedBriefingSignals("u1", PROFILE, NOW)).toBeNull();
  });

  it("surfaces a notable, confident yellow/red signal", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS") return ok(48, "yellow", 70);
      return insufficient;
    });
    const ctx = await detectDerivedBriefingSignals("u1", PROFILE, NOW);
    expect(ctx).not.toBeNull();
    expect(ctx!.signals).toHaveLength(1);
    expect(ctx!.signals[0]).toMatchObject({
      sourceMetric: "readiness",
      score: 48,
      band: "yellow",
    });
  });

  it("isolates a per-metric compute failure", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) => {
      if (args?.metric === "READINESS") throw new Error("boom");
      if (args?.metric === "RECOVERY_SCORE") return ok(30, "red", 88);
      return insufficient;
    });
    const ctx = await detectDerivedBriefingSignals("u1", PROFILE, NOW);
    expect(ctx!.signals.map((s) => s.sourceMetric)).toEqual(["recovery"]);
    expect(ctx!.signals[0].label).toBe("WHOOP Recovery (device score)");
  });

  it("never offers the computed proxy, which is HealthLog's readiness", async () => {
    recoverySource = "COMPUTED";
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "RECOVERY_SCORE" ? ok(30, "red", 88) : insufficient,
    );
    expect(await detectDerivedBriefingSignals("u1", PROFILE, NOW)).toBeNull();
  });

  it("offers an Oura recovery under Oura's own name", async () => {
    recoverySource = "OURA";
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "RECOVERY_SCORE" ? ok(30, "red", 88) : insufficient,
    );
    const ctx = await detectDerivedBriefingSignals("u1", PROFILE, NOW);
    expect(ctx!.signals[0].label).toBe("Oura Readiness (device score)");
  });

  it("says nothing about a readiness that is not fresh", async () => {
    compute.mockImplementation(async (args?: { metric?: string }) =>
      args?.metric === "READINESS" ? ok(48, "yellow", 70, false) : insufficient,
    );
    expect(await detectDerivedBriefingSignals("u1", PROFILE, NOW)).toBeNull();
  });
});

describe("buildDerivedBriefingPrompt", () => {
  it("renders an EN system-context block citing the value + band", () => {
    const prompt = buildDerivedBriefingPrompt(
      {
        signals: [
          {
            sourceMetric: "readiness",
            label: "readiness",
            score: 48,
            band: "yellow",
            confidence: 70,
          },
        ],
      },
      "en",
    );
    expect(prompt).toContain("DERIVED WELLNESS SIGNALS");
    expect(prompt).toContain("readiness: 48/100");
    expect(prompt).toContain("NEVER recommend");
  });

  it("renders a DE block for the de locale", () => {
    const prompt = buildDerivedBriefingPrompt(
      {
        signals: [
          {
            sourceMetric: "recovery",
            label: "recovery",
            score: 30,
            band: "red",
            confidence: 88,
          },
        ],
      },
      "de",
    );
    expect(prompt).toContain("ABGELEITETE WELLNESS-SIGNALE");
  });
});
