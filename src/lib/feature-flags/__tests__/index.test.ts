import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { prisma } from "@/lib/db";
import {
  ASSISTANT_FLAGS_DEFAULT,
  AssistantDisabledError,
  getAssistantFlags,
  requireAssistantSurface,
  resolveAssistantFlags,
} from "../index";

const FIND = prisma.appSettings.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  FIND.mockReset();
});

describe("resolveAssistantFlags", () => {
  it("returns the input unchanged when master is on", () => {
    const input = {
      enabled: true,
      coach: true,
      briefing: false,
      insightStatus: true,
      correlations: false,
      healthScoreExplainer: true,
    };
    expect(resolveAssistantFlags(input)).toEqual(input);
  });

  it("forces every sub-flag false when master is off", () => {
    const input = {
      enabled: false,
      coach: true,
      briefing: true,
      insightStatus: true,
      correlations: true,
      healthScoreExplainer: true,
    };
    expect(resolveAssistantFlags(input)).toEqual({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
      correlations: false,
      healthScoreExplainer: false,
    });
  });
});

describe("getAssistantFlags", () => {
  it("returns defaults when the row is missing", async () => {
    FIND.mockResolvedValue(null);
    const flags = await getAssistantFlags();
    expect(flags).toEqual(ASSISTANT_FLAGS_DEFAULT);
  });

  it("reads each column correctly", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: false,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: false,
    });
    const flags = await getAssistantFlags();
    expect(flags).toEqual({
      enabled: true,
      coach: false,
      briefing: true,
      insightStatus: false,
      correlations: true,
      healthScoreExplainer: false,
    });
  });

  it("forces every sub-flag false when master is off", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    const flags = await getAssistantFlags();
    expect(flags).toEqual({
      enabled: false,
      coach: false,
      briefing: false,
      insightStatus: false,
      correlations: false,
      healthScoreExplainer: false,
    });
  });

  it("falls back to defaults on a Prisma error", async () => {
    FIND.mockRejectedValue(new Error("db down"));
    const flags = await getAssistantFlags();
    expect(flags).toEqual(ASSISTANT_FLAGS_DEFAULT);
  });
});

describe("requireAssistantSurface", () => {
  it("returns the resolved flag set when the surface is enabled", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    const flags = await requireAssistantSurface("coach");
    expect(flags.coach).toBe(true);
  });

  it("throws AssistantDisabledError when the sub-flag is off", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: false,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    await expect(requireAssistantSurface("coach")).rejects.toThrow(
      AssistantDisabledError,
    );
  });

  it("throws AssistantDisabledError when the master kills the surface", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: false,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    await expect(requireAssistantSurface("briefing")).rejects.toThrow(
      AssistantDisabledError,
    );
  });

  it("AssistantDisabledError carries the surface-tagged errorCode", () => {
    const err = new AssistantDisabledError("correlations");
    expect(err.surface).toBe("correlations");
    expect(err.errorCode).toBe("assistant.disabled.correlations");
  });
});
