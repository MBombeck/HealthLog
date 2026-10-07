/**
 * v1.41 — the live trail and the dialog of a turn through the real route,
 * pipeline and loop, with a scripted provider:
 *
 *  - frame order: the trail and the steps first (thinking before the
 *    provider is called, each fetch, the digest), interim tables as soon as
 *    they are read, the answer entry before the first token, then the reply
 *    frames as before;
 *  - the stored trail carries the model text, the provenance only the
 *    structure;
 *  - a question asked through the tool ends the turn with its choices;
 *  - a person may run two turns at once, not three;
 *  - a tapped decision is answered without a model, and a stale one goes to
 *    the model as an ordinary message.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = await vi.hoisted(
  () => import("@/app/api/insights/chat/__tests__/dialog-harness"),
);
const contract = vi.hoisted(() => ({
  decideFactProposal: vi.fn(),
  decidePlanProposal: vi.fn(),
}));

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
vi.mock("@/lib/ai/coach/memory/contract", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decideFactProposal: contract.decideFactProposal,
  decidePlanProposal: contract.decidePlanProposal,
}));

import type { CoachActivity, CoachProvenance } from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import { POST } from "@/app/api/insights/chat/route";

const post = POST as unknown as (req: Request) => Promise<Response>;
const { world, providerCalls, framesOf, m } = h;

const series = (metric: string, count: number): InventoryEntry => ({
  tool: "get_metric_series",
  metric,
  domain: metric,
  present: true,
  count,
});

beforeEach(() => {
  vi.setSystemTime(h.NOW);
  h.resetDialog();
  contract.decideFactProposal.mockReset();
  contract.decidePlanProposal.mockReset();
  world.inventory = [
    series("bp", 58),
    series("pulse", 61),
    series("resting_hr", 240),
    series("walking_hr", 212),
  ];
});

function rank(frame: { type: string; interim?: boolean }): number {
  if (frame.type === "activity" || frame.type === "step") return 0;
  if (frame.type === "result" && frame.interim) return 0;
  return [
    "live",
    "token",
    "provenance",
    "result",
    "suggestion",
    "suggestedAction",
    "memoryNote",
    "planProposal",
    "clarification",
    "followUps",
    "done",
  ].indexOf(frame.type);
}

describe("the live trail", () => {
  it("streams every phase before the first token, in the promised order", async () => {
    world.script = [
      {
        text: "Let me look at your blood pressure first.",
        calls: [
          {
            name: "get_metric_table",
            args: { metric: "bp", window: "last30days" },
          },
        ],
      },
      { text: "Your blood pressure held steady. result:r1" },
    ];
    const { status, frames } = await h.postTurn(post, {
      message: "How was my blood pressure?",
      locale: "en",
    });
    expect(status).toBe(200);
    expect(frames.at(-1)?.type).toBe("done");
    const order = frames.map(rank);
    expect(order.every((r) => r >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const activity = framesOf<{ activity: CoachActivity }>(
      frames,
      "activity",
    ).map((f) => f.activity);
    // The thinking entry opens first; the answer entry is the last live one.
    expect(activity[0]).toMatchObject({ phase: "thinking", status: "running" });
    expect(activity.at(-1)).toMatchObject({
      phase: "answer",
      status: "running",
    });
    const phases = new Set(activity.map((a) => a.phase));
    for (const phase of [
      "thinking",
      "checkpoint",
      "fetch",
      "digest",
      "answer",
    ]) {
      expect(phases).toContain(phase);
    }
    const fetch = activity.filter((a) => a.phase === "fetch").at(-1)!;
    expect(fetch).toMatchObject({
      status: "done",
      stepRef: "s1",
      labelKey: "insights.coach.activity.fetching",
    });
    expect(fetch.label).toBe("Fetching Blood pressure, last 30 days…");
    const checkpoint = activity.filter((a) => a.phase === "checkpoint").at(-1)!;
    expect(checkpoint.title).toBe("Let me look at your blood pressure first.");

    // The table went out as soon as it was read, before the first token.
    const firstToken = frames.findIndex((f) => f.type === "token");
    const interim = frames.findIndex(
      (f) => f.type === "result" && f.interim === true,
    );
    expect(interim).toBeGreaterThan(-1);
    expect(interim).toBeLessThan(firstToken);
  });

  it("persists the structure on the provenance and the text in the trail", async () => {
    world.script = [
      {
        text: "Let me look at your blood pressure first.",
        calls: [
          {
            name: "get_metric_table",
            args: { metric: "bp", window: "last30days" },
          },
        ],
      },
      { text: "Your blood pressure held steady. result:r1" },
    ];
    await h.postTurn(post, {
      message: "How was my blood pressure?",
      locale: "en",
    });
    const assistant = m.appendMessage.mock.calls
      .map(
        (c) =>
          c[0] as {
            role: string;
            metricSource?: CoachProvenance;
            trail?: unknown;
          },
      )
      .find((args) => args.role === "assistant")!;
    const provenance = assistant.metricSource!;
    expect(provenance.activity?.length).toBeGreaterThan(3);
    // The answer entry is stored closed.
    expect(provenance.activity?.at(-1)).toMatchObject({
      phase: "answer",
      status: "done",
    });
    expect(JSON.stringify(provenance)).not.toContain(
      "look at your blood pressure",
    );
    expect(assistant.trail).toMatchObject({
      entries: [
        expect.objectContaining({
          title: "Let me look at your blood pressure first.",
        }),
      ],
    });
  });
});

describe("a question asked through the tool", () => {
  it("ends the turn with the question and its choices, no chips", async () => {
    world.script = [
      {
        calls: [
          {
            name: "ask_clarification",
            args: {
              kind: "metric",
              question:
                "Do you mean resting or walking heart rate? Otherwise I'll look at resting.",
              choices: ["resting_hr", "walking_hr"],
              assumption: "resting_hr",
            },
          },
        ],
      },
    ];
    const { frames } = await h.postTurn(post, {
      message: "Is my heart rate good?",
      locale: "en",
    });
    expect(providerCalls).toHaveLength(1);
    const prose = framesOf<{ token: string }>(frames, "token")
      .map((f) => f.token)
      .join("");
    expect(prose).toBe(
      "Do you mean resting or walking heart rate? Otherwise I'll look at resting.",
    );
    const [clarification] = framesOf<{
      clarification: { kind: string; assumption?: string; choices: unknown[] };
    }>(frames, "clarification");
    expect(clarification.clarification).toMatchObject({
      kind: "metric",
      assumption: "c1",
    });
    expect(framesOf(frames, "followUps")).toHaveLength(0);
    const asking = framesOf<{ activity: CoachActivity }>(
      frames,
      "activity",
    ).find((f) => f.activity.phase === "asking");
    expect(asking?.activity.label).toBe("Asking you…");
  });
});

describe("concurrent turns", () => {
  it("refuses a third turn at once and gives its slot back", async () => {
    m.checkRateLimit.mockImplementation(async (key: string) =>
      key.startsWith("coach-turn-active:")
        ? { allowed: false, resetAt: 0 }
        : { allowed: true, resetAt: 0 },
    );
    const { status } = await h.postTurn(post, {
      message: "How was my blood pressure?",
      locale: "en",
    });
    expect(status).toBe(429);
    expect(providerCalls).toHaveLength(0);
    expect(m.checkRateLimit).toHaveBeenCalledWith(
      "coach-turn-active:u1",
      2,
      // The longest turn's wall time (200 s since v1.41.2) plus 30 s for
      // its reply to stream.
      230_000,
    );
  });
});

describe("a tapped decision", () => {
  beforeEach(() => {
    world.priorTurns = [
      { role: "user", content: "I started a weekly injection in May." },
      {
        role: "assistant",
        content: "Noted. Shall I remember that you take a weekly injection?",
      },
    ];
    world.storedProvenance = {
      memoryNote: { proposal: true, proposalId: "p1", category: "medication" },
    };
  });

  it("saves through the contract and answers with the catalog line, no model", async () => {
    contract.decideFactProposal.mockResolvedValue({
      kind: "saved",
      factId: "f1",
    });
    const { frames } = await h.postTurn(post, {
      message: "Yes, remember it",
      locale: "en",
      conversationId: h.CONVERSATION_ID,
      memoryDecision: {
        messageId: h.LAST_ASSISTANT_ID,
        proposalId: "p1",
        accept: true,
      },
    });
    expect(providerCalls).toHaveLength(0);
    expect(contract.decideFactProposal).toHaveBeenCalledWith({
      userId: "u1",
      conversationId: h.CONVERSATION_ID,
      messageId: h.LAST_ASSISTANT_ID,
      proposalId: "p1",
      accept: true,
    });
    const prose = framesOf<{ token: string }>(frames, "token")
      .map((f) => f.token)
      .join("");
    expect(prose).toBe("Got it, I'll remember.");
    expect(m.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant", providerType: "decision" }),
    );
  });

  it("goes to the model with the tap's label when the proposal is not on the latest reply", async () => {
    world.script = [{ text: "Sure." }];
    const { frames } = await h.postTurn(post, {
      message: "Yes, remember it",
      locale: "en",
      conversationId: h.CONVERSATION_ID,
      memoryDecision: { messageId: "m-older", proposalId: "p1", accept: true },
    });
    expect(contract.decideFactProposal).not.toHaveBeenCalled();
    expect(providerCalls).toHaveLength(1);
    expect(frames.at(-1)?.type).toBe("done");
  });
});
