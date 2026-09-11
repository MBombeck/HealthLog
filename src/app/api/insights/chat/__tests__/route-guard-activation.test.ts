import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * REGRESSION — when the Coach's numeric grounding guard is armed, and when it
 * deliberately is not.
 *
 * The guard rewrites any figure in the reply that the turn's Grounding Ledger
 * cannot account for. Its activation used to key solely off `loop.toolResults`,
 * and a tool that found nothing resolves to `{ present: false, reason: "none" }`
 * with no `available` payload, which `loop.ts` drops (pinned in
 * `tools-loop-miss-payloads.test.ts`). So the guard disarmed itself exactly
 * when the record was empty, and a fabricated figure shipped verbatim with no
 * withheld-figure marker.
 *
 * `toolTrace` now discriminates the two cases the old condition conflated:
 *
 *   - tools RAN and every one missed  -> grade. An empty ledger is the finding,
 *     not a reason to skip, so every magnitude is unreconciled. A reply that
 *     loses a figure this way is replaced with the honest "nothing recorded"
 *     answer rather than shipping elided prose that still asserts a series.
 *   - the model called NO tool        -> stay dormant. This is the v1.32.1
 *     contract: the tool-mode base prompt deliberately carries no pre-computed
 *     figures, and flagging a legitimately recalled one was a real regression.
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
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(),
}));
vi.mock("@/lib/logging/redact", () => ({
  redactSecrets: (s: string) => s,
  redactOptional: (s: unknown) => s,
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ coachPrefsJson: null })) },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
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

const { fetchConversationWithMessages } = vi.hoisted(() => ({
  fetchConversationWithMessages: vi.fn(),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(async () => ({ id: "m1" })),
  createConversation: vi.fn(async () => ({ id: "c1" })),
  fetchConversationWithMessages,
  listConversations: vi.fn(),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({
  storeDeterministicFacts: vi.fn(async () => undefined),
}));

// Guard II — the schedule read. Empty here; the schedule-gated dose rule is
// unit-tested in the outbound-screen suite.
vi.mock("@/lib/medications/scheduled-doses", () => ({
  getScheduledDoseValues: vi.fn(async () => []),
}));

const { reserveBudget, reconcileSpend } = vi.hoisted(() => ({
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 3000 })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-23"),
  reserveBudget,
  reconcileSpend,
  resolveDailyCap: vi.fn(() => 2_000_000),
  resolveDailyCapFor: vi.fn(() => 2_000_000),
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
    probeScope: { sources: ["bp"], window: "last30days" },
  })),
  renderDataInventory: vi.fn(() => "DATA INVENTORY\n- blood pressure: present"),
  renderFocusHint: vi.fn(() => ""),
  runCoachToolLoop: vi.fn(),
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

const { parseKeyValuesSentinel } = vi.hoisted(() => ({
  parseKeyValuesSentinel: vi.fn(),
}));
vi.mock("@/lib/ai/coach/keyvalues", () => ({ parseKeyValuesSentinel }));
const { parseSuggestReminder } = vi.hoisted(() => ({
  parseSuggestReminder: vi.fn(),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({ parseSuggestReminder }));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));

const { appendMessage } = await import("@/lib/ai/coach/persistence");

const sse = vi.hoisted(() => ({ done: Promise.resolve() as Promise<unknown> }));
vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: (
    producer: (c: {
      signal: { aborted: boolean };
      enqueue: () => void;
    }) => void | Promise<void>,
  ) => {
    sse.done = Promise.resolve(
      producer({ signal: { aborted: false }, enqueue: () => {} }),
    );
    return new ReadableStream();
  },
}));

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Force the model's assembled prose through the sentinel/suggest parsers. */
function stubReply(prose: string, toolResults: unknown[]): void {
  parseKeyValuesSentinel.mockReturnValue({
    prose,
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  });
  parseSuggestReminder.mockReturnValue({ prose });
  runCoachToolLoop.mockImplementation(async () => ({
    result: { content: prose, tokensUsed: 80, model: "m" },
    workingProviderType: "anthropic",
    totalTokens: 80,
    rounds: 1,
    toolTrace: [{ name: "get_metric_series", present: true }],
    toolResults,
  }));
}

function assistantContent(): string {
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (assistant?.[0] as { content: string }).content;
}

