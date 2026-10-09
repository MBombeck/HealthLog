/**
 * A passkey sign-in that cannot be checked answers with its own status and
 * `meta.errorCode`, never a 500. The real `verifyAuthentication` runs here
 * against a mocked database, so the test pins the whole path from the
 * library's refusal to the wire: an expired or already-used challenge, a
 * credential this server does not know, a body that is not an assertion, and
 * an assertion the WebAuthn library refuses.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    passkey: { findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { checkAuthSurfaceRateLimit } from "@/lib/rate-limit";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

const ASSERTION = {
  id: "cred-1",
  rawId: "cred-1",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AA",
    signature: "AA",
  },
};

function request(credential: unknown = ASSERTION): NextRequest {
  return new NextRequest("http://localhost/api/auth/passkey/login-verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: "ch-1", credential }),
  });
}

async function refusal(res: Response) {
  const body = (await res.json()) as {
    data: null;
    meta?: { errorCode?: string };
  };
  return { status: res.status, code: body.meta?.errorCode, data: body.data };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: 0,
    ip: "203.0.113.1",
  } as never);
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { challenge: "c-1", user_id: null },
  ] as never);
  vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
    id: "pk-1",
    userId: "user-1",
    credentialId: "cred-1",
    credentialPublicKey: new Uint8Array([1]),
    counter: BigInt(0),
    transports: [],
  } as never);
});

describe("POST /api/auth/passkey/login-verify — named refusals", () => {
  it("answers an expired or already-used challenge with 401 passkey.challenge.expired", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    expect(await refusal(await POST(request()))).toEqual({
      status: 401,
      code: "passkey.challenge.expired",
      data: null,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.login.failed",
      expect.objectContaining({
        details: { reason: "passkey_challenge_expired" },
      }),
    );
  });

  it("answers a challenge begun for another account the same way", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { challenge: "c-1", user_id: "someone-else" },
    ] as never);
    const out = await refusal(await POST(request()));
    expect(out.status).toBe(401);
    expect(out.code).toBe("passkey.challenge.expired");
  });

  it("answers a passkey that is not registered here with 404 passkey.unknown", async () => {
    vi.mocked(prisma.passkey.findUnique).mockResolvedValue(null as never);
    expect(await refusal(await POST(request()))).toEqual({
      status: 404,
      code: "passkey.unknown",
      data: null,
    });
    expect(auditLog).toHaveBeenCalledWith(
      "auth.login.failed",
      expect.objectContaining({ details: { reason: "passkey_unknown" } }),
    );
  });

  it("answers a body that is not an assertion with 422 passkey.response.invalid", async () => {
    const out = await refusal(await POST(request({ id: "cred-1" })));
    expect(out.status).toBe(422);
    expect(out.code).toBe("passkey.response.invalid");
  });

  it("answers an assertion the library refuses with 401 passkey.verification.failed", async () => {
    vi.mocked(verifyAuthenticationResponse).mockRejectedValue(
      new Error("Unexpected authentication response origin"),
    );
    const out = await refusal(await POST(request()));
    expect(out.status).toBe(401);
    expect(out.code).toBe("passkey.verification.failed");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("still lets a real fault surface as one", async () => {
    vi.mocked(prisma.passkey.findUnique).mockRejectedValue(
      new Error("connection reset"),
    );
    const res = await POST(request());
    expect(res.status).toBe(500);
  });
});
