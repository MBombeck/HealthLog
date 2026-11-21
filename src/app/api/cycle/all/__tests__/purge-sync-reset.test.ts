/**
 * `DELETE /api/cycle/all` hard-deletes every cycle row without tombstones, so
 * the feed must be reset inside the same transaction. Without it a paired
 * client keeps its mirror of the purged rows: the next pull carries nothing
 * about them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const order = vi.hoisted(() => [] as string[]);
const tx = vi.hoisted(() => {
  const counted = (name: string) =>
    vi.fn(async () => {
      order.push(name);
      return { count: 1 };
    });
  return {
    cycleDayLog: { deleteMany: counted("cycleDayLog") },
    cycleSymptom: { deleteMany: counted("cycleSymptom") },
    cyclePrediction: { deleteMany: counted("cyclePrediction") },
    menstrualCycle: { deleteMany: counted("menstrualCycle") },
    auditLog: { deleteMany: counted("auditLog") },
    pushAttempt: { deleteMany: counted("pushAttempt") },
    cycleProfile: { updateMany: counted("cycleProfile") },
    user: {
      update: vi.fn(async () => {
        order.push("user.syncResetAt");
        return {};
      }),
    },
  };
});
const db = vi.hoisted(() => ({
  $transaction: vi.fn(async (run: (t: unknown) => Promise<unknown>) => {
    order.push("tx.begin");
    const out = await run(tx);
    order.push("tx.commit");
    return out;
  }),
}));

vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthContext: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cycle/gate", () => ({ requireCycleEnabled: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 29 }),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { DELETE } from "../route";
import { getSession } from "@/lib/auth/session";
import { requireCycleEnabled } from "@/lib/cycle/gate";

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  vi.mocked(getSession).mockResolvedValue({
    session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
    user: { id: "user-1", username: "t", role: "USER", gender: "FEMALE" },
  } as never);
  vi.mocked(requireCycleEnabled).mockResolvedValue({
    enabled: true,
    profile: {} as never,
  });
});

describe("DELETE /api/cycle/all", () => {
  it("resets the sync feed inside the purge transaction", async () => {
    const res = await DELETE(
      new NextRequest("http://localhost/api/cycle/all", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { syncResetAt: expect.any(Date) },
    });
    const reset = order.indexOf("user.syncResetAt");
    expect(reset).toBeGreaterThan(order.indexOf("cycleDayLog"));
    expect(reset).toBeGreaterThan(order.indexOf("menstrualCycle"));
    expect(reset).toBeLessThan(order.indexOf("tx.commit"));
  });
});
