/**
 * What the relay can tell pushes apart by: nothing beyond the class.
 *
 * Beside the sealed envelope a `/v1/push` item carries `class`, `ttlSeconds`
 * and `collapse` in the clear (`spec/protocol.md`), and the relay derives the
 * APNs priority from the class. A lifetime per kind of push used to ride in
 * `ttlSeconds`, which told a reminder (15 min) from a dose confirmation (2 h),
 * a test push (10 min) and every other alert (6 h). This drives every kind of
 * sealed push through the real send paths to one relay-bound device and
 * asserts that, within each class, every item has the same field set, the
 * same `ttlSeconds`, the same envelope length and the same collapse length.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { FakeRelay, RELAY_PUBLIC_KEY, RELAY_URL } from "./push-relay-fake";

const relay = vi.hoisted(() => ({
  current: null as null | {
    handle: (url: string | URL, init?: RequestInit) => Promise<Response>;
  },
}));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (url: string | URL, init?: RequestInit) => {
      if (!relay.current) throw new Error("no fake relay");
      return relay.current.handle(url, init);
    },
  };
});

import { getPrismaClient, truncateAllTables } from "./setup";
import { bindDevice, enableRelay } from "./push-relay-kit";

const APNS_ENV_KEYS = [
  "APNS_KEY_ID",
  "APNS_TEAM_ID",
  "APNS_BUNDLE_ID",
  "APNS_KEY",
  "APNS_KEY_FILE",
  "APNS_PRODUCTION",
] as const;

let fake: FakeRelay;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("PUSH_RELAY_URL", RELAY_URL);
  vi.stubEnv("PUSH_RELAY_KEYS", RELAY_PUBLIC_KEY);
  for (const k of APNS_ENV_KEYS) vi.stubEnv(k, "");
  (await import("@/lib/notifications/senders/apns")).resetApnsForTesting();
  await truncateAllTables(getPrismaClient());
  fake = new FakeRelay();
  relay.current = fake;
});

/** What the relay sees of one item, the envelope's bytes aside. */
function shape(item: Record<string, unknown>) {
  return {
    keys: Object.keys(item)
      .filter((k) => k !== "ref" && k !== "token")
      .sort(),
    class: item.class,
    env: item.env,
    ttlSeconds: item.ttlSeconds,
    envelopeLength: String(item.envelope ?? "").length,
    collapseLength: String(item.collapse ?? "").length,
  };
}

describe("relay wire metadata", () => {
  it("lets no two kinds of sealed push differ beyond their class", async () => {
    const prisma = getPrismaClient();
    const { instanceId, admin, adminSession } = await enableRelay();
    // The admin's own device, so the relay test push has somewhere to go.
    const { deviceId } = await bindDevice(
      instanceId,
      "c1".repeat(32),
      adminSession,
    );
    await prisma.device.update({
      where: { id: deviceId },
      data: { medicationDelivery: "server" },
    });

    const { sendApnsChannel } = await import("@/lib/push-relay/apns-channel");
    const alerts: Array<Parameters<typeof sendApnsChannel>[1]> = [
      {
        eventType: "MEDICATION_REMINDER",
        title: "Time for your medication",
        message: "1 tablet",
        metadata: {
          medicationId: "med-1",
          scheduledAt: "2026-11-22T08:00:00.000Z",
          webPushTag: "med-1-slot",
        },
      },
      {
        eventType: "SECURITY_ALERT",
        title: "New sign-in",
        message: "A new device signed in.",
        metadata: { securityKind: "new_device" },
      },
      {
        eventType: "MEDICATION_LOW_STOCK",
        title: "Running low",
        message: "About 5 days left.",
        metadata: { medicationId: "med-1" },
      },
      {
        eventType: "SYSTEM_ALERT",
        title: "Server notice",
        message: "Something needs a look.",
        urgent: true,
      },
    ];
    for (const payload of alerts) {
      await sendApnsChannel(admin.id, payload, { serverDeviceIds: [deviceId] });
    }

    const { loadPushContext, ROUTABLE_DEVICE_SELECT } =
      await import("@/lib/push-relay/route-device");
    const device = await prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      select: ROUTABLE_DEVICE_SELECT,
    });
    const ctx = await loadPushContext();
    const { sendSealedIntakeRecorded, sendSealedIntakeSync } =
      await import("@/lib/push-relay/medication-pushes");
    await sendSealedIntakeRecorded(
      [device],
      {
        medicationId: "med-1",
        intakeId: "intake-1",
        slotInstant: new Date("2026-11-22T08:00:00.000Z"),
        outcome: "taken",
        takenAt: new Date(),
        takenVia: "INTEGRATION",
      },
      { title: "Dose recorded", body: "Recorded on another device." },
      ctx,
    );
    const { sendRelayTestPush } = await import("@/lib/push-relay/test-push");
    expect((await sendRelayTestPush(admin.id)).outcome).toBe("accepted");

    await sendSealedIntakeSync([device], ctx);
    const { sendWake } = await import("@/lib/push-relay/wakes");
    await sendWake(
      "DATA_CHANGED",
      [device],
      { domains: ["sleep"], changedAt: new Date().toISOString() },
      { ctx, collapseKey: "data-changed" },
    );
    await sendWake(
      "HEALTHKIT_CATCH_UP",
      [device],
      { requestedAt: new Date().toISOString() },
      { ctx, collapseKey: "healthkit-catch-up" },
    );

    // Every kind reached the relay: four dispatcher alerts, the dose
    // confirmation and the test push; the intake sync and two wakes.
    const byClass = new Map<string, ReturnType<typeof shape>[]>();
    for (const item of fake.wire) {
      const list = byClass.get(String(item.class)) ?? [];
      list.push(shape(item));
      byClass.set(String(item.class), list);
    }
    expect(byClass.get("alert")).toHaveLength(alerts.length + 2);
    expect(byClass.get("silent")).toHaveLength(3);

    for (const [, shapes] of byClass) {
      const distinct = new Set(shapes.map((s) => JSON.stringify(s)));
      expect([...distinct]).toHaveLength(1);
    }
    // The class's one lifetime, rounded down to the minute on the wire.
    expect(byClass.get("alert")![0]!.ttlSeconds).toBe(14 * 60);
    expect(byClass.get("silent")![0]!.ttlSeconds).toBe(59 * 60);
    // The ledger keeps the same deadline per class, whatever the kind.
    const rows = await prisma.pushRelayDelivery.findMany({
      where: { deviceId },
      select: { pushClass: true, createdAt: true, expiresAt: true },
    });
    for (const row of rows) {
      const lifetime =
        (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000;
      const expected = row.pushClass === "alert" ? 900 : 3600;
      expect(Math.abs(lifetime - expected)).toBeLessThan(2);
    }
  });
});
