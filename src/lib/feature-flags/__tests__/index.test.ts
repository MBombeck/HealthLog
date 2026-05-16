import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn(),
    },
  },
}));

// v1.4.33 — `mockEvent` lets the dedicated memoisation describe-block
// below pin a stable WideEventBuilder stub so the per-request cache
// keys on the same reference across multiple `getAssistantFlags()`
// calls. The legacy describe-blocks leave `mockEvent` null so every
// call gets a fresh `{}` and the memo never collapses — preserves the
// pre-v1.4.33 assertion semantics.
let mockEvent: object | null = null;
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => mockEvent ?? { addWarning: vi.fn() },
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
  mockEvent = null;
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

describe("per-request memoisation", () => {
  // v1.4.33 — When the same request opens the Coach drawer, five gated
  // routes (`/api/insights/chat`, the rail list, each `<metric>-status`
  // call, etc.) all funnel through `getAssistantFlags()` → `AppSettings`
  // read. The memo on the active WideEventBuilder collapses those to
  // one DB hit.
  it("collapses repeated reads inside the same request to one DB call", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });
    // Pin a stable stub object so every `getEvent()` inside this test
    // returns the same reference — the memo keys on identity, so a
    // shared reference == shared cache.
    mockEvent = { addWarning: vi.fn() };

    const a = await getAssistantFlags();
    const b = await getAssistantFlags();
    const c = await getAssistantFlags();

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(FIND).toHaveBeenCalledTimes(1);
  });

  it("issues independent reads when the request context changes", async () => {
    FIND.mockResolvedValue({
      assistantEnabled: true,
      assistantCoachEnabled: true,
      assistantBriefingEnabled: true,
      assistantInsightStatusEnabled: true,
      assistantCorrelationsEnabled: true,
      assistantHealthScoreExplainerEnabled: true,
    });

    mockEvent = { addWarning: vi.fn(), id: "req-1" };
    await getAssistantFlags();
    mockEvent = { addWarning: vi.fn(), id: "req-2" };
    await getAssistantFlags();

    expect(FIND).toHaveBeenCalledTimes(2);
  });
});
