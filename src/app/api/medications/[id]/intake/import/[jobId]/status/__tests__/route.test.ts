import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeImportJob: {
      findFirst: vi.fn(),
    },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const request = new NextRequest(
  "http://localhost/api/medications/med-1/intake/import/job-1",
);
const context = {
  params: Promise.resolve({ id: "med-1", jobId: "job-1" }),
};
const session = {
  session: { id: "session-1", expiresAt: new Date(Date.now() + 60_000) },
  user: { id: "user-1", username: "owner", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(session as never);
});

describe("GET medication intake import status", () => {
  it("rejects unauthenticated polling", async () => {
    vi.mocked(getSession).mockResolvedValue(null);

    const response = await GET(request, context);

    expect(response.status).toBe(401);
    expect(prisma.medicationIntakeImportJob.findFirst).not.toHaveBeenCalled();
  });

  it("uses a single owner-and-medication-scoped lookup and hides foreign jobs", async () => {
    vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue(
      null,
    );

    const response = await GET(request, context);

    expect(response.status).toBe(404);
    expect(prisma.medicationIntakeImportJob.findFirst).toHaveBeenCalledWith({
      where: { id: "job-1", medicationId: "med-1", userId: "user-1" },
    });
  });

  it.each(["queued", "running", "done", "failed"])(
    "returns the owner-visible %s state",
    async (status) => {
      vi.mocked(prisma.medicationIntakeImportJob.findFirst).mockResolvedValue({
        id: "job-1",
        status,
        progress: { processed: status === "queued" ? 0 : 2, total: 2 },
        result: status === "done" ? { imported: 2 } : null,
        failureReason:
          status === "failed" ? "Medication intake import failed" : null,
        createdAt: new Date("2026-07-21T10:00:00.000Z"),
        startedAt:
          status === "queued" ? null : new Date("2026-07-21T10:00:01.000Z"),
        completedAt:
          status === "done" || status === "failed"
            ? new Date("2026-07-21T10:00:02.000Z")
            : null,
      } as never);

      const response = await GET(request, context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toEqual(
        expect.objectContaining({
          jobId: "job-1",
          status,
          progress: expect.any(Object),
        }),
      );
      expect(JSON.stringify(body)).not.toContain("user-1");
      expect(JSON.stringify(body)).not.toContain("med-1");
    },
  );
});
