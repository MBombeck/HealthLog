/**
 * `POST /api/daily/digest/dismiss` — the Today rail dismiss surface.
 *
 * Under test: cookie/Bearer auth narrows the user, the `insights` module gate
 * returns a 403 `module.disabled` envelope when off, an `itemKey` that isn't
 * namespaced under a dismissible kind 422s BEFORE any DB write, and the happy
 * path upserts the `DismissedPriorityItem` row scoped to the caller.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    dismissedPriorityItem: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 60,
    remaining: 39,
    resetAt: Date.now() + 60_000,
  })),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthScore: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return { ...actual, annotate: vi.fn() };
});
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { apiError } from "@/lib/api-response";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    locale: "en",
  },
};

const callPost = POST as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost/api/daily/digest/dismiss"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
});

describe("POST /api/daily/digest/dismiss", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    const res = await callPost(
      makeReq({ itemKey: "milestone:record_first:WEIGHT:2026-07-16" }),
    );
    expect(res.status).toBe(401);
    expect(prisma.dismissedPriorityItem.upsert).not.toHaveBeenCalled();
  });

  it("returns the 403 module.disabled envelope when insights is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "insights" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "insights",
      }),
    });
    const res = await callPost(
      makeReq({ itemKey: "milestone:record_first:WEIGHT:2026-07-16" }),
    );
    expect(res.status).toBe(403);
    expect(prisma.dismissedPriorityItem.upsert).not.toHaveBeenCalled();
  });

  it("422s an itemKey that isn't namespaced under a dismissible kind — an actionable item can never be dismissed", async () => {
    const res = await callPost(makeReq({ itemKey: "dose_window:anything" }));
    expect(res.status).toBe(422);
    expect(prisma.dismissedPriorityItem.upsert).not.toHaveBeenCalled();
  });

  it("422s a missing itemKey", async () => {
    const res = await callPost(makeReq({}));
    expect(res.status).toBe(422);
  });

  it("422s an unknown extra field (strict schema)", async () => {
    const res = await callPost(
      makeReq({
        itemKey: "milestone:record_first:WEIGHT:2026-07-16",
        userId: "someone-else",
      }),
    );
    expect(res.status).toBe(422);
    expect(prisma.dismissedPriorityItem.upsert).not.toHaveBeenCalled();
  });

  it("upserts each approved observational or notice dismissal for the caller", async () => {
    for (const itemKey of [
      "milestone:record_first:WEIGHT:2026-07-16",
      "ecg_new_recording:2026-07-16T08:00:00.000Z",
      "tension_window:2026-07-16:afternoon",
      "same_time_baseline:2026-07-16:ACTIVITY_STEPS",
      "health_score_algorithm:2",
    ]) {
      vi.mocked(prisma.dismissedPriorityItem.upsert).mockClear();
      const res = await callPost(makeReq({ itemKey }));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual({ dismissed: true });
      expect(prisma.dismissedPriorityItem.upsert).toHaveBeenCalledWith({
        where: { userId_itemKey: { userId: "user-1", itemKey } },
        update: {},
        create: { userId: "user-1", itemKey },
      });
    }
  });

  it("returns 429 when the caller's dismiss rate limit is exhausted", async () => {
    const { checkRateLimit } = await import("@/lib/rate-limit");
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await callPost(
      makeReq({ itemKey: "milestone:record_first:WEIGHT:2026-07-16" }),
    );
    expect(res.status).toBe(429);
    expect(prisma.dismissedPriorityItem.upsert).not.toHaveBeenCalled();
  });

  it("evicts score-bearing server caches after the algorithm notice write", async () => {
    const res = await callPost(
      makeReq({ itemKey: "health_score_algorithm:2" }),
    );
    expect(res.status).toBe(200);
    expect(invalidateUserHealthScore).toHaveBeenCalledWith("user-1");
  });
});
