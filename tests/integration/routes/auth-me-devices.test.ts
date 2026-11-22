/**
 * `/api/auth/me/devices` and `/api/auth/me/devices/{id}`: the registered
 * device list and the device revoke, against the real database and through
 * the real API kit.
 *
 * What a person relies on here:
 *   - the list shows the account's own devices, most recently seen first,
 *     with their delivery channels, and nothing that could be replayed to
 *     send a notification (no push token, no APNs identifier);
 *   - the "this device" badge follows `X-Device-Id` (the device's `token`,
 *     which a native sign-in stores as `RefreshToken.deviceId`) only when
 *     that device holds a live refresh token of this account, so a forged
 *     header cannot move it;
 *   - the revoke reaches only the caller's own devices, removes the row,
 *     revokes every live refresh token bound to it and the access tokens they
 *     pair with, and those access tokens stop authenticating at once.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/auth/me/devices/route";
import { DELETE } from "@/app/api/auth/me/devices/[id]/route";
import { hashToken } from "@/lib/auth/hmac";
import type { Prisma, User } from "@/generated/prisma/client";

import { anonymous, callRoute, type RouteAuth } from "../../kit/call-route";
import {
  makeSession,
  makeToken,
  makeUser,
  uniqueSuffix,
  type BearerFixture,
} from "../../kit/factories";
import { getPrismaClient, truncateAllTables } from "../setup";

const prisma = getPrismaClient();

type DeviceRow = {
  id: string;
  label: string;
  platform: string;
  appVersion: string | null;
  locale: string | null;
  channels: Array<"web_push" | "apns">;
  lastSeenAt: string;
  createdAt: string;
  isCurrent: boolean;
};

type RevokeResult = {
  id: string;
  revoked: boolean;
  refreshTokensRevoked: number;
  accessTokensRevoked: number;
};

beforeEach(async () => {
  await truncateAllTables(prisma);
});

async function makeDevice(
  user: Pick<User, "id">,
  overrides: Partial<Omit<Prisma.DeviceUncheckedCreateInput, "userId">> = {},
) {
  return prisma.device.create({
    data: {
      userId: user.id,
      platform: "ios",
      token: `device-token-${uniqueSuffix()}`,
      bundleId: "io.healthlog.app",
      ...overrides,
    },
  });
}

/**
 * A refresh token bound to a device, paired with an access token the way
 * the native sign-in pairs them. `access: null` stores a refresh row with no
 * access-token pairing.
 */
async function makeRefresh(
  user: Pick<User, "id">,
  deviceId: string,
  options: { access?: BearerFixture | null; revokedAt?: Date } = {},
) {
  return prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256")
        .update(`refresh-${uniqueSuffix()}`)
        .digest("hex"),
      deviceId,
      accessTokenHash: options.access ? hashToken(options.access.token) : null,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      revokedAt: options.revokedAt ?? null,
    },
  });
}

async function listDevices(auth: RouteAuth, deviceIdHeader?: string) {
  return callRoute<{ devices: DeviceRow[] }>(GET, {
    method: "GET",
    route: "/api/auth/me/devices",
    auth,
    headers: deviceIdHeader ? { "x-device-id": deviceIdHeader } : undefined,
  });
}

describe("GET /api/auth/me/devices", () => {
  it("answers 401 without a credential", async () => {
    expect((await listDevices(anonymous)).status).toBe(401);
  });

  it("lists the caller's devices most recently seen first, with channels and no push identifiers", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const phone = await makeDevice(owner, {
      model: "iPhone 14 Pro",
      locale: "en-US",
      appVersion: "1.0",
      apnsToken: "apns-secret-value",
      apnsEnvironment: "production",
      lastSeen: new Date("2026-05-10T12:00:00Z"),
    });
    const tablet = await makeDevice(owner, {
      model: null,
      lastSeen: new Date("2026-05-09T12:00:00Z"),
    });
    await makeDevice(other, { model: "Not yours" });

    const res = await listDevices(await makeSession(owner));

    expect(res.status).toBe(200);
    expect(res.data.devices).toEqual([
      {
        id: phone.id,
        label: "iPhone 14 Pro",
        platform: "ios",
        appVersion: "1.0",
        locale: "en-US",
        channels: ["web_push", "apns"],
        lastSeenAt: "2026-05-10T12:00:00.000Z",
        createdAt: phone.createdAt.toISOString(),
        isCurrent: false,
      },
      expect.objectContaining({
        id: tablet.id,
        // No model: the bundle id labels the row rather than a blank.
        label: "io.healthlog.app",
        channels: ["web_push"],
        isCurrent: false,
      }),
    ]);
    const serialised = JSON.stringify(res.body);
    expect(serialised).not.toContain(phone.token);
    expect(serialised).not.toContain("apns-secret-value");
  });

  it("marks the device named by X-Device-Id when it holds a live refresh token of this account", async () => {
    const owner = await makeUser();
    const phone = await makeDevice(owner);
    const tablet = await makeDevice(owner);
    const access = await makeToken(owner);
    await makeRefresh(owner, tablet.token, { access });

    const res = await listDevices(access, tablet.token);

    expect(res.status).toBe(200);
    expect(res.data.devices.map((d) => [d.id, d.isCurrent]).sort()).toEqual(
      [
        [phone.id, false],
        [tablet.id, true],
      ].sort(),
    );
  });

  it("ignores an X-Device-Id that no live refresh token of this account anchors", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const forged = await makeDevice(owner);
    const revoked = await makeDevice(owner);
    const foreignAnchor = await makeDevice(owner);
    await makeRefresh(owner, revoked.token, { revokedAt: new Date() });
    // Another account's refresh row naming this device id anchors nothing.
    await makeRefresh(other, foreignAnchor.token);
    const access = await makeToken(owner);

    for (const header of [forged.token, revoked.token, foreignAnchor.token]) {
      const res = await listDevices(access, header);
      expect(res.status).toBe(200);
      expect(res.data.devices.some((d) => d.isCurrent)).toBe(false);
    }
  });
});

