/**
 * #1279 — one simulated hour against an OpenAI-compatible gateway whose model
 * answers every request with reasoning and no answer, cut off at the token
 * ceiling (`finish_reason: "length"`), as gpt-oss behind vLLM did with the
 * gateway's Reasoning left at Default and nobody using the app.
 *
 * What runs for real: the sync-driven re-selection of status cards
 * (`invalidateStatusInsightsForTypes`), the production enqueue with its
 * queue name, singleton key and send options (`enqueueStatusGeneration`),
 * the queue's consumer (`runInsightStatusGenerate`), the card's single-call
 * path and fallback (`runPreparedStatusCard`, `returnTimeoutFallback`), the
 * status chokepoint (`runStatusCompletion`), the chain walker with the
 * health ledger's in-memory twin, the gateway client and its reasoning
 * lessons, and the note store's negative windows over an in-memory table.
 * What is faked: the wire (`safeFetch` answers like the gateway and moves
 * the clock by the model's latency), pg-boss (a queue that honours the
 * singleton key, the exclusive policy and the retry options a send names),
 * the clock, and the reads that would need Postgres for anything else.
 *
 * A data sync dirties five cards every minute. Before the fix, every sync
 * re-selected every card whose last generation had failed, and each job
 * reached the model: run against that code, this hour counted 151 requests,
 * 150 of them sent with `none`, none of them charged to the day's ledger.
 * The second case also loses the reasoning lesson between jobs, which is
 * what the reported log shows (two requests behind every answerless line):
 * 300 requests before the fix. The bound has to hold without the lesson.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InsightStatusGeneratePayload } from "@/lib/jobs/insight-status-generate-shared";

// ── The clock and the wire ───────────────────────────────────────────────────

const wire = vi.hoisted(() => ({
  requests: [] as Array<{ effort: unknown; maxTokens: unknown }>,
  latencyMs: 2600,
}));

vi.mock("@/lib/safe-fetch", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/safe-fetch")>()),
  safeFetch: async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    wire.requests.push({
      effort: body.reasoning_effort,
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
    });
    vi.setSystemTime(Date.now() + wire.latencyMs);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1279",
        object: "chat.completion",
        model: "gpt-oss-120b",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "We need to look at the readings. ".repeat(30),
            },
            finish_reason: "length",
          },
        ],
        usage: {
          prompt_tokens: 2470,
          completion_tokens: 300,
          total_tokens: 2770,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
}));

// ── pg-boss, as far as these sends use it ────────────────────────────────────

interface QueuedJob {
  data: InsightStatusGeneratePayload;
  key: string | null;
  runAt: number;
  retriesLeft: number;
  retryDelayS: number;
  backoff: boolean;
  attempt: number;
}

const boss = vi.hoisted(() => ({
  jobs: [] as QueuedJob[],
  sends: 0,
  /** The last time each singleton key was sent, for `singletonSeconds`. */
  slots: new Map<string, number>(),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({
    async send(
      _queue: string,
      data: InsightStatusGeneratePayload,
      opts: Record<string, unknown> = {},
    ) {
      boss.sends += 1;
      const key =
        typeof opts.singletonKey === "string" ? opts.singletonKey : null;
      const now = Date.now();
      if (key) {
        // The queue's exclusive policy: one queued or running job per key.
        if (boss.jobs.some((j) => j.key === key)) return null;
        const window = Number(opts.singletonSeconds ?? 0) * 1000;
        const last = boss.slots.get(key);
        if (last !== undefined && now - last < window) return null;
        boss.slots.set(key, now);
      }
      boss.jobs.push({
        data,
        key,
        runAt: now + Number(opts.startAfter ?? 0) * 1000,
        retriesLeft: Number(opts.retryLimit ?? 2),
        retryDelayS: Number(opts.retryDelay ?? 0),
        backoff: opts.retryBackoff === true,
        attempt: 0,
      });
      return "job-id";
    },
  }),
}));

// ── The note store and the reads around it ───────────────────────────────────

interface NoteRow {
  userId: string;
  metric: string;
  locale: string;
  dateKey: string;
  textEncrypted: Uint8Array | null;
  generatedAt: Date | null;
  retryAt: Date | null;
  negativeReason: string | null;
  failureStreak: number;
}

const store = vi.hoisted(() => ({ notes: new Map<string, NoteRow>() }));

