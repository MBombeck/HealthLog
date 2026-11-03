/**
 * Adding a factor to an account needs a fresh proof, not just a live session.
 *
 * The chain this closes: a stolen browser session starts TOTP enrollment, reads
 * a code from the secret it was just handed, and presents that code as "an
 * existing second factor" — to mint a step-up, to register its own passkey, to
 * pass the fresh-factor gates. Two rules break it, and both are pinned here
 * against real Postgres:
 *
 *   1. a code from a secret that was never confirmed is not a factor anywhere;
 *   2. the cookie arm of TOTP and security-key enrollment wants a sign-in or a
 *      second factor from the last five minutes, or a proof in the body.
 */
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-enrollment-proof-32-bytes-minimum-1234567890";

const { hashToken } = await import("@/lib/auth/hmac");
const { hashPassword } = await import("@/lib/auth/password");

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

const USER_ID = "user-enroll-proof";
const PASSWORD = "Correct horse battery staple!42";
const HOUR = 60 * 60 * 1000;

type RouteFn = (request: NextRequest) => Promise<Response>;

function post(path: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  for (const name of ["authorization", "x-step-up"]) {
    const value = headerJar.get(name);
    if (value) headers[name] = value;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function totpSetup(body?: unknown) {
  const { POST } = await import("@/app/api/auth/me/mfa/totp/setup/route");
  return (POST as unknown as RouteFn)(
    post("/api/auth/me/mfa/totp/setup", body),
  );
}

async function securityKeyOptions(body?: unknown) {
  const { POST } =
    await import("@/app/api/auth/me/mfa/webauthn/register/options/route");
  return (POST as unknown as RouteFn)(
    post("/api/auth/me/mfa/webauthn/register/options", body),
  );
}

async function stepUpMint(body: unknown) {
  const { POST } = await import("@/app/api/auth/step-up/route");
  return (POST as unknown as RouteFn)(post("/api/auth/step-up", body));
}

async function startSession(opts: {
  createdAgoMs: number;
  mfaVerifiedAgoMs?: number;
}): Promise<string> {
  const now = Date.now();
  const session = await getPrismaClient().session.create({
    data: {
      userId: USER_ID,
      createdAt: new Date(now - opts.createdAgoMs),
      expiresAt: new Date(now + HOUR),
      mfaVerifiedAt:
        opts.mfaVerifiedAgoMs === undefined
          ? null
          : new Date(now - opts.mfaVerifiedAgoMs),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return session.id;
}

async function seedPendingTotp(): Promise<string> {
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  const { encrypt } = await import("@/lib/crypto");
  const secret = generateTotpSecret();
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: {
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: null,
      totpLastStep: null,
    },
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

async function errorCode(res: Response): Promise<string | undefined> {
  const body = (await res.json()) as { meta?: { errorCode?: string } };
  return body.meta?.errorCode;
}

async function storedSecret(): Promise<string | null> {
  const user = await getPrismaClient().user.findUniqueOrThrow({
    where: { id: USER_ID },
    select: { totpSecretEncrypted: true },
  });
  return user.totpSecretEncrypted;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  process.env.APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "enroll-user",
      email: "enroll@example.test",
      role: "USER",
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});

describe("TOTP enrollment on the cookie arm", () => {
  it("refuses a session that is neither fresh nor carrying a proof", async () => {
    await startSession({ createdAgoMs: HOUR });
    const res = await totpSetup();
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth.reproof.required");
    expect(await storedSecret()).toBeNull();
  });

  it("enrolls with the account password in the body", async () => {
    await startSession({ createdAgoMs: HOUR });
    const res = await totpSetup({ method: "password", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await storedSecret()).not.toBeNull();
  });

  it("enrolls without a body right after signing in", async () => {
    await startSession({ createdAgoMs: 30_000 });
    const res = await totpSetup();
    expect(res.status).toBe(200);
  });

  it("enrolls without a body after a recent second factor", async () => {
    await startSession({ createdAgoMs: HOUR, mfaVerifiedAgoMs: 60_000 });
    const res = await totpSetup();
    expect(res.status).toBe(200);
  });

  it("refuses and audits a wrong password", async () => {
    await startSession({ createdAgoMs: HOUR });
    const res = await totpSetup({ method: "password", password: "nope" });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth.reproof.failed");
    expect(await storedSecret()).toBeNull();
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: USER_ID, action: "auth.mfa.failed" },
      }),
    ).toBe(1);
  });

  it("does not take a code from its own pending secret as the proof", async () => {
    const secret = await seedPendingTotp();
    await startSession({ createdAgoMs: HOUR });
    const res = await totpSetup({ method: "totp", code: codeFor(secret) });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth.reproof.failed");
  });

  it("cannot be guessed at past the shared re-proof ceiling", async () => {
    await startSession({ createdAgoMs: HOUR });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await totpSetup({ method: "password", password: `guess-${i}` }))
          .status,
      );
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });
});

describe("security-key enrollment on the cookie arm", () => {
  it("refuses a stale session without a proof and creates no challenge", async () => {
    await startSession({ createdAgoMs: HOUR });
    const res = await securityKeyOptions();
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe("auth.reproof.required");
    expect(await getPrismaClient().authChallenge.count()).toBe(0);
  });

  it("issues options once the password is re-proved", async () => {
    await startSession({ createdAgoMs: HOUR });
    const res = await securityKeyOptions({
      method: "password",
      password: PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(await getPrismaClient().authChallenge.count()).toBe(1);
  });
});

describe("a pending TOTP secret on the Bearer arm", () => {
  it("cannot mint a step-up elevation", async () => {
    const secret = await seedPendingTotp();
    const raw = `hlk_enrollproof${"0".repeat(64 - "enrollproof".length)}`;
    await getPrismaClient().apiToken.create({
      data: {
        userId: USER_ID,
        name: "phone",
        tokenHash: hashToken(raw),
        permissions: ["*"],
      },
    });
    headerJar.set("authorization", `Bearer ${raw}`);

    const res = await stepUpMint({ method: "totp", code: codeFor(secret) });
    expect(res.status).toBe(401);
    expect(await getPrismaClient().stepUpElevation.count()).toBe(0);
  });
});
