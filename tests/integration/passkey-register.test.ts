/**
 * Primary-passkey enrollment security boundary.
 *
 * These are deliberately RED contracts for v1.34.1. A registration ceremony
 * is not authorized by possession of an ambient cookie or any Bearer token.
 * The caller must re-prove an existing account factor in the same cookie
 * session, and the resulting WebAuthn challenge must remain bound to that
 * user, purpose, session, expiry, and one redemption.
 *
 * WebAuthn cryptography is mocked because a test process cannot manufacture a
 * hardware attestation. Authentication policy, challenge persistence, route
 * handling, and Passkey insertion all run against the real PostgreSQL
 * Testcontainer.
 */
import { NextRequest } from "next/server";
import * as OTPAuth from "otpauth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-passkey-enrollment-32-bytes-minimum-123456789";

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

vi.mock("@/lib/auth/passkey", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/passkey")>(
      "@/lib/auth/passkey",
    );
  return {
    ...actual,
    verifyAuthentication: vi.fn(),
    verifyRegistration: vi.fn(),
  };
});

vi.mock("@/lib/auth/mfa/webauthn", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/auth/mfa/webauthn")
  >("@/lib/auth/mfa/webauthn");
  return {
    ...actual,
    verifyMfaAuthentication: vi.fn(),
  };
});

const USER_ID = "user-passkey-register";
const OTHER_USER_ID = "user-passkey-register-other";
const PASSWORD = "Correct horse battery staple!42";

type RouteFn = (request: NextRequest) => Promise<Response>;

function request(path: string, body?: unknown): NextRequest {
  const headers: Record<string, string> = {};
  const authorization = headerJar.get("authorization");
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function registerOptions(proof?: Record<string, unknown>) {
  const { POST } =
    await import("@/app/api/auth/passkey/register-options/route");
  return (POST as unknown as RouteFn)(
    request("/api/auth/passkey/register-options", proof),
  );
}

async function registerVerify(challengeId: string, credentialId: string) {
  const { POST } = await import("@/app/api/auth/passkey/register-verify/route");
  return POST(
    request("/api/auth/passkey/register-verify", {
      challengeId,
      credential: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: "client-data",
          attestationObject: "attestation",
          transports: ["internal"],
        },
        clientExtensionResults: {},
      },
    }),
  );
}

function assertionCredential(id: string) {
  return {
    id,
    rawId: id,
    type: "public-key",
    response: {
      clientDataJSON: "client-data",
      authenticatorData: "authenticator-data",
      signature: "signature",
    },
    clientExtensionResults: {},
  };
}

async function currentSessionId(): Promise<string> {
  const session = await getPrismaClient().session.findFirstOrThrow({
    where: { userId: USER_ID },
    select: { id: true },
  });
  return session.id;
}

async function issueOptions(proof: Record<string, unknown>) {
  const response = await registerOptions(proof);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { challengeId: string; options: { challenge: string } };
  };
  return body.data;
}

async function expectNoCredential(): Promise<void> {
  expect(await getPrismaClient().passkey.count()).toBe(0);
}

async function mintBearer(
  permissions: string[],
  label: string,
): Promise<string> {
  const raw = `hlk_${label}${"0".repeat(64 - label.length)}`;
  await getPrismaClient().apiToken.create({
    data: {
      userId: USER_ID,
      name: label,
      tokenHash: hashToken(raw),
      permissions,
    },
  });
  return raw;
}

