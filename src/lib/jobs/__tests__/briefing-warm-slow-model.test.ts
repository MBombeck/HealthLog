/**
 * #1274 — the out-of-band briefing warm against a local model that needs
 * 300 s per answer, with the response timeout at 600 s.
 *
 * The warm is what the Insights page relies on: the page's read serves the
 * cache and enqueues it, and the regenerate is only the explicit button. Its
 * outer abort was sized as one model call plus headroom, while one
 * comprehensive generation makes up to four calls one after another: the
 * generation (asked once more inside the client when a thinking model answered
 * with reasoning alone), the JSON retry and the grounding retry. Every single
 * call honoured the 600 s; three 300 s answers in a row did not fit the 630 s
 * the warm allowed, and the briefing was dropped.
 *
 * Driven end to end: the real forced warm, its real outer abort, the real
 * comprehensive generator with its retries, the real budgeted chain runner,
 * the real Local client with the setting bound by `bindResponseTimeout`, the
 * real `safeFetch` and pinned dispatcher, and a real HTTP server on loopback
 * that answers each request after 300 s. Time is fake for the timers the warm
 * and the server use and real for the sockets; the database, the feature read
 * and the capability gates are stand-ins.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
const chain = vi.hoisted(() => ({ current: [] as ProviderChainResolved[] }));

const prismaMock = vi.hoisted(() => ({
  $queryRaw: vi.fn(async () => [{ total_tokens: 0, operator_tokens: 0 }]),
  $executeRaw: vi.fn(async () => 0),
  user: {
    findUnique: (...a: unknown[]) => findUnique(...a),
    update: vi.fn(async () => ({})),
    updateMany: (...a: unknown[]) => updateMany(...a),
  },
  auditLog: {
    create: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  },
}));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/ai/capabilities/gate", () => {
  const available = async () => ({
    available: true,
    reason: null,
    onDeviceAllowed: true,
  });
  return {
    aiCapabilityForJob: available,
    aiCapabilityForRecord: available,
    aiCapabilityToServe: available,
  };
});
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain: vi.fn(async () => chain.current),
  resolveProvider: vi.fn(async () => ({ type: "none" })),
}));
vi.mock("@/lib/ai/provider-health-ledger", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai/provider-health-ledger")
  >("@/lib/ai/provider-health-ledger");
  return {
    ...actual,
    postgresProviderHealthLedger: {
      async getSkipHints() {
        return new Map();
      },
      async recordSuccess() {},
      async recordFailure() {},
    },
  };
});
vi.mock("@/lib/insights/features", () => ({
  FeaturesPayloadTooLargeError: class extends Error {
    sizeBytes = 0;
  },
  extractFeatures: vi.fn(async () => FEATURES),
  BRIEFING_FEATURE_WINDOW_DAYS: 400,
}));
vi.mock("@/lib/insights/illness-cycle-briefing", () => ({
  buildBriefingIllnessCycleContext: vi.fn().mockResolvedValue(null),
  buildBriefingIllnessCyclePrompt: vi.fn().mockReturnValue(""),
}));
vi.mock("@/lib/insights/glp1-plateau", () => ({
  detectGlp1Plateau: vi.fn(async () => null),
  buildGlp1PlateauPrompt: vi.fn(() => ""),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
  buildAboutMeInsightBlock: vi.fn(() => ""),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserInsights: vi.fn(),
}));

import { bindResponseTimeout } from "@/lib/ai/effective-timeout";
import {
  LocalOpenAICompatibleClient,
  resetLocalJsonDialectCache,
} from "@/lib/ai/local-client";
import { clearLastWorkingProviderCache } from "@/lib/ai/provider-runner";
import { resetReasoningDialectCache } from "@/lib/ai/reasoning/dialect-cache";
import { openInsightsCachedText } from "@/lib/insights/cached-text-cipher";
import { _resetPinnedDispatcherForTests } from "@/lib/safe-fetch-dispatcher";
import { NextRequest } from "next/server";
import { withFeatureCacheScope } from "@/lib/insights/feature-cache";
import { loadGenerationContext } from "@/lib/insights/briefing-request/context";
import { generateBriefing } from "@/lib/insights/briefing-request/generate";
import { forceWarmUser } from "../insight-pregenerate";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ProviderChainResolved } from "@/lib/ai/provider-runner";

type CacheColumns = Parameters<typeof openInsightsCachedText>[0];
const warmPrisma = prismaMock as unknown as PrismaClient;

vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));

/** A signals block, so the grounding gate engages, and a medications block. */
const FEATURES = {
  signalsOfDay: [
    {
      sourceMetric: "weight",
      latest: 81.4,
      avg7: 82,
      avg30: 82.1,
      deltaVs7: -0.6,
      deltaVs30: -0.7,
      spread30: 1.2,
      recentAnomaly: null,
    },
  ],
  medications: [
    {
      name: "Ramipril",
      dose: "5 mg",
      category: "cardio",
      compliance7: 100,
      compliance30: 86,
      compliance90: 88,
      streak: 12,
      missedLast7: 0,
    },
  ],
};

