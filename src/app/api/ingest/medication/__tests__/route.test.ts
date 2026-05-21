/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/ingest/medication.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    medicationIntakeEvent: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    medication: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
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
import { checkRateLimit } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/ingest/medication", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer hlk_test_token",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    permissions: ["*"],
    revoked: false,
    expiresAt: null,
    lastUsedAt: null,
  } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("POST /api/ingest/medication — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // externalIntakeSchema requires medicationName (min 1, max 200) and
    // idempotencyKey (string, max 128); takenAt iso optional. Sending
    // `medicationName=""` (min-1 violation) + `takenAt="not-iso"`
    // forces two issues. idempotencyKey is omitted so we also catch
    // the required-field check.
    const res = await POST(
      postReq({ medicationName: "", takenAt: "not-iso" }),
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
    // medicationName not a string (type-mismatch) + idempotencyKey too
    // long (>128 chars) + takenAt bad iso → 3 distinct issues.
    const res = await POST(
      postReq({
        medicationName: 123,
        idempotencyKey: "x".repeat(200),
        takenAt: "not-iso",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed ingest.medication.validation-failed", async () => {
    const res = await POST(postReq({ medicationName: "" }));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("ingest.medication.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(postReq({ medicationName: "" }));
    expect(res.status).toBe(422);
  });
});
