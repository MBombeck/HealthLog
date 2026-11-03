/**
 * v1.43 (#1217) — AI usage levels, through the real routes and the real
 * invalidator against real Postgres.
 *
 * The resolution matrix, the estimate and the effect table are unit-tested
 * (`src/lib/ai/__tests__/usage-level.test.ts`). What only this file proves is
 * the wiring end to end:
 *
 *   - `ai.usage` on `GET /api/auth/me` reads the record's stored choice and
 *     the operator's bounds off their rows, and the measured use off
 *     `coach_usage`;
 *   - `PUT /api/auth/me/ai-usage` writes the choice and refuses one above the
 *     ceiling; the admin route lowers the ceiling, which caps a stored choice
 *     at once without erasing it;
 *   - the `supplementLabel` capability closes with `usage_level` on `frugal`;
 *   - the status invalidator holds a `frugal` account's sync ingest to one
 *     regeneration per scope a day, while a hand entry six hours later goes
 *     through, and `standard` holds a sync to the operator's gap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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

// The queue is not under test: record what the invalidator enqueues.
const enqueued = vi.hoisted(() => [] as Array<{ metric: string }>);
vi.mock("@/lib/jobs/insight-status-generate-shared", async (orig) => ({
  ...(await orig<object>()),
  enqueueStatusGeneration: vi.fn(async (job: { metric: string }) => {
    enqueued.push(job);
  }),
}));

interface UsageState {
  level: string;
  preference: string | null;
  defaultLevel: string;
  maxLevel: string;
  source: string;
  options: Array<{
    level: string;
    allowed: boolean;
    estimatedTokensPerDay: number | null;
  }>;
  measuredTokensPerDay: number | null;
  measuredDays: number;
}

interface MePayload {
  ai: {
    capabilities: Record<string, { available: boolean; reason: string | null }>;
    usage?: UsageState;
  };
}

let counter = 0;

/** A person with their own key, every receipt and the nutrients module on. */
async function makeUser(overrides: Record<string, unknown> = {}) {
  const suffix = `${counter++}`;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `usage-${suffix}`,
      email: `usage-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      // Presence only: the probe never decrypts, so any value will do.
      aiAnthropicKeyEncrypted: "v1:presence-only",
      modulePreferencesJson: { nutrients: true },
      ...overrides,
    },
  });
  await prisma.consentReceipt.create({
    data: {
      userId: user.id,
      kind: "ai_full",
      artefact: "test",
      signedAt: new Date(),
    },
  });
  return user;
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
}

async function readMe(): Promise<MePayload> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: MePayload }).data;
}

async function putLevel(level: string | null): Promise<Response> {
  const { PUT } = await import("@/app/api/auth/me/ai-usage/route");
  return (PUT as unknown as (r: Request) => Promise<Response>)(
    new Request("http://localhost/api/auth/me/ai-usage", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ level }),
    }),
  );
}

/** Set the operator's usage bounds through the admin route, as an admin. */
async function putBounds(aiUsage: Record<string, unknown>) {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: {
      username: `admin-${counter++}`,
      email: `admin-${counter}@example.test`,
      role: "ADMIN",
    },
  });
  const previous = cookieJar.get("healthlog_session");
  await signIn(admin.id);
  const { PUT } =
    await import("@/app/api/admin/settings/assistant-flags/route");
  const { NextRequest } = await import("next/server");
  const res = await PUT(
    new NextRequest("http://localhost/api/admin/settings/assistant-flags", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ aiUsage }),
    }),
  );
  if (previous) cookieJar.set("healthlog_session", previous);
  return res;
}

/** A stored status note for `scope`, written `hoursAgo` hours ago. */
async function noteWritten(userId: string, scope: string, hoursAgo: number) {
  await getPrismaClient().insightStatusCache.create({
    data: {
      userId,
      metric: scope,
      locale: "en",
      textEncrypted: Buffer.from("ciphertext"),
      dateKey: new Date().toISOString().slice(0, 10),
      generatedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    },
  });
}

async function invalidate(userId: string, source: "sync" | "manual") {
  enqueued.length = 0;
  const { invalidateStatusInsightsForTypes } =
    await import("@/lib/insights/status-invalidation");
  await invalidateStatusInsightsForTypes(userId, ["ACTIVITY_STEPS"], {
    source,
  });
  return enqueued.map((job) => job.metric).sort();
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  enqueued.length = 0;
  counter = 0;
});

describe("ai.usage on GET /api/auth/me", () => {
  it("publishes the instance default with the measured use and the estimate", async () => {
    const user = await makeUser();
    const today = new Date();
    for (let i = 1; i <= 4; i++) {
      const day = new Date(today.getTime() - i * 86_400_000);
      await getPrismaClient().coachUsage.create({
        data: {
          userId: user.id,
          dateKey: day.toISOString().slice(0, 10),
          totalTokens: 100_000,
        },
      });
    }
    // Today is still running and does not count.
    await getPrismaClient().coachUsage.create({
      data: {
        userId: user.id,
        dateKey: today.toISOString().slice(0, 10),
        totalTokens: 9_000_000,
      },
    });
    await signIn(user.id);
    const { ai } = await readMe();
    expect(ai.usage).toEqual({
      level: "standard",
      preference: null,
      defaultLevel: "standard",
      maxLevel: "standard",
      source: "default",
      options: [
        { level: "frugal", allowed: true, estimatedTokensPerDay: 50_000 },
        { level: "standard", allowed: true, estimatedTokensPerDay: 100_000 },
        { level: "full", allowed: false, estimatedTokensPerDay: 333_333 },
      ],
      measuredTokensPerDay: 100_000,
      measuredDays: 4,
    });
    expect(ai.capabilities.supplementLabel).toMatchObject({
      available: true,
      reason: null,
    });
  });

  it("writes the choice, closes the label photo on frugal, and refuses above the ceiling", async () => {
    const user = await makeUser();
    await signIn(user.id);

    const res = await putLevel("frugal");
    expect(res.status).toBe(200);
    expect(
      (await getPrismaClient().user.findUnique({ where: { id: user.id } }))
        ?.aiUsageLevel,
    ).toBe("FRUGAL");
    const me = await readMe();
    expect(me.ai.usage).toMatchObject({ level: "frugal", source: "user" });
    expect(me.ai.capabilities.supplementLabel).toMatchObject({
      available: false,
      reason: "usage_level",
    });
    // Nothing else is touched by the level.
    expect(me.ai.capabilities.documentAi.available).toBe(true);

    const above = await putLevel("full");
    expect(above.status).toBe(422);
    expect(((await above.json()) as { meta: unknown }).meta).toMatchObject({
      errorCode: "ai.usage.aboveCeiling",
      maxLevel: "standard",
    });

    expect((await putLevel(null)).status).toBe(200);
    expect((await readMe()).ai.usage).toMatchObject({
      level: "standard",
      preference: null,
      source: "default",
    });
  });

  it("caps a stored choice the moment the operator lowers the ceiling, and keeps it", async () => {
    const user = await makeUser();
    expect(
      (
        await putBounds({
          maxLevel: "full",
          defaultLevel: "standard",
          syncRegenGapHours: null,
        })
      ).status,
    ).toBe(200);
    await signIn(user.id);
    expect((await putLevel("full")).status).toBe(200);
    expect((await readMe()).ai.usage).toMatchObject({
      level: "full",
      source: "user",
    });

    const lowered = await putBounds({
      maxLevel: "frugal",
      defaultLevel: "frugal",
      syncRegenGapHours: null,
    });
    expect(lowered.status).toBe(200);
    const usage = (await readMe()).ai.usage!;
    expect(usage).toMatchObject({
      level: "frugal",
      preference: "full",
      maxLevel: "frugal",
      source: "admin_cap",
    });
    expect(usage.options.map((o) => o.allowed)).toEqual([true, false, false]);

    const refused = await putBounds({
      maxLevel: "frugal",
      defaultLevel: "standard",
      syncRegenGapHours: null,
    });
    expect(refused.status).toBe(422);
  });
});

describe("status regeneration gap by level and source", () => {
  it("frugal: no second generation per scope within 24 h of a sync; a hand entry after 6 h goes through", async () => {
    const user = await makeUser({ aiUsageLevel: "FRUGAL" });
    await noteWritten(user.id, "general", 7);
    await noteWritten(user.id, "metric:STEPS", 23);
    // A sync 7 h and 23 h after the last generation: still inside the day.
    expect(await invalidate(user.id, "sync")).toEqual([]);
    // A hand entry: both scopes were generated more than six hours ago.
    expect(await invalidate(user.id, "manual")).toEqual([
      "general",
      "metric:STEPS",
    ]);
  });

  it("frugal: a hand entry within six hours of the last generation waits", async () => {
    const user = await makeUser({ aiUsageLevel: "FRUGAL" });
    await noteWritten(user.id, "general", 7);
    await noteWritten(user.id, "metric:STEPS", 3);
    expect(await invalidate(user.id, "manual")).toEqual(["general"]);
  });

  it("frugal: a sync a day after the last generation regenerates", async () => {
    const user = await makeUser({ aiUsageLevel: "FRUGAL" });
    await noteWritten(user.id, "general", 25);
    await noteWritten(user.id, "metric:STEPS", 25);
    expect(await invalidate(user.id, "sync")).toEqual([
      "general",
      "metric:STEPS",
    ]);
  });

  it("standard: a sync waits the operator's gap, a hand entry the hour", async () => {
    const user = await makeUser();
    await noteWritten(user.id, "general", 3);
    await noteWritten(user.id, "metric:STEPS", 7);
    expect(await invalidate(user.id, "sync")).toEqual(["metric:STEPS"]);
    expect(await invalidate(user.id, "manual")).toEqual([
      "general",
      "metric:STEPS",
    ]);

    await putBounds({
      maxLevel: "standard",
      defaultLevel: "standard",
      syncRegenGapHours: 2,
    });
    expect(await invalidate(user.id, "sync")).toEqual([
      "general",
      "metric:STEPS",
    ]);
  });
});
