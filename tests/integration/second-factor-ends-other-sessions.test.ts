/**
 * Turning on the first second factor ends every other sign-in, as a password
 * change does. A session opened before the factor existed, perhaps by whoever
 * the owner is locking out, must not keep going without it. Adding a further
 * factor to an account that already has one leaves other sign-ins alone.
 */
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-second-factor-32-bytes-minimum-1234567890";

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
      set: (name: string, value: string) => cookieJar.set(name, value),
      delete: (name: string) => cookieJar.delete(name),
    })),
  };
});

const USER_ID = "user-second-factor";
const HOUR = 60 * 60 * 1000;

type RouteFn = (request: NextRequest) => Promise<Response>;

async function confirm(code: string) {
  const { POST } = await import("@/app/api/auth/me/mfa/totp/confirm/route");
  return (POST as unknown as RouteFn)(
    new NextRequest("http://localhost/api/auth/me/mfa/totp/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
}

async function session(): Promise<string> {
  const row = await getPrismaClient().session.create({
    data: { userId: USER_ID, expiresAt: new Date(Date.now() + HOUR) },
  });
  return row.id;
}

async function pendingSecret(): Promise<string> {
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  const { encrypt } = await import("@/lib/crypto");
  const secret = generateTotpSecret();
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: { totpSecretEncrypted: encrypt(secret), totpConfirmedAt: null },
  });
  return secret;
}

function codeFor(secret: string): string {
  return new OTPAuth.TOTP({
    issuer: "HealthLog",
    label: "HealthLog",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate({ timestamp: Date.now() });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "second-factor-user",
      email: "second-factor@example.test",
      role: "USER",
    },
  });
});

describe("TOTP confirmation", () => {
  it("ends every other sign-in when it is the account's first second factor", async () => {
    const secret = await pendingSecret();
    const other = await session();
    const current = await session();
    cookieJar.set("healthlog_session", current);

    const res = await confirm(codeFor(secret));
    expect(res.status).toBe(200);

    const left = await getPrismaClient().session.findMany({
      where: { userId: USER_ID },
      select: { id: true },
    });
    expect(left.map((s) => s.id)).toEqual([current]);
    expect(left.map((s) => s.id)).not.toContain(other);
  });

  it("leaves other sign-ins alone when a security key was already there", async () => {
    const secret = await pendingSecret();
    await getPrismaClient().webauthnMfaCredential.create({
      data: {
        userId: USER_ID,
        name: "Key",
        credentialId: "cred-1",
        credentialPublicKey: Buffer.from("pk"),
        counter: BigInt(0),
        transports: [],
      },
    });
    await session();
    const current = await session();
    cookieJar.set("healthlog_session", current);

    const res = await confirm(codeFor(secret));
    expect(res.status).toBe(200);
    expect(
      await getPrismaClient().session.count({ where: { userId: USER_ID } }),
    ).toBe(2);
  });
});
