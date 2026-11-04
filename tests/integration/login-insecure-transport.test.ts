/**
 * #1097 against real Postgres: a browser sign-in whose session cookie cannot
 * stick (Secure-only cookies, page on plain http:// at a network address) is
 * refused BEFORE it spends anything.
 *
 *   - the password step mints no MFA ticket, creates no session and charges
 *     no account-throttle failure;
 *   - the MFA step leaves the ticket unclaimed and the TOTP code unspent, so
 *     the same ticket and code still complete over https;
 *   - the passkey start issues no challenge;
 *   - a request without `clientTransport` (the iOS app, scripts) is never
 *     refused; neither is localhost.
 */
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-test-hmac-key-test-hmac-key-0123456789";

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

const { hashPassword } = await import("@/lib/auth/password");
const { encrypt } = await import("@/lib/crypto");
const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");

const PASSWORD = "Correct horse battery staple!42";
const LAN_HTTP = { protocol: "http", host: "192.168.1.20:3000" };
const HTTPS = { protocol: "https", host: "healthlog.example.test" };

let secret: string;

function totpNow(): string {
  return new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() });
}

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function login(clientTransport?: unknown, password = PASSWORD) {
  const { POST } = await import("@/app/api/auth/login/route");
  return POST(
    post("/api/auth/login", {
      email: "mfa@example.test",
      password,
      ...(clientTransport ? { clientTransport } : {}),
    }),
  );
}

async function mfaVerify(
  mfaTicket: string,
  code: string,
  clientTransport?: unknown,
) {
  const { POST } = await import("@/app/api/auth/mfa/verify/route");
  return POST(
    post("/api/auth/mfa/verify", {
      mfaTicket,
      method: "totp",
      code,
      ...(clientTransport ? { clientTransport } : {}),
    }),
  );
}

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.mfaChallenge.deleteMany();
  await prisma.authChallenge.deleteMany();
  await prisma.rateLimit.deleteMany();
  cookieJar.clear();
  headerJar.clear();
  vi.stubEnv("SESSION_COOKIE_SECURE", "true");
  secret = generateTotpSecret();
  await prisma.user.create({
    data: {
      id: "mfa-user",
      username: "mfa-user",
      email: "mfa@example.test",
      passwordHash: await hashPassword(PASSWORD),
      onboardingCompletedAt: new Date(),
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: new Date(),
    },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sign-in over plain http with Secure-only cookies (real Postgres)", () => {
  it("refuses the password step before a ticket, a session or a throttle charge", async () => {
    const prisma = getPrismaClient();
    // A wrong password too: the refusal must come before the check, so a
    // wrong password cannot be told from a right one here either.
    for (const password of [PASSWORD, "wrong password entirely"]) {
      const res = await login(LAN_HTTP, password);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.meta).toEqual({
        requestId: expect.any(String),
        errorCode: "auth.session.insecure_transport",
        sessionCookieSecure: true,
      });
    }
    expect(await prisma.mfaChallenge.count()).toBe(0);
    expect(await prisma.session.count()).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: { startsWith: "auth.login" } },
      }),
    ).toBe(0);
    expect(
      await prisma.rateLimit.count({
        where: { NOT: { key: { startsWith: "auth:login" } } },
      }),
    ).toBe(0);
  });

  it("leaves the ticket and the code unspent at the MFA step", async () => {
    const prisma = getPrismaClient();
    const first = await login(HTTPS);
    expect(first.status).toBe(200);
    const ticket = (await first.json()).meta.mfaTicket as string;
    expect(ticket).toBeTruthy();

    const code = totpNow();
    const refused = await mfaVerify(ticket, code, LAN_HTTP);
    expect(refused.status).toBe(409);
    expect((await refused.json()).meta.errorCode).toBe(
      "auth.session.insecure_transport",
    );

    const challenge = await prisma.mfaChallenge.findFirstOrThrow();
    expect(challenge.attempts).toBe(0);
    expect(challenge.consumedAt).toBeNull();
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: "mfa-user" },
      select: { totpLastStep: true },
    });
    expect(user.totpLastStep).toBeNull();

    // The same ticket and the same code still finish over https.
    const done = await mfaVerify(ticket, code, HTTPS);
    expect(done.status).toBe(200);
    expect(await prisma.session.count()).toBe(1);
  });

  it("issues no passkey challenge for a page on plain http", async () => {
    const prisma = getPrismaClient();
    const { POST } = await import("@/app/api/auth/passkey/login-options/route");
    const refused = await POST(
      post("/api/auth/passkey/login-options", { clientTransport: LAN_HTTP }),
    );
    expect(refused.status).toBe(409);
    expect(await prisma.authChallenge.count()).toBe(0);

    const ok = await POST(
      new NextRequest("http://localhost/api/auth/passkey/login-options", {
        method: "POST",
      }),
    );
    expect(ok.status).toBe(200);
    expect(await prisma.authChallenge.count()).toBe(1);
  });

  it("never refuses a caller that sends no transport, or localhost", async () => {
    const withoutField = await login();
    expect(withoutField.status).toBe(200);
    expect((await withoutField.json()).meta.mfaRequired).toBe(true);

    const local = await login({ protocol: "http", host: "localhost:3000" });
    expect(local.status).toBe(200);
  });

  it("does not refuse when the server does not set Secure cookies", async () => {
    vi.stubEnv("SESSION_COOKIE_SECURE", "false");
    const res = await login(LAN_HTTP);
    expect(res.status).toBe(200);
  });
});
