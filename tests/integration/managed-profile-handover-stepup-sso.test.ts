/**
 * #959 — a Guardian who signs in through an identity provider, with a second
 * factor enrolled in the app, hands a managed profile over after the
 * five-minute window has passed. The report: "I get the error message that I
 * need to confirm my second factor, but there is nowhere to do so."
 *
 * Driven end to end against real Postgres and a mock identity provider that
 * speaks the wire (discovery, JWKS, a PKCE-checking token endpoint, ES256 ID
 * tokens), the same harness as `managed-profile-handover-sso.test.ts`:
 *
 *   1. the real OIDC login and callback, which puts an account with a second
 *      factor through the app's own MFA challenge;
 *   2. the real `/api/auth/mfa/verify`, which stamps the session;
 *   3. ten minutes later the handover refuses with `auth.stepup.required` AND
 *      names the proofs that clear it, which is what lets the browser open the
 *      re-proof dialog instead of printing a sentence;
 *   4. `/api/auth/reproof` with the second factor, exactly what the dialog
 *      posts, and the handover goes through.
 *
 * And the other half of the question: a Guardian whose only factor is the one
 * the identity provider asked for. The app cannot see that factor, so the gate
 * asks for one of its own (`mfa_not_enrolled`), and the way through is
 * reachable: enrolling right after a sign-in needs no further proof, and the
 * confirmation stamps the session, so the handover follows.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import * as OTPAuth from "otpauth";
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
import { _resetOidcCacheForTests } from "@/lib/auth/oidc";
import { handoverCreateBody } from "@/lib/queries/use-managed-profiles";

process.env.API_TOKEN_HMAC_KEY ??=
  "test-hmac-key-handover-stepup-sso-32-bytes-minimum-123456";

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

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async () => {}),
}));

const APP = "http://localhost:3000";
const CLIENT_ID = "healthlog-test";
const CLIENT_SECRET = "client-secret-for-the-mock-idp";
const MINUTE = 60 * 1000;

// ── The mock identity provider ──────────────────────────────────────────────

interface Grant {
  sub: string;
  email: string;
  nonce: string;
  codeChallenge: string;
}

let idp: Server;
let ISSUER = "";
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
const grants = new Map<string, Grant>();

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
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
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const grant = grants.get(form.get("code") ?? "");
      if (
        !grant ||
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET ||
        s256(form.get("code_verifier") ?? "") !== grant.codeChallenge
      ) {
        return json(400, { error: "invalid_grant" });
      }
      grants.delete(form.get("code") ?? "");
      const idToken = await new SignJWT({
        nonce: grant.nonce,
        email: grant.email,
        email_verified: true,
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

// ── Signing in through the provider ─────────────────────────────────────────

type NextResponseLike = Response & {
  cookies?: { get(name: string): { value: string } | undefined };
};

function setCookie(response: Response, name: string): string | undefined {
  return (response as NextResponseLike).cookies?.get(name)?.value || undefined;
}

let sequence = 0;

/**
 * The browser's trip: the login route, the provider, the callback. Returns the
 * callback's answer; the session (when one is minted) lands in the cookie jar.
 */
