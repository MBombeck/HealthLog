/**
 * v1.4.48 H-APNs-1 — coverage for the admin notification diagnostic
 * endpoint. The route surfaces what the dispatcher would observe when
 * targeting the calling admin's account so an operator can debug push
 * delivery without DB-shell access; these tests pin:
 *
 *   * 401 for an unauthenticated caller (no session cookie),
 *   * 403 for an authenticated non-admin (USER role),
 *   * 200 + the documented envelope shape for an admin with an empty
 *     device + channel set,
 *   * APNs token masking (prefix 8 + suffix 8 hex only, full token
 *     never returned),
 *   * per-channel `configPresent` reflecting the decrypted JSON blob
 *     for TELEGRAM / NTFY and the row-existence shortcut for APNS /
 *     WEB_PUSH (the latter two store delivery targets on sibling
 *     tables, not in the channel config blob).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    device: {
      findMany: vi.fn(),
    },
    notificationChannel: {
      findMany: vi.fn(),
    },
    // v1.4.49 — backing query for `recentPushAttempts`. The route
    // pulls the trailing 20 rows ordered by `createdAt` DESC and maps
    // the `createdAt` Date to an `at` ISO string for the response.
    pushAttempt: {
      findMany: vi.fn(),
    },
  },
}));

// The route imports requireAdmin from `@/lib/api-handler`. We keep
// apiHandler real so HttpError throws produce the proper 401 / 403
// JSON envelope, but stub requireAdmin to drive the three auth cases.
vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
  eventStorage: {
    run: <T>(_evt: unknown, fn: () => Promise<T>) => fn(),
  },
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn((value: string) => value.replace(/^enc\(|\)$/g, "")),
  encrypt: vi.fn((value: string) => `enc(${value})`),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";

const ADMIN_USER_ID = "admin-1";
const ADMIN_CTX = {
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: ADMIN_USER_ID,
    username: "admin",
    role: "ADMIN",
  },
} as never;

interface DiagnosticEnvelope {
  data: {
    devices: Array<{
      id: string;
      platform: string;
      hasApnsToken: boolean;
      apnsTokenPrefix: string | null;
      apnsTokenSuffix: string | null;
      apnsEnvironment: string | null;
      lastSeenAt: string;
    }>;
    notificationChannels: Array<{
      type: string;
      enabled: boolean;
      configPresent: boolean;
    }>;
    recentPushAttempts: Array<{
      eventType: string;
      channel: string;
      result: string;
      reason: string | null;
      at: string;
    }>;
  };
  error: string | null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.device.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.pushAttempt.findMany).mockResolvedValue([] as never);
});

describe("GET /api/admin/notifications/diagnostic — auth gates", () => {
  it("returns 401 when the caller has no session", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(401, "Not authenticated"),
    );

    const res = await GET();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { data: null; error: string };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Not authenticated");
  });

  it("returns 403 when the caller is authenticated but not ADMIN", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );

    const res = await GET();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { data: null; error: string };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Admin access required");
  });
});

describe("GET /api/admin/notifications/diagnostic — empty state", () => {
  it("returns the documented envelope shape with empty arrays for an admin with no devices or channels", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.error).toBeNull();
    expect(body.data).toEqual({
      devices: [],
      notificationChannels: [],
      recentPushAttempts: [],
    });
  });
});

describe("GET /api/admin/notifications/diagnostic — device masking", () => {
  it("returns hasApnsToken=true and 8/8-char prefix+suffix when device has an APNs token", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    const fullToken =
      "abcdef1234567890aabbccddeeff0011223344556677889900112233445566778899aabb";
    // Trim to a typical 64-char APNs hex token to keep the assertion
    // realistic. The masker doesn't care about length beyond `>= 16`.
    const token64 = fullToken.slice(0, 64);
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      {
        id: "dev-1",
        platform: "ios",
        apnsToken: token64,
        apnsEnvironment: "production",
        lastSeen: new Date("2026-05-22T10:00:00.000Z"),
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(res.status).toBe(200);
    expect(body.data.devices).toHaveLength(1);
    const device = body.data.devices[0];
    expect(device.hasApnsToken).toBe(true);
    expect(device.apnsTokenPrefix).toBe(token64.slice(0, 8));
    expect(device.apnsTokenSuffix).toBe(token64.slice(-8));
    expect(device.apnsEnvironment).toBe("production");
    expect(device.lastSeenAt).toBe("2026-05-22T10:00:00.000Z");

    // Belt-and-braces: the full token must not appear anywhere in the
    // serialised response.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(token64);
  });

  it("returns hasApnsToken=false and null prefix/suffix when the device row has no APNs token", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      {
        id: "dev-2",
        platform: "ios",
        apnsToken: null,
        apnsEnvironment: null,
        lastSeen: new Date("2026-05-22T11:00:00.000Z"),
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(res.status).toBe(200);
    const device = body.data.devices[0];
    expect(device.hasApnsToken).toBe(false);
    expect(device.apnsTokenPrefix).toBeNull();
    expect(device.apnsTokenSuffix).toBeNull();
  });
});

describe("GET /api/admin/notifications/diagnostic — channel configPresent", () => {
  it("returns configPresent=true for TELEGRAM when the decrypted blob has both botToken and chatId", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        type: "TELEGRAM",
        enabled: true,
        config: 'enc({"botToken":"bot:12345","chatId":"678"})',
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(res.status).toBe(200);
    expect(body.data.notificationChannels).toEqual([
      { type: "TELEGRAM", enabled: true, configPresent: true },
    ]);
  });

  it("returns configPresent=false for TELEGRAM when chatId is empty", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        type: "TELEGRAM",
        enabled: false,
        config: 'enc({"botToken":"bot:12345","chatId":""})',
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.data.notificationChannels).toEqual([
      { type: "TELEGRAM", enabled: false, configPresent: false },
    ]);
  });

  it("returns configPresent=true for NTFY when topic is non-empty", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        type: "NTFY",
        enabled: true,
        config: 'enc({"serverUrl":"https://ntfy.sh","topic":"hl-test"})',
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.data.notificationChannels).toEqual([
      { type: "NTFY", enabled: true, configPresent: true },
    ]);
  });

  it("returns configPresent=false for NTFY when topic is missing", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      {
        type: "NTFY",
        enabled: true,
        config: 'enc({"serverUrl":"https://ntfy.sh"})',
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.data.notificationChannels).toEqual([
      { type: "NTFY", enabled: true, configPresent: false },
    ]);
  });

  it("treats APNS and WEB_PUSH rows as configPresent=true (delivery target lives on sibling tables)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      { type: "APNS", enabled: true, config: "enc({})" },
      { type: "WEB_PUSH", enabled: false, config: "enc({})" },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.data.notificationChannels).toEqual([
      { type: "APNS", enabled: true, configPresent: true },
      { type: "WEB_PUSH", enabled: false, configPresent: true },
    ]);
  });

  it("returns configPresent=false when the encrypted blob is malformed (decryption throws)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    // Our crypto mock unwraps `enc(...)`; pass a value that yields
    // non-JSON after the unwrap so JSON.parse throws and the helper's
    // try/catch returns false.
    vi.mocked(prisma.notificationChannel.findMany).mockResolvedValue([
      { type: "TELEGRAM", enabled: true, config: "not-encrypted-junk" },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(res.status).toBe(200);
    expect(body.data.notificationChannels).toEqual([
      { type: "TELEGRAM", enabled: true, configPresent: false },
    ]);
  });
});

describe("GET /api/admin/notifications/diagnostic — recentPushAttempts", () => {
  it("returns recentPushAttempts as an empty array when the user has no rows", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(body.data.recentPushAttempts).toEqual([]);
  });

  it("maps push_attempts rows to the documented response shape (createdAt → at ISO string)", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    // The route's findMany select returns `createdAt` as a Date; the
    // mapping step normalises to an ISO string under `at`.
    vi.mocked(prisma.pushAttempt.findMany).mockResolvedValue([
      {
        eventType: "MEDICATION_REMINDER",
        channel: "APNS",
        result: "ok",
        reason: null,
        createdAt: new Date("2026-05-22T09:00:00.000Z"),
      },
      {
        eventType: "MOOD_REMINDER",
        channel: "TELEGRAM",
        result: "error",
        reason: "telegram_blocked_by_user",
        createdAt: new Date("2026-05-22T08:30:00.000Z"),
      },
    ] as never);

    const res = await GET();
    const body = (await res.json()) as DiagnosticEnvelope;

    expect(res.status).toBe(200);
    expect(body.data.recentPushAttempts).toEqual([
      {
        eventType: "MEDICATION_REMINDER",
        channel: "APNS",
        result: "ok",
        reason: null,
        at: "2026-05-22T09:00:00.000Z",
      },
      {
        eventType: "MOOD_REMINDER",
        channel: "TELEGRAM",
        result: "error",
        reason: "telegram_blocked_by_user",
        at: "2026-05-22T08:30:00.000Z",
      },
    ]);
  });

  it("scopes the push-attempt query to the calling admin's userId, ordered desc by recency, capped at 20", async () => {
    vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
    vi.mocked(prisma.pushAttempt.findMany).mockResolvedValue([] as never);

    await GET();

    expect(vi.mocked(prisma.pushAttempt.findMany)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.pushAttempt.findMany).mock.calls[0]?.[0] as {
      where: { userId: string };
      orderBy: { createdAt: "desc" };
      take: number;
    };
    expect(args.where.userId).toBe(ADMIN_USER_ID);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(20);
  });
});
