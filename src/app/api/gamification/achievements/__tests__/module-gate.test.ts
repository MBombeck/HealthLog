import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.18.0 — the achievements module gate on
 * `GET /api/gamification/achievements`.
 *
 * Disabled  ⇒ a 403 `module.disabled` envelope, and the heavy badge
 *             aggregation never runs (no Prisma reads, no unlock
 *             persistence). This is what makes the surface DISAPPEAR for
 *             an account that has turned the module off — the web page,
 *             the dashboard tile, and the unlock notifier all gate the
 *             same route and the same `/api/auth/me` module map.
 * Enabled   ⇒ the route behaves exactly as before (200 + payload).
 */

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
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// The module gate is mocked directly so this test asserts the route's
// branch on the gate decision, not the resolver internals (those have
// their own unit coverage in src/lib/modules/__tests__/gate.test.ts).
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
  resolveModuleMap: vi.fn(),
  MODULE_DISABLED_ERROR_CODE: "module.disabled",
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled, resolveModuleMap } from "@/lib/modules/gate";
import { apiError } from "@/lib/api-response";
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
  // v1.18.0 — default to "every module on" so individual cases only
  // flip the one key under test.
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
});

describe("GET /api/gamification/achievements — achievements module gate", () => {
  it("returns the 403 module.disabled envelope when the module is off", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "achievements" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "achievements",
      }),
    });

    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      data: null;
      error: string;
      meta: { errorCode: string; module: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta.errorCode).toBe("module.disabled");
    expect(body.meta.module).toBe("achievements");

    // The disappearance is total: no badge aggregation ran.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.measurement.findMany).not.toHaveBeenCalled();
    expect(prisma.userAchievement.findMany).not.toHaveBeenCalled();
    expect(prisma.userAchievement.createMany).not.toHaveBeenCalled();
  });

  it("serves the payload normally when the module is enabled", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });

    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { achievements: unknown[]; summary: unknown };
    };
    expect(body.data.achievements).toBeDefined();
    expect(body.data.summary).toBeDefined();
    expect(prisma.userAchievement.findMany).toHaveBeenCalled();
  });

  it("still 401s before the module gate when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );

    expect(res.status).toBe(401);
    // Auth is the outer guard — the module gate is never consulted.
    expect(requireModuleEnabled).not.toHaveBeenCalled();
  });
});

describe("GET /api/gamification/achievements — per-module badge skipping", () => {
  // Three mood entries make the mood badges earnable (hasMood = true) so
  // they survive the discovery filter when the mood module is ON — which
  // means a later disappearance can only be the B5 module filter.
  const MOOD_ENTRIES = [
    {
      date: "2026-03-02",
      score: 4,
      moodLoggedAt: new Date("2026-03-02T08:00:00.000Z"),
    },
    {
      date: "2026-03-03",
      score: 5,
      moodLoggedAt: new Date("2026-03-03T08:00:00.000Z"),
    },
    {
      date: "2026-03-04",
      score: 5,
      moodLoggedAt: new Date("2026-03-04T08:00:00.000Z"),
    },
  ];

  type Badge = { id: string; category: string; metric: string };

  async function badgesFor(
    moduleMap: Record<string, boolean>,
  ): Promise<Badge[]> {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
    vi.mocked(resolveModuleMap).mockResolvedValue(moduleMap as never);
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue(
      MOOD_ENTRIES as never,
    );

    const res = await GET(
      new NextRequest("http://localhost/api/gamification/achievements"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { achievements: Badge[] } };
    return body.data.achievements;
  }

  it("includes mood badges when the mood module is enabled", async () => {
    const badges = await badgesFor({ mood: true });
    expect(badges.some((b) => b.category === "mood")).toBe(true);
  });

  it("drops every mood badge when the mood module is disabled", async () => {
    const badges = await badgesFor({ mood: false });
    expect(badges.some((b) => b.category === "mood")).toBe(false);
    // Non-mood badges still render — the filter is surgical, not global.
    expect(badges.length).toBeGreaterThan(0);
  });

  // The "a disabled module never gets its badge pinned" invariant moved with
  // the write itself — see `src/lib/jobs/__tests__/achievement-unlock-sweep.test.ts`.
  // That this route persists nothing at all is proved in
  // `writes-nothing.test.ts`, against a result that HAS a pending unlock.
});
