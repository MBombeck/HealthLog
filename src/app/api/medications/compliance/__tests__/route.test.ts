/**
 * v1.16.8 — batched card-compliance read (`GET /api/medications/compliance`).
 *
 * One round trip returns a compact adherence row per medication the
 * caller owns, replacing the per-card fan-out over the per-id endpoint.
 * The rows build through the SAME per-medication cache cells
 * (`${userId}|${medicationId}|compliance|${userTz}`) the per-id route
 * reads, so the two endpoints warm each other and invalidate together.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/cache/server-cache", () => ({
  cachedSwr: vi.fn(
    async (_cache: unknown, _key: string, builder: () => Promise<unknown>) =>
      builder(),
  ),
  caches: { medicationCompliance: {} },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  }),
}));

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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { cachedSwr } from "@/lib/cache/server-cache";
import { checkRateLimit } from "@/lib/rate-limit";

const TZ = "UTC";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    timezone: TZ,
  },
};

function dailySchedule(id: string) {
  return {
    id,
    windowStart: "08:00",
    windowEnd: "09:00",
    timesOfDay: ["08:00"],
    daysOfWeek: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    reminderGraceMinutes: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
  };
}

function medication(id: string) {
  return {
    id,
    userId: "user-1",
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
    startsOn: null,
    endsOn: null,
    oneShot: false,
    schedules: [dailySchedule(`${id}-sched`)],
    scheduleRevisions: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(cachedSwr).mockImplementation(
    async (_cache: unknown, _key: string, builder: () => Promise<unknown>) =>
      builder(),
  );
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 29,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/medications/compliance", () => {
  it("returns one compact row per medication, without the heatmap grid", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication("med-1"),
      medication("med-2"),
    ] as never);

    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const items = body.data as Array<Record<string, unknown>>;

    expect(items).toHaveLength(2);
    expect(items.map((i) => i.medicationId)).toEqual(["med-1", "med-2"]);
    for (const item of items) {
      expect(item.compliance7).toBeDefined();
      expect(item.compliance30).toBeDefined();
      expect(item.complianceDisplay).toBeDefined();
      // The heavy per-day grid stays on the per-id endpoint.
      expect(item).not.toHaveProperty("dailyCompliance");
    }
  });

  it("reads each medication through the shared per-medication cache cell", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      medication("med-1"),
      medication("med-2"),
    ] as never);

    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost"),
    );
    expect(res.status).toBe(200);

    // Same key shape as the per-id route, so the two endpoints warm each
    // other and `invalidateUserMedications` sweeps both with one prefix.
    const keys = vi.mocked(cachedSwr).mock.calls.map(([, key]) => key);
    expect(keys).toEqual([
      "user-1|med-1|compliance|UTC",
      "user-1|med-2|compliance|UTC",
    ]);
  });

  it("scopes the medication read to the calling user", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);

    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);

    const call = vi.mocked(prisma.medication.findMany).mock.calls[0][0] as {
      where: { userId: string };
    };
    expect(call.where.userId).toBe("user-1");
  });

  it("returns 429 when the per-user rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });

    const res = await (GET as (req: Request) => Promise<Response>)(
      new Request("http://localhost"),
    );
    expect(res.status).toBe(429);
    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledWith(
      "medication-compliance-summary:user-1",
      30,
      60_000,
    );
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
  });
});
