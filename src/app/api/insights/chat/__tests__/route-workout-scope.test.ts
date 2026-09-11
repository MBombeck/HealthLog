import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * v1.31.0 — the workout-scoped launch (`?workout=` / the detail page's
 * "Ask why").
 *
 * Three contracts are pinned here, in order of how much they would cost if
 * they broke:
 *
 *  1. SNAPSHOT-ONCE. The workout evidence is read and pinned on the FIRST turn
 *     only. If a later turn rebuilt it, per-turn work would grow with the
 *     conversation — which is exactly the cost the snapshot-once design
 *     removed. The multi-turn case asserts the workout read fires exactly once
 *     across a conversation that keeps sending the id.
 *  2. TENANCY. The row is narrowed by `{ id, userId }`. Another user's workout
 *     id therefore resolves to nothing, and the conversation proceeds on the
 *     standard snapshot rather than leaking a foreign session's numbers.
 *  3. The evidence rides INSIDE the fenced snapshot payload, so it inherits the
 *     data/instruction contract the fence states.
 *
 * Mock scaffold mirrors route-snapshot-once.test.ts so `../route` imports
 * cleanly.
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

const { isModuleEnabled } = vi.hoisted(() => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  isModuleEnabled,
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

/**
 * The workout row belongs to `u1`. The mock enforces the tenancy narrow the
 * way Postgres would: a `where` naming a different `userId` finds nothing.
 */
const { workoutFindFirst } = vi.hoisted(() => ({
  workoutFindFirst: vi.fn(
    async ({ where }: { where: { id: string; userId: string } }) =>
      where.id === "w1" && where.userId === "u1"
        ? {
            sportType: "running",
            source: "APPLE_HEALTH",
            startedAt: new Date("2026-07-01T06:00:00Z"),
            endedAt: new Date("2026-07-01T06:40:00Z"),
            durationSec: 2400,
            totalEnergyKcal: 410,
            totalDistanceM: 7200,
            avgHeartRate: 148,
            maxHeartRate: 171,
            minHeartRate: 96,
            stepCount: 6800,
            elevationM: 62,
            pauseDurationSec: 0,
            metadata: { device_bundle_id: "com.example.watch" },
            samples: { samples: null },
          }
        : null,
  ),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        coachPrefsJson: null,
        sourcePriorityJson: null,
        dateOfBirth: null,
      })),
    },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
    workout: { findFirst: workoutFindFirst },
  },
}));

vi.mock("@/lib/workouts/hr-series", () => ({
  buildWorkoutHrSeries: vi.fn(async () => ({
    source: "workout_series",
    bucketSec: 60,
    envelope: true,
    points: [
      { tSec: 0, mean: 120, min: 110, max: 130 },
      { tSec: 60, mean: 150, min: 140, max: 171 },
      { tSec: 120, mean: 155, min: 148, max: 160 },
      { tSec: 180, mean: 132, min: 125, max: 140 },
    ],
  })),
}));
vi.mock("@/lib/workouts/zones", () => ({
  computeZones: vi.fn(() => ({
    model: "tanaka",
    hrMax: 185,
    zones: [{ zone: 3, lowBpm: 130, highBpm: 148, seconds: 900 }],
  })),
  hrMaxFromAge: vi.fn(() => 185),
  parseWhoopZoneDurations: vi.fn(() => null),
}));
vi.mock("@/lib/workouts/sport-context", () => ({
  buildSportContext: vi.fn(async () => ({
    count: 14,
    avgDurationSec: 2100,
    avgDistanceM: 6400,
    avgAvgHr: 151,
  })),
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
  // Pin a no-tools provider so the legacy snapshot-stuffing path runs — that
  // is the path the workout section rides.
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
  buildDateKey: vi.fn(() => "2026-07-19"),
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 1500 })),
  reconcileSpend: vi.fn(async () => undefined),
  resolveDailyCap: vi.fn(() => 2_000_000),
  resolveDailyCapFor: vi.fn(() => 2_000_000),
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
    prose: "That run sat above your usual pace.",
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  })),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({
  parseSuggestReminder: vi.fn(() => ({
    prose: "That run sat above your usual pace.",
  })),
}));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));

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

