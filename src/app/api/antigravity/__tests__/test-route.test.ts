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

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock("@/lib/ai/antigravity-capability-cache", () => ({
  setAntigravityCapabilities: vi.fn(),
}));

vi.mock("@/lib/ai/antigravity-client", () => ({
  antigravityProfileLocation: vi.fn(),
  antigravityReasonOf: vi.fn(),
  probeAntigravity: vi.fn(),
}));

import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import {
  antigravityProfileLocation,
  antigravityReasonOf,
  probeAntigravity,
} from "@/lib/ai/antigravity-client";
import { POST } from "../test/route";

const postWithRequest = POST as unknown as (
  request: NextRequest,
) => Promise<Response>;

function testReq(): NextRequest {
  return new NextRequest("http://localhost:3000/api/antigravity/test", {
    method: "POST",
  });
}

const USER_ID = "usr-1";
const PROFILE_ID = "prof-test-1";

describe("POST /api/antigravity/test", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(prisma.user, "findUnique").mockImplementation(vi.fn());
    vi.spyOn(prisma.user, "update").mockImplementation(vi.fn());
    vi.mocked(getSession).mockResolvedValue({
      user: { id: USER_ID, email: "user@example.com", role: "USER" },
      session: { id: "sess-1", actingAsUserId: null },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
  });

  it("returns disconnected without probe when no profile is configured", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: null,
      antigravityConnectionStatus: "disconnected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const res = await postWithRequest(testReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toEqual({
      status: "disconnected",
      reason: "not_set_up",
      capabilities: null,
    });
    expect(probeAntigravity).not.toHaveBeenCalled();
  });

  it("does not probe and returns disconnected when profile is retained but disconnected", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
      antigravityConnectionStatus: "disconnected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const res = await postWithRequest(testReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toEqual({
      status: "disconnected",
      reason: "not_set_up",
      capabilities: null,
    });
    expect(probeAntigravity).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          antigravityConnectionStatus: "disconnected",
          antigravityConnectedAt: null,
        }),
      }),
    );
  });

  it("does not probe and preserves auth_required when status is auth_required", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
      antigravityConnectionStatus: "auth_required",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const res = await postWithRequest(testReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toEqual({
      status: "auth_required",
      reason: "not_set_up",
      capabilities: null,
    });
    expect(probeAntigravity).not.toHaveBeenCalled();
  });

  it("probes profile when user is connected and updates capabilities on success", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
      antigravityConnectionStatus: "connected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(antigravityProfileLocation).mockReturnValue({
      geminiDir: "/tmp/profiles/prof-test-1",
    });
    vi.mocked(probeAntigravity).mockResolvedValue({
      capabilities: { image: true, embeddedContext: true },
      agentName: null,
      modelOptions: null,
      thoughtLevelOptions: null,
    });

    const res = await postWithRequest(testReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(probeAntigravity).toHaveBeenCalledWith({
      geminiDir: "/tmp/profiles/prof-test-1",
    });
    expect(body.data).toEqual({
      status: "connected",
      reason: null,
      capabilities: { image: true, embeddedContext: true },
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          antigravityConnectionStatus: "connected",
          antigravityCapabilitiesJson: {
            promptCapabilities: { image: true, embeddedContext: true },
          },
        }),
      }),
    );
  });

  it("returns auth_required when probe reveals expired credentials", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      antigravityProfileId: PROFILE_ID,
      antigravityConnectionStatus: "connected",
    } as unknown as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    vi.mocked(antigravityProfileLocation).mockReturnValue({
      geminiDir: "/tmp/profiles/prof-test-1",
    });
    vi.mocked(probeAntigravity).mockRejectedValue(new Error("Token expired"));
    vi.mocked(antigravityReasonOf).mockReturnValue("auth_required");

    const res = await postWithRequest(testReq());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.data).toEqual({
      status: "auth_required",
      reason: "auth_required",
      capabilities: null,
    });
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          antigravityConnectionStatus: "auth_required",
          antigravityConnectedAt: null,
        }),
      }),
    );
  });
});
