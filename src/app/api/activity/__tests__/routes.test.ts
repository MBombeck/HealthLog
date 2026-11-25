/**
 * `/api/activity/calendar` and `/api/activity/goals` (D1036).
 *
 * The goals: a PATCH replaces only what it names, `null` clears, an unknown
 * key or a goal out of bounds is a 422 and writes nothing, and clearing the
 * last goal returns the column to NULL rather than storing an empty object.
 * The calendar: the module gate answers before any read, a future or malformed
 * day is refused, and the reader is asked for exactly the window the period
 * needs and never past today.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  readActivityDays: vi.fn(),
  requireModuleEnabled: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock("@/lib/api-handler", () => ({
  apiHandler: (handler: unknown) => handler,
  requireAuth: vi.fn(async () => ({ user: { id: "user-1" } })),
  requireRecordAuth: vi.fn(async () => ({
    user: { id: "user-1" },
    actor: { id: "user-1" },
    grantId: null,
  })),
}));
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({ auditLog: mocks.auditLog }));
vi.mock("@/lib/db", () => {
  // The goals PATCH reads and writes inside a row-locked transaction; the
  // transaction client is the same mocked user model.
  const tx = {
    user: { findUnique: mocks.findUnique, update: mocks.update },
    $queryRaw: vi.fn(async () => []),
  };
  return {
    prisma: {
      ...tx,
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    },
    toJson: (v: unknown) => v,
  };
});
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: mocks.requireModuleEnabled,
}));
vi.mock("@/lib/activity/calendar-read", () => ({
  readActivityDays: mocks.readActivityDays,
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));

import { Prisma } from "@/generated/prisma/client";
import { GET as calendarGet } from "../calendar/route";
import { GET as goalsGet, PATCH as goalsPatch } from "../goals/route";

type Handler = (req: NextRequest) => Promise<Response>;

function patch(body: unknown) {
  return (goalsPatch as unknown as Handler)(
    new NextRequest("http://localhost/api/activity/goals", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function calendar(query: string) {
  return (calendarGet as unknown as Handler)(
    new NextRequest(`http://localhost/api/activity/calendar${query}`),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue({
    activityGoalsJson: { workoutsPerWeek: 3, stepsPerWeek: 50000 },
  });
  mocks.update.mockResolvedValue({});
  mocks.requireModuleEnabled.mockResolvedValue({ enabled: true });
  mocks.readActivityDays.mockResolvedValue({ days: [], loadType: null });
});

describe("activity goals", () => {
  it("reads every goal, unset ones as null", async () => {
    const res = await (goalsGet as unknown as () => Promise<Response>)();
    const body = await res.json();
    expect(body.data).toEqual({
      workoutsPerWeek: 3,
      activeMinutesPerWeek: null,
      stepsPerWeek: 50000,
      stepsPerMonth: null,
    });
  });

  it("changes what the body names and keeps the rest", async () => {
    const res = await patch({ stepsPerWeek: null, stepsPerMonth: 250000 });
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        activityGoalsJson: {
          workoutsPerWeek: 3,
          activeMinutesPerWeek: null,
          stepsPerWeek: null,
          stepsPerMonth: 250000,
        },
      },
    });
    expect(mocks.auditLog).toHaveBeenCalledWith(
      "activity.goals.update",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("stores NULL once the last goal is cleared", async () => {
    await patch({ workoutsPerWeek: null, stepsPerWeek: null });
    expect(mocks.update.mock.calls[0][0].data.activityGoalsJson).toBe(
      Prisma.DbNull,
    );
  });

  it.each([
    [{ caloriesPerWeek: 3000 }],
    [{ workoutsPerWeek: 0 }],
    [{ stepsPerWeek: 2.5 }],
    [{ stepsPerMonth: "200000" }],
  ])("refuses %j without writing", async (body) => {
    const res = await patch(body);
    expect(res.status).toBe(422);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("activity calendar", () => {
  it("answers the module gate before reading anything", async () => {
    mocks.requireModuleEnabled.mockResolvedValue({
      enabled: false,
      response: new Response(null, { status: 403 }),
    });
    const res = await calendar("?period=month");
    expect(res.status).toBe(403);
    expect(mocks.readActivityDays).not.toHaveBeenCalled();
  });

  it.each(["?period=year", "?date=2026-13-01", "?date=yesterday"])(
    "refuses %s",
    async (q) => {
      const res = await calendar(q);
      expect(res.status).toBe(422);
    },
  );

  it("refuses a day after today", async () => {
    const res = await calendar("?date=2999-01-01");
    expect(res.status).toBe(422);
    expect(mocks.readActivityDays).not.toHaveBeenCalled();
  });

  it("reads the baseline window before the period and nothing past the grid", async () => {
    const res = await calendar("?period=week&date=2025-03-12");
    expect(res.status).toBe(200);
    const args = mocks.readActivityDays.mock.calls[0][0];
    // Week of Monday 2025-03-10; 84 days before it.
    expect(args.fromKey).toBe("2024-12-16");
    expect(args.toKey).toBe("2025-03-16");
    expect(args.tz).toBe("Europe/Berlin");
    const body = await res.json();
    expect(body.data.start).toBe("2025-03-10");
    expect(body.data.goals.workoutsPerWeek).toBe(3);
    expect(body.data.days).toHaveLength(7);
  });
});