async function postAndDrain(body: Record<string, unknown>): Promise<void> {
  await post(chatReq(body));
  await sse.done;
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

/** Drive one turn against a conversation that already has `n` turns on disk. */
function withPriorTurns(n: number): void {
  fetchConversationWithMessages.mockResolvedValue(
    n === 0
      ? null
      : {
          id: "c1",
          summary: null,
          messages: Array.from({ length: n }, (_, i) => ({
            role: i % 2 === 0 ? "user" : "assistant",
            content: `turn ${i}`,
          })),
        },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runStreamingRawCompletionWithFallback.mockResolvedValue({
    result: {
      content: "That run sat above your usual pace.",
      tokensUsed: 42,
      model: "m",
    },
    workingProvider: { providerType: "admin-openai" },
  });
  isModuleEnabled.mockResolvedValue(true);
});

describe("coach chat — workout scope, first turn", () => {
  it("does not read workout evidence when the workouts module is disabled", async () => {
    isModuleEnabled.mockResolvedValueOnce(false);
    withPriorTurns(0);
    await postAndDrain({ message: "Why was that hard?", workoutId: "w1" });

    expect(workoutFindFirst).not.toHaveBeenCalled();
    expect(lastUserPrompt()).not.toContain("thisWorkout");
  });

  it("pins the workout's own numbers as a snapshot section", async () => {
    withPriorTurns(0);
    await postAndDrain({ message: "Why was that hard?", workoutId: "w1" });

    const prompt = lastUserPrompt();
    expect(prompt).toContain("thisWorkout");
    // Figures from the row itself …
    expect(prompt).toContain("2400");
    expect(prompt).toContain("7200");
    // … the own-history comparison …
    expect(prompt).toContain("2100");
    // … and the derived HR shape (peak 171 at t=60).
    expect(prompt).toContain("171");
  });

  it("keeps the section inside the health-data fence", async () => {
    withPriorTurns(0);
    await postAndDrain({ message: "Why was that hard?", workoutId: "w1" });

    const prompt = lastUserPrompt();
    const fenceStart = prompt.indexOf("<<<HEALTH_DATA_START>>>");
    const fenceEnd = prompt.lastIndexOf("<<<HEALTH_DATA_END>>>");
    const at = prompt.indexOf("thisWorkout");
    expect(fenceStart).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(fenceStart);
    expect(at).toBeLessThan(fenceEnd);
  });

  it("never leaks the row's free-text metadata into the prompt", async () => {
    withPriorTurns(0);
    await postAndDrain({ message: "Why was that hard?", workoutId: "w1" });

    // `metadata` is read only for numeric zone durations; its free-text
    // leaves must not reach the model.
    expect(lastUserPrompt()).not.toContain("com.example.watch");
  });
});

describe("coach chat — workout scope, tenancy", () => {
  it("finds nothing for another user's workout and proceeds unscoped", async () => {
    withPriorTurns(0);
    await postAndDrain({
      message: "Why was that hard?",
      workoutId: "someone-else",
    });

    // The narrow named the session's own user, so the foreign id missed.
    expect(workoutFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u1" }),
      }),
    );
    const prompt = lastUserPrompt();
    expect(prompt).not.toContain("thisWorkout");
    // The conversation still runs — a miss degrades, it does not fail.
    expect(prompt).toContain(SNAPSHOT_JSON);
  });

  it("always names userId in the where clause", async () => {
    withPriorTurns(0);
    await postAndDrain({ message: "Why?", workoutId: "w1" });

    for (const call of workoutFindFirst.mock.calls) {
      const arg = call[0] as { where: Record<string, unknown> };
      expect(arg.where.userId).toBe("u1");
    }
  });
});

describe("coach chat — workout scope preserves snapshot-once", () => {
  it("does NOT read the workout again on a follow-up turn", async () => {
    withPriorTurns(2);
    await postAndDrain({
      conversationId: "c1",
      message: "And my pace?",
      workoutId: "w1",
    });

    // The evidence was pinned on turn 1; re-reading it here would be per-turn
    // work that grows with the conversation.
    expect(workoutFindFirst).not.toHaveBeenCalled();
    expect(lastUserPrompt()).not.toContain("thisWorkout");
  });

  it("reads the workout exactly once across a ten-turn conversation", async () => {
    // Turn 1 creates the thread; every later turn keeps sending the id (a
    // client that never drops it is the adversarial case for this invariant).
    withPriorTurns(0);
    await postAndDrain({ message: "Why was that hard?", workoutId: "w1" });

    for (let prior = 2; prior <= 18; prior += 2) {
      withPriorTurns(prior);
      await postAndDrain({
        conversationId: "c1",
        message: "and?",
        workoutId: "w1",
      });
    }

    expect(workoutFindFirst).toHaveBeenCalledTimes(1);
  });
});
