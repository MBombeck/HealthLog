/**
 * Parity for `GET` and `POST /api/insights/generate` while the briefing read
 * and generation move out of the route into `src/lib/insights/`.
 *
 * One account with a full record (see `record-fixture.ts`) and its own
 * Anthropic key walks through every case the two handlers tell apart. Each
 * case starts from a known briefing state (`resetBriefing`): the cached
 * payload, its stamp and language, the failure markers, the day's token
 * ledger and the hourly generation quota are written for that case alone.
 *
 * The read: refusals, an empty cache, a fresh, a stale, an other-language,
 * an unparseable and a legacy cache, a held failure and a withheld
 * (ungrounded) briefing. The generation: the cache short-circuit and its
 * bypasses, the body cap, the hourly quota with and without the cached
 * fallback, a chain that resolves to nothing, the three rungs of the payload
 * downgrade ladder, the day's token ceiling, every provider failure class
 * the route maps, invalid and truncated replies, the grounding gate (retry
 * kept, previous briefing stood in, stripped, retry unparseable), the
 * outbound screen, both scope races, and successes in two languages, one
 * with the comparison snapshot, an about-me block and the short form.
 *
 * The provider is never called: `runRawCompletionWithFallback` is replaced
 * by a script each case fills, and every call it receives is recorded (the
 * chain, the parameters, and a digest of the prompt). The queue enqueues and
 * the failure markers the route does not await are recorded too; the markers
 * are also written, and waited for before the snapshot.
 *
 * The clock is pinned (`Date` only) to noon of the day the test runs, and
 * every instant and day key in the snapshot is written relative to the start
 * of the day. The record's measurements on the 7th, 30th and 60th day back
 * are removed, so a window cut in SQL against the database clock never meets
 * a reading on its edge. Two values change from one day to the next by
 * design and are normalised here: the opener hint and the first-name line of
 * the briefing prompt rotate per user and day, and the stored snapshot hash
 * covers dated features, so it is recorded as the hash of the same input
 * with its dates written relative to the anchor.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/insights/generate/route";
import { encrypt } from "@/lib/crypto";
import { AllProvidersFailedError } from "@/lib/ai/provider-runner";
import {
  insightsCacheWrite,
  openInsightsCachedText,
} from "@/lib/insights/cached-text-cipher";
import { BRIEFING_GENERATED_AT_KEY } from "@/lib/insights/briefing-generated-at";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";

import { anonymous, callRoute, type RouteAuth } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  relativeToAnchor,
  stable,
  startOfUtcToday,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";
import { parityId, seedParityRecord } from "./record-fixture";

/** What the provider stand-in answers, one entry per call, in order. */
type ScriptEntry =
  | {
      content: string;
      finishReason?: string;
      tokensUsed?: number;
      /** Runs inside the call, before the answer: a write racing the request. */
      during?: () => Promise<void>;
    }
  | { error: () => Error };

const seams = vi.hoisted(() => ({
  script: [] as ScriptEntry[],
  /** Feature reads that fail as oversized before computing, in order. */
  oversize: [] as number[],
  /** Real snapshot hash → the same input's hash with anchored dates. */
  hashes: new Map<string, string>(),
  pending: [] as Promise<unknown>[],
  /** A provider call no case scripted: the case is wrong, not the route. */
  unscripted: 0,
}));

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});

vi.mock("@/lib/rollups/measurement-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/measurement-rollups")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    ensureUserRollupsFresh: async (...args: unknown[]) => {
      effectRecorder.record("ensureUserRollupsFresh", args);
    },
  };
});

vi.mock("@/lib/rollups/mood-rollups", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/rollups/mood-rollups")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    ensureUserMoodRollupsFresh: async (...args: unknown[]) => {
      effectRecorder.record("ensureUserMoodRollupsFresh", args);
    },
  };
});

