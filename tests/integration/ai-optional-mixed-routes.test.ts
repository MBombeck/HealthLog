/**
 * Mixed reads: data plus optional model text, through the real handlers
 * against real Postgres.
 *
 * Each read answers 200 in every state. Model-written text is served only
 * while its capability is available; otherwise the field is null (or the
 * deterministic stand-in), `ai` names the reason, the stored text is not
 * served however fresh, and nothing is enqueued to warm it. The baseline (S0)
 * proves each assertion can see the text when it is allowed to.
 *
 * Mutation check: dropping the capability test from the narrative route
 * (`existing = stored`) serves the provider row and turns all four hiding
 * states red. The per-read snapshot gate is mutation-checked by
 * `snapshot-read-briefing-capability.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  enterState,
  resetWorld,
  setSwitches,
  type StateName,
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

// The two enqueue seams a mixed read may reach. Spied, never run: the test
// asserts they are not called while a capability is unavailable.
const enqueueNarrativeWarm = vi.fn(async () => undefined);
vi.mock("@/lib/jobs/period-narrative-shared", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/period-narrative-shared")
  >()),
  enqueueNarrativeWarm: (...args: unknown[]) =>
    (enqueueNarrativeWarm as (...a: unknown[]) => Promise<void>)(...args),
}));
const enqueueForceWarm = vi.fn(async () => undefined);
vi.mock("@/lib/jobs/insight-pregenerate-shared", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/insight-pregenerate-shared")
  >()),
  enqueueForceWarm: (...args: unknown[]) =>
    (enqueueForceWarm as (...a: unknown[]) => Promise<void>)(...args),
}));

const BRIEFING = {
  dailyBriefing: {
    paragraph: "Model prose about your week. It reads well.",
    keyFindings: [],
  },
};

async function seed(recordId: string): Promise<void> {
  const prisma = getPrismaClient();
  const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
  // A model-written narrative, fresh.
  await prisma.insightNarrative.create({
    data: {
      userId: recordId,
      period: "week",
      locale: "en",
      dateKey: "2026-09-20",
      encryptedContent: encryptToBytes("A model wrote this retrospective."),
      providerType: "anthropic",
    },
  });
  // A fresh cached briefing in the reader's language.
  await prisma.user.update({
    where: { id: recordId },
    data: {
      // Generated now: only text written today is served as today's read.
      insightsCachedText: JSON.stringify({
        ...BRIEFING,
        briefingGeneratedAt: new Date().toISOString(),
      }),
      insightsCachedAt: new Date(),
      insightsCachedLocale: "en",
    },
  });
  // A Coach thread whose newest message the person has not opened.
  const conversation = await prisma.coachConversation.create({
    data: { userId: recordId, title: "Week" },
  });
  await prisma.coachMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      encryptedContent: encryptToBytes("Hello from the Coach."),
    },
  });
  // A workout with a stored Activity Insight paragraph.
  const startedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const workout = await prisma.workout.create({
    data: {
      userId: recordId,
      sportType: "RUNNING",
      startedAt,
      endedAt: new Date(startedAt.getTime() + 30 * 60 * 1000),
      durationSec: 1800,
      source: "APPLE_HEALTH",
    },
  });
  await prisma.workoutInsight.create({
    data: {
      userId: recordId,
      workoutId: workout.id,
      paragraphEncrypted: encryptToBytes("A steady run, model-written."),
      inputHash: "h",
      promptVersion: "p",
      providerType: "anthropic",
      locale: "en",
      generatedAt: new Date(),
    },
  });
}

async function json<T>(res: Response): Promise<{ status: number; data: T }> {
  return {
    status: res.status,
    data: ((await res.json()) as { data: T }).data,
  };
}

async function readNarrative() {
  const { GET } = await import("@/app/api/insights/narrative/route");
  return json<{
    narrative: { text: string } | null;
    revalidating: boolean;
    ai: { available: boolean; reason: string | null };
  }>(
    await GET(
      new NextRequest("http://localhost/api/insights/narrative?period=week"),
    ),
  );
}

async function readSnapshot() {
  const { GET } = await import("@/app/api/dashboard/snapshot/route");
  return json<{
    briefing: unknown;
    briefingState: string;
    briefingUpdatedAt: string | null;
    briefingAi: { available: boolean; reason: string | null };
  }>(await GET());
}

async function readDigest() {
  const { GET } = await import("@/app/api/daily/digest/route");
  return json<{
    briefingLead: string | null;
    ai: { briefing: { reason: string | null } };
  }>(await GET());
}

async function readNudge() {
  const { GET } = await import("@/app/api/insights/coach/nudge-status/route");
  return json<{
    unread: boolean;
    nudgedAt: string | null;
    ai: { reason: string | null };
  }>(await GET());
}

async function readWorkout(recordId: string) {
  const workout = await getPrismaClient().workout.findFirstOrThrow({
    where: { userId: recordId },
  });
  const { GET } = await import("@/app/api/workouts/[id]/route");
  return json<{
    aiInsight: { paragraph: string } | null;
    ai: { reason: string | null };
  }>(
    await GET(
      new NextRequest(`http://localhost/api/workouts/${workout.id}?compact=1`),
      { params: Promise.resolve({ id: workout.id }) },
    ),
  );
}

async function readComprehensive() {
  const { GET } = await import("@/app/api/insights/comprehensive/route");
  return json<{
    ai: {
      briefing: { reason: string | null };
      statusText: { reason: string | null };
    };
  }>(await GET());
}

async function pregenerate() {
  const { POST } = await import("@/app/api/insights/pregenerate/route");
  return json<{ queued: boolean; ai: unknown }>(
    await POST(
      new NextRequest("http://localhost/api/insights/pregenerate", {
        method: "POST",
      }),
    ),
  );
}

beforeEach(async () => {
  await resetWorld();
  enqueueNarrativeWarm.mockClear();
  enqueueForceWarm.mockClear();
});

describe("the baseline sees the model text", () => {
  it("S0 serves every model-written field", async () => {
    const world = await enterState("S0", seed);

    const narrative = await readNarrative();
    expect(narrative.status).toBe(200);
    expect(narrative.data.narrative?.text).toBe(
      "A model wrote this retrospective.",
    );
    expect(narrative.data.ai.available).toBe(true);

    const snapshot = await readSnapshot();
    expect(snapshot.data.briefing).not.toBeNull();
    expect(snapshot.data.briefingAi.available).toBe(true);

    const digest = await readDigest();
    expect(digest.data.briefingLead).toBe("Model prose about your week.");

    const nudge = await readNudge();
    expect(nudge.data.unread).toBe(true);

    const workout = await readWorkout(world.recordId);
    expect(workout.data.aiInsight?.paragraph).toBe(
      "A steady run, model-written.",
    );

    const comprehensive = await readComprehensive();
    expect(comprehensive.status).toBe(200);
    expect(comprehensive.data.ai.briefing.reason).toBeNull();

    const warm = await pregenerate();
    expect(warm.data.queued).toBe(true);
    expect(enqueueForceWarm).toHaveBeenCalledTimes(1);
  });
});

describe.each([
  ["S1", "operator_disabled"],
  ["S3", "no_provider"],
  ["S4", "consent_required"],
  ["S6", "user_disabled"],
] as const)("%s hides the model text", (state: StateName, reason) => {
  it("answers 200 with the text nulled, the reason named and nothing enqueued", async () => {
    const world = await enterState(state, seed);

    const narrative = await readNarrative();
    expect(narrative.status).toBe(200);
    expect(narrative.data.narrative).toBeNull();
    expect(narrative.data.ai.reason).toBe(reason);
    // Nothing servable: the warm is still allowed, because the worker then
    // writes the deterministic narrative. It is the only enqueue allowed.

    const snapshot = await readSnapshot();
    expect(snapshot.status).toBe(200);
    expect(snapshot.data.briefing).toBeNull();
    expect(snapshot.data.briefingUpdatedAt).toBeNull();
    expect(snapshot.data.briefingAi.reason).toBe(reason);
    expect(snapshot.data.briefingState).toBe(
      reason === "no_provider" ? "no-provider" : "disabled",
    );

    const digest = await readDigest();
    expect(digest.status).toBe(200);
    expect(digest.data.briefingLead).toBeNull();
    expect(digest.data.ai.briefing.reason).toBe(reason);

    const workout = await readWorkout(world.recordId);
    expect(workout.status).toBe(200);
    expect(workout.data.aiInsight).toBeNull();

    const comprehensive = await readComprehensive();
    expect(comprehensive.status).toBe(200);
    expect(comprehensive.data.ai.statusText.reason).toBe(reason);

    const warm = await pregenerate();
    expect(warm.status).toBe(200);
    expect(warm.data.queued).toBe(false);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
  });
});

describe("the Coach half", () => {
  it.each([
    ["S1", "operator_disabled"],
    ["S5", "user_disabled"],
    ["S3", "no_provider"],
  ] as const)(
    "nudge-status answers the quiet shape in %s",
    async (state, reason) => {
      await enterState(state, seed);
      const nudge = await readNudge();
      expect(nudge.status).toBe(200);
      expect(nudge.data.unread).toBe(false);
      expect(nudge.data.nudgedAt).toBeNull();
      expect(nudge.data.ai.reason).toBe(reason);
    },
  );

  it("hiding the Coach hides the Coach, not the briefing", async () => {
    await enterState("S5", seed);
    const snapshot = await readSnapshot();
    expect(snapshot.data.briefing).not.toBeNull();
    const digest = await readDigest();
    expect(digest.data.briefingLead).toBe("Model prose about your week.");
  });
});

describe("the narrative's deterministic text is data", () => {
  it("serves a deterministic row with the master switch off, and does not re-warm it", async () => {
    await enterState("S1", async (recordId) => {
      const { encryptToBytes } = await import("@/lib/ai/coach/bytes-codec");
      await getPrismaClient().insightNarrative.create({
        data: {
          userId: recordId,
          period: "week",
          locale: "en",
          dateKey: "2026-09-20",
          encryptedContent: encryptToBytes("Your week, in numbers."),
          providerType: "deterministic",
          updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
        },
      });
    });
    const narrative = await readNarrative();
    expect(narrative.data.narrative?.text).toBe("Your week, in numbers.");
    expect(narrative.data.revalidating).toBe(false);
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();
  });
});

describe("the snapshot applies the capability per read", () => {
  it("hides a cached briefing on the very next read after the operator switches it off", async () => {
    await enterState("S0", seed);
    const before = await readSnapshot();
    expect(before.data.briefing).not.toBeNull();

    await setSwitches({ assistantBriefingEnabled: false });
    const after = await readSnapshot();
    expect(after.data.briefing).toBeNull();
    expect(after.data.briefingAi.reason).toBe("operator_disabled");
  });
});

describe("the status family", () => {
  async function readStatus(path: string) {
    const route =
      path === "weight"
        ? await import("@/app/api/insights/weight-status/route")
        : await import("@/app/api/insights/metric-status/route");
    const url =
      path === "weight"
        ? "http://localhost/api/insights/weight-status"
        : "http://localhost/api/insights/metric-status?metric=RESTING_HEART_RATE";
    return json<Record<string, unknown>>(await route.GET(new NextRequest(url)));
  }

  it("S0 publishes the capability beside the note", async () => {
    const world = await enterState("S0");
    // The available path resolves (never calls) the provider chain, so the
    // key has to decrypt.
    const { encrypt } = await import("@/lib/crypto");
    await getPrismaClient().user.update({
      where: { id: world.recordId },
      data: { aiAnthropicKeyEncrypted: encrypt("sk-ant-integration") },
    });
    const status = await readStatus("weight");
    expect(status.status).toBe(200);
    expect(status.data.ai).toMatchObject({ available: true });
  });

  it.each([
    ["S1", "operator_disabled", true],
    ["S3", "no_provider", false],
    ["S6", "user_disabled", true],
  ] as const)(
    "%s answers 200 with no note and provider presence in hasProvider",
    async (state, reason, hasProvider) => {
      await enterState(state);
      for (const path of ["weight", "metric"]) {
        const status = await readStatus(path);
        expect(status.status, path).toBe(200);
        expect(status.data, path).toMatchObject({
          text: null,
          preparing: false,
          hasProvider,
          ai: { available: false, reason },
        });
      }
      const metric = await readStatus("metric");
      // No readings were seeded: the data half still says so.
      expect(metric.data.insufficient).toBe(true);
    },
  );
});

describe("inside somebody else's record (S8, a MANAGE delegate)", () => {
  async function seedOwnerText(recordId: string): Promise<void> {
    await seed(recordId);
    const prisma = getPrismaClient();
    // The narrative is stale, so an owner's read would warm it.
    await prisma.insightNarrative.updateMany({
      where: { userId: recordId },
      data: { updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });
    const { writeStatusNote, statusCacheAction } =
      await import("@/lib/insights/status-cache");
    const { userDayKey } = await import("@/lib/tz/format");
    await writeStatusNote({
      userId: recordId,
      cacheAction: statusCacheAction("weight", "en"),
      todayKey: userDayKey(new Date(), "UTC"),
      text: "The owner's weight note.",
    });
  }

  it("reads the owner's stored model text exactly as the owner would", async () => {
    await enterState("S8", seedOwnerText);

    const narrative = await readNarrative();
    expect(narrative.data.narrative?.text).toBe(
      "A model wrote this retrospective.",
    );
    expect(narrative.data.ai.available).toBe(true);

    const snapshot = await readSnapshot();
    expect(snapshot.data.briefing).not.toBeNull();

    const digest = await readDigest();
    expect(digest.data.briefingLead).toBe("Model prose about your week.");

    const { GET } = await import("@/app/api/insights/weight-status/route");
    const status = await json<{ text: string | null }>(
      await GET(new NextRequest("http://localhost/api/insights/weight-status")),
    );
    expect(status.status).toBe(200);
    expect(status.data.text).toBe("The owner's weight note.");
  });

  it("starts no model work on the owner's record", async () => {
    await enterState("S8", seedOwnerText);

    // A stale narrative the owner's read would warm: the delegate's does not.
    const narrative = await readNarrative();
    expect(narrative.data.revalidating).toBe(false);
    expect(enqueueNarrativeWarm).not.toHaveBeenCalled();

    // Every generating route refuses a delegate before any work.
    const { POST: chat } = await import("@/app/api/insights/chat/route");
    const chatRes = await chat(
      new NextRequest("http://localhost/api/insights/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "How was my week?" }),
      }),
    );
    expect(chatRes.status).toBe(403);

    const warm = await pregenerate();
    expect(warm.status).toBe(403);
    expect(enqueueForceWarm).not.toHaveBeenCalled();
    expect(await getPrismaClient().coachConversation.count()).toBe(1);
  });
});
