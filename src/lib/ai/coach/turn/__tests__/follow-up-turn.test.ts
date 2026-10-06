/**
 * v1.39.4 — a tapped follow-up chip through the turn pipeline.
 *
 *  - A reuse chip ("as a chart", "as a table") is answered from the stored
 *    table: no budget reservation, no model, one assistant message tagged
 *    `reuse`, and a `result` frame whose rows are the stored rows.
 *  - A chip that is no longer current degrades to a plain message.
 *  - Any other chip runs the model with a server-written context line.
 *  - With the pref off the model turn carries no `followUps` frame.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  userFindUnique: vi.fn(),
  annotate: vi.fn(),
  readMessageResults: vi.fn(),
  appendMessage: vi.fn(),
  resolveTurnConversation: vi.fn(),
  persistUserTurn: vi.fn(),
  assembleTurnContext: vi.fn(),
  resolveTurnChain: vi.fn(),
  reserveTurnBudget: vi.fn(),
  runTurnModel: vi.fn(),
  guardReply: vi.fn(),
  surfaceCards: vi.fn(),
  persistAssistantReply: vi.fn(),
  resolveModuleMap: vi.fn(),
  readFollowUpHistory: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachMessage: { findMany: m.findMany },
    user: { findUnique: m.userFindUnique },
  },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: m.annotate }));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: m.resolveModuleMap,
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: m.appendMessage,
  createConversation: vi.fn(),
  readMessageResults: m.readMessageResults,
}));
vi.mock("../conversation", () => ({
  resolveTurnConversation: m.resolveTurnConversation,
  persistUserTurn: m.persistUserTurn,
}));
vi.mock("../context", () => ({ assembleTurnContext: m.assembleTurnContext }));
vi.mock("../chain", () => ({ resolveTurnChain: m.resolveTurnChain }));
vi.mock("../budget", () => ({
  reserveTurnBudget: m.reserveTurnBudget,
}));
vi.mock("../model", () => ({ runTurnModel: m.runTurnModel }));
// The record reaches back years, so the history chips have something to
// offer; the chip rules themselves are pinned in derive.test.ts.
vi.mock("@/lib/ai/coach/follow-ups/derive", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readFollowUpHistory: m.readFollowUpHistory,
}));
vi.mock("../reply-guards", () => ({ guardReply: m.guardReply }));
vi.mock("../cards", () => ({ surfaceCards: m.surfaceCards }));
vi.mock("../persist", () => ({
  persistAssistantReply: m.persistAssistantReply,
}));

import type {
  CoachFollowUp,
  CoachResultTable,
  CoachStreamEvent,
} from "@/lib/ai/coach/types";
import { DEFAULT_COACH_PREFS } from "@/lib/validations/coach-prefs";

import { runCoachTurn } from "../pipeline";
import { STUB_PROMPT_CONTEXT, modelExtras, stubLedger } from "./turn-test-kit";
import type { TurnInput } from "../types";

const STORED: CoachResultTable = {
  ref: "r1",
  source: {
    tool: "get_metric_table",
    domain: "bp",
    window: "last30days",
    period: "current",
    granularity: "week",
  },
  shape: "timeSeries",
  titleKey: "coach.result.title.byWeek",
  title: "Blood pressure by week",
  rowCount: 3,
  chartKind: "line",
  displayed: false,
  columns: [
    { key: "week", kind: "period", labelKey: "k", label: "Week" },
    { key: "sys", kind: "number", labelKey: "k", label: "Systolic" },
  ],
  rows: [
    ["2026-W36", 128],
    ["2026-W37", null],
    ["2026-W38", 131],
  ],
  truncated: false,
  chart: { kind: "line", x: "week", series: ["sys"] },
};

const AS_CHART: CoachFollowUp = {
  id: "f1",
  kind: "as_chart",
  labelKey: "coach.followUp.asChart",
  label: "Show as a chart",
  anchor: {
    ref: "r1",
    domain: "bp",
    window: "last30days",
    granularity: "week",
    period: "current",
  },
  reuse: true,
  origin: "server",
};
const PREVIOUS: CoachFollowUp = {
  ...AS_CHART,
  id: "f2",
  kind: "previous_period",
  labelKey: "coach.followUp.previousPeriod",
  label: "Compare with the period before",
  reuse: false,
};

function latestReply(followUps: CoachFollowUp[]) {
  return [
    {
      id: "m-last",
      role: "assistant",
      providerType: "openai",
      metricSourceJson: JSON.stringify({
        windows: [],
        metrics: [],
        followUps,
        results: [{ ...STORED, rows: undefined, columns: undefined }],
      }),
    },
  ];
}

function input(over: Partial<TurnInput> = {}): TurnInput {
  return {
    userId: "u1",
    locale: "en",
    signal: new AbortController().signal,
    conversationId: "c1",
    message: "Show as a chart",
    scope: undefined,
    guidedQuestion: undefined,
    workoutId: undefined,
    followUp: { messageId: "m-last", id: "f1" },
    clarification: undefined,
    reasoningLevel: "medium",
    recheckCapability: async () => null,
    ...over,
  };
}

async function frames(res: Response): Promise<CoachStreamEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as CoachStreamEvent);
}

function annotated(name: string) {
  return m.annotate.mock.calls.filter(
    ([arg]) => (arg as { action: { name: string } }).action.name === name,
  );
}

/** The model path, enough of it to reach the frames. */
function modelPath(prefs = DEFAULT_COACH_PREFS) {
  m.assembleTurnContext.mockResolvedValue({
    ...STUB_PROMPT_CONTEXT,
    coachPrefs: prefs,
    snapshot: { provenance: { windows: [], metrics: [] } },
  });
  m.resolveTurnChain.mockResolvedValue({ ok: true, chain: [], toolMode: true });
  m.reserveTurnBudget.mockResolvedValue({ ok: true, ledger: stubLedger() });
  const table = { ...STORED, chart: null, chartKind: null, displayed: true };
  m.runTurnModel.mockResolvedValue({
    ...modelExtras(),
    ok: true,
    result: { content: "x", model: "gpt" },
    workingProviderType: "openai",
    toolTrace: [],
    totalTokens: 12,
    cachedTokens: 0,
    steps: [
      {
        id: "s1",
        tool: "get_metric_table",
        labelKey: "coach.step.readWindow",
        label: "x",
        domain: "bp",
        window: "last30days",
        status: "done",
        count: 20,
        resultRef: "r1",
      },
    ],
    results: [table],
    forcedFinal: false,
    inventory: [
      { tool: "get_metric_series", metric: "bp", domain: "bp", present: true },
    ],
    correlations: [],
  });
  m.guardReply.mockResolvedValue({
    ok: true,
    reply: {
      replyText: "Steady.",
      outboundBlocked: false,
      referencedResults: ["r1"],
      followUpProposals: [],
      clarification: null,
      keyValuesSentinel: {
        keyValues: [],
        malformed: false,
        malformedEntries: [],
      },
      groundedFigures: [],
      unverifiedStripped: 0,
    },
  });
  m.surfaceCards.mockResolvedValue({ suggestion: null, action: null });
  m.persistAssistantReply.mockResolvedValue({ messageId: "m-new" });
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.readFollowUpHistory.mockResolvedValue({
    today: "2026-09-27",
    firstDate: { bp: "2024-01-01" },
  });
  m.resolveTurnConversation.mockResolvedValue({
    conversation: {
      conversationId: "c1",
      priorTurns: [],
      priorUserMessages: [],
      priorToolFigures: [],
      priorSummary: null,
      priorResults: [{ messageId: "m-last", turnIndex: 2, results: [STORED] }],
    },
  });
  m.resolveModuleMap.mockResolvedValue({});
  m.userFindUnique.mockResolvedValue({ coachPrefsJson: null });
  m.appendMessage.mockImplementation(async (params: { role: string }) => ({
    id: params.role === "assistant" ? "m-reuse" : "m-user",
  }));
});

