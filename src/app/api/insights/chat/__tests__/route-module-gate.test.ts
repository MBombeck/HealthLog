import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.18.0 — the Coach chat POST (SSE) and the conversation-list GET both
 * enforce the two-layer module gate (operator availability AND the
 * per-user `disableCoach` opt-out) right after auth. A disabled module
 * returns the 403 `module.disabled` envelope verbatim before any other
 * Coach dependency runs; an enabled module falls through to the existing
 * assistant-flag check. The suite pins both branches so a refactor can't
 * quietly drop the gate.
 */

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

// The legacy assistant-flag gate the handler reaches AFTER the module
// gate. We throw a sentinel so an enabled module is observable by the
// control reaching this call.
class AssistantSentinel extends Error {}

const { requireModuleEnabled, requireAssistantSurface } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(),
  requireAssistantSurface: vi.fn(),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));
vi.mock("@/lib/feature-flags", () => ({ requireAssistantSurface }));

// Everything else the module imports — stubbed harmlessly; none of it is
// reached on the disabled branch, and the enabled branch stops at the
// assistant sentinel above.
vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(),
  resolveProvider: vi.fn(),
}));
vi.mock("@/lib/ai/consent-guard", () => ({ assertConsentForChain: vi.fn() }));
vi.mock("@/lib/ai/prompts/insight-generator", () => ({ PROMPT_VERSION: "x" }));
vi.mock("@/lib/ai/coach/types", () => ({
  coachChatRequestSchema: { safeParse: () => ({ success: false }) },
}));
// v1.20.0 (F1) — the route statically imports the tool barrel; this suite
// never reaches tool code (it asserts the 403 module-gate short-circuit), so a
// thin stub keeps the import graph satisfied without pulling the real schemas.
vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [],
  MAX_ROUNDS: 3,
  buildCoachDataInventory: vi.fn(),
  renderDataInventory: vi.fn(),
  renderFocusHint: vi.fn(() => ""),
  buildToolModeAddendum: vi.fn(),
  runCoachToolLoop: vi.fn(),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
  fetchConversationWithMessages: vi.fn(),
  listConversations: vi.fn(async () => ({
    conversations: [],
    nextCursor: null,
  })),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({ storeDeterministicFacts: vi.fn() }));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(),
  reserveBudget: vi.fn(async () => ({
    allowed: true,
    reserved: 0,
    totalAfter: 0,
  })),
  reconcileSpend: vi.fn(),
  resolveDailyCap: vi.fn(() => 200_000),
  resolveCostOwner: vi.fn(() => "operator" as const),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({ detectRefusal: vi.fn() }));
vi.mock("@/lib/ai/coach/system-prompt", () => ({
  getCoachSystemPrompt: vi.fn(),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(),
}));
vi.mock("@/lib/ai/coach/snapshot", () => ({ buildCoachSnapshot: vi.fn() }));
vi.mock("@/lib/ai/coach/keyvalues", () => ({
  parseKeyValuesSentinel: vi.fn(),
}));
vi.mock("@/lib/validations/coach-prefs", () => ({ parseCoachPrefs: vi.fn() }));
vi.mock("@/lib/sse/create-stream", () => ({ createSseStream: vi.fn() }));

import { POST, GET } from "../route";

type Envelope = {
  data: unknown;
  error: string | null;
  status: number;
  meta?: { errorCode?: string; module?: string };
};
const post = POST as unknown as (req: Request) => Promise<Envelope>;
const get = GET as unknown as (req: Request) => Promise<Envelope>;

const disabledResponse: Envelope = {
  data: null,
  error: 'Module "coach" is not enabled',
  status: 403,
  meta: { errorCode: "module.disabled", module: "coach" },
};

function chatPostReq(): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
}

function listReq(): Request {
  return new Request("http://localhost/api/insights/chat", { method: "GET" });
}

describe("coach chat module gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAssistantSurface.mockImplementation(async () => {
      throw new AssistantSentinel("reached assistant surface");
    });
  });

  it("POST returns 403 module.disabled when Coach is disabled", async () => {
    requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: disabledResponse,
    });

    const res = await post(chatPostReq());

    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
    expect(res.meta?.module).toBe("coach");
    expect(requireModuleEnabled).toHaveBeenCalledWith("u1", "coach");
    // The gate short-circuits before the legacy assistant flag.
    expect(requireAssistantSurface).not.toHaveBeenCalled();
  });

  it("POST falls through to the assistant flag when Coach is enabled", async () => {
    requireModuleEnabled.mockResolvedValue({ enabled: true });

    await expect(post(chatPostReq())).rejects.toBeInstanceOf(AssistantSentinel);
    expect(requireAssistantSurface).toHaveBeenCalledWith("coach");
  });

  it("GET returns 403 module.disabled when Coach is disabled", async () => {
    requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: disabledResponse,
    });

    const res = await get(listReq());

    expect(res.status).toBe(403);
    expect(res.meta?.errorCode).toBe("module.disabled");
    expect(requireModuleEnabled).toHaveBeenCalledWith("u1", "coach");
    expect(requireAssistantSurface).not.toHaveBeenCalled();
  });

  it("GET reaches 200 when Coach is enabled", async () => {
    requireModuleEnabled.mockResolvedValue({ enabled: true });
    requireAssistantSurface.mockResolvedValue(undefined);

    const res = await get(listReq());

    expect(res.status).toBe(200);
    expect(requireAssistantSurface).toHaveBeenCalledWith("coach");
  });
});
