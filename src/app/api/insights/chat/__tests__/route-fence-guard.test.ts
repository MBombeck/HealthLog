import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.29.x (S7) — the tool route's DUAL fence guard (design §2.2, adversarial
 * tests 2 + 5). A fenced conversation id can never reach the tool loop:
 *   - PRIMARY: the fetch narrows `documentScoped: false`, so a fenced thread is
 *     invisible → 404.
 *   - BACKSTOP: even a `documentScoped: false` row carrying an attachment (flag/
 *     join drift) is refused with a `insights.coach.fence_drift` audit alarm.
 *
 * Mock scaffold mirrors route-snapshot-once.test.ts so `../route` imports cleanly.
 */

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = "HttpError";
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
const { annotate } = vi.hoisted(() => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({ annotate }));
const { auditLog } = vi.hoisted(() => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog }));
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
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runStreamingRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
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
  buildDateKey: vi.fn(() => "2026-07-16"),
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
    snapshotJson: "{}",
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: "",
  })),
}));
vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(() => ({
    prose: "ok",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({ prose: "ok" })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));
vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: () => new ReadableStream(),
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

async function statusOfThrow(body: Record<string, unknown>): Promise<number> {
  try {
    await post(chatReq(body));
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

describe("POST /api/insights/chat — fence guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches with documentScoped:false (a fenced thread is invisible here) and 404s", async () => {
    fetchConversationWithMessages.mockResolvedValue(null);
    const status = await statusOfThrow({
      conversationId: "fenced-conv",
      message: "hi",
    });
    expect(status).toBe(404);
    expect(fetchConversationWithMessages).toHaveBeenCalledWith(
      "u1",
      "fenced-conv",
      { documentScoped: false },
    );
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("fails closed with a fence_drift audit alarm when a documentScoped:false row still carries an attachment", async () => {
    fetchConversationWithMessages.mockResolvedValue({
      id: "drifted",
      title: "t",
      createdAt: "",
      updatedAt: "",
      messageCount: 1,
      fenced: false,
      attachments: [{ documentId: "doc-x", title: "x" }],
      attachmentCount: 1,
      messages: [],
      summary: null,
    });
    const status = await statusOfThrow({
      conversationId: "drifted",
      message: "hi",
    });
    expect(status).toBe(404);
    expect(auditLog).toHaveBeenCalledWith(
      "insights.coach.fence_drift",
      expect.objectContaining({
        userId: "u1",
        details: { conversationId: "drifted" },
      }),
    );
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "insights.coach.fence_drift" },
      }),
    );
  });
});
