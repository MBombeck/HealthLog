/**
 * A device signed out of an account takes none of its pushes any more
 * (iOS #190, #191; `src/lib/devices/signed-out-push.ts`).
 *
 * Against the real database and the real routes:
 *   - signing out with the Bearer token drops the device's APNs token, push
 *     key, relay consent and binding, and Live Activity state; a relay push
 *     still waiting for it is dropped too;
 *   - so does revoking the refresh token, "sign out everywhere else" (for
 *     every device but the caller's), and a password change;
 *   - a device with another live sign-in, and a device that never had a
 *     native sign-in at all, keep theirs;
 *   - the nightly ledger cleanup strips a device whose sign-in simply
 *     expired;
 *   - deleting a device revokes the sign-ins made on it (they are keyed on
 *     the device's `token`, not its row id).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { hashToken } from "@/lib/auth/hmac";
import type { User } from "@/generated/prisma/client";

import { anonymous, callRoute } from "../kit/call-route";
import {
  makeSession,
  makeToken,
  makeUser,
  uniqueSuffix,
  type BearerFixture,
} from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY = 86_400_000;

beforeEach(async () => {
  await truncateAllTables(prisma);
});

/** A device with every push credential a row can hold. */
async function pushingDevice(user: Pick<User, "id">) {
  const suffix = uniqueSuffix();
  const apnsToken = Buffer.from(`apns-${suffix}`)
    .toString("hex")
    .padEnd(64, "0")
    .slice(0, 64);
  const device = await prisma.device.create({
    data: {
      userId: user.id,
      platform: "ios",
      token: `install-${suffix}`,
      bundleId: "io.healthlog.ios",
      apnsToken,
      apnsEnvironment: "production",
      pushKeyPublic: "B".repeat(43),
      pushKeySuites: [1],
      relayState: "bound",
      relayBoundAt: new Date(),
      relayConsentAt: new Date(),
      relayConsentVersion: "1",
      liveActivityConsentAt: new Date(),
      liveActivityConsentVersion: "1",
      liveActivityPushToken: "cd".repeat(32),
      laStartToken: "ef".repeat(32),
      medicationDelivery: "client",
    },
  });
  const medication = await prisma.medication.create({
    data: { userId: user.id, name: `Med ${suffix}`, dose: "1" },
  });
  await prisma.liveActivityToken.create({
    data: {
      deviceId: device.id,
      pushToken: "12".repeat(32),
      medicationId: medication.id,
    },
  });
  await prisma.pushRelayDelivery.create({
    data: {
      deviceId: device.id,
      ref: `01JTESTREF${suffix}`.slice(0, 26).padEnd(26, "0"),
      pushClass: "alert",
      eventType: "MEDICATION_REMINDER",
      expiresAt: new Date(Date.now() + 3600_000),
      status: "pending",
    },
  });
  return device;
}

/** A native sign-in on `device`: an access token and its refresh row. */
async function signIn(
  user: Pick<User, "id">,
  device: { token: string },
  options: { expiresAt?: Date } = {},
): Promise<{ access: BearerFixture; refresh: string }> {
  const access = await makeToken(user);
  const refresh = `hlr_${uniqueSuffix()}`;
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refresh),
      accessTokenHash: hashToken(access.token),
      deviceId: device.token,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 30 * DAY),
    },
  });
  return { access, refresh };
}

async function pushState(deviceId: string) {
  const row = await prisma.device.findUniqueOrThrow({
    where: { id: deviceId },
    select: {
      apnsToken: true,
      pushKeyPublic: true,
      relayState: true,
      relayConsentAt: true,
      liveActivityConsentAt: true,
      liveActivityPushToken: true,
      laStartToken: true,
      medicationDelivery: true,
    },
  });
  return {
    ...row,
    liveActivities: await prisma.liveActivityToken.count({
      where: { deviceId },
    }),
    pendingRelayPushes: await prisma.pushRelayDelivery.count({
      where: { deviceId, status: "pending" },
    }),
  };
}

const STRIPPED = {
  apnsToken: null,
  pushKeyPublic: null,
  relayState: "none",
  relayConsentAt: null,
  liveActivityConsentAt: null,
  liveActivityPushToken: null,
  laStartToken: null,
  // The person's per-device choice stays for the next sign-in.
  medicationDelivery: "client",
  liveActivities: 0,
  pendingRelayPushes: 0,
};

async function expectPushing(deviceId: string) {
  const state = await pushState(deviceId);
  expect(state.apnsToken).not.toBeNull();
  expect(state.pushKeyPublic).not.toBeNull();
  expect(state.relayState).toBe("bound");
  expect(state.liveActivities).toBe(1);
}

async function logout(access: BearerFixture) {
  const { POST } = await import("@/app/api/auth/logout/route");
  return callRoute(POST, {
    method: "POST",
    route: "/api/auth/logout",
    auth: access,
  });
}