vi.mock("@/lib/ai/provider-runner", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/provider-runner")>();
  const { effectRecorder, relativeToAnchor, startOfUtcToday } =
    await import("../../../kit/parity");
  return {
    ...actual,
    runRawCompletionWithFallback: async (
      args: Parameters<typeof actual.runRawCompletionWithFallback>[0],
    ) => {
      const { messages, system, signal: _signal, ...rest } = args.params;
      const prompt = String(
        relativeToAnchor(
          `${system}\n---\n${messages
            .map((m) =>
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content),
            )
            .join("\n---\n")}`,
          startOfUtcToday(),
        ),
      )
        .replace(/^(OPENER HINT|OPENER-HINWEIS): .*$/gm, "$1: <per-day>")
        .replace(/\nNAME: [^\n]*/g, "");
      const { createHash: hash } = await import("node:crypto");
      effectRecorder.record("provider", [
        {
          surface: args.surface,
          chain: args.providers.map((p) => p.providerType),
          params: rest,
          promptChars: prompt.length,
          promptSha256: hash("sha256").update(prompt).digest("hex"),
        },
      ]);
      const next = seams.script.shift();
      if (!next) {
        seams.unscripted += 1;
        throw new Error("parity: an unscripted provider call");
      }
      if ("error" in next) throw next.error();
      if (next.during) await next.during();
      return {
        result: {
          content: next.content,
          tokensUsed: next.tokensUsed ?? 1200,
          model: "claude-parity",
          providerType: "anthropic",
          finishReason: next.finishReason ?? "stop",
        },
        workingProvider: args.providers[0],
        fallbackHops: [],
        tokensSpent: 0,
      };
    },
  };
});

vi.mock("@/lib/insights/features", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/features")>();
  return {
    ...actual,
    extractFeatures: async (
      ...args: Parameters<typeof actual.extractFeatures>
    ) => {
      const size = seams.oversize.shift();
      if (size !== undefined) {
        throw new actual.FeaturesPayloadTooLargeError(size, 5_000_000);
      }
      return actual.extractFeatures(...args);
    },
  };
});

vi.mock("@/lib/insights/snapshot-hash", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/insights/snapshot-hash")>();
  const { relativeToAnchor, startOfUtcToday } =
    await import("../../../kit/parity");
  return {
    ...actual,
    hashInsightSnapshot: (value: unknown) => {
      const real = actual.hashInsightSnapshot(value);
      if (value && typeof value === "object" && "features" in value) {
        seams.hashes.set(
          real,
          actual.hashInsightSnapshot(
            relativeToAnchor(value, startOfUtcToday()),
          ),
        );
      }
      return real;
    },
  };
});

vi.mock("@/lib/insights/briefing-failure-marker", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/insights/briefing-failure-marker")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    recordBriefingFailure: (
      args: Parameters<typeof actual.recordBriefingFailure>[0],
    ) => {
      effectRecorder.record("recordBriefingFailure", [args]);
      const written = actual.recordBriefingFailure(args);
      seams.pending.push(written);
      return written;
    },
  };
});

vi.mock("@/lib/jobs/insight-pregenerate-shared", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/jobs/insight-pregenerate-shared")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueForceWarm: async (...args: unknown[]) => {
      effectRecorder.record("enqueueForceWarm", args);
    },
  };
});

vi.mock("@/lib/jobs/insight-status-generate-shared", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/jobs/insight-status-generate-shared")
    >();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    enqueueStatusGeneration: async (...args: unknown[]) => {
      effectRecorder.record("enqueueStatusGeneration", args);
    },
  };
});

const prisma = getPrismaClient();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ANCHOR = startOfUtcToday();
const NOW = new Date(ANCHOR.getTime() + 12 * HOUR);
const EDGE_DAYS = [7, 30, 60];
const OWNER_ID = parityId("insightsgen", 1);
const OPTED_OUT_ID = parityId("insightsgen", 2);
const UNREADABLE_KEY_ID = parityId("insightsgen", 3);

let owner: RouteAuth;
let optedOut: RouteAuth;
let unreadableKey: RouteAuth;

// ── Payloads ────────────────────────────────────────────────

const GROUNDED_BRIEFING = {
  paragraph: "Your readings held steady this week, with no surprises.",
  signalsOfDay: [
    {
      sourceMetric: "weight",
      tone: "info",
      headline: "Weight is steady",
      nudge: "Keep weighing in at the same time each morning.",
      delta: null,
    },
  ],
  keyFindings: [],
};

