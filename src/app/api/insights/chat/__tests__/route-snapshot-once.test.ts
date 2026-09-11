import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

/**
 * Stateless-provider grounding contract.
 *
 * The no-tools completion API does not retain a prior HTTP request's prompt.
 * Its persisted transcript contains user/assistant prose, not the SNAPSHOT
 * block. Every request therefore carries the current authoritative snapshot;
 * otherwise a short follow-up can only lean on model-authored prose and may
 * silently drift away from the user's data. Tool-capable providers use the
 * separate compact inventory + retrieval loop and are unaffected.
 */

const SNAPSHOT_JSON = '{"bp":{"aggregate":{"mean":128}}}';
const GROUNDING = "REFERENCE RANGES\nBP optimal < 120/80.";

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
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
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
vi.mock("@/lib/ai/provider", () => ({
  // v1.20.0 (F1) — pin a no-tools provider so this suite exercises the legacy
  // snapshot-stuffing fallback path (the behaviour it was written to pin). The
  // tool-retrieval path is covered by route-tool-mode.test.ts.
  resolveProviderChain: vi.fn(async () => [
    { providerType: "admin-openai", instance: { supportsTools: false } },
  ]),
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
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
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-06-21"),
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 1500 })),
  reconcileSpend: vi.fn(async () => undefined),
  resolveDailyCap: vi.fn(() => 2_000_000),
  resolveCostOwner: vi.fn(() => "user" as const),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
}));
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
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: GROUNDING,
  })),
}));
vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(() => ({
    prose: "Your BP looks stable.",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({ prose: "Your BP looks stable." })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));
// v1.22 (#89) — the provider call now runs INSIDE the stream producer. Capture
// the producer promise so the test can await it before asserting on call args.
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

function lastUserPrompt(): string {
  const calls = runStreamingRawCompletionWithFallback.mock
    .calls as unknown as Array<
    [{ params: { messages: Array<{ role: string; content: string }> } }]
  >;
  const last = calls[calls.length - 1];
  const userTurn = last[0].params.messages.find((m) => m.role === "user");
  return typeof userTurn?.content === "string" ? userTurn.content : "";
}

function lastProviderRequest(): { system: string; user: string } {
  const calls = runStreamingRawCompletionWithFallback.mock
    .calls as unknown as Array<
    [
      {
        params: {
          system: string;
          messages: Array<{ role: string; content: string }>;
        };
      },
    ]
  >;
  const params = calls[calls.length - 1][0].params;
  return {
    system: params.system,
    user:
      params.messages.find((message) => message.role === "user")?.content ?? "",
  };
}

describe("coach chat — stateless no-tools snapshot grounding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runStreamingRawCompletionWithFallback.mockResolvedValue({
      result: { content: "Your BP looks stable.", tokensUsed: 42, model: "m" },
      workingProvider: { providerType: "admin-openai" },
    });
  });

  it("ships the full SNAPSHOT + grounding on the first turn", async () => {
    await postAndDrain({ message: "How is my BP?" });
    const prompt = lastUserPrompt();
    expect(prompt).toContain(SNAPSHOT_JSON);
    expect(prompt).toContain(GROUNDING);
  });

  it("preserves the exact first-turn provider request bytes", async () => {
    await postAndDrain({ message: "How is my BP?" });
    const request = lastProviderRequest();

    expect({
      system: createHash("sha256").update(request.system).digest("hex"),
      user: createHash("sha256").update(request.user).digest("hex"),
    }).toEqual({
      system:
        "af01480eff5efcf94708812d55adacd1d197382112ada9f21150d841969c670a",
      user: "8f33d9d501db243e630ae88ca1680b426892520674b22547a17b9740b758d5b5",
    });
  });

  it("re-ships the authoritative snapshot on a follow-up turn", async () => {
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      summary: null,
      messages: [
        { role: "user", content: "How is my BP?" },
        { role: "assistant", content: "Your BP looks stable." },
      ],
    });

    await postAndDrain({ conversationId: "c1", message: "High?" });
    const prompt = lastUserPrompt();
    expect(prompt).toContain(SNAPSHOT_JSON);
    expect(prompt).toContain(GROUNDING);
    expect(prompt).not.toContain("provided earlier in this conversation");
    expect(prompt).toContain("Your BP looks stable.");
  });
});

/**
 * Long conversations remain grounded after transcript elision. The rolling
 * summary replaces old conversational prose, never the authoritative health
 * snapshot.
 */
describe("coach chat — snapshot stays grounded across transcript elision", () => {
  const TURN_CAP = 20;

  beforeEach(() => {
    vi.clearAllMocks();
    runStreamingRawCompletionWithFallback.mockResolvedValue({
      result: { content: "Your BP looks stable.", tokensUsed: 42, model: "m" },
      workingProvider: { providerType: "admin-openai" },
    });
  });

  /** Drive one turn against a conversation that already has `n` turns on disk. */
  async function turnWithPriorCount(n: number): Promise<string> {
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      summary: "earlier summary",
      messages: Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i}`,
      })),
    });
    await postAndDrain({ conversationId: "c1", message: "next?" });
    return lastUserPrompt();
  }

  it("remains grounded on the turn that crosses the cap", async () => {
    expect(await turnWithPriorCount(TURN_CAP)).toContain(SNAPSHOT_JSON);
  });

  it("remains grounded on every later stateless request", async () => {
    for (const prior of [TURN_CAP + 2, TURN_CAP + 6, TURN_CAP + 20, 58]) {
      expect(await turnWithPriorCount(prior)).toContain(SNAPSHOT_JSON);
    }
  });

  it("ships the current snapshot across a 60-turn conversation", async () => {
    let shipped = 0;
    const shippedAt: number[] = [];

    // Turn 1 starts a fresh conversation (no prior turns on disk); every later
    // turn loads the growing history. A successful turn persists both the user
    // and the assistant message, so the count advances by 2.
    fetchConversationWithMessages.mockResolvedValue(null);
    await postAndDrain({ message: "How is my BP?" });
    if (lastUserPrompt().includes(SNAPSHOT_JSON)) {
      shipped++;
      shippedAt.push(0);
    }

    for (let prior = 2; prior <= 60; prior += 2) {
      if ((await turnWithPriorCount(prior)).includes(SNAPSHOT_JSON)) {
        shipped++;
        shippedAt.push(prior);
      }
    }

    expect(shippedAt).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38,
      40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
    ]);
    expect(shipped).toBe(31);
  });

  /**
   * The turn count does not advance in fixed steps: the user message is
   * persisted before the provider call, the assistant message only on success,
   * so a turn that lost its reply advances the count by 1 instead of 2. An
   * exact `=== TURN_CAP` equality would be stepped straight over by such a
   * conversation and would then never re-ground at all. The window must catch
   * the crossing from either parity.
   */
  it("stays grounded when a lost reply shifts the turn parity", async () => {
    expect(await turnWithPriorCount(TURN_CAP + 1)).toContain(SNAPSHOT_JSON);
  });
});