function assistantProvenance(): Record<string, unknown> | null | undefined {
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (
    assistant?.[0] as {
      metricSource?: Record<string, unknown> | null;
    }
  ).metricSource;
}

describe("coach chat — grounding-guard activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({ allowed: true, reserved: 3000 });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      attachmentCount: 0,
      summary: null,
      messages: [],
    });
  });

  /** Drive the loop with an explicit trace so a MISS is modelled faithfully. */
  function stubMissedTurn(prose: string): void {
    parseKeyValuesSentinel.mockReturnValue({
      prose,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    parseSuggestReminder.mockReturnValue({ prose });
    runCoachToolLoop.mockImplementation(async () => ({
      result: { content: prose, tokensUsed: 80, model: "m" },
      workingProviderType: "anthropic",
      totalTokens: 80,
      rounds: 1,
      // The tool ran and found nothing; `loop.ts` drops the pure miss from
      // `toolResults` but the trace still records the call.
      toolTrace: [{ name: "get_sleep", present: false }],
      toolResults: [],
    }));
  }

  it("CONTROL — one present tool result arms the guard: the invented figure is stripped", async () => {
    stubReply("Your sleep averaged 432 minutes last week.", [
      { present: true, data: { metric: "bp", aggregate: { avgSys30: 128 } } },
    ]);

    await post(chatReq({ conversationId: "c1", message: "how did I sleep?" }));
    await sse.done;

    expect(assistantContent()).not.toContain("432");
    expect(assistantContent()).toContain("[…]");
    expect(assistantProvenance()?.unverifiedFigures).toBe(1);
  });

  it("every tool missed: the fabricated figure is caught and the turn is replaced", async () => {
    stubMissedTurn("Your sleep averaged 432 minutes last week.");

    await post(chatReq({ conversationId: "c1", message: "how did I sleep?" }));
    await sse.done;

    const content = assistantContent();
    expect(content).not.toContain("432");
    // Not the elided prose either — the sentence asserted a series the record
    // does not hold, so the whole turn is replaced with the honest answer.
    expect(content).not.toContain("[…]");
    expect(content).toContain("recorded readings");
    // The replacement copy says it in words, so the count-based notice is off.
    expect(assistantProvenance()?.unverifiedFigures).toBeUndefined();
  });

  it("every tool missed but the figure is grounded by a prior turn: left alone", async () => {
    // Turn 1 fetched systolic 128 and persisted it as a tool figure. This turn
    // every tool misses, but recalling 128 still reconciles, so nothing is
    // stripped and the reply is NOT replaced.
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      attachmentCount: 0,
      summary: null,
      messages: [
        { role: "user", content: "How is my BP?" },
        {
          role: "assistant",
          content: "Your systolic averaged 128.",
          metricSource: { groundedFigures: [128] },
        },
      ],
    });
    stubMissedTurn(
      "No sleep readings yet. Your systolic 128 average is unrelated to that.",
    );

    await post(chatReq({ conversationId: "c1", message: "and my sleep?" }));
    await sse.done;

    const content = assistantContent();
    expect(content).toContain("128");
    expect(content).not.toContain("[…]");
    expect(content).not.toContain("recorded readings");
  });

  it("the model called no tool at all: the guard stays dormant (v1.32.1)", async () => {
    // Deliberately unchanged behaviour. The tool-mode base prompt carries no
    // pre-computed figures, so a number here came from the transcript or the
    // model's own recall, and grading it off the counts-only inventory flagged
    // legitimate figures as ungrounded. `toolTrace` is empty, so the widened
    // activation above does not reach this case.
    const prose = "Your resting heart rate has been averaging 58 bpm.";
    parseKeyValuesSentinel.mockReturnValue({
      prose,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    parseSuggestReminder.mockReturnValue({ prose });
    runCoachToolLoop.mockImplementation(async () => ({
      result: { content: prose, tokensUsed: 80, model: "m" },
      workingProviderType: "anthropic",
      totalTokens: 80,
      rounds: 1,
      toolTrace: [],
      toolResults: [],
    }));

    await post(chatReq({ conversationId: "c1", message: "how is my RHR?" }));
    await sse.done;

    expect(assistantContent()).toBe(prose);
    expect(assistantProvenance()?.unverifiedFigures).toBeUndefined();
  });
});
