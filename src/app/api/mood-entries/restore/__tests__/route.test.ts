/**
 * v1.16.4 — POST /api/mood-entries/restore.
 *
 * Asserts the ownership-scoped un-tombstone contract that backs the
 * delete-Undo toast: only owned, currently-tombstoned rows are touched;
 * a forged / foreign / never-deleted id is a silent no-op (no 404
 * existence leak); the mood rollup recompute collapses to the unique
 * day set; the >200-id cap returns 422.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    moodEntry: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
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
  invalidateUserMood: vi.fn(),
}));
vi.mock("@/lib/rollups/mood-rollups", () => ({
  recomputeMoodBucketsForEntry: vi.fn().mockResolvedValue(undefined),
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
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMood } from "@/lib/cache/invalidate";
import { recomputeMoodBucketsForEntry } from "@/lib/rollups/mood-rollups";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/mood-entries/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(recomputeMoodBucketsForEntry).mockResolvedValue(undefined as never);
});

describe("POST /api/mood-entries/restore", () => {
  it("un-tombstones only owned, tombstoned rows and returns that count", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { moodLoggedAt: new Date("2026-01-01T08:00:00Z") },
      { moodLoggedAt: new Date("2026-01-01T20:00:00Z") },
    ] as never);
    vi.mocked(prisma.moodEntry.updateMany).mockResolvedValue({
      count: 2,
    } as never);

    const res = await POST(postReq({ ids: ["e1", "e2", "foreign"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { restored: number } };
    expect(body.data.restored).toBe(2);

    const call = vi.mocked(prisma.moodEntry.updateMany).mock.calls[0][0];
    expect(call.where).toMatchObject({
      id: { in: ["e1", "e2", "foreign"] },
      userId: "user-1",
      deletedAt: { not: null },
    });
    expect(call.data).toMatchObject({
      deletedAt: null,
      syncVersion: { increment: 1 },
    });

    expect(invalidateUserMood).toHaveBeenCalledWith("user-1");
  });

  it("collapses the mood rollup recompute to the unique day set, not per-row", async () => {
    // 3 restored rows across 2 distinct date labels → 2 recomputes.
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([
      { date: "2026-01-01" },
      { date: "2026-01-01" },
      { date: "2026-01-02" },
    ] as never);
    vi.mocked(prisma.moodEntry.updateMany).mockResolvedValue({
      count: 3,
    } as never);

    await POST(postReq({ ids: ["a", "b", "c"] }));

    expect(recomputeMoodBucketsForEntry).toHaveBeenCalledTimes(2);
  });

  it("is a no-op (restored: 0) when no id is owned + tombstoned", async () => {
    vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.moodEntry.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(postReq({ ids: ["foreign-1", "live-1"] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { restored: number } };
    expect(body.data.restored).toBe(0);
    expect(invalidateUserMood).not.toHaveBeenCalled();
    expect(recomputeMoodBucketsForEntry).not.toHaveBeenCalled();
  });

  it("rejects a batch over the 200-id cap with 422", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `e${i}`);
    const res = await POST(postReq({ ids }));
    expect(res.status).toBe(422);
    expect(prisma.moodEntry.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an empty id array with 422", async () => {
    const res = await POST(postReq({ ids: [] }));
    expect(res.status).toBe(422);
  });

  it("429s when the rate limit is exceeded", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false } as never);
    const res = await POST(postReq({ ids: ["e1"] }));
    expect(res.status).toBe(429);
    expect(prisma.moodEntry.updateMany).not.toHaveBeenCalled();
  });
});
