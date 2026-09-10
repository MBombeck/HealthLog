import { describe, it, expect, vi, beforeEach } from "vitest";

const { storeMock, clearMock, auditMock, markDisconnectedMock } = vi.hoisted(
  () => ({
    storeMock: vi.fn(),
    clearMock: vi.fn(),
    auditMock: vi.fn(),
    markDisconnectedMock: vi.fn(),
  }),
);

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: auditMock }));
vi.mock("@/lib/integrations/status", () => ({
  markDisconnected: markDisconnectedMock,
}));
vi.mock("@/lib/polar/credentials", () => ({
  storePolarClientCredentials: storeMock,
  clearPolarClientCredentials: clearMock,
}));
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
  safeJson: vi.fn(async (req: { _body: unknown }) => ({
    data: req._body,
    error: null,
  })),
}));

import { PUT, DELETE } from "../route";
import { prisma } from "@/lib/db";

type RouteResult = { data: unknown; error: string | null; status: number };
const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PUT /api/polar/credentials", () => {
  it("stores credentials and audit-logs the mutation", async () => {
    const req = { _body: { clientId: "cid", clientSecret: "csecret" } };
    const put = PUT as unknown as (r: typeof req) => Promise<RouteResult>;
    const res = await put(req);
    expect(res.status).toBe(200);
    expect(storeMock).toHaveBeenCalledWith("u1", "cid", "csecret");
    expect(auditMock).toHaveBeenCalledWith("polar.credentials.update", {
      userId: "u1",
    });
  });

  it("rejects an invalid body with a 422", async () => {
    const req = { _body: { clientId: "" } };
    const put = PUT as unknown as (r: typeof req) => Promise<RouteResult>;
    const res = await put(req);
    expect(res.status).toBe(422);
    expect(storeMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/polar/credentials", () => {
  it("clears creds + token and parks the ledger at disconnected", async () => {
    const del = DELETE as unknown as () => Promise<RouteResult>;
    const res = await del();
    expect(res.status).toBe(200);
    // The active token + member id are nulled.
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { polarAccessTokenEncrypted: null, polarUserIdEncrypted: null },
    });
    expect(clearMock).toHaveBeenCalledWith("u1");
    expect(auditMock).toHaveBeenCalledWith("polar.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnectedMock).toHaveBeenCalledWith("u1", "polar");
  });
});
