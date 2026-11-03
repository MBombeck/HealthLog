/**
 * v1.43 (#959) — handing a managed profile over on a server that signs in
 * through an identity provider, end to end: the real start route, the real
 * OIDC login and callback, a real Postgres, and a mock identity provider that
 * speaks the wire (discovery, JWKS, a token endpoint that checks PKCE, and
 * ES256-signed ID tokens), so state, nonce, PKCE and the signature are the
 * production code's own checks rather than stubs.
 *
 * Every refusal is asserted twice: where the browser lands, and that nothing
 * about any account changed (the profile is still managed, the subject is not
 * bound, nobody got a session, the link is still as it was).
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { NextRequest } from "next/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { createManagedProfile } from "@/lib/managed-profiles/create";
import { acceptGrant, inviteGrant } from "@/lib/sharing/grants";
import { readPendingHandoverDecision } from "@/lib/managed-profiles/handover";
import { _resetOidcCacheForTests } from "@/lib/auth/oidc";
import { handoverCreateBody } from "@/lib/queries/use-managed-profiles";
import { claimBody, claimSsoBody } from "@/lib/queries/use-profile-claim";
import type { HandoverAccess } from "@/lib/managed-profiles/handover-access";

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

vi.mock("@/lib/password-breach-check", () => ({
  checkPasswordBreachIfEnabled: vi.fn().mockResolvedValue(null),
}));

const sent: { userId: string; messageKey: string }[] = [];
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(
    async (opts: { userId: string; messageKey: string }) => {
      sent.push({ userId: opts.userId, messageKey: opts.messageKey });
    },
  ),
}));

const APP = "http://localhost:3000";
const CLIENT_ID = "healthlog-test";
const CLIENT_SECRET = "client-secret-for-the-mock-idp";

// ── The mock identity provider ──────────────────────────────────────────────

interface Grant {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  nonce: string;
  codeChallenge: string;
  /** The provider would redeem the code more than once (a replay test). */
  reusable?: boolean;
  /** Sign the ID token with this nonce instead of the requested one. */
  nonceOverride?: string;
}

let idp: Server;
let ISSUER = "";
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
const grants = new Map<string, Grant>();
const redeemed: string[] = [];

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readBody(req: import("node:http").IncomingMessage) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return new URLSearchParams(body);
}

beforeAll(async () => {
  const pair = await generateKeyPair("ES256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256" };

  idp = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", ISSUER).pathname;
    if (path === "/.well-known/openid-configuration") {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      });
    }
    if (path === "/jwks") return json(200, { keys: [publicJwk] });
    if (path === "/token" && req.method === "POST") {
      const form = await readBody(req);
      const code = form.get("code") ?? "";
      const grant = grants.get(code);
      if (
        !grant ||
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET ||
        form.get("redirect_uri") !== `${APP}/api/auth/oidc/callback` ||
        // PKCE, as a provider enforces it.
        s256(form.get("code_verifier") ?? "") !== grant.codeChallenge
      ) {
        return json(400, { error: "invalid_grant" });
      }
      if (!grant.reusable) grants.delete(code);
      redeemed.push(code);
      const idToken = await new SignJWT({
        nonce: grant.nonceOverride ?? grant.nonce,
        ...(grant.email !== undefined ? { email: grant.email } : {}),
        ...(grant.emailVerified !== undefined
          ? { email_verified: grant.emailVerified }
          : {}),
      })
        .setProtectedHeader({ alg: "ES256", kid: "k1" })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(grant.sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { id_token: idToken, token_type: "Bearer" });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
  ISSUER = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()));
});

// ── The household ───────────────────────────────────────────────────────────

let sequence = 0;

async function person(label: string) {
  const suffix = sequence++;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `${label}-${suffix}`,
      email: `${label}-${suffix}@example.test`,
      totpConfirmedAt: new Date(),
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      mfaVerifiedAt: new Date(),
    },
  });
  return { id: user.id, username: user.username, sessionId: session.id };
}

