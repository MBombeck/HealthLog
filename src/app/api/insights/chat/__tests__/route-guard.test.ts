import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.32.7 (Coach Guard I / G1) — route-level SSE assertions on the ASSEMBLED
 * reply, the class the pure-module tests cannot see (the #591 lesson: the unit
 * suite was green while the route regressed, because the guard runs inside
 * `route.ts`). Unlike `route-tool-mode.test.ts`, this file uses the REAL
 * outbound guard and the REAL numeric verifier — only the provider + IO are
 * stubbed — so it exercises the guard exactly as production does, on both a
 * tool turn and a no-tool turn.
 *
 * It asserts on the persisted assistant `content`, which is the fully-guarded
 * text streamed to the client (every guard runs before the first token frame).
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
    workout: { findFirst: vi.fn(async () => null) },
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
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 3000 })),
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

// NB: the outbound guard + numeric verifier are REAL — that is the point.
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

const { runCoachToolLoop } = vi.hoisted(() => ({
  runCoachToolLoop: vi.fn(),
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
import { COACH_OUTBOUND_RISK_BLOCK_EN } from "@/lib/ai/coach/outbound-guard";

const post = POST as unknown as (req: Request) => Promise<Response>;

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The reply the model "returned" flows through the sentinel parsers verbatim. */
function echo(content: string): void {
  parseKeyValuesSentinel.mockReturnValue({
    prose: content,
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  });
  parseSuggestReminder.mockReturnValue({ prose: content });
}

/** Drive a TOOL turn returning `content` with the given tool payloads. */
async function toolTurn(
  content: string,
  toolResults: Array<{ present: boolean; data: unknown }> = [],
): Promise<string> {
  echo(content);
  resolveProviderChain.mockResolvedValue([
    { providerType: "anthropic", instance: {} },
  ]);
  runCoachToolLoop.mockResolvedValue({
    result: { content, tokensUsed: 80, model: "m" },
    workingProviderType: "anthropic",
    totalTokens: 80,
    rounds: 1,
    toolTrace: [{ name: "get_metric_series", present: true }],
    toolResults,
  });
  const res = await post(chatReq({ message: "How is my BP?" }));
  await sse.done;
  expect(res.status).toBe(200);
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (assistant?.[0] as { content: string }).content;
}

/** Drive a NO-TOOL turn (a provider lacking tools) returning `content`. */
async function noToolTurn(content: string): Promise<string> {
  echo(content);
  resolveProviderChain.mockResolvedValue([
    { providerType: "anthropic", instance: {} },
    { providerType: "local", instance: { supportsTools: false } },
  ]);
  runStreamingRawCompletionWithFallback.mockResolvedValue({
    result: { content, tokensUsed: 42, model: "m" },
    workingProvider: { providerType: "anthropic" },
  });
  const res = await post(chatReq({ message: "How is my BP?" }));
  await sse.done;
  expect(res.status).toBe(200);
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (assistant?.[0] as { content: string }).content;
}

describe("coach chat — Guard I at the route level (G1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({ allowed: true, reserved: 3000 });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
  });

  it("replaces a fabricated risk assertion end-to-end (tool turn)", async () => {
    const content =
      "Based on SCORE2, your risk sits at about 14% given your numbers.";
    const out = await toolTurn(content, [
      { present: true, data: { metric: "bp", aggregate: { avgSys30: 128 } } },
    ]);
    expect(out).toBe(COACH_OUTBOUND_RISK_BLOCK_EN);
    expect(out).not.toContain("14%");
  });

  it("replaces a fabricated risk assertion end-to-end (no-tool turn)", async () => {
    const out = await noToolTurn(
      "Your ten-year cardiovascular risk is roughly twelve percent.",
    );
    expect(out).toBe(COACH_OUTBOUND_RISK_BLOCK_EN);
    expect(out).not.toContain("twelve percent");
  });

  it("streams a model-perfect refusal intact — it is not blocked or mangled (tool turn)", async () => {
    const content =
      "I can't calculate a 10-year cardiovascular risk for you — an ASCVD score is something your clinician computes with lab values I don't have.";
    const out = await toolTurn(content, [
      { present: true, data: { metric: "bp", aggregate: { avgSys30: 128 } } },
    ]);
    expect(out).toBe(content);
    expect(out).not.toContain("[…]");
  });

  it("streams dates, ranges and thousands unmangled when they are grounded (tool turn)", async () => {
    const content =
      "On 2026-07-23 your systolic sat between 120 and 135 mmHg, with about 10,000 steps logged.";
    const out = await toolTurn(content, [
      {
        present: true,
        data: { metric: "bp", section: { aggregate: { min: 121, max: 134 } } },
      },
      {
        present: true,
        data: { metric: "steps", section: { aggregate: { latest: 10000 } } },
      },
    ]);
    expect(out).toBe(content);
    expect(out).not.toContain("[…]");
  });

  it("soft-strips a genuinely fabricated figure on a tool turn (the floor still holds)", async () => {
    const content = "Your systolic averaged about 138 recently.";
    const out = await toolTurn(content, [
      {
        present: true,
        data: { metric: "bp", section: { aggregate: { avgSys30: 128 } } },
      },
    ]);
    expect(out).toContain("[…]");
    expect(out).not.toContain("138");
  });
});