/** A local model's first answer that is prose around the JSON, not JSON. */
const PROSE = "Here is your briefing: the week looked steady overall.";
/** Valid JSON quoting a figure the server never computed. */
const UNGROUNDED = JSON.stringify({
  dailyBriefing: { paragraph: "Your weight is down 47.9 kg this week." },
});
/** Valid JSON citing a figure the server computed. */
const GROUNDED = JSON.stringify({
  dailyBriefing: { paragraph: "Adherence sits at 86 % over the last 30 days." },
});

/** What the model takes for every answer, and the person's setting. */
const ANSWER_MS = 300_000;
const RESPONSE_TIMEOUT_SECONDS = 600;
/** Fake time advanced per step of the drive loop. */
const STEP_MS = 1_000;

const realSetTimeout = globalThis.setTimeout;
let server: http.Server;
let origin: string;
let replies: string[] = [];
let answered = 0;

function envelope(content: string) {
  return {
    id: "chatcmpl-1274",
    object: "chat.completion",
    created: 1_760_000_000,
    model: "slow-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5200, completion_tokens: 600, total_tokens: 5800 },
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const content = replies.shift() ?? GROUNDED;
      // A non-streamed answer: nothing, not even the headers, until it is done.
      setTimeout(() => {
        answered += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(envelope(content)));
      }, ANSWER_MS);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  _resetPinnedDispatcherForTests();
  await new Promise<void>((r) => server.close(() => r()));
});

const savedOrigins = process.env.AI_PRIVATE_ORIGINS;

beforeEach(() => {
  process.env.AI_PRIVATE_ORIGINS = origin;
  replies = [];
  answered = 0;
  findUnique.mockReset();
  findUnique.mockResolvedValue({
    id: "u1",
    locale: "de",
    timezone: "Europe/Berlin",
    insightsPrivacyMode: "aggregated",
    insightsCachedAt: null,
    insightsCachedTextEncrypted: null,
    insightsCachedLocale: null,
    insightsExcludeMetrics: [],
    insightsSnapshotHash: null,
    insightsBriefingRerollDate: null,
    insightsWarmFailedAt: null,
    aiResponseTimeoutSeconds: RESPONSE_TIMEOUT_SECONDS,
  });
  updateMany.mockReset();
  updateMany.mockResolvedValue({ count: 1 });
  clearLastWorkingProviderCache();
  resetLocalJsonDialectCache();
  resetReasoningDialectCache();
  const client = new LocalOpenAICompatibleClient({
    baseUrl: `${origin}/v1`,
    model: "slow-model",
  });
  chain.current = [
    {
      providerType: "local",
      instance: bindResponseTimeout(client, RESPONSE_TIMEOUT_SECONDS),
    },
  ];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  // A warm cut short leaves its request open on the server; drop it.
  server.closeAllConnections();
  if (savedOrigins === undefined) delete process.env.AI_PRIVATE_ORIGINS;
  else process.env.AI_PRIVATE_ORIGINS = savedOrigins;
});

