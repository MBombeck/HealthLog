/**
 * Shared fixtures for the Coach chat golden transcripts.
 *
 * The golden suite drives `POST /api/insights/chat` end to end through the
 * real SSE stream (`createSseStream` is NOT mocked) and the real reply guards
 * (sentinel parsers, outbound screen, grounding ledger, learn-link scrub,
 * refusal detector, request builder). Only the boundaries are replaced: auth,
 * the database, providers, budget, snapshot, tools, persistence and the
 * observability sinks.
 *
 * Every replaced boundary writes to one ordered call log, so a transcript
 * pins both halves of a turn: the frames the client sees (heartbeat comments
 * dropped) and the side effects in the order they happened.
 *
 * The test file registers the module mocks itself (vi.mock is hoisted per
 * file) and points each factory at the objects exported here.
 */
import { createHash } from "node:crypto";

import { vi } from "vitest";

export interface CallLogEntry {
  call: string;
  [key: string]: unknown;
}

export const log: CallLogEntry[] = [];

function record(call: string, detail: Record<string, unknown> = {}): void {
  log.push({ call, ...detail });
}

/** Short, stable fingerprint for a prompt string. */
export function fingerprint(text: string): string {
  return `${createHash("sha256").update(text).digest("hex").slice(0, 12)}:${text.length}`;
}

function sortedKeys(value: unknown): string[] {
  return value && typeof value === "object"
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
}

// ── Classes the route checks with instanceof ────────────────────────────

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface FallbackHopLike {
  providerType: string;
  httpStatus: number | null;
}

/** Mirrors the real `AllProvidersFailedError` fields the route reads. */
export class AllProvidersFailedError extends Error {
  readonly attempts: FallbackHopLike[];
  readonly primaryCredentialExpired: boolean;
  constructor(attempts: FallbackHopLike[]) {
    super(`All ${attempts.length} configured providers failed`);
    this.name = "AllProvidersFailedError";
    this.attempts = attempts;
    const first = attempts[0];
    this.primaryCredentialExpired =
      first !== undefined &&
      (first.httpStatus === 401 || first.httpStatus === 403);
  }
}

// ── Default fixtures ────────────────────────────────────────────────────

export const SNAPSHOT_JSON = '{"bloodPressure":{"aggregate":{"avgSys30":128}}}';

export function defaultSnapshot() {
  return {
    snapshotJson: SNAPSHOT_JSON,
    sections: { bloodPressure: { aggregate: { avgSys30: 128, avgDia30: 82 } } },
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: "REFERENCE RANGES",
  };
}

export function defaultInventory() {
  return {
    entries: [
      {
        tool: "get_metric_series",
        metric: "bp",
        domain: "blood pressure",
        present: true,
        count: 42,
      },
    ],
    restMode: false,
    cycleEnabled: false,
    window: "last30days",
    probeScope: { sources: ["bp"], window: "last30days" },
  };
}

// ── Mock module surfaces ────────────────────────────────────────────────

export const m = {
  requireAuth: vi.fn(),
  requireAiCapability: vi.fn(),
  isModuleEnabled: vi.fn(),
  annotate: vi.fn(),
  getEvent: vi.fn(),
  auditLog: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  conversationFindFirst: vi.fn(),
  coachMessageFindMany: vi.fn(),
  checkRateLimit: vi.fn(),
  resolveServerLocale: vi.fn(),
  runStreamingRawCompletionWithFallback: vi.fn(),
  resolveProviderChain: vi.fn(),
  resolveProvider: vi.fn(),
  assertConsentForChain: vi.fn(),
  appendMessage: vi.fn(),
  createConversation: vi.fn(),
  fetchConversationWithMessages: vi.fn(),
  listConversations: vi.fn(),
  enqueueCoachMemoryRefresh: vi.fn(),
  storeDeterministicFacts: vi.fn(),
  buildDateKey: vi.fn(),
  reserveBudget: vi.fn(),
  reconcileSpend: vi.fn(),
  resolveDailyCap: vi.fn(),
  resolveCostOwner: vi.fn(),
  getCoachSystemPrompt: vi.fn(),
  getSelfContextTextForUser: vi.fn(),
  buildCoachSnapshot: vi.fn(),
  getScheduledDoseValues: vi.fn(),
  buildWorkoutEvidenceSection: vi.fn(),
  buildCoachDataInventory: vi.fn(),
  renderDataInventory: vi.fn(),
  renderFocusHint: vi.fn(),
  buildToolModeAddendum: vi.fn(),
  runCoachToolLoop: vi.fn(),
  gateSuggestion: vi.fn(),
  captureReminderFromSentinel: vi.fn(),
  getGlitchtipSettings: vi.fn(),
  sendGlitchtipEvent: vi.fn(),
};

let messageSeq = 0;

