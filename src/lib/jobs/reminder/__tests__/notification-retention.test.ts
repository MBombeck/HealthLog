import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pushFindMany: vi.fn(),
  pushDeleteMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  authorizationDeleteMany: vi.fn(),
  meta: {} as Record<string, unknown>,
}));

vi.mock("../shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkerPrisma: () => ({
    pushAttempt: { findMany: h.pushFindMany, deleteMany: h.pushDeleteMany },
    notificationEvent: { deleteMany: h.eventDeleteMany },
    notificationEgressAuthorization: { deleteMany: h.authorizationDeleteMany },
  }),
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: {
      addMeta: (key: string, value: unknown) => void;
      addWarning: (warning: string) => void;
    }) => Promise<unknown>,
  ) =>
    fn({
      addMeta: (key, value) => {
        h.meta[key] = value;
      },
      addWarning: vi.fn(),
    }),
}));

import { handlePushAttemptCleanup } from "../cleanup-handlers";

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(h.meta)) delete h.meta[key];
  h.pushFindMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
  h.pushDeleteMany.mockResolvedValue({ count: 3 });
  h.eventDeleteMany.mockResolvedValue({ count: 5 });
  h.authorizationDeleteMany.mockResolvedValue({ count: 7 });
});

describe("notification retention", () => {
  it("prunes notification ledgers with the canonical bounded attempt retention", async () => {
    await handlePushAttemptCleanup([]);

    // The attempt ledger has no index on its age, so it goes in batches:
    // the ids past the horizon, then exactly those.
    expect(h.pushFindMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
      select: { id: true },
      take: 5_000,
    });
    expect(h.pushDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b", "c"] } },
    });
    // State-scoped admin-config-notice anchors live as long as the state
    // they describe; the horizon prune must leave them alone or the
    // once-per-state notice re-fires every 90 days.
    expect(h.eventDeleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: expect.any(Date) },
        eventType: { not: "ADMIN_CONFIG_NOTICE" },
      },
    });
    expect(h.authorizationDeleteMany).toHaveBeenCalledWith({
      where: { authorizedAt: { lt: expect.any(Date) } },
    });
    expect(h.meta.push_attempt_cleanup_deleted).toBe(3);
    expect(h.meta.notification_event_cleanup_deleted).toBe(5);
    expect(h.meta.notification_egress_authorization_cleanup_deleted).toBe(7);
  });
});
