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
 *      the enrolment routes; a passkey satisfies it.
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
const { resolveMfaEnrollment } = await import("@/lib/auth/mfa-enrollment");
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
    return prisma.user.create({
      data: {
        username: `admin-${policySinceDaysAgo}`,
        email: `admin-${policySinceDaysAgo}@example.test`,
        role: "ADMIN",
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
