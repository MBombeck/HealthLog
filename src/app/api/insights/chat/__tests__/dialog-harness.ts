/**
 * Shared fixtures for driving `POST /api/insights/chat` through the real
 * turn pipeline with a scripted provider.
 *
 * Unlike the golden harness, the tool loop, the executor, the table tool,
 * the chart heuristics, the chips, the clarification filter, the method
 * line, the reply guards and the SSE stream all run for real. Only the
 * edges are replaced: auth and the front-door gates, the database, the
 * provider (a script of rounds), the data reads under the table tool, the
 * snapshot and inventory builders, persistence and the observability sinks.
 *
 * A test file registers the module mocks itself (vi.mock is hoisted per
 * file) and points each factory at the objects exported here; `mockModules`
 * lists them so the two files that use this harness stay in step.
 */
import { vi } from "vitest";

import type {
  CoachFollowUp,
  CoachResultMeta,
  CoachResultTable,
  CoachScopeSource,
} from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import { COACH_SOURCE_SNAPSHOT_KEY } from "@/lib/ai/coach/tools/source-keys";

// ── The world a turn runs against ─────────────────────────────────────────

/** One scripted provider round: tool calls, or the reply text. */
export interface ScriptRound {
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
  text?: string;
}

export interface DialogWorld {
  inventory: InventoryEntry[];
  priorTurns: Array<{ role: "user" | "assistant"; content: string }>;
  /** Tables the last assistant turn holds, stored in full. */
  storedTables: CoachResultTable[];
  /** Chips the last assistant turn offered. */
  storedFollowUps: CoachFollowUp[];
  /** Extra plaintext provenance on the last assistant turn. */
  storedProvenance: Record<string, unknown>;
  /** The stored tables' values are withheld (their module is off). */
  resultsWithheld: boolean;
  /** The provider's rounds, consumed in order. */
  script: ScriptRound[];
}

export const world: DialogWorld = {
  inventory: [],
  priorTurns: [],
  storedTables: [],
  storedFollowUps: [],
  storedProvenance: {},
  resultsWithheld: false,
  script: [],
};

/** Everything the scripted provider was sent and answered, in order. */
export interface ProviderCall {
  system: string;
  messages: Array<{ role: string; content: string }>;
  toolChoice: string | undefined;
  cacheKey: string | undefined;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
}
export const providerCalls: ProviderCall[] = [];

/** The last assistant message of the stored conversation. */
export const LAST_ASSISTANT_ID = "m-a1";
export const CONVERSATION_ID = "c-dialog";

/** Pinned "now" for every turn. */
export const NOW = new Date("2026-09-27T10:00:00Z");
/** The record's first reading of every present metric. */
const FIRST_READING = new Date("2024-06-01T08:00:00Z");

/** The value a type reads on every day it has a reading. */
const LEVEL: Record<string, number> = {
  BLOOD_PRESSURE_SYS: 124,
  BLOOD_PRESSURE_DIA: 81,
  PULSE: 62,
  RESTING_HEART_RATE: 58,
  WALKING_HEART_RATE_AVERAGE: 96,
  WEIGHT: 78.4,
};

function presentSources(): Set<CoachScopeSource> {
  const out = new Set<CoachScopeSource>();
  for (const entry of world.inventory) {
    if (!entry.present) continue;
    if (entry.metric) out.add(entry.metric as CoachScopeSource);
    if (entry.tool === "get_sleep") out.add("sleep");
    if (entry.tool === "get_medication_compliance") out.add("compliance");
  }
  return out;
}

function presentTypes(): Set<string> {
  const out = new Set<string>();
  for (const source of presentSources()) {
    for (const type of COACH_SOURCE_MEASUREMENT_TYPES[source] ?? []) {
      out.add(type);
    }
  }
  return out;
}

// ── Stored tables ──────────────────────────────────────────────────────────

/** A full stored table for a scenario's table metadata. */
export function storedTable(meta: CoachResultMeta): CoachResultTable {
  const granularity = meta.source.granularity ?? "day";
  const periods =
    granularity === "week"
      ? ["2026-W35", "2026-W36", "2026-W37", "2026-W38", "2026-W39"]
      : Array.from({ length: 5 }, (_, i) => `2026-09-${String(20 + i)}`);
  const bp = meta.source.domain === "bp";
  return {
    ...meta,
    rowCount: periods.length,
    columns: [
      {
        key: granularity,
        kind: "period",
        labelKey: `coach.result.column.${granularity}`,
        label: granularity === "week" ? "Week" : "Day",
      },
      ...(bp
        ? [
            {
              key: "systolic",
              kind: "number" as const,
              labelKey: "coach.result.column.systolic",
              label: "Systolic",
              unit: "mmHg",
              decimals: 0,
            },
            {
              key: "diastolic",
              kind: "number" as const,
              labelKey: "coach.result.column.diastolic",
              label: "Diastolic",
              unit: "mmHg",
              decimals: 0,
            },
          ]
        : [
            {
              key: "value",
              kind: "number" as const,
              labelKey: "coach.result.column.value",
              label: "Value",
              unit: "bpm",
              decimals: 0,
            },
          ]),
    ],
    rows: periods.map((p, i) =>
      bp ? [p, 122 + i, 80 + (i % 2)] : [p, 61 + i],
    ),
    truncated: false,
    chart: {
      kind: "line",
      x: granularity,
      series: bp ? ["systolic", "diastolic"] : ["value"],
    },
    chartKind: "line",
  };
}

