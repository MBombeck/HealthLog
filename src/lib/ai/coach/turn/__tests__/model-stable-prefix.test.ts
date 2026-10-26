/**
 * #1217 — the turn model sends the same system prompt on every turn. The
 * per-turn lines (opener hint, name clause, a resolved follow-up) reach the
 * model on the user side, on the tool path and on the streaming no-tools
 * path alike, so the provider's cached prefix survives from turn to turn.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  loop: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/ai/coach/persistence", () => ({ appendMessage: vi.fn() }));
vi.mock("@/lib/ai/coach/memory/contract", () => ({
  buildMemoryContextBlock: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/tools/run/prior-results", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  admittedPriorResults: vi.fn(async () => []),
}));
vi.mock("@/lib/ai/coach/tools", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildCoachDataInventory: vi.fn(async () => ({
    entries: [],
    probeScope: undefined,
  })),
  renderDataInventory: () => "DATA INVENTORY",
  runCoachToolLoop: (args: unknown) => m.loop(args),
}));
vi.mock("@/lib/ai/provider-runner", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runStreamingRawCompletionWithFallback: (args: unknown) => m.stream(args),
}));

import { runTurnModel } from "../model";
import type { TurnContext } from "../context";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function ctx(turnNotes: string): TurnContext {
  return {
    coachPrefs: {},
    reach: { kind: "unbounded" },
    aiResponseTimeoutMs: 60_000,
    effectiveScope: undefined,
    snapshot: {
      snapshotJson: "{}",
      sections: {},
      provenance: { windows: [], metrics: [], counts: {} },
    },
    aboutMe: null,
    scheduleDoses: [],
    medicationNames: [],
    turnContext: {
      allTurns: [],
      window: [],
      transcript: "user: hi",
      guidedBlock: "",
      historyElided: false,
      isFirstTurn: true,
      includeFullSnapshot: true,
    },
    workoutEvidence: null,
    systemPrompt: "STABLE SYSTEM",
    userPrompt: "SNAPSHOT AND CONVERSATION",
    turnNotes,
  } as unknown as TurnContext;
}

function run(turnNotes: string, turnHints: string[], toolMode: boolean) {
  return runTurnModel({
    userId: "u1",
    locale: "en",
    signal: new AbortController().signal,
    conversationId: "c1",
    ctx: ctx(turnNotes),
    chain: [] as never,
    toolMode,
    ledger: {
      settleRound: vi.fn(async () => {}),
      reserveRound: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    } as never,
    emitter: { emit: () => {}, aborted: () => false },
    turnHints,
    message: "hi",
    payer: "user",
    conversationWindowSet: false,
  }).catch(() => null);
}

beforeEach(() => {
  m.loop.mockReset().mockRejectedValue(new Error("stop after capture"));
  m.stream.mockReset().mockRejectedValue(new Error("stop after capture"));
});

describe("runTurnModel keeps the system prompt stable (#1217)", () => {
  it("on the tool path", async () => {
    await run("OPENER HINT for this turn: A", [], true);
    await run("OPENER HINT for this turn: B", ["FOLLOW-UP: the table"], true);
    const [first, second] = m.loop.mock.calls.map(
      ([args]) =>
        args as { system: string; messages: Array<{ content: string }> },
    );
    expect(sha(first!.system)).toBe(sha(second!.system));
    expect(first!.system).not.toContain("OPENER HINT");
    expect(second!.system).not.toContain("FOLLOW-UP");
    expect(first!.messages[0]!.content).toContain(
      "OPENER HINT for this turn: A",
    );
    expect(second!.messages[0]!.content).toContain("FOLLOW-UP: the table");
  });

  it("on the streaming no-tools path", async () => {
    await run("OPENER HINT for this turn: A", [], false);
    await run("OPENER HINT for this turn: B", ["FOLLOW-UP: the table"], false);
    const params = m.stream.mock.calls.map(
      ([args]) =>
        (
          args as {
            params: { system: string; messages: Array<{ content: string }> };
          }
        ).params,
    );
    expect(params[0]!.system).toBe("STABLE SYSTEM");
    expect(params[1]!.system).toBe("STABLE SYSTEM");
    const users = params.map((p) => JSON.stringify(p.messages));
    expect(users[0]).toContain("OPENER HINT for this turn: A");
    expect(users[1]).toContain("FOLLOW-UP: the table");
  });
});
