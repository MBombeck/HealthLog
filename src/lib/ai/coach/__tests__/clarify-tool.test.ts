/**
 * v1.41 — clarifying questions asked through `ask_clarification`: the
 * triggers' kinds and their choices, the assumed choice first, and the
 * brake (never two in a row, one in six turns, three a day). Then the
 * dialog tool that runs it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  messageFindMany: vi.fn(),
  messageCount: vi.fn(),
  planFindMany: vi.fn(),
  illnessFindMany: vi.fn(),
  isModuleEnabled: vi.fn(),
  rememberFactFromTool: vi.fn(),
  proposePlanFromTool: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    coachMessage: { findMany: db.messageFindMany, count: db.messageCount },
    coachPlan: { findMany: db.planFindMany },
    illnessEpisode: { findMany: db.illnessFindMany },
  },
}));
vi.mock("@/lib/modules/gate", () => ({ isModuleEnabled: db.isModuleEnabled }));
vi.mock("@/lib/ai/coach/memory/contract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  rememberFactFromTool: db.rememberFactFromTool,
  proposePlanFromTool: db.proposePlanFromTool,
}));

import {
  CLARIFY_DAILY_LIMIT,
  assumptionFromClarification,
  buildClarificationFromTool,
  clarificationAllowed,
  loadClarifyRecordChoices,
  resolveClarificationAnswer,
} from "@/lib/ai/coach/clarify";
import {
  runDialogTool,
  type DialogToolContext,
} from "@/lib/ai/coach/tools/dialog-tools";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";

const series = (metric: string, present = true): InventoryEntry => ({
  tool: "get_metric_series",
  metric,
  domain: metric,
  present,
});
const PULSES = [series("pulse"), series("resting_hr"), series("walking_hr")];

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  db.messageFindMany.mockResolvedValue([]);
  db.messageCount.mockResolvedValue(0);
  db.isModuleEnabled.mockResolvedValue(true);
});

describe("buildClarificationFromTool", () => {
  it("offers the metrics the record holds, the assumed one first", () => {
    const out = buildClarificationFromTool({
      call: {
        kind: "metric",
        question: "Resting or walking pulse? Otherwise I'll look at resting.",
        choices: ["walking_hr", "resting_hr", "spo2"],
        assumption: "resting_hr",
      },
      inventory: PULSES,
      locale: "en",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(
      out.clarification.choices.map((c) => [c.id, c.value.metric]),
    ).toEqual([
      ["c1", "resting_hr"],
      ["c2", "walking_hr"],
    ]);
    expect(out.clarification.assumption).toBe("c1");
    // Labels come from the catalog, never from the model.
    expect(out.clarification.choices[0].labelKey).toBe(
      "insights.coach.metric.resting_hr",
    );
  });

  it("offers comparison bases from their catalog", () => {
    const out = buildClarificationFromTool({
      call: {
        kind: "comparison",
        question: "Compared with what? Otherwise the month before.",
        choices: ["previous_period", "year_ago", "whenever"],
      },
      inventory: null,
      locale: "en",
    });
    expect(out.ok && out.clarification.choices.map((c) => c.value)).toEqual([
      { comparison: "previous_period" },
      { comparison: "year_ago" },
    ]);
  });

  it("builds goal choices from the record, never from the model", () => {
    const goals = [
      {
        id: "plan-1",
        labelKey: "insights.coach.metric.weight",
        label: "Weight",
      },
      { id: "plan-2", labelKey: "insights.coach.metric.sleep", label: "Sleep" },
    ];
    const out = buildClarificationFromTool({
      call: {
        kind: "goal",
        question: "Which goal do you mean?",
        choices: ["lose ten kilos", "sleep more"],
      },
      inventory: null,
      locale: "en",
      goals,
    });
    expect(
      out.ok && out.clarification.choices.map((c) => c.value.goal),
    ).toEqual(["plan-1", "plan-2"]);
    expect(JSON.stringify(out)).not.toContain("ten kilos");
  });

  it("drops a goal or anchor question without two record choices", () => {
    expect(
      buildClarificationFromTool({
        call: { kind: "anchor", question: "Since when?" },
        inventory: null,
        locale: "en",
        anchors: [{ id: "e1", labelKey: "k", label: "Since 3 Mar" }],
      }),
    ).toEqual({ ok: false, reason: "no_record_choices" });
  });

  it("drops a question that is not one, is too long, or carries a dose", () => {
    const base = { kind: "context" as const, choices: [] };
    expect(
      buildClarificationFromTool({
        call: { ...base, question: "Tell me more." },
        inventory: null,
        locale: "en",
      }).ok,
    ).toBe(false);
    expect(
      buildClarificationFromTool({
        call: { ...base, question: `${"x".repeat(210)}?` },
        inventory: null,
        locale: "en",
      }).ok,
    ).toBe(false);
    expect(
      buildClarificationFromTool({
        call: {
          ...base,
          question: "You should take 500 mg of metformin twice a day, right?",
        },
        inventory: null,
        locale: "en",
      }).ok,
    ).toBe(false);
  });

  it("turns a declined question into an assumption with its alternatives", () => {
    const out = buildClarificationFromTool({
      call: {
        kind: "window",
        question: "Which stretch? Otherwise the last 30 days.",
        choices: ["last30days", "last90days", "lastYear"],
        assumption: "last30days",
      },
      inventory: null,
      locale: "en",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const assumption = assumptionFromClarification(out.clarification);
    expect(assumption?.kind).toBe("window");
    expect(assumption?.value.value).toEqual({ window: "last30days" });
    expect(assumption?.alternatives.map((a) => a.value.window)).toEqual([
      "last90days",
      "lastYear",
    ]);
  });
});

describe("clarificationAllowed", () => {
  const stored = (clarification: boolean) => ({
    providerType: "codex",
    metricSourceJson: JSON.stringify({
      windows: [],
      metrics: [],
      ...(clarification
        ? { clarification: { kind: "context", choices: [], freeText: true } }
        : {}),
    }),
  });

  it("allows a first question", async () => {
    db.messageFindMany.mockResolvedValue([stored(false), stored(false)]);
    await expect(
      clarificationAllowed({ userId: "u1", conversationId: "c1" }),
    ).resolves.toBe(true);
    expect(db.messageFindMany.mock.calls[0][0]).toMatchObject({
      where: { conversationId: "c1", conversation: { userId: "u1" } },
      take: 5,
    });
  });

  it("refuses a question within six turns of the last one", async () => {
    db.messageFindMany.mockResolvedValue([
      stored(false),
      stored(false),
      stored(true),
    ]);
    await expect(
      clarificationAllowed({ userId: "u1", conversationId: "c1" }),
    ).resolves.toBe(false);
  });

  it("refuses the fourth question of a day", async () => {
    db.messageCount.mockResolvedValue(CLARIFY_DAILY_LIMIT);
    await expect(
      clarificationAllowed({ userId: "u1", conversationId: "c1" }),
    ).resolves.toBe(false);
  });

  it("refuses when the count cannot be read", async () => {
    db.messageFindMany.mockRejectedValue(new Error("down"));
    await expect(
      clarificationAllowed({ userId: "u1", conversationId: "c1" }),
    ).resolves.toBe(false);
  });
});

describe("loadClarifyRecordChoices", () => {
  it("lists active plans by their metric's catalog label, one per metric", async () => {
    db.planFindMany.mockResolvedValue([
      { id: "p1", metric: "WEIGHT" },
      { id: "p2", metric: "weight" },
      { id: "p3", metric: "BLOOD_PRESSURE" },
      { id: "p4", metric: "MOOD_SWINGS" },
    ]);
    const out = await loadClarifyRecordChoices({
      userId: "u1",
      kind: "goal",
      locale: "en",
    });
    expect(out.map((c) => [c.id, c.labelKey])).toEqual([
      ["p1", "insights.coach.metric.weight"],
      ["p3", "insights.coach.metric.bp"],
    ]);
  });

  it("offers no illness anchor while the illness module is off", async () => {
    db.isModuleEnabled.mockResolvedValue(false);
    const out = await loadClarifyRecordChoices({
      userId: "u1",
      kind: "anchor",
      locale: "en",
    });
    expect(out).toEqual([]);
    expect(db.illnessFindMany).not.toHaveBeenCalled();
  });
});

describe("resolveClarificationAnswer for the v1.41 kinds", () => {
  it("names a goal answer by its label, never by the id alone", async () => {
    const latest = async () => [
      {
        id: "m1",
        role: "assistant",
        providerType: "codex",
        metricSourceJson: JSON.stringify({
          windows: [],
          metrics: [],
          clarification: {
            kind: "goal",
            choices: [
              {
                id: "c1",
                labelKey: "insights.coach.metric.weight",
                label: "Weight",
                value: { goal: "plan-1" },
              },
            ],
            freeText: true,
          },
        }),
      },
    ];
    const line = await resolveClarificationAnswer({
      userId: "u1",
      conversationId: "c1",
      clarification: { messageId: "m1", choiceId: "c1" },
      latest,
    });
    expect(line).toContain('"Weight"');
  });
});

describe("runDialogTool", () => {
  const ctx: DialogToolContext = {
    userId: "u1",
    conversationId: "c1",
    locale: "en",
    userMessage: "how is my pulse?",
    inventory: PULSES,
    conversationWindowSet: false,
  };
  const ask = (args: Record<string, unknown>, round = 1, over = {}) =>
    runDialogTool({
      name: "ask_clarification",
      rawArguments: JSON.stringify(args),
      round,
      ctx: { ...ctx, ...over },
      noted: false,
      proposed: false,
    });
  const WHICH = {
    kind: "metric",
    question: "Resting or walking pulse? Otherwise resting.",
    choices: ["resting_hr", "walking_hr"],
    assumption: "resting_hr",
  };

  it("asks in rounds one and two", async () => {
    expect((await ask(WHICH, 2)).kind).toBe("ask");
  });

  it("declines after round two and says what to assume", async () => {
    const out = await ask(WHICH, 3);
    expect(out).toEqual({
      kind: "none",
      result: { declined: "late", assume: "resting_hr" },
    });
  });

  it("never asks about the window when the conversation set one", async () => {
    const out = await ask(
      {
        kind: "window",
        question: "Which stretch?",
        choices: ["last7days", "last30days"],
      },
      1,
      { conversationWindowSet: true },
    );
    expect(out.result).toMatchObject({ declined: "window_set" });
  });

  it("turns a question the brake refuses into an assumption", async () => {
    db.messageCount.mockResolvedValue(CLARIFY_DAILY_LIMIT);
    const out = await ask(WHICH);
    expect(out.kind).toBe("declined");
    expect(out.result).toEqual({
      declined: "rate",
      assume: "Resting HR",
    });
  });

  it("refuses arguments outside the schema", async () => {
    const out = await ask({ ...WHICH, kind: "dose" });
    expect(out.result).toEqual({ present: false, reason: "invalid_arguments" });
  });

  it("remembers at most one fact per answer", async () => {
    const out = await runDialogTool({
      name: "remember_fact",
      rawArguments: JSON.stringify({
        category: "goal",
        fact: "Wants to reach 75 kg by December",
        why: "goal",
      }),
      round: 1,
      ctx,
      noted: true,
      proposed: false,
    });
    expect(out.result).toEqual({ declined: "one_per_answer" });
    expect(db.rememberFactFromTool).not.toHaveBeenCalled();
  });

  it("passes the person's own message to the memory contract", async () => {
    db.rememberFactFromTool.mockResolvedValue({
      kind: "proposed",
      note: {
        proposal: true,
        proposalId: "p1",
        category: "medication",
        fact: "Takes a weekly injection",
      },
    });
    const out = await runDialogTool({
      name: "remember_fact",
      rawArguments: JSON.stringify({
        category: "medication",
        fact: "Takes a weekly injection",
        why: "context for weight",
      }),
      round: 1,
      ctx,
      noted: false,
      proposed: false,
    });
    expect(db.rememberFactFromTool).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: "how is my pulse?" }),
    );
    expect(out).toMatchObject({
      kind: "memory",
      result: { proposed: true, category: "medication" },
    });
  });

  it("proposes at most one plan per answer and reports a declined one", async () => {
    db.proposePlanFromTool.mockResolvedValue({
      kind: "declined",
      reason: "too_many_open",
    });
    const call = JSON.stringify({
      metric: "WEIGHT",
      ifCue: "after dinner",
      thenAction: "walk 15 minutes",
      reviewInDays: 14,
    });
    const out = await runDialogTool({
      name: "propose_plan",
      rawArguments: call,
      round: 1,
      ctx,
      noted: false,
      proposed: false,
    });
    expect(out.result).toEqual({ declined: "too_many_open" });
    const again = await runDialogTool({
      name: "propose_plan",
      rawArguments: call,
      round: 1,
      ctx,
      noted: false,
      proposed: true,
    });
    expect(again.result).toEqual({ declined: "one_per_answer" });
  });
});
