/**
 * v1.4.43 W6 — multi-issue 422 envelope on PUT
 * /api/medications/[id]/intake/[eventId].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
    },
    medication: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
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

import { PUT, DELETE } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/e1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = {
  params: Promise.resolve({ id: "m1", eventId: "e1" }),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
    id: "e1",
    userId: "user-1",
    medicationId: "m1",
    scheduledFor: new Date(),
  } as never);
  // Default lifecycle stubs: medication is NOT one-shot so the
  // reconcile is a no-op for the legacy 422-envelope tests below.
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    oneShot: false,
    active: true,
  } as never);
  vi.mocked(prisma.medication.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  // v1.7.0 sync — PUT now looks the event up via `findFirst` with a
  // `deletedAt: null` guard. The default returns the live event so the
  // PUT lookup succeeds; the lifecycle `liveIntake` probe (also
  // `findFirst`) is sequenced per-test via `mockResolvedValueOnce`.
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
    id: "e1",
    userId: "user-1",
    medicationId: "m1",
    scheduledFor: new Date(),
  } as never);
});

describe("PUT /api/medications/[id]/intake/[eventId] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `takenAt` iso + bad `skipped` (not boolean).
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
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
    // Bad takenAt + bad skipped + bad scheduledFor.
    const res = await PUT(
      putReq({
        takenAt: "not-iso",
        skipped: "string",
        scheduledFor: "also-not-iso",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed medications.intake.event.update.validation-failed", async () => {
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe(
      "medications.intake.event.update.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.5.0 — one-shot lifecycle reconciliation on PUT / DELETE
// ────────────────────────────────────────────────────────────────────

function deleteReq(): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/e1", {
    method: "DELETE",
  });
}

describe("DELETE /api/medications/[id]/intake/[eventId] — one-shot reconcile", () => {
  it("re-activates a one-shot medication after the deleted event was its last live intake", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValueOnce({
      oneShot: true,
      active: false,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never,
    );
    vi.mocked(prisma.medication.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.delete).mockResolvedValueOnce(
      {} as never,
    );

    const res = await DELETE(deleteReq(), ROUTE_CTX);
    expect(res.status).toBe(200);

    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-1", oneShot: true },
      data: { active: true },
    });
    const calls = vi.mocked(auditLog).mock.calls.map((c) => c[0]);
    expect(calls).toContain("medication.oneShot.reconciled");
  });

  it("is idempotent on a non-one-shot medication", async () => {
    // Default beforeEach: medication is non-one-shot.
    vi.mocked(prisma.medicationIntakeEvent.delete).mockResolvedValueOnce(
      {} as never,
    );
    const res = await DELETE(deleteReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medication.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/medications/[id]/intake/[eventId] — one-shot reconcile on skip flip", () => {
  it("re-activates a one-shot medication when its single intake is flipped to skipped", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValueOnce({
      oneShot: true,
      active: false,
    } as never);
    // v1.7.0 sync — first `findFirst` is the PUT event lookup (returns
    // the live event); the second is the lifecycle `liveIntake` probe
    // (returns null → the dose is no longer logged → reactivate).
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: new Date(),
      } as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      skipped: true,
      takenAt: null,
    } as never);

    const res = await PUT(putReq({ skipped: true, takenAt: null }), ROUTE_CTX);
    expect(res.status).toBe(200);

    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-1", oneShot: true },
      data: { active: true },
    });
  });
});
