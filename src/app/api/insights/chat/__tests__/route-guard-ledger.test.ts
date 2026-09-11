import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.32.9 (Coach Guard II / G2) — the Grounding Ledger is CROSS-TURN, so its
 * two load-bearing properties can only be seen at the route level, over a
 * conversation with prior turns (the #591 lesson — the pure module cannot see
 * the route's activation + cross-turn assembly):
 *
 *  - a prior-turn TOOL figure (persisted as `groundedFigures`) recalled this
 *    turn reconciles and is NOT stripped;
 *  - a number that appears only in a prior ASSISTANT REPLY (never a tool figure)
 *    does NOT ground the next turn — assistant prose is never a ledger source
 *    (D3 / red-team H3). It is still stripped.
 *
 * Guards are REAL here (coach-prose-grounding + grounding-ledger unmocked); the
 * provider loop + persistence are stubbed, exactly like route-tool-mode.
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

describe("coach chat — cross-turn Grounding Ledger (G2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({ allowed: true, reserved: 3000 });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
  });

  it("recalls a PRIOR-turn tool figure (persisted groundedFigures) without stripping it", async () => {
    // Turn 1 fetched systolic 128 and persisted it as groundedFigures.
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
    // This turn: a FRESH sleep tool activates the verifier; the model recalls
    // the prior 128 AND cites the fresh 440.
    stubReply(
      "Your sleep averaged 440 minutes, and your systolic 128 average still holds.",
      [{ present: true, data: { metric: "sleep", aggregate: { mean: 440 } } }],
    );

    await post(chatReq({ conversationId: "c1", message: "and my sleep?" }));
    await sse.done;

    const content = assistantContent();
    expect(content).toContain("128");
    expect(content).toContain("440");
    expect(content).not.toContain("[unverified]");
    expect(content).not.toContain("[…]");
    // v1.32.14 — a fully grounded reply carries NO unverifiedFigures key.
    expect(assistantProvenance()?.unverifiedFigures).toBeUndefined();
  });

  it("does NOT let a number from a prior ASSISTANT REPLY ground the next turn (D3 / H3)", async () => {
    // The prior assistant reply contains 158, but the persisted tool figure was
    // 128 — 158 was never a tool figure (a rung leak / fabrication). The ledger
    // must not read the assistant prose, so 158 stays ungrounded and is stripped.
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      attachmentCount: 0,
      summary: null,
      messages: [
        { role: "user", content: "How is my BP?" },
        {
          role: "assistant",
          content: "Your systolic spike to 158 mmHg is worth watching.",
          metricSource: { groundedFigures: [128] },
        },
      ],
    });
    // This turn: a fresh BP tool returns the real 128; the model repeats the
    // fabricated 158.
    stubReply("Your systolic spike to 158 mmHg persists this week.", [
      { present: true, data: { metric: "bp", aggregate: { avgSys30: 128 } } },
    ]);

    await post(chatReq({ conversationId: "c1", message: "still high?" }));
    await sse.done;

    const content = assistantContent();
    expect(content).not.toContain("158");
    // v1.32.14 — the withheld figure reads as the editorial elision mark, never
    // the old internal QA literal, and the count rides the provenance envelope.
    expect(content).toContain("[…]");
    expect(content).not.toContain("[unverified]");
    expect(assistantProvenance()?.unverifiedFigures).toBe(1);
  });
});
