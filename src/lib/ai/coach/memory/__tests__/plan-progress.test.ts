/**
 * v1.41 — the progress sentence beside an active plan, and the briefing's
 * plan lines.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));

const state = vi.hoisted(() => ({
  rows: [] as Array<{ day: string; sum: number; n: number }>,
  briefing: true,
  coach: true,
  plans: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/measurements/day-aggregates", () => ({
  readDayAggregates: vi.fn(async () =>
    state.rows.map((r) => ({ ...r, segment: 0, min: 0, max: 0 })),
  ),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: vi.fn(async () => ({
    available: state.briefing,
    reason: state.briefing ? null : "operator_disabled",
    onDeviceAllowed: true,
  })),
}));
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => state.coach),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    coachPlan: { findMany: vi.fn(async () => state.plans) },
    user: { findUnique: vi.fn(async () => ({ unitPreference: "metric" })) },
  },
}));

import { prisma } from "@/lib/db";
import { DEFAULT_UNIT_PREFERENCES } from "@/lib/measurements/display-transform";

import { buildPlanProgressLines, computePlanProgress } from "../plan-progress";

const NOW = new Date("2026-10-06T12:00:00Z");
const START = new Date("2026-09-15T09:00:00Z");
const CTX = {
  userId: "u1",
  timeZone: "UTC",
  units: DEFAULT_UNIT_PREFERENCES,
  now: NOW,
};

function day(key: string, value: number, n = 1) {
  return { day: key, sum: value * n, n };
}

beforeEach(() => {
  state.rows = [];
  state.briefing = true;
  state.coach = true;
  state.plans = [];
  vi.clearAllMocks();
});

describe("computePlanProgress", () => {
  it("states the recent mean, the change against before, and the trend", async () => {
    state.rows = [
      day("2026-09-05", 80),
      day("2026-09-08", 80),
      day("2026-09-12", 80),
      day("2026-09-16", 79.6),
      day("2026-09-22", 79.2),
      day("2026-09-29", 78.8),
      day("2026-10-02", 78.6),
      day("2026-10-05", 78.4),
    ];
    const line = await computePlanProgress(
      { metric: "WEIGHT", startedAt: START, target: "75 kg\nby December" },
      CTX,
    );
    expect(line).toMatch(
      /^weight plan since 2026-09-15; target "75 kg by December": /,
    );
    expect(line).toContain("latest 7-day mean 78.5 kg");
    expect(line).toContain("against 80 kg in the 14 days before");
    expect(line).toMatch(/trend -0\.\d kg per week/);
  });

  it("says when there are too few readings to call it", async () => {
    state.rows = [day("2026-09-20", 79)];
    const line = await computePlanProgress(
      { metric: "WEIGHT", startedAt: START, target: null },
      CTX,
    );
    expect(line).toBe(
      "weight plan since 2026-09-15: 1 day(s) with readings since the start, too few to call progress yet.",
    );
  });

  it("reads a step plan as daily totals, not per-sample means", async () => {
    state.rows = [
      day("2026-10-01", 1000, 9),
      day("2026-10-03", 1000, 9),
      day("2026-10-05", 1000, 9),
    ];
    const line = await computePlanProgress(
      { metric: "STEPS", startedAt: START, target: null },
      CTX,
    );
    expect(line).toContain("latest 7-day mean 9000");
  });

  it("has nothing to say about a metric without a series", async () => {
    await expect(
      computePlanProgress(
        { metric: "MEDITATION", startedAt: START, target: null },
        CTX,
      ),
    ).resolves.toBeNull();
  });
});

describe("buildPlanProgressLines", () => {
  it("reads nothing while the briefing may not reach a model", async () => {
    state.briefing = false;
    await expect(buildPlanProgressLines("u1", { now: NOW })).resolves.toEqual(
      [],
    );
    expect(prisma.coachPlan.findMany).not.toHaveBeenCalled();
  });

  it("reads nothing while the Coach module is off", async () => {
    state.coach = false;
    await expect(buildPlanProgressLines("u1", { now: NOW })).resolves.toEqual(
      [],
    );
    expect(prisma.coachPlan.findMany).not.toHaveBeenCalled();
  });

  it("gives at most two lines, from active plans only", async () => {
    state.rows = [
      day("2026-09-20", 79),
      day("2026-09-25", 79),
      day("2026-10-04", 78),
    ];
    state.plans = [1, 2, 3].map((n) => ({
      metric: "WEIGHT",
      targetEncrypted: null,
      createdAt: START,
      id: `p${n}`,
    }));
    const lines = await buildPlanProgressLines("u1", { now: NOW });
    expect(lines).toHaveLength(2);
    const where = vi.mocked(prisma.coachPlan.findMany).mock.calls[0][0]
      ?.where as Record<string, unknown>;
    expect(where).toMatchObject({ userId: "u1", status: "active" });
  });
});
