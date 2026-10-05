/**
 * `POST /api/insights/chat` with a tapped chip or an answered question,
 * through the real route and turn pipeline (the dialog harness replaces
 * only the edges: auth, database, provider, data reads, persistence).
 *
 * The contract at the front door:
 *
 *   - `followUp` and `clarification` are validated like the rest of the
 *     body; a malformed one is a 422 before anything runs.
 *   - A reuse chip is answered without a provider call or a budget
 *     reservation, but never without the capability gate and the rate
 *     limit.
 *   - What a chip asks for is read from the stored reply. The request
 *     names a chip; anything else it says about it is ignored.
 *   - A chip or a question that is no longer on the latest reply degrades
 *     to a plain message.
 *   - An answered question reaches the model as one server-written line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = await vi.hoisted(() => import("./dialog-harness"));

vi.mock("@/lib/api-handler", () => h.modules.apiHandler());
vi.mock("@/lib/api-response", () => h.modules.apiResponse());
vi.mock("@/lib/modules/gate", () => h.modules.gate());
vi.mock("@/lib/ai/capabilities/gate", () => h.modules.capabilities());
vi.mock("@/lib/logging/context", () => h.modules.logging());
vi.mock("@/lib/auth/audit", () => h.modules.audit());
vi.mock("@/lib/db", () => h.modules.db());
vi.mock("@/lib/rate-limit", () => h.modules.rateLimit());
vi.mock("@/lib/i18n/server-locale", () => h.modules.serverLocale());
vi.mock("@/lib/ai/provider-runner", () => h.modules.providerRunner());
vi.mock("@/lib/ai/provider", () => h.modules.provider());
vi.mock("@/lib/ai/consent-guard", () => h.modules.consent());
vi.mock("@/lib/ai/coach/persistence", () => h.modules.persistence());
vi.mock("@/lib/ai/coach/coach-memory-shared", () => h.modules.memory());
vi.mock("@/lib/ai/coach/facts", () => h.modules.facts());
vi.mock("@/lib/ai/coach/budget", () => h.modules.budget());
vi.mock("@/lib/ai/coach/about-me", () => h.modules.aboutMe());
vi.mock("@/lib/ai/coach/snapshot", () => h.modules.snapshot());
vi.mock("@/lib/medications/scheduled-doses", () => h.modules.scheduledDoses());
vi.mock("@/lib/ai/coach/workout-evidence-builder", () =>
  h.modules.workoutEvidence(),
);
vi.mock("@/lib/ai/coach/suggest-gate", () => h.modules.suggestGate());
vi.mock("@/lib/monitoring-settings", () => h.modules.glitchtipSettings());
vi.mock("@/lib/monitoring/glitchtip", () => h.modules.glitchtip());
vi.mock("@/lib/tz/resolver", () => h.modules.timezone());
vi.mock("@/lib/measurements/daily-series-read", () => h.modules.dailySeries());
vi.mock("@/lib/rollups/measurement-read", () => h.modules.sourcePriority());
vi.mock("@/lib/ai/coach/bytes-codec", () => h.modules.bytesCodec());
vi.mock("@/lib/ai/coach/tools/inventory", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCoachDataInventory: h.modules.buildInventory,
}));

import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";
import type {
  CoachClarification,
  CoachFollowUp,
  CoachResultMeta,
  CoachResultTable,
} from "@/lib/ai/coach/types";

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;
const { world, providerCalls, framesOf, m } = h;

const BP_META: CoachResultMeta = {
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
  rowCount: 5,
  chartKind: "line",
  displayed: true,
};

function chip(
  id: string,
  kind: CoachFollowUp["kind"],
  reuse = false,
): CoachFollowUp {
  return {
    id,
    kind,
    labelKey: `coach.followUp.${kind}`,
    label: kind,
    anchor: {
      ref: "r1",
      domain: "bp",
      window: "last30days",
      granularity: "week",
      period: "current",
    },
    reuse,
    origin: "server",
  };
}

const QUESTION: CoachClarification = {
  kind: "metric",
  freeText: true,
  choices: [
    {
      id: "c1",
      labelKey: "coach.domain.pulse",
      label: "Pulse",
      value: { metric: "pulse" },
    },
    {
      id: "c2",
      labelKey: "coach.domain.resting_hr",
      label: "Resting heart rate",
      value: { metric: "resting_hr" },
    },
  ],
};

/** A conversation whose last reply holds the bp table and three chips. */
function conversationWithChips(): void {
  world.inventory = [
    {
      tool: "get_metric_series",
      metric: "bp",
      domain: "blood pressure",
      present: true,
      count: 58,
    },
  ];
  world.priorTurns = [
    { role: "user", content: "How was my blood pressure last month?" },
    { role: "assistant", content: "It averaged 124/81 mmHg." },
  ];
  world.storedTables = [h.storedTable(BP_META)];
  world.storedFollowUps = [
    chip("f1", "as_table", true),
    chip("f2", "previous_period"),
    chip("f3", "as_chart", true),
  ];
}