function toMeta(table: CoachResultTable): CoachResultMeta {
  const {
    columns: _columns,
    rows: _rows,
    truncated: _truncated,
    chart: _chart,
    ...meta
  } = table;
  return meta;
}

/** The stored conversation, as `fetchConversationWithMessages` returns it. */
function storedConversation() {
  const messages = world.priorTurns.map((turn, index) => {
    const last = index === world.priorTurns.length - 1;
    const id =
      turn.role === "assistant" && last ? LAST_ASSISTANT_ID : `m-${index}`;
    const metricSource =
      turn.role === "assistant" && last
        ? {
            windows: ["last30days"],
            metrics: [],
            ...world.storedProvenance,
            ...(world.storedTables.length > 0
              ? { results: world.storedTables.map(toMeta) }
              : {}),
            ...(world.storedFollowUps.length > 0
              ? { followUps: world.storedFollowUps }
              : {}),
          }
        : null;
    return {
      id,
      role: turn.role,
      content: turn.content,
      createdAt: new Date(NOW.getTime() - (10 - index) * 60_000).toISOString(),
      metricSource,
      providerType: turn.role === "assistant" ? "anthropic" : null,
      promptVersion: null,
      tokensUsed: null,
      model: null,
    };
  });
  return {
    id: CONVERSATION_ID,
    title: "Dialog",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    messageCount: messages.length,
    attachmentCount: 0,
    summary: null,
    messages,
  };
}

/** The newest stored rows, newest first, as the dialog resolvers read them. */
function latestRows() {
  return storedConversation()
    .messages.map((m) => ({
      id: m.id,
      role: m.role,
      providerType: m.providerType,
      metricSourceJson: m.metricSource ? JSON.stringify(m.metricSource) : null,
      encryptedContent: Buffer.from(m.content),
    }))
    .reverse()
    .slice(0, 4);
}

// ── Mock surfaces ───────────────────────────────────────────────────────

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class AllProvidersFailedError extends Error {
  readonly attempts: Array<{ providerType: string; httpStatus: number | null }>;
  readonly primaryCredentialExpired = false;
  constructor(
    attempts: Array<{ providerType: string; httpStatus: number | null }>,
  ) {
    super("all providers failed");
    this.attempts = attempts;
  }
}

export const m = {
  requireAuth: vi.fn(),
  requireAiCapability: vi.fn(),
  checkRateLimit: vi.fn(),
  annotate: vi.fn(),
  auditLog: vi.fn(),
  appendMessage: vi.fn(),
  readDailySeries: vi.fn(),
  runStreaming: vi.fn(),
  reserveBudget: vi.fn(),
};

/** The scripted provider: answers the next round of `world.script`. */
async function runRawCompletionWithFallback(args: {
  params: {
    system: string;
    messages: Array<{ role: string; content: string }>;
    toolChoice?: string;
    cacheKey?: string;
  };
}) {
  const round = world.script.shift() ?? { text: "" };
  const calls = round.calls ?? [];
  providerCalls.push({
    system: args.params.system,
    messages: args.params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    toolChoice: args.params.toolChoice,
    cacheKey: args.params.cacheKey,
    toolCalls: calls,
  });
  const offered = args.params.toolChoice !== "none";
  return {
    result: {
      content: round.text ?? "",
      tokensUsed: 40,
      model: "scripted",
      ...(calls.length > 0 && offered
        ? {
            finishReason: "tool_calls" as const,
            toolCalls: calls.map((call, i) => ({
              id: `call-${providerCalls.length}-${i}`,
              name: call.name,
              arguments: JSON.stringify(call.args),
            })),
          }
        : { finishReason: "stop" as const }),
    },
    workingProvider: { providerType: "anthropic" },
    fallbackHops: [],
  };
}

function inventoryFor() {
  const sources = [...presentSources()];
  return {
    entries: world.inventory,
    restMode: false,
    cycleEnabled: false,
    window: "last30days",
    probeScope: { sources, window: "last30days" },
  };
}

