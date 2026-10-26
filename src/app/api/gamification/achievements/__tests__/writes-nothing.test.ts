/**
 * `GET /api/gamification/achievements` is a read.
 *
 * It used to INSERT a `UserAchievement` row for every unlock it noticed,
 * which is the side-effecting GET the MCP-audience note in `lib/auth/guards/context.ts`
 * warns against. The evaluation still runs here; only the persistence moved
 * to the `achievement-unlock-sweep` job.
 *
 * The builder is faked so the result ALWAYS carries a pending unlock. That is
 * the point: an assertion that the route did not write is worth nothing
 * against a fixture that had nothing to write, and the fixture in
 * `module-gate.test.ts` turns out to be exactly that.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: { userAchievement: { findMany: vi.fn(), createMany: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  resolveModuleMap: vi.fn(async () => ({})),
  MODULE_DISABLED_ERROR_CODE: "module.disabled",
}));

const PENDING_UNLOCK = {
  achievementId: "mood-first-entry",
  unlockedAt: new Date("2026-03-02T08:00:00.000Z"),
};

vi.mock("@/lib/gamification/achievements-result", () => ({
  buildAchievementsResult: vi.fn(async () => ({
    summary: { unlockedCount: 1, totalCount: 1 },
    achievements: [
      {
        id: "mood-first-entry",
        category: "mood",
        unlocked: true,
        completedAt: "2026-03-02T08:00:00.000Z",
        titleKey: "achievements.moodFirst.title",
        descriptionKey: "achievements.moodFirst.description",
        icon: "Smile",
        progressPercent: 100,
        points: 10,
        target: 1,
        current: 1,
        isHidden: false,
      },
    ],
    metrics: {},
    pendingUnlocks: [PENDING_UNLOCK],
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { buildAchievementsResult } from "@/lib/gamification/achievements-result";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    locale: "en",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllCachesForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

async function callGet() {
  const res = await GET(
    new NextRequest("http://localhost/api/gamification/achievements"),
  );
  return { status: res.status, body: JSON.parse(await res.text()) };
}

describe("GET /api/gamification/achievements", () => {
  it("has a pending unlock to notice — otherwise the case below is empty", async () => {
    await callGet();
    const result = await vi.mocked(buildAchievementsResult).mock.results[0]!
      .value;
    expect(result.pendingUnlocks).toHaveLength(1);
  });

  it("persists nothing — a GET does not write", async () => {
    const { status } = await callGet();
    expect(status).toBe(200);
    expect(prisma.userAchievement.createMany).not.toHaveBeenCalled();
  });

  it("still renders the unlocked badge, so the payload never depended on the row", async () => {
    const { body } = await callGet();
    const achievements = (body.data as { achievements: Array<unknown> })
      .achievements as Array<{ id: string; unlocked: boolean }>;
    expect(achievements).toHaveLength(1);
    expect(achievements[0]!.unlocked).toBe(true);
  });

  it("does not leak the internal pendingUnlocks carrier onto the wire", async () => {
    const { body } = await callGet();
    expect(body.data).not.toHaveProperty("pendingUnlocks");
  });
});
