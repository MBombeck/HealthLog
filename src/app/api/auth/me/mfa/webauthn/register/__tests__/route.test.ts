import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/mfa-enrollment", () => ({
  setMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
  syncMfaEnrollCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (fn: unknown) => fn,
  requireMfaManagementAuth: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { webauthnMfaCredential: { create: vi.fn() } },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: vi.fn(() => ({})),
}));

vi.mock("@/lib/auth/mfa/webauthn", () => ({
  createMfaRegistrationOptions: vi.fn(),
  verifyMfaRegistration: vi.fn(),
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { POST as REGISTER_OPTIONS } from "../options/route";
import { POST as REGISTER_VERIFY } from "../verify/route";
import { requireMfaManagementAuth } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  createMfaRegistrationOptions,
  verifyMfaRegistration,
} from "@/lib/auth/mfa/webauthn";

const USER = { id: "user-1", username: "u", email: "u@example.com" };

function verifyRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    "http://localhost/api/auth/me/mfa/webauthn/register/verify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireMfaManagementAuth).mockResolvedValue({
    transport: "cookie",
    user: USER,
    session: { id: "sess-1" },
    commitElevation: vi.fn().mockResolvedValue(undefined),
  } as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/auth/me/mfa/webauthn/register/options", () => {
  it("returns ceremony options + challenge id", async () => {
    vi.mocked(createMfaRegistrationOptions).mockResolvedValue({
      options: { challenge: "abc" },
      challengeId: "ch-1",
    } as never);

    const res = await REGISTER_OPTIONS();
    const body = (await res.json()) as {
      data: { options: unknown; challengeId: string };
    };

    expect(res.status).toBe(200);
    expect(body.data.challengeId).toBe("ch-1");
    expect(createMfaRegistrationOptions).toHaveBeenCalledWith(
      "user-1",
      "u@example.com",
    );
  });
});

describe("POST /api/auth/me/mfa/webauthn/register/verify", () => {
  const credential = {
    id: "cred-1",
    rawId: "cred-1",
    type: "public-key",
    response: { transports: ["usb"] },
  };

  it("stores the credential when verification succeeds", async () => {
    vi.mocked(verifyMfaRegistration).mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-1",
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 0,
        },
      },
    } as never);
    vi.mocked(prisma.webauthnMfaCredential.create).mockResolvedValue({
      id: "row-1",
      name: "My key",
      createdAt: new Date(),
      lastUsedAt: null,
    } as never);

    const res = await REGISTER_VERIFY(
      verifyRequest({ challengeId: "ch-1", credential, name: "My key" }),
    );
    const body = (await res.json()) as { data: { id: string; name: string } };

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("row-1");
    expect(verifyMfaRegistration).toHaveBeenCalledWith(
      "ch-1",
      "user-1",
      credential,
    );
    const createArgs = vi.mocked(prisma.webauthnMfaCredential.create).mock
      .calls[0][0];
    expect(createArgs.data.userId).toBe("user-1");
    expect(createArgs.data.credentialId).toBe("cred-1");
    expect(createArgs.data.name).toBe("My key");
  });

  it("returns 400 when verification fails", async () => {
    vi.mocked(verifyMfaRegistration).mockResolvedValue({
      verified: false,
    } as never);

    const res = await REGISTER_VERIFY(
      verifyRequest({ challengeId: "ch-1", credential }),
    );

    expect(res.status).toBe(400);
    expect(prisma.webauthnMfaCredential.create).not.toHaveBeenCalled();
  });

  it("returns 422 for a malformed body", async () => {
    const res = await REGISTER_VERIFY(verifyRequest({ challengeId: "ch-1" }));
    expect(res.status).toBe(422);
  });
});