function snapshotFor() {
  const sections: Record<string, unknown> = {
    scope: { sources: [...presentSources()] },
  };
  for (const source of presentSources()) {
    const key = COACH_SOURCE_SNAPSHOT_KEY[source] ?? source;
    sections[key] = { aggregate: { count: 30 } };
  }
  return {
    snapshotJson: JSON.stringify(sections),
    sections,
    provenance: { windows: ["last30days"], metrics: [...presentSources()] },
    referenceGrounding: null,
  };
}

/** One reading a day over `[from, to)` for a present type, from the first. */
function dailySeries(args: { type: string; from: Date; to: Date }) {
  if (!presentTypes().has(args.type)) return [];
  const rows = [];
  const start = new Date(
    Math.max(args.from.getTime(), FIRST_READING.getTime()),
  );
  start.setUTCHours(8, 0, 0, 0);
  for (let at = start; at < args.to; at = new Date(at.getTime() + 86_400_000)) {
    rows.push({
      type: args.type,
      value: LEVEL[args.type] ?? 50,
      measuredAt: at.toISOString(),
      count: 1,
    });
  }
  return rows;
}

/** `Measurement` bounds per present type, as the availability probe reads them. */
function measurementBounds(args: { where: { type: { in: string[] } } }) {
  return args.where.type.in
    .filter((type) => presentTypes().has(type))
    .map((type) => ({
      type,
      unit: "u",
      _count: { _all: 400 },
      _min: { measuredAt: FIRST_READING, value: LEVEL[type] ?? 50 },
      _max: { measuredAt: NOW, value: LEVEL[type] ?? 50 },
      _avg: { value: LEVEL[type] ?? 50 },
    }));
}

const EMPTY_AGGREGATE = {
  _count: { _all: 0 },
  _min: { date: null, startedAt: null, scheduledFor: null, takenAt: null },
  _max: { date: null, startedAt: null, scheduledFor: null, takenAt: null },
};

let messageSeq = 0;

/** Forget what the last turn recorded; the behaviour stays. */
export function clearCalls(): void {
  providerCalls.length = 0;
  for (const fn of Object.values(m)) fn.mockClear();
}

/** Restore every default and clear the recorded calls. */
export function resetDialog(): void {
  world.inventory = [];
  world.priorTurns = [];
  world.storedTables = [];
  world.storedFollowUps = [];
  world.storedProvenance = {};
  world.resultsWithheld = false;
  world.script = [];
  providerCalls.length = 0;
  messageSeq = 0;
  for (const fn of Object.values(m)) fn.mockReset();
  m.requireAuth.mockResolvedValue({ user: { id: "u1", locale: "en" } });
  m.requireAiCapability.mockResolvedValue({ available: true, reason: null });
  m.checkRateLimit.mockResolvedValue({ allowed: true, resetAt: 0 });
  m.appendMessage.mockImplementation(async () => {
    messageSeq += 1;
    return { id: `m-new-${messageSeq}` };
  });
  m.readDailySeries.mockImplementation(async (args) => dailySeries(args));
  m.runStreaming.mockRejectedValue(new Error("the no-tools path is not used"));
  m.reserveBudget.mockImplementation(async (_u: string, amount: number) => ({
    allowed: true,
    reserved: amount,
    owner: "user",
  }));
}

