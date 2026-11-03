/**
 * The dose-history import kickoff contract.
 *
 * The route parses, matches, and hands the write to the background job. What is
 * asserted here is the contract around that: the verdict it returns, that a dry
 * run writes nothing at all, that the job it enqueues is account-wide with the
 * pre-queue refusals already seeded into its progress, and that a file it cannot
 * read is refused with a code naming the actual problem.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const prismaMock = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "user-1" }]),
    medication: { findMany: vi.fn() },
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
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/jobs/boss-instance", () => ({ getGlobalBoss: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
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
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: {
    id: "session-1",
    expiresAt: new Date(Date.now() + 3_600_000),
    actingAsUserId: null,
  },
  user: { id: "user-1", username: "owner", role: "USER", email: null },
};

const HEADER =
  "Date,Scheduled Date,Medication,Nickname,Dosage,Scheduled Dosage,Unit,Status,Archived,Codings";

/** Two takeable rows for one medication, plus a row recording no decision. */
const CSV = [
  HEADER,
  "2025-01-01 08:20:00 +1030,2025-01-01 08:00:00 +1030,Ramipril,Ramipril,1.0,1.0,count,Taken,No,",
  "2025-01-02 08:05:00 +1030,2025-01-02 08:00:00 +1030,Ramipril,Ramipril,0.5,1.0,count,Taken,Yes,",
  "2025-01-03 08:00:00 +1030,2025-01-03 08:00:00 +1030,Ramipril,Ramipril,,1.0,count,Not Interacted,No,",
  "",
].join("\n");

