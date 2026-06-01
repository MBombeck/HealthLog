/**
 * v1.4.43 W6 — multi-issue 422 envelope on PUT /api/medications/[id].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    medicationSchedule: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    apiToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/medication-category", () => ({
  deleteMedicationCategory: vi.fn().mockResolvedValue(undefined),
  getMedicationCategories: vi.fn().mockResolvedValue({}),
  setMedicationCategory: vi.fn().mockResolvedValue(undefined),
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
import { getMedicationCategories } from "@/lib/medication-category";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = { params: Promise.resolve({ id: "m1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "m1",
    userId: "user-1",
  } as never);
});

describe("PUT /api/medications/[id] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `name` (number) + bad `active` (string).
    const res = await PUT(putReq({ name: 123, active: "string" }), ROUTE_CTX);
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
    // Bad name + bad active + bad category.
    const res = await PUT(
      putReq({ name: 123, active: "string", category: 999 }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("PUT /api/medications/[id] — v1.5 scheduling primitives", () => {
  function lastUpdateCall(): {
    data: Record<string, unknown>;
  } {
    const calls = vi.mocked(prisma.medication.update).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0] as never;
  }

  it("(6) PATCH endsOn updates the field", async () => {
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      endsOn: new Date("2026-12-31"),
      schedules: [],
    } as never);
    // Re-stub deps the outer beforeEach's resetAllMocks cleared.
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    const res = await PUT(
      putReq({ endsOn: "2026-12-31" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const call = lastUpdateCall();
    expect(call.data.endsOn).toBeInstanceOf(Date);
    expect((call.data.endsOn as Date).toISOString()).toBe(
      new Date("2026-12-31").toISOString(),
    );
  });

  it("(4-PUT) 422 when oneShot=true + schedule carries rrule", async () => {
    const res = await PUT(
      putReq({
        oneShot: true,
        startsOn: "2026-10-15",
        schedules: [
          {
            windowStart: "10:00",
            windowEnd: "10:30",
            rrule: "FREQ=DAILY",
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });

  it("(5-PUT) 422 when oneShot=true + multiple schedules", async () => {
    const res = await PUT(
      putReq({
        oneShot: true,
        startsOn: "2026-10-15",
        schedules: [
          { windowStart: "08:00", windowEnd: "08:30" },
          { windowStart: "20:00", windowEnd: "20:30" },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

describe("PUT /api/medications/[id] — primary-schedule grace bridge", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
      schedules: [
        {
          id: "sched-primary",
          windowStart: "08:00",
          windowEnd: "08:30",
        },
      ],
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      schedules: [
        {
          id: "sched-primary",
          windowStart: "08:00",
          windowEnd: "08:30",
        },
      ],
    } as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(prisma.medicationSchedule.findFirst).mockResolvedValue({
      id: "sched-primary",
    } as never);
    vi.mocked(prisma.medicationSchedule.update).mockResolvedValue({
      id: "sched-primary",
      reminderGraceMinutes: 45,
    } as never);
  });

  it("lands a top-level reminderGraceMinutes value on the primary schedule", async () => {
    const res = await PUT(putReq({ reminderGraceMinutes: 45 }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medicationSchedule.findFirst).toHaveBeenCalledWith({
      where: { medicationId: "m1" },
      orderBy: { windowStart: "asc" },
      select: { id: true },
    });
    expect(prisma.medicationSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-primary" },
      data: { reminderGraceMinutes: 45 },
    });
  });

  it("clears the override when the user passes null", async () => {
    vi.mocked(prisma.medicationSchedule.update).mockResolvedValue({
      id: "sched-primary",
      reminderGraceMinutes: null,
    } as never);
    const res = await PUT(putReq({ reminderGraceMinutes: null }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medicationSchedule.update).toHaveBeenCalledWith({
      where: { id: "sched-primary" },
      data: { reminderGraceMinutes: null },
    });
  });

  it("skips the schedule bridge when the body carries a full schedules array", async () => {
    const res = await PUT(
      putReq({
        reminderGraceMinutes: 45,
        schedules: [{ windowStart: "08:00", windowEnd: "08:30" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationSchedule.findFirst).not.toHaveBeenCalled();
    expect(prisma.medicationSchedule.update).not.toHaveBeenCalled();
  });
});
