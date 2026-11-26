import type { Prisma } from "@/generated/prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The one device-delete path queues relay unbinds; here it is the plain
// delete the assertions below read.
vi.mock("@/lib/devices/delete-devices", async () => {
  const { prisma } = await import("@/lib/db");
  return {
    deleteDeviceRows: async (where: Prisma.DeviceWhereInput) =>
      (await prisma.device.deleteMany({ where }))?.count ?? 0,
    deleteDeviceRowsIn: async (
      tx: Prisma.TransactionClient,
      where: Prisma.DeviceWhereInput,
    ) => ({
      count: (await tx.device.deleteMany({ where }))?.count ?? 0,
      unbinds: [],
    }),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      // The pre-takeover Live Activity end looks for other accounts' rows.
      findMany: async () => [],
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      updateMany: vi.fn(),
    },
    liveActivityToken: {
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
      createMany: vi.fn(),
    },
    // Also answers the live sign-in check (`live-sign-in.ts`) with no row:
    // the other account holds no sign-in on the device.
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    notificationChannel: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    // The hosted relay ships its keys pinned, so the route looks up this
    // instance's relay registration; none exists here. A plain function, so
    // the suite's mock resets cannot turn the answer into `undefined`.
    pushRelayRegistration: {
      findUnique: async () => null,
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

function signIn() {
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
}

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
  vi.mocked(prisma.notificationChannel.updateMany).mockResolvedValue({
    count: 0,
  });
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
    signIn();
    const res = await POST(req({ bundleId: "io.healthlog.app" }));
    expect(res.status).toBe(422);
  });

  it("creates a new device row when token is unknown", async () => {
    signIn();
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

  it("takes over a device token another account registered", async () => {
    signIn();
    vi.mocked(prisma.device.findUnique).mockResolvedValue({
      id: "dev-foreign",
      userId: "other-user",
      token: "install-token-1",
      apnsToken: null,
      relayState: "none",
      relayConsentAt: null,
    } as never);
    const res = await POST(
      req({ token: "install-token-1", bundleId: "io.healthlog.app" }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["dev-foreign"] } },
    });
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith("devices.register.taken_over", {
      userId: "other-user",
      details: { deviceId: "dev-foreign" },
    });
  });

  it("updates in place when same user re-registers their own token", async () => {
    signIn();
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
    signIn();
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
    signIn();
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
    signIn();
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
    signIn();
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
    // A reminder with no iPhone paired rests the APNs channel for an hour;
    // pairing one ends that rest, so the next reminder does not wait it out.
    expect(prisma.notificationChannel.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        type: "APNS",
        // A device that registers ends the rest of a channel that waited
        // for one: none paired, or none with a route.
        lastFailureReason: { in: ["apns_no_devices", "apns_device_unrouted"] },
      },
      data: { nextRetryAt: null, lastFailureReason: null },
    });
  });

  it("takes over an apnsToken another account holds", async () => {
    signIn();
    vi.mocked(prisma.device.findFirst).mockImplementation((async (args: {
      where: { apnsToken?: string; userId?: string };
    }) =>
      args.where.apnsToken && !args.where.userId
        ? {
            id: "other-dev",
            userId: "other-user",
            token: "other-install",
            apnsToken: args.where.apnsToken,
            relayState: "none",
            relayConsentAt: null,
          }
        : null) as never);
    const res = await POST(
      req({
        token: "install-token-2",
        bundleId: "io.healthlog.app",
        apnsToken: "ab".repeat(32),
        apnsEnvironment: "sandbox",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.device.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["other-dev"] } },
    });
    expect(prisma.device.create).toHaveBeenCalledTimes(1);
  });

  it("reconciles a changed legacy token onto the same user's APNs device", async () => {
    signIn();
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
    signIn();
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
    signIn();
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
    signIn();
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

  it("registers the device and names a non-hex liveActivityPushToken", async () => {
    signIn();
    const res = await POST(
      req({
        token: "device-token-abc",
        bundleId: "io.healthlog.app",
        liveActivityPushToken: "zzzz-not-hex-zzzz",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.ignored).toEqual([
      {
        field: "liveActivityPushToken",
        code: "devices.register.invalid_field",
      },
    ]);
    const data = vi.mocked(prisma.device.create).mock.calls[0][0].data;
    expect(data).not.toHaveProperty("liveActivityPushToken");
  });

  // Apple documents no fixed token length; a push-to-start token of 256 hex
  // characters failed the whole registration against a cap of 200.
  it("takes APNs and Live Activity tokens of 256 and 512 hex characters", async () => {
    signIn();
    const res = await POST(
      req({
        token: "device-token-abc",
        bundleId: "io.healthlog.app",
        apnsToken: "ab".repeat(128),
        apnsEnvironment: "production",
        liveActivityPushToken: "cd".repeat(256),
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.ignored).toBeUndefined();
    const data = vi.mocked(prisma.device.create).mock.calls[0][0].data;
    expect(data.apnsToken).toBe("ab".repeat(128));
    expect(data.liveActivityPushToken).toBe("cd".repeat(256));
  });

  it("accepts a 256-character push-to-start token in its shape", async () => {
    signIn();
    const res = await POST(
      req({
        token: "device-token-abc",
        bundleId: "io.healthlog.app",
        apnsToken: "ab".repeat(32),
        apnsEnvironment: "production",
        liveActivityStart: {
          token: "ef".repeat(128),
          statement: {
            instanceId: "0b5f3d4e-1c2a-4b6d-8e9f-0a1b2c3d4e5f",
            tokenTag: "0".repeat(32),
            laTokenTag: "1".repeat(32),
            iat: Math.floor(Date.now() / 1000),
          },
          signature: "A".repeat(86),
        },
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // No relay consent on this device: the statement cannot hold, so the
    // field is dropped with that reason, never for its length.
    expect(body.data.ignored).toEqual([
      {
        field: "liveActivityStart",
        code: "devices.push.relay_consent_required",
      },
    ]);
    expect(vi.mocked(prisma.device.create)).toHaveBeenCalledTimes(1);
  });

  it("still registers when an optional Live Activity field is malformed", async () => {
    signIn();
    const res = await POST(
      req({
        token: "device-token-abc",
        bundleId: "io.healthlog.app",
        apnsToken: "ab".repeat(32),
        apnsEnvironment: "production",
        liveActivityStart: { token: "ef".repeat(300), signature: "x" },
        liveActivityTokens: [
          { token: "12".repeat(32), medicationId: "med-1" },
          { token: "not hex", medicationId: "med-2" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.ignored).toEqual([
      { field: "liveActivityStart", code: "devices.register.invalid_field" },
      {
        field: "liveActivityTokens[1]",
        code: "devices.register.invalid_field",
      },
    ]);
    const data = vi.mocked(prisma.device.create).mock.calls[0][0].data;
    expect(data.apnsToken).toBe("ab".repeat(32));
  });

  it("still refuses a malformed apnsToken, the registration's own field", async () => {
    signIn();
    const res = await POST(
      req({
        token: "device-token-abc",
        bundleId: "io.healthlog.app",
        apnsToken: "ab".repeat(257),
        apnsEnvironment: "production",
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe("POST /api/devices — 422 multi-issue envelope (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    signIn();
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
    signIn();
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
    signIn();
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
    signIn();
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
