/**
 * Data never depends on AI: the formerly AI-gated data routes, through the
 * real handlers against real Postgres, under every state of the matrix.
 *
 * For each state the same record is seeded and every data route is read. Each
 * answers 200, and its body equals the all-on baseline's once the per-request
 * AI state, the clock and row ids are set aside: switching AI off, never
 * configuring a provider, withdrawing consent, hiding the Coach, opting out
 * of AI analysis, or reading as a delegate changes no data. An ECG upload is
 * stored with the master switch off and with AI analysis opted out.
 *
 * Mutation check: putting `requireModuleEnabled(user.id, "insights")` back
 * into `insights/ecg/route.ts` turns S6 red by route name; putting
 * `await requireAiCapability("statusText")` there turns S1, S2, S3, S4, S6
 * and S8 red.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enterState,
  resetWorld,
  type StateName,
  type World,
} from "./ai-optional-fixtures";
import { getPrismaClient } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

/** One ECG recording, one device event, a week of pulse and a Coach fact. */
async function seed(recordId: string): Promise<void> {
  const prisma = getPrismaClient();
  const { persistEcgRecording } = await import("@/lib/ecg/persist-recording");
  await persistEcgRecording(
    {
      userId: recordId,
      source: "APPLE_HEALTH",
      externalRecordingId: "aio-ecg-1",
      recordedAt: new Date(NOW - 2 * DAY),
      samples: [12, -7, 3, 240, -180, 60],
      samplingFrequency: 512,
      lead: "I",
      averageHeartRate: 64,
      rhythmClassification: "NOT_DETECTED",
    },
    prisma,
  );
  await prisma.measurement.create({
    data: {
      userId: recordId,
      type: "HIGH_HEART_RATE_EVENT",
      value: 1,
      unit: "event",
      measuredAt: new Date(NOW - 3 * DAY),
      source: "APPLE_HEALTH",
    },
  });
  for (let i = 0; i < 7; i++) {
    await prisma.measurement.create({
      data: {
        userId: recordId,
        type: "PULSE",
        value: 60 + i,
        unit: "bpm",
        measuredAt: new Date(NOW - i * DAY),
        source: "MANUAL",
      },
    });
  }
  const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
  await prisma.coachFact.create({
    data: {
      userId: recordId,
      factEncrypted: encryptToBytes("Prefers morning walks"),
      category: "preference",
      confidence: 80,
      createdAt: new Date(NOW - DAY),
      // Pinned like `createdAt`: each state re-seeds the record, and the
      // facts read publishes `updatedAt`, so a wall-clock stamp would differ
      // between states for reasons that have nothing to do with AI.
      updatedAt: new Date(NOW - DAY),
    },
  });
}

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

interface DataRead {
  name: string;
  load: () => Promise<Handler>;
  url: string;
  method?: "GET" | "POST";
  params?: (world: World) => Promise<Record<string, string>>;
  /** Scoped to the caller rather than the record: not read in S8. */
  actorScoped?: boolean;
}

async function firstEcgId(world: World): Promise<Record<string, string>> {
  const row = await getPrismaClient().ecgRecording.findFirstOrThrow({
    where: { userId: world.recordId },
  });
  return { id: row.id };
}

const READS: DataRead[] = [
  {
    name: "GET /api/insights/ecg",
    load: async () => (await import("@/app/api/insights/ecg/route")).GET,
    url: "/api/insights/ecg",
  },
  {
    name: "GET /api/insights/ecg/[id]",
    load: async () =>
      (await import("@/app/api/insights/ecg/[id]/route")).GET as Handler,
    url: "/api/insights/ecg/x",
    params: firstEcgId,
  },
  {
    name: "GET /api/insights/rhythm-events",
    load: async () =>
      (await import("@/app/api/insights/rhythm-events/route")).GET as Handler,
    url: "/api/insights/rhythm-events",
  },
  {
    name: "GET /api/insights/derived/batch",
    load: async () =>
      (await import("@/app/api/insights/derived/batch/route")).GET,
    url: "/api/insights/derived/batch?metrics=VITALS_BASELINE:PULSE,READINESS",
  },
  {
    name: "GET /api/insights/cards",
    load: async () =>
      (await import("@/app/api/insights/cards/route")).GET as Handler,
    url: "/api/insights/cards",
  },
  {
    name: "GET /api/insights/correlations",
    load: async () =>
      (await import("@/app/api/insights/correlations/route")).GET as Handler,
    url: "/api/insights/correlations",
  },
  {
    name: "GET /api/insights/coach-read",
    load: async () => (await import("@/app/api/insights/coach-read/route")).GET,
    url: "/api/insights/coach-read?metric=PULSE",
  },
  {
    name: "GET /api/insights/health-status",
    load: async () =>
      (await import("@/app/api/insights/health-status/route")).GET as Handler,
    url: "/api/insights/health-status",
  },
  {
    name: "GET /api/insights/pulse/intraday",
    load: async () =>
      (await import("@/app/api/insights/pulse/intraday/route")).GET as Handler,
    url: "/api/insights/pulse/intraday",
  },
  {
    name: "GET /api/insights/patterns",
    load: async () =>
      (await import("@/app/api/insights/patterns/route")).GET as Handler,
    url: "/api/insights/patterns",
  },
  {
    name: "GET /api/insights/coach/facts",
    load: async () =>
      (await import("@/app/api/insights/coach/facts/route")).GET as Handler,
    url: "/api/insights/coach/facts",
    actorScoped: true,
  },
  {
    name: "GET /api/insights/chat",
    load: async () => (await import("@/app/api/insights/chat/route")).GET,
    url: "/api/insights/chat",
    actorScoped: true,
  },
  {
    name: "GET /api/daily/digest",
    load: async () =>
      (await import("@/app/api/daily/digest/route")).GET as Handler,
    url: "/api/daily/digest",
  },
];