/** A profile with two Guardians: its creator and one more. */
async function household() {
  const creator = await person("creator");
  const second = await person("second");
  const { profile, creatorGrant } = await createManagedProfile({
    creatorId: creator.id,
    displayName: "Robin",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  const invitation = await inviteGrant({
    grantorId: profile.id,
    granteeId: second.id,
    access: "MANAGE",
    scope: null,
  });
  const secondGrant = await acceptGrant({
    grantId: invitation.id,
    granteeId: second.id,
  });
  return { creator, second, profile, creatorGrant, secondGrant };
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** Mint a link as the creator (the Guardian side), then sign out. */
async function mintToken(
  creator: { sessionId: string },
  profileId: string,
  proposals: { grantId: string; proposal: HandoverAccess }[] = [],
): Promise<string> {
  cookieJar.set("healthlog_session", creator.sessionId);
  const { POST } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  const response = await POST(
    new NextRequest(
      `${APP}/api/managed-profiles/${profileId}/handover`,
      json(handoverCreateBody({ profileId, expiresInDays: 7, proposals })),
    ),
    { params: Promise.resolve({ id: profileId }) },
  );
  expect(response.status).toBe(201);
  cookieJar.clear();
  return (await response.json()).data.token as string;
}

async function handoverStatus(creator: { sessionId: string }, id: string) {
  cookieJar.set("healthlog_session", creator.sessionId);
  const { GET } =
    await import("@/app/api/managed-profiles/[id]/handover/route");
  const response = await GET(
    new NextRequest(`${APP}/api/managed-profiles/${id}/handover`),
    { params: Promise.resolve({ id }) },
  );
  cookieJar.clear();
  return response;
}

async function preview(token: string) {
  const { POST } = await import("@/app/api/auth/claim/preview/route");
  return POST(
    new NextRequest(`${APP}/api/auth/claim/preview`, json({ token })),
  );
}

async function passwordClaim(token: string) {
  const suffix = sequence++;
  const { POST } = await import("@/app/api/auth/claim/route");
  return POST(
    new NextRequest(
      `${APP}/api/auth/claim`,
      json(
        claimBody({
          token,
          username: `robinpw${suffix}`,
          email: `robin-pw-${suffix}@example.test`,
          password: "correct horse battery staple 1959",
        }),
      ),
    ),
  );
}

async function startSso(token: string, username: string) {
  const { POST } = await import("@/app/api/auth/claim/sso/route");
  return POST(
    new NextRequest(
      `${APP}/api/auth/claim/sso`,
      json(claimSsoBody({ token, username })),
    ),
  );
}

function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** The value a response sets for a cookie, or undefined. */
function setCookie(response: Response, name: string): string | undefined {
  const cookie = (response as NextResponseLike).cookies?.get(name);
  return cookie?.value || undefined;
}
type NextResponseLike = Response & {
  cookies?: { get(name: string): { value: string } | undefined };
};

async function login(claimCookie: string | undefined, query = "intent=claim") {
  const { GET } = await import("@/app/api/auth/oidc/login/route");
  return GET(
    new NextRequest(`${APP}/api/auth/oidc/login?${query}`, {
      headers: { cookie: cookieHeader({ hl_claim: claimCookie }) },
    }),
  );
}

interface Identity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  reusable?: boolean;
  nonceOverride?: string;
}

/** Where the provider sends the browser back, and with which cookies. */
interface Callback {
  url: string;
  stateCookie: string;
  claimCookie: string | undefined;
}

/** The provider authenticates `identity` for an authorize redirect. */
function authorize(loginResponse: Response, identity: Identity, code: string) {
  const location = new URL(loginResponse.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  grants.set(code, {
    ...identity,
    nonce: location.searchParams.get("nonce") ?? "",
    codeChallenge: location.searchParams.get("code_challenge") ?? "",
  });
  return location.searchParams.get("state") ?? "";
}

async function callback(
  cb: Callback,
  extra: Record<string, string | undefined> = {},
) {
  const { GET } = await import("@/app/api/auth/oidc/callback/route");
  return GET(
    new NextRequest(cb.url, {
      headers: {
        cookie: cookieHeader({
          oidc_auth_state: cb.stateCookie,
          hl_claim: cb.claimCookie,
          ...extra,
        }),
      },
    }),
  );
}

/** Start, log in and come back from the provider; the callback not yet run. */
async function throughProvider(
  token: string,
  identity: Identity,
  username = `robin${sequence++}`,
): Promise<Callback> {
  const started = await startSso(token, username);
  expect(started.status).toBe(200);
  expect((await started.json()).data.redirectTo).toBe(
    "/api/auth/oidc/login?intent=claim",
  );
  const claimCookie = setCookie(started, "hl_claim");
  expect(claimCookie).toBeDefined();
  const loginResponse = await login(claimCookie);
  const stateCookie = setCookie(loginResponse, "oidc_auth_state");
  expect(stateCookie).toBeDefined();
  const code = `code-${sequence++}`;
  const state = authorize(loginResponse, identity, code);
  return {
    url: `${APP}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`,
    stateCookie: stateCookie!,
    claimCookie,
  };
}

function landedOn(response: Response): string {
  expect([302, 303, 307]).toContain(response.status);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin).toBe(APP);
  return location.pathname + location.search;
}

async function profileRow(id: string) {
  return getPrismaClient().user.findUniqueOrThrow({
    where: { id },
    select: {
      username: true,
      email: true,
      passwordHash: true,
      oidcIssuer: true,
      oidcSub: true,
      managedProfileAt: true,
      onboardingCompletedAt: true,
    },
  });
}

/** The account did not change at all, and nobody signed in to it. */
async function expectUntouched(profileId: string) {
  const row = await profileRow(profileId);
  expect(row.managedProfileAt).not.toBeNull();
  expect(row.oidcSub).toBeNull();
  expect(row.email).toBeNull();
  expect(row.username.startsWith("managed-")).toBe(true);
  expect(
    await getPrismaClient().session.count({ where: { userId: profileId } }),
  ).toBe(0);
  expect(
    await getPrismaClient().auditLog.count({
      where: { userId: profileId, action: "auth.claim" },
    }),
  ).toBe(0);
}

function oidcEnv(only: boolean) {
  process.env.OIDC_ISSUER_URL = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_BUTTON_LABEL = "Example ID";
  if (only) process.env.OIDC_ONLY = "true";
  else delete process.env.OIDC_ONLY;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  grants.clear();
  redeemed.length = 0;
  sent.length = 0;
  _resetOidcCacheForTests();
  process.env.APP_URL = APP;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  oidcEnv(true);
});

afterEach(() => {
  for (const key of [
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_BUTTON_LABEL",
    "OIDC_ONLY",
  ]) {
    delete process.env[key];
  }
});

// ── The tests ───────────────────────────────────────────────────────────────

describe("claiming through single sign-on on an SSO-only server", () => {
  it("hands the profile over and binds the provider's subject", async () => {
    const { creator, second, profile, secondGrant } = await household();

    // The Guardian side: available, through single sign-on only.
    const status = (await (await handoverStatus(creator, profile.id)).json())
      .data;
    expect(status.available).toBe(true);
    expect(status.methods).toEqual(["sso"]);

    const token = await mintToken(creator, profile.id, [
      { grantId: secondGrant.id, proposal: "read" },
    ]);

    // The person's side: the preview names the provider, the password claim
    // stays closed.
    const shown = (await (await preview(token)).json()).data;
    expect(shown.methods).toEqual(["sso"]);
    expect(shown.ssoProviderName).toBe("Example ID");
    const refused = await passwordClaim(token);
    expect(refused.status).toBe(403);
    expect((await refused.json()).meta.errorCode).toBe(
      "profile_claim.oidc_only_unsupported",
    );

    const cb = await throughProvider(
      token,
      {
        sub: "subject-robin",
        email: "Robin@Example.test",
        emailVerified: true,
      },
      "robin",
    );
    const response = await callback(cb);
    expect(landedOn(response)).toBe("/onboarding/handover");
    // Both single-use cookies go with the answer.
    expect(response.headers.get("set-cookie")).toMatch(/hl_claim=;/);
    expect(response.headers.get("set-cookie")).toMatch(/oidc_auth_state=;/);
    // The provider redeemed the code with the matching PKCE verifier.
    expect(redeemed).toHaveLength(1);

    const row = await profileRow(profile.id);
    expect(row).toMatchObject({
      username: "robin",
      email: "robin@example.test",
      passwordHash: null,
      oidcIssuer: ISSUER,
      oidcSub: "subject-robin",
      managedProfileAt: null,
      onboardingCompletedAt: null,
    });

    // The link is spent; a session exists for the new owner, and only one.
    const link =
      await getPrismaClient().managedProfileHandover.findFirstOrThrow({
        where: { profileId: profile.id },
      });
    expect(link.usedAt).not.toBeNull();
    expect(
      await getPrismaClient().session.count({ where: { userId: profile.id } }),
    ).toBe(1);
    expect(cookieJar.get("healthlog_session")).toBeDefined();

    // The Guardians' proposals hold and wait for the owner's decision.
    const decision = await readPendingHandoverDecision(profile.id);
    expect(
      decision?.guardians.map((g) => [g.displayName, g.proposal, g.current]),
    ).toEqual(
      expect.arrayContaining([
        [expect.stringContaining("second"), "read", "read"],
      ]),
    );
    const secondNow = await getPrismaClient().accountGrant.findFirst({
      where: { grantorId: profile.id, granteeId: second.id, revokedAt: null },
    });
    expect(secondNow?.access).toBe("READ");

    // Audited as an SSO claim, and the Guardians were told.
    const audits = await getPrismaClient().auditLog.findMany({
      where: { userId: profile.id },
      select: { action: true, details: true },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "managed_profile.claim_sso.started",
        "managed_profile.claimed",
        "auth.claim",
      ]),
    );
    const claimAudit = audits.find((a) => a.action === "auth.claim");
    expect(JSON.parse(claimAudit!.details!)).toEqual({ method: "sso" });
    // The token never reached an audit row.
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(sent.map((s) => s.userId).sort()).toEqual(
      [creator.id, second.id].sort(),
    );
  });

  it("creates the account without an address the provider did not verify", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, {
      sub: "subject-unverified",
      email: "robin@example.test",
      emailVerified: false,
    });
    expect(landedOn(await callback(cb))).toBe("/onboarding/handover");
    const row = await profileRow(profile.id);
    expect(row.email).toBeNull();
    expect(row.oidcSub).toBe("subject-unverified");
  });

  it("ignores a caller-supplied next and lands on the fixed page", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const started = await startSso(token, "robin");
    const claimCookie = setCookie(started, "hl_claim");
    const loginResponse = await login(
      claimCookie,
      "intent=claim&next=https%3A%2F%2Fevil.example%2Fphish",
    );
    const state = authorize(loginResponse, { sub: "s-next" }, "code-next");
    const response = await callback({
      url: `${APP}/api/auth/oidc/callback?code=code-next&state=${encodeURIComponent(state)}`,
      stateCookie: setCookie(loginResponse, "oidc_auth_state")!,
      claimCookie,
    });
    expect(response.headers.get("location")).toBe(`${APP}/onboarding/handover`);
  });
});