const UNGROUNDED_BRIEFING = {
  paragraph: "Your weight reached 123.4 kg this morning, up 9.7 kg.",
  signalsOfDay: [],
  keyFindings: [],
};

const PREVIOUS_BRIEFING = {
  paragraph: "Yesterday's briefing, grounded when it was written.",
  signalsOfDay: [],
  keyFindings: [],
};

/**
 * A reply in the rich shape the strict prompt asks for. It carries no
 * `disclaimer`, so the strict schema rejects it and the route keeps the
 * parsed object whole, briefing included.
 */
function reply(briefing: unknown, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: "Your tracked metrics held steady over the last 30 days.",
    classification: "gut",
    findings: [],
    correlations: [],
    recommendations: [],
    dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
    dailyBriefing: briefing,
    ...extra,
  });
}

/** A cached payload as the generator stores it. */
function cached(briefing: unknown, generatedAt: Date | null) {
  return {
    summary: "Cached summary.",
    classification: "gut",
    findings: [],
    correlations: [],
    recommendations: [],
    dataQuality: { coverage: "good", gaps: [], confidence: "hoch" },
    dailyBriefing: briefing,
    ...(generatedAt
      ? { [BRIEFING_GENERATED_AT_KEY]: generatedAt.toISOString() }
      : {}),
  };
}

function hop(httpStatus: number | null, attempt = 1) {
  return {
    providerType: "anthropic" as const,
    attempt,
    failureReason: httpStatus === null ? "ECONNRESET" : `HTTP ${httpStatus}`,
    httpStatus,
  };
}

function providerError(httpStatus: number): () => Error {
  return () =>
    Object.assign(new Error(`upstream answered ${httpStatus}`), {
      httpStatus,
      bodyExcerpt: `{"error":"status ${httpStatus}"}`,
    });
}

// ── State ───────────────────────────────────────────────────

interface BriefingState {
  /** The cached payload: an object, a raw string, or nothing. */
  text?: unknown;
  cachedAt?: Date | null;
  cachedLocale?: string | null;
  /** Failure markers to write, with their reason and age. */
  markers?: Array<{ reason: string; at: Date; httpStatus?: number | null }>;
  /** Tokens already spent today. */
  spentToday?: number;
  /** Generations already counted against this hour's quota. */
  quotaUsed?: number;
}

async function resetBriefing(userId: string, state: BriefingState = {}) {
  const text =
    state.text === undefined
      ? null
      : typeof state.text === "string"
        ? state.text
        : JSON.stringify(state.text);
  await prisma.user.update({
    where: { id: userId },
    data: {
      insightsCachedAt: state.cachedAt ?? null,
      insightsCachedTextEncrypted: text
        ? insightsCacheWrite(text).insightsCachedTextEncrypted
        : null,
      insightsCachedLocale: state.cachedLocale ?? null,
      insightsSnapshotHash: null,
    },
  });
  await prisma.auditLog.deleteMany({ where: { userId } });
  for (const m of state.markers ?? []) {
    await prisma.auditLog.create({
      data: {
        userId,
        action: "insights.briefing-failure",
        createdAt: m.at,
        details: JSON.stringify({
          reason: m.reason,
          httpStatus: m.httpStatus ?? null,
          failureKind: null,
        }),
      },
    });
  }
  await prisma.coachUsage.deleteMany({ where: { userId } });
  if (state.spentToday) {
    await prisma.coachUsage.create({
      data: {
        userId,
        dateKey: NOW.toISOString().slice(0, 10),
        totalTokens: state.spentToday,
      },
    });
  }
  await prisma.rateLimit.deleteMany({ where: { key: `insights:${userId}` } });
  if (state.quotaUsed) {
    await prisma.$executeRaw`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${`insights:${userId}`}, ${state.quotaUsed}, (NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour')`;
  }
  seams.script.length = 0;
  seams.oversize.length = 0;
}

