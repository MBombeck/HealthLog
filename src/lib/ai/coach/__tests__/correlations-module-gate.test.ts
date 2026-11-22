/**
 * v1.30.22 — the `insights` gate on the correlations reader.
 *
 * `readCoachCorrelations` is reached from four places — the Coach
 * `get_correlations` tool, the MCP `get_correlation` rich read, the
 * per-metric "Coach read" strip, and the Coach snapshot — and only the REST
 * sibling `/api/insights/correlations` ever gated. The reader also feeds on
 * mood, symptom and compliance channels, so a mood-disabled account could
 * receive pair rows naming mood with direction, lag, n and r.
 *
 * The gate lives in the reader, so these assertions cover every caller at
 * once. That is the point of the placement: a fifth caller cannot reintroduce
 * the gap by forgetting.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
  // Every module on: the record's map feeds the matrix mask.
  resolveModuleMap: vi.fn(async () => ({})),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => null,
}));

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: { findUnique: vi.fn() },
    measurement: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    userSourcePriority: { findMany: vi.fn() },
  },
}));
// The per-type measurement read is raw SQL; serve it from the findMany mock.
vi.mock("@/lib/measurements/newest-per-type", async () =>
  (
    await import("@/__tests__/helpers/newest-per-type-mock")
  ).newestPerTypeMock(),
);

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

import { readCoachCorrelations } from "../tools/correlations-read";
import { isModuleEnabled } from "@/lib/modules/gate";

const USER = "u1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isModuleEnabled).mockImplementation(async () => true);
  prismaMock.user.findUnique.mockResolvedValue({ timezone: "Europe/Berlin" });
  prismaMock.measurement.findMany.mockResolvedValue([]);
  prismaMock.moodEntry.findMany.mockResolvedValue([]);
  prismaMock.userSourcePriority.findMany.mockResolvedValue([]);
});

describe("readCoachCorrelations — insights module gate", () => {
  it("gates on `insights`, not on a per-domain key", async () => {
    await readCoachCorrelations(USER, "en");
    expect(isModuleEnabled).toHaveBeenCalledWith(USER, "insights");
  });

  it("omits with the module OFF, and reads nothing at all", async () => {
    vi.mocked(isModuleEnabled).mockImplementation(async () => false);

    const res = await readCoachCorrelations(USER, "en");

    expect(res.present).toBe(false);
    // Distinct from `no_data`: the assistant is told the domain is switched
    // off rather than inferring the user has no correlatable history.
    expect(res.reason).toBe("module_disabled");
    // The gate short-circuits before any channel is sourced. This is the
    // load-bearing assertion — the reader draws on mood / symptom /
    // compliance channels, so "computed then hid it" would still have pulled
    // a disabled domain's rows into this process.
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
    expect(prismaMock.moodEntry.findMany).not.toHaveBeenCalled();
  });

  it("proceeds to the engine with the module ON", async () => {
    const res = await readCoachCorrelations(USER, "en");
    // The synthetic fixture has no paired data, so the honest answer is a
    // miss — but it must be the ENGINE's miss, reached after the real reads
    // ran, not the gate's.
    expect(prismaMock.measurement.findMany).toHaveBeenCalled();
    expect(res.reason).not.toBe("module_disabled");
  });

  it("closes the operator kill-switch path, not only the user toggle", async () => {
    // `isModuleEnabled` resolves `operatorAvailable && userEnabled`, so a
    // server-wide operator disable arrives here as the same `false`. Asserted
    // explicitly because it is the sharper case: the account holder cannot
    // override an operator decision, so a leak past it is strictly worse than
    // one past a personal preference.
    vi.mocked(isModuleEnabled).mockImplementation(
      async (_u: string, key: string) => key !== "insights",
    );

    const res = await readCoachCorrelations(USER, "en");

    expect(res.present).toBe(false);
    expect(res.reason).toBe("module_disabled");
    expect(prismaMock.measurement.findMany).not.toHaveBeenCalled();
  });

  it("surfaces a gate failure instead of swallowing it as a miss", async () => {
    // The reader's body is fail-soft (any throw degrades to
    // `{ present: false }`) so a correlation hiccup never sinks a Coach turn.
    // The gate sits OUTSIDE that try/catch on purpose: a broken gate must be
    // loud, not silently indistinguishable from "no pattern found".
    vi.mocked(isModuleEnabled).mockRejectedValue(new Error("gate down"));

    await expect(readCoachCorrelations(USER, "en")).rejects.toThrow(
      "gate down",
    );
  });
});
