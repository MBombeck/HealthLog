/**
 * Turning the subscription off audits the feeds this request revoked, not
 * the one it read first. A rotation that commits while the DELETE waits has
 * already revoked that one and made a successor; the second pass revokes the
 * successor, and the trail must name it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  requireGuardianAuth: vi.fn(),
  findLiveFeed: vi.fn(),
  updateMany: vi.fn(),
  findMany: vi.fn(),
  audit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireGuardianAuth: m.requireGuardianAuth,
  assertRecentCookieProof: vi.fn(),
}));
vi.mock("@/lib/cycle/feed/status", () => ({
  FEED_SUMMARY_SELECT: {},
  cycleFeedStatus: vi.fn(),
  findLiveFeed: m.findLiveFeed,
  toFeedSummary: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    cycleCalendarFeed: { updateMany: m.updateMany, findMany: m.findMany },
  },
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: m.audit }));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { DELETE } from "../route";

const OLD = {
  id: "feed-old",
  tokenPrefix: "hlf_old",
  createdAt: new Date("2026-11-01T00:00:00Z"),
};
const SUCCESSOR = {
  id: "feed-new",
  tokenPrefix: "hlf_new",
  createdAt: new Date("2026-11-10T00:00:00Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  m.requireGuardianAuth.mockResolvedValue({
    authMethod: "cookie",
    user: { id: "u1" },
  });
  m.findLiveFeed.mockResolvedValue(OLD);
});

describe("DELETE /api/cycle/feed-subscription", () => {
  it("audits the successor a racing rotation made, not the feed read first", async () => {
    // The rotation revoked OLD before the first pass, so the first pass
    // revokes nothing and the second revokes the successor.
    m.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    m.findMany.mockResolvedValue([SUCCESSOR]);

    const res = await (DELETE as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);

    const stamp = m.updateMany.mock.calls[0]![0].data.revokedAt as Date;
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", revokedAt: stamp },
      }),
    );
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(m.audit).toHaveBeenCalledWith(
      "cycle.feed.revoke",
      expect.objectContaining({
        userId: "u1",
        details: expect.objectContaining({ feedId: SUCCESSOR.id }),
      }),
    );
  });

  it("audits every feed the request revoked", async () => {
    m.updateMany.mockResolvedValue({ count: 1 });
    m.findMany.mockResolvedValue([OLD, SUCCESSOR]);

    await (DELETE as unknown as () => Promise<Response>)();
    expect(m.audit.mock.calls.map((c) => c[1].details.feedId)).toEqual([
      OLD.id,
      SUCCESSOR.id,
    ]);
  });

  it("writes no revoke row when another request already turned it off", async () => {
    m.updateMany.mockResolvedValue({ count: 0 });
    m.findMany.mockResolvedValue([]);

    const res = await (DELETE as unknown as () => Promise<Response>)();
    expect(res.status).toBe(200);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
