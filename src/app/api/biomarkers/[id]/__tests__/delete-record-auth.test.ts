import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * `DELETE /api/biomarkers/{id}` takes a marker together with every reading
 * filed under it. It must resolve its record through the same record-scoped
 * labs authority as the PUT beside it — `requireRecordAuth("manage", "labs")`
 * — rather than the bare `requireAuth()` it carried before, so the delete is
 * held to the labs domain, the session fence, and the grant level like every
 * other labs write.
 */

const requireAuth = vi.fn();
const requireRecordAuth = vi.fn();

vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-handler")>();
  return {
    ...actual,
    requireAuth: (...args: unknown[]) => requireAuth(...args),
    requireRecordAuth: (...args: unknown[]) => requireRecordAuth(...args),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    biomarker: { findFirst: vi.fn(), delete: vi.fn() },
    labResult: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  },
}));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserHealthScore: vi.fn(),
}));

import { DELETE } from "../route";
import { HttpError } from "@/lib/api-handler";
import { prisma } from "@/lib/db";

const RECORD_USER = { id: "record-1", username: "r", role: "USER" };

function delReq(): NextRequest {
  return new NextRequest("http://localhost/api/biomarkers/bm-1", {
    method: "DELETE",
  });
}
const params = { params: Promise.resolve({ id: "bm-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockRejectedValue(
    new HttpError(403, "Not available for this record"),
  );
  requireRecordAuth.mockResolvedValue({
    user: RECORD_USER,
    actor: { id: "actor-1" },
    grantId: "grant-1",
    authMethod: "cookie",
  });
  vi.mocked(prisma.biomarker.findFirst).mockResolvedValue({
    id: "bm-1",
    userId: "record-1",
  } as never);
  vi.mocked(prisma.labResult.deleteMany).mockResolvedValue({
    count: 2,
  } as never);
  vi.mocked(prisma.biomarker.delete).mockResolvedValue({} as never);
});

describe("DELETE /api/biomarkers/[id] record authority", () => {
  it("resolves the record through requireRecordAuth('manage', 'labs')", async () => {
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(200);
    expect(requireRecordAuth).toHaveBeenCalledWith("manage", "labs");
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it("narrows both delete legs to the resolved record", async () => {
    await DELETE(delReq(), params);
    expect(prisma.labResult.deleteMany).toHaveBeenCalledWith({
      where: { userId: "record-1", biomarkerId: "bm-1" },
    });
  });

  it("refuses when the record authority refuses, deleting nothing", async () => {
    requireRecordAuth.mockRejectedValue(
      new HttpError(403, "Not available for this record"),
    );
    const res = await DELETE(delReq(), params);
    expect(res.status).toBe(403);
    expect(prisma.labResult.deleteMany).not.toHaveBeenCalled();
    expect(prisma.biomarker.delete).not.toHaveBeenCalled();
  });
});
