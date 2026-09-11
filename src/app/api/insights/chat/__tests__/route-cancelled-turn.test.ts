import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #781 — a client that navigates away mid-generation aborts the SSE fetch.
 * The route must close the turn honestly: persist an EMPTY assistant marker
 * with `providerType: "cancelled"` so the conversation shows the interrupted
 * turn (and the client can offer a retry), instead of leaving the user
 * message dangling unanswered. The reservation is refunded in full, and the
 * abort is never misreported as a provider failure.
 *
 * Route-level on purpose: the abort branch lives in `route.ts`'s catch, a
 * place no pure-module test can see (the #591 lesson).
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
const { annotate } = vi.hoisted(() => ({ annotate: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  annotate,
  getEvent: vi.fn(() => null),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ coachPrefsJson: null })) },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    workout: { findFirst: vi.fn(async () => null) },
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

const { resolveProviderChain } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain,
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/prompts/insight-generator", () => ({ PROMPT_VERSION: "x" }));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { coach: { maxTokens: 1500, temperature: 0.4 } },
}));

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
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 3000,
    owner: "user" as const,
  })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-08-13"),
  reserveBudget,
  reconcileSpend,
  resolveDailyCap: vi.fn(() => 2_000_000),
  resolveCostOwner: vi.fn(() => "user" as const),
}));

vi.mock("@/lib/ai/coach/refusal", () => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
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

vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [{ name: "get_metric_series" }],
  MAX_ROUNDS: 3,
  buildCoachDataInventory: vi.fn(async () => ({
    entries: [],
    restMode: false,
    cycleEnabled: false,
    window: "last30days",
    probeScope: { sources: ["bp"], window: "last30days" },
  })),
  renderDataInventory: vi.fn(() => "DATA INVENTORY"),
  renderFocusHint: vi.fn(() => ""),
  buildToolModeAddendum: vi.fn(() => "TOOL ADDENDUM"),
  runCoachToolLoop: vi.fn(),
}));

vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(),
}));
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
      producer({ signal: { aborted: true }, enqueue: () => {} }),
    );
    return new ReadableStream();
  },
}));

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;

function abortedChatReq(body: Record<string, unknown>): Request {
  const controller = new AbortController();
  const req = new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  // The body is read synchronously by the handler before the provider call;
  // aborting here models the client tearing the connection down while the
  // provider is generating (the runner rejects below).
  controller.abort();
  return req;
}

function abortError(): Error {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("coach chat — client abort mid-generation (#781)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({
      allowed: true,
      reserved: 3000,
      owner: "user" as const,
    });
    // No-tools chain so the turn runs the streaming runner (which rejects
    // with the abort the torn-down connection produces).
    resolveProviderChain.mockResolvedValue([
      { providerType: "local", instance: { supportsTools: false } },
    ]);
    runStreamingRawCompletionWithFallback.mockRejectedValue(abortError());
  });

  it("persists an empty assistant marker with providerType 'cancelled'", async () => {
    const res = await post(abortedChatReq({ message: "How is my BP?" }));
    expect(res.status).toBe(200);
    await sse.done;

    const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
    // The user turn is persisted first, then the cancelled marker.
    const roles = calls.map((c) => (c[0] as { role: string }).role);
    expect(roles).toEqual(["user", "assistant"]);
    const marker = calls[1][0] as {
      role: string;
      content: string;
      providerType: string | null;
    };
    expect(marker.providerType).toBe("cancelled");
    expect(marker.content).toBe("");
  });

  it("refunds the full reservation and annotates the abort as cancelled, not a provider failure", async () => {
    await post(abortedChatReq({ message: "How is my BP?" }));
    await sse.done;

    expect(reconcileSpend).toHaveBeenCalledWith(
      "u1",
      3000,
      0,
      "2026-08-13",
      0,
      // No hop served the cancelled turn, so nothing is attributed to an
      // owner — the reservation is reversed on both counters.
      { servedBy: null, reservedOwner: "user" },
    );
    const actions = annotate.mock.calls
      .map((c) => (c[0] as { action?: { name?: string } }).action?.name)
      .filter(Boolean);
    expect(actions).toContain("insights.coach.cancelled");
    expect(actions).not.toContain("insights.coach.providerFailed");
  });
});