async function stored(userId: string) {
  const [user, audit, usage] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        insightsCachedAt: true,
        insightsCachedTextEncrypted: true,
        insightsCachedLocale: true,
        insightsSnapshotHash: true,
      },
    }),
    prisma.auditLog.findMany({
      where: { userId },
      orderBy: [{ createdAt: "asc" }, { action: "asc" }],
      select: { action: true, details: true, ipAddress: true },
    }),
    prisma.coachUsage.findMany({
      where: { userId },
      select: {
        dateKey: true,
        totalTokens: true,
        operatorTokens: true,
        messageCount: true,
      },
    }),
  ]);
  const text = openInsightsCachedText(user);
  let payload: unknown = text;
  try {
    payload = text === null ? null : JSON.parse(text);
  } catch {
    // Kept as the raw string.
  }
  const hash = user.insightsSnapshotHash;
  return {
    insightsCachedAt: user.insightsCachedAt,
    insightsCachedLocale: user.insightsCachedLocale,
    cachedPayload: payload,
    snapshotHash:
      hash === null ? null : (seams.hashes.get(hash) ?? "<not a briefing>"),
    audit: audit.map((row) => ({
      ...row,
      details: row.details === null ? null : JSON.parse(row.details),
    })),
    usage,
  };
}

/**
 * The feature read annotates from parallel queries, so the order of its meta
 * keys follows the database. The keys are sorted; what they hold is not
 * touched.
 */
function sortedMeta(facts: unknown): unknown {
  const f = facts as { meta?: Record<string, unknown> | null };
  if (!f.meta) return facts;
  return {
    ...f,
    meta: Object.fromEntries(
      Object.entries(f.meta).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}

/** Keys of per-phase timings, which the clock and the load decide. */
function timingKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => timingKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/_ms$|Ms$/.test(k)) out.add(k);
      timingKeys(v, out);
    }
  }
  return out;
}

async function step(
  name: string,
  options: {
    method: "GET" | "POST";
    auth?: RouteAuth;
    body?: unknown;
    userId?: string;
    headers?: Record<string, string>;
    /** A status the contract does not declare; the reason says which. */
    undeclared?: string;
  },
): Promise<void> {
  wideEventRecorder.take();
  effectRecorder.take();
  const handler = options.method === "GET" ? GET : POST;
  const res = await callRoute(handler, {
    method: options.method,
    route: "/api/insights/generate",
    body: options.body,
    headers: options.headers,
    auth: options.auth ?? owner,
    contract: options.undeclared ? { skip: options.undeclared } : undefined,
  });
  await Promise.all(seams.pending.splice(0));
  await settleBackgroundTasks();
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  const facts = events.map(eventFacts).map(sortedMeta);
  expect(seams.script, "every scripted reply was asked for").toEqual([]);
  expect(seams.unscripted, "no provider call went unscripted").toBe(0);
  expect(seams.oversize, "every planted oversize was read").toEqual([]);
  await expectParity(
    `insights-generate.${name}`,
    stable(
      relativeToAnchor(
        {
          status: res.status,
          body: res.body,
          events: facts,
          effects: effectRecorder.take(),
          stored: await stored(options.userId ?? OWNER_ID),
        },
        ANCHOR,
      ),
      { since: NOW, volatileKeys: [...timingKeys(facts)] },
    ),
  );
}

const get = (name: string, opts: { auth?: RouteAuth; userId?: string } = {}) =>
  step(name, { method: "GET", ...opts });
const post = (
  name: string,
  body: unknown = { force: true },
  opts: { auth?: RouteAuth; userId?: string; undeclared?: string } = {},
) => step(name, { method: "POST", body, ...opts });

async function dropEdgeDays(userId: string): Promise<void> {
  for (const d of EDGE_DAYS) {
    await prisma.measurement.deleteMany({
      where: {
        userId,
        measuredAt: {
          gte: new Date(ANCHOR.getTime() - d * DAY),
          lt: new Date(ANCHOR.getTime() - (d - 1) * DAY),
        },
      },
    });
  }
}

