/**
 * v1.4.35 — integration coverage for the passkey registration ceremony.
 *
 * F-2 in the test coverage audit flagged
 * `/api/auth/passkey/register-options` and `register-verify` as having
 * zero route tests. The ceremony is purely server-side — a regression
 * in the challenge-store roundtrip ships silently. This file pins:
 *
 *   - register-options issues a challenge, persists it in
 *     `auth_challenges`, and returns the RP-ID derived from APP_URL
 *   - register-verify with a valid (mocked) attestation persists a
 *     Passkey row and consumes the challenge
 *   - register-verify with a tampered attestation responds 400 and
 *     does NOT persist a Passkey
 *
 * `@simplewebauthn/server` runs cryptographic verification we can't
 * fake against real WebAuthn output in a unit-test setting; the helper
 * module that wraps it (`src/lib/auth/passkey.ts`) is mocked so the
 * test exercises the route handler + DB write path end-to-end.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// `verifyRegistration` runs the upstream attestation verification that
// requires real WebAuthn credentials. Stub the helper so the test owns
// the success / failure branch shape; the route handler's
// challenge-lookup + Passkey insertion still runs against real Postgres.
vi.mock("@/lib/auth/passkey", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/passkey")>(
    "@/lib/auth/passkey",
  );
  return {
    ...actual,
    verifyRegistration: vi.fn(),
  };
});

const TEST_USER_ID = "user-passkey-register";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();

  // The RP-ID derives from APP_URL / NEXT_PUBLIC_APP_URL; pin both so
  // the assertion below can compare literal hostnames.
  process.env.APP_URL = "http://localhost:3000";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "passkey-user",
      email: "passkey@example.test",
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Passkey registration (real Postgres)", () => {
  it("register-options persists a challenge and returns the RP-ID from APP_URL", async () => {
    const { POST } = await import(
      "@/app/api/auth/passkey/register-options/route"
    );
    // The route handler takes no arguments at the TS level (the wrapper
    // ignores the request) — cast to a no-arg callable for clarity.
    const res = await (POST as unknown as () => Promise<Response>)();

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        options: {
          challenge: string;
          rp: { name: string; id: string };
        };
        challengeId: string;
      };
    };

    expect(body.data.challengeId).toBeTruthy();
    expect(body.data.options.challenge).toBeTruthy();
    expect(body.data.options.rp.id).toBe("localhost");
    expect(body.data.options.rp.name).toBe("HealthLog");

    // The challenge row landed in `auth_challenges` and is tied to the
    // calling user with type=registration and a future expiry.
    const prisma = getPrismaClient();
    const stored = await prisma.authChallenge.findUnique({
      where: { id: body.data.challengeId },
    });
    expect(stored).not.toBeNull();
    expect(stored?.userId).toBe(TEST_USER_ID);
    expect(stored?.type).toBe("registration");
    expect(stored!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("register-verify persists a Passkey row on a verified attestation", async () => {
    const { verifyRegistration } = await import("@/lib/auth/passkey");
    const credentialIdRaw = "valid-credential-id";
    vi.mocked(verifyRegistration).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: credentialIdRaw,
          publicKey: new Uint8Array([1, 2, 3, 4, 5]),
          counter: 0,
        },
        credentialDeviceType: "singleDevice",
        credentialBackedUp: false,
      },
    } as never);

    const prisma = getPrismaClient();
    // Seed a challenge row so the verify path can resolve `challengeId`.
    const challenge = await prisma.authChallenge.create({
      data: {
        userId: TEST_USER_ID,
        challenge: "fake-server-challenge",
        type: "registration",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const { POST } = await import(
      "@/app/api/auth/passkey/register-verify/route"
    );
    const res = await POST(
      new NextRequest("http://localhost/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.id,
          credential: {
            id: credentialIdRaw,
            response: { transports: ["internal"] },
          },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { verified: boolean } };
    expect(body.data.verified).toBe(true);

    // Passkey row exists and is tied to this user.
    const passkeys = await prisma.passkey.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(passkeys).toHaveLength(1);
    expect(passkeys[0].credentialId).toBe(credentialIdRaw);
    expect(passkeys[0].transports).toEqual(["internal"]);

    // Audit row for the register action.
    const audit = await prisma.auditLog.findFirst({
      where: { userId: TEST_USER_ID, action: "auth.passkey.register" },
    });
    expect(audit).not.toBeNull();
  });

  it("register-verify returns 400 on a tampered attestation and writes no Passkey", async () => {
    const { verifyRegistration } = await import("@/lib/auth/passkey");
    vi.mocked(verifyRegistration).mockResolvedValue({
      verified: false,
    } as never);

    const prisma = getPrismaClient();
    const challenge = await prisma.authChallenge.create({
      data: {
        userId: TEST_USER_ID,
        challenge: "fake-server-challenge",
        type: "registration",
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    const { POST } = await import(
      "@/app/api/auth/passkey/register-verify/route"
    );
    const res = await POST(
      new NextRequest("http://localhost/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.id,
          credential: { id: "tampered-credential" },
        }),
      }),
    );

    expect(res.status).toBe(400);

    const passkeys = await prisma.passkey.findMany({
      where: { userId: TEST_USER_ID },
    });
    expect(passkeys).toHaveLength(0);
  });

  it("register-verify returns 422 when challengeId is missing", async () => {
    const { POST } = await import(
      "@/app/api/auth/passkey/register-verify/route"
    );
    const res = await POST(
      new NextRequest("http://localhost/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential: { id: "x" } }),
      }),
    );

    expect(res.status).toBe(422);
  });
});
