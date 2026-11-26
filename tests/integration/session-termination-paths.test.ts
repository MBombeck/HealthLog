/**
 * Every action that ends an account's sessions ends all of them.
 *
 * "Signed out" means more than the browser cookie: the native app holds a
 * refresh token family and the access token paired with it, a script holds a
 * programmatic API token, and the phone holds push credentials that keep the
 * account's reminders arriving. Each path below is driven through its real
 * route against Postgres and then checked from the outside: the web session,
 * the app's access token, its refresh token and the API token are all refused,
 * and the device takes no more pushes.
 *
 * The admin force logout used to delete web sessions only, so the app stayed
 * signed in for the rest of its refresh window; it now runs the same
 * `destroyAllSessions` as the password paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hashToken } from "@/lib/auth/hmac";
import type { User } from "@/generated/prisma/client";

import { anonymous, callRoute, type RouteAuth } from "../kit/call-route";
import {
  makeAdmin,
  makeSession,
  makeToken,
  makeUser,
  uniqueSuffix,
  type BearerFixture,
  type SessionFixture,
} from "../kit/factories";
import { getPrismaClient, truncateAllTables } from "./setup";

const prisma = getPrismaClient();
const DAY = 86_400_000;
const ADMIN_ROUTE = { skip: "admin routes are outside the public contract" };
const OLD_PASSWORD = "Correct horse battery staple 41!";
const NEW_PASSWORD = "Another long passphrase for tests 77?";

beforeEach(async () => {
  await truncateAllTables(prisma);
  await prisma.rateLimit.deleteMany();
  vi.unstubAllEnvs();
});

interface SignedIn {
  user: User;
  web: SessionFixture;
  app: { access: BearerFixture; refresh: string; deviceId: string };
  script: BearerFixture;
}

/**
 * An account signed in everywhere: a browser session, the native app on a
 * phone that holds push credentials, and a programmatic API token.
 */
async function signedInEverywhere(user: User): Promise<SignedIn> {
  const suffix = uniqueSuffix();
  const device = await prisma.device.create({
    data: {
      userId: user.id,
      platform: "ios",
      token: `install-${suffix}`,
      bundleId: "io.healthlog.ios",
      apnsToken: Buffer.from(`apns-${suffix}`)
        .toString("hex")
        .padEnd(64, "0")
        .slice(0, 64),
      apnsEnvironment: "production",
      pushKeyPublic: "B".repeat(43),
      pushKeySuites: [1],
    },
  });
  const access = await makeToken(user, { name: `native ${suffix}` });
  const refresh = `hlr_${uniqueSuffix()}`;
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refresh),
      accessTokenHash: hashToken(access.token),
      deviceId: device.token,
      expiresAt: new Date(Date.now() + 60 * DAY),
    },
  });
  return {
    user,
    web: await makeSession(user),
    app: { access, refresh, deviceId: device.id },
    script: await makeToken(user, { name: `script ${suffix}` }),
  };
}

async function me(auth: RouteAuth): Promise<number> {
  const { GET } = await import("@/app/api/auth/me/route");
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/auth/me",
    auth,
  });
  return res.status;
}

async function refreshStatus(refreshToken: string): Promise<number> {
  const { POST } = await import("@/app/api/auth/refresh/route");
  const res = await callRoute(POST, {
    method: "POST",
    route: "/api/auth/refresh",
    auth: anonymous,
    body: { refreshToken },
  });
  return res.status;
}

/** Nothing the account was signed in with still works, and the phone is quiet. */
async function expectSignedOutEverywhere(s: SignedIn): Promise<void> {
  expect(await me(s.web), "web session").toBe(401);
  expect(await me(s.app.access), "app access token").toBe(401);
  expect(await me(s.script), "API token").toBe(401);
  expect(await refreshStatus(s.app.refresh), "app refresh token").toBe(401);
  const device = await prisma.device.findUniqueOrThrow({
    where: { id: s.app.deviceId },
    select: { apnsToken: true, pushKeyPublic: true },
  });
  expect(device, "device push credentials").toEqual({
    apnsToken: null,
    pushKeyPublic: null,
  });
}

