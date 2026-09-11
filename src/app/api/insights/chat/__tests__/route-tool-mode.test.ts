import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.20.0 (F1) — Coach tool-retrieval routing contract.
 *
 *  - When every provider in the chain supports tools, the route runs the tool
 *    loop with a base context (DATA INVENTORY, NOT the snapshot figures), and
 *    persists the tool trace onto provenance.
 *  - When any provider lacks tool support, the route falls back to the legacy
 *    snapshot-stuffing single completion verbatim.
 *  - The inbound gates (rate limit, refusal, consent, budget reservation) all
 *    fire BEFORE the loop in both modes.
 */

const SNAPSHOT_JSON = '{"bp":{"aggregate":{"mean":128}}}';

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: vi.fn(async () => undefined),
}));
vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ coachPrefsJson: null })) },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    workout: {
      findFirst: vi.fn(async () => ({
        sportType: "running",
        source: "APPLE_HEALTH",
        startedAt: new Date("2026-07-01T06:00:00Z"),
        endedAt: new Date("2026-07-01T06:40:00Z"),
        durationSec: 2400,
        totalEnergyKcal: 410,
        totalDistanceM: 7200,
        avgHeartRate: 148,
        maxHeartRate: 171,
        minHeartRate: 96,
        stepCount: 6800,
        elevationM: 62,
        pauseDurationSec: 0,
        metadata: null,
        samples: null,
      })),
    },
  },
}));

const { checkRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

const { runStreamingRawCompletionWithFallback } = vi.hoisted(() => ({
  runStreamingRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runStreamingRawCompletionWithFallback,
}));

const { resolveProviderChain } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain,
  resolveProvider: vi.fn(),
}));

const { assertConsentForChain } = vi.hoisted(() => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/consent-guard", () => ({ assertConsentForChain }));
vi.mock("@/lib/ai/prompts/insight-generator", () => ({ PROMPT_VERSION: "x" }));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { coach: { maxTokens: 1500, temperature: 0.4 } },
}));

vi.mock("@/lib/ai/coach/types", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/coach/types")>(
    "@/lib/ai/coach/types",
  );
  return actual;
});

vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(async () => ({ id: "m1" })),
  createConversation: vi.fn(async () => ({ id: "c1" })),
  fetchConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({
  storeDeterministicFacts: vi.fn(async () => undefined),
}));

const { reserveBudget, reconcileSpend } = vi.hoisted(() => ({
  reserveBudget: vi.fn<
    () => Promise<{
      allowed: boolean;
      reserved: number;
      totalAfter?: number;
      owner?: "operator" | "user";
    }>
  >(async () => ({ allowed: true, reserved: 3000, owner: "user" as const })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-21"),
  reserveBudget,
  reconcileSpend,
  resolveDailyCap: vi.fn(() => 2_000_000),
  resolveCostOwner: vi.fn(() => "user" as const),
}));

const { detectRefusal } = vi.hoisted(() => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({ detectRefusal }));
vi.mock("@/lib/ai/coach/outbound-guard", () => ({
  screenCoachReply: vi.fn(() => ({ block: false })),
  coachOutboundFallback: vi.fn(() => "fallback"),
}));
vi.mock("@/lib/ai/coach/system-prompt", () => ({
  getCoachSystemPrompt: vi.fn(() => "SYSTEM"),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: vi.fn(async () => ({
    snapshotJson: SNAPSHOT_JSON,
    sections: { bloodPressure: { aggregate: { mean: 128 } } },
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: "REFERENCE RANGES",
  })),
}));
vi.mock("@/lib/workouts/hr-series", () => ({
  buildWorkoutHrSeries: vi.fn(async () => null),
}));
vi.mock("@/lib/workouts/zones", () => ({
  computeZones: vi.fn(() => null),
  hrMaxFromAge: vi.fn(() => 185),
  parseWhoopZoneDurations: vi.fn(() => null),
}));
vi.mock("@/lib/workouts/sport-context", () => ({
  buildSportContext: vi.fn(async () => null),
}));

// Tool-module surface — stub the inventory + loop so we assert routing only.
const {
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  runCoachToolLoop,
} = vi.hoisted(() => ({
  buildCoachDataInventory: vi.fn(async () => ({
    entries: [],
    restMode: false,
    cycleEnabled: false,
    window: "last30days",
    probeScope: { sources: ["bp", "hrv"], window: "last30days" },
  })),
  renderDataInventory: vi.fn(() => "DATA INVENTORY\n- blood pressure: present"),
  renderFocusHint: vi.fn(() => ""),
  runCoachToolLoop: vi.fn(async () => ({
    result: { content: "Your BP is steady.", tokensUsed: 80, model: "m" },
    workingProviderType: "anthropic",
    totalTokens: 80,
    rounds: 2,
    toolTrace: [{ name: "get_metric_series", present: true }],
    toolResults: [],
  })),
}));
vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [{ name: "get_metric_series" }],
  MAX_ROUNDS: 3,
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  buildToolModeAddendum: vi.fn(() => "TOOL ADDENDUM"),
  runCoachToolLoop,
}));

vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(() => ({
    prose: "Your BP is steady.",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({ prose: "Your BP is steady." })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));

const { appendMessage } = await import("@/lib/ai/coach/persistence");
const { parseKeyValuesSentinel } = await import("@/lib/ai/coach/keyvalues");
const { parseSuggestReminder } =
  await import("@/lib/ai/coach/suggest-reminder");

// v1.22 (#89) — the provider call + guards + persistence now run INSIDE the
// stream producer (heartbeat-fronted). The mock captures the producer's promise
// so tests can await it after `post()` before asserting on persisted effects.
const sse = vi.hoisted(() => ({ done: Promise.resolve() as Promise<unknown> }));
vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: (
    producer: (c: {
      signal: { aborted: boolean };
      enqueue: () => void;
    }) => void | Promise<void>,
  ) => {
    // aborted:false so the producer streams to completion (persist + frames).
    sse.done = Promise.resolve(
      producer({ signal: { aborted: false }, enqueue: () => {} }),
    );
    return new ReadableStream();
  },
}));

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;

/** Run a POST and wait for the in-stream producer to finish. */
async function postAndDrain(body: Record<string, unknown>): Promise<Response> {
  const res = await post(chatReq(body));
  await sse.done;
  return res;
}

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("coach chat — tool-mode routing (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({
      allowed: true,
      reserved: 3000,
      owner: "user" as const,
    });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
  });

  it("runs the tool loop (not the snapshot path) when the chain supports tools", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} }, // no supportsTools=false ⇒ tools on
    ]);
    await postAndDrain({ message: "How is my BP?" });

    expect(runCoachToolLoop).toHaveBeenCalledTimes(1);
    expect(runStreamingRawCompletionWithFallback).not.toHaveBeenCalled();
    // The base context carries the inventory, NOT the snapshot figures.
    const loopArgs = (runCoachToolLoop.mock.calls[0] as unknown[])[0] as {
      messages: Array<{ content: string }>;
    };
    const userContent = loopArgs.messages[0].content;
    expect(userContent).toContain("DATA INVENTORY");
    expect(userContent).not.toContain(SNAPSHOT_JSON);
  });

  it("pins selected-workout evidence into the tool-mode prompt", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    await postAndDrain({
      message: "Why was that hard?",
      workoutId: "workout-1",
    });

    const args = (runCoachToolLoop.mock.calls[0] as unknown[])[0] as {
      messages: Array<{ content: string }>;
    };
    expect(args.messages[0].content).toContain("SELECTED WORKOUT DATA");
    expect(args.messages[0].content).toContain("thisWorkout");
    expect(args.messages[0].content).toContain("2400");
  });

  it("reserves the multi-round budget in tool mode", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    await post(chatReq({ message: "How is my BP?" }));
    // maxTokens (1500) × MAX_ROUNDS (3). The 4th arg is the provider-aware
    // daily cap (F1) — mocked to the user-plan ceiling for this BYOK chain.
    expect(reserveBudget).toHaveBeenCalledWith(
      "u1",
      4500,
      "2026-06-21",
      2_000_000,
      "user",
    );
  });

  it("surfaces a graceful provider-error stream (NOT an HTTP 500) when the tool loop throws a tagged provider error", async () => {
    // v1.21.3 — RCA for the live incident. A Codex 400 raised inside the tool
    // loop used to bubble out un-wrapped and rethrow as an HTTP 500. The route
    // must now classify any tagged provider error (`upstream` + `httpStatus`)
    // and return the graceful 200 SSE error frame the drawer decodes.
    resolveProviderChain.mockResolvedValue([
      { providerType: "codex", instance: {} },
    ]);
    (runCoachToolLoop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Codex request failed (400): {…}"), {
        httpStatus: 400,
        upstream: "codex",
      }),
    );

    const res = await post(chatReq({ message: "How is my BP?" }));
    await sse.done;

    // No throw → no 500. The provider-error frame streams over a 200.
    expect(res.status).toBe(200);
    // The full reservation is refunded (no tokens billed on a failed turn).
    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      3000,
      0,
      expect.anything(),
      0,
      { servedBy: null, reservedOwner: "user" },
    );
  });

  it("persists the tool trace onto provenance", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    await postAndDrain({ message: "How is my BP?" });
    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    expect(
      (assistantCall?.[0] as { metricSource: { toolCalls?: unknown } })
        .metricSource.toolCalls,
    ).toEqual([{ name: "get_metric_series", present: true }]);
  });

  it("soft-strips a prose number the tools never returned (P6)", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    // Echo the real prose through the sentinel + suggest parsers so the
    // verifier sees the model's actual numbers (the default mocks return a
    // fixed string).
    const drift = "Your systolic averaged about 138 lately.";
    (parseKeyValuesSentinel as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: drift,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    (parseSuggestReminder as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: drift,
    });
    // The tool returned systolic 128; the prose drifts to 138.
    (runCoachToolLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        result: {
          content: "Your systolic averaged about 138 lately.",
          tokensUsed: 80,
          model: "m",
        },
        workingProviderType: "anthropic",
        totalTokens: 80,
        rounds: 2,
        toolTrace: [{ name: "get_metric_series", present: true }],
        toolResults: [
          { present: true, data: { aggregate: { avgSys30: 128 } } },
        ],
      }),
    );
    await postAndDrain({ message: "How is my BP?" });
    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    const content = (assistantCall?.[0] as { content: string }).content;
    expect(content).toContain("[…]");
    expect(content).not.toContain("138");
  });

  it("does not flag a sample count restated from the DATA INVENTORY manifest even when its own tool did not run this turn (v1.32.1)", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    // The DATA INVENTORY (always sent to the model this turn, regardless of
    // which tools actually fire — see `renderDataInventory`) advertises a
    // blood-pressure sample count of 42. The model restates it in prose while
    // the ONLY tool it actually called this turn was for workouts.
    (buildCoachDataInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        entries: [
          {
            tool: "get_metric_series",
            metric: "bp",
            domain: "blood pressure",
            present: true,
            count: 42,
          },
          {
            tool: "get_workouts",
            domain: "workouts & training",
            present: true,
            count: 12,
          },
        ],
        restMode: false,
        cycleEnabled: false,
        window: "last30days",
        probeScope: { sources: ["bp", "workouts"], window: "last30days" },
      },
    );
    const reply =
      "You've logged 42 blood pressure readings this window, and your last run burned 320 kcal.";
    (parseKeyValuesSentinel as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: reply,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    (parseSuggestReminder as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: reply,
    });
    (runCoachToolLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        result: { content: reply, tokensUsed: 80, model: "m" },
        workingProviderType: "anthropic",
        totalTokens: 80,
        rounds: 2,
        toolTrace: [{ name: "get_workouts", present: true }],
        // ONLY the workouts tool ran — the BP count "42" was never fetched
        // this turn, it came from the always-sent DATA INVENTORY manifest.
        toolResults: [
          {
            present: true,
            data: { workouts: [{ type: "run", calories: 320 }] },
          },
        ],
      }),
    );
    await postAndDrain({ message: "How is my BP and my training?" });
    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    const content = (assistantCall?.[0] as { content: string }).content;
    expect(content).not.toContain("[…]");
    expect(content).toContain("42");
    expect(content).toContain("320");
  });

  it("keeps the verifier dormant when NO tool returned figures this turn, even though the inventory rides the prompt (v1.32.1 regression)", async () => {
    // Regression guard for the integration failure: in tool mode the model can
    // answer a quick turn WITHOUT calling any tool (empty toolResults). The
    // always-sent DATA INVENTORY carries counts only, never the snapshot's
    // pre-computed averages. The verifier must NOT activate off the inventory
    // alone — otherwise a figure the model narrated from the snapshot (a
    // 30-day systolic average) is wrongly stripped. Matches `main`'s "no tool
    // figures → skip, prompt-level grounding is the backstop" contract.
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    (buildCoachDataInventory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      {
        entries: [
          {
            tool: "get_metric_series",
            metric: "bp",
            domain: "blood pressure",
            present: true,
            count: 14,
          },
        ],
        restMode: false,
        cycleEnabled: false,
        window: "last30days",
        probeScope: { sources: ["bp"], window: "last30days" },
      },
    );
    const reply = "Your 30-day systolic average is 130 mmHg, trending up.";
    (parseKeyValuesSentinel as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: reply,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    (parseSuggestReminder as ReturnType<typeof vi.fn>).mockReturnValue({
      prose: reply,
    });
    (runCoachToolLoop as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        result: { content: reply, tokensUsed: 60, model: "m" },
        workingProviderType: "anthropic",
        totalTokens: 60,
        rounds: 1,
        toolTrace: [],
        // No tool returned figures this turn — the model answered directly.
        toolResults: [],
      }),
    );
    await postAndDrain({ message: "How is my blood pressure this month?" });
    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const assistantCall = calls.find(
      (c) => (c[0] as { role: string }).role === "assistant",
    );
    const content = (assistantCall?.[0] as { content: string }).content;
    expect(content).not.toContain("[…]");
    expect(content).toContain("130");
  });

  it("falls back to the snapshot-stuffing path when a provider lacks tools", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
      { providerType: "local", instance: { supportsTools: false } },
    ]);
    runStreamingRawCompletionWithFallback.mockResolvedValue({
      result: { content: "Your BP is steady.", tokensUsed: 42, model: "m" },
      workingProvider: { providerType: "anthropic" },
    });
    await postAndDrain({ message: "How is my BP?" });

    expect(runCoachToolLoop).not.toHaveBeenCalled();
    expect(runStreamingRawCompletionWithFallback).toHaveBeenCalledTimes(1);
    // Single-round budget reservation in the fallback path; the 4th arg is the
    // provider-aware daily cap (F1).
    expect(reserveBudget).toHaveBeenCalledWith(
      "u1",
      1500,
      "2026-06-21",
      2_000_000,
      "user",
    );
    // The legacy path ships the snapshot figures in the user turn.
    const params = (
      (runStreamingRawCompletionWithFallback.mock.calls[0] as unknown[])[0] as {
        params: { messages: Array<{ content: string }> };
      }
    ).params;
    expect(params.messages[0].content).toContain(SNAPSHOT_JSON);
  });

  it("fires the inbound gates BEFORE the loop (consent throws ⇒ no loop)", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    assertConsentForChain.mockRejectedValue(new Error("consent.ai.required"));
    await expect(post(chatReq({ message: "How is my BP?" }))).rejects.toThrow(
      "consent.ai.required",
    );
    expect(runCoachToolLoop).not.toHaveBeenCalled();
    expect(reserveBudget).not.toHaveBeenCalled();
  });

  it("refuses over-budget before entering the loop", async () => {
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    reserveBudget.mockResolvedValue({
      allowed: false,
      reserved: 3000,
      totalAfter: 99999,
    });
    await post(chatReq({ message: "How is my BP?" }));
    expect(runCoachToolLoop).not.toHaveBeenCalled();
  });
});
