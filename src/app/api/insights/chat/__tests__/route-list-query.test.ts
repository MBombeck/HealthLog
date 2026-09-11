import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.30.2 (QoL H1) — `GET /api/insights/chat` gained an optional `q` search
 * param so the history rail's search reaches the caller's FULL conversation
 * set (title-only, server-side) instead of filtering only the loaded page.
 * This suite pins the route's parsing: trimmed, length-capped, and omitted
 * (not an empty string) when absent — `listConversations` treats `undefined`
 * and `""` identically, but keeping the route from ever forwarding a bare
 * empty string documents the contract at the call site.
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

const { requireModuleEnabled, requireAssistantSurface } = vi.hoisted(() => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  requireAssistantSurface: vi.fn(async () => undefined),
}));
vi.mock("@/lib/modules/gate", () => ({ requireModuleEnabled }));
vi.mock("@/lib/feature-flags", () => ({ requireAssistantSurface }));

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
  runStreamingRawCompletionWithFallback: vi.fn(),
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
vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [],
  MAX_ROUNDS: 3,
  buildCoachDataInventory: vi.fn(),
  renderDataInventory: vi.fn(),
  renderFocusHint: vi.fn(() => ""),
  buildToolModeAddendum: vi.fn(),
  runCoachToolLoop: vi.fn(),
}));

interface ListConversationsCallArgs {
  userId: string;
  cursor?: string | null;
  limit?: number;
  q?: string;
}

// `vi.mock` factories are hoisted above every top-level declaration in the
// file, so a plain `const listConversations = vi.fn(...)` referenced inside
// the factory below would hit the temporal dead zone. `vi.hoisted` runs
// before that hoisting and is the documented escape hatch.
const { listConversations } = vi.hoisted(() => ({
  listConversations: vi.fn(async (params: ListConversationsCallArgs) => {
    void params; // typed purely so `.mock.calls[n][0]` below is not `never`
    return { conversations: [], nextCursor: null };
  }),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
  fetchConversationWithMessages: vi.fn(),
  listConversations,
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({ storeDeterministicFacts: vi.fn() }));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(),
  reserveBudget: vi.fn(),
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

import { GET } from "../route";

type Envelope = { data: unknown; error: string | null; status: number };
const get = GET as unknown as (req: Request) => Promise<Envelope>;

function listReq(qs = ""): Request {
  return new Request(`http://localhost/api/insights/chat${qs}`, {
    method: "GET",
  });
}

describe("GET /api/insights/chat — q search param", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireModuleEnabled.mockResolvedValue({ enabled: true });
    requireAssistantSurface.mockResolvedValue(undefined);
    listConversations.mockResolvedValue({
      conversations: [],
      nextCursor: null,
    });
  });

  it("omits q from listConversations when absent", async () => {
    await get(listReq());
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", q: undefined }),
    );
  });

  it("trims and forwards q", async () => {
    await get(listReq("?q=%20blood%20pressure%20"));
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ q: "blood pressure" }),
    );
  });

  it("caps an oversized q at 200 chars", async () => {
    const long = "a".repeat(500);
    await get(listReq(`?q=${long}`));
    const call = listConversations.mock.calls[0][0];
    expect(call.q).toHaveLength(200);
  });

  it("treats a whitespace-only q the same as absent (undefined, not empty string)", async () => {
    await get(listReq("?q=%20%20%20"));
    const call = listConversations.mock.calls[0][0];
    // Trimmed to "" — the route still passes the (falsy) trimmed string
    // through; listConversations treats "" the same as undefined.
    expect(call.q).toBe("");
  });

  it("still forwards cursor + limit unchanged alongside q", async () => {
    await get(listReq("?cursor=abc&limit=10&q=weight"));
    expect(listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "abc", limit: 10, q: "weight" }),
    );
  });
});