/** Ids, the clock and the per-request AI state set aside. */
function dataOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dataOnly);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (
        [
          "ai",
          "id",
          "generatedAt",
          "revalidating",
          "hasProvider",
          "conversationId",
          "computedAt",
        ].includes(key)
      ) {
        continue;
      }
      out[key] = dataOnly(inner);
    }
    return out;
  }
  return value;
}

async function readAll(
  world: World,
  state: StateName,
): Promise<Record<string, { status: number; body: unknown }>> {
  const out: Record<string, { status: number; body: unknown }> = {};
  for (const read of READS) {
    if (state === "S8" && read.actorScoped) continue;
    const handler = await read.load();
    const request = new NextRequest(`http://localhost${read.url}`, {
      method: read.method ?? "GET",
    });
    const res = read.params
      ? await handler(request, {
          params: Promise.resolve(await read.params(world)),
        })
      : await handler(request);
    const json = (await res.json()) as { data: unknown };
    out[read.name] = { status: res.status, body: dataOnly(json.data) };
  }
  return out;
}

let baseline: Record<string, { status: number; body: unknown }> | null = null;

beforeEach(async () => {
  await resetWorld();
});

describe("data routes under every AI state", () => {
  it("S0 (all on) is the baseline, and every read answers", async () => {
    const world = await enterState("S0", seed);
    baseline = await readAll(world, "S0");
    for (const [name, { status }] of Object.entries(baseline)) {
      expect(status, name).toBe(200);
    }
    // The seed is visible, so equality below compares something real.
    const ecg = baseline["GET /api/insights/ecg"].body as {
      hasRecordings: boolean;
    };
    expect(ecg.hasRecordings).toBe(true);
    const events = baseline["GET /api/insights/rhythm-events"].body as {
      hasEvents: boolean;
    };
    expect(events.hasEvents).toBe(true);
    const facts = baseline["GET /api/insights/coach/facts"].body as {
      facts: unknown[];
    };
    expect(facts.facts).toHaveLength(1);
  });

  it.each(["S1", "S2", "S3", "S4", "S5", "S6", "S8"] as const)(
    "%s answers every read with the baseline's data",
    async (state) => {
      expect(baseline, "the S0 baseline runs first").not.toBeNull();
      const world = await enterState(state, seed);
      const reads = await readAll(world, state);
      for (const [name, { status, body }] of Object.entries(reads)) {
        expect(status, `${state} ${name}`).toBe(200);
        expect(body, `${state} ${name}`).toEqual(baseline![name].body);
      }
    },
  );
});

describe("writes that AI never refuses", () => {
  async function ingest(): Promise<Response> {
    const { POST } = await import("@/app/api/insights/ecg/route");
    return POST(
      new NextRequest("http://localhost/api/insights/ecg", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          externalRecordingId: "aio-ingest-1",
          recordedAt: new Date(NOW - DAY).toISOString(),
          samplingFrequency: 512,
          samples: [1, 2, 3, 4],
          classification: "NOT_DETECTED",
          source: "APPLE_HEALTH",
        }),
      }),
    );
  }

  it.each(["S1", "S6"] as const)(
    "stores an ECG upload in %s",
    async (state) => {
      const world = await enterState(state);
      const res = await ingest();
      expect(res.status).toBe(201);
      const rows = await getPrismaClient().ecgRecording.count({
        where: { userId: world.recordId },
      });
      expect(rows).toBe(1);
    },
  );

  it.each(["S1", "S5"] as const)(
    "stamps the Coach as seen and erases a fact in %s",
    async (state) => {
      const world = await enterState(state, seed);
      const { POST: seen } =
        await import("@/app/api/insights/coach/seen/route");
      expect((await seen()).status).toBe(200);
      const { DELETE: forgetAll } =
        await import("@/app/api/insights/coach/facts/route");
      const res = await forgetAll();
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { data: { cleared: number } }).data,
      ).toEqual({ cleared: 1 });
      const live = await getPrismaClient().coachFact.count({
        where: { userId: world.recordId, deletedAt: null },
      });
      expect(live).toBe(0);
    },
  );
});