/** Reset the log and restore every default behaviour. */
export function resetGolden(): void {
  log.length = 0;
  messageSeq = 0;
  for (const fn of Object.values(m)) fn.mockReset();

  m.requireAuth.mockResolvedValue({ user: { id: "u1", locale: "en" } });
  m.requireAiCapability.mockResolvedValue({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  m.isModuleEnabled.mockImplementation(async (_u: string, mod: string) => {
    record("isModuleEnabled", { module: mod });
    return true;
  });
  m.annotate.mockImplementation(
    (input: { action?: { name?: string }; meta?: unknown }) => {
      record("annotate", {
        name: input.action?.name ?? null,
        metaKeys: sortedKeys(input.meta),
      });
    },
  );
  m.getEvent.mockReturnValue({
    // A request event, so the per-request cache memoises as in production.
    getKind: () => "request",
    setError: (err: Error) =>
      record("event.setError", { message: err.message }),
  });
  m.auditLog.mockImplementation(
    async (name: string, input: { details?: unknown }) => {
      record("auditLog", { name, detailKeys: sortedKeys(input?.details) });
    },
  );
  m.userFindUnique.mockResolvedValue({
    coachPrefsJson: null,
    displayName: null,
    aiResponseTimeoutSeconds: null,
  });
  m.userUpdate.mockImplementation(async (args: { data: unknown }) => {
    record("prisma.user.update", { data: args.data });
    return {};
  });
  m.conversationFindFirst.mockResolvedValue({ id: "c-existing" });
  m.coachMessageFindMany.mockResolvedValue([]);
  m.checkRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
  m.resolveServerLocale.mockResolvedValue("en");
  m.resolveProviderChain.mockResolvedValue([
    { providerType: "anthropic", instance: {} },
  ]);
  m.resolveProvider.mockResolvedValue({ type: "none" });
  m.assertConsentForChain.mockImplementation(
    async (args: { chain: Array<{ providerType: string }> }) => {
      record("assertConsentForChain", {
        chain: args.chain.map((c) => c.providerType),
      });
    },
  );
  m.appendMessage.mockImplementation(
    async (args: {
      role: string;
      content: string;
      providerType?: string;
      metricSource?: unknown;
      tokensUsed?: number | null;
      model?: string | null;
    }) => {
      messageSeq += 1;
      record("appendMessage", {
        role: args.role,
        providerType: args.providerType ?? null,
        content: args.content,
        metricSource: args.metricSource ?? null,
        tokensUsed: args.tokensUsed ?? null,
        model: args.model ?? null,
      });
      return { id: `m${messageSeq}` };
    },
  );
  m.createConversation.mockImplementation(async () => {
    record("createConversation");
    return { id: "c-new" };
  });
  m.fetchConversationWithMessages.mockResolvedValue(null);
  m.enqueueCoachMemoryRefresh.mockImplementation(() => {
    record("enqueueCoachMemoryRefresh");
  });
  m.storeDeterministicFacts.mockImplementation(async () => {
    record("storeDeterministicFacts");
  });
  m.buildDateKey.mockReturnValue("2026-09-26");
  m.reserveBudget.mockImplementation(
    async (
      _userId: string,
      amount: number,
      dateKey: string,
      cap: number,
      owner: string,
      surface: string,
    ) => {
      record("reserveBudget", { amount, dateKey, cap, owner, surface });
      return { allowed: true, reserved: amount, owner: "user" };
    },
  );
  m.reconcileSpend.mockImplementation(
    async (
      _userId: string,
      reserved: number,
      actual: number,
      dateKey: string,
      cached: number,
      attribution: unknown,
    ) => {
      record("reconcileSpend", {
        reserved,
        actual,
        dateKey,
        cached,
        attribution,
      });
    },
  );
  m.resolveDailyCap.mockReturnValue(2_000_000);
  m.resolveCostOwner.mockReturnValue("user");
  m.getCoachSystemPrompt.mockReturnValue("SYSTEM");
  m.getSelfContextTextForUser.mockResolvedValue(null);
  m.buildCoachSnapshot.mockImplementation(async () => defaultSnapshot());
  m.getScheduledDoseValues.mockResolvedValue([]);
  m.buildWorkoutEvidenceSection.mockResolvedValue({
    sportType: "running",
    durationSec: 2400,
    avgHeartRate: 148,
  });
  m.buildCoachDataInventory.mockImplementation(async () => defaultInventory());
  m.renderDataInventory.mockReturnValue(
    "DATA INVENTORY\n- blood pressure: 42 readings",
  );
  m.renderFocusHint.mockReturnValue("");
  m.buildToolModeAddendum.mockReturnValue("TOOL ADDENDUM");
  m.runCoachToolLoop.mockResolvedValue(toolLoopResult("Your BP is steady."));
  m.runStreamingRawCompletionWithFallback.mockImplementation(
    streamingResult("Your BP is steady."),
  );
  m.gateSuggestion.mockResolvedValue({ surface: true });
  m.captureReminderFromSentinel.mockImplementation(
    async (args: { parsed: unknown }) => {
      record("captureReminderFromSentinel", { parsed: args.parsed });
    },
  );
  m.getGlitchtipSettings.mockResolvedValue({ glitchtipEnabled: false });
  m.sendGlitchtipEvent.mockResolvedValue(undefined);
}

/** A tool-loop result carrying `content`, recorded when the loop runs. */
export function toolLoopResult(
  content: string,
  overrides: {
    toolTrace?: Array<{ name: string; present: boolean }>;
    toolResults?: Array<{
      present: boolean;
      data?: unknown;
      available?: unknown;
    }>;
    totalTokens?: number;
    cachedTokens?: number;
  } = {},
) {
  return {
    result: {
      content,
      tokensUsed: overrides.totalTokens ?? 80,
      model: "m-tool",
    },
    workingProviderType: "anthropic",
    totalTokens: overrides.totalTokens ?? 80,
    cachedTokens: overrides.cachedTokens ?? 0,
    rounds: 2,
    toolTrace: overrides.toolTrace ?? [
      { name: "get_metric_series", present: true },
    ],
    toolResults: overrides.toolResults ?? [
      { present: true, data: { aggregate: { avgSys30: 128, avgDia30: 82 } } },
    ],
  };
}

/** A streaming-runner implementation that emits a few deltas. */
export function streamingResult(content: string) {
  return async (args: { onDelta?: (d: string) => void }) => {
    for (const piece of content.split(" ")) args.onDelta?.(piece);
    return {
      result: {
        content,
        tokensUsed: 42,
        cachedInputTokens: 5,
        model: "m-local",
      },
      workingProvider: { providerType: "local" },
    };
  };
}

// ── Provider-call recording ─────────────────────────────────────────────
// The provider entry points record their inputs as fingerprints (so prompt
// drift shows up in a transcript) and then delegate to the per-scenario
// behaviour on `m`. Recording lives in the wrapper, so a scenario that swaps
// the behaviour still gets logged.

export async function runCoachToolLoop(args: Record<string, unknown>) {
  const messages = args.messages as Array<{ role: string; content: string }>;
  record("runCoachToolLoop", {
    providers: (args.providers as Array<{ providerType: string }>).map(
      (p) => p.providerType,
    ),
    system: fingerprint(String(args.system)),
    messages: messages.map((msg) => `${msg.role}:${fingerprint(msg.content)}`),
    tools: (args.tools as unknown[]).length,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
    fallbackWindow: args.fallbackWindow ?? null,
    sharedScope: args.sharedScope,
    timeoutMs: args.timeoutMs,
    signal: args.signal instanceof AbortSignal,
  });
  const out = await m.runCoachToolLoop(args);
  // The real loop settles each round on the turn's ledger as it returns;
  // the scripted loop settles its whole cost as one round.
  const spend = args.spend as
    | {
        settleRound(usage: {
          tokens: number;
          cachedTokens: number;
          servedBy: string;
          final: boolean;
        }): Promise<void>;
      }
    | undefined;
  await spend?.settleRound({
    tokens: out.totalTokens,
    cachedTokens: out.cachedTokens,
    servedBy: out.workingProviderType,
    final: false,
  });
  return out;
}

export async function runStreamingRawCompletionWithFallback(
  args: Record<string, unknown>,
) {
  const params = args.params as {
    system?: string;
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    signal?: unknown;
  };
  record("runStreamingRawCompletionWithFallback", {
    surface: args.surface,
    providers: (args.providers as Array<{ providerType: string }>).map(
      (p) => p.providerType,
    ),
    system: fingerprint(String(params.system)),
    messages: params.messages.map(
      (msg) => `${msg.role}:${fingerprint(msg.content)}`,
    ),
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
    signal: params.signal instanceof AbortSignal,
  });
  return m.runStreamingRawCompletionWithFallback(args);
}

// ── Driving a turn ──────────────────────────────────────────────────────

export type Frame = Record<string, unknown>;

/** Split an SSE body into data frames, dropping `: ka` heartbeat comments. */
export function parseFrames(body: string): Frame[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(":"))
    .map((chunk) => {
      if (!chunk.startsWith("data: ")) {
        throw new Error(`unexpected SSE chunk: ${chunk}`);
      }
      return JSON.parse(chunk.slice("data: ".length)) as Frame;
    });
}

export interface Transcript {
  status: number | null;
  contentType: string | null;
  thrown: string | null;
  /** The body of a non-SSE response (a JSON refusal), else null. */
  body: string | null;
  frames: Frame[];
  calls: CallLogEntry[];
}

type PostFn = (req: Request) => Promise<Response>;

export async function runTurn(
  post: PostFn,
  body: Record<string, unknown> | string,
  opts: { signal?: AbortSignal } = {},
): Promise<Transcript> {
  const req = new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: opts.signal,
  });
  let res: Response;
  try {
    res = await post(req);
  } catch (err) {
    return {
      status: err instanceof HttpError ? err.status : null,
      contentType: null,
      thrown: err instanceof Error ? err.message : String(err),
      body: null,
      frames: [],
      calls: [...log],
    };
  }
  const text = await res.text();
  // Fire-and-forget writes settle on the microtask queue; give them a tick.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const contentType = res.headers.get("Content-Type");
  const isSse = contentType?.startsWith("text/event-stream") ?? false;
  return {
    status: res.status,
    contentType,
    thrown: null,
    body: isSse ? null : text,
    frames: isSse ? parseFrames(text) : [],
    calls: [...log],
  };
}