async function expectStillSignedIn(s: SignedIn): Promise<void> {
  expect(await me(s.web)).toBe(200);
  expect(await me(s.app.access)).toBe(200);
  expect(await me(s.script)).toBe(200);
}

describe("ending an account's sessions ends every sign-in", () => {
  it("admin force logout signs the app out too, not only the browser", async () => {
    const admin = await makeAdmin();
    const adminWeb = await makeSession(admin);
    const target = await signedInEverywhere(await makeUser());
    const bystander = await signedInEverywhere(await makeUser());
    await expectStillSignedIn(target);

    const { POST } =
      await import("@/app/api/admin/users/[id]/force-logout/route");
    const res = await callRoute<{ sessionsRevoked: number }>(POST, {
      method: "POST",
      route: "/api/admin/users/{id}/force-logout",
      params: { id: target.user.id },
      auth: adminWeb,
      contract: ADMIN_ROUTE,
    });

    expect(res.status).toBe(200);
    // One browser session and one live sign-in on the phone.
    expect(res.data.sessionsRevoked).toBe(2);
    await expectSignedOutEverywhere(target);
    await expectStillSignedIn(bystander);
    expect(await me(adminWeb)).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { userId: admin.id, action: "admin.user.force-logout" },
      select: { details: true },
    });
    expect(JSON.parse(String(audit.details))).toMatchObject({
      targetUserId: target.user.id,
      webSessionsRevoked: 1,
      deviceSignInsRevoked: 1,
    });
  });

  it("admin password reset", async () => {
    const admin = await makeAdmin();
    const adminWeb = await makeSession(admin);
    const target = await signedInEverywhere(await makeUser());

    const { POST } =
      await import("@/app/api/admin/users/[id]/reset-password/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/admin/users/{id}/reset-password",
      params: { id: target.user.id },
      auth: adminWeb,
      body: { password: NEW_PASSWORD },
      contract: ADMIN_ROUTE,
    });

    expect(res.status).toBe(200);
    await expectSignedOutEverywhere(target);
  });

  it("the account's own password change, from another browser", async () => {
    const { hashPassword } = await import("@/lib/auth/password");
    const user = await makeUser({
      passwordHash: await hashPassword(OLD_PASSWORD),
    });
    const target = await signedInEverywhere(user);
    const changer = await makeSession(user);

    const { POST } = await import("@/app/api/auth/password/route");
    const res = await callRoute(POST, {
      method: "POST",
      route: "/api/auth/password",
      auth: changer,
      body: {
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      },
    });

    expect(res.status).toBe(200);
    // Every earlier sign-in ends, the changing browser's included; the route
    // hands that browser a fresh session of its own.
    await expectSignedOutEverywhere(target);
    expect(await me(changer)).toBe(401);
  });

  it("an admin deleting the account (locked for the grace window)", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
    const admin = await makeAdmin();
    const adminWeb = await makeSession(admin);
    const target = await signedInEverywhere(await makeUser());

    const { DELETE } = await import("@/app/api/admin/users/[id]/route");
    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/admin/users/{id}",
      params: { id: target.user.id },
      auth: adminWeb,
      body: { confirm: "DELETE_ACCOUNT" },
      contract: ADMIN_ROUTE,
    });

    expect(res.status).toBe(200);
    await expectSignedOutEverywhere(target);
  });

  it("the account deleting itself (locked for the grace window)", async () => {
    vi.stubEnv("ACCOUNT_DELETION_GRACE_DAYS", "14");
    const target = await signedInEverywhere(await makeUser());
    const deleter = await makeSession(target.user);

    const { DELETE } = await import("@/app/api/settings/account/route");
    const res = await callRoute(DELETE, {
      method: "DELETE",
      route: "/api/settings/account",
      auth: deleter,
      body: { confirm: "DELETE_ACCOUNT" },
    });

    expect(res.status).toBe(200);
    await expectSignedOutEverywhere(target);
  });
});
