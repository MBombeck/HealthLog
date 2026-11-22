/**
 * v1.4.23 — `POST /api/devices` integration test.
 *
 * Locks in three guarantees:
 *
 *  1. Registering a device with an `apnsToken` auto-creates a
 *     `NotificationChannel { type: "APNS" }` row for the user. Without
 *     this row the dispatcher's APNS branch never fires (HIGH-1 in the
 *     v1.4.23 W6 code review).
 *  2. Registering without an `apnsToken` does NOT create the channel —
 *     the iOS client may upsert device metadata before APNs grants a
 *     token, and we must not enable APNs delivery prematurely.
 *  3. Re-registering the same `apnsToken` is idempotent, including when the
 *     legacy token changes: the route returns 201 and keeps one canonical
 *     device and one channel. A token another account holds is taken over
 *     (iOS #190, #191): that account's row goes with its push credentials.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

// Every dispatch, with the devices its account still held at that moment.
const dispatched = vi.hoisted(
  () =>
    [] as Array<{
      userId: string;
      eventType: string;
      metadata: unknown;
      deviceIds: string[];
    }>,
);
vi.mock("@/lib/notifications/dispatcher", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/notifications/dispatcher")>();
  return {
    ...actual,
    dispatchNotification: async (
      input: Parameters<typeof actual.dispatchNotification>[0],
    ) => {
      const devices = await getPrismaClient().device.findMany({
        where: { userId: input.userId },
        select: { id: true },
      });
      dispatched.push({
        userId: input.userId,
        eventType: input.eventType,
        metadata: input.metadata,
        deviceIds: devices.map((d) => d.id),
      });
      return actual.dispatchNotification(input);
    },
  };
});

beforeEach(async () => {
  dispatched.length = 0;
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: { username, email: `${username}@example.test` },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

function buildRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function registerDevice(body: Record<string, unknown>) {
  // Load after the test env and next/headers mock are installed.
  const { POST } = await import("@/app/api/devices/route");
  return (POST as (request: NextRequest) => Promise<Response>)(
    buildRequest(body),
  );
}

describe("POST /api/devices", () => {
  it("auto-upserts a NotificationChannel { type: APNS } when apnsToken is supplied", async () => {
    const user = await seedSession("device-apns-channel");
    const res = await registerDevice({
      token: "legacy-token-1",
      bundleId: "io.healthlog.ios",
      apnsToken: "abcdef0123456789",
      apnsEnvironment: "sandbox",
    });
    expect(res.status).toBe(201);

    const channel = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channel).not.toBeNull();
    expect(channel?.enabled).toBe(true);
  });

  it("does NOT create an APNS channel when apnsToken is omitted", async () => {
    const user = await seedSession("device-no-apns");
    const res = await registerDevice({
      token: "legacy-token-2",
      bundleId: "io.healthlog.ios",
    });
    expect(res.status).toBe(201);

    const channel = await getPrismaClient().notificationChannel.findFirst({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channel).toBeNull();
  });

  it("re-registering the same apnsToken for the same user keeps the channel row at one", async () => {
    const user = await seedSession("device-apns-idempotent");
    const first = await registerDevice({
      token: "legacy-token-3",
      bundleId: "io.healthlog.ios",
      apnsToken: "deadbeef",
      apnsEnvironment: "sandbox",
    });
    expect(first.status).toBe(201);

    const second = await registerDevice({
      token: "legacy-token-3",
      bundleId: "io.healthlog.ios",
      apnsToken: "deadbeef",
      apnsEnvironment: "sandbox",
    });
    expect(second.status).toBe(201);

    const channels = await getPrismaClient().notificationChannel.findMany({
      where: { userId: user.id, type: "APNS" },
    });
    expect(channels).toHaveLength(1);
  });

  it("reconciles a changed legacy token onto the same user's APNs device", async () => {
    const user = await seedSession("device-changed-token");
    const prisma = getPrismaClient();

    const first = await registerDevice({
      token: "legacy-token-old",
      bundleId: "io.healthlog.ios",
      apnsToken: "aaaabbbbccccdddd",
      apnsEnvironment: "sandbox",
      appVersion: "1.0.0",
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string } };
    const refreshToken = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: "changed-token-refresh-hash",
        deviceId: "legacy-token-old",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const second = await registerDevice({
      token: "legacy-token-new",
      bundleId: "io.healthlog.ios.beta",
      apnsToken: "aaaabbbbccccdddd",
      apnsEnvironment: "production",
      appVersion: "2.0.0",
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string } };

    expect(secondBody.data.id).toBe(firstBody.data.id);
    const devices = await prisma.device.findMany({
      where: { userId: user.id },
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: firstBody.data.id,
      token: "legacy-token-new",
      bundleId: "io.healthlog.ios.beta",
      apnsToken: "aaaabbbbccccdddd",
      apnsEnvironment: "production",
      appVersion: "2.0.0",
    });
    await expect(
      prisma.refreshToken.findUniqueOrThrow({
        where: { id: refreshToken.id },
        select: { deviceId: true },
      }),
    ).resolves.toEqual({ deviceId: "legacy-token-new" });
  });

  it("merges same-user device identities and migrates only owned refresh-token bindings", async () => {
    const user = await seedSession("device-identity-merge");
    const prisma = getPrismaClient();
    const otherUser = await prisma.user.create({
      data: {
        username: "device-identity-merge-other",
        email: "device-identity-merge-other@example.test",
      },
    });
    const apnsDevice = await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "legacy-token-original",
        bundleId: "io.healthlog.ios",
        apnsToken: "1111222233334444",
        apnsEnvironment: "sandbox",
        medicationDelivery: "server",
        liveActivityPushToken: "feedface".repeat(8),
      },
    });
    await prisma.device.create({
      data: {
        userId: user.id,
        platform: "ios",
        token: "legacy-token-current",
        bundleId: "io.healthlog.ios",
        medicationDelivery: null,
        liveActivityPushToken: null,
      },
    });
    const ownedRefreshToken = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: "owned-refresh-token-hash",
        deviceId: "legacy-token-original",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const foreignRefreshToken = await prisma.refreshToken.create({
      data: {
        userId: otherUser.id,
        tokenHash: "foreign-refresh-token-hash",
        deviceId: "legacy-token-original",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await registerDevice({
      token: "legacy-token-current",
      bundleId: "io.healthlog.ios.updated",
      apnsToken: "1111222233334444",
      apnsEnvironment: "production",
      model: "iPhone17,1",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };
    expect(body.data.id).toBe(apnsDevice.id);

    const devices = await prisma.device.findMany({
      where: { userId: user.id },
    });
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: apnsDevice.id,
      token: "legacy-token-current",
      bundleId: "io.healthlog.ios.updated",
      apnsToken: "1111222233334444",
      apnsEnvironment: "production",
      model: "iPhone17,1",
      medicationDelivery: null,
      liveActivityPushToken: null,
    });
    await expect(
      prisma.refreshToken.findUniqueOrThrow({
        where: { id: ownedRefreshToken.id },
        select: { deviceId: true },
      }),
    ).resolves.toEqual({ deviceId: "legacy-token-current" });
    await expect(
      prisma.refreshToken.findUniqueOrThrow({
        where: { id: foreignRefreshToken.id },
        select: { deviceId: true },
      }),
    ).resolves.toEqual({ deviceId: "legacy-token-original" });
  });

  it("takes over an APNs token another account holds, with nothing of that account left on it", async () => {
    const user = await seedSession("device-apns-takeover");
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "device-apns-owner",
        email: "device-apns-owner@example.test",
      },
    });
    const apns = "ab".repeat(32);
    const ownedDevice = await prisma.device.create({
      data: {
        userId: owner.id,
        platform: "ios",
        token: "owner-install-token",
        bundleId: "io.healthlog.ios",
        apnsToken: apns,
        apnsEnvironment: "sandbox",
        pushKeyPublic: "A".repeat(43),
        pushKeySuites: [1],
        relayState: "bound",
        relayConsentAt: new Date(),
        relayConsentVersion: "1",
        liveActivityPushToken: "cd".repeat(32),
        laStartToken: "ef".repeat(32),
      },
    });
    // The previous account's second phone keeps its pushes.
    const otherDevice = await prisma.device.create({
      data: {
        userId: owner.id,
        platform: "ios",
        token: "owner-second-phone",
        bundleId: "io.healthlog.ios",
        apnsToken: "9a".repeat(32),
        apnsEnvironment: "production",
      },
    });
    const medication = await prisma.medication.create({
      data: { userId: owner.id, name: "Owner med", dose: "1" },
    });
    await prisma.liveActivityToken.create({
      data: {
        deviceId: ownedDevice.id,
        pushToken: "12".repeat(32),
        medicationId: medication.id,
      },
    });

    const response = await registerDevice({
      token: "taker-install-token",
      bundleId: "io.healthlog.ios.changed",
      apnsToken: apns.toUpperCase(),
      apnsEnvironment: "production",
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { id: string } };

    // The previous account's row went, with its push key, binding and Live
    // Activity state.
    await expect(
      prisma.device.count({ where: { id: ownedDevice.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.liveActivityToken.count({ where: { deviceId: ownedDevice.id } }),
    ).resolves.toBe(0);
    const taken = await prisma.device.findUniqueOrThrow({
      where: { id: body.data.id },
    });
    expect(taken).toMatchObject({
      userId: user.id,
      token: "taker-install-token",
      apnsToken: apns,
      apnsEnvironment: "production",
      pushKeyPublic: null,
      relayState: "none",
      relayConsentAt: null,
      liveActivityPushToken: null,
      laStartToken: null,
    });
    // Both accounts can see what happened, without the token itself.
    const audits = await prisma.auditLog.findMany({
      where: {
        action: {
          in: ["devices.register.takeover", "devices.register.taken_over"],
        },
      },
      select: { userId: true, action: true, details: true },
    });
    expect(audits.map((a) => [a.userId, a.action]).sort()).toEqual(
      [
        [owner.id, "devices.register.taken_over"],
        [user.id, "devices.register.takeover"],
      ].sort(),
    );
    for (const audit of audits) expect(audit.details ?? "").not.toContain(apns);
    // The previous account hears of it, on what it still has: the taken-over
    // row is gone before the alert is dispatched.
    expect(dispatched.filter((d) => d.eventType === "SECURITY_ALERT")).toEqual([
      {
        userId: owner.id,
        eventType: "SECURITY_ALERT",
        metadata: { securityKind: "device_reassigned" },
        deviceIds: [otherDevice.id],
      },
    ]);
  });

  it("takes over the same install token (X-Device-Id) another account registered", async () => {
    const user = await seedSession("device-token-takeover");
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "device-token-owner",
        email: "device-token-owner@example.test",
      },
    });
    const previous = await prisma.device.create({
      data: {
        userId: owner.id,
        platform: "ios",
        token: "shared-install-token",
        bundleId: "io.healthlog.ios",
        medicationDelivery: "client",
      },
    });

    const response = await registerDevice({
      token: "shared-install-token",
      bundleId: "io.healthlog.ios",
      apnsToken: "fe".repeat(32),
      apnsEnvironment: "production",
    });
    expect(response.status).toBe(201);

    await expect(
      prisma.device.count({ where: { id: previous.id } }),
    ).resolves.toBe(0);
    const rows = await prisma.device.findMany({
      where: { token: "shared-install-token" },
    });
    expect(rows).toHaveLength(1);
    // The previous account's per-device choice does not carry over.
    expect(rows[0]).toMatchObject({
      userId: user.id,
      medicationDelivery: null,
    });
    await expect(
      prisma.device.count({ where: { userId: owner.id } }),
    ).resolves.toBe(0);
  });

  it("stores a bounded localRunwayUntil, clears it on null, keeps it when omitted", async () => {
    const user = await seedSession("device-local-runway");
    const prisma = getPrismaClient();
    const base = {
      token: "runway-install-token",
      bundleId: "io.healthlog.ios",
      medicationDelivery: "client",
    };
    const inAWeek = new Date(Date.now() + 7 * 86_400_000);
    expect(
      (
        await registerDevice({
          ...base,
          localRunwayUntil: inAWeek.toISOString(),
        })
      ).status,
    ).toBe(201);
    const stored = () =>
      prisma.device.findFirstOrThrow({
        where: { userId: user.id },
        select: { localRunwayUntil: true },
      });
    expect((await stored()).localRunwayUntil?.getTime()).toBe(
      inAWeek.getTime(),
    );

    expect((await registerDevice(base)).status).toBe(201);
    expect((await stored()).localRunwayUntil?.getTime()).toBe(
      inAWeek.getTime(),
    );

    for (const outOfBounds of [
      new Date(Date.now() - 3_600_000),
      new Date(Date.now() + 15 * 86_400_000),
    ]) {
      const refused = await registerDevice({
        ...base,
        localRunwayUntil: outOfBounds.toISOString(),
      });
      expect(refused.status).toBe(422);
    }
    expect((await stored()).localRunwayUntil?.getTime()).toBe(
      inAWeek.getTime(),
    );

    expect(
      (await registerDevice({ ...base, localRunwayUntil: null })).status,
    ).toBe(201);
    expect((await stored()).localRunwayUntil).toBeNull();
  });

  it("serializes concurrent registration into one canonical device and channel", async () => {
    const user = await seedSession("device-concurrent-register");
    const payload = {
      token: "concurrent-legacy-token",
      bundleId: "io.healthlog.ios",
      apnsToken: "abcdabcdabcdabcd",
      apnsEnvironment: "sandbox",
    };

    const responses = await Promise.all([
      registerDevice(payload),
      registerDevice(payload),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ data: { id: string } }>;
    expect(bodies[0].data.id).toBe(bodies[1].data.id);

    const prisma = getPrismaClient();
    await expect(
      prisma.device.count({ where: { userId: user.id } }),
    ).resolves.toBe(1);
    await expect(
      prisma.notificationChannel.count({
        where: { userId: user.id, type: "APNS" },
      }),
    ).resolves.toBe(1);
  });
});

describe("POST /api/devices — per-Activity Live Activity tokens", () => {
  const base = {
    token: "device-la-list-1",
    bundleId: "io.healthlog.ios",
    apnsToken: "abcdef0123456789abcdef0123456789",
    apnsEnvironment: "sandbox",
  };
  async function stored(deviceToken: string) {
    const device = await getPrismaClient().device.findFirstOrThrow({
      where: { token: deviceToken },
      include: { liveActivities: { orderBy: { pushToken: "asc" } } },
    });
    return device;
  }

  it("replaces the list when sent, clears it on [], keeps it when omitted, and then ignores the legacy token", async () => {
    await seedSession("device-la-list");
    const slot = "2026-11-21T07:00:00.000Z";
    expect(
      (
        await registerDevice({
          ...base,
          liveActivityPushToken: "1111111111111111",
          liveActivityTokens: [
            {
              token: "aaaa0000aaaa0000",
              medicationId: "m-a",
              slotInstant: slot,
            },
            { token: "bbbb0000bbbb0000", medicationId: "m-b" },
          ],
        })
      ).status,
    ).toBeLessThan(300);
    let device = await stored(base.token);
    expect(
      device.liveActivities.map((a) => [
        a.pushToken,
        a.medicationId,
        a.slotInstant?.toISOString() ?? null,
      ]),
    ).toEqual([
      ["aaaa0000aaaa0000", "m-a", slot],
      ["bbbb0000bbbb0000", "m-b", null],
    ]);
    // The legacy field is ignored when the list is present.
    expect(device.liveActivityPushToken).toBeNull();

    await registerDevice({ ...base });
    device = await stored(base.token);
    expect(device.liveActivities).toHaveLength(2);

    await registerDevice({ ...base, liveActivityTokens: [] });
    device = await stored(base.token);
    expect(device.liveActivities).toHaveLength(0);
  });
});
