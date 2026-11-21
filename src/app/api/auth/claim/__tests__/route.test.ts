/**
 * v1.42 (#959) — the anonymous claim and its preview, at the route seam.
 *
 * The transaction itself is integration-tested
 * (`tests/integration/managed-profile-handover.test.ts`); here the order of
 * the refusals is pinned, because each one is a security property:
 *
 *   - single sign-on only refuses the PASSWORD claim before anything else,
 *     while the preview answers there and names `sso` as the way in (v1.43);
 *   - the single-sign-on start needs a configured provider, refuses a live
 *     session before the rate limit, checks the link before the username,
 *     and seals the link's id (never the token) into `hl_claim`;
 *   - a live session is refused BEFORE the rate limit (a state, not an
 *     attempt), and before any token is read;
 *   - the rate limit runs before the body is parsed;
 *   - an unusable token answers the same 404 on both routes, and the claim
 *     checks the link BEFORE probing whether a username or email is taken, so
 *     the route is not a name oracle for somebody without a live link;
 *   - nothing is hashed for a token that is refused.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  // The identity lookup is raw SQL (`@/lib/auth/identity-lookup`); its rows
  // are what decides "taken".
  prisma: { $queryRaw: vi.fn() },
}));
vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@/lib/auth/oidc", () => ({
  isOidcOnly: vi.fn(),
  isOidcConfigured: vi.fn(),
  getOidcConfig: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((s: string) => `sealed(${s})`),
  decrypt: vi.fn(),
}));
vi.mock("@/lib/auth/secure-cookie", () => ({
  shouldEmitSecureCookie: () => true,
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/auth/password", () => ({
  hashPassword: vi.fn(),
  checkPasswordStrength: vi.fn(),
}));
vi.mock("@/lib/password-breach-check", () => ({
  checkPasswordBreachIfEnabled: vi.fn(),
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/auth/login-alert", () => ({ recordSignInDevice: vi.fn() }));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn().mockResolvedValue("en"),
}));
vi.mock("@/lib/managed-profiles/handover", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/managed-profiles/handover")
  >("@/lib/managed-profiles/handover");
  return {
    HandoverError: actual.HandoverError,
    previewHandover: vi.fn(),
    usableHandoverForToken: vi.fn(),
    claimManagedProfile: vi.fn(),
  };
});
vi.mock("@/lib/managed-profiles/handover-notify", () => ({
  notifyGuardiansOfHandover: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST as claim } from "../route";
import { POST as preview } from "../preview/route";
import { POST as claimSso } from "../sso/route";
import { prisma } from "@/lib/db";
import { createSession, getSession } from "@/lib/auth/session";
import { getOidcConfig, isOidcConfigured, isOidcOnly } from "@/lib/auth/oidc";
import { auditLog } from "@/lib/auth/audit";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { checkPasswordStrength, hashPassword } from "@/lib/auth/password";
import { checkPasswordBreachIfEnabled } from "@/lib/password-breach-check";
import {
  claimManagedProfile,
  HandoverError,
  previewHandover,
  usableHandoverForToken,
} from "@/lib/managed-profiles/handover";
import { notifyGuardiansOfHandover } from "@/lib/managed-profiles/handover-notify";

const TOKEN = `hlp_${"a".repeat(64)}`;
const BODY = {
  token: TOKEN,
  username: "alex",
  email: "alex@example.test",
  password: "a long enough passphrase",
};

function post(path: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PREVIEW = {
  displayName: "Alex",
  expiresAt: new Date("2030-01-01T00:00:00Z"),
  guardians: [{ grantId: "g1", displayName: "Sam", proposal: "read" as const }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isOidcOnly).mockReturnValue(false);
  vi.mocked(isOidcConfigured).mockReturnValue(false);
  vi.mocked(getOidcConfig).mockReturnValue(null);
  vi.mocked(usableHandoverForToken).mockResolvedValue({
    handoverId: "h1",
    profileId: "p1",
  });
  vi.mocked(getSession).mockResolvedValue(null as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "203.0.113.7",
  } as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(checkPasswordStrength).mockReturnValue({
    isAcceptable: true,
    feedback: [],
  } as never);
  vi.mocked(checkPasswordBreachIfEnabled).mockResolvedValue(null as never);
  vi.mocked(hashPassword).mockResolvedValue("argon2-hash");
  vi.mocked(previewHandover).mockResolvedValue(PREVIEW);
  vi.mocked(claimManagedProfile).mockResolvedValue({
    profileId: "p1",
    username: "alex",
    displayName: "Alex",
    guardians: [{ guardianId: "u-sam", access: "read" }],
  });
});

async function errorCode(res: Response): Promise<unknown> {
  const body = (await res.json()) as { meta?: { errorCode?: string } };
  return body.meta?.errorCode;
}

const OIDC_CONFIG = {
  issuerUrl: "https://idp.example.test",
  clientId: "c",
  clientSecret: "s",
  scopes: "openid email",
  buttonLabel: "Example ID",
};

function singleSignOnOnly(): void {
  vi.mocked(isOidcOnly).mockReturnValue(true);
  vi.mocked(isOidcConfigured).mockReturnValue(true);
  vi.mocked(getOidcConfig).mockReturnValue(OIDC_CONFIG);
}

describe("on a single-sign-on-only instance", () => {
  it("refuses the password claim before anything else", async () => {
    singleSignOnOnly();
    vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
    const res = await claim(post("/api/auth/claim", BODY));
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("profile_claim.oidc_only_unsupported");
    expect(previewHandover).not.toHaveBeenCalled();
  });

  it("answers the preview and names single sign-on as the only way in", async () => {
    singleSignOnOnly();
    const res = await preview(
      post("/api/auth/claim/preview", { token: TOKEN }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.methods).toEqual(["sso"]);
    expect(body.data.ssoProviderName).toBe("Example ID");
  });
});

describe.each([
  ["claim", claim, "/api/auth/claim", BODY],
  ["preview", preview, "/api/auth/claim/preview", { token: TOKEN }],
  ["sso", claimSso, "/api/auth/claim/sso", { token: TOKEN, username: "alex" }],
] as const)(
  "POST %s — refusals that read no token",
  (name, route, path, body) => {
    beforeEach(() => {
      if (name === "sso") {
        vi.mocked(isOidcConfigured).mockReturnValue(true);
        vi.mocked(getOidcConfig).mockReturnValue(OIDC_CONFIG);
      }
      if (name === "sso") {
        vi.mocked(usableHandoverForToken).mockImplementation(async () => {
          // Routes the sso start through the same "link" spy the other two
          // use, so one set of assertions covers all three.
          const found = await previewHandover(TOKEN);
          return found ? { handoverId: "h1", profileId: "p1" } : null;
        });
      }
    });

    it("refuses over a live session before spending the rate limit", async () => {
      vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
      const res = await route(post(path, body));
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("auth.already_authenticated");
      expect(checkAuthSurfaceRateLimit).not.toHaveBeenCalled();
      expect(previewHandover).not.toHaveBeenCalled();
    });

    it("answers 429 from the per-address bucket before parsing the body", async () => {
      vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
        allowed: false,
        ip: "203.0.113.7",
      } as never);
      const res = await route(post(path, body));
      expect(res.status).toBe(429);
      expect(previewHandover).not.toHaveBeenCalled();
    });

    it("answers the same 404 for an unusable link", async () => {
      vi.mocked(previewHandover).mockResolvedValue(null);
      const res = await route(post(path, body));
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("profile_claim.invalid");
    });
  },
);

describe("POST /api/auth/claim", () => {
  it("checks the link before the username and email probe", async () => {
    vi.mocked(previewHandover).mockResolvedValue(null);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: "x" }] as never);
    const res = await claim(post("/api/auth/claim", BODY));
    // A taken name would be a 409; the link is checked first, so 404.
    expect(res.status).toBe(404);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("answers 409 profile_claim.taken for a name in use, before hashing", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ id: "x" }] as never);
    const res = await claim(post("/api/auth/claim", BODY));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("profile_claim.taken");
    expect(hashPassword).not.toHaveBeenCalled();
    expect(claimManagedProfile).not.toHaveBeenCalled();
  });

  it("refuses a username with the managed-profile prefix as 422", async () => {
    const res = await claim(
      post("/api/auth/claim", { ...BODY, username: "managed-alex" }),
    );
    expect(res.status).toBe(422);
    expect(previewHandover).not.toHaveBeenCalled();
  });

  it("refuses an unknown field (strict body)", async () => {
    const res = await claim(
      post("/api/auth/claim", { ...BODY, userId: "someone-else" }),
    );
    expect(res.status).toBe(422);
  });

  it("maps a race lost inside the transaction to the same 404", async () => {
    vi.mocked(claimManagedProfile).mockRejectedValue(
      new HandoverError("invalid"),
    );
    const res = await claim(post("/api/auth/claim", BODY));
    expect(res.status).toBe(404);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("maps a unique-constraint race to 409 taken", async () => {
    vi.mocked(claimManagedProfile).mockRejectedValue(
      new HandoverError("taken"),
    );
    const res = await claim(post("/api/auth/claim", BODY));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("profile_claim.taken");
  });

  it("signs the new owner in with onboarding owed and tells the guardians", async () => {
    const res = await claim(post("/api/auth/claim", BODY));
    expect(res.status).toBe(201);
    expect(claimManagedProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        link: { rawToken: TOKEN },
        username: "alex",
        email: "alex@example.test",
        passwordHash: "argon2-hash",
      }),
    );
    expect(createSession).toHaveBeenCalledWith("p1", true, "203.0.113.7", null);
    expect(notifyGuardiansOfHandover).toHaveBeenCalledWith("claimed", "Alex", [
      { guardianId: "u-sam", access: "read" },
    ]);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ userId: "p1", username: "alex" });
  });
});

describe("POST /api/auth/claim/preview", () => {
  it("returns the minimal preview and nothing else", async () => {
    const res = await preview(
      post("/api/auth/claim/preview", { token: TOKEN }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual([
      "displayName",
      "expiresAt",
      "guardians",
      "methods",
      "ssoProviderName",
    ]);
    expect(body.data.methods).toEqual(["password"]);
    expect(body.data.ssoProviderName).toBeNull();
    expect(body.data.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });
});

describe("POST /api/auth/claim/sso", () => {
  const SSO_BODY = { token: TOKEN, username: "alex" };

  beforeEach(() => {
    vi.mocked(isOidcConfigured).mockReturnValue(true);
    vi.mocked(getOidcConfig).mockReturnValue(OIDC_CONFIG);
  });

  it("answers 404 sso_unavailable without an identity provider, before anything else", async () => {
    vi.mocked(isOidcConfigured).mockReturnValue(false);
    vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
    const res = await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("profile_claim.sso_unavailable");
    expect(checkAuthSurfaceRateLimit).not.toHaveBeenCalled();
    expect(usableHandoverForToken).not.toHaveBeenCalled();
  });

  it("works on a single-sign-on-only instance", async () => {
    singleSignOnOnly();
    const res = await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(res.status).toBe(200);
  });

  it("draws on the password claim's bucket", async () => {
    await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(checkAuthSurfaceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "auth:claim",
      5,
      15 * 60 * 1000,
    );
  });

  it("checks the link before the username probe", async () => {
    vi.mocked(usableHandoverForToken).mockResolvedValue(null);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: "x" }] as never);
    const res = await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("profile_claim.invalid");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 409 taken for a username in use, and sets no cookie", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ id: "x" }] as never);
    const res = await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("profile_claim.taken");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses an unknown field and a managed- username (strict body)", async () => {
    for (const body of [
      { ...SSO_BODY, email: "x@example.test" },
      { ...SSO_BODY, username: "managed-alex" },
    ]) {
      const res = await claimSso(post("/api/auth/claim/sso", body));
      expect(res.status).toBe(422);
    }
    expect(usableHandoverForToken).not.toHaveBeenCalled();
  });

  it("seals the link's id and the username, never the token, into hl_claim", async () => {
    const res = await claimSso(post("/api/auth/claim/sso", SSO_BODY));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({
      redirectTo: "/api/auth/oidc/login?intent=claim",
    });
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^hl_claim=/);
    expect(cookie).toMatch(/Path=\/api\/auth\/oidc/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Max-Age=600/);
    const sealed = decodeURIComponent(cookie.split(";")[0]!.slice(9));
    const payload = JSON.parse(sealed.replace(/^sealed\(/, "").slice(0, -1));
    expect(payload.h).toBe("h1");
    expect(payload.u).toBe("alex");
    expect(typeof payload.b).toBe("string");
    expect(cookie).not.toContain(TOKEN);
    expect(JSON.stringify(vi.mocked(auditLog).mock.calls)).not.toContain(TOKEN);
    expect(auditLog).toHaveBeenCalledWith(
      "managed_profile.claim_sso.started",
      expect.objectContaining({ userId: "p1", details: { handoverId: "h1" } }),
    );
  });
});
