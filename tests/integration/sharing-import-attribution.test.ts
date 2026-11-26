import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getImportStatus } from "@/app/api/medications/[id]/intake/import/[jobId]/status/route";
import { ACCOUNT_SELECTOR_HEADER } from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import { toJson } from "@/lib/db";
import {
  _setMedicationIntakeImportPrismaForTests,
  processMedicationIntakeImportJob,
  type MedicationImportProgress,
} from "@/lib/jobs/medication-intake-import";

import { getPrismaClient, truncateAllTables } from "./setup";
import { cookieJar, headerJar } from "./mock-next-headers";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
    })),
  };
});

const EMPTY_PROGRESS: MedicationImportProgress = {
  processed: 0,
  total: 0,
  imported: 0,
  skippedByReason: {},
  touchedDays: [],
  rollupProcessed: 0,
};

beforeEach(async () => {
  const prisma = getPrismaClient();
  _setMedicationIntakeImportPrismaForTests(prisma);
  await truncateAllTables(prisma);
  cookieJar.clear();
  headerJar.clear();
});

describe("shared intake import attribution", () => {
  it("[J7-durable-import-actor] retains the record and manager through one durable completion audit", async () => {
    const prisma = getPrismaClient();
    await prisma.user.createMany({
      data: [
        {
          id: "import-record",
          username: "import-record",
          email: "import-record@example.test",
          role: "USER",
        },
        {
          id: "import-manager",
          username: "import-manager",
          email: "import-manager@example.test",
          role: "USER",
        },
      ],
    });
    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: "import-record",
        actorUserId: "import-manager",
        medicationId: null,
        payload: toJson({ entries: [] }),
        progress: toJson(EMPTY_PROGRESS),
      } as never,
    });

    await processMedicationIntakeImportJob(job.id);
    await processMedicationIntakeImportJob(job.id);

    const [completed, audits] = await Promise.all([
      prisma.medicationIntakeImportJob.findUniqueOrThrow({
        where: { id: job.id },
      }),
      prisma.auditLog.findMany({
        where: {
          userId: "import-record",
          action: "medication.intake.import",
        },
      }),
    ]);

    expect(completed).toMatchObject({
      recordUserId: "import-record",
      actorUserId: "import-manager",
      status: "done",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: "import-record",
      actorUserId: "import-manager",
    });
    expect(JSON.parse(audits[0]!.details!)).toEqual({
      jobId: job.id,
      recordUserId: "import-record",
      actorUserId: "import-manager",
      imported: 0,
      skipped: 0,
      total: 0,
    });
  });

  it("[J7-durable-import-actor] lets the initiating manager poll the record-scoped job", async () => {
    const prisma = getPrismaClient();
    await prisma.user.createMany({
      data: [
        {
          id: "status-record",
          username: "status-record",
          email: "status-record@example.test",
          role: "USER",
        },
        {
          id: "status-manager",
          username: "status-manager",
          email: "status-manager@example.test",
          role: "USER",
        },
      ],
    });
    const medication = await prisma.medication.create({
      data: {
        userId: "status-record",
        name: "Status medication",
        dose: "1 unit",
      },
    });
    await prisma.accountGrant.create({
      data: {
        id: "status-manage-grant",
        grantorId: "status-record",
        granteeId: "status-manager",
        access: "MANAGE",
        acceptedAt: new Date(),
      },
    });
    const token = "hlk_shared-import-status-token".padEnd(32, "0");
    await prisma.apiToken.create({
      data: {
        userId: "status-manager",
        name: "shared import status",
        tokenHash: hashToken(token),
        permissions: ["*"],
      },
    });
    headerJar.set("authorization", `Bearer ${token}`);
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "status-record");
    const job = await prisma.medicationIntakeImportJob.create({
      data: {
        recordUserId: "status-record",
        actorUserId: "status-manager",
        medicationId: medication.id,
        payload: toJson({ entries: [] }),
        progress: toJson(EMPTY_PROGRESS),
      },
    });

    const response = await getImportStatus(
      new NextRequest(
        `http://localhost/api/medications/${medication.id}/intake/import/${job.id}/status`,
        {},
      ),
      { params: Promise.resolve({ id: medication.id, jobId: job.id }) },
    );

    expect(response.status).toBe(200);
    expect((await response.json()).data.jobId).toBe(job.id);
  });
});