async function seedTotp(): Promise<string> {
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

function currentTotpCode(secret: string): string {
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

  process.env.APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

  const prisma = getPrismaClient();
  await prisma.user.createMany({
    data: [
      {
        id: USER_ID,
        username: "passkey-user",
        email: "passkey@example.test",
        role: "USER",
        passwordHash: await hashPassword(PASSWORD),
      },
      {
        id: OTHER_USER_ID,
        username: "passkey-other",
        email: "passkey-other@example.test",
        role: "USER",
        passwordHash: await hashPassword(PASSWORD),
      },
    ],
  });
  const session = await prisma.session.create({
    data: {
      userId: USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);

  const { verifyAuthentication, verifyRegistration } =
    await import("@/lib/auth/passkey");
  vi.mocked(verifyAuthentication).mockResolvedValue({
    verification: { verified: true },
    passkey: { userId: USER_ID },
  } as never);
  vi.mocked(verifyRegistration).mockImplementation(
    async (_challengeId, credential) => {
      const id = (credential as { id: string }).id;
      return {
        verified: true,
        registrationInfo: {
          credential: {
            id,
            publicKey: new Uint8Array([1, 2, 3, 4]),
            counter: 0,
          },
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
        },
      } as never;
    },
  );
  const { verifyMfaAuthentication } = await import("@/lib/auth/mfa/webauthn");
  vi.mocked(verifyMfaAuthentication).mockResolvedValue(true);
});

describe("passkey register-options existing-factor proof (real Postgres)", () => {
  it("accepts a fresh password proof and binds the new challenge to the cookie session", async () => {
    const data = await issueOptions({ method: "password", password: PASSWORD });
    const challenge = await getPrismaClient().authChallenge.findUniqueOrThrow({
      where: { id: data.challengeId },
    });

    expect(challenge.userId).toBe(USER_ID);
    expect(challenge.type).toMatch(/^passkey-registration:v1:/);
    expect(challenge.type).not.toContain(await currentSessionId());
    await expectNoCredential();
  });

  it("accepts a fresh TOTP proof", async () => {
    const secret = await seedTotp();
    const data = await issueOptions({
      method: "totp",
      code: currentTotpCode(secret),
    });
    const challenge = await getPrismaClient().authChallenge.findUniqueOrThrow({
      where: { id: data.challengeId },
    });

    expect(challenge.type).toMatch(/^passkey-registration:v1:/);
    await expectNoCredential();
  });

  it("accepts an existing primary passkey proof", async () => {
    const prisma = getPrismaClient();
    await prisma.passkey.create({
      data: {
        userId: USER_ID,
        credentialId: "existing-primary-passkey",
        credentialPublicKey: Buffer.from([4, 3, 2, 1]),
        counter: 0,
        credentialDeviceType: "multiDevice",
        credentialBackedUp: true,
        transports: ["internal"],
      },
    });
    const proofChallenge = await prisma.authChallenge.create({
      data: {
        userId: USER_ID,
        challenge: "primary-proof",
        type: "authentication",
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    const data = await issueOptions({
      method: "passkey",
      challengeId: proofChallenge.id,
      credential: assertionCredential("existing-primary-passkey"),
    });
    const challenge = await prisma.authChallenge.findUniqueOrThrow({
      where: { id: data.challengeId },
    });

    expect(challenge.type).toMatch(/^passkey-registration:v1:/);
    expect(await prisma.passkey.count({ where: { userId: USER_ID } })).toBe(1);
  });

  it("accepts an existing MFA WebAuthn proof", async () => {
    const prisma = getPrismaClient();
    await prisma.webauthnMfaCredential.create({
      data: {
        userId: USER_ID,
        credentialId: "existing-mfa-key",
        credentialPublicKey: Buffer.from([9, 8, 7, 6]),
        counter: 0,
        transports: ["usb"],
      },
    });
    const proofChallenge = await prisma.authChallenge.create({
      data: {
        userId: USER_ID,
        challenge: "mfa-proof",
        type: "mfa_authentication",
        expiresAt: new Date(Date.now() + 5 * 60_000),
      },
    });

    const data = await issueOptions({
      method: "webauthn",
      challengeId: proofChallenge.id,
      credential: assertionCredential("existing-mfa-key"),
    });
    const challenge = await prisma.authChallenge.findUniqueOrThrow({
      where: { id: data.challengeId },
    });

    expect(challenge.type).toMatch(/^passkey-registration:v1:/);
    await expectNoCredential();
  });

  it("rejects an ambient cookie that presents no fresh existing-factor proof", async () => {
    const response = await registerOptions();

    expect(response.status).toBe(401);
    expect(await getPrismaClient().authChallenge.count()).toBe(0);
    await expectNoCredential();
  });

  it("refuses a code from a TOTP secret that was never confirmed", async () => {
    const secret = await seedTotp();
    await getPrismaClient().user.update({
      where: { id: USER_ID },
      data: { totpConfirmedAt: null },
    });

    const response = await registerOptions({
      method: "totp",
      code: currentTotpCode(secret),
    });

    expect(response.status).toBe(401);
    expect(await getPrismaClient().authChallenge.count()).toBe(0);
    const session = await getPrismaClient().session.findFirstOrThrow({
      where: { userId: USER_ID },
      select: { mfaVerifiedAt: true },
    });
    expect(session.mfaVerifiedAt).toBeNull();
  });

  it("audits every wrong proof and stops guessing after five", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await registerOptions({
        method: "password",
        password: `wrong-guess-${i}`,
      });
      statuses.push(response.status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const failed = await getPrismaClient().auditLog.findMany({
      where: { userId: USER_ID, action: "auth.mfa.failed" },
      select: { details: true },
    });
    expect(failed).toHaveLength(5);
    const details = failed[0].details;
    expect(
      typeof details === "string" ? JSON.parse(details) : details,
    ).toMatchObject({
      stage: "passkey_enroll",
      method: "password",
      reason: "bad_password",
    });

    // The bucket is spent, so even the right password waits it out.
    const correct = await registerOptions({
      method: "password",
      password: PASSWORD,
    });
    expect(correct.status).toBe(429);
    expect(await getPrismaClient().authChallenge.count()).toBe(0);
  });

  it.each([
    ["wildcard", ["*"]],
    ["narrow", ["medication:ingest"]],
  ])(
    "rejects a %s Bearer token even with the account password",
    async (_, permissions) => {
      cookieJar.clear();
      const raw = await mintBearer(permissions, `bearer-${permissions[0]}`);
      headerJar.set("authorization", `Bearer ${raw}`);

      const response = await registerOptions({
        method: "password",
        password: PASSWORD,
      });

      expect([401, 403]).toContain(response.status);
      expect(await getPrismaClient().authChallenge.count()).toBe(0);
      await expectNoCredential();
    },
  );
});

describe("register-verify repeats cookie/fresh-factor and challenge binding", () => {
  it("persists one credential for a fresh same-session password ceremony", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });

    const response = await registerVerify(challengeId, "new-credential");

    expect(response.status).toBe(200);
    expect(
      await getPrismaClient().passkey.count({ where: { userId: USER_ID } }),
    ).toBe(1);
  });

  it("rejects verify after the proof becomes stale", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });
    await getPrismaClient().session.update({
      where: { id: await currentSessionId() },
      data: { mfaVerifiedAt: new Date(Date.now() - 6 * 60_000) },
    });

    const response = await registerVerify(challengeId, "stale-proof");

    expect(response.status).toBe(401);
    await expectNoCredential();
  });

  it("rejects a challenge from another cookie session", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });
    const foreignSession = await getPrismaClient().session.create({
      data: {
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", foreignSession.id);

    const response = await registerVerify(challengeId, "foreign-session");

    expect(response.status).toBe(401);
    await expectNoCredential();
  });

  it("rejects a challenge from another user", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });
    const foreignSession = await getPrismaClient().session.create({
      data: {
        userId: OTHER_USER_ID,
        expiresAt: new Date(Date.now() + 60 * 60_000),
        mfaVerifiedAt: new Date(),
      },
    });
    cookieJar.set("healthlog_session", foreignSession.id);

    const response = await registerVerify(challengeId, "foreign-user");

    expect(response.status).toBe(401);
    await expectNoCredential();
  });

  it("rejects a challenge with the wrong purpose", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });
    await getPrismaClient().authChallenge.update({
      where: { id: challengeId },
      data: { type: "authentication" },
    });

    const response = await registerVerify(challengeId, "wrong-purpose");

    expect(response.status).toBe(400);
    await expectNoCredential();
  });

  it("rejects an expired enrollment challenge", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });
    await getPrismaClient().authChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const response = await registerVerify(challengeId, "expired");

    expect(response.status).toBe(400);
    await expectNoCredential();
  });

  it("consumes the challenge once so replay cannot create a second credential", async () => {
    const { challengeId } = await issueOptions({
      method: "password",
      password: PASSWORD,
    });

    expect((await registerVerify(challengeId, "first")).status).toBe(200);
    const replay = await registerVerify(challengeId, "second");

    expect([400, 401]).toContain(replay.status);
    expect(await getPrismaClient().passkey.count()).toBe(1);
    expect(
      await getPrismaClient().authChallenge.findUnique({
        where: { id: challengeId },
      }),
    ).toBeNull();
  });
});