describe("a reuse chip", () => {
  it("answers from the stored table with no budget and no model", async () => {
    m.findMany.mockResolvedValue(latestReply([AS_CHART]));
    m.readMessageResults.mockResolvedValue([STORED]);

    const res = await runCoachTurn(input());
    const out = await frames(res);

    expect(m.reserveTurnBudget).not.toHaveBeenCalled();
    expect(m.runTurnModel).not.toHaveBeenCalled();
    expect(m.resolveTurnChain).not.toHaveBeenCalled();
    expect(m.readMessageResults).toHaveBeenCalledWith(
      "u1",
      "c1",
      "m-last",
      expect.any(Function),
    );
    // The person's message, then exactly one assistant message.
    expect(m.persistUserTurn).toHaveBeenCalledWith("c1", "Show as a chart");
    expect(m.appendMessage).toHaveBeenCalledTimes(1);
    const persisted = m.appendMessage.mock.calls[0][0];
    expect(persisted).toMatchObject({
      role: "assistant",
      providerType: "reuse",
      content: "Here are the same figures from my last answer, unchanged.",
    });
    expect(persisted.results[0].rows).toEqual(STORED.rows);
    expect(persisted.tokensUsed).toBeUndefined();

    // Consecutive token frames collapsed: the caption streams word by word.
    const order = out
      .map((f) => f.type)
      .filter((type, i, all) => type !== "token" || all[i - 1] !== "token");
    expect(order).toEqual(["step", "token", "provenance", "result", "done"]);
    expect(
      out.flatMap((f) => (f.type === "token" ? [f.token] : [])).join(""),
    ).toBe("Here are the same figures from my last answer, unchanged.");
    const result = out.find((f) => f.type === "result");
    expect(result?.type === "result" && result.result).toMatchObject({
      ref: "r1",
      rows: STORED.rows,
      columns: STORED.columns,
      displayed: true,
      chart: STORED.chart,
      reusedFrom: { messageId: "m-last", ref: "r1" },
    });
    // The table is shown with its chart, and the panel carries its own
    // chart/table toggle, so no chip offers the other view again.
    expect(out.some((f) => f.type === "followUps")).toBe(false);
    const done = out.at(-1);
    expect(done).toMatchObject({
      type: "done",
      conversationId: "c1",
      messageId: "m-reuse",
    });
    // The provenance carries the table's metadata, never its values.
    const provenance = out.find((f) => f.type === "provenance");
    expect(JSON.stringify(provenance)).not.toContain("131");
    expect(annotated("coach.followUp.reused")).toHaveLength(1);
  });

  it("shows the table first on 'as a table', leaving the chart to the panel's toggle", async () => {
    const asTable = { ...AS_CHART, kind: "as_table" as const };
    m.findMany.mockResolvedValue(latestReply([asTable]));
    m.readMessageResults.mockResolvedValue([STORED]);
    const out = await frames(await runCoachTurn(input()));
    const result = out.find((f) => f.type === "result");
    expect(result?.type === "result" && result.result).toMatchObject({
      view: "table",
      chart: STORED.chart,
      rows: STORED.rows,
    });
    // The chart stays on the result, one tap away on its toggle; a chip
    // for it would repeat that toggle.
    expect(out.some((f) => f.type === "followUps")).toBe(false);
  });

  it("goes to the model with the chip's hint when the table is withheld", async () => {
    m.findMany.mockResolvedValue(latestReply([AS_CHART]));
    m.readMessageResults.mockResolvedValue([
      { ref: "r1", withheld: "module_disabled" },
    ]);
    modelPath();
    await frames(await runCoachTurn(input()));
    expect(annotated("coach.followUp.reuse_unavailable")).toHaveLength(1);
    expect(m.appendMessage).not.toHaveBeenCalled();
    expect(m.reserveTurnBudget).toHaveBeenCalledTimes(1);
    const { turnHints } = m.runTurnModel.mock.calls[0][0];
    expect(turnHints).toEqual([
      expect.stringContaining("show_result with ref m2.r1 and view chart"),
    ]);
  });
});

