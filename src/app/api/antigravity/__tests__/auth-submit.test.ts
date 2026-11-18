import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/ai/antigravity-auth-session", () => ({
  submitAntigravityAuthCode: vi.fn(),
  ANTIGRAVITY_LOGIN_FAILURE_MESSAGES: {},
}));

vi.mock("@/lib/ai/antigravity-client", () => ({
  antigravityProfileLocation: vi.fn(),
  probeAntigravity: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-errors", () => ({
  antigravityReasonOf: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-capability-cache", () => ({
  setAntigravityCapabilities: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import { submitAntigravityAuthCode } from "@/lib/ai/antigravity-auth-session";
import {
  antigravityProfileLocation,
  probeAntigravity,
} from "@/lib/ai/antigravity-client";
import { antigravityReasonOf } from "@/lib/ai/antigravity-errors";
import { setAntigravityCapabilities } from "@/lib/ai/antigravity-capability-cache";
import { POST as authSubmitPOST } from "../auth/submit/route";

const submitWithRequest = authSubmitPOST as unknown as (
  request: NextRequest,
) => Promise<Response>;

function mockUserSession() {
  vi.mocked(getSession).mockResolvedValue({
    user: {
      id: "u-1",
      email: "u1@example.com",
      role: "user",
    },
    session: { id: "s-1" },
  } as never);
}

describe("POST /api/antigravity/auth/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserSession();
    vi.mocked(submitAntigravityAuthCode).mockResolvedValue(null);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: "0123456789abcdef0123456789abcdef",
    } as never);
    vi.mocked(antigravityProfileLocation).mockReturnValue({
      geminiDir:
        "/var/lib/healthlog/antigravity/0123456789abcdef0123456789abcdef",
    });
  });

  it("updates user as connected when probe succeeds", async () => {
    vi.mocked(probeAntigravity).mockResolvedValue({
      capabilities: { image: true, embeddedContext: true },
      agentName: null,
      modelOptions: null,
    });

    const req = new NextRequest(
      "http://localhost/api/antigravity/auth/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "4/valid-code" }),
      },
    );

    const res = await submitWithRequest(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ success: true, status: "connected" });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: expect.objectContaining({
        antigravityConnectionStatus: "connected",
        antigravityCapabilitiesJson: {
          promptCapabilities: { image: true, embeddedContext: true },
        },
      }),
    });
  });

  it("saves antigravityReasonOf(err) status and does not report connected on probe failure", async () => {
    const probeError = new Error("Auth token invalid");
    vi.mocked(probeAntigravity).mockRejectedValue(probeError);
    vi.mocked(antigravityReasonOf).mockReturnValue("auth_required");

    const req = new NextRequest(
      "http://localhost/api/antigravity/auth/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "4/stale-code" }),
      },
    );

    const res = await submitWithRequest(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ success: false, status: "auth_required" });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: expect.objectContaining({
        antigravityConnectionStatus: "auth_required",
        antigravityConnectedAt: null,
      }),
    });
  });

  it("saves error status and does not report connected on general probe error", async () => {
    const probeError = new Error("CLI timed out");
    vi.mocked(probeAntigravity).mockRejectedValue(probeError);
    vi.mocked(antigravityReasonOf).mockReturnValue("timeout");

    const req = new NextRequest(
      "http://localhost/api/antigravity/auth/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "4/valid-code" }),
      },
    );

    const res = await submitWithRequest(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ success: false, status: "error" });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: expect.objectContaining({
        antigravityConnectionStatus: "error",
        antigravityConnectedAt: null,
      }),
    });
    expect(setAntigravityCapabilities).toHaveBeenCalledWith("u-1", null);
  });

  it("updates DB to error and clears capabilities cache when user has no profile configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
    } as never);

    const req = new NextRequest(
      "http://localhost/api/antigravity/auth/submit",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "4/valid-code" }),
      },
    );

    const res = await submitWithRequest(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ success: false, status: "error" });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u-1" },
      data: expect.objectContaining({
        antigravityConnectionStatus: "error",
        antigravityConnectedAt: null,
      }),
    });
    expect(setAntigravityCapabilities).toHaveBeenCalledWith("u-1", null);
  });
});