function noteKey(w: { userId: string; metric: string; locale: string }) {
  return `${w.userId}|${w.metric}|${w.locale}`;
}

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        locale: "en",
        timezone: "UTC",
        aiResponseTimeoutSeconds: null,
      }),
    },
    insightStatusCache: {
      findUnique: async (args: {
        where: {
          userId_metric_locale: {
            userId: string;
            metric: string;
            locale: string;
          };
        };
      }) => store.notes.get(noteKey(args.where.userId_metric_locale)) ?? null,
      upsert: async (args: {
        where: {
          userId_metric_locale: {
            userId: string;
            metric: string;
            locale: string;
          };
        };
        create: Partial<NoteRow>;
        update: Partial<NoteRow>;
      }) => {
        const k = noteKey(args.where.userId_metric_locale);
        const prev = store.notes.get(k);
        const next = prev
          ? { ...prev, ...args.update }
          : ({
              textEncrypted: null,
              generatedAt: null,
              retryAt: null,
              negativeReason: null,
              failureStreak: 0,
              ...args.create,
            } as NoteRow);
        store.notes.set(k, next);
        return next;
      },
      findMany: async (args: {
        where: {
          userId: string;
          OR: Array<{ metric: string; locale: string }>;
          generatedAt?: { gte: Date };
          textEncrypted?: { not: null };
          retryAt?: { gt: Date };
        };
      }) =>
        args.where.OR.flatMap((key) => {
          const row = store.notes.get(
            noteKey({ userId: args.where.userId, ...key }),
          );
          if (!row) return [];
          const w = args.where;
          if (
            w.generatedAt &&
            !(row.generatedAt && row.generatedAt >= w.generatedAt.gte)
          ) {
            return [];
          }
          if (w.textEncrypted && row.textEncrypted === null) return [];
          if (w.retryAt && !(row.retryAt && row.retryAt > w.retryAt.gt))
            return [];
          return [{ metric: row.metric, locale: row.locale }];
        }),
      updateMany: async () => ({ count: 0 }),
    },
  },
}));

// The day's token ledger: every reservation allowed, the charge recorded.
const ledger = vi.hoisted(() => ({ charged: 0 }));
vi.mock("@/lib/ai/coach/budget", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/ai/coach/budget")>()),
  buildDateKey: async () => "2026-10-24",
  reserveBudget: async (_u: string, estimated: number) => ({
    allowed: true,
    reserved: estimated,
    owner: "user",
    limit: null,
    totalAfter: 0,
    operatorAfter: 0,
  }),
  reconcileSpend: async (_u: string, _reserved: number, actual: number) => {
    ledger.charged += actual;
  },
}));

// The chain's durable health ledger, as its in-memory twin, fresh per case.
const health = vi.hoisted(() => ({
  current: null as null | {
    getSkipHints(userId: string): Promise<Map<string, unknown>>;
    recordSuccess(userId: string, type: string): Promise<void>;
    recordFailure(
      userId: string,
      type: string,
      status: number | null,
    ): Promise<void>;
  },
}));
vi.mock("@/lib/ai/provider-health-ledger", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/ai/provider-health-ledger")>();
  return {
    ...actual,
    postgresProviderHealthLedger: {
      getSkipHints: (u: string) => health.current!.getSkipHints(u),
      recordSuccess: (u: string, t: string) =>
        health.current!.recordSuccess(u, t),
      recordFailure: (u: string, t: string, s: number | null) =>
        health.current!.recordFailure(u, t, s),
    },
  };
});

// The one chain entry: the gateway, as the settings build it.
vi.mock("@/lib/ai/provider", async () => {
  const { OpenAIClient } = await import("@/lib/ai/openai-client");
  const gateway = new OpenAIClient({
    apiKey: "",
    model: "gpt-oss-120b",
    baseUrl: "https://gateway.example/v1",
    providerType: "openai-compatible",
  });
  return {
    resolveProviderChain: async () => [
      { providerType: "openai-compatible", instance: gateway },
    ],
    resolveProvider: async () => ({ type: "none" }),
    probeProviderPresence: async () => true,
  };
});

const AVAILABLE = { available: true, reason: null, onDeviceAllowed: true };
vi.mock("@/lib/ai/capabilities/gate", () => ({
  aiCapabilityForRecord: async () => AVAILABLE,
  aiCapabilityForJob: async () => AVAILABLE,
  aiCapabilityToServe: async () => AVAILABLE,
}));
vi.mock("@/lib/ai/capabilities/egress", () => ({
  aiEgressRefusal: async () => null,
}));
vi.mock("@/lib/ai/capabilities/usage", () => ({
  loadRecordAiUsage: async () => ({
    level: "standard",
    settings: { syncRegenGapHours: 6 },
  }),
}));
vi.mock("@/lib/sharing/provider-work-authority", () => ({
  providerWorkAuthorityForRecord: () => ({ origin: "owner" }),
  mayEnqueueProviderWork: () => true,
  mayDispatchProviderWork: async () => true,
  withProviderWorkAuthority: async (_a: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));

const signals = vi.hoisted(() => [] as Array<{ action: string }>);
vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (s: { action: string }) => signals.push(s),
  logCaught: () => undefined,
  caughtAs: () => undefined,
}));

import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import {
  runInsightStatusGenerate,
  type InsightStatusMetric,
} from "@/lib/jobs/insight-status-generate";
import { runPreparedStatusCard } from "@/lib/insights/status-card-generation";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { statusCacheAction } from "@/lib/insights/status-cache";
import { resetReasoningDialectCache } from "@/lib/ai/reasoning/dialect-cache";
import { clearLastWorkingProviderCache } from "@/lib/ai/provider-runner";
import { createInMemoryProviderHealthLedger } from "@/lib/ai/provider-health-ledger";

