import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForJob: vi.fn(),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
const newestMessage = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    coachMessage: { findFirst: (...a: unknown[]) => newestMessage(...a) },
  },
}));
vi.mock("../coach-memory-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../coach-memory-shared")>()),
  enqueueCoachMemoryRefresh: vi.fn(async () => undefined),
}));
vi.mock("../conversation-summary", () => ({
  refreshConversationSummary: vi.fn(async () => ({ status: "refreshed" })),
}));
vi.mock("../facts", () => ({
  extractAndStoreFacts: vi.fn(async () => ({ status: "stored", count: 1 })),
}));
vi.mock("../plans", () => ({
  extractAndStorePlanProposals: vi.fn(async () => ({
    status: "stored",
    count: 0,
  })),
}));

import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { annotate } from "@/lib/logging/context";
import { runCoachMemoryRefresh } from "../coach-memory-refresh-worker";
import {
  COACH_MEMORY_QUIET_MS,
  enqueueCoachMemoryRefresh,
} from "../coach-memory-shared";
import { refreshConversationSummary } from "../conversation-summary";
import { extractAndStoreFacts } from "../facts";
import { extractAndStorePlanProposals } from "../plans";

const payload = { conversationId: "c1", userId: "u1", locale: "en" as const };
const NOW = new Date("2026-10-06T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  // Quiet for an hour by default.
  newestMessage.mockResolvedValue({
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
  });
});

describe("runCoachMemoryRefresh", () => {
  it("runs all three steps when the Coach is available", async () => {
    vi.mocked(aiCapabilityForJob).mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    await runCoachMemoryRefresh(payload, NOW);
    expect(aiCapabilityForJob).toHaveBeenCalledWith("u1", "coach");
    expect(refreshConversationSummary).toHaveBeenCalled();
    expect(extractAndStoreFacts).toHaveBeenCalled();
    expect(extractAndStorePlanProposals).toHaveBeenCalled();
  });

  it.each(["operator_disabled", "user_disabled", "consent_required"] as const)(
    "reads no transcript and runs no step when the Coach is unavailable (%s)",
    async (reason) => {
      vi.mocked(aiCapabilityForJob).mockResolvedValue({
        available: false,
        reason,
        onDeviceAllowed: false,
      });
      await runCoachMemoryRefresh(payload, NOW);
      expect(refreshConversationSummary).not.toHaveBeenCalled();
      expect(extractAndStoreFacts).not.toHaveBeenCalled();
      expect(extractAndStorePlanProposals).not.toHaveBeenCalled();
      expect(annotate).toHaveBeenCalledWith({
        action: { name: "coach.memory.refresh.skipped" },
        meta: { reason },
      });
    },
  );

  it("puts itself back while the conversation is still going", async () => {
    vi.mocked(aiCapabilityForJob).mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    newestMessage.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    await runCoachMemoryRefresh(payload, NOW);
    expect(enqueueCoachMemoryRefresh).toHaveBeenCalledWith(
      { conversationId: "c1", userId: "u1", locale: "en" },
      COACH_MEMORY_QUIET_MS - 10 * 60_000,
    );
    expect(extractAndStoreFacts).not.toHaveBeenCalled();
    expect(aiCapabilityForJob).not.toHaveBeenCalled();
  });

  it("runs on a short conversation once it is quiet (no twenty-turn gate)", async () => {
    vi.mocked(aiCapabilityForJob).mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });
    await runCoachMemoryRefresh(payload, NOW);
    expect(extractAndStoreFacts).toHaveBeenCalledWith("c1", "u1", {
      locale: "en",
    });
  });

  it("does nothing for a conversation that is gone", async () => {
    newestMessage.mockResolvedValue(null);
    await runCoachMemoryRefresh(payload, NOW);
    expect(aiCapabilityForJob).not.toHaveBeenCalled();
    expect(enqueueCoachMemoryRefresh).not.toHaveBeenCalled();
  });
});
