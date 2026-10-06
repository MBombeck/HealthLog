/**
 * The turn's medication names reach the outbound dose screen: the Coach reply
 * and the trail text both treat a scheduled brand name as a medication noun,
 * so "skip the Eliquis" is replaced with the dose fallback.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: { coachMessage: { findMany: (...a: unknown[]) => findMany(...a) } },
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/ai/coach/reminders", () => ({
  parseRememberSentinel: (prose: string) => ({ prose, reminder: null }),
  captureReminderFromSentinel: vi.fn(),
}));

import { guardReply } from "../reply-guards";
import type { TurnContext } from "../context";
import type { ModelOutcome } from "../model";
import type { TurnConversation } from "../types";
import { COACH_OUTBOUND_DOSE_BLOCK_EN } from "@/lib/ai/coach/outbound-guard";
import { screenActivityTitle } from "@/lib/ai/coach/activity/screen";

const SKIP = "Skip the Eliquis tomorrow before the race.";

function run(content: string, medicationNames: string[]) {
  const model = {
    ok: true,
    result: { content },
    toolTrace: [],
    toolResultPayloads: [],
    inventoryPayloads: [],
    noToolsSnapshotPayloads: [],
    inventory: [],
    steps: [],
    results: [],
    forcedFinal: false,
  } as unknown as Extract<ModelOutcome, { ok: true }>;
  const ctx = {
    scheduleDoses: [],
    medicationNames,
    aboutMe: null,
    turnContext: { guidedBlock: "", includeFullSnapshot: false },
    snapshot: { referenceGrounding: null },
  } as unknown as TurnContext;
  const conversation: TurnConversation = {
    conversationId: "conv1",
    priorTurns: [],
    priorUserMessages: [],
    priorToolFigures: [],
    priorSummary: null,
  };
  return guardReply({
    userId: "u1",
    locale: "en",
    conversation,
    ctx,
    toolMode: true,
    model,
  });
}

describe("guardReply — the schedule's medication names", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it("replaces a skip of a scheduled brand with the dose fallback", async () => {
    const out = await run(SKIP, ["Eliquis 5 mg"]);
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe(COACH_OUTBOUND_DOSE_BLOCK_EN);
  });

  it("leaves the same sentence alone when the brand is not on the schedule", async () => {
    const out = await run(SKIP, []);
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe(SKIP);
  });
});

describe("screenActivityTitle — the schedule's medication names", () => {
  it("drops a trail title that skips a scheduled brand", () => {
    const ctx = { locale: "en" as const, figures: () => [] };
    expect(screenActivityTitle(SKIP, ctx)).toBe(SKIP);
    expect(
      screenActivityTitle(SKIP, { ...ctx, medicationNames: ["Eliquis"] }),
    ).toBeNull();
  });
});
