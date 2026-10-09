import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: vi.fn() },
    measurement: { count: vi.fn() },
    medication: { count: vi.fn() },
    medicationIntakeEvent: { count: vi.fn() },
    apiToken: { count: vi.fn() },
    session: { count: vi.fn() },
    appSettings: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/api-handler", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/api-handler")>(
      "@/lib/api-handler",
    );
  return {
    ...actual,
    apiHandler: <T extends (...args: unknown[]) => Promise<Response>>(
      h: T,
    ): T => h,
    requireAdmin: vi.fn(),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(() => null),
}));

vi.mock("@/lib/jobs/worker-status", () => ({
  getWorkerStatus: vi.fn(() => ({
    running: true,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    lastHeartbeat: null,
    lastReminderCheck: null,
    lastWithingsSync: null,
    lastInsightsRun: null,
    jobsProcessed: 0,
    errors: 0,
  })),
}));

const geoMock = vi.hoisted(() => ({
  lookup: "online" as "offline" | "online" | "off",
  chosen: false,
  host: "ipwho.is",
}));
vi.mock("@/lib/geo", () => ({
  geoLookupMode: () => geoMock.lookup,
  geoProviderChosen: () => geoMock.chosen,
  resolveGeoProviderHost: () => geoMock.host,
}));

vi.mock("@/lib/jobs/job-failures", () => ({
  JOB_FAILURE_WINDOW_HOURS: 72,
  readFailingQueues: vi.fn(),
}));

// v1.4.25 W21 Fix-K — `/api/admin/status` now reads the legacy-form
import { GET } from "../route";
import { prisma } from "@/lib/db";
import { requireAdmin, HttpError } from "@/lib/api-handler";
import { readFailingQueues } from "@/lib/jobs/job-failures";

const ADMIN_CTX = {
  authMethod: "cookie" as const,
  session: { id: "s1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "admin-1",
    username: "admin",
    role: "ADMIN",
  } as never,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue(ADMIN_CTX);
  vi.mocked(prisma.user.count).mockResolvedValue(0);
  vi.mocked(prisma.measurement.count).mockResolvedValue(0);
  vi.mocked(prisma.medication.count).mockResolvedValue(0);
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
  vi.mocked(prisma.apiToken.count).mockResolvedValue(0);
  vi.mocked(prisma.session.count).mockResolvedValue(0);
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
  vi.mocked(readFailingQueues).mockResolvedValue([]);
});

describe("GET /api/admin/status (integration health summary)", () => {
  it("rejects non-admin callers with 403", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new HttpError(403, "Admin access required"),
    );
    await expect(GET()).rejects.toThrow("Admin access required");
  });

  it("returns null integration entries when no app settings exist", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { integrations: Record<string, unknown> };
    };
    expect(body.data.integrations).toEqual({
      umami: null,
      glitchtip: null,
      webPush: null,
    });
  });

  it("aggregates configured + enabled flags for umami / glitchtip / web-push", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      umamiScriptUrl: "https://x/script.js",
      umamiWebsiteId: "site-1",
      umamiEnabled: true,
      glitchtipDsn: "https://abc@x/123",
      glitchtipEnabled: false,
      webPushVapidPublicKey: "pub",
      webPushVapidPrivateKeyEncrypted: "secret-blob",
      webPushVapidSubject: "mailto:a@b.com",
    } as never);

    const res = await GET();
    const body = (await res.json()) as {
      data: { integrations: Record<string, Record<string, unknown> | null> };
    };
    expect(body.data.integrations.umami).toEqual({
      configured: true,
      enabled: true,
    });
    // glitchtip is configured but the global toggle is off
    expect(body.data.integrations.glitchtip).toEqual({
      configured: true,
      enabled: false,
    });
    expect(body.data.integrations.webPush).toEqual({ configured: true });

    // Regression: encrypted blobs MUST never appear in the response envelope.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret-blob");
    expect(serialized).not.toContain("token-blob");
  });

  it("does not mark webPush configured when only the public key is present", async () => {
    vi.mocked(prisma.appSettings.findUnique).mockResolvedValue({
      webPushVapidPublicKey: "pub",
      webPushVapidPrivateKeyEncrypted: null,
      webPushVapidSubject: null,
    } as never);
    const res = await GET();
    const body = (await res.json()) as {
      data: { integrations: { webPush: unknown } };
    };
    expect(body.data.integrations.webPush).toBeNull();
  });

  it("returns aggregate counts and the worker status block", async () => {
    vi.mocked(prisma.user.count).mockResolvedValue(7);
    vi.mocked(prisma.measurement.count).mockResolvedValue(123);
    vi.mocked(prisma.apiToken.count).mockResolvedValue(2);

    const res = await GET();
    const body = (await res.json()) as {
      data: {
        counts: Record<string, number>;
        worker: { running: boolean; errors?: number };
        database: string;
      };
    };
    expect(body.data.counts).toEqual({
      users: 7,
      measurements: 123,
      medications: 0,
      intakeEvents: 0,
      activeTokens: 2,
      activeSessions: 0,
    });
    expect(body.data.worker.running).toBe(true);
    expect(body.data.worker).not.toHaveProperty("errors");
    expect(body.data.database).toBe("connected");

    // Regression: only NON-revoked tokens are counted as "active".
    const tokenCallArgs = vi.mocked(prisma.apiToken.count).mock.calls[0]?.[0];
    expect(tokenCallArgs).toEqual({ where: { revoked: false } });
  });

  it("reports named failing queues through failingJobs only", async () => {
    vi.mocked(readFailingQueues).mockResolvedValueOnce([
      {
        queue: "environment-fetch",
        failures: 2,
        lastFailedAt: "2026-07-28T12:00:00.000Z",
        lastError: "upstream unavailable",
      },
    ]);

    const res = await GET();
    const body = (await res.json()) as {
      data: {
        worker: Record<string, unknown>;
        failingJobs: {
          windowHours: number;
          queues: Array<{ queue: string; failures: number }>;
        };
      };
    };

    expect(body.data.worker).not.toHaveProperty("errors");
    expect(body.data.failingJobs).toEqual({
      windowHours: 72,
      queues: [
        expect.objectContaining({
          queue: "environment-fetch",
          failures: 2,
        }),
      ],
    });
  });

  it("carries the login-IP geo state the public version route no longer shows", async () => {
    geoMock.lookup = "online";
    geoMock.chosen = true;
    geoMock.host = "ip-api.com";
    const res = await GET();
    const body = (await res.json()) as { data: { geo: unknown } };
    expect(body.data.geo).toEqual({
      lookup: "online",
      providerChosen: true,
      providerHost: "ip-api.com",
    });
  });
});
