/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST
 * /api/medications/[id]/intake/import. Preserves the
 * `medication.intake.import.invalid_format` errorCode meta so the CSV
 * import client UI can branch on the prefix semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findUnique: vi.fn(),
    },
    medicationIntakeEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForDay: vi.fn().mockResolvedValue(undefined),
  dayKeyForScheduledFor: vi.fn().mockReturnValue("2026-01-01"),
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
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
  } as never);
});

describe("POST /api/medications/[id]/intake/import — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Two entries with malformed datum + malformed uhrzeit.
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "not-a-time" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    // Special: the CSV-import UI branches on this errorCode to preserve
    // the historical "Invalid format: …" client behaviour.
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await POST(
      postReq([
        { datum: "not-a-date", uhrzeit: "not-a-time" },
        { datum: "also-bad", uhrzeit: "07:00:00" },
        { datum: "2026-01-01", uhrzeit: "weird" },
      ]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe(
      "medication.intake.import.invalid_format",
    );
  });

  it("writes the audit-ledger row keyed medications.intake.import.validation-failed", async () => {
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe(
      "medications.intake.import.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq([{ datum: "not-a-date", uhrzeit: "07:00:00" }]),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});
