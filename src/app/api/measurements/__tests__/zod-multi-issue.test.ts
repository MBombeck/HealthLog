/**
 * v1.4.43 W6 — multi-issue 422 envelope on the measurements route.
 *
 * GET, batch POST and single POST now return every Zod issue under
 * `details.issues` and write an audit-ledger breadcrumb so the
 * operator can grep `/api/admin/audit` for the corresponding
 * `<route>.validation-failed` rows.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    measurementRollup: {
      findMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    timezone: "Europe/Berlin",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

function getReq(qs: string): NextRequest {
  return new NextRequest(`http://localhost/api/measurements?${qs}`);
}

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/measurements — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // `limit=999999` (above 5000 max) + `offset=-1` (below 0 min).
    const res = await GET(getReq("limit=999999&offset=-1"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // bad sortBy + bad sortDir + bad aggregate.
    const res = await GET(getReq("sortBy=junk&sortDir=upside&aggregate=hourly"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a measurements.list.validation-failed audit row", async () => {
    const res = await GET(getReq("limit=999999&offset=-1"));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.list.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await GET(getReq("limit=999999&offset=-1"));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/measurements — single — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Missing `type` (required enum) + missing `value` (required number).
    const res = await POST(
      postReq({ measuredAt: "not-an-iso-string" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad enum (`type`) + bad number (`value`) + bad iso (`measuredAt`).
    const res = await POST(
      postReq({ type: "NOT_A_TYPE", value: "stringy", measuredAt: "x" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a measurements.create.validation-failed audit row", async () => {
    const res = await POST(postReq({ measuredAt: "junk" }));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.create.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(postReq({ measuredAt: "junk" }));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/measurements — batch — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors across the batch", async () => {
    // Two malformed entries: one with bad type, one with bad measuredAt.
    const res = await POST(
      postReq([
        { type: "NOT_A_TYPE", value: 100, measuredAt: "2026-01-01T00:00:00Z" },
        { type: "WEIGHT", value: 70, measuredAt: "definitely-not-iso" },
      ]),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces THREE simultaneous validation errors across the batch", async () => {
    const res = await POST(
      postReq([
        { type: "WEIGHT", value: "string", measuredAt: "2026-01-01T00:00:00Z" },
        { type: "NOT_A_TYPE", value: 70, measuredAt: "2026-01-01T00:00:00Z" },
        { type: "WEIGHT", value: 70, measuredAt: "nope" },
      ]),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a measurements.create.batch.validation-failed audit row", async () => {
    const res = await POST(
      postReq([
        { type: "WEIGHT", value: 70, measuredAt: "junk" },
        { type: "NOT_A_TYPE", value: 70, measuredAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("measurements.create.batch.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq([
        { type: "WEIGHT", value: 70, measuredAt: "junk" },
        { type: "NOT_A_TYPE", value: 70, measuredAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    expect(res.status).toBe(422);
  });
});
