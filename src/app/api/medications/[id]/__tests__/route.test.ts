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
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    medicationScheduleRevision: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
    medicationIntakeEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
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
// v1.16.1 — the schedule-replace branch recomputes the compliance
// rollups of the tombstoned slots; stub the rollup module so the route
// test never reaches `$executeRaw`.
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  dayKeyForScheduledFor: vi.fn(() => "2026-06-10"),
  recomputeMedicationComplianceForDay: vi.fn().mockResolvedValue(undefined),
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
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";

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
  // `resetAllMocks` clears the factory-level resolved values, so the
  // schedule-replace reads need fresh defaults each test.
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  vi.mocked(prisma.medicationSchedule.deleteMany).mockResolvedValue({
    count: 0,
  } as never);
  // v1.16.3 — the schedule-replace branch archives the previous rows as a
  // revision when a cadence field changes; default to "no previous rows".
  vi.mocked(prisma.medicationSchedule.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationScheduleRevision.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.medicationScheduleRevision.create).mockResolvedValue(
    {} as never,
  );
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
    const res = await PUT(putReq({ endsOn: "2026-12-31" }), ROUTE_CTX);
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

describe("PUT /api/medications/[id] — schedule replace archives a revision (v1.16.3)", () => {
  const PREVIOUS_ROW = {
    id: "s1",
    medicationId: "m1",
    windowStart: "07:00",
    windowEnd: "19:00",
    label: null,
    dose: null,
    daysOfWeek: null,
    timesOfDay: ["07:00", "19:00"],
    reminderGraceMinutes: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
  };

  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
      createdAt: new Date("2026-05-01T08:00:00.000Z"),
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      schedules: [],
    } as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(dayKeyForScheduledFor).mockReturnValue("2026-06-10");
    vi.mocked(recomputeMedicationComplianceForDay).mockResolvedValue(undefined);
    vi.mocked(prisma.medicationSchedule.findMany).mockResolvedValue([
      PREVIOUS_ROW,
    ] as never);
  });

  it("archives the previous rows when the dose times change", async () => {
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "09:00",
            windowEnd: "21:00",
            timesOfDay: ["09:00", "21:00"],
            rrule: "FREQ=DAILY",
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const calls = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls;
    expect(calls).toHaveLength(1);
    const data = calls[0][0].data as {
      medicationId: string;
      validFrom: Date;
      validUntil: Date;
      payload: Array<{ timesOfDay: string[] }>;
    };
    expect(data.medicationId).toBe("m1");
    // First revision chains from medication.createdAt.
    expect(data.validFrom.toISOString()).toBe("2026-05-01T08:00:00.000Z");
    expect(data.validUntil.getTime()).toBeLessThanOrEqual(Date.now());
    expect(data.payload[0].timesOfDay).toEqual(["07:00", "19:00"]);
  });

  it("does NOT archive a revision on a no-op echo of the same schedule", async () => {
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "07:00",
            windowEnd: "19:00",
            timesOfDay: ["19:00", "07:00"], // reordered — still no-op
            rrule: "FREQ=DAILY",
            label: "Renamed", // display-only — never a cadence change
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("chains validFrom from the newest existing revision", async () => {
    vi.mocked(prisma.medicationScheduleRevision.findFirst).mockResolvedValue({
      validUntil: new Date("2026-06-01T12:00:00.000Z"),
    } as never);
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "10:00",
            windowEnd: "22:00",
            timesOfDay: ["10:00", "22:00"],
            rrule: "FREQ=DAILY",
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const calls = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls;
    expect(calls).toHaveLength(1);
    const data = calls[0][0].data as { validFrom: Date };
    expect(data.validFrom.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });
});

describe("PUT /api/medications/[id] — schedule replace migrates open slots", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      schedules: [],
    } as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
      count: 1,
    } as never);
  });

  it("tombstones open pending rows (today + future) on a schedule replace", async () => {
    const res = await PUT(
      putReq({
        schedules: [{ windowStart: "20:00", windowEnd: "20:30" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.updateMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.medicationIntakeEvent.updateMany).mock
      .calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Only live, never-acted rows from today's local day-start forward —
    // taken / skipped / auto-missed history must survive a schedule edit.
    expect(arg.where).toMatchObject({
      userId: "user-1",
      medicationId: "m1",
      deletedAt: null,
      takenAt: null,
      skipped: false,
      autoMissed: false,
    });
    expect((arg.where.scheduledFor as { gte: Date }).gte).toBeInstanceOf(Date);
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
    expect(arg.data.syncVersion).toEqual({ increment: 1 });
  });

  it("recomputes the compliance rollups of the tombstoned days (v1.16.1)", async () => {
    // Two pendings on the same local day + one on another day → exactly
    // two distinct day-key recomputes, not three.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      { scheduledFor: new Date("2026-06-10T06:00:00Z") },
      { scheduledFor: new Date("2026-06-10T18:00:00Z") },
      { scheduledFor: new Date("2026-06-11T06:00:00Z") },
    ] as never);
    vi.mocked(dayKeyForScheduledFor).mockImplementation((scheduledFor: Date) =>
      scheduledFor.toISOString().slice(0, 10),
    );

    const res = await PUT(
      putReq({
        schedules: [{ windowStart: "20:00", windowEnd: "20:30" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(recomputeMedicationComplianceForDay).toHaveBeenCalledTimes(2);
    expect(recomputeMedicationComplianceForDay).toHaveBeenCalledWith(
      "user-1",
      "m1",
      "2026-06-10",
      "Europe/Berlin",
    );
    expect(recomputeMedicationComplianceForDay).toHaveBeenCalledWith(
      "user-1",
      "m1",
      "2026-06-11",
      "Europe/Berlin",
    );
  });

  it("does NOT touch intake rows when the body carries no schedules array", async () => {
    const res = await PUT(putReq({ name: "Renamed" }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/medications/[id] — window / timesOfDay consistency", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      schedules: [],
    } as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(prisma.medicationIntakeEvent.updateMany).mockResolvedValue({
      count: 0,
    } as never);
  });

  function createdSchedule(): Record<string, unknown> {
    const calls = vi.mocked(prisma.medication.update).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const arg = calls[calls.length - 1][0] as unknown as {
      data: { schedules: { create: Array<Record<string, unknown>> } };
    };
    return arg.data.schedules.create[0];
  }

  it("pulls a stale window to the min/max of new timesOfDay", async () => {
    // The client changed only the dose times and echoed the old window
    // back; 21:00 falls outside [08:00, 09:00].
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            timesOfDay: ["07:00", "21:00"],
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const created = createdSchedule();
    expect(created.windowStart).toBe("07:00");
    expect(created.windowEnd).toBe("21:00");
  });

  it("keeps a window that already covers every time byte-identical", async () => {
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "06:00",
            windowEnd: "22:00",
            timesOfDay: ["08:00", "20:00"],
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const created = createdSchedule();
    expect(created.windowStart).toBe("06:00");
    expect(created.windowEnd).toBe("22:00");
  });

  it("keeps an overnight window whose times sit inside the wrap", async () => {
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "22:00",
            windowEnd: "02:00",
            timesOfDay: ["23:00"],
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const created = createdSchedule();
    expect(created.windowStart).toBe("22:00");
    expect(created.windowEnd).toBe("02:00");
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

describe("PUT /api/medications/[id] — as-needed (v1.16.11, #316)", () => {
  /** Existing-row shape the as-needed invariants read. */
  function mockExisting(overrides: {
    asNeeded?: boolean;
    scheduleCount?: number;
  }) {
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      asNeeded: overrides.asNeeded ?? false,
      _count: { schedules: overrides.scheduleCount ?? 1 },
    } as never);
  }

  it("422s when asNeeded:true carries a non-empty schedules array (Zod)", async () => {
    mockExisting({ scheduleCount: 1 });
    const res = await PUT(
      putReq({
        asNeeded: true,
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("422s when asNeeded:true would keep the existing schedules (no replace list)", async () => {
    mockExisting({ scheduleCount: 2 });
    const res = await PUT(putReq({ asNeeded: true }), ROUTE_CTX);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("schedules: []");
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("allows a normal update on an existing zero-schedule scheduled mirror when schedules are omitted", async () => {
    mockExisting({ asNeeded: false, scheduleCount: 0 });
    vi.mocked(getMedicationCategories).mockResolvedValue({} as never);
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      dose: "10 mg",
      asNeeded: false,
      schedules: [],
    } as never);

    const res = await PUT(putReq({ dose: "10 mg" }), ROUTE_CTX);

    expect(res.status).toBe(200);
    const updateData = vi.mocked(prisma.medication.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateData.data.dose).toBe("10 mg");
    expect(updateData.data.schedules).toBeUndefined();
  });

  it("flips to as-needed with schedules:[] — old rows deleted, none recreated", async () => {
    mockExisting({ scheduleCount: 1 });
    // Re-stub deps the outer beforeEach's resetAllMocks cleared.
    vi.mocked(getMedicationCategories).mockResolvedValue({} as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      asNeeded: true,
      schedules: [],
    } as never);
    const res = await PUT(putReq({ asNeeded: true, schedules: [] }), ROUTE_CTX);
    expect(res.status).toBe(200);
    // Wholesale replace ran: delete-all, recreate none.
    expect(prisma.medicationSchedule.deleteMany).toHaveBeenCalledWith({
      where: { medicationId: "m1" },
    });
    const updateData = vi.mocked(prisma.medication.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateData.data.asNeeded).toBe(true);
    expect(updateData.data.schedules).toEqual({ create: [] });
  });

  it("PUT on an already-as-needed medication never re-acquires schedules silently", async () => {
    mockExisting({ asNeeded: true, scheduleCount: 0 });
    // Body without asNeeded but WITH schedules: the effective flag stays
    // true (existing row), so the entries are refused.
    const res = await PUT(
      putReq({ schedules: [{ windowStart: "08:00", windowEnd: "09:00" }] }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("422s a flip back to scheduled without at least one schedule", async () => {
    mockExisting({ asNeeded: true, scheduleCount: 0 });
    const res = await PUT(putReq({ asNeeded: false }), ROUTE_CTX);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("at least one schedule");
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });

  it("flips back to scheduled when the body carries the new schedule list", async () => {
    mockExisting({ asNeeded: true, scheduleCount: 0 });
    vi.mocked(getMedicationCategories).mockResolvedValue({} as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      asNeeded: false,
      schedules: [{ id: "s1" }],
    } as never);
    const res = await PUT(
      putReq({
        asNeeded: false,
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const updateData = vi.mocked(prisma.medication.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(updateData.data.asNeeded).toBe(false);
  });

  it("archives an EMPTY era for the as-needed stretch on the flip back", async () => {
    // Without the empty revision the live era would start at the previous
    // revision boundary (or createdAt) and the NEW schedule's slots would
    // retro-paint every schedule-less as-needed day as missed.
    mockExisting({ asNeeded: true, scheduleCount: 0 });
    vi.mocked(getMedicationCategories).mockResolvedValue({} as never);
    const previousBoundary = new Date("2026-05-01T08:00:00Z");
    vi.mocked(prisma.medicationScheduleRevision.findFirst).mockResolvedValue({
      validUntil: previousBoundary,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      asNeeded: false,
      schedules: [{ id: "s1" }],
    } as never);
    const res = await PUT(
      putReq({
        asNeeded: false,
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationScheduleRevision.create).toHaveBeenCalledTimes(1);
    const createArg = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls[0][0] as {
      data: { payload: unknown; validFrom: Date; validUntil: Date };
    };
    expect(createArg.data.payload).toEqual([]);
    expect(createArg.data.validFrom).toEqual(previousBoundary);
    expect(createArg.data.validUntil).toBeInstanceOf(Date);
  });

  it("does NOT archive an era when a scheduled medication replaces schedules from zero rows", async () => {
    // A non-as-needed medication with no previous rows (fresh create path)
    // keeps the v1.16.3 behaviour: nothing to archive.
    mockExisting({ asNeeded: false, scheduleCount: 0 });
    vi.mocked(getMedicationCategories).mockResolvedValue({} as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      asNeeded: false,
      schedules: [{ id: "s1" }],
    } as never);
    const res = await PUT(
      putReq({
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
  });

  it("422s an empty schedules array WITHOUT asNeeded:true (Zod)", async () => {
    mockExisting({ scheduleCount: 1 });
    const res = await PUT(putReq({ schedules: [] }), ROUTE_CTX);
    expect(res.status).toBe(422);
    expect(prisma.medication.update).not.toHaveBeenCalled();
  });
});

describe("PUT /api/medications/[id] — intake tracking switch (#1033)", () => {
  const LIVE_ROW = {
    id: "s1",
    medicationId: "m1",
    windowStart: "08:00",
    windowEnd: "08:00",
    label: null,
    dose: null,
    daysOfWeek: null,
    timesOfDay: ["08:00"],
    reminderGraceMinutes: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
  };

  function arrange(trackIntake: boolean) {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      active: true,
      asNeeded: false,
      trackIntake,
      createdAt: new Date("2026-05-01T08:00:00.000Z"),
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({
      id: "m1",
      userId: "user-1",
      trackIntake: !trackIntake,
      unitsPerDose: 1,
      schedules: [{ ...LIVE_ROW, unitsPerDose: null }],
    } as never);
    vi.mocked(getMedicationCategories).mockResolvedValue({});
    vi.mocked(auditLog).mockResolvedValue(undefined);
    vi.mocked(dayKeyForScheduledFor).mockReturnValue("2026-06-10");
    vi.mocked(recomputeMedicationComplianceForDay).mockResolvedValue(undefined);
    vi.mocked(prisma.medicationSchedule.findMany).mockResolvedValue([
      LIVE_ROW,
    ] as never);
    vi.mocked(prisma.medicationScheduleRevision.create).mockClear();
    vi.mocked(prisma.medicationIntakeEvent.updateMany).mockClear();
    vi.mocked(prisma.medication.update).mockClear();
  }

  it("switching off archives the schedule in force and tombstones open slots", async () => {
    arrange(true);
    const res = await PUT(putReq({ trackIntake: false }), ROUTE_CTX);
    expect(res.status).toBe(200);

    // The tracked stretch keeps its expected doses: the archived era
    // carries the live schedule and ends now.
    const revisions = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls;
    expect(revisions).toHaveLength(1);
    const era = revisions[0][0].data as {
      payload: Array<{ timesOfDay: string[] }>;
      validFrom: Date;
    };
    expect(era.payload).toHaveLength(1);
    expect(era.payload[0].timesOfDay).toEqual(["08:00"]);
    expect(era.validFrom.toISOString()).toBe("2026-05-01T08:00:00.000Z");

    // Open placeholders of today and later go; actioned rows never do.
    const tombstones = vi.mocked(prisma.medicationIntakeEvent.updateMany).mock
      .calls;
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0][0].where).toMatchObject({
      medicationId: "m1",
      takenAt: null,
      skipped: false,
      autoMissed: false,
      deletedAt: null,
    });

    // The flag is written field-by-field; the schedule rows are kept.
    const update = vi.mocked(prisma.medication.update).mock.calls[0][0];
    expect(update.data).toMatchObject({ trackIntake: false });
    expect(update.data).not.toHaveProperty("schedules");
    expect(prisma.medicationSchedule.deleteMany).not.toHaveBeenCalledWith({
      where: { medicationId: "m1" },
    });

    // The wire serves it like an as-needed medication, schedule on record.
    const body = (await res.json()) as {
      data: { schedules: unknown[]; recordedSchedules?: unknown[] };
    };
    expect(body.data.schedules).toEqual([]);
    expect(body.data.recordedSchedules).toHaveLength(1);
  });

  it("switching back on archives the untracked stretch as expecting nothing", async () => {
    arrange(false);
    const res = await PUT(putReq({ trackIntake: true }), ROUTE_CTX);
    expect(res.status).toBe(200);
    const revisions = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls;
    expect(revisions).toHaveLength(1);
    const era = revisions[0][0].data as { payload: unknown[] };
    // No retroactive misses: the stretch that was off expected no dose.
    expect(era.payload).toEqual([]);
    // Nothing is tombstoned on the way back on.
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      data: { schedules: unknown[]; recordedSchedules?: unknown[] };
    };
    expect(body.data.schedules).toHaveLength(1);
    expect(body.data).not.toHaveProperty("recordedSchedules");
  });

  it("an unchanged flag archives nothing", async () => {
    arrange(true);
    const res = await PUT(putReq({ trackIntake: true }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medicationScheduleRevision.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.updateMany).not.toHaveBeenCalled();
  });

  it("a schedule edit while untracked archives the stretch as empty", async () => {
    arrange(false);
    const res = await PUT(
      putReq({
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "08:00",
            timesOfDay: ["08:00"],
            rrule: "FREQ=DAILY",
          },
        ],
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    const era = vi.mocked(prisma.medicationScheduleRevision.create).mock
      .calls[0][0].data as { payload: unknown[] };
    expect(era.payload).toEqual([]);
  });
});
