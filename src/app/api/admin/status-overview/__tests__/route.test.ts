import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { count: vi.fn() },
    withingsConnection: { count: vi.fn() },
    notificationChannel: { count: vi.fn() },
    pushSubscription: { count: vi.fn() },
    appSettings: { findUnique: vi.fn() },
    auditLog: { findFirst: vi.fn(), count: vi.fn() },
    dataBackup: { findFirst: vi.fn(), findMany: vi.fn() },
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
    requireAdmin: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

vi.mock("@/lib/jobs/worker-status", () => ({
  getWorkerStatus: vi.fn(() => ({
    running: true,
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    lastHeartbeat: null,
    lastReminderCheck: null,
    lastWithingsSync: null,
    lastInsightsRun: null,
    jobsProcessed: 0,
    errors: 0,
  })),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";

const mocks = prisma as unknown as {
  user: { count: ReturnType<typeof vi.fn> };
  withingsConnection: { count: ReturnType<typeof vi.fn> };
  notificationChannel: { count: ReturnType<typeof vi.fn> };
  pushSubscription: { count: ReturnType<typeof vi.fn> };
  appSettings: { findUnique: ReturnType<typeof vi.fn> };
  auditLog: {
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  dataBackup: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

describe("GET /api/admin/status-overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // default returns
    mocks.user.count.mockResolvedValue(0);
    mocks.withingsConnection.count.mockResolvedValue(0);
    mocks.notificationChannel.count.mockResolvedValue(0);
    mocks.pushSubscription.count.mockResolvedValue(0);
    mocks.appSettings.findUnique.mockResolvedValue(null);
    mocks.auditLog.findFirst.mockResolvedValue(null);
    mocks.auditLog.count.mockResolvedValue(0);
    mocks.dataBackup.findFirst.mockResolvedValue(null);
    mocks.dataBackup.findMany.mockResolvedValue([]);
  });

  it("returns the 6-section overview shape", async () => {
    const res = await GET();
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toHaveProperty("users");
    expect(body.data).toHaveProperty("integrations");
    expect(body.data).toHaveProperty("monitoring");
    expect(body.data).toHaveProperty("backups");
    expect(body.data).toHaveProperty("maintenance");
    expect(body.data).toHaveProperty("auditLog");
  });

  it("batches DB calls in a single Promise.all (no N+1)", async () => {
    await GET();
    // 3 user.count + 1 withings + 1 ntfy notifications + 1 webPush + 3
    // moodLog/telegram done via user.count → expect user.count called 4 times
    // (total, admins, newThisWeek, moodLog, telegram)
    expect(mocks.user.count).toHaveBeenCalledTimes(5);
    expect(mocks.withingsConnection.count).toHaveBeenCalledTimes(1);
    expect(mocks.notificationChannel.count).toHaveBeenCalledTimes(1);
    expect(mocks.pushSubscription.count).toHaveBeenCalledTimes(1);
    // The route does not loop — every aggregate is a single query.
    expect(mocks.dataBackup.findMany).toHaveBeenCalledTimes(1);
  });

  it("flags backups as alert when none exist", async () => {
    mocks.dataBackup.findFirst.mockResolvedValue(null);
    const res = await GET();
    const body = (await res.json()) as {
      data: { backups: { severity: string } };
    };
    expect(body.data.backups.severity).toBe("alert");
  });

  it("flags backups as good when fresh (<8d)", async () => {
    mocks.dataBackup.findFirst.mockResolvedValue({
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const res = await GET();
    const body = (await res.json()) as {
      data: { backups: { severity: string } };
    };
    expect(body.data.backups.severity).toBe("good");
  });

  it("flags monitoring as alert on a recent error (<24h)", async () => {
    mocks.auditLog.findFirst.mockImplementation(
      ({ where }: { where: { action: unknown } }) => {
        const action = where.action as { startsWith?: string } | string;
        if (
          typeof action === "object" &&
          action.startsWith === "system.error"
        ) {
          return Promise.resolve({ createdAt: new Date(Date.now() - 60_000) });
        }
        return Promise.resolve(null);
      },
    );
    mocks.appSettings.findUnique.mockResolvedValue({
      glitchtipEnabled: true,
      umamiEnabled: true,
    });
    const res = await GET();
    const body = (await res.json()) as {
      data: { monitoring: { severity: string } };
    };
    expect(body.data.monitoring.severity).toBe("alert");
  });

  it("flags maintenance as alert when worker is stopped", async () => {
    const wsModule = await import("@/lib/jobs/worker-status");
    vi.mocked(wsModule.getWorkerStatus).mockReturnValue({
      running: false,
      startedAt: null,
      lastHeartbeat: null,
      lastReminderCheck: null,
      lastWithingsSync: null,
      lastInsightsRun: null,
      jobsProcessed: 0,
      errors: 0,
    });
    const res = await GET();
    const body = (await res.json()) as {
      data: { maintenance: { severity: string; workerRunning: boolean } };
    };
    expect(body.data.maintenance.severity).toBe("alert");
    expect(body.data.maintenance.workerRunning).toBe(false);
  });
});