async function consent(userId: string): Promise<void> {
  await prisma.consentReceipt.create({
    data: { userId, kind: "ai_full", artefact: "test", signedAt: NOW },
  });
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  const ownerRow = await makeUser({
    id: OWNER_ID,
    timezone: "UTC",
    locale: "en",
    heightCm: 178,
    dateOfBirth: new Date("1975-04-02T00:00:00.000Z"),
    gender: "male",
    displayName: "Parity Person",
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    aiAnthropicKeyEncrypted: encrypt("sk-ant-parity"),
  });
  await consent(OWNER_ID);
  await seedParityRecord({ userId: OWNER_ID, now: NOW, tz: "UTC", tag: "ig" });
  await dropEdgeDays(OWNER_ID);
  const rollups = await vi.importActual<
    typeof import("@/lib/rollups/measurement-rollups")
  >("@/lib/rollups/measurement-rollups");
  await rollups.ensureUserRollupsFresh(OWNER_ID);
  const moodRollups = await vi.importActual<
    typeof import("@/lib/rollups/mood-rollups")
  >("@/lib/rollups/mood-rollups");
  await moodRollups.ensureUserMoodRollupsFresh(OWNER_ID);
  await settleBackgroundTasks();
  owner = await makeSession(ownerRow);

  const optedOutRow = await makeUser({
    id: OPTED_OUT_ID,
    timezone: "UTC",
    locale: "en",
    modulePreferencesJson: { insights: false },
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    aiAnthropicKeyEncrypted: encrypt("sk-ant-parity"),
  });
  await consent(OPTED_OUT_ID);
  optedOut = await makeSession(optedOutRow);

  // A key the presence probe sees and no resolver can open.
  const unreadableRow = await makeUser({
    id: UNREADABLE_KEY_ID,
    timezone: "UTC",
    locale: "en",
    aiProvider: "ANTHROPIC",
    aiModel: "claude-sonnet-4-6",
    aiAnthropicKeyEncrypted: "v1:presence-only",
  });
  await consent(UNREADABLE_KEY_ID);
  unreadableKey = await makeSession(unreadableRow);
});

afterAll(() => {
  vi.useRealTimers();
});

describe("GET /api/insights/generate parity", () => {
  it("G01 an anonymous call", async () => {
    await get("G01-anonymous", { auth: anonymous });
  });

  it("G02 the AI analysis opt-out", async () => {
    await get("G02-opted-out", { auth: optedOut, userId: OPTED_OUT_ID });
  });

  it("G03 no cached briefing", async () => {
    await resetBriefing(OWNER_ID);
    await get("G03-empty");
  });

  it("G04 a briefing written today", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - HOUR)),
      cachedAt: new Date(NOW.getTime() - HOUR),
      cachedLocale: "en",
    });
    await get("G04-fresh");
  });

  it("G05 a briefing written yesterday", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - 20 * HOUR)),
      cachedAt: new Date(NOW.getTime() - 2 * HOUR),
      cachedLocale: "en",
    });
    await get("G05-stale");
  });

  it("G06 a briefing in another language", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - HOUR)),
      cachedAt: new Date(NOW.getTime() - HOUR),
      cachedLocale: "de",
    });
    await get("G06-other-language");
  });

  it("G07 an unparseable cache row", async () => {
    await resetBriefing(OWNER_ID, {
      text: "{not json",
      cachedAt: new Date(NOW.getTime() - HOUR),
    });
    await get("G07-unparseable");
  });

  it("G08 a legacy payload, untagged", async () => {
    await resetBriefing(OWNER_ID, {
      text: { summary: "Legacy", recommendations: ["Drink water."] },
      cachedAt: new Date(NOW.getTime() - HOUR),
    });
    await get("G08-legacy");
  });

  it("G09 a failure newer than the last good briefing", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - 3 * HOUR)),
      cachedAt: new Date(NOW.getTime() - 3 * HOUR),
      cachedLocale: "en",
      markers: [
        {
          reason: "all-providers-failed",
          at: new Date(NOW.getTime() - HOUR),
          httpStatus: 429,
        },
      ],
    });
    await get("G09-held-after-failure");
  });

  it("G10 a failure with no good briefing, and an older superseded one", async () => {
    await resetBriefing(OWNER_ID, {
      markers: [
        { reason: "provider-error", at: new Date(NOW.getTime() - 5 * HOUR) },
        { reason: "invalid-json", at: new Date(NOW.getTime() - HOUR) },
      ],
    });
    await get("G10-failed-empty");
  });

  it("G11 a briefing the grounding gate withheld", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(null, new Date(NOW.getTime() - 2 * HOUR)),
      cachedAt: new Date(NOW.getTime() - 2 * HOUR),
      cachedLocale: "en",
      markers: [
        { reason: "briefing-ungrounded", at: new Date(NOW.getTime() - HOUR) },
      ],
    });
    await get("G11-withheld");
  });
});