function tap(id: string, over: Record<string, unknown> = {}) {
  return h.postTurn(post, {
    conversationId: h.CONVERSATION_ID,
    message: "Chip",
    followUp: { messageId: h.LAST_ASSISTANT_ID, id, ...over },
  });
}

function annotated(name: string) {
  return m.annotate.mock.calls
    .map(([arg]) => arg as { action: { name: string }; meta?: unknown })
    .filter((a) => a.action.name === name);
}

beforeEach(() => {
  vi.setSystemTime(h.NOW);
  h.resetDialog();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("validation", () => {
  it.each([
    ["a chip without an id", { followUp: { messageId: "m-a1" } }],
    [
      "a chip id past its cap",
      { followUp: { messageId: "m-a1", id: "f".repeat(9) } },
    ],
    ["a question without its message", { clarification: { choiceId: "c1" } }],
    [
      "a choice id past its cap",
      { clarification: { messageId: "m-a1", choiceId: "c".repeat(9) } },
    ],
  ])("refuses %s with a 422 before anything runs", async (_name, extra) => {
    const run = await h.postTurn(post, { message: "Hi", ...extra });
    expect(run.status).toBe(422);
    expect(JSON.parse(run.body).error).toBe("coach.request.invalid");
    expect(m.appendMessage).not.toHaveBeenCalled();
    expect(providerCalls).toHaveLength(0);
  });
});

describe("a reuse chip", () => {
  it("answers 'as a table' from the stored table, with no provider and no budget", async () => {
    conversationWithChips();
    const run = await tap("f1");
    expect(run.status).toBe(200);
    expect(providerCalls).toHaveLength(0);
    expect(m.reserveBudget).not.toHaveBeenCalled();
    expect(m.readDailySeries).not.toHaveBeenCalled();

    const [result] = framesOf<{ result: CoachResultTable }>(
      run.frames,
      "result",
    ).map((f) => f.result);
    expect(result.rows).toEqual(world.storedTables[0].rows);
    // The table shows first; the chart stays, so the chart is offered back.
    expect(result.view).toBe("table");
    expect(result.chart).toEqual(world.storedTables[0].chart);
    expect(result.reusedFrom).toEqual({
      messageId: h.LAST_ASSISTANT_ID,
      ref: "r1",
    });
    // The result renders with its own chart/table toggle, so no chip
    // offers the chart again.
    expect(
      framesOf<{ followUps: CoachFollowUp[] }>(run.frames, "followUps"),
    ).toEqual([]);
    expect(m.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", providerType: "reuse" }),
    );
  });

  it("answers 'as a chart' with the stored chart and leaves the table to its toggle", async () => {
    conversationWithChips();
    const run = await tap("f3");
    expect(providerCalls).toHaveLength(0);
    const [result] = framesOf<{ result: CoachResultTable }>(
      run.frames,
      "result",
    ).map((f) => f.result);
    expect(result.chart).toEqual(world.storedTables[0].chart);
    expect(
      framesOf<{ followUps: CoachFollowUp[] }>(run.frames, "followUps"),
    ).toEqual([]);
  });

  it("still passes the rate limit", async () => {
    conversationWithChips();
    m.checkRateLimit.mockResolvedValue({ allowed: false, resetAt: 1 });
    const run = await tap("f1");
    expect(run.status).toBe(429);
    expect(m.appendMessage).not.toHaveBeenCalled();
  });

  it("still passes the capability gate (a delegate is refused)", async () => {
    conversationWithChips();
    m.requireAiCapability.mockRejectedValue(
      new AiUnavailableError("coach", "not_permitted_for_record"),
    );
    await expect(tap("f1")).rejects.toBeInstanceOf(AiUnavailableError);
    expect(m.appendMessage).not.toHaveBeenCalled();
  });

  it("goes to the model with the chip's line when the stored table cannot be served", async () => {
    conversationWithChips();
    world.resultsWithheld = true;
    world.script = [
      {
        calls: [{ name: "show_result", args: { ref: "m1.r1", view: "chart" } }],
      },
      { text: "Here it is. result:r1" },
    ];
    const run = await tap("f3");
    expect(run.status).toBe(200);
    expect(annotated("coach.followUp.reuse_unavailable")).toHaveLength(1);
    expect(providerCalls[0].system).toContain(
      "Call show_result with ref m1.r1 and view chart",
    );
  });
});

describe("a model chip", () => {
  it("carries what the stored chip asks for, whatever the request adds", async () => {
    conversationWithChips();
    world.script = [
      { text: "Compared with the month before, it is unchanged." },
    ];
    const run = await tap("f2", {
      kind: "widen_window",
      anchor: { domain: "glucose", window: "allTime" },
    });
    expect(run.status).toBe(200);
    const system = providerCalls[0].system;
    expect(system).toContain(
      "FOLLOW-UP: the person tapped the previous_period chip",
    );
    expect(system).toContain(
      "get_metric_table metric=bp window=last30days period=previous granularity=week",
    );
    expect(system).toContain("m1.r1");
    expect(system).not.toContain("glucose window=allTime");
  });

  it("degrades a chip that is not on the latest reply to a plain message", async () => {
    conversationWithChips();
    world.script = [{ text: "Here is what I see." }];
    const run = await h.postTurn(post, {
      conversationId: h.CONVERSATION_ID,
      message: "Chip",
      followUp: { messageId: "m-older", id: "f2" },
    });
    expect(run.status).toBe(200);
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0].system).not.toContain("FOLLOW-UP:");
    expect(annotated("coach.followUp.stale")).toEqual([
      expect.objectContaining({ meta: { reason: "not_latest" } }),
    ]);
  });

  it("degrades an id the reply never offered", async () => {
    conversationWithChips();
    world.script = [{ text: "Here is what I see." }];
    await tap("f9");
    expect(providerCalls[0].system).not.toContain("FOLLOW-UP:");
    expect(annotated("coach.followUp.stale")).toEqual([
      expect.objectContaining({ meta: { reason: "unknown_chip" } }),
    ]);
  });

  it("continues a forced reply, pointing at the question it left unfinished", async () => {
    conversationWithChips();
    world.storedFollowUps = [{ ...chip("f1", "continue"), anchor: undefined }];
    world.storedProvenance = {
      forcedFinal: true,
      steps: [
        {
          id: "s1",
          tool: "get_metric_table",
          labelKey: "coach.step.readWindow",
          label: "Reading",
          domain: "bp",
          window: "last30days",
          granularity: "week",
          status: "done",
          count: 20,
          resultRef: "r1",
        },
      ],
    };
    world.script = [
      { text: "Having looked further, the readings stay level." },
    ];
    await tap("f1");
    const system = providerCalls[0].system;
    expect(system).toContain(
      "CONTINUE: the person asked you to keep looking. The unfinished question is their message before that request, in CONVERSATION.",
    );
    // The question stays the person's own turn; it never reaches the
    // system role.
    expect(system).not.toContain("How was my blood pressure last month?");
    expect(system).toContain(
      "Already fetched: get_metric_table(bp, last30days, week) → m1.r1",
    );
  });
});