describe("refusals", () => {
  it("refuses a subject already bound to another account (no double binding)", async () => {
    const { creator, profile } = await household();
    const holder = await getPrismaClient().user.create({
      data: {
        username: "holder",
        email: "holder@example.test",
        oidcIssuer: ISSUER,
        oidcSub: "subject-taken",
      },
    });
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-taken" });

    expect(landedOn(await callback(cb))).toBe(
      "/auth/claim?error=claim_sso_subject_bound",
    );
    await expectUntouched(profile.id);
    // The holder keeps their sign-in and is told somebody tried.
    expect((await profileRow(holder.id)).oidcSub).toBe("subject-taken");
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: holder.id, action: "auth.oidc.claim_conflict" },
      }),
    ).toBe(1);
    // The link survives for the right person.
    expect((await preview(token)).status).toBe(200);
  });

  it("refuses a second profile for a subject that already claimed one", async () => {
    const first = await household();
    const second = await household();
    const tokenA = await mintToken(first.creator, first.profile.id);
    const tokenB = await mintToken(second.creator, second.profile.id);

    const a = await throughProvider(tokenA, { sub: "one-person" });
    expect(landedOn(await callback(a))).toBe("/onboarding/handover");
    cookieJar.clear();

    const b = await throughProvider(tokenB, { sub: "one-person" });
    expect(landedOn(await callback(b))).toBe(
      "/auth/claim?error=claim_sso_subject_bound",
    );
    await expectUntouched(second.profile.id);
  });

  it("refuses a verified address another account holds", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, {
      sub: "subject-email",
      email: creator.username + "@EXAMPLE.test",
      emailVerified: true,
    });
    expect(landedOn(await callback(cb))).toBe(
      "/auth/claim?error=claim_email_taken",
    );
    await expectUntouched(profile.id);
  });

  it("refuses a username taken during the round trip", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-name" }, "robin");
    await getPrismaClient().user.create({
      data: { username: "robin", email: "other@example.test" },
    });
    expect(landedOn(await callback(cb))).toBe(
      "/auth/claim?error=claim_username_taken",
    );
    await expectUntouched(profile.id);
  });

  it.each([
    [
      "expired",
      async (profileId: string) => {
        await getPrismaClient().managedProfileHandover.updateMany({
          where: { profileId },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      },
    ],
    [
      "withdrawn",
      async (profileId: string) => {
        await getPrismaClient().managedProfileHandover.updateMany({
          where: { profileId },
          data: { revokedAt: new Date() },
        });
      },
    ],
  ])(
    "refuses a link %s while the person was at the provider",
    async (_n, spoil) => {
      const { creator, profile } = await household();
      const token = await mintToken(creator, profile.id);
      const cb = await throughProvider(token, { sub: "subject-late" });
      await spoil(profile.id);
      expect(landedOn(await callback(cb))).toBe(
        "/auth/claim?error=claim_expired",
      );
      await expectUntouched(profile.id);
      // Refused before the code was redeemed: nothing spent at the provider.
      expect(redeemed).toHaveLength(0);
    },
  );

  it("refuses a link used by a password claim in the meantime", async () => {
    oidcEnv(false);
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-slow" });
    expect((await passwordClaim(token)).status).toBe(201);
    cookieJar.clear();
    expect(landedOn(await callback(cb))).toBe(
      "/auth/claim?error=claim_expired",
    );
    const row = await profileRow(profile.id);
    expect(row.oidcSub).toBeNull();
    expect(row.passwordHash).not.toBeNull();
  });

  it("stops an expired link at the login, before the provider", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const started = await startSso(token, "robin");
    await getPrismaClient().managedProfileHandover.updateMany({
      where: { profileId: profile.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const response = await login(setCookie(started, "hl_claim"));
    expect(landedOn(response)).toBe("/auth/claim?error=claim_expired");
    expect(setCookie(response, "oidc_auth_state")).toBeUndefined();
  });

  it("answers the start with 404 for a used or unknown link", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-once" });
    expect(landedOn(await callback(cb))).toBe("/onboarding/handover");
    cookieJar.clear();
    for (const t of [token, `hlp_${"0".repeat(64)}`]) {
      const response = await startSso(t, "someone");
      expect(response.status).toBe(404);
      expect((await response.json()).meta.errorCode).toBe(
        "profile_claim.invalid",
      );
    }
  });
});

describe("replay, state, nonce and the claim cookie", () => {
  it("does nothing on a replayed callback, even if the provider redeemed the code twice", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, {
      sub: "subject-replay",
      reusable: true,
    });
    expect(landedOn(await callback(cb))).toBe("/onboarding/handover");
    const sessionsAfterFirst = await getPrismaClient().session.count({
      where: { userId: profile.id },
    });
    const sessionCookie = cookieJar.get("healthlog_session");
    expect(sessionCookie).toMatch(/^hls_/);
    cookieJar.clear();

    // The same request again, cookies and all, from a browser without the
    // session (a captured request): the link is spent.
    expect(landedOn(await callback(cb))).toBe(
      "/auth/claim?error=claim_expired",
    );
    // From the browser that now holds the session: refused as signed in,
    // before the link is even looked at.
    expect(
      landedOn(await callback(cb, { healthlog_session: sessionCookie })),
    ).toBe("/auth/claim?error=claim_signed_in");

    expect(
      await getPrismaClient().session.count({ where: { userId: profile.id } }),
    ).toBe(sessionsAfterFirst);
    expect(
      await getPrismaClient().auditLog.count({
        where: { userId: profile.id, action: "auth.claim" },
      }),
    ).toBe(1);
  });

  it("refuses a callback whose state does not match", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-state" });
    const forged = cb.url.replace(/state=[^&]+/, "state=forged-state-value");
    expect(landedOn(await callback({ ...cb, url: forged }))).toBe(
      "/auth/claim?error=oidc_state",
    );
    await expectUntouched(profile.id);
    expect(redeemed).toHaveLength(0);
  });

  it("refuses an ID token minted for another nonce", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, {
      sub: "subject-nonce",
      nonceOverride: "some-other-sign-in",
    });
    expect(landedOn(await callback(cb))).toBe("/auth/claim?error=oidc_failed");
    await expectUntouched(profile.id);
  });

  it("refuses a callback that comes back without the claim cookie", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-nocookie" });
    expect(landedOn(await callback({ ...cb, claimCookie: undefined }))).toBe(
      "/auth/claim?error=claim_expired",
    );
    await expectUntouched(profile.id);
    expect(redeemed).toHaveLength(0);
  });

  it("refuses a claim cookie from a different start", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-swap" });
    // A second start in the same browser seals a new binding; the sign-in
    // that began with the first one cannot finish with it.
    const other = setCookie(await startSso(token, "robin2"), "hl_claim");
    expect(landedOn(await callback({ ...cb, claimCookie: other }))).toBe(
      "/auth/claim?error=claim_expired",
    );
    await expectUntouched(profile.id);
  });

  it("refuses a forged claim cookie", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-forged" });
    const link =
      await getPrismaClient().managedProfileHandover.findFirstOrThrow({
        where: { profileId: profile.id },
      });
    const forged = Buffer.from(
      JSON.stringify({ h: link.id, u: "x", b: "y", e: Date.now() + 1e6 }),
    ).toString("base64");
    expect(landedOn(await callback({ ...cb, claimCookie: forged }))).toBe(
      "/auth/claim?error=claim_expired",
    );
    await expectUntouched(profile.id);
  });

  it("does not adopt a session id the browser brought along", async () => {
    const { creator, profile } = await household();
    const token = await mintToken(creator, profile.id);
    const cb = await throughProvider(token, { sub: "subject-fixation" });
    const planted = "planted-session-id-chosen-by-somebody-else";
    expect(landedOn(await callback(cb, { healthlog_session: planted }))).toBe(
      "/onboarding/handover",
    );
    const sessions = await getPrismaClient().session.findMany({
      where: { userId: profile.id },
      select: { id: true },
    });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).not.toBe(planted);
    expect(cookieJar.get("healthlog_session")).not.toBe(planted);
  });
});

