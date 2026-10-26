/**
 * Parity for `GET /api/auth/oidc/callback` while its sign-in resolution moves
 * into `src/lib/auth/`.
 *
 * The provider is replaced at the four calls that would leave the process
 * (discovery, code exchange, ID-token verification, userinfo); everything
 * else is real: the sealed state cookie, sessions, MFA challenges, native
 * handoffs, the pending-link cookie, the audit ledger. The walk covers each
 * outcome the route tells apart: SSO switched off, a provider refusal, a
 * broken round trip, a missing state blob with and without a live session,
 * a forged state, a failed exchange, an exchange with no ID token,
 * first-login provisioning (the first account becomes admin), a returning
 * identity whose verified email changed, the userinfo fallback, the email
 * refusals, a link conflict, a pending link on the web and on the phone,
 * closed registration, the second factor on the web and on the phone, the
 * native handoff, and the two claim refusals. After each request the
 * snapshot holds the redirect, the cookies it set, the wide event, the
 * recorded sign-in device tail and the accounts, sessions and ledger rows.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/auth/oidc/callback/route";
import { encrypt } from "@/lib/crypto";
import { OIDC_STATE_COOKIE } from "@/lib/auth/oidc-cookie";
import { sessionCookieName } from "@/lib/auth/session-cookie";

import { anonymous, callRoute } from "../../../kit/call-route";
import { makeSession, makeUser } from "../../../kit/factories";
import {
  effectRecorder,
  eventFacts,
  expectParity,
  stable,
  wideEventRecorder,
} from "../../../kit/parity";
import { getPrismaClient, truncateAllTables } from "../../setup";

vi.mock("@/lib/logging/transports", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/logging/transports")>();
  const { wideEventRecorder: recorder } = await import("../../../kit/parity");
  return {
    ...actual,
    emitIfSampled: (event: (typeof recorder.events)[number]) => {
      recorder.events.push(event);
    },
  };
});
vi.mock("@/lib/auth/login-alert", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/auth/login-alert")>();
  const { effectRecorder } = await import("../../../kit/parity");
  return {
    ...actual,
    recordSignInDevice: async (...args: unknown[]) => {
      effectRecorder.record("recordSignInDevice", args);
    },
  };
});

/** What the fake provider answers for the next callback. */
const idp = vi.hoisted(() => ({
  exchange: "ok" as "ok" | "no_id_token" | "throws",
  accessToken: false,
  identity: {
    sub: "sub-1",
    email: null as string | null,
    emailVerified: undefined as boolean | undefined,
  },
  userinfo: {
    email: null as string | null,
    emailVerified: undefined as boolean | undefined,
  },
}));
const ISSUER = "https://id.example.test";
vi.mock("@/lib/auth/oidc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/oidc")>();
  return {
    ...actual,
    discoverOidcMetadata: async () => ({
      issuer: "https://id.example.test",
      authorization_endpoint: "https://id.example.test/authorize",
      token_endpoint: "https://id.example.test/token",
      jwks_uri: "https://id.example.test/jwks",
    }),
    exchangeCodeForTokens: async () => {
      if (idp.exchange === "throws") throw new Error("invalid_grant");
      return {
        ...(idp.exchange === "ok" ? { id_token: "id-token" } : {}),
        ...(idp.accessToken ? { access_token: "access-token" } : {}),
        token_type: "Bearer",
      };
    },
    verifyIdToken: async () => ({ ...idp.identity, name: null }),
    fetchUserinfoEmail: async () => ({ ...idp.userinfo }),
  };
});

const prisma = getPrismaClient();
const NOW = new Date("2026-10-15T12:00:00.000Z");
const APP = "http://localhost:3000";
const SAVED_ENV = { ...process.env };

interface State {
  native?: true;
  appCodeChallenge?: string;
  intent?: "claim";
  claimBinding?: string;
  next?: string;
  /** Send a different `state` in the query than the blob carries. */
  forged?: true;
}

