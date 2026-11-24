/**
 * The Coach reply in the app's punctuation: `guardReply` runs the same
 * `plainSeparators` the briefing and the status notes use, so the text every
 * token frame is cut from, and the stored row, carry a comma where the model
 * put a spaced dash, keep a range as a range, and leave code alone.
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

const INVENTORY = ["pulse", "resting_hr", "walking_hr"].map((metric) => ({
  tool: "get_metric_series",
  metric,
  domain: metric,
  present: true,
}));

function run(content: string) {
  const model = {
    ok: true,
    result: { content },
    toolTrace: [],
    toolResultPayloads: [],
    inventoryPayloads: [],
    noToolsSnapshotPayloads: [],
    inventory: INVENTORY,
    steps: [],
    results: [],
    forcedFinal: false,
  } as unknown as Extract<ModelOutcome, { ok: true }>;
  const ctx = {
    scheduleDoses: [],
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

describe("guardReply: separators", () => {
  beforeEach(() => {
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });

  it("turns a spaced dash between clauses into a comma", async () => {
    const out = await run(
      "Your week was steady — nothing needs changing · keep the rhythm.",
    );
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe(
      "Your week was steady, nothing needs changing, keep the rhythm.",
    );
  });

  it("keeps a range a range, spaced or not", async () => {
    const out = await run("Aim for 3 – 5 walks a week, or 3–5 if you can.");
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe(
      "Aim for 3–5 walks a week, or 3–5 if you can.",
    );
  });

  it("leaves code exactly as the model wrote it", async () => {
    const reply = [
      "Run it like this — once a day:",
      "```",
      "a — b · c",
      "```",
      "and keep `x — y` as it is.",
    ].join("\n");
    const out = await run(reply);
    if (!out.ok) throw new Error(out.code);
    expect(out.reply.replyText).toBe(
      [
        "Run it like this, once a day:",
        "```",
        "a — b · c",
        "```",
        "and keep `x — y` as it is.",
      ].join("\n"),
    );
  });
});