describe("POST /api/insights/generate parity", () => {
  it("P01 an anonymous call", async () => {
    await post("P01-anonymous", { force: true }, { auth: anonymous });
  });

  it("P02 the AI analysis opt-out", async () => {
    await post(
      "P02-opted-out",
      { force: true },
      { auth: optedOut, userId: OPTED_OUT_ID },
    );
  });

  it("P03 a body over the cap", async () => {
    await resetBriefing(OWNER_ID);
    await post("P03-body-too-large", { pad: "x".repeat(17 * 1024) });
  });

  it("P04 a cached briefing written today", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - HOUR)),
      cachedAt: new Date(NOW.getTime() - HOUR),
      cachedLocale: "en",
    });
    await post("P04-cache-hit", {});
  });

  it("P05 a cached briefing from yesterday, regenerated", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - 20 * HOUR)),
      cachedAt: new Date(NOW.getTime() - 2 * HOUR),
      cachedLocale: "en",
    });
    seams.script.push({ content: reply(GROUNDED_BRIEFING) });
    await post("P05-yesterday-regenerated", {});
  });

  it("P06 a cache in another language, regenerated", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(GROUNDED_BRIEFING, new Date(NOW.getTime() - HOUR)),
      cachedAt: new Date(NOW.getTime() - HOUR),
      cachedLocale: "de",
    });
    seams.script.push({ content: reply(GROUNDED_BRIEFING) });
    await post("P06-other-language-regenerated", {});
  });

  it("P07 a briefingless cache when the hour's quota is spent", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(null, new Date(NOW.getTime() - HOUR)),
      cachedAt: new Date(NOW.getTime() - HOUR),
      cachedLocale: "en",
      quotaUsed: 10,
    });
    await post("P07-quota-cached-fallback", {});
  });

  it("P08 a forced generation when the hour's quota is spent", async () => {
    await resetBriefing(OWNER_ID, { quotaUsed: 10 });
    await post("P08-quota-refused");
  });

  it("P09 a key no resolver can open", async () => {
    await resetBriefing(UNREADABLE_KEY_ID);
    await post(
      "P09-unreadable-key",
      { force: true },
      { auth: unreadableKey, userId: UNREADABLE_KEY_ID },
    );
  });

  it("P10 a fresh generation", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({ content: reply(GROUNDED_BRIEFING), tokensUsed: 2100 });
    await post("P10-generated");
  });

  it("P11 a reply the strict schema accepts", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      content: reply(GROUNDED_BRIEFING, { disclaimer: "Consult your doctor." }),
    });
    await post("P11-strict-reply");
  });

  it("P12 a generation in German with the comparison, about-me and short form", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: {
        locale: "de",
        aiUsageLevel: "FRUGAL",
        dashboardWidgetsJson: { comparisonBaseline: "lastMonth" },
      },
    });
    await prisma.allergy.create({
      data: { userId: OWNER_ID, substance: "Penicillin" },
    });
    await resetBriefing(OWNER_ID);
    seams.script.push({ content: reply(GROUNDED_BRIEFING) });
    await post("P12-generated-de-short");
    await prisma.allergy.deleteMany({ where: { userId: OWNER_ID } });
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { locale: "en", aiUsageLevel: null, dashboardWidgetsJson: {} },
    });
  });

  it("P13 an oversized raw payload, downgraded once", async () => {
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { insightsPrivacyMode: "raw" },
    });
    await resetBriefing(OWNER_ID);
    seams.oversize.push(6_100_000);
    seams.script.push({ content: reply(GROUNDED_BRIEFING) });
    await post("P13-downgraded");
  });

  it("P14 an oversized aggregate too, downgraded twice", async () => {
    await resetBriefing(OWNER_ID);
    seams.oversize.push(6_100_000, 5_400_000);
    seams.script.push({ content: reply(GROUNDED_BRIEFING) });
    await post("P14-hard-downgraded");
  });

  it("P15 oversized on every rung", async () => {
    await resetBriefing(OWNER_ID);
    seams.oversize.push(6_100_000, 5_400_000, 5_200_000);
    await post("P15-too-large");
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { insightsPrivacyMode: "aggregated" },
    });
  });

  it("P16 the day's token ceiling", async () => {
    await resetBriefing(OWNER_ID, { spentToday: 5_000_000 });
    await post("P16-budget-exceeded");
  });

  it("P17 every provider refused the credential", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      error: () => new AllProvidersFailedError([hop(401), hop(403, 2)]),
    });
    await post("P17-chain-auth");
  });

  it("P18 every provider rate-limited", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({ error: () => new AllProvidersFailedError([hop(429)]) });
    await post("P18-chain-rate-limited");
  });

  it("P19 a provider in a 5xx", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      error: () => new AllProvidersFailedError([hop(401), hop(502, 2)]),
    });
    await post("P19-chain-5xx");
  });

  it("P20 every provider unreachable", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      error: () => new AllProvidersFailedError([hop(null), hop(null, 2)]),
    });
    await post("P20-chain-transport");
  });

  it("P21 a mixed chain failure", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      error: () => new AllProvidersFailedError([hop(404), hop(429, 2)]),
    });
    await post("P21-chain-mixed");
  });

  it("P22 one provider error per status class", async () => {
    for (const status of [401, 429, 500, 400]) {
      await resetBriefing(OWNER_ID);
      seams.script.push({ error: providerError(status) });
      await post(`P22-provider-${status}`);
    }
  });

  it("P23 a reply that is not JSON", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({ content: "Sure! Here is your briefing." });
    await post("P23-invalid-json");
  });

  it("P24 a reply cut off at the token ceiling", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({ content: '{"summary": "Your', finishReason: "length" });
    await post("P24-truncated");
  });

  it("P25 an ungrounded briefing the retry fixes", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push(
      { content: reply(UNGROUNDED_BRIEFING) },
      { content: reply(GROUNDED_BRIEFING), tokensUsed: 900 },
    );
    await post("P25-grounding-retry-kept");
  });

  it("P26 still ungrounded, the previous briefing stands in", async () => {
    await resetBriefing(OWNER_ID, {
      text: cached(PREVIOUS_BRIEFING, new Date(NOW.getTime() - 26 * HOUR)),
      cachedAt: new Date(NOW.getTime() - 26 * HOUR),
      cachedLocale: "en",
    });
    seams.script.push(
      { content: reply(UNGROUNDED_BRIEFING) },
      { content: reply(UNGROUNDED_BRIEFING) },
    );
    await post("P26-grounding-previous");
  });

  it("P27 still ungrounded, nothing to stand in", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push(
      { content: reply(UNGROUNDED_BRIEFING) },
      { content: reply(UNGROUNDED_BRIEFING) },
    );
    await post("P27-grounding-stripped");
  });

  it("P28 an ungrounded briefing whose retry is not JSON", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push(
      { content: reply(UNGROUNDED_BRIEFING) },
      { content: "not json" },
    );
    await post("P28-grounding-retry-unparseable");
  });

  it("P29 a reply the outbound screen blocks", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      content: reply(GROUNDED_BRIEFING, {
        summary:
          "Your 10-year cardiovascular risk is elevated — consider stepping your dose up.",
      }),
    });
    await post("P29-outbound-screened", { force: true });
  });

  it("P30 the about-me text changing during the generation", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      content: reply(GROUNDED_BRIEFING),
      during: async () => {
        await prisma.allergy.create({
          data: { userId: OWNER_ID, substance: "Latex" },
        });
      },
    });
    await post("P30-profile-scope-changed");
    await prisma.allergy.deleteMany({ where: { userId: OWNER_ID } });
  });

  it("P31 the profile changing during the generation", async () => {
    await resetBriefing(OWNER_ID);
    seams.script.push({
      content: reply(GROUNDED_BRIEFING),
      during: async () => {
        await prisma.user.update({
          where: { id: OWNER_ID },
          data: { displayName: "Renamed Person" },
        });
      },
    });
    await post("P31-scope-changed");
    await prisma.user.update({
      where: { id: OWNER_ID },
      data: { displayName: "Parity Person" },
    });
  });
});
