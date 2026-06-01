/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/medications/intake/bulk.
 * Preserves the `medications.intake.bulk.invalid` errorCode meta passthrough.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn(),
      // v1.8.2 — the slot resolver loads the med via findFirst.
      findFirst: vi.fn(),
    },
    medicationIntakeEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      // v1.8.2 reconcile — shared slot upsert reads + updates in place.
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
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
import { checkRateLimit } from "@/lib/rate-limit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/intake/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
});

describe("POST /api/medications/intake/bulk — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    const res = await POST(
      postReq({
        entries: [
          { medicationId: "", scheduledFor: "2026-01-01T00:00:00Z" },
          { medicationId: "m1", scheduledFor: "not-iso" },
        ],
      }),
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
    expect(body.meta?.errorCode).toBe("medications.intake.bulk.invalid");
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await POST(
      postReq({
        entries: [
          { medicationId: "", scheduledFor: "2026-01-01T00:00:00Z" },
          { medicationId: "m2", scheduledFor: "not-iso" },
          { medicationId: "m3", takenAt: "also-not-iso" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
      meta?: { errorCode?: string };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
    expect(body.meta?.errorCode).toBe("medications.intake.bulk.invalid");
  });

  it("writes the audit-ledger row keyed medications.intake.bulk.validation-failed", async () => {
    const res = await POST(
      postReq({
        entries: [{ medicationId: "", scheduledFor: "not-iso" }],
      }),
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe("medications.intake.bulk.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(
      postReq({
        entries: [{ medicationId: "", scheduledFor: "not-iso" }],
      }),
    );
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.8.2 reconcile — bulk slot-snap upsert invariants (C2 + C1)
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/intake/bulk — v1.8.2 reconcile", () => {
  const SCHEDULED_MED = {
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    schedules: [
      {
        id: "s1",
        windowStart: "07:00",
        windowEnd: "07:00",
        daysOfWeek: null,
        timesOfDay: ["07:00", "19:00"],
        reminderGraceMinutes: null,
        rrule: null,
        rollingIntervalDays: null,
        scheduleType: "SCHEDULED",
        cyclicOnWeeks: null,
        cyclicOffWeeks: null,
      },
    ],
  };

  beforeEach(() => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      SCHEDULED_MED as never,
    );
  });

  it("C2 — a pending echo onto an already-TAKEN slot is reported duplicate, NOT a downgrade", async () => {
    // Existing TAKEN row at the 07:00 slot. The bulk entry is a pending
    // echo (no takenAt, skipped false) — must NOT clear takenAt.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      {
        id: "row-taken",
        takenAt: new Date("2026-06-15T05:01:00Z"),
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T05:00:00Z"),
        source: "WEB",
        createdAt: new Date("2026-06-15T05:01:00Z"),
      },
    ] as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:30.000Z",
            // no takenAt, skipped defaults false → pending echo
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        duplicates: number;
        updated: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.duplicates).toBe(1);
    expect(body.data.updated).toBe(0);
    expect(body.data.entries[0].status).toBe("duplicate");
    // The recorded dose was NEVER touched — no update issued.
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("C2 — an explicit takenAt still applies onto a pending slot (status updated)", async () => {
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      {
        id: "row-pending",
        takenAt: null,
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T05:00:00Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-pending",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:30.000Z",
            takenAt: "2026-06-15T05:02:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { updated: number; entries: Array<{ status: string }> };
    };
    expect(body.data.updated).toBe(1);
    expect(body.data.entries[0].status).toBe("updated");
  });

  it("C1 — a same-slot P2002 on create converges via re-find+update, not dropped as duplicate", async () => {
    // First slot find empty → create races a P2002 → re-find returns the
    // racing pending row → update applies the incoming takenAt.
    vi.mocked(prisma.medicationIntakeEvent.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          id: "row-raced",
          takenAt: null,
          skipped: false,
          idempotencyKey: null,
          scheduledFor: new Date("2026-06-15T05:00:00Z"),
          source: "REMINDER",
          createdAt: new Date("2026-06-15T00:00:00Z"),
        },
      ] as never);
    vi.mocked(prisma.medicationIntakeEvent.create).mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-raced",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:30.000Z",
            takenAt: "2026-06-15T05:02:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { updated: number; entries: Array<{ status: string; id?: string }> };
    };
    // The dose is APPLIED to the existing row, not silently dropped.
    expect(body.data.updated).toBe(1);
    expect(body.data.entries[0].status).toBe("updated");
    expect(body.data.entries[0].id).toBe("row-raced");
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-raced" } }),
    );
  });
});
