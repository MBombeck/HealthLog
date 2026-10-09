/**
 * v1.42 (#959) — the anonymous claim and its preview, at the route seam.
 *
 * The transaction itself is integration-tested
 * (`tests/integration/managed-profile-handover.test.ts`); here the order of
 * the refusals is pinned, because each one is a security property:
 *
 *   - single sign-on only refuses before anything else;
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
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({
  createSession: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@/lib/auth/oidc", () => ({ isOidcOnly: vi.fn() }));
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
import { prisma } from "@/lib/db";
import { createSession, getSession } from "@/lib/auth/session";
import { isOidcOnly } from "@/lib/auth/oidc";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { checkPasswordStrength, hashPassword } from "@/lib/auth/password";
import { checkPasswordBreachIfEnabled } from "@/lib/password-breach-check";
import {
  claimManagedProfile,
  HandoverError,
  previewHandover,
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
  vi.mocked(getSession).mockResolvedValue(null as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "203.0.113.7",
  } as never);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
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

describe.each([
  ["claim", claim, "/api/auth/claim", BODY],
  ["preview", preview, "/api/auth/claim/preview", { token: TOKEN }],
] as const)(
  "POST %s — refusals that read no token",
  (_n, route, path, body) => {
    it("refuses on a single-sign-on-only instance before anything else", async () => {
      vi.mocked(isOidcOnly).mockReturnValue(true);
      vi.mocked(getSession).mockResolvedValue({ user: { id: "u1" } } as never);
      const res = await route(post(path, body));
      expect(res.status).toBe(403);
      expect(await errorCode(res)).toBe("profile_claim.oidc_only_unsupported");
      expect(previewHandover).not.toHaveBeenCalled();
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
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ id: "x" } as never);
    const res = await claim(post("/api/auth/claim", BODY));
    // A taken name would be a 409; the link is checked first, so 404.
    expect(res.status).toBe(404);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("answers 409 profile_claim.taken for a name in use, before hashing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce({
      id: "x",
    } as never);
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
        rawToken: TOKEN,
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
    ]);
    expect(body.data.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });
});