describe("a stale chip", () => {
  it("degrades to a plain message", async () => {
    m.findMany.mockResolvedValue([
      {
        id: "m-newer",
        role: "assistant",
        providerType: "openai",
        metricSourceJson: null,
      },
      ...latestReply([AS_CHART]),
    ]);
    modelPath();
    await frames(await runCoachTurn(input()));
    expect(annotated("coach.followUp.stale")).toHaveLength(1);
    expect(m.readMessageResults).not.toHaveBeenCalled();
    expect(m.persistUserTurn).toHaveBeenCalledWith("c1", "Show as a chart");
    expect(m.runTurnModel.mock.calls[0][0].turnHints).toEqual([]);
  });
});

describe("a chip answered by the model", () => {
  it("carries a server-written context line", async () => {
    m.findMany.mockResolvedValue(latestReply([PREVIOUS]));
    modelPath();
    await frames(
      await runCoachTurn(
        input({
          message: "Compare with the period before",
          followUp: { messageId: "m-last", id: "f2" },
        }),
      ),
    );
    expect(m.readMessageResults).not.toHaveBeenCalled();
    expect(m.runTurnModel.mock.calls[0][0].turnHints).toEqual([
      "FOLLOW-UP: the person tapped the previous_period chip under your last answer. Fetch get_metric_table metric=bp window=last30days period=previous granularity=week and compare it with the current period. The table from your last answer is m2.r1: use show_result for it, do not fetch it again.",
    ]);
  });
});

describe("the follow-up pref", () => {
  it("offers chips on a model turn by default", async () => {
    modelPath();
    const out = await frames(
      await runCoachTurn(input({ followUp: undefined })),
    );
    expect(out.some((f) => f.type === "followUps")).toBe(true);
  });

  it("sends no followUps frame when switched off", async () => {
    modelPath({ ...DEFAULT_COACH_PREFS, followUpChips: false });
    const out = await frames(
      await runCoachTurn(input({ followUp: undefined })),
    );
    expect(out.map((f) => f.type)).not.toContain("followUps");
    expect(out.at(-1)?.type).toBe("done");
  });

  it("sends no followUps frame on a reuse turn when switched off", async () => {
    m.userFindUnique.mockResolvedValue({
      coachPrefsJson: { followUpChips: false },
    });
    m.findMany.mockResolvedValue(latestReply([AS_CHART]));
    m.readMessageResults.mockResolvedValue([STORED]);
    const out = await frames(await runCoachTurn(input()));
    expect(out.map((f) => f.type)).not.toContain("followUps");
    expect(out.some((f) => f.type === "result")).toBe(true);
  });
});
