/**
 * #959 — a passkey counts as the second factor on the managed-profile acts.
 *
 * A Guardian whose only strong credential is a primary passkey (a password
 * too, but no TOTP and no security key) used to be refused
 * `auth.stepup.mfa_not_enrolled` by `requireFreshMfa`, and so could not hand a
 * profile over, create one or manage its guardians. Driven against real
 * Postgres through the real routes, with only the WebAuthn signature check
 * stubbed:
 *
 *   1. the password login is unchanged: no MFA challenge, a session straight
 *      away, and that session is not stamped as a fresh factor;
 *   2. the handover refuses with `auth.stepup.required` and offers the passkey
 *      (not the password) as the way through;
 *   3. a password re-proof does not open the gate;
 *   4. a passkey re-proof, which is what the dialog posts, does, and the
 *      handover goes through.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { handoverCreateBody } from "@/lib/queries/use-managed-profiles";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-managed-profile-passkey-step-up-32-bytes-min";

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

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async () => {}),
}));

// The signature check is the one piece a test cannot produce honestly; the
// challenge lookup, the ownership check and the session stamp all run.
vi.mock("@/lib/auth/passkey", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/auth/passkey")>(
      "@/lib/auth/passkey",
    );
  return { ...actual, verifyAuthentication: vi.fn() };
});

const { hashPassword } = await import("@/lib/auth/password");

const APP = "http://localhost:3000";
const PASSWORD = "Correct horse battery staple!42";
const EMAIL = "guardian@example.test";
const CREDENTIAL_ID = "guardian-primary-passkey";

type RouteFn = (request: NextRequest) => Promise<Response>;

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function login() {
  const { POST } = await import("@/app/api/auth/login/route");
  return (POST as unknown as RouteFn)(
    post("/api/auth/login", { email: EMAIL, password: PASSWORD }),
  );
}

async function reproof(body: unknown) {
  const { POST } = await import("@/app/api/auth/reproof/route");
  return (POST as unknown as RouteFn)(post("/api/auth/reproof", body));
}

async function handover(profileId: string) {
  const { POST } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  return POST(
    post(
      `/api/managed-profiles/${profileId}/handover`,
      handoverCreateBody({ profileId, expiresInDays: 7, proposals: [] }),
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
}

async function body(res: Response) {
  return (await res.json()) as {
    data?: unknown;
    meta?: { errorCode?: string; methods?: string[]; mfaRequired?: boolean };
  };
}

async function passkeyProof(userId: string) {
  const challenge = await getPrismaClient().authChallenge.create({
    data: {
      userId,
      challenge: `proof-${Date.now()}`,
      type: "authentication",
      expiresAt: new Date(Date.now() + 5 * 60_000),
    },
  });
  return {
    method: "passkey",
    challengeId: challenge.id,
    credential: {
      id: CREDENTIAL_ID,
      rawId: CREDENTIAL_ID,
      type: "public-key",
      response: {
        clientDataJSON: "client-data",
        authenticatorData: "authenticator-data",
        signature: "signature",
      },
      clientExtensionResults: {},
    },
  };
}

let guardianId = "";
let profileId = "";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.authChallenge.deleteMany();
  await prisma.rateLimit.deleteMany();
  cookieJar.clear();
  headerJar.clear();
  process.env.APP_URL = APP;
  process.env.NEXT_PUBLIC_APP_URL = APP;

  const guardian = await prisma.user.create({
    data: {
      username: "guardian",
      email: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      onboardingCompletedAt: new Date(),
    },
  });
  guardianId = guardian.id;
  await prisma.passkey.create({
    data: {
      userId: guardian.id,
      credentialId: CREDENTIAL_ID,
      credentialPublicKey: Buffer.from([4, 3, 2, 1]),
      counter: 0,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      transports: ["internal"],
    },
  });
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Robin",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  profileId = profile.id;

  const { verifyAuthentication } = await import("@/lib/auth/passkey");
  vi.mocked(verifyAuthentication).mockResolvedValue({
    verification: { verified: true },
    passkey: { userId: guardian.id },
  } as never);
});

describe("a Guardian whose only strong credential is a passkey", () => {
  it("signs in with the password exactly as before, without an MFA challenge", async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect((await body(res)).meta?.mfaRequired).toBeUndefined();
    expect(cookieJar.get("healthlog_session")).toBeDefined();
    const session = await getPrismaClient().session.findFirstOrThrow({
      where: { userId: guardianId },
      select: { mfaVerifiedAt: true },
    });
    // The password login proves no factor, so it cannot open the gate itself.
    expect(session.mfaVerifiedAt).toBeNull();
    expect(await getPrismaClient().mfaChallenge.count()).toBe(0);
  });

  it("is offered the passkey, refused on a password, and hands over after the passkey", async () => {
    expect((await login()).status).toBe(200);

    const refused = await handover(profileId);
    expect(refused.status).toBe(401);
    expect((await body(refused)).meta).toMatchObject({
      errorCode: "auth.stepup.required",
      methods: ["passkey"],
    });

    // A password re-proof is accepted by the endpoint (the recent-proof gate
    // still takes it on this account) but stamps no factor, so the handover
    // stays shut.
    const byPassword = await reproof({
      method: "password",
      password: PASSWORD,
    });
    expect(byPassword.status).toBe(200);
    expect((await handover(profileId)).status).toBe(401);

    // What the dialog posts after the passkey ceremony.
    const byPasskey = await reproof(await passkeyProof(guardianId));
    expect(byPasskey.status).toBe(200);

    const minted = await handover(profileId);
    expect(minted.status).toBe(201);
    expect(
      await getPrismaClient().managedProfileHandover.count({
        where: { profileId },
      }),
    ).toBe(1);
  });
});
