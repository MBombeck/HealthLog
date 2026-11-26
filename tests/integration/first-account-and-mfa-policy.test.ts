/**
 * Claiming a fresh instance, and the second-factor policy, against a real
 * database.
 *
 *   a) the first account needs the setup token, by body or by the proof
 *      cookie `POST /api/auth/register/setup` sets; it becomes the admin and
 *      the token opens nothing afterwards;
 *   b) the admin policy (on by default) gives a factor-less admin the grace
 *      period from when the policy took effect, stamps it on a new session,
 *      and after it refuses a native sign-in and confines the web session to
 *      the enrolment routes; a passkey satisfies it;
 *   c) that confinement is decided at request time from the account and the
 *      policy: a session from before the policy is confined after the grace
 *      period, and an account created under a running policy gets its grace
 *      period from its creation. A sign-in token of the app from before the
 *      due date, and its refresh, keep working in 1.50 (the shipped builds
 *      are not built for a refusal there); `/me` reports the state, and the
 *      grace period's start is claimed once for its notice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { expectedSetupToken } = await import("@/lib/auth/setup-token");
const { callRoute } = await import("../kit/call-route");
const { makeSession, makeToken, makeUser } = await import("../kit/factories");
const { GET: readMe } = await import("@/app/api/auth/me/route");
const { GET: listMeasurements } = await import("@/app/api/measurements/route");
const { POST: refresh } = await import("@/app/api/auth/refresh/route");
const { issueAccessAndRefresh } = await import("@/lib/auth/refresh-token");
const { DELETE: deleteDevice } = await import("@/app/api/devices/[id]/route");
const { GET: readVersion } = await import("@/app/api/version/route");
const { GET: readHealth } = await import("@/app/api/health/route");
const { forgetMfaPolicy, resolveMfaEnrollment } =
  await import("@/lib/auth/mfa-enrollment");
const { MFA_GRACE_NOTICE_EVENT_TYPE } =
  await import("@/lib/auth/mfa-grace-notice");
const { mfaDueAtForSignIn } = await import("@/lib/auth/mfa-confinement");
const { refuseNativeSignInWithoutFactor } =
  await import("@/lib/auth/mfa-native-refusal");

const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = ["Correct", "Horse", "Battery", "Staple", "42"].join("-");

function registerRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.20",
    },
    body: JSON.stringify(body),
  });
}

async function register(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/auth/register/route");
  return POST(registerRequest(body) as Parameters<typeof POST>[0]);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  forgetMfaPolicy();
});

describe("the first account", () => {
  const first = { email: "first@example.test", username: "first" };

  it("is refused without the setup token, and a wrong one", async () => {
    expect((await register({ ...first, password: PASSWORD })).status).toBe(403);
    const wrong = await register({
      ...first,
      password: PASSWORD,
      setupToken: "hlu_" + "0".repeat(48),
    });
    expect(wrong.status).toBe(403);
    expect(await getPrismaClient().user.count()).toBe(0);
  });

  it("becomes the admin with the token", async () => {
    const res = await register({
      ...first,
      password: PASSWORD,
      setupToken: expectedSetupToken(),
    });
    expect(res.status).toBe(201);
    const prisma = getPrismaClient();
    const user = await prisma.user.findFirstOrThrow({
      where: { username: "first" },
    });
    expect(user.role).toBe("ADMIN");
    const audit = await prisma.auditLog.findFirst({
      where: { action: "auth.setup.claimed" },
    });
    expect(audit?.userId).toBe(user.id);
  });

  it("is admitted by the proof cookie the setup route sets", async () => {
    const { POST } = await import("@/app/api/auth/register/setup/route");
    const proven = await POST(
      new Request("http://localhost/api/auth/register/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.21",
        },
        body: JSON.stringify({ setupToken: expectedSetupToken() }),
      }) as Parameters<typeof POST>[0],
    );
    expect(proven.status).toBe(200);
    expect(cookieJar.has("hl_setup")).toBe(true);

    expect((await register({ ...first, password: PASSWORD })).status).toBe(201);
    // Spent with the claim.
    expect(cookieJar.has("hl_setup")).toBe(false);

    const again = await POST(
      new Request("http://localhost/api/auth/register/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.21",
        },
        body: JSON.stringify({ setupToken: expectedSetupToken() }),
      }) as Parameters<typeof POST>[0],
    );
    expect(again.status).toBe(409);
  });
});

describe("the second-factor policy for admins", () => {
  async function seedAdmin(policySinceDaysAgo: number) {
    const prisma = getPrismaClient();
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: {
        mfaPolicySince: new Date(Date.now() - policySinceDaysAgo * DAY_MS),
      },
      update: {
        mfaPolicySince: new Date(Date.now() - policySinceDaysAgo * DAY_MS),
      },
    });
    forgetMfaPolicy();
    return prisma.user.create({
      data: {
        username: `admin-${policySinceDaysAgo}`,
        email: `admin-${policySinceDaysAgo}@example.test`,
        role: "ADMIN",
        // Older than the policy, as on an instance updated to it.
        createdAt: new Date(Date.now() - 400 * DAY_MS),
      },
    });
  }

  it("is on by default and gives the grace period from when it took effect", async () => {
    const admin = await seedAdmin(3);
    const enrollment = await resolveMfaEnrollment(admin.id, admin);
    expect(enrollment.state).toBe("grace");
    const due = await mfaDueAtForSignIn(admin.id);
    expect(due!.getTime()).toBeGreaterThan(Date.now() + 10 * DAY_MS);
    expect(await refuseNativeSignInWithoutFactor(admin.id, "ip", "t")).toBe(
      null,
    );
  });

  it("refuses the native sign-in once the grace period is over, and audits it", async () => {
    const admin = await seedAdmin(15);
    const refusal = await refuseNativeSignInWithoutFactor(
      admin.id,
      "203.0.113.22",
      "login.password",
    );
    expect(refusal?.status).toBe(403);
    const body = (await refusal!.json()) as { meta: { errorCode: string } };
    expect(body.meta.errorCode).toBe("auth.mfa.enrollment_required");
    const audit = await getPrismaClient().auditLog.findFirst({
      where: { action: "auth.login.mfa_enrollment_required" },
    });
    expect(audit?.userId).toBe(admin.id);
  });

  it("is satisfied by a passkey", async () => {
    const admin = await seedAdmin(15);
    await getPrismaClient().passkey.create({
      data: {
        userId: admin.id,
        credentialId: "cred-1",
        credentialPublicKey: Buffer.from("key"),
        credentialDeviceType: "multiDevice",
      },
    });
    expect((await resolveMfaEnrollment(admin.id, admin)).state).toBe("none");
    expect(await mfaDueAtForSignIn(admin.id)).toBeNull();
  });

  it("leaves an ordinary account alone", async () => {
    await seedAdmin(15);
    const user = await getPrismaClient().user.create({
      data: { username: "plain", email: "plain@example.test" },
    });
    expect((await resolveMfaEnrollment(user.id, user)).state).toBe("none");
  });
});

describe("confinement decided at request time", () => {
  async function usePolicySince(daysAgo: number): Promise<void> {
    const since = new Date(Date.now() - daysAgo * DAY_MS);
    await getPrismaClient().appSettings.upsert({
      where: { id: "singleton" },
      create: { mfaPolicySince: since },
      update: { mfaPolicySince: since },
    });
    forgetMfaPolicy();
  }

  const OLD = () => new Date(Date.now() - 400 * DAY_MS);

  /** A session as a pre-1.50 sign-in left it: no due date recorded. */
  async function preUpdateSession(user: { id: string }) {
    const session = await makeSession(user);
    await getPrismaClient().session.update({
      where: { id: session.sessionId },
      data: { mfaEnrollmentDueAt: null },
    });
    return session;
  }

  function readMeasurements(auth: Parameters<typeof callRoute>[1]["auth"]) {
    return callRoute(listMeasurements, {
      method: "GET",
      route: "/api/measurements",
      auth,
    });
  }

  it("confines a session from before the update once the grace period is over", async () => {
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const session = await preUpdateSession(admin);

    const refused = await readMeasurements(session);
    expect(refused.status).toBe(403);
    expect(refused.meta?.errorCode).toBe("auth.mfa.enrollment_required");
    // The enrolment surface stays open.
    const me = await callRoute(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: session,
    });
    expect(me.status).toBe(200);
  });

  it("keeps a sign-in token past the due date working, and tells it on /me", async () => {
    // 1.50: the shipped iPhone builds are not built for a refusal here; 1.51
    // confines these tokens (announced in the changelog).
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const signIn = await makeToken(admin);
    expect((await readMeasurements(signIn)).status).toBe(200);
    const me = await callRoute<{
      mfaEnrollment: { state: string; dueAt: string | null };
    }>(readMe, { method: "GET", route: "/api/auth/me", auth: signIn });
    expect(me.data.mfaEnrollment.state).toBe("required");
    expect(me.data.mfaEnrollment.dueAt).not.toBeNull();
    const narrow = await makeToken(admin, {
      permissions: ["read:measurements"],
    });
    const scoped = await callRoute(listMeasurements, {
      method: "GET",
      route: "/api/measurements",
      auth: narrow,
    });
    expect(scoped.meta?.errorCode).not.toBe("auth.mfa.enrollment_required");
  });

  it("gives an admin account created under a running policy its grace period from creation", async () => {
    await usePolicySince(30);
    const fresh = await makeUser({
      role: "ADMIN",
      createdAt: new Date(Date.now() - 3 * DAY_MS),
    });
    expect((await readMeasurements(await makeSession(fresh))).status).toBe(200);
    const older = await makeUser({
      role: "ADMIN",
      createdAt: new Date(Date.now() - 15 * DAY_MS),
    });
    expect((await readMeasurements(await makeSession(older))).status).toBe(403);
  });

  it("leaves an admin with a passkey whole", async () => {
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    await getPrismaClient().passkey.create({
      data: {
        userId: admin.id,
        credentialId: "cred-request-time",
        credentialPublicKey: Buffer.from("key"),
        credentialDeviceType: "multiDevice",
      },
    });
    expect((await readMeasurements(await preUpdateSession(admin))).status).toBe(
      200,
    );
  });

  it("leaves a non-admin alone under the admin policy alone", async () => {
    await usePolicySince(20);
    const user = await makeUser({ createdAt: OLD() });
    expect((await readMeasurements(await preUpdateSession(user))).status).toBe(
      200,
    );
  });

  async function nativeBundle(userId: string) {
    return issueAccessAndRefresh({
      userId,
      policy: {
        policy: "native",
        accessTokenDays: 1,
        refreshTokenDays: 60,
        tokenLabel: "native",
      },
      source: "login.password",
      deviceId: "device-1",
    });
  }

  function refreshRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/api/auth/refresh", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "device-1",
        "x-forwarded-for": "203.0.113.31",
      },
      body: JSON.stringify(body),
    }) as Parameters<typeof refresh>[0];
  }

  it("refreshes a native sign-in past the due date", async () => {
    // A refused refresh signs the store build out; 1.51 refuses it.
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const bundle = await nativeBundle(admin.id);
    const res = await refresh(
      refreshRequest({ refreshToken: bundle.refreshToken }),
    );
    expect(res.status).toBe(200);
    const row = await getPrismaClient().refreshToken.findFirstOrThrow({
      where: { userId: admin.id, usedAt: { not: null } },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("claims the grace notice once when the grace period has begun", async () => {
    await usePolicySince(2);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const signIn = await makeToken(admin);
    for (let i = 0; i < 2; i++) {
      const me = await callRoute<{ mfaEnrollment: { state: string } }>(readMe, {
        method: "GET",
        route: "/api/auth/me",
        auth: signIn,
      });
      expect(me.data.mfaEnrollment.state).toBe("grace");
    }
    const prisma = getPrismaClient();
    let claims = 0;
    for (let i = 0; i < 50 && claims === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      claims = await prisma.notificationEvent.count({
        where: {
          recordUserId: admin.id,
          eventType: MFA_GRACE_NOTICE_EVENT_TYPE,
        },
      });
    }
    expect(claims).toBe(1);
  });

  it("still signs a past-due account out: refresh with revoke ends the family", async () => {
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const bundle = await nativeBundle(admin.id);
    const res = await refresh(
      refreshRequest({ refreshToken: bundle.refreshToken, revoke: true }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { revoked: boolean } }).data).toEqual(
      { revoked: true },
    );
    const row = await getPrismaClient().refreshToken.findFirstOrThrow({
      where: { userId: admin.id },
    });
    expect(row.revokedAt).not.toBeNull();
  });

  it("lets a past-due sign-in token remove its device, and a confined session read the probes", async () => {
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const signIn = await makeToken(admin);
    const removed = await callRoute(deleteDevice, {
      method: "DELETE",
      route: "/api/devices/{id}",
      params: { id: "no-such-device" },
      auth: signIn,
    });
    expect(removed.meta?.errorCode).not.toBe("auth.mfa.enrollment_required");
    expect(removed.status).not.toBe(403);

    const session = await preUpdateSession(admin);
    const version = await callRoute(readVersion, {
      method: "GET",
      route: "/api/version",
      auth: session,
    });
    expect(version.status).toBe(200);
    const health = await callRoute(readHealth, {
      method: "GET",
      route: "/api/health",
      auth: session,
      contract: { skip: "status depends on the test container's services" },
    });
    expect(health.status).not.toBe(403);
    expect(health.meta?.errorCode).not.toBe("auth.mfa.enrollment_required");
  });

  it("reports required on /me for a confined session, with the open paths", async () => {
    await usePolicySince(20);
    const admin = await makeUser({ role: "ADMIN", createdAt: OLD() });
    const me = await callRoute<{
      mfaEnrollment: { state: string; openPaths: { path: string }[] };
    }>(readMe, {
      method: "GET",
      route: "/api/auth/me",
      auth: await preUpdateSession(admin),
    });
    expect(me.status).toBe(200);
    expect(me.data.mfaEnrollment.state).toBe("required");
    expect(me.data.mfaEnrollment.openPaths.map((p) => p.path)).toContain(
      "/api/auth/me",
    );

    const graced = await makeUser({
      role: "ADMIN",
      createdAt: new Date(Date.now() - DAY_MS),
    });
    const graceMe = await callRoute<{ mfaEnrollment: { state: string } }>(
      readMe,
      { method: "GET", route: "/api/auth/me", auth: await makeSession(graced) },
    );
    expect(graceMe.data.mfaEnrollment.state).toBe("grace");
  });
});
