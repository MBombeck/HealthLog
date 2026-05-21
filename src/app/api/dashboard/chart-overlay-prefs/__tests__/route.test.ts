/**
 * v1.4.43 W6 — multi-issue 422 envelope on PUT
 * /api/dashboard/chart-overlay-prefs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserDashboardWidgets: vi.fn(),
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

import { PUT } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/chart-overlay-prefs", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

import { __resetAuditDedupMemoForTests } from "@/lib/audit-dedup";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  __resetAuditDedupMemoForTests();
});

describe("PUT /api/dashboard/chart-overlay-prefs — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `chartKey` enum + `prefs.showTrendIndicator` not a boolean.
    const res = await PUT(
      putReq({
        chartKey: "not-a-known-chart",
        prefs: {
          showTrendIndicator: "string",
          showTrendArrow: true,
          showTargetRange: true,
        },
      }),
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
    // Bad chartKey + bad showTrendIndicator + bad comparisonBaseline.
    const res = await PUT(
      putReq({
        chartKey: "not-a-chart",
        prefs: {
          showTrendIndicator: "string",
          showTrendArrow: true,
          showTargetRange: true,
          comparisonBaseline: "tomorrow",
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes a dashboard.chart-overlay.validation-failed audit row", async () => {
    const res = await PUT(
      putReq({
        chartKey: "not-a-chart",
        prefs: {
          showTrendIndicator: "string",
          showTrendArrow: true,
          showTargetRange: true,
        },
      }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe("dashboard.chart-overlay.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await PUT(
      putReq({
        chartKey: "not-a-chart",
        prefs: {
          showTrendIndicator: "string",
          showTrendArrow: true,
          showTargetRange: true,
        },
      }),
    );
    expect(res.status).toBe(422);
  });
});