/** The module factories, keyed by module id. */
export const modules = {
  apiHandler: () => ({
    apiHandler: <T>(fn: T) => fn,
    requireAuth: m.requireAuth,
    HttpError,
  }),
  apiResponse: () => ({
    apiError: (error: string, status: number) =>
      new Response(JSON.stringify({ data: null, error }), { status }),
    apiSuccess: (data: unknown) =>
      new Response(JSON.stringify({ data, error: null }), { status: 200 }),
    apiValidationError: (error: string, issues: unknown, status: number) =>
      new Response(JSON.stringify({ data: null, error, details: { issues } }), {
        status,
      }),
    sanitiseZodIssues: (issues: Array<{ path: unknown; code: unknown }>) =>
      issues.map((i) => ({ path: i.path, code: i.code })),
  }),
  gate: () => ({
    isModuleEnabled: async () => true,
    resolveModuleMap: async () => ({}),
    MODULE_DISABLED_ERROR_CODE: "module.disabled",
  }),
  capabilities: () => ({ requireAiCapability: m.requireAiCapability }),
  logging: () => ({
    annotate: m.annotate,
    getEvent: () => ({ setError: () => undefined }),
  }),
  audit: () => ({ auditLog: m.auditLog }),
  db: () => ({
    prisma: {
      user: {
        findUnique: async () => ({
          coachPrefsJson: null,
          displayName: null,
          aiResponseTimeoutSeconds: null,
        }),
        update: async () => ({}),
      },
      coachConversation: {
        findFirst: async () => ({ id: CONVERSATION_ID }),
      },
      coachMessage: {
        findMany: async () => latestRows(),
        // v1.41 — the clarification brake's count of today's questions.
        count: async () => 0,
      },
      measurement: {
        groupBy: async (args: { where: { type: { in: string[] } } }) =>
          measurementBounds(args),
        findMany: async () => [],
      },
      moodEntry: {
        findMany: async () => [],
        aggregate: async () => EMPTY_AGGREGATE,
      },
      workout: { aggregate: async () => EMPTY_AGGREGATE },
      medicationIntakeEvent: { aggregate: async () => EMPTY_AGGREGATE },
      labResult: { aggregate: async () => EMPTY_AGGREGATE },
    },
  }),
  rateLimit: () => ({
    checkRateLimit: m.checkRateLimit,
    refundRateLimit: async () => {},
  }),
  serverLocale: () => ({
    resolveServerLocale: async (args: { override?: string }) =>
      args.override ?? "en",
  }),
  providerRunner: () => ({
    AllProvidersFailedError,
    runRawCompletionWithFallback,
    runStreamingRawCompletionWithFallback: m.runStreaming,
  }),
  provider: () => ({
    resolveProviderChain: async () => [
      { providerType: "anthropic", instance: { supportsTools: true } },
    ],
    resolveProvider: async () => ({ type: "none" }),
  }),
  consent: () => ({ assertConsentForChain: async () => undefined }),
  persistence: () => ({
    appendMessage: m.appendMessage,
    createConversation: async () => ({ id: "c-new" }),
    fetchConversationWithMessages: async () =>
      world.priorTurns.length > 0 ? storedConversation() : null,
    listConversations: async () => ({ conversations: [], nextCursor: null }),
    readMessageResults: async (
      _userId: string,
      _conversationId: string,
      messageId: string,
    ) => {
      if (messageId !== LAST_ASSISTANT_ID) return null;
      return world.resultsWithheld
        ? world.storedTables.map((t) => ({
            ref: t.ref,
            withheld: "module_disabled",
          }))
        : world.storedTables;
    },
  }),
  memory: () => ({ enqueueCoachMemoryRefresh: () => undefined }),
  facts: () => ({ storeDeterministicFacts: async () => undefined }),
  budget: () => ({
    buildDateKey: () => "2026-09-27",
    reserveBudget: m.reserveBudget,
    reconcileSpend: async () => undefined,
    resolveDailyCap: () => 2_000_000,
    resolveCostOwner: () => "user",
  }),
  aboutMe: () => ({ getSelfContextTextForUser: async () => null }),
  snapshot: () => ({ buildCoachSnapshot: async () => snapshotFor() }),
  scheduledDoses: () => ({ getScheduledDoseValues: async () => [] }),
  workoutEvidence: () => ({
    buildWorkoutEvidenceSection: async () => null,
  }),
  suggestGate: () => ({ gateSuggestion: async () => ({ surface: true }) }),
  glitchtipSettings: () => ({
    getGlitchtipSettings: async () => ({ glitchtipEnabled: false }),
  }),
  glitchtip: () => ({ sendGlitchtipEvent: async () => undefined }),
  timezone: () => ({ resolveUserTimezone: async () => "UTC" }),
  dailySeries: () => ({ readDailySeries: m.readDailySeries }),
  sourcePriority: () => ({ loadUserSourcePriority: async () => null }),
  buildInventory: async () => inventoryFor(),
  bytesCodec: () => ({
    decryptFromBytes: (bytes: Buffer) => Buffer.from(bytes).toString("utf8"),
    encryptToBytes: (text: string) => Buffer.from(text),
  }),
};

// ── Driving a turn ──────────────────────────────────────────────────────

export type Frame = { type: string } & Record<string, unknown>;

/** Split an SSE body into its data frames, heartbeats dropped. */
export function parseFrames(body: string): Frame[] {
  return body
    .split("\n\n")
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Frame);
}

export interface TurnRun {
  status: number;
  frames: Frame[];
  body: string;
}

export async function postTurn(
  post: (req: Request) => Promise<Response>,
  body: Record<string, unknown>,
): Promise<TurnRun> {
  const res = await post(
    new Request("http://localhost/api/insights/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const sse = res.headers.get("Content-Type")?.startsWith("text/event-stream");
  return {
    status: res.status,
    frames: sse ? parseFrames(text) : [],
    body: text,
  };
}

/** Frames of one type, in order. */
export function framesOf<T = Frame>(frames: Frame[], type: string): T[] {
  return frames.filter((f) => f.type === type) as unknown as T[];
}
