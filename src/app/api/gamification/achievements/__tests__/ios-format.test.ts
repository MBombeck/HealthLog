import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    // v1.28.25 — the achievements vitals read is a raw (day, hour, type)
    // bucket aggregation.
    $queryRaw: vi.fn(),
    measurement: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    passkey: { findMany: vi.fn() },
    auditLog: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    userAchievement: {
      findMany: vi.fn(),
      createMany: vi.fn(),
    },
    userHealthProfile: { findUnique: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

// v1.18.0 — this suite predates the achievements module gate and only
// mocks the aggregation Prisma models. Pin the gate to "enabled" (a plain
// async fn so `vi.resetAllMocks()` can't blank it out) so the format
// branches stay in scope; the gate's enable/disable behaviour is covered
// in module-gate.test.ts.
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: async () => ({ enabled: true }),
  // v1.18.0 — all modules enabled by default so the badge filter is
  // a no-op here; the skip behaviour is asserted in module-gate.test.ts.
  resolveModuleMap: async () => ({}),
  MODULE_DISABLED_ERROR_CODE: "module.disabled",
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    createdAt: new Date("2026-03-01T00:00:00.000Z"),
    heightCm: null,
    locale: "en",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.34 — reset achievement LRU between tests so each case
  // observes a cold cache.
  __resetAllCachesForTests();
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.passkey.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userAchievement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userAchievement.createMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.userHealthProfile.findUnique).mockResolvedValue(
    null as never,
  );
});

describe("GET /api/gamification/achievements?format=ios", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest(
        "http://localhost/api/gamification/achievements?format=ios",
      ),
    );
    expect(res.status).toBe(401);
  });

  it("returns a flat iOS-shaped achievement array", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      new NextRequest(
        "http://localhost/api/gamification/achievements?format=ios",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        key: string;
        title: string;
        description: string;
        iconName: string;
        unlocked: boolean;
        unlockedAt: string | null;
        progress: number;
        category: string;
        points: number;
        target: number;
        current: number;
        isHidden: boolean;
      }>;
    };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    const first = body.data[0];
    expect(first.id).toEqual(expect.any(String));
    expect(first.key).toEqual(expect.any(String));
    expect(first.title).toEqual(expect.any(String));
    expect(first.iconName).toEqual(expect.any(String));
    expect(first.progress).toBeGreaterThanOrEqual(0);
    expect(first.progress).toBeLessThanOrEqual(1);
    // v1.18.0 — parity fields the iOS DTO previously dropped.
    expect(first.category).toEqual(expect.any(String));
    expect(first.points).toEqual(expect.any(Number));
    expect(first.target).toEqual(expect.any(Number));
    expect(first.current).toEqual(expect.any(Number));
    expect(first.isHidden).toEqual(expect.any(Boolean));
  });

  it("falls back to the legacy wrapped shape when no format is given", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { achievements: unknown[]; summary: unknown };
    };
    expect(body.data.achievements).toBeDefined();
    expect(body.data.summary).toBeDefined();
  });
});
