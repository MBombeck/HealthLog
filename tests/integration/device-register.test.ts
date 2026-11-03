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
 *     device and one channel. Foreign ownership still returns 409.
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

beforeEach(async () => {
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

  it("rejects an APNs token owned by another user without mutating either account", async () => {
    const user = await seedSession("device-apns-conflict");
    const prisma = getPrismaClient();
    const owner = await prisma.user.create({
      data: {
        username: "device-apns-owner",
        email: "device-apns-owner@example.test",
      },
    });
    const ownedDevice = await prisma.device.create({
      data: {
        userId: owner.id,
        platform: "ios",
        token: "foreign-legacy-token",
        bundleId: "io.healthlog.ios",
        apnsToken: "9999aaaabbbbcccc",
        apnsEnvironment: "sandbox",
      },
    });

    const response = await registerDevice({
      token: "requesting-user-token",
      bundleId: "io.healthlog.ios.changed",
      apnsToken: "9999aaaabbbbcccc",
      apnsEnvironment: "production",
    });
    expect(response.status).toBe(409);

    await expect(
      prisma.device.findUniqueOrThrow({ where: { id: ownedDevice.id } }),
    ).resolves.toMatchObject({
      userId: owner.id,
      token: "foreign-legacy-token",
      bundleId: "io.healthlog.ios",
      apnsEnvironment: "sandbox",
    });
    await expect(
      prisma.device.count({ where: { userId: user.id } }),
    ).resolves.toBe(0);
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