describe("DELETE /api/auth/me/devices/{id}", () => {
  it("answers 401 without a credential and leaves the device", async () => {
    const owner = await makeUser();
    const device = await makeDevice(owner);

    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: device.id },
      auth: anonymous,
    });

    expect(res.status).toBe(401);
    expect(await prisma.device.count({ where: { id: device.id } })).toBe(1);
  });

  it("answers 404 for an id that does not exist", async () => {
    const owner = await makeUser();

    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: "no-such-device" },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(404);
  });

  it("answers 404 for another account's device and leaves it and its credentials alone", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const theirs = await makeDevice(other);
    const theirAccess = await makeToken(other);
    const theirRefresh = await makeRefresh(other, theirs.token, {
      access: theirAccess,
    });

    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: theirs.id },
      auth: await makeSession(owner),
    });

    expect(res.status).toBe(404);
    expect(await prisma.device.count({ where: { id: theirs.id } })).toBe(1);
    const refresh = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: theirRefresh.id },
    });
    expect(refresh.revokedAt).toBeNull();
    expect((await listDevices(theirAccess)).status).toBe(200);
  });

  it("deletes the device, revokes its refresh tokens and their paired access tokens, and those stop authenticating", async () => {
    const owner = await makeUser();
    const session = await makeSession(owner);
    const phone = await makeDevice(owner, { model: "iPhone" });
    const tablet = await makeDevice(owner);
    const accessA = await makeToken(owner);
    const accessB = await makeToken(owner);
    const tabletAccess = await makeToken(owner);
    const refreshA = await makeRefresh(owner, phone.token, { access: accessA });
    const refreshB = await makeRefresh(owner, phone.token, { access: accessB });
    const unpaired = await makeRefresh(owner, phone.token, { access: null });
    const earlier = new Date("2026-01-01T00:00:00Z");
    const alreadyRevoked = await makeRefresh(owner, phone.token, {
      revokedAt: earlier,
    });
    const tabletRefresh = await makeRefresh(owner, tablet.token, {
      access: tabletAccess,
    });

    const res = await callRoute<RevokeResult>(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: phone.id },
      auth: session,
    });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      id: phone.id,
      revoked: true,
      refreshTokensRevoked: 3,
      accessTokensRevoked: 2,
    });

    expect(await prisma.device.count({ where: { id: phone.id } })).toBe(0);
    const refreshRows = await prisma.refreshToken.findMany({
      where: { userId: owner.id },
    });
    const byId = new Map(refreshRows.map((r) => [r.id, r]));
    for (const id of [refreshA.id, refreshB.id, unpaired.id]) {
      expect(byId.get(id)?.revokedAt).not.toBeNull();
    }
    // An earlier revocation keeps its own timestamp.
    expect(byId.get(alreadyRevoked.id)?.revokedAt).toEqual(earlier);
    // The other device is untouched.
    expect(byId.get(tabletRefresh.id)?.revokedAt).toBeNull();
    expect(await prisma.device.count({ where: { id: tablet.id } })).toBe(1);

    expect((await listDevices(accessA)).status).toBe(401);
    expect((await listDevices(accessB)).status).toBe(401);
    expect((await listDevices(tabletAccess)).status).toBe(200);
    // Browser sessions live on their own rows and are not touched.
    expect((await listDevices(session)).status).toBe(200);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: owner.id, action: "devices.revoke" },
    });
    expect(JSON.parse(audit.details ?? "{}")).toEqual({
      deviceId: phone.id,
      label: "iPhone",
      refreshTokensRevoked: 3,
      accessTokensRevoked: 2,
    });

    // A retry after a successful revoke finds nothing.
    const retry = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: phone.id },
      auth: session,
    });
    expect(retry.status).toBe(404);
  });
});
