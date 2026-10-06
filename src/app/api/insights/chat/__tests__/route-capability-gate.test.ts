import { describe, it, expect, vi, beforeEach } from "vitest";

import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";

/**
 * The Coach chat POST (SSE) asks for the `coach` AI capability right after
 * auth, before the body is parsed or anything else runs. The capability folds
 * in what the Coach module gate, the operator switch and the `disableCoach`
 * opt-out used to answer separately, plus provider presence and consent.
 *
 *   - Unavailable for any reason but a missing provider: the capability
 *     envelope is thrown (apiHandler renders it) and nothing else runs.
 *   - `no_provider`: the existing `coach.provider.none` SSE frame, now with
 *     `reason`, because the streaming clients already read that frame.
 *
 * The conversation-list GET is the person's stored data: it never asks.
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

const { requireAiCapability } = vi.hoisted(() => ({
  requireAiCapability: vi.fn(),
}));
vi.mock("@/lib/ai/capabilities/gate", () => ({ requireAiCapability }));
vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
  MODULE_DISABLED_ERROR_CODE: "module.disabled",
}));

vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number, meta?: unknown) => ({
    data: null,
    error,
    status,
    meta,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiValidationError: (error: string, _issues: unknown, status: number) =>
    new Response(JSON.stringify({ data: null, error }), { status }),
  sanitiseZodIssues: () => [],
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  refundRateLimit: vi.fn(async () => {}),
}));
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
// The rest of the module stays real: the step labels read its enums at load.
vi.mock("@/lib/ai/coach/types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai/coach/types")>()),
  coachChatRequestSchema: {
    safeParse: () => ({ success: false, error: { issues: [] } }),
  },
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
  resolveDailyCapFor: vi.fn(() => 200_000),
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
// Collect the frames a stream would carry, so a refusal frame is observable.
vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: vi.fn(
    (start: (c: { enqueue: (chunk: Uint8Array) => void }) => void) => {
      const chunks: string[] = [];
      start({
        enqueue: (chunk) => chunks.push(new TextDecoder().decode(chunk)),
      });
      return chunks.join("");
    },
  ),
}));

import { POST, GET } from "../route";

type Envelope = { data: unknown; error: string | null; status: number };
const post = POST as unknown as (req: Request) => Promise<Response>;
const get = GET as unknown as (req: Request) => Promise<Envelope>;

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

describe("coach chat capability gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["operator_disabled", 403, "assistant.disabled.coach"],
    ["module_disabled", 403, "module.disabled"],
    ["user_disabled", 403, "module.disabled"],
    ["consent_required", 403, "consent.ai.required"],
    ["not_permitted_for_record", 403, "ai.record.notPermitted"],
    ["check_failed", 503, "ai.unavailable"],
  ] as const)(
    "POST refuses with the capability envelope for %s",
    async (reason, status, errorCode) => {
      requireAiCapability.mockRejectedValue(
        new AiUnavailableError("coach", reason),
      );

      const refused = await post(chatPostReq()).catch((err: unknown) => err);

      expect(refused).toBeInstanceOf(AiUnavailableError);
      const error = refused as AiUnavailableError;
      expect(error.status).toBe(status);
      expect(error.meta).toMatchObject({
        errorCode,
        capability: "coach",
        reason,
      });
      expect(requireAiCapability).toHaveBeenCalledWith("coach");
    },
  );

  it("POST keeps the coach.provider.none SSE frame for a missing provider, with the reason", async () => {
    requireAiCapability.mockRejectedValue(
      new AiUnavailableError("coach", "no_provider"),
    );

    const res = await post(chatPostReq());

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"code":"coach.provider.none"');
    expect(body).toContain('"reason":"no_provider"');
  });

  it("POST continues past the gate when the Coach is available", async () => {
    requireAiCapability.mockResolvedValue({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    });

    const res = await post(chatPostReq());

    // The stubbed schema refuses the body, so reaching validation proves the
    // gate let the request through.
    expect(res.status).toBe(422);
  });

  it("GET never asks for the capability: stored conversations stay readable", async () => {
    requireAiCapability.mockRejectedValue(
      new AiUnavailableError("coach", "operator_disabled"),
    );

    const res = await get(listReq());

    expect(res.status).toBe(200);
    expect(requireAiCapability).not.toHaveBeenCalled();
  });
});