async function signInThroughProvider(identity: {
  sub: string;
  email: string;
}): Promise<Response> {
  const { GET: login } = await import("@/app/api/auth/oidc/login/route");
  const started = await login(new NextRequest(`${APP}/api/auth/oidc/login`));
  const location = new URL(started.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
  const stateCookie = setCookie(started, "oidc_auth_state");
  expect(stateCookie).toBeDefined();

  const code = `code-${sequence++}`;
  grants.set(code, {
    ...identity,
    nonce: location.searchParams.get("nonce") ?? "",
    codeChallenge: location.searchParams.get("code_challenge") ?? "",
  });
  const state = location.searchParams.get("state") ?? "";

  const { GET: callback } = await import("@/app/api/auth/oidc/callback/route");
  return callback(
    new NextRequest(
      `${APP}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `oidc_auth_state=${stateCookie}` } },
    ),
  );
}

function post(path: string, body?: unknown): NextRequest {
  return new NextRequest(`${APP}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

type RouteFn = (request: NextRequest) => Promise<Response>;

async function mfaVerify(mfaTicket: string, code: string) {
  const { POST } = await import("@/app/api/auth/mfa/verify/route");
  return (POST as unknown as RouteFn)(
    post("/api/auth/mfa/verify", { mfaTicket, method: "totp", code }),
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

async function totpSetup() {
  const { POST } = await import("@/app/api/auth/me/mfa/totp/setup/route");
  return (POST as unknown as RouteFn)(post("/api/auth/me/mfa/totp/setup"));
}

async function totpConfirm(code: string) {
  const { POST } = await import("@/app/api/auth/me/mfa/totp/confirm/route");
  return (POST as unknown as RouteFn)(
    post("/api/auth/me/mfa/totp/confirm", { code }),
  );
}

async function meta(res: Response) {
  return (
    (await res.json()) as {
      meta?: { errorCode?: string; methods?: string[] };
    }
  ).meta;
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

// ── The household ───────────────────────────────────────────────────────────

/** A Guardian bound to the provider's subject, and the profile they look after. */
async function guardianWithProfile(withTotp: boolean) {
  const prisma = getPrismaClient();
  const suffix = sequence++;
  let secret: string | null = null;
  let totp = {};
  if (withTotp) {
    const { generateTotpSecret } = await import("@/lib/auth/mfa/totp");
    const { encrypt } = await import("@/lib/crypto");
    secret = generateTotpSecret();
    totp = {
      totpSecretEncrypted: encrypt(secret),
      totpConfirmedAt: new Date(),
      totpLastStep: null,
    };
  }
  const guardian = await prisma.user.create({
    data: {
      username: `guardian-${suffix}`,
      email: `guardian-${suffix}@example.test`,
      oidcIssuer: ISSUER,
      oidcSub: `subject-guardian-${suffix}`,
      onboardingCompletedAt: new Date(),
      ...totp,
    },
  });
  const { profile } = await createManagedProfile({
    creatorId: guardian.id,
    displayName: "Robin",
    dateOfBirth: null,
    locale: "en",
    timezone: "UTC",
  });
  return {
    guardian,
    profileId: profile.id,
    secret,
    identity: { sub: guardian.oidcSub!, email: guardian.email! },
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let clock = 0;

/** Move the wall clock the app reads, as time passing would. */
function advance(ms: number) {
  clock += ms;
  vi.setSystemTime(clock);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  grants.clear();
  _resetOidcCacheForTests();
  process.env.APP_URL = APP;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  process.env.OIDC_ISSUER_URL = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.OIDC_BUTTON_LABEL = "Example ID";
  // Single sign-on only: the report came from such a server, and it is the
  // strictest case (no password to fall back on anywhere).
  process.env.OIDC_ONLY = "true";
  // Only `Date` is faked: the provider round trip and Postgres keep real
  // timers, and the codes generated below follow the moved clock.
  vi.useFakeTimers({ toFake: ["Date"] });
  clock = Date.now();
  vi.setSystemTime(clock);
});

afterEach(() => {
  vi.useRealTimers();
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

describe("a Guardian signed in through SSO with a second factor in the app", () => {
  it("confirms the factor when asked, then hands the profile over", async () => {
    const { guardian, profileId, secret, identity } =
      await guardianWithProfile(true);

    // The callback puts the account through the app's own challenge.
    const cb = await signInThroughProvider(identity);
    expect([302, 303, 307]).toContain(cb.status);
    const handoff = setCookie(cb, "oidc_mfa_handoff");
    expect(handoff).toBeDefined();
    const { ticket, methods } = JSON.parse(decodeURIComponent(handoff!)) as {
      ticket: string;
      methods: string[];
    };
    expect(methods).toContain("totp");
    expect(cookieJar.get("healthlog_session")).toBeUndefined();

    const verified = await mfaVerify(ticket, codeFor(secret!));
    expect(verified.status).toBe(200);
    const sessionId = cookieJar.get("healthlog_session");
    expect(sessionId).toBeDefined();
    const session = await getPrismaClient().session.findFirstOrThrow({
      where: { userId: guardian.id },
      select: { mfaVerifiedAt: true },
    });
    expect(session.mfaVerifiedAt).not.toBeNull();

    // Ten minutes on, the factor is stale. The refusal is the gate, and it
    // names what clears it: the TOTP factor this account holds.
    advance(10 * MINUTE);
    const refused = await handover(profileId);
    expect(refused.status).toBe(401);
    expect(await meta(refused)).toMatchObject({
      errorCode: "auth.stepup.required",
      methods: ["totp"],
    });
    expect(
      await getPrismaClient().managedProfileHandover.count({
        where: { profileId },
      }),
    ).toBe(0);

    // What the dialog posts.
    const proved = await reproof({ method: "totp", code: codeFor(secret!) });
    expect(proved.status).toBe(200);

    // And the request is sent once more.
    const minted = await handover(profileId);
    expect(minted.status).toBe(201);
    const link = (await minted.json()).data as { url: string };
    expect(link.url).toContain("/claim");
    expect(
      await getPrismaClient().managedProfileHandover.count({
        where: { profileId },
      }),
    ).toBe(1);
  });

  it("does not let the provider's sign-in stand in for the factor", async () => {
    // The re-proof dialog never offers "sign in again" to this account: it
    // holds a factor, and the gate names it. A fresh SSO sign-in still goes
    // through the factor, so it is no shortcut either.
    const { profileId, secret, identity } = await guardianWithProfile(true);
    const cb = await signInThroughProvider(identity);
    const { ticket } = JSON.parse(
      decodeURIComponent(setCookie(cb, "oidc_mfa_handoff")!),
    ) as { ticket: string };
    expect((await mfaVerify(ticket, codeFor(secret!))).status).toBe(200);
    advance(10 * MINUTE);

    const wrong = await reproof({ method: "totp", code: "000000" });
    expect(wrong.status).toBe(401);
    expect((await handover(profileId)).status).toBe(401);
  });
});

describe("a Guardian whose only second factor is the identity provider's", () => {
  it("is asked for an app factor, can enrol one at once, and then hands over", async () => {
    const { guardian, profileId, identity } = await guardianWithProfile(false);

    const cb = await signInThroughProvider(identity);
    expect([302, 303, 307]).toContain(cb.status);
    expect(cookieJar.get("healthlog_session")).toBeDefined();

    // The app cannot see the provider's factor, so the gate asks for one of
    // its own — and says so with its own code, which the web turns into
    // "set one up under Settings → Security" rather than a dialog.
    const refused = await handover(profileId);
    expect(refused.status).toBe(401);
    expect((await meta(refused))?.errorCode).toBe(
      "auth.stepup.mfa_not_enrolled",
    );

    // Right after signing in, enrolment needs no further proof.
    const setup = await totpSetup();
    expect(setup.status).toBe(200);
    const { totpSecret } = (await setup.json()).data as { totpSecret: string };
    const confirmed = await totpConfirm(codeFor(totpSecret));
    expect(confirmed.status).toBe(200);

    // The confirmation stamped the session, so the handover goes through.
    const minted = await handover(profileId);
    expect(minted.status).toBe(201);
    const row = await getPrismaClient().user.findUniqueOrThrow({
      where: { id: guardian.id },
      select: { totpConfirmedAt: true },
    });
    expect(row.totpConfirmedAt).not.toBeNull();
  });

  it("is told to sign in again when the sign-in is too old to enrol from", async () => {
    const { identity } = await guardianWithProfile(false);
    await signInThroughProvider(identity);
    advance(10 * MINUTE);

    // Nothing to re-prove in place: no password, no passkey, no factor. The
    // identity provider is the one way left, so `oidc` is all that is
    // offered, and the web sends the person through a fresh provider login
    // instead of asking for a password this account does not have.
    const refused = await totpSetup();
    expect(refused.status).toBe(401);
    expect(await meta(refused)).toMatchObject({
      errorCode: "auth.reproof.required",
      methods: ["oidc"],
    });

    // And signing in again is a way through.
    cookieJar.clear();
    await signInThroughProvider(identity);
    expect((await totpSetup()).status).toBe(200);
  });
});