describe("signing out ends the device's pushes", () => {
  it("on a Bearer sign-out, and leaves the account's other devices alone", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const tablet = await pushingDevice(user);
    const legacy = await pushingDevice(user);
    const { access } = await signIn(user, phone);
    await signIn(user, tablet);
    // `legacy` never had a native sign-in: "no live one" cannot be told from
    // "never had one", so it is not touched.

    expect((await logout(access)).status).toBe(200);

    expect(await pushState(phone.id)).toEqual(STRIPPED);
    await expectPushing(tablet.id);
    await expectPushing(legacy.id);
    // The relay may still hold the phone's binding: its unbind is owed.
    // (No relay is configured here, so the queue is settled at once.)
    expect(
      await prisma.pushRelayUnbind.count({
        where: { token: phone.apnsToken! },
      }),
    ).toBe(0);
  });

  it("only once the device's last live sign-in is gone", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const first = await signIn(user, phone);
    const second = await signIn(user, phone);

    await logout(first.access);
    await expectPushing(phone.id);

    await logout(second.access);
    expect(await pushState(phone.id)).toEqual(STRIPPED);
  });

  it("on a refresh-token sign-out", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const { refresh } = await signIn(user, phone);
    const { POST } = await import("@/app/api/auth/refresh/route");
    const res = await callRoute<{ revoked: boolean }>(POST, {
      method: "POST",
      route: "/api/auth/refresh",
      auth: anonymous,
      body: { refreshToken: refresh, revoke: true },
    });
    expect(res.status).toBe(200);
    expect(res.data.revoked).toBe(true);
    expect(await pushState(phone.id)).toEqual(STRIPPED);
  });

  it("on sign out everywhere else, for every device but the caller's", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const tablet = await pushingDevice(user);
    const { access } = await signIn(user, phone);
    await signIn(user, tablet);

    const { destroyOtherSessions } = await import("@/lib/auth/session");
    await destroyOtherSessions(
      user.id,
      { kind: "accessToken", accessTokenHash: hashToken(access.token) },
      { reach: "sign-ins" },
    );

    await expectPushing(phone.id);
    expect(await pushState(tablet.id)).toEqual(STRIPPED);
  });

  it("on a credential remediation that ends every sign-in", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    await signIn(user, phone);
    const { destroyAllSessions } = await import("@/lib/auth/session");
    await destroyAllSessions(user.id);
    expect(await pushState(phone.id)).toEqual(STRIPPED);
  });

  it("on reuse detection, which revokes the device's family", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const { refresh } = await signIn(user, phone);
    const { rotateRefreshToken } = await import("@/lib/auth/refresh-token");
    const policy = {
      policy: "native" as const,
      accessTokenDays: 1,
      refreshTokenDays: 60,
      tokenLabel: "test",
    };
    const rotated = await rotateRefreshToken({
      refreshToken: refresh,
      policy,
      deviceId: phone.token,
    });
    expect(rotated.ok).toBe(true);
    await expectPushing(phone.id);
    // The consumed token presented again: the family goes, and the pushes.
    const replay = await rotateRefreshToken({
      refreshToken: refresh,
      policy,
      deviceId: phone.token,
    });
    expect(replay).toEqual({ ok: false, reason: "already_used" });
    expect(await pushState(phone.id)).toEqual(STRIPPED);
  });

  it("in the nightly cleanup for a sign-in that simply expired", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const tablet = await pushingDevice(user);
    await signIn(user, phone, { expiresAt: new Date(Date.now() - DAY) });
    await signIn(user, tablet);

    const { cleanupAuthLedgers } =
      await import("@/lib/jobs/auth-ledger-cleanup");
    const result = await cleanupAuthLedgers(prisma);
    expect(result.signedOutAccounts).toBe(1);

    expect(await pushState(phone.id)).toEqual(STRIPPED);
    await expectPushing(tablet.id);
  });
});

describe("deleting a device", () => {
  it("revokes the sign-ins made on it", async () => {
    const user = await makeUser();
    const phone = await pushingDevice(user);
    const { access } = await signIn(user, phone);
    const { DELETE } = await import("@/app/api/auth/me/devices/[id]/route");
    const res = await callRoute<{ refreshTokensRevoked: number }>(DELETE, {
      method: "DELETE",
      route: "/api/auth/me/devices/{id}",
      params: { id: phone.id },
      auth: await makeSession(user),
    });
    expect(res.status).toBe(200);
    expect(res.data.refreshTokensRevoked).toBe(1);
    expect(
      await prisma.refreshToken.count({
        where: { deviceId: phone.token, revokedAt: null },
      }),
    ).toBe(0);
    const { GET } = await import("@/app/api/auth/me/devices/route");
    const after = await callRoute(GET, {
      method: "GET",
      route: "/api/auth/me/devices",
      auth: access,
    });
    expect(after.status).toBe(401);
  });
});
