import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    fitbitConnection: { delete: vi.fn() },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));

vi.mock("@/lib/api-response", () => ({
  // The parse-refusal pair the routes now answer with: the same envelope
  // plus the per-field issue list.
  sanitiseZodIssues: (
    issues: { path: (string | number)[]; code: string; message: string }[],
  ) =>
    issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    })),
  apiValidationError: (
    error: string,
    issues: unknown[],
    status: number,
    options?: { errorCode?: string },
  ) => ({
    data: null,
    error,
    status,
    details: { issues },
    meta: options?.errorCode ? { errorCode: options.errorCode } : undefined,
  }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  safeJson: async (req: NextRequest) => {
    try {
      return { data: await req.json(), error: null };
    } catch {
      return { data: null, error: { status: 400 } };
    }
  },
}));

import { PUT, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";

const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/fitbit/credentials", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("/api/fitbit/credentials", () => {
  beforeEach(() => vi.clearAllMocks());

  it("PUT 422s on missing fields", async () => {
    const res = (await (
      PUT as unknown as (r: NextRequest) => Promise<{ status: number }>
    )(req({ clientId: "" }))) as { status: number };
    expect(res.status).toBe(422);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("DELETE clears credentials, audits the teardown, and parks the ledger (04-L1 parity)", async () => {
    userUpdate.mockResolvedValue({});
    (
      prisma.fitbitConnection.delete as ReturnType<typeof vi.fn>
    ).mockResolvedValue({});
    const res = (
      await (DELETE as unknown as () => Promise<{ data: unknown }>)()
    ).data as { deleted: boolean };
    expect(res.deleted).toBe(true);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        fitbitClientIdEncrypted: null,
        fitbitClientSecretEncrypted: null,
      },
    });
    expect(auditLog).toHaveBeenCalledWith("fitbit.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "fitbit");
  });
});
