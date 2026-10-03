import { beforeEach, describe, expect, it, vi } from "vitest";

interface WorkerStatusFixture {
  running: boolean;
  startedAt: string | null;
  lastHeartbeat: string | null;
  lastReminderCheck: string | null;
  lastWithingsSync: string | null;
  lastInsightsRun: string | null;
  jobsProcessed: number;
  errors: number;
}

const { queryRaw, getWorkerStatus, getGlobalBoss, getSession } = vi.hoisted(
  () => ({
    queryRaw: vi.fn(async () => 1),
    getWorkerStatus: vi.fn((): WorkerStatusFixture => ({
      running: false,
      startedAt: null,
      lastHeartbeat: null,
      lastReminderCheck: null,
      lastWithingsSync: null,
      lastInsightsRun: null,
      jobsProcessed: 0,
      errors: 0,
    })),
    getGlobalBoss: vi.fn((): object | null => null),
    getSession: vi.fn(async () => null),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: { $queryRaw: queryRaw },
}));
vi.mock("@/lib/jobs/worker-status", () => ({ getWorkerStatus }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss }));
vi.mock("@/lib/auth/session", () => ({ getSession }));
vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

import { GET } from "../route";

async function health() {
  const response = await (GET as unknown as () => Promise<Response>)();
  return { response, body: (await response.json()) as { status: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue(1);
  getWorkerStatus.mockReturnValue({
    running: false,
    startedAt: null,
    lastHeartbeat: null,
    lastReminderCheck: null,
    lastWithingsSync: null,
    lastInsightsRun: null,
    jobsProcessed: 0,
    errors: 0,
  });
  getGlobalBoss.mockReturnValue(null);
  getSession.mockResolvedValue(null);
});

describe("GET /api/health process topology", () => {
  it("web mode requires DB and producer readiness, not an in-process worker", async () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "web");
    getGlobalBoss.mockReturnValue({});

    const { response, body } = await health();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("worker mode requires DB and worker readiness, not web producer readiness", async () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "worker");
    getWorkerStatus.mockReturnValue({
      running: true,
      startedAt: "2026-07-20T00:00:00.000Z",
      lastHeartbeat: "2026-07-20T00:00:00.000Z",
      lastReminderCheck: null,
      lastWithingsSync: null,
      lastInsightsRun: null,
      jobsProcessed: 0,
      errors: 0,
    });

    const { response, body } = await health();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("all mode requires both producer and worker readiness", async () => {
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "all");
    getWorkerStatus.mockReturnValue({
      running: true,
      startedAt: "2026-07-20T00:00:00.000Z",
      lastHeartbeat: "2026-07-20T00:00:00.000Z",
      lastReminderCheck: null,
      lastWithingsSync: null,
      lastInsightsRun: null,
      jobsProcessed: 0,
      errors: 0,
    });

    const missingProducer = await health();
    expect(missingProducer.response.status).toBe(503);
    expect(missingProducer.body).toEqual({ status: "degraded" });

    getGlobalBoss.mockReturnValue({});
    const ready = await health();
    expect(ready.response.status).toBe(200);
    expect(ready.body).toEqual({ status: "ok" });
  });
});

describe("GET /api/health while the encryption key does not match", () => {
  it("answers 503 with the reason, for everyone, even with every component up", async () => {
    const { setKeyMismatchState } =
      await import("@/lib/boot/key-mismatch-state");
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "web");
    getGlobalBoss.mockReturnValue({});
    setKeyMismatchState({ keyIds: ["v1"], detectedAt: "2026-10-03T00:00:00Z" });
    try {
      const { response, body } = await health();
      expect(response.status).toBe(503);
      expect(body).toEqual({
        status: "degraded",
        reason: "encryption_key_mismatch",
      });
    } finally {
      setKeyMismatchState(null);
    }
    const { response, body } = await health();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });
});

describe("GET /api/health under ENCRYPTION_KEY_CHECK=warn", () => {
  it("names the mismatch as a warning and stays ok", async () => {
    const { setKeyMismatchWarning } =
      await import("@/lib/boot/key-mismatch-state");
    vi.stubEnv("HEALTHLOG_PROCESS_TYPE", "web");
    getGlobalBoss.mockReturnValue({});
    setKeyMismatchWarning({
      keyIds: ["v1"],
      detectedAt: "2026-10-03T00:00:00Z",
    });
    try {
      const { response, body } = await health();
      expect(response.status).toBe(200);
      expect(body).toEqual({
        status: "ok",
        warning: "encryption_key_mismatch",
      });
    } finally {
      setKeyMismatchWarning(null);
    }
  });
});
