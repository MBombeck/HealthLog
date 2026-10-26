import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    notificationChannel: {
      upsert: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetAt: new Date(Date.now() + 15 * 60 * 1000),
  }),
}));

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
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(prisma.device.findUnique).mockResolvedValue(null);
  vi.mocked(prisma.device.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.device.create).mockResolvedValue({ id: "dev-1" } as never);
  vi.mocked(prisma.device.update).mockResolvedValue({ id: "dev-1" } as never);
  vi.mocked(prisma.device.deleteMany).mockResolvedValue({ count: 0 });
  vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({ count: 0 });
  vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
  vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
    callback(prisma as never),
  );
  vi.mocked(prisma.notificationChannel.upsert).mockResolvedValue({
    id: "ch-1",
  } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // `resetAllMocks` strips the top-level `.mockResolvedValue(...)`
  // declaration too, so re-arm the rate-limit success path here.
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 19,
    resetAt: new Date(Date.now() + 15 * 60 * 1000),
  } as never);
});

describe("POST /api/devices", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 for missing token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ bundleId: "io.healthlog.app" }));
    expect(res.status).toBe(422);
  });

  it("creates a new device row when token is unknown", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        locale: "de-DE",
        appVersion: "1.0.0",
        model: "iPhone15,2",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("rejects cross-user re-registration with 409", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "other-user",
      token: "abcd1234efgh5678",
    } as never);
    const res = await POST(
      req({ token: "abcd1234efgh5678", bundleId: "io.healthlog.app" }),
    );
    expect(res.status).toBe(409);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(prisma.device.create).not.toHaveBeenCalled();
  });

  it("updates in place when same user re-registers their own token", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "user-1",
      token: "abcd1234efgh5678",
    } as never);
    const res = await POST(
      req({ token: "abcd1234efgh5678", bundleId: "io.healthlog.app" }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.update).toHaveBeenCalledTimes(1);
    expect(prisma.device.create).not.toHaveBeenCalled();
  });

  it("returns 422 when only apnsToken is supplied without apnsEnvironment", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
      }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when only apnsEnvironment is supplied without apnsToken", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("returns 422 when apnsToken is not hex", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "not-hex-z",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(422);
  });

  it("creates a Device row with the apnsToken + apnsEnvironment pair", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.device.create).mock.calls[0][0] as {
      data: { apnsToken?: string; apnsEnvironment?: string };
    };
    expect(args.data.apnsToken).toBe("deadbeef".repeat(8));
    expect(args.data.apnsEnvironment).toBe("sandbox");
  });

  it("rejects re-registration of an apnsToken owned by another user with 409", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findFirst).mockResolvedValue({
      id: "other-dev",
      userId: "other-user",
    } as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(409);
    expect(prisma.device.create).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("reconciles a changed legacy token onto the same user's APNs device", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findFirst).mockResolvedValue({
      id: "self-dev",
      userId: "user-1",
      token: "original-legacy-token",
    } as never);
    const res = await POST(
      req({
        token: "changed-legacy-token",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.create).not.toHaveBeenCalled();
    expect(prisma.device.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "self-dev", userId: "user-1" },
        data: expect.objectContaining({ token: "changed-legacy-token" }),
      }),
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deviceId: "original-legacy-token" },
      data: { deviceId: "changed-legacy-token" },
    });
  });

  it("merges two same-user identities and migrates owned refresh tokens", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "legacy-dev",
      userId: "user-1",
      token: "changed-legacy-token",
      medicationDelivery: "client",
      liveActivityPushToken: "cafebabe".repeat(8),
    } as never);
    vi.mocked(prisma.device.findFirst).mockResolvedValue({
      id: "apns-dev",
      userId: "user-1",
      token: "original-legacy-token",
    } as never);

    const res = await POST(
      req({
        token: "changed-legacy-token",
        bundleId: "io.healthlog.app",
        apnsToken: "deadbeef".repeat(8),
        apnsEnvironment: "production",
      }),
    );

    expect(res.status).toBe(201);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", deviceId: "original-legacy-token" },
      data: { deviceId: "changed-legacy-token" },
    });
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({
      where: { id: "legacy-dev", userId: "user-1" },
    });
    expect(prisma.device.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "apns-dev", userId: "user-1" },
        data: expect.objectContaining({
          medicationDelivery: "client",
          liveActivityPushToken: "cafebabe".repeat(8),
        }),
      }),
    );
  });

  // v1.17.1 (#22) — Live Activity push-token registration.
  it("persists liveActivityPushToken on create when supplied", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        liveActivityPushToken: "cafebabe".repeat(8),
      }),
    );
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.device.create).mock.calls[0][0].data;
    expect(data.liveActivityPushToken).toBe("cafebabe".repeat(8));
  });

  it("clears liveActivityPushToken on re-register when null is sent", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-1",
      userId: "user-1",
      token: "abcd1234efgh5678",
    } as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        liveActivityPushToken: null,
      }),
    );
    expect(res.status).toBe(201);
    const data = vi.mocked(prisma.device.update).mock.calls[0][0].data;
    expect(data.liveActivityPushToken).toBeNull();
  });

  it("rejects a non-hex liveActivityPushToken with 422", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({
        token: "abcd1234efgh5678",
        bundleId: "io.healthlog.app",
        liveActivityPushToken: "not-hex-!!!",
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/devices — 422 multi-issue envelope (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Missing `token` (required) + invalid `apnsEnvironment` enum.
    const res = await POST(
      req({ bundleId: "io.healthlog.app", apnsEnvironment: "tomorrow" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Missing `token` + invalid `apnsToken` (non-hex) + invalid `bundleId` (number, not string).
    const res = await POST(
      req({
        bundleId: 42,
        apnsToken: "not-hex-z",
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes one audit-ledger row keyed devices.register.validation-failed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(
      req({ bundleId: "io.healthlog.app", apnsEnvironment: "tomorrow" }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    // Through `auditLog()`, which decides whether the refusal is filed.
    expect(auditLog).toHaveBeenCalledWith(
      "devices.register.validation-failed",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(
      req({ bundleId: "io.healthlog.app", apnsEnvironment: "tomorrow" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });
});
