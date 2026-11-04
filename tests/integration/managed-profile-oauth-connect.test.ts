/**
 * A guardian connects an OAuth provider for a managed profile, against real
 * Postgres: the connect route mints a state naming the profile, the
 * provider's callback lands the tokens on the profile, and every refusal the
 * flow promises holds (an adult's record, a revoked grant, a READ grant, no
 * guardian session). Oura stands for the signed-state flows; the ledger
 * flows share `verifyCallbackActor`, which is exercised directly too.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.API_TOKEN_HMAC_KEY ??=
  "integration-hmac-key-0123456789abcdef0123456789";

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

const OURA_TOKEN_URL = "https://moi.ouraring.com/oauth/v2/ext/oauth-token";
const OURA_ISS = "https://moi.ouraring.com/oauth/v2/ext/oauth-anonymous";
const GUARDIAN = "guardian-oauth";
const PROFILE = "profile-oauth";
const ADULT = "adult-oauth";

function urlOf(input: unknown): string {
  return typeof input === "string" ? input : (input as Request).url;
}

async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

async function grant(
  grantorId: string,
  access: "READ" | "WRITE" | "MANAGE" = "MANAGE",
) {
  return getPrismaClient().accountGrant.create({
    data: { grantorId, granteeId: GUARDIAN, access, acceptedAt: new Date() },
  });
}

async function startConnect(): Promise<Response> {
  const { POST } =
    await import("@/app/api/record-settings/integrations/[provider]/connect/route");
  return POST(
    new NextRequest(
      "http://localhost/api/record-settings/integrations/oura/connect",
      { method: "POST" },
    ),
    { params: Promise.resolve({ provider: "oura" }) },
  );
}

async function ouraCallback(state: string) {
  const { GET } = await import("@/app/api/oura/callback/route");
  const params = new URLSearchParams({
    code: "oura-code",
    state,
    iss: OURA_ISS,
  });
  return GET(
    new NextRequest(`http://localhost/api/oura/callback?${params}`, {
      method: "GET",
      headers: { cookie: `oura_oauth_state=${state}` },
    }),
  );
}

function stateOf(authorizationUrl: string): string {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("no state in the consent URL");
  return state;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.OURA_CLIENT_ID;
  delete process.env.OURA_CLIENT_SECRET;
  delete process.env.OURA_REDIRECT_URI;

  const { encrypt } = await import("@/lib/crypto");
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: GUARDIAN,
      username: "guardian-oauth",
      email: "guardian-oauth@example.test",
      role: "USER",
      // The guardian's own Oura app; the profile has none.
      ouraClientIdEncrypted: encrypt("guardian-oura-client"),
      ouraClientSecretEncrypted: encrypt("guardian-oura-secret"),
    },
  });
  await prisma.user.create({
    data: {
      id: PROFILE,
      username: "profile-oauth",
      email: "profile-oauth@example.test",
      role: "USER",
      managedProfileAt: new Date(),
    },
  });
  await prisma.user.create({
    data: {
      id: ADULT,
      username: "adult-oauth",
      email: "adult-oauth@example.test",
      role: "USER",
    },
  });

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (urlOf(input) !== OURA_TOKEN_URL) {
      throw new Error(`Unexpected fetch: ${urlOf(input)}`);
    }
    return new Response(
      JSON.stringify({
        access_token: "profile-access",
        refresh_token: "profile-refresh",
        expires_in: 86400,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a guardian connects Oura for a managed profile", () => {
  it("lands the tokens on the profile, never on the guardian, and audits both steps", async () => {
    await grant(PROFILE);
    const session = await signIn(GUARDIAN);
    await switchSessionTo(session.id, PROFILE);

    const started = await startConnect();
    expect(started.status).toBe(200);
    const body = (await started.json()) as {
      data: { recordId: string; authorizationUrl: string };
    };
    expect(body.data.recordId).toBe(PROFILE);

    const { verifySignedState } = await import("@/lib/oauth/signed-state");
    const state = stateOf(body.data.authorizationUrl);
    expect(verifySignedState("oura", state)?.userId).toBe(PROFILE);

    const res = await ouraCallback(state);
    expect(res.headers.get("location")).toContain("oura=connected");

    const { decrypt } = await import("@/lib/crypto");
    const prisma = getPrismaClient();
    const profile = await prisma.user.findUniqueOrThrow({
      where: { id: PROFILE },
      select: {
        ouraAccessTokenEncrypted: true,
        ouraRefreshTokenEncrypted: true,
        ouraClientIdEncrypted: true,
      },
    });
    expect(decrypt(profile.ouraAccessTokenEncrypted!)).toBe("profile-access");
    expect(decrypt(profile.ouraRefreshTokenEncrypted!)).toBe("profile-refresh");
    // The guardian's app was borrowed, sealed, for the refresh to use later.
    expect(decrypt(profile.ouraClientIdEncrypted!)).toBe(
      "guardian-oura-client",
    );
    const guardian = await prisma.user.findUniqueOrThrow({
      where: { id: GUARDIAN },
      select: { ouraAccessTokenEncrypted: true },
    });
    expect(guardian.ouraAccessTokenEncrypted).toBeNull();

    const audits = await prisma.auditLog.findMany({
      where: { userId: PROFILE },
      select: { action: true, actorUserId: true },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toEqual(
      expect.arrayContaining([
        { action: "integration.client_app.shared", actorUserId: GUARDIAN },
        { action: "integration.connect.started", actorUserId: GUARDIAN },
        { action: "oura.connect", actorUserId: GUARDIAN },
      ]),
    );
  });

  it("refuses the callback once the grant was revoked on the consent screen", async () => {
    const live = await grant(PROFILE);
    const session = await signIn(GUARDIAN);
    await switchSessionTo(session.id, PROFILE);
    const started = await startConnect();
    const { data } = (await started.json()) as {
      data: { authorizationUrl: string };
    };

    await getPrismaClient().accountGrant.update({
      where: { id: live.id },
      data: { revokedAt: new Date(), revokedBy: "GRANTOR" },
    });

    const res = await ouraCallback(stateOf(data.authorizationUrl));
    expect(res.headers.get("location")).toContain("reason=cross_user");
    const profile = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: PROFILE },
      select: { ouraAccessTokenEncrypted: true },
    });
    expect(profile.ouraAccessTokenEncrypted).toBeNull();
  });

  it("does not start a connect on an adult's record, even under MANAGE", async () => {
    await grant(ADULT);
    const session = await signIn(GUARDIAN);
    await switchSessionTo(session.id, ADULT);
    const res = await startConnect();
    expect(res.status).toBe(403);
  });
});

describe("verifyCallbackActor against real grants", () => {
  it("admits only a live MANAGE grant on a managed profile", async () => {
    const { verifyCallbackActor } =
      await import("@/lib/integrations/oauth-kit/connect-target");
    await expect(verifyCallbackActor(PROFILE, GUARDIAN)).resolves.toEqual({
      ok: false,
      reason: "cross_user",
    });

    const read = await grant(PROFILE, "READ");
    await expect(verifyCallbackActor(PROFILE, GUARDIAN)).resolves.toMatchObject(
      { ok: false },
    );
    await getPrismaClient().accountGrant.delete({ where: { id: read.id } });

    await grant(PROFILE, "MANAGE");
    await expect(verifyCallbackActor(PROFILE, GUARDIAN)).resolves.toEqual({
      ok: true,
      guardianUserId: GUARDIAN,
    });
    // A managed profile has no session of its own to finish a connect with.
    await expect(verifyCallbackActor(PROFILE, null)).resolves.toEqual({
      ok: false,
      reason: "guardian_session_required",
    });

    await grant(ADULT, "MANAGE");
    await expect(verifyCallbackActor(ADULT, GUARDIAN)).resolves.toEqual({
      ok: false,
      reason: "cross_user",
    });
    await expect(verifyCallbackActor(ADULT, null)).resolves.toEqual({
      ok: true,
      guardianUserId: null,
    });
  });
});

describe("one provider account, one record", () => {
  it("refuses to attach the guardian's own Oura account to the profile", async () => {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: GUARDIAN },
      data: { ouraUserId: "oura-account-guardian" },
    });
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v2/usercollection/personal_info")) {
        return new Response(JSON.stringify({ id: "oura-account-guardian" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url !== OURA_TOKEN_URL) throw new Error(`Unexpected fetch: ${url}`);
      return new Response(
        JSON.stringify({
          access_token: "guardian-access",
          refresh_token: "guardian-refresh",
          expires_in: 86400,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    await grant(PROFILE);
    const session = await signIn(GUARDIAN);
    await switchSessionTo(session.id, PROFILE);
    const started = await startConnect();
    const { data } = (await started.json()) as {
      data: { authorizationUrl: string };
    };

    const res = await ouraCallback(stateOf(data.authorizationUrl));
    expect(res.headers.get("location")).toContain("reason=already_linked");
    const profile = await prisma.user.findUniqueOrThrow({
      where: { id: PROFILE },
      select: { ouraAccessTokenEncrypted: true, ouraUserId: true },
    });
    expect(profile.ouraAccessTokenEncrypted).toBeNull();
    expect(profile.ouraUserId).toBeNull();
  });

  it("finds the other holder of a Withings account and routes its webhook to the first", async () => {
    const prisma = getPrismaClient();
    const { encrypt } = await import("@/lib/crypto");
    const base = {
      withingsUserId: "withings-shared",
      accessToken: encrypt("a"),
      refreshToken: encrypt("r"),
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
    };
    await prisma.withingsConnection.create({
      data: {
        ...base,
        userId: GUARDIAN,
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.withingsConnection.create({
      data: { ...base, userId: PROFILE },
    });

    const { otherHoldersOfAccount } =
      await import("@/lib/integrations/oauth-kit/account-link");
    await expect(
      otherHoldersOfAccount("withings", "withings-shared", PROFILE),
    ).resolves.toEqual([GUARDIAN]);
    await expect(
      otherHoldersOfAccount("withings", "withings-shared", ADULT),
    ).resolves.toHaveLength(2);
    await expect(
      otherHoldersOfAccount("withings", "withings-elsewhere", PROFILE),
    ).resolves.toEqual([]);
  });
});

describe("a borrowed provider app leaves with its reason", () => {
  async function connectForProfile() {
    await grant(PROFILE);
    const session = await signIn(GUARDIAN);
    await switchSessionTo(session.id, PROFILE);
    const started = await startConnect();
    const { data } = (await started.json()) as {
      data: { authorizationUrl: string };
    };
    const res = await ouraCallback(stateOf(data.authorizationUrl));
    expect(res.headers.get("location")).toContain("oura=connected");
  }

  async function profileApp() {
    return getPrismaClient().user.findUniqueOrThrow({
      where: { id: PROFILE },
      select: {
        ouraClientIdEncrypted: true,
        ouraClientSecretEncrypted: true,
        clientAppSharedBy: true,
      },
    });
  }

  it("removes the guardian's app when the profile's Oura is disconnected", async () => {
    await connectForProfile();
    expect((await profileApp()).clientAppSharedBy).toEqual({ oura: GUARDIAN });

    const { disconnectOAuth } =
      await import("@/lib/integrations/oauth-kit/disconnect");
    await expect(disconnectOAuth("oura", PROFILE)).resolves.toBe(
      "disconnected",
    );
    expect(await profileApp()).toEqual({
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
      clientAppSharedBy: null,
    });
    const removed = await getPrismaClient().auditLog.findFirst({
      where: { userId: PROFILE, action: "integration.client_app.removed" },
    });
    expect(removed).not.toBeNull();
  });

  it("removes the guardian's app when their MANAGE grant ends", async () => {
    const prisma = getPrismaClient();
    await prisma.user.create({
      data: {
        id: "second-guardian",
        username: "second-guardian",
        email: "second-guardian@example.test",
        role: "USER",
      },
    });
    await prisma.accountGrant.create({
      data: {
        grantorId: PROFILE,
        granteeId: "second-guardian",
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    await connectForProfile();
    const leaving = await prisma.accountGrant.findFirstOrThrow({
      where: { grantorId: PROFILE, granteeId: GUARDIAN, revokedAt: null },
    });

    const { revokeManagedProfileGuardian } =
      await import("@/lib/sharing/grants");
    await revokeManagedProfileGuardian({
      profileId: PROFILE,
      guardianId: "second-guardian",
      grantId: leaving.id,
    });

    const app = await profileApp();
    expect(app.ouraClientIdEncrypted).toBeNull();
    expect(app.ouraClientSecretEncrypted).toBeNull();
    expect(app.clientAppSharedBy).toBeNull();
  });
});
