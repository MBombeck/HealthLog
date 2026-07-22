/**
 * Durable medication-intake import kickoff contracts.
 *
 * The request process validates and persists the complete payload, then
 * returns a polling handle without performing intake writes itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const prismaMock = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "m1" }]),
    medication: {
      findUnique: vi.fn(),
    },
    medicationIntakeImportJob: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  return {
    prisma: {
      ...prismaMock,
      $transaction: vi.fn((callback: (tx: typeof prismaMock) => unknown) =>
        callback(prismaMock),
      ),
    },
    toJson: (value: unknown) => value,
  };
});

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
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
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import {
  MEDICATION_INTAKE_IMPORT_QUEUE,
  MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
} from "@/lib/jobs/medication-intake-import";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

const CREATED_JOB = {
  id: "job-1",
  status: "queued",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(getGlobalBoss).mockReturnValue({
    send: vi.fn().mockResolvedValue("boss-1"),
  } as never);
  vi.mocked(prisma.medicationIntakeImportJob.create).mockResolvedValue(
    CREATED_JOB as never,
  );
  vi.mocked(prisma.medicationIntakeImportJob.update).mockResolvedValue(
    CREATED_JOB as never,
  );
  vi.mocked(prisma.medicationIntakeImportJob.updateMany).mockResolvedValue({
    count: 0,
  });
  vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
  } as never);
});

describe("POST /api/medications/[id]/intake/import — 422 multi-issue (v1.4.43 W6)", () => {
  it("rejects a body over the 1 MB cap with 413 before parsing", async () => {
    const res = await POST(postReq(["x".repeat(1024 * 1024)]), ROUTE_CTX);
    expect(res.status).toBe(413);
  });

  it("surfaces TWO simultaneous validation errors", async () => {
    // Two entries with malformed datum + malformed uhrzeit.
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "not-a-time" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    // Special: the CSV-import UI branches on this errorCode to preserve
    // the historical "Invalid format: …" client behaviour.
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "not-a-time" },
        { datum: "also-bad", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "weird" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
  });

  it("writes the audit-ledger row keyed medications.intake.import.validation-failed", async () => {
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe(
      "medications.intake.import.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );

    expect(res.status).toBe(422);
  });
  it("rejects an impossible calendar timestamp before creating a job", async () => {
    const res = await POST(
      postReq([{ datum: "2026-02-30", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );

    expect(res.status).toBe(422);
    expect(prisma.medicationIntakeImportJob.create).not.toHaveBeenCalled();
    expect(getGlobalBoss).not.toHaveBeenCalled();
  });
});

describe("POST /api/medications/[id]/intake/import — durable kickoff", () => {
  it("returns 202 with an owner-pollable job handle", async () => {
    const res = await POST(
      postReq([
        { datum: "2026-01-01", uhrzeit: "07:00:00", zaehler: 41 },
        { datum: "2026-01-01", uhrzeit: "19:00:00" },
      ]),
      ROUTE_CTX,
    );

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({
      data: {
        jobId: "job-1",
        status: "queued",
        statusUrl: "/api/medications/m1/intake/import/job-1/status",
      },
      error: null,
    });

    expect(prisma.medicationIntakeImportJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        medicationId: "m1",
        status: "queued",
        payload: {
          entries: [
            {
              idempotencyKey: "import-m1-41",
              takenAt: expect.any(String),
            },
            {
              idempotencyKey: expect.stringMatching(/^import-m1-\d+$/),
              takenAt: expect.any(String),
            },
          ],
        },
        progress: expect.objectContaining({
          processed: 0,
          imported: 0,
          skippedDuplicates: 0,
          total: 2,
        }),
      }),
    });

    const boss = vi.mocked(getGlobalBoss).mock.results[0]?.value as {
      send: ReturnType<typeof vi.fn>;
    };
    expect(boss.send).toHaveBeenCalledWith(
      MEDICATION_INTAKE_IMPORT_QUEUE,
      { jobId: "job-1" },
      expect.objectContaining({ retryLimit: expect.any(Number) }),
    );
  });

  it("fails stale abandoned work and admits a replacement job", async () => {
    const now = new Date("2026-07-21T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      vi.mocked(prisma.medicationIntakeImportJob.updateMany).mockResolvedValue({
        count: 1,
      });

      const res = await POST(
        postReq([{ datum: "2026-01-01", uhrzeit: "07:00:00" }]),
        ROUTE_CTX,
      );

      expect(res.status).toBe(202);
      expect(prisma.medicationIntakeImportJob.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          medicationId: "m1",
          userId: "user-1",
          status: { in: ["queued", "running"] },
          OR: expect.arrayContaining([
            {
              heartbeatAt: {
                lt: new Date(
                  now.getTime() - MEDICATION_INTAKE_IMPORT_STALE_AFTER_MS,
                ),
              },
            },
          ]),
        }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: "Medication intake import abandoned",
          completedAt: now,
        }),
      });
      expect(prisma.medicationIntakeImportJob.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a fresh queued or running job as the single active import", async () => {
    vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue({
      id: "active-job",
      status: "running",
    } as never);

    const res = await POST(
      postReq([{ datum: "2026-01-01", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      data: null,
      error: "Medication intake import already in progress",
    });
    expect(prisma.medicationIntakeImportJob.create).not.toHaveBeenCalled();
    expect(getGlobalBoss).not.toHaveBeenCalled();
  });

  it("marks enqueue failure terminal and never exposes the queue error", async () => {
    const queueError = "postgres://queue-user:secret@example.test exploded";
    const send = vi.fn().mockRejectedValue(new Error(queueError));
    vi.mocked(getGlobalBoss).mockReturnValue({ send } as never);

    const res = await POST(
      postReq([{ datum: "2026-01-01", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).not.toContain(queueError);
    expect(body).not.toContain("secret");
    expect(prisma.medicationIntakeImportJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "failed",
        failureReason: "Background worker enqueue failed",
        completedAt: expect.any(Date),
      }),
    });
  });
});