function stateCookie(state: State): string {
  return encrypt(
    JSON.stringify({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
      next: state.next ?? "/",
      ...(state.native
        ? { native: true, appCodeChallenge: state.appCodeChallenge }
        : {}),
      ...(state.intent
        ? { intent: state.intent, claimBinding: state.claimBinding }
        : {}),
    }),
  );
}

/** The redirect target with its one-time values replaced. */
function location(headers: Headers): string | null {
  const raw = headers.get("location");
  if (!raw) return null;
  return raw.replace(
    /([?&](?:code|mfa_ticket)=)[^&]+/g,
    (_, key: string) => `${key}<value>`,
  );
}

/** The cookies the response set or cleared, by name and attributes. */
function setCookies(headers: Headers): string[] {
  return headers
    .getSetCookie()
    .map((c) =>
      c.replace(
        /^([^=]+)=([^;]*)/,
        (_, n: string, v: string) => `${n}=${v ? "<value>" : ""}`,
      ),
    )
    .map((c) => c.replace(/Expires=[^;]+/i, "Expires=<date>"))
    .sort();
}

async function stored() {
  const [users, sessions, audit, challenges, handoffs] = await Promise.all([
    prisma.user.findMany({
      orderBy: { username: "asc" },
      select: {
        username: true,
        email: true,
        role: true,
        timezone: true,
        oidcIssuer: true,
        oidcSub: true,
      },
    }),
    prisma.session.findMany({
      orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
      select: {
        user: { select: { username: true } },
        mfaVerifiedAt: true,
      },
    }),
    prisma.auditLog.findMany({
      orderBy: [{ createdAt: "asc" }, { action: "asc" }],
      select: { action: true, user: { select: { username: true } } },
    }),
    prisma.mfaChallenge.count(),
    prisma.oidcNativeHandoff.count(),
  ]);
  return { users, sessions, audit, challenges, handoffs };
}

async function step(
  name: string,
  options: {
    query?: Record<string, string>;
    state?: State | null;
    cookies?: Record<string, string>;
  },
): Promise<void> {
  await prisma.rateLimit.deleteMany({});
  wideEventRecorder.take();
  effectRecorder.take();
  const query =
    options.query ??
    ({
      code: "code-1",
      state: options.state?.forged ? "state-x" : "state-1",
    } as Record<string, string>);
  const cookies: Record<string, string> = {
    ...(options.state
      ? { [OIDC_STATE_COOKIE]: stateCookie(options.state) }
      : {}),
    ...options.cookies,
  };
  const res = await callRoute(GET, {
    method: "GET",
    route: "/api/auth/oidc/callback",
    query,
    headers: {
      cookie: Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; "),
    },
    auth: anonymous,
    contract: {
      skip: "a browser redirect target, not part of the published API",
    },
  });
  const events = wideEventRecorder.take();
  expect(events.length).toBeGreaterThan(0);
  await expectParity(
    `oidc-callback.${name}`,
    stable(
      {
        status: res.status,
        location: location(res.headers),
        setCookies: setCookies(res.headers),
        events: events.map(eventFacts),
        effects: effectRecorder.take(),
        stored: await stored(),
      },
      { since: NOW },
    ),
  );
}

function identity(
  sub: string,
  email: string | null,
  emailVerified: boolean | undefined,
): void {
  idp.exchange = "ok";
  idp.accessToken = false;
  idp.identity = { sub, email, emailVerified };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await truncateAllTables(prisma);
  process.env.APP_URL = APP;
  process.env.NEXT_PUBLIC_APP_URL = APP;
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_ONLY;
});