const USER = "self-hoster";
const HOUR_MS = 60 * 60 * 1000;
const SYNC_EVERY_MS = 60 * 1000;
/** A watch drip: weight, blood pressure and pulse dirty five cards. */
const SYNC_TYPES = ["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"] as const;

/** A card generator as the worker runs it: one status call, its fallback. */
function cardGenerator(scope: InsightStatusMetric) {
  return async (userId: string, options: { locale: string }) => {
    const cacheAction = statusCacheAction(scope, options.locale);
    return runPreparedStatusCard({
      phase: "pending",
      metric: scope,
      userId,
      cacheAction,
      systemPrompt: "You write the status note.",
      userPrompt: `Snapshot for ${scope}: …`,
      temperature: 0.45,
      noProvider: { hasProvider: false, cached: true, updatedAt: null },
      finalize: async () => ({
        hasProvider: true,
        cached: false,
        updatedAt: null,
      }),
      timeout: (reason) =>
        returnTimeoutFallback({
          cacheAction,
          reason,
          stubText: "Deterministic line.",
          userId,
          todayKey: "2026-10-24",
        }),
    });
  };
}

const GENERATORS: Parameters<typeof runInsightStatusGenerate>[1] = {
  general: cardGenerator("general"),
  "blood-pressure": cardGenerator("blood-pressure"),
  weight: cardGenerator("weight"),
  pulse: cardGenerator("pulse"),
  bmi: cardGenerator("bmi"),
  mood: cardGenerator("mood"),
  "medication-compliance": cardGenerator("medication-compliance"),
};

/** Let fire-and-forget writes (the negative stub) land. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/**
 * Run the worker for one simulated hour: a sync every minute, the queue
 * drained one job at a time as soon as a job is due.
 */
async function simulateHour(opts: { loseLessonBetweenJobs: boolean }) {
  const end = Date.now() + HOUR_MS;
  let nextSync = Date.now();
  let jobsRun = 0;
  let syncs = 0;
  while (Date.now() < end) {
    if (Date.now() >= nextSync) {
      syncs += 1;
      await invalidateStatusInsightsForTypes(USER, SYNC_TYPES, {
        source: "sync",
      });
      await settle();
      nextSync += SYNC_EVERY_MS;
    }
    const due = boss.jobs
      .filter((j) => j.runAt <= Date.now())
      .sort((a, b) => a.runAt - b.runAt)[0];
    if (!due) {
      const nextJob = Math.min(...boss.jobs.map((j) => j.runAt), Infinity);
      vi.setSystemTime(Math.min(nextSync, nextJob, end));
      continue;
    }
    jobsRun += 1;
    try {
      await runInsightStatusGenerate(due.data, GENERATORS);
      boss.jobs.splice(boss.jobs.indexOf(due), 1);
    } catch {
      if (due.retriesLeft > 0) {
        due.retriesLeft -= 1;
        due.attempt += 1;
        const delay =
          due.retryDelayS * (due.backoff ? 2 ** (due.attempt - 1) : 1);
        due.runAt = Date.now() + delay * 1000;
      } else {
        boss.jobs.splice(boss.jobs.indexOf(due), 1);
      }
    }
    await settle();
    if (opts.loseLessonBetweenJobs) resetReasoningDialectCache();
    vi.setSystemTime(Date.now() + 100);
  }
  return { jobsRun, syncs };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T15:40:00.000Z"));
  wire.requests = [];
  boss.jobs = [];
  boss.sends = 0;
  boss.slots.clear();
  store.notes.clear();
  ledger.charged = 0;
  signals.length = 0;
  resetReasoningDialectCache();
  clearLastWorkingProviderCache();
  health.current = createInMemoryProviderHealthLedger();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("#1279: an hour of background status work against a model that never answers", () => {
  it("sends a handful of requests, not hundreds", async () => {
    const { jobsRun, syncs } = await simulateHour({
      loseLessonBetweenJobs: false,
    });

    // A sync every minute kept dirtying the five cards …
    expect(syncs).toBe(60);
    expect(jobsRun).toBeGreaterThan(0);
    // … but the model was asked a bounded number of times.
    expect(wire.requests.length).toBeLessThanOrEqual(10);
    // `none` went out once, as the one repeat, and never again.
    expect(wire.requests.filter((r) => r.effort === "none")).toHaveLength(1);
    // And what those requests cost reached the day's ledger.
    expect(ledger.charged).toBe(wire.requests.length * 2770);
  });

  it("stays bounded when the lesson does not survive from one job to the next", async () => {
    await simulateHour({ loseLessonBetweenJobs: true });
    expect(wire.requests.length).toBeLessThanOrEqual(14);
  });

  it("says once that background work paused, not once per job", async () => {
    await simulateHour({ loseLessonBetweenJobs: false });
    const paused = signals.filter(
      (s) => s.action === "ai.chain.background_paused",
    );
    expect(paused.length).toBeGreaterThanOrEqual(1);
    expect(paused.length).toBeLessThanOrEqual(4);
    expect(
      signals.filter((s) => s.action === "ai.gateway.reasoning_answerless"),
    ).toHaveLength(1);
  });
});
