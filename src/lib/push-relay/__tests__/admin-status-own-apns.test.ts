/**
 * The relay card's `ownApnsKey`: a server with an APNs key of its own sends
 * every push directly to Apple (`routeFor`), so the admin status says the
 * key is in use and the relay is not, and the relay question is not asked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apns = vi.hoisted(() => ({ config: null as object | null }));

vi.mock("@/lib/db", () => ({
  prisma: {
    device: { count: vi.fn().mockResolvedValue(0) },
    pushRelayDelivery: {
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    pushRelayUnbind: { count: vi.fn().mockResolvedValue(0) },
    pushRelayRegistration: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi
      .fn()
      .mockResolvedValue([{ count: 0, retried: 0, p50: null, p95: null }]),
  },
}));

vi.mock("@/lib/notifications/senders/apns", () => ({
  loadApnsConfig: () => apns.config,
}));

vi.mock("@/lib/push-relay/registration", () => ({
  loadRegistration: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/push-relay/operator-decision", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/push-relay/operator-decision")
  >()),
  loadStoredRelayDecision: vi.fn().mockResolvedValue(null),
}));

import { adminRelayStatus } from "@/lib/push-relay/admin-status";
import { routeFor } from "@/lib/push-relay/route-device";

/** A device bound at the relay with consent: the relay's best case. */
const boundDevice = {
  id: "d1",
  apnsToken: "token",
  apnsEnvironment: "production",
  pushKeyPublic: "key",
  relayState: "bound",
  relayConsentAt: new Date("2026-11-20T08:00:00.000Z"),
};

beforeEach(() => {
  apns.config = null;
});

describe("adminRelayStatus ownApnsKey", () => {
  it("says the own APNs key is in use, and nothing asks about the relay", async () => {
    apns.config = { bundleId: "dev.healthlog.app" };
    const status = await adminRelayStatus();
    expect(status.ownApnsKey).toBe(true);
    expect(status.operatorDecision).toBe("off");
    // What the card says is what the send does: even a bound device with
    // consent on a registered server goes direct.
    expect(
      routeFor(boundDevice, {
        apnsConfigured: status.ownApnsKey,
        registration: { instanceId: "i1" },
        canSeal: true,
      }),
    ).toBe("direct");
  });

  it("is false without a key of the server's own, and the relay carries the push", async () => {
    const status = await adminRelayStatus();
    expect(status.ownApnsKey).toBe(false);
    expect(
      routeFor(boundDevice, {
        apnsConfigured: status.ownApnsKey,
        registration: { instanceId: "i1" },
        canSeal: true,
      }),
    ).toBe("relay");
  });
});