describe("an answered question", () => {
  function conversationWithQuestion(): void {
    conversationWithChips();
    world.storedFollowUps = [];
    world.storedTables = [];
    world.storedProvenance = { clarification: QUESTION };
    world.script = [{ text: "Your resting heart rate held steady." }];
  }

  it("reaches the model as the stored choice's value", async () => {
    conversationWithQuestion();
    const run = await h.postTurn(post, {
      conversationId: h.CONVERSATION_ID,
      message: "Resting heart rate",
      clarification: { messageId: h.LAST_ASSISTANT_ID, choiceId: "c2" },
    });
    expect(run.status).toBe(200);
    expect(providerCalls[0].system).toContain(
      "CLARIFIED: the person answered your clarifying question by choosing metric=resting_hr.",
    );
  });

  it("reads a typed answer as the person's own words", async () => {
    conversationWithQuestion();
    await h.postTurn(post, {
      conversationId: h.CONVERSATION_ID,
      message: "The one from my watch",
      clarification: { messageId: h.LAST_ASSISTANT_ID },
    });
    expect(providerCalls[0].system).toContain(
      "CLARIFIED: the person answered your clarifying question in their own words",
    );
  });

  it("drops an answer to a question that is not the latest reply", async () => {
    conversationWithQuestion();
    await h.postTurn(post, {
      conversationId: h.CONVERSATION_ID,
      message: "Resting heart rate",
      clarification: { messageId: "m-older", choiceId: "c2" },
    });
    expect(providerCalls[0].system).not.toContain("CLARIFIED:");
    expect(annotated("coach.clarification.stale")).toHaveLength(1);
  });

  it("never asks twice in a row", async () => {
    conversationWithQuestion();
    world.script = [
      {
        text: "Which one do you mean?\n---CLARIFY---\nkind: metric\nchoices: pulse, bp\n---END---",
      },
    ];
    world.inventory.push({
      tool: "get_metric_series",
      metric: "pulse",
      domain: "pulse",
      present: true,
      count: 40,
    });
    const run = await h.postTurn(post, {
      conversationId: h.CONVERSATION_ID,
      message: "Resting heart rate",
      clarification: { messageId: h.LAST_ASSISTANT_ID, choiceId: "c2" },
    });
    expect(framesOf(run.frames, "clarification")).toEqual([]);
    expect(annotated("coach.clarification.dropped")).toEqual([
      expect.objectContaining({ meta: { reason: "repeat", kind: "metric" } }),
    ]);
  });
});
