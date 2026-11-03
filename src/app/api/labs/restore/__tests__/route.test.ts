/**
 * `POST /api/labs/restore` — the un-tombstone behind the lab-history
 * delete-Undo toast.
 *
 * The route had no test of its own. It writes health data back into the
 * record and, until now, wrote no audit row for it: the trail showed a
 * deletion that appeared to have been reversed by nobody. With a delegate
 * able to act on a shared record that question has a second possible answer,
 * so the row is what makes it answerable.
 *
 * Also pins the ownership scope the affordance depends on — a forged,
 * foreign or never-deleted id is a silent no-op rather than a 404 existence
 * leak — because that scope lives in the mutation `where` and nothing else
 * asserted it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    labResult: { updateMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthScore: vi.fn(),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/labs/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 59,
    reset: Date.now() + 60_000,
  } as never);
  vi.mocked(prisma.labResult.updateMany).mockResolvedValue({
    count: 2,
  } as never);
});

describe("POST /api/labs/restore", () => {
  it("clears the tombstone on owned, currently-deleted rows only", async () => {
    const res = await POST(postReq({ ids: ["lab-1", "lab-2"] }));
    expect(res.status).toBe(200);

    const call = vi.mocked(prisma.labResult.updateMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      id: { in: ["lab-1", "lab-2"] },
      userId: "user-1",
      deletedAt: { not: null },
    });
    expect(call.data).toEqual({ deletedAt: null });
  });

  it("writes an audit row naming how many readings came back", async () => {
    await POST(postReq({ ids: ["lab-1", "lab-2"] }));

    expect(auditLog).toHaveBeenCalledTimes(1);
    const [action, payload] = vi.mocked(auditLog).mock.calls[0] as [
      string,
      { userId: string; details: Record<string, unknown> },
    ];
    expect(action).toBe("labResult.restore");
    expect(payload.userId).toBe("user-1");
    expect(payload.details).toMatchObject({ count: 2 });
  });

  it("reports zero and leaves the health score alone when nothing matched", async () => {
    vi.mocked(prisma.labResult.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(postReq({ ids: ["forged"] }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { restored: number } };
    expect(json.data.restored).toBe(0);
    expect(invalidateUserHealthScore).not.toHaveBeenCalled();
  });

  it("rejects an empty id list with 422 and touches nothing", async () => {
    const res = await POST(postReq({ ids: [] }));
    expect(res.status).toBe(422);
    expect(prisma.labResult.updateMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it("returns 429 without restoring when the rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const res = await POST(postReq({ ids: ["lab-1"] }));
    expect(res.status).toBe(429);
    expect(prisma.labResult.updateMany).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });
});
