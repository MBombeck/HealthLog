/**
 * v1.42 — one account must not drain the instance-wide Open-Meteo budget.
 *
 * The backfill route shared the analytics-read bucket (120 a minute) and sent
 * every explicit range without a key, so one account could queue a
 * two-year backfill again and again. It is now held to three a rolling hour,
 * and to one queued backfill per twenty-minute slot, keyed on the account.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send, store } = vi.hoisted(() => ({
  send: vi.fn(),
  store: new Map<string, number>(),
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAuth: vi.fn(async () => ({ user: { id: "acct-1" } })),
  };
});
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send }),
}));
vi.mock("@/lib/rate-limit", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/rate-limit")>(
      "@/lib/rate-limit",
    );
  const counted = (limit: number) => async (key: string) => {
    const count = (store.get(key) ?? 0) + 1;
    store.set(key, count);
    return {
      allowed: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: Date.now() + 1000,
    };
  };
  return {
    ...actual,
    checkAnalyticsReadRateLimit: (id: string) =>
      counted(120)(`analytics-read:${id}`),
    checkEnvironmentBackfillRateLimit: (id: string) =>
      counted(actual.ENVIRONMENT_BACKFILL_LIMIT)(`environment-backfill:${id}`),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({
        homeLat: null,
        homeLocationEncrypted: new Uint8Array([1]),
        homeSince: new Date("2025-01-01T00:00:00Z"),
      })),
    },
  },
}));

import { POST } from "../route";

function post() {
  return new NextRequest("http://localhost/api/environment/backfill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ startDate: "2025-01-01", endDate: "2026-10-01" }),
  });
}

beforeEach(() => {
  store.clear();
  send.mockReset().mockResolvedValue("job-id");
});

describe("POST /api/environment/backfill budget protection", () => {
  it("sends with a per-account singleton key and slot", async () => {
    const res = await POST(post());
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith(
      "environment-fetch",
      expect.objectContaining({ userId: "acct-1" }),
      expect.objectContaining({
        singletonKey: "environment-backfill:acct-1",
        singletonSeconds: 20 * 60,
      }),
    );
  });

  it("answers 409 when the account's slot already holds a backfill", async () => {
    send.mockResolvedValue(null);
    const res = await POST(post());
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.meta.errorCode).toBe("environment.backfill_pending");
  });

  it("refuses the fourth backfill in an hour with 429", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await POST(post())).status).toBe(202);
    }
    const res = await POST(post());
    expect(res.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
