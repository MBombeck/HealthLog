/**
 * v1.41 — the Coach turn's level as the chat route resolves it: the stored
 * preference against the operator's controls, read through the real loader
 * against a stubbed settings row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { row, user } = vi.hoisted(() => ({
  row: { current: null as unknown, fail: false },
  user: { level: null as string | null, fail: false },
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(async () => {
        if (row.fail) throw new Error("db down");
        return row.current;
      }),
    },
    user: {
      findUnique: vi.fn(async () => {
        if (user.fail) throw new Error("user db down");
        return { aiUsageLevel: user.level };
      }),
    },
  },
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => undefined,
}));

import {
  loadReasoningControls,
  resolveCoachTurnReasoningLevel,
  resolveJobReasoning,
} from "../controls";

beforeEach(() => {
  row.current = null;
  row.fail = false;
  user.level = null;
  user.fail = false;
});

describe("loadReasoningControls", () => {
  it("reads an untouched instance as on and uncapped", async () => {
    expect(await loadReasoningControls()).toEqual({
      enabled: true,
      maxEffort: "high",
    });
  });

  it("fails closed when the row cannot be read", async () => {
    row.fail = true;
    expect((await loadReasoningControls()).enabled).toBe(false);
  });

  it("reads an unknown stored cap as no cap", async () => {
    row.current = { aiReasoningEnabled: true, aiReasoningMaxEffort: "xhigh" };
    expect((await loadReasoningControls()).maxEffort).toBe("high");
  });
});

describe("resolveCoachTurnReasoningLevel", () => {
  it("runs a never-chosen preference at medium", async () => {
    expect(await resolveCoachTurnReasoningLevel(null)).toBe("medium");
    expect(await resolveCoachTurnReasoningLevel({ tone: "warm" })).toBe(
      "medium",
    );
  });

  it("reads a malformed stored level as the default", async () => {
    expect(await resolveCoachTurnReasoningLevel({ reasoning: "max" })).toBe(
      "medium",
    );
  });

  it("clamps the stored level to the operator's cap", async () => {
    row.current = { aiReasoningEnabled: true, aiReasoningMaxEffort: "low" };
    expect(await resolveCoachTurnReasoningLevel({ reasoning: "high" })).toBe(
      "low",
    );
  });

  it("is off when the operator switched reasoning off", async () => {
    row.current = { aiReasoningEnabled: false, aiReasoningMaxEffort: "high" };
    expect(await resolveCoachTurnReasoningLevel({ reasoning: "high" })).toBe(
      "off",
    );
  });

  it("is off when the controls cannot be read", async () => {
    row.fail = true;
    expect(await resolveCoachTurnReasoningLevel({ reasoning: "high" })).toBe(
      "off",
    );
  });
});

// #1217 — background reasoning per AI usage level.
describe("resolveJobReasoning by usage level", () => {
  const chain = [{ providerType: "openai" as const }];

  it("asks for nothing on frugal", async () => {
    user.level = "FRUGAL";
    row.current = { aiUsageMaxLevel: "FULL", aiUsageDefaultLevel: "STANDARD" };
    expect(
      await resolveJobReasoning("daily_briefing", chain, "u1"),
    ).toBeUndefined();
  });

  it.each(["STANDARD", "FULL"])(
    "keeps the job's level on %s",
    async (level) => {
      user.level = level;
      row.current = {
        aiUsageMaxLevel: "FULL",
        aiUsageDefaultLevel: "STANDARD",
      };
      expect(await resolveJobReasoning("daily_briefing", chain, "u1")).toEqual({
        effort: "medium",
        summaries: false,
        maxEffort: "high",
      });
    },
  );

  it("clamps maxEffort to admin ceiling when admin caps at low", async () => {
    row.current = {
      aiReasoningEnabled: true,
      aiReasoningMaxEffort: "low",
      aiUsageMaxLevel: "FULL",
      aiUsageDefaultLevel: "STANDARD",
    };
    expect(await resolveJobReasoning("daily_briefing", chain, "u1")).toEqual({
      effort: "low",
      summaries: false,
      maxEffort: "low",
    });
  });

  it("follows a frugal instance default for an account without a choice", async () => {
    row.current = {
      aiUsageMaxLevel: "STANDARD",
      aiUsageDefaultLevel: "FRUGAL",
    };
    expect(
      await resolveJobReasoning("daily_briefing", chain, "u1"),
    ).toBeUndefined();
  });

  it("returns explicit off with maxEffort off for antigravity chain on frugal or admin disabled", async () => {
    const agyChain = [{ providerType: "antigravity" as const }];
    user.level = "FRUGAL";
    row.current = { aiUsageMaxLevel: "FULL", aiUsageDefaultLevel: "STANDARD" };
    expect(await resolveJobReasoning("daily_briefing", agyChain, "u1")).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    user.level = "FULL";
    row.current = {
      aiReasoningEnabled: false,
      aiUsageMaxLevel: "FULL",
      aiUsageDefaultLevel: "STANDARD",
    };
    expect(await resolveJobReasoning("daily_briefing", agyChain, "u1")).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });

    // Non-antigravity chain receives undefined on admin disabled
    expect(
      await resolveJobReasoning("daily_briefing", chain, "u1"),
    ).toBeUndefined();
  });

  it("fails closed with explicit off for antigravity chain when db errors occur, while non-antigravity receives undefined", async () => {
    const agyChain = [{ providerType: "antigravity" as const }];

    // 1. DB failure during loadRecordUsageLevel
    user.fail = true;
    expect(await resolveJobReasoning("daily_briefing", agyChain, "u1")).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });
    expect(
      await resolveJobReasoning("daily_briefing", chain, "u1"),
    ).toBeUndefined();

    // 2. DB failure during loadReasoningControls
    user.fail = false;
    row.fail = true;
    expect(await resolveJobReasoning("daily_briefing", agyChain, "u1")).toEqual({
      effort: "off",
      summaries: false,
      maxEffort: "off",
    });
    expect(
      await resolveJobReasoning("daily_briefing", chain, "u1"),
    ).toBeUndefined();
  });
});
