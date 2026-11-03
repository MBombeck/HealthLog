/**
 * The fresh-proof gate in front of whole-record exports, share links, token
 * minting and the admin data actions, against real Postgres.
 *
 * A live browser session is not enough for these: it needs a sign-in or a
 * re-proof inside five minutes (a second factor, on an account that has one).
 * `POST /api/auth/reproof` is how a session re-proves in place.
 */
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-recent-proof-32-bytes-minimum-1234567890ab";

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

const USER_ID = "user-recent-proof";
const PASSWORD = "Correct horse battery staple!42";
const HOUR = 60 * 60 * 1000;

type RouteFn = (request: NextRequest) => Promise<Response>;

function request(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fullBackup() {
  const { GET } = await import("@/app/api/export/full-backup/route");
  return (GET as unknown as RouteFn)(request("GET", "/api/export/full-backup"));
}

async function reproof(body: unknown) {
  const { POST } = await import("@/app/api/auth/reproof/route");
  return (POST as unknown as RouteFn)(
    request("POST", "/api/auth/reproof", body),
  );
}

async function startSession(createdAgoMs: number): Promise<string> {
  const now = Date.now();
  const session = await getPrismaClient().session.create({
    data: {
      userId: USER_ID,
      createdAt: new Date(now - createdAgoMs),
      expiresAt: new Date(now + HOUR),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return session.id;
}

async function body(res: Response) {
  return (await res.json()) as {
    meta?: { errorCode?: string; methods?: string[] };
  };
}

async function enrollTotp(): Promise<string> {
  const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
  const { encrypt } = await import("@/lib/crypto");
  const secret = generateTotpSecret();
  await getPrismaClient().user.update({
    where: { id: USER_ID },
    data: {
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: new Date(),
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

beforeEach(async () => {
  vi.clearAllMocks();
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: USER_ID,
      username: "recent-proof-user",
      email: "recent-proof@example.test",
      role: "USER",
      passwordHash: await hashPassword(PASSWORD),
    },
  });
});

describe("account without a second factor", () => {
  it("exports right after signing in", async () => {
    await startSession(30_000);
    const res = await fullBackup();
    expect(res.status).toBe(200);
    await res.text();
  });

  it("refuses an old session and names the password as the way through", async () => {
    await startSession(HOUR);
    const res = await fullBackup();
    expect(res.status).toBe(401);
    const b = await body(res);
    expect(b.meta?.errorCode).toBe("auth.reproof.required");
    expect(b.meta?.methods).toEqual(["password"]);
  });

  it("exports after a password re-proof, which stamps only reproofAt", async () => {
    const sessionId = await startSession(HOUR);
    const proved = await reproof({ method: "password", password: PASSWORD });
    expect(proved.status).toBe(200);
    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.reproofAt).not.toBeNull();
    expect(row.mfaVerifiedAt).toBeNull();

    const res = await fullBackup();
    expect(res.status).toBe(200);
    await res.text();
  });

  it("refuses and audits a wrong password without stamping", async () => {
    const sessionId = await startSession(HOUR);
    const res = await reproof({ method: "password", password: "nope" });
    expect(res.status).toBe(401);
    expect((await body(res)).meta?.errorCode).toBe("auth.reproof.failed");
    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.reproofAt).toBeNull();
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: USER_ID, action: "auth.mfa.failed" },
      }),
    ).toBe(1);
  });
});

describe("account with a second factor", () => {
  it("refuses the password as a proof before spending a guess", async () => {
    await enrollTotp();
    await startSession(HOUR);
    const res = await reproof({ method: "password", password: PASSWORD });
    expect(res.status).toBe(422);
    const b = await body(res);
    expect(b.meta?.errorCode).toBe("auth.reproof.too_weak");
    expect(b.meta?.methods).toEqual(["totp"]);
    expect(
      await getPrismaClient().rateLimit.count({
        where: { key: `auth:step-up:${USER_ID}` },
      }),
    ).toBe(0);
  });

  it("a fresh sign-in alone is not enough; a TOTP re-proof is", async () => {
    const secret = await enrollTotp();
    const sessionId = await startSession(30_000);
    const refused = await fullBackup();
    expect(refused.status).toBe(401);
    expect((await body(refused)).meta?.methods).toEqual(["totp"]);

    const proved = await reproof({ method: "totp", code: codeFor(secret) });
    expect(proved.status).toBe(200);
    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.mfaVerifiedAt).not.toBeNull();

    const res = await fullBackup();
    expect(res.status).toBe(200);
    await res.text();
  });
});