/**
 * Run `work` to completion, advancing fake time a step at a time and giving
 * the sockets a real moment between steps. Returns the fake time it took.
 */
async function drive<T>(
  work: Promise<T>,
  limitMs: number,
): Promise<{ value: T; elapsedMs: number }> {
  let settled = false;
  let value: T | undefined;
  let failure: unknown = null;
  work.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e: unknown) => {
      settled = true;
      failure = e;
    },
  );
  let elapsedMs = 0;
  while (!settled && elapsedMs <= limitMs) {
    await new Promise((r) => realSetTimeout(r, 1));
    await vi.advanceTimersByTimeAsync(STEP_MS);
    elapsedMs += STEP_MS;
  }
  if (failure) throw failure;
  expect(settled, `still running after ${limitMs} ms`).toBe(true);
  return { value: value as T, elapsedMs };
}

/** The briefing paragraph the warm committed, if it committed one. */
function committedParagraph(): string | null {
  const writes = updateMany.mock.calls
    .map((c) => openInsightsCachedText((c[0] as { data: CacheColumns }).data))
    .filter((t): t is string => t !== null);
  const last = writes.at(-1);
  if (!last) return null;
  const parsed = JSON.parse(last) as {
    dailyBriefing?: { paragraph?: string };
  };
  return parsed.dailyBriefing?.paragraph ?? null;
}

describe("briefing warm against a model that needs 300 s per answer (600 s setting)", () => {
  it("commits a briefing that takes one answer", async () => {
    replies = [GROUNDED];
    const { value, elapsedMs } = await drive(
      forceWarmUser(warmPrisma, "u1", "de", { today: true }),
      30 * 60_000,
    );
    expect(value.comprehensive).toBe("generated");
    expect(answered).toBe(1);
    expect(elapsedMs).toBeGreaterThanOrEqual(ANSWER_MS);
    expect(committedParagraph()).toMatch(/86 %/);
  });

  it("commits a briefing that needs the JSON retry and the grounding retry", async () => {
    // Prose first (JSON retry), then an invented figure (grounding retry),
    // then a grounded answer: three answers, 900 s, each well inside 600 s.
    replies = [PROSE, UNGROUNDED, GROUNDED];
    const { value, elapsedMs } = await drive(
      forceWarmUser(warmPrisma, "u1", "de", { today: true }),
      60 * 60_000,
    );
    expect(value.comprehensive).toBe("generated");
    expect(answered).toBe(3);
    expect(elapsedMs).toBeGreaterThanOrEqual(3 * ANSWER_MS);
    expect(committedParagraph()).toMatch(/86 %/);
  });
});

describe("the regenerate's server half against the same model", () => {
  it("answers the POST with the briefing after the generation and its grounding retry", async () => {
    // The route generates inline with no deadline of its own; the browser
    // waits `forceAdvisorTimeoutMs` (three calls at the setting, plus 30 s).
    replies = [UNGROUNDED, GROUNDED];
    const work = withFeatureCacheScope(async () => {
      const ctx = await loadGenerationContext({
        request: new NextRequest("http://localhost/api/insights/generate", {
          method: "POST",
        }),
        userId: "u1",
        userLocale: "de",
      });
      return generateBriefing({
        ctx,
        chain: chain.current,
        ipAddress: null,
      });
    });
    const { value, elapsedMs } = await drive(work, 30 * 60_000);
    expect(value.ok).toBe(true);
    expect(answered).toBe(2);
    expect(elapsedMs).toBeGreaterThanOrEqual(2 * ANSWER_MS);
    expect(committedParagraph()).toMatch(/86 %/);
  });
});
