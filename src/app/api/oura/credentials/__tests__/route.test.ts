import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({ markDisconnected: vi.fn() }));

const { storeMock, clearMock } = vi.hoisted(() => ({
  storeMock: vi.fn(),
  clearMock: vi.fn(),
}));
vi.mock("@/lib/oura/credentials", () => ({
  storeOuraClientCredentials: storeMock,
  clearOuraClientCredentials: clearMock,
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
  safeJson: vi.fn(),
}));

import { GET, PUT, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { markDisconnected } from "@/lib/integrations/status";
import { safeJson } from "@/lib/api-response";
import type { NextRequest } from "next/server";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const userUpdate = prisma.user.update as ReturnType<typeof vi.fn>;
const safeJsonMock = safeJson as ReturnType<typeof vi.fn>;

type RouteResult = { data: unknown; error: string | null; status: number };

beforeEach(() => {
  vi.clearAllMocks();
  userFind.mockResolvedValue(null);
  userUpdate.mockResolvedValue({});
  storeMock.mockResolvedValue(undefined);
  clearMock.mockResolvedValue(undefined);
});

describe("GET /api/oura/credentials", () => {
  it("reports hasCredentials true only when both columns are set", async () => {
    userFind.mockResolvedValue({
      ouraClientIdEncrypted: "enc:id",
      ouraClientSecretEncrypted: "enc:secret",
    });
    const res = (await (GET as unknown as () => Promise<RouteResult>)())!;
    expect(res.data).toEqual({ hasCredentials: true });
  });

  it("reports false when a column is missing", async () => {
    userFind.mockResolvedValue({ ouraClientIdEncrypted: "enc:id" });
    const res = (await (GET as unknown as () => Promise<RouteResult>)())!;
    expect(res.data).toEqual({ hasCredentials: false });
  });
});

describe("PUT /api/oura/credentials", () => {
  const put = PUT as unknown as (r: NextRequest) => Promise<RouteResult>;
  const req = {} as NextRequest;

  it("422s when the body fails the zod schema", async () => {
    safeJsonMock.mockResolvedValue({ data: { clientId: "" }, error: null });
    const res = await put(req);
    expect(res.status).toBe(422);
    expect(storeMock).not.toHaveBeenCalled();
  });

  it("encrypts and stores a valid client id/secret", async () => {
    safeJsonMock.mockResolvedValue({
      data: { clientId: "cid", clientSecret: "csecret" },
      error: null,
    });
    const res = await put(req);
    expect(res.status).toBe(200);
    expect(storeMock).toHaveBeenCalledWith("u1", "cid", "csecret");
  });

  it("propagates the safeJson error envelope", async () => {
    const jsonError = { data: null, error: "too big", status: 413 };
    safeJsonMock.mockResolvedValue({ data: null, error: jsonError });
    const res = await put(req);
    expect(res).toBe(jsonError);
    expect(storeMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/oura/credentials", () => {
  const del = DELETE as unknown as () => Promise<RouteResult>;

  it("audits + marks disconnected when a live token was present", async () => {
    userFind.mockResolvedValue({ ouraAccessTokenEncrypted: "enc:tok" });
    const res = await del();
    expect(res.data).toEqual({ deleted: true });
    expect(clearMock).toHaveBeenCalledWith("u1");
    expect(userUpdate).toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith("oura.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "oura");
  });

  /**
   * This case used to assert the opposite, and the assertion was the defect.
   *
   * Auditing only when a token happened to be present meant that tearing down
   * a stored credential pair which had never completed OAuth left no trail at
   * all — and a credential teardown is exactly the event an operator reads the
   * audit trail for. The Polar twin has always done both unconditionally; the
   * old expectation pinned the divergence rather than catching it.
   */
  it("audits + marks disconnected even when nothing was connected", async () => {
    userFind.mockResolvedValue({ ouraAccessTokenEncrypted: null });
    const res = await del();
    expect(res.data).toEqual({ deleted: true });
    expect(clearMock).toHaveBeenCalledWith("u1");
    expect(auditLog).toHaveBeenCalledWith("oura.credentials.delete", {
      userId: "u1",
    });
    expect(markDisconnected).toHaveBeenCalledWith("u1", "oura");
  });
});