describe("which ways in a server offers", () => {
  it("offers both with a provider and passwords allowed, and both work", async () => {
    oidcEnv(false);
    const { creator, profile } = await household();
    const status = (await (await handoverStatus(creator, profile.id)).json())
      .data;
    expect(status.methods).toEqual(["password", "sso"]);
    const token = await mintToken(creator, profile.id);
    expect((await (await preview(token)).json()).data.methods).toEqual([
      "password",
      "sso",
    ]);
    const cb = await throughProvider(token, { sub: "subject-mixed" });
    expect(landedOn(await callback(cb))).toBe("/onboarding/handover");

    const other = await household();
    const token2 = await mintToken(other.creator, other.profile.id);
    expect((await passwordClaim(token2)).status).toBe(201);
  });

  it("offers only the password without a provider, and the SSO start says so", async () => {
    for (const key of ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_ONLY"]) {
      delete process.env[key];
    }
    const { creator, profile } = await household();
    const status = (await (await handoverStatus(creator, profile.id)).json())
      .data;
    expect(status.methods).toEqual(["password"]);
    const token = await mintToken(creator, profile.id);
    const shown = (await (await preview(token)).json()).data;
    expect(shown.methods).toEqual(["password"]);
    expect(shown.ssoProviderName).toBeNull();
    const response = await startSso(token, "robin");
    expect(response.status).toBe(404);
    expect((await response.json()).meta.errorCode).toBe(
      "profile_claim.sso_unavailable",
    );
  });
});