function postReq(
  body: string,
  opts: { contentType?: string; query?: string } = {},
) {
  return new NextRequest(
    `http://localhost/api/medications/intake/dose-history-import${opts.query ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": opts.contentType ?? "text/csv" },
      body,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSession).mockResolvedValue(
    SESSION_OK as unknown as Awaited<ReturnType<typeof getSession>>,
  );
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: new Date(),
  } as unknown as Awaited<ReturnType<typeof checkRateLimit>>);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([
    { id: "med-1", name: "Ramipril", externalSource: null },
  ] as never);
  vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue(null);
  vi.mocked(prisma.medicationIntakeImportJob.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.medicationIntakeImportJob.create).mockResolvedValue({
    id: "job-1",
  } as never);
  vi.mocked(getGlobalBoss).mockReturnValue({
    send: vi.fn().mockResolvedValue("boss-1"),
  } as never);
});

describe("POST /api/medications/intake/dose-history-import", () => {
  it("returns the whole verdict and a pollable handle", async () => {
    const res = await POST(postReq(CSV));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data).toEqual({
      dryRun: false,
      jobId: "job-1",
      status: "queued",
      statusUrl: "/api/medications/intake/dose-history-import/job-1/status",
      file: {
        rowsRead: 3,
        queued: 2,
        refused: 1,
        refusedByReason: [{ reason: "status_no_dose_information", count: 1 }],
        unmatchedMedications: [],
        ambiguousMedications: [],
        mirroredMedications: [],
        unknownColumns: [],
        codingsNotRead: 0,
        // Read and reported, never a reason to drop the dose.
        fromArchivedMedications: 1,
      },
    });
  });

  it("enqueues an account-wide job carrying both instants and the seeded refusals", async () => {
    await POST(postReq(CSV));
    expect(prisma.medicationIntakeImportJob.create).toHaveBeenCalledWith({
      data: {
        recordUserId: "user-1",
        actorUserId: "user-1",
        // No medication owns a file covering a regimen; each entry names its own.
        medicationId: null,
        status: "queued",
        payload: {
          entries: [
            {
              medicationId: "med-1",
              scheduledFor: "2024-12-31T21:30:00.000Z",
              takenAt: "2024-12-31T21:50:00.000Z",
              idempotencyKey: `import-med-1-${Date.parse("2024-12-31T21:30:00.000Z")}`,
              sourceLine: 2,
            },
            {
              medicationId: "med-1",
              scheduledFor: "2025-01-01T21:30:00.000Z",
              takenAt: "2025-01-01T21:35:00.000Z",
              idempotencyKey: `import-med-1-${Date.parse("2025-01-01T21:30:00.000Z")}`,
              sourceLine: 3,
              // 0.5 against a scheduled 1.0 — a real deviation, so it is kept.
              doseTaken: "0.5",
            },
          ],
        },
        progress: {
          processed: 0,
          total: 2,
          imported: 0,
          // Seeded, so the count at the end of the run covers the whole file.
          skippedByReason: { status_no_dose_information: 1 },
          skipDetails: [{ line: 4, reason: "status_no_dose_information" }],
          skippedDetailsOmitted: 0,
          touchedDays: [],
          rollupProcessed: 0,
        },
      },
    });
  });

  it("writes nothing on a dry run", async () => {
    const res = await POST(postReq(CSV, { query: "?dryRun=1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.dryRun).toBe(true);
    expect(body.data.jobId).toBeNull();
    expect(body.data.file.queued).toBe(2);
    expect(prisma.medicationIntakeImportJob.create).not.toHaveBeenCalled();
    expect(getGlobalBoss).not.toHaveBeenCalled();
  });

  it("names the medications it could not match", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    const res = await POST(postReq(CSV, { query: "?dryRun=1" }));
    const body = await res.json();
    expect(body.data.file.unmatchedMedications).toEqual(["Ramipril"]);
    expect(body.data.file.queued).toBe(0);
  });

  it("refuses the JSON shape with the reason it cannot be imported", async () => {
    const res = await POST(
      postReq(
        JSON.stringify([
          {
            displayText: "Ramipril",
            scheduledDate: "2025-01-01 08:00:00 +1030",
            status: "Taken",
            isArchived: false,
          },
        ]),
        { contentType: "application/json" },
      ),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("json_carries_no_intake_time");
    expect(prisma.medicationIntakeImportJob.create).not.toHaveBeenCalled();
  });

  it("names the missing column when the header cannot carry a dose", async () => {
    const res = await POST(postReq("Date,Nickname\n2025-01-01,x\n"));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta).toEqual({
      requestId: expect.any(String),
      errorCode: "missing_required_columns",
      detail: "Medication, Status",
    });
  });

  it("refuses a body it has no parser for rather than guessing", async () => {
    const res = await POST(postReq(CSV, { contentType: "application/x-yaml" }));
    expect(res.status).toBe(415);
  });

  it("refuses a second run while one is still going", async () => {
    vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue({
      id: "job-0",
    } as never);
    const res = await POST(postReq(CSV));
    expect(res.status).toBe(409);
    expect(prisma.medicationIntakeImportJob.create).not.toHaveBeenCalled();
  });

  it("looks only at account-wide work when deciding whether one is already running", async () => {
    await POST(postReq(CSV));
    // The in-progress check and the stale sweep both narrow on
    // `medicationId: null`. Without that narrowing, an import running on a
    // single medication's own page would refuse this one — and the sweep would
    // reach across and fail it.
    expect(prisma.medicationIntakeImportJob.findFirst).toHaveBeenCalledWith({
      where: {
        recordUserId: "user-1",
        medicationId: null,
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    expect(prisma.medicationIntakeImportJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          recordUserId: "user-1",
          medicationId: null,
        }),
      }),
    );
  });

  it("fails the job and answers 503 when the worker cannot take it", async () => {
    vi.mocked(getGlobalBoss).mockReturnValue(null as never);
    const res = await POST(postReq(CSV));
    expect(res.status).toBe(503);
    // The job row is not left sitting in `queued` with nothing to pick it up.
    expect(prisma.medicationIntakeImportJob.update).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: expect.objectContaining({
        status: "failed",
        failureReason: "Background worker enqueue failed",
      }),
    });
  });

  it("refuses once the import quota for the hour is spent", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof checkRateLimit>>);
    const res = await POST(postReq(CSV));
    expect(res.status).toBe(429);
    expect(prisma.medication.findMany).not.toHaveBeenCalled();
  });
});