afterAll(() => {
  vi.useRealTimers();
  for (const key of [
    "APP_URL",
    "NEXT_PUBLIC_APP_URL",
    "OIDC_ISSUER_URL",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
  ]) {
    if (SAVED_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED_ENV[key];
  }
});

describe("GET /api/auth/oidc/callback parity", () => {
  it("01 SSO switched off", async () => {
    await step("01-disabled", { state: {} });
    process.env.OIDC_ISSUER_URL = ISSUER;
    process.env.OIDC_CLIENT_ID = "healthlog-test";
    process.env.OIDC_CLIENT_SECRET = "client-secret";
  });

  it("02 the round-trip refusals", async () => {
    await step("02-idp-denied", {
      query: { error: "access_denied", state: "state-1" },
      state: {},
    });
    await step("03-idp-denied-unknown-code", {
      query: { error: "something_else" },
      state: { native: true, appCodeChallenge: "challenge-1" },
    });
    await step("04-no-code", { query: { state: "state-1" }, state: {} });
    await step("05-no-state-blob", { state: null });
    await step("06-forged-state", { state: { forged: true } });
    idp.exchange = "throws";
    await step("07-exchange-failed", { state: {} });
    idp.exchange = "no_id_token";
    await step("08-no-id-token", { state: {} });
  });

  it("09 the first login provisions an admin", async () => {
    identity("sub-first", "First@Example.test", true);
    await step("09-provision-first", { state: { next: "/insights" } });
    identity("sub-second", "second@example.test", true);
    await step("10-provision-second", { state: {} });
  });

  it("11 a returning identity, and a duplicate callback", async () => {
    identity("sub-first", "first.new@example.test", true);
    await step("11-returning-email-refresh", { state: {} });
    const first = await prisma.user.findFirstOrThrow({
      where: { oidcSub: "sub-first" },
    });
    const session = await makeSession(first);
    await step("12-duplicate-with-session", {
      state: null,
      cookies: { [sessionCookieName()]: session.cookie },
    });
  });

  it("13 the email refusals and the userinfo fallback", async () => {
    identity("sub-noemail", null, undefined);
    await step("13-no-email", { state: {} });
    identity("sub-unverified", "unverified@example.test", false);
    await step("14-email-unverified", { state: {} });
    identity("sub-userinfo", null, undefined);
    idp.accessToken = true;
    idp.userinfo = { email: "userinfo@example.test", emailVerified: true };
    await step("15-userinfo-provision", { state: {} });
  });

  it("16 an account already holding the email", async () => {
    await makeUser({
      username: "linked-elsewhere",
      email: "conflict@example.test",
      oidcIssuer: "https://other.example.test",
      oidcSub: "other-sub",
    });
    identity("sub-conflict", "conflict@example.test", true);
    await step("16-link-conflict", { state: {} });
    await makeUser({ username: "local-only", email: "local@example.test" });
    identity("sub-local", "local@example.test", true);
    await step("17-link-pending-web", { state: {} });
    await step("18-link-pending-native", {
      state: { native: true, appCodeChallenge: "challenge-1" },
    });
  });

  it("19 closed registration", async () => {
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", registrationEnabled: false },
      update: { registrationEnabled: false },
    });
    identity("sub-late", "late@example.test", true);
    await step("19-registration-closed", { state: {} });
    await prisma.appSettings.update({
      where: { id: "singleton" },
      data: { registrationEnabled: true },
    });
  });

  it("20 the second factor and the native handoff", async () => {
    await prisma.user.updateMany({
      where: { oidcSub: "sub-second" },
      data: { totpConfirmedAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    identity("sub-second", "second@example.test", true);
    await step("20-mfa-web", { state: { next: "/medications" } });
    await step("21-mfa-native", {
      state: { native: true, appCodeChallenge: "challenge-1" },
    });
    identity("sub-userinfo", "userinfo@example.test", true);
    await step("22-native-handoff", {
      state: { native: true, appCodeChallenge: "challenge-2" },
    });
  });

  it("23 the claim refusals", async () => {
    const someone = await prisma.user.findFirstOrThrow({
      where: { oidcSub: "sub-first" },
    });
    const session = await makeSession(someone);
    identity("sub-claimer", "claimer@example.test", true);
    await step("23-claim-signed-in", {
      state: { intent: "claim", claimBinding: "binding-1" },
      cookies: { [sessionCookieName()]: session.cookie },
    });
    await step("24-claim-no-cookie", {
      state: { intent: "claim", claimBinding: "binding-1" },
    });
    await step("25-claim-no-code", {
      query: { state: "state-1" },
      state: { intent: "claim", claimBinding: "binding-1" },
    });
  });
});
