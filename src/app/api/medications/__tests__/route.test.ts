/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/medications.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    medicationCategoryAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    medicationSchedule: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
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
vi.mock("@/lib/cache/server-cache", () => ({
  cached: vi.fn(async (_c: unknown, _k: string, f: () => Promise<unknown>) =>
    f(),
  ),
  caches: { medicationsList: {} },
  __resetAllCachesForTests: vi.fn(),
}));
vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn().mockResolvedValue({}),
  setMedicationCategory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/timezone", () => ({
  getUserTodayBounds: vi
    .fn()
    .mockReturnValue({ start: new Date(), end: new Date() }),
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
  return new NextRequest("http://localhost/api/medications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  // Default happy-path stub: return the data shape the caller passed in
  // so test assertions can inspect what the route actually forwarded
  // to Prisma without re-implementing the create-returning DB.
  vi.mocked(prisma.medication.create).mockImplementation((async (
    args: { data: Record<string, unknown> },
  ) => ({
    id: "med-1",
    userId: "user-1",
    ...args.data,
    // Reflect the nested `schedules.create` as a populated array so
    // the include returns the same shape as Prisma.
    schedules: Array.isArray(
      (args.data as { schedules?: { create?: unknown[] } }).schedules?.create,
    )
      ? (
          args.data as {
            schedules: { create: Record<string, unknown>[] };
          }
        ).schedules.create.map((s, i) => ({
          id: `sched-${i}`,
          medicationId: "med-1",
          ...s,
        }))
      : [],
  })) as never);
});

describe("POST /api/medications — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Missing `name` + bad `dose` (e.g. number).
    const res = await POST(postReq({ dose: 42, dosesPerUnit: -1 }));
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
    // name not a string + bad dose + bad dosesPerUnit.
    const res = await POST(
      postReq({ name: 123, dose: 42, dosesPerUnit: "bad" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("POST /api/medications — v1.5 scheduling primitives", () => {
  /**
   * Helper to extract the `data.schedules.create[i]` payload the route
   * forwarded to Prisma.create — that's the single point of truth this
   * test suite cares about.
   */
  function lastCreateCall(): {
    data: Record<string, unknown> & {
      schedules: { create: Record<string, unknown>[] };
    };
  } {
    const calls = vi.mocked(prisma.medication.create).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls[calls.length - 1][0] as never;
  }

  it("(1) one-shot create writes oneShot=true + single timesOfDay schedule", async () => {
    const res = await POST(
      postReq({
        name: "Flu shot",
        dose: "1 shot",
        oneShot: true,
        startsOn: "2026-10-15",
        schedules: [
          { windowStart: "10:00", windowEnd: "10:30", timesOfDay: ["10:00"] },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const call = lastCreateCall();
    expect(call.data.oneShot).toBe(true);
    // endsOn auto-normalised to startsOn for one-shot.
    expect(call.data.endsOn).toBeInstanceOf(Date);
    expect((call.data.endsOn as Date).toISOString()).toEqual(
      (call.data.startsOn as Date).toISOString(),
    );
    const s = call.data.schedules.create[0];
    expect(s.timesOfDay).toEqual(["10:00"]);
    expect(s.rrule).toBeUndefined();
    expect(s.rollingIntervalDays).toBeUndefined();
  });

  it("(2) RRULE schedule is persisted verbatim", async () => {
    const res = await POST(
      postReq({
        name: "Monthly med",
        dose: "1 tab",
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "08:30",
            rrule: "FREQ=MONTHLY;BYMONTHDAY=1",
            timesOfDay: ["08:00"],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const s = lastCreateCall().data.schedules.create[0];
    expect(s.rrule).toBe("FREQ=MONTHLY;BYMONTHDAY=1");
    expect(s.timesOfDay).toEqual(["08:00"]);
  });

  it("(3) rolling schedule is persisted with rollingIntervalDays", async () => {
    const res = await POST(
      postReq({
        name: "Mounjaro",
        dose: "5mg",
        schedules: [
          {
            windowStart: "09:00",
            windowEnd: "09:30",
            rollingIntervalDays: 7,
            timesOfDay: ["09:00"],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const s = lastCreateCall().data.schedules.create[0];
    expect(s.rollingIntervalDays).toBe(7);
    expect(s.rrule).toBeUndefined();
    expect(s.timesOfDay).toEqual(["09:00"]);
  });

  it("(4) 422 when oneShot=true AND schedule carries recurrence", async () => {
    const res = await POST(
      postReq({
        name: "Bad one-shot",
        dose: "1",
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
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/one-shot.*recurrence/i);
  });

  it("(5) 422 when oneShot=true AND multiple schedules", async () => {
    const res = await POST(
      postReq({
        name: "Bad one-shot",
        dose: "1",
        oneShot: true,
        startsOn: "2026-10-15",
        schedules: [
          { windowStart: "08:00", windowEnd: "08:30" },
          { windowStart: "20:00", windowEnd: "20:30" },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/one-shot.*one schedule/i);
  });

  it("(7) legacy POST without new fields back-fills timesOfDay from windowStart", async () => {
    const res = await POST(
      postReq({
        name: "Daily vitamin",
        dose: "1 tab",
        schedules: [
          {
            windowStart: "08:00",
            windowEnd: "09:00",
            daysOfWeek: [1, 2, 3, 4, 5],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const s = lastCreateCall().data.schedules.create[0];
    // timesOfDay populated server-side from windowStart.
    expect(s.timesOfDay).toEqual(["08:00"]);
    // Legacy daysOfWeek serialised; new rrule not stamped because
    // legacy days were supplied.
    expect(s.daysOfWeek).toBe("1,2,3,4,5");
    expect(s.rrule).toBeUndefined();
  });

  it("(7b) legacy POST with no daysOfWeek, no rrule, no rolling → defaults rrule=FREQ=DAILY", async () => {
    const res = await POST(
      postReq({
        name: "Plain daily",
        dose: "1 tab",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(201);
    const s = lastCreateCall().data.schedules.create[0];
    expect(s.rrule).toBe("FREQ=DAILY");
    expect(s.timesOfDay).toEqual(["08:00"]);
  });
});

describe("POST /api/medications — v1.5.4 clinical category extension", () => {
  /**
   * The modal wizard's Step 2 taxonomy adds Diabetes and Antibiotikum
   * as first-class rows. The mapping table writes `category:
   * "DIABETES"` and `category: "ANTIBIOTIC"` to the side-table for
   * those rows instead of collapsing them into `"OTHER"`.
   *
   * The Zod schema accepts the new values; the route's
   * `setMedicationCategory` helper normalises them through
   * `MEDICATION_CATEGORY_VALUES`. The tests below pin that the route
   * accepts both new values without 422-ing.
   */

  it("accepts DIABETES as a valid clinical category", async () => {
    const res = await POST(
      postReq({
        name: "Metformin",
        dose: "500 mg",
        category: "DIABETES",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("accepts ANTIBIOTIC as a valid clinical category", async () => {
    const res = await POST(
      postReq({
        name: "Amoxicillin",
        dose: "500 mg",
        category: "ANTIBIOTIC",
        oneShot: true,
        startsOn: "2026-06-01",
        schedules: [{ windowStart: "08:00", windowEnd: "08:30" }],
      }),
    );
    expect(res.status).toBe(201);
  });

  it("still 422s on an unknown category string", async () => {
    const res = await POST(
      postReq({
        name: "Random",
        dose: "1 tab",
        category: "MYSTERY",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(422);
  });
});
