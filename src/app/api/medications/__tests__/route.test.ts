/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/medications.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn().mockResolvedValue([]),
      // v1.28 — the Apple-mirror idempotency pre-query.
      findFirst: vi.fn().mockResolvedValue(null),
      // v1.32.25 — the mirror growth-guard count.
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(),
    },
    medicationIntakeEvent: {
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([]),
    },
    medicationScheduleRevision: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    medicationInventoryItem: {
      groupBy: vi.fn().mockResolvedValue([]),
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
  cachedSwr: vi.fn(async (_c: unknown, _k: string, f: () => Promise<unknown>) =>
    f(),
  ),
  caches: { medicationsList: {} },
  __resetAllCachesForTests: vi.fn(),
}));
vi.mock("@/lib/medication-category", () => ({
  getMedicationCategories: vi.fn().mockResolvedValue({}),
  setMedicationCategory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/tz/local-day", () => ({
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

import { GET, POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { cachedSwr } from "@/lib/cache/server-cache";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { getMedicationCategories } from "@/lib/medication-category";

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
  // v1.32.25 — default the mirror growth-guard count below the cap so the
  // pre-existing mirror-create tests hit the create path, not the guard.
  vi.mocked(prisma.medication.count).mockResolvedValue(0 as never);
  // Default happy-path stub: return the data shape the caller passed in
  // so test assertions can inspect what the route actually forwarded
  // to Prisma without re-implementing the create-returning DB.
  vi.mocked(prisma.medication.create).mockImplementation((async (args: {
    data: Record<string, unknown>;
  }) => ({
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

describe("GET /api/medications — todayEventCount counts only actioned rows (v1.16.9)", () => {
  it("filters the today-count groupBy to taken-or-skipped rows", async () => {
    // The dashboard projector mints a pending row per slot of the day, so
    // an unfiltered count covered every passed dose after any dashboard
    // visit and the cards' overdue pill went dark. The count read must
    // exclude pending rows.
    // (`vi.resetAllMocks()` in beforeEach clears the factory defaults, so
    // re-wire the pass-through + empty result sets here.)
    vi.mocked(cachedSwr).mockImplementation((async (
      _c: unknown,
      _k: string,
      f: () => Promise<unknown>,
    ) => f()) as never);
    vi.mocked(getUserTodayBounds).mockReturnValue({
      start: new Date("2026-06-10T00:00:00Z"),
      end: new Date("2026-06-10T23:59:59Z"),
    } as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.medicationIntakeEvent.groupBy).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationScheduleRevision.groupBy).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationInventoryItem.groupBy).mockResolvedValue(
      [] as never,
    );
    // The handler body takes no parameters; `apiHandler` still receives
    // the request through the wrapper's rest args.
    const res = await (
      GET as unknown as (req: NextRequest) => Promise<Response>
    )(new NextRequest("http://localhost/api/medications"));
    expect(res.status).toBe(200);

    const groupByCalls = vi.mocked(prisma.medicationIntakeEvent.groupBy).mock
      .calls;
    const countCall = groupByCalls.find(
      (c) => (c[0] as { _count?: unknown })._count !== undefined,
    );
    expect(countCall).toBeDefined();
    const where = (
      countCall![0] as {
        where: { OR?: unknown };
      }
    ).where;
    expect(where.OR).toEqual([{ takenAt: { not: null } }, { skipped: true }]);
  });
});

describe("POST /api/medications — as-needed (v1.16.11, #316)", () => {
  function lastCreateData(): Record<string, unknown> & {
    schedules: { create: Record<string, unknown>[] };
  } {
    const calls = vi.mocked(prisma.medication.create).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][0] as { data: never }).data;
  }

  it("422s when asNeeded:true carries a schedules array", async () => {
    const res = await POST(
      postReq({
        name: "Ibuprofen",
        dose: "400 mg",
        asNeeded: true,
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(
      body.details.issues.some((i) =>
        i.message.includes("as-needed medication cannot carry schedules"),
      ),
    ).toBe(true);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("422s when asNeeded:true is combined with oneShot:true", async () => {
    const res = await POST(
      postReq({
        name: "Ibuprofen",
        dose: "400 mg",
        asNeeded: true,
        oneShot: true,
        startsOn: "2026-06-01",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ message: string }> };
    };
    expect(
      body.details.issues.some((i) => i.message.includes("mutually exclusive")),
    ).toBe(true);
  });

  it("creates an as-needed medication with ZERO schedules", async () => {
    const res = await POST(
      postReq({
        name: "Ibuprofen",
        dose: "400 mg",
        category: "PAIN_RELIEF",
        unitsPerDose: 2,
        asNeeded: true,
      }),
    );
    expect(res.status).toBe(201);
    const data = lastCreateData();
    expect(data.asNeeded).toBe(true);
    expect(data.oneShot).toBeUndefined();
    expect(data.schedules.create).toEqual([]);
    // Dose fields stay first-class — they feed inventory consumption.
    expect(data.unitsPerDose).toBe(2);
  });

  // #1034 — a whole number plus a fraction reaches the Prisma write
  // unchanged, on the medication and on a per-slot override; a value with
  // a fifth decimal place is refused before any write.
  it("creates a medication with a mixed units-per-dose value", async () => {
    const res = await POST(
      postReq({
        name: "Ibuprofen",
        dose: "400 mg",
        category: "PAIN_RELIEF",
        unitsPerDose: 1.5,
        asNeeded: true,
      }),
    );
    expect(res.status).toBe(201);
    expect(lastCreateData().unitsPerDose).toBe(1.5);
  });

  it("422s a units-per-dose value with more than four decimal places", async () => {
    const res = await POST(
      postReq({
        name: "Ibuprofen",
        dose: "400 mg",
        category: "PAIN_RELIEF",
        unitsPerDose: 1.23456,
        asNeeded: true,
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: Array<string | number> }> };
    };
    expect(
      body.details.issues.some((i) => i.path.includes("unitsPerDose")),
    ).toBe(true);
  });

  it("still 422s a scheduled create without any schedule (legacy contract)", async () => {
    const res = await POST(postReq({ name: "Ramipril", dose: "5 mg" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(body.details.issues.some((i) => i.path.includes("schedules"))).toBe(
      true,
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.28 — Apple Health mirrored medications (#423)
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications — Apple Health mirror (v1.28)", () => {
  const MIRROR_BODY = {
    name: "Ramipril",
    dose: "5 mg",
    externalSource: "APPLE_HEALTH",
    externalId: "hk-concept-1",
    schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
  };

  function lastCreateData(): Record<string, unknown> {
    const calls = vi.mocked(prisma.medication.create).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][0] as { data: Record<string, unknown> })
      .data;
  }

  it("admits a scheduled Apple Health mirror without a HealthLog-owned schedule", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medication.count).mockResolvedValue(0 as never);

    const res = await POST(
      postReq({
        name: "Telmisartan",
        dose: "1 count",
        externalSource: "APPLE_HEALTH",
        externalId: "hk-concept-scheduled",
        asNeeded: false,
      }),
    );

    expect(res.status).toBe(201);
    const data = lastCreateData();
    expect(data.externalSource).toBe("APPLE_HEALTH");
    expect(data.externalId).toBe("hk-concept-scheduled");
    expect(data.asNeeded).toBe(false);
    expect(data.schedules).toEqual({ create: [] });
  });

  it("persists externalSource + externalId field-by-field on create", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(201);
    const data = lastCreateData();
    expect(data.externalSource).toBe("APPLE_HEALTH");
    expect(data.externalId).toBe("hk-concept-1");
    // The pre-query probed the mirror triple, user-scoped.
    expect(prisma.medication.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          externalSource: "APPLE_HEALTH",
          externalId: "hk-concept-1",
        },
      }),
    );
  });

  it("returns the EXISTING medication (200) on a re-post of the same triple — no duplicate row", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "med-existing",
      userId: "user-1",
      name: "Ramipril",
      dose: "5 mg",
      unitsPerDose: 1,
      externalSource: "APPLE_HEALTH",
      externalId: "hk-concept-1",
      schedules: [],
    } as never);

    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; externalId: string; category: string };
    };
    expect(body.data.id).toBe("med-existing");
    expect(body.data.externalId).toBe("hk-concept-1");
    expect(body.data.category).toBe("OTHER");
    // Idempotent replay: nothing written.
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("resolves a concurrent P2002 race on the mirror triple to the winning row (200)", async () => {
    // Pre-query misses; the create then loses the race against a
    // concurrent mirror of the same concept id.
    vi.mocked(prisma.medication.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({
        id: "med-winner",
        userId: "user-1",
        name: "Ramipril",
        dose: "5 mg",
        unitsPerDose: 1,
        externalSource: "APPLE_HEALTH",
        externalId: "hk-concept-1",
        schedules: [],
      } as never);
    vi.mocked(prisma.medication.create).mockRejectedValueOnce(
      Object.assign(new Error("unique"), { code: "P2002" }),
    );

    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("med-winner");
  });

  it("422s when externalSource is supplied without externalId", async () => {
    const res = await POST(postReq({ ...MIRROR_BODY, externalId: undefined }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(
      body.details.issues.some((i) =>
        i.message.includes("must be supplied together"),
      ),
    ).toBe(true);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("422s when externalId is supplied without externalSource", async () => {
    const res = await POST(
      postReq({ ...MIRROR_BODY, externalSource: undefined }),
    );
    expect(res.status).toBe(422);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("422s on a non-Apple externalSource value (server-owned sources stay closed)", async () => {
    const res = await POST(postReq({ ...MIRROR_BODY, externalSource: "WEB" }));
    expect(res.status).toBe(422);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  /**
   * The mirror's idempotency is only as good as the stability of the
   * concept id. A client that serialised an opaque platform object with
   * its default description sent `<HKHealthConceptIdentifier: 0x…>` — a
   * memory address that changes on every launch — and a live instance
   * grew 23 phantom medications in a day, one per sync sweep, none of
   * which could ever collect a dose. The create refuses that shape now.
   */
  it("422s on an object-description externalId instead of minting a phantom mirror", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    const res = await POST(
      postReq({
        ...MIRROR_BODY,
        externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    const issue = body.details.issues.find((i) => i.path === "externalId");
    expect(issue).toBeDefined();
    // The client developer has to be able to act on this without asking.
    expect(issue!.message).toContain("stable across app restarts");
    expect(issue!.message).toContain("object description");
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("422s on a bare memory-address externalId", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    const res = await POST(
      postReq({ ...MIRROR_BODY, externalId: "0xdeadbeef" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(
      body.details.issues.some(
        (i) => i.path === "externalId" && i.message.includes("memory address"),
      ),
    ).toBe(true);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("still accepts the stable concept-id shapes the mirror really sends", async () => {
    for (const externalId of [
      "hk-concept-1",
      "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
      "a3f5c9e1b7d2486fa0c3e5b7d9f1a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6",
    ]) {
      vi.mocked(prisma.medication.create).mockClear();
      vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
      const res = await POST(postReq({ ...MIRROR_BODY, externalId }));
      expect(res.status).toBe(201);
      expect(lastCreateData().externalId).toBe(externalId);
    }
  });

  it("a plain create keeps today's behavior — no external columns forwarded", async () => {
    const res = await POST(
      postReq({
        name: "Ramipril",
        dose: "5 mg",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(201);
    const data = lastCreateData();
    expect("externalSource" in data).toBe(false);
    expect("externalId" in data).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.32.25 — mirror growth guard + provenance echo
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications — mirror growth guard (v1.32.25)", () => {
  const MIRROR_BODY = {
    name: "Blutdruckmittel",
    dose: "1",
    externalSource: "APPLE_HEALTH",
    externalId: "hk-concept-new",
    asNeeded: true,
  };

  it("refuses a NEW mirror create (422) once the user already holds the cap", async () => {
    // Idempotency miss (genuinely new row) + user already at 30 mirrors.
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medication.count).mockResolvedValue(30 as never);

    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      meta: { errorCode: string };
    };
    expect(body.meta.errorCode).toBe("medications.mirror.limit_exceeded");
    // Nothing minted — the guard blocks the write.
    expect(prisma.medication.create).not.toHaveBeenCalled();
    // The count was scoped to the user's Apple-Health mirrors.
    expect(prisma.medication.count).toHaveBeenCalledWith({
      where: { userId: "user-1", externalSource: "APPLE_HEALTH" },
    });
  });

  it("still returns 200 for an idempotent re-post of an EXISTING mirror while at the cap — the guard never blocks a replay", async () => {
    // Even at/over the cap, a re-post of a mirror the user already holds
    // must resolve to the existing row (200), because the idempotency
    // lookup HITS before the growth guard runs.
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "med-existing",
      userId: "user-1",
      name: "Blutdruckmittel",
      dose: "1",
      unitsPerDose: 1,
      externalSource: "APPLE_HEALTH",
      externalId: "hk-concept-new",
      schedules: [],
    } as never);
    vi.mocked(prisma.medication.count).mockResolvedValue(50 as never);

    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe("med-existing");
    // Replay: neither the guard count nor a write ran.
    expect(prisma.medication.count).not.toHaveBeenCalled();
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it("does not gate a native create (no externalSource) even while at the cap", async () => {
    // A native medication has no external provenance, so the guard branch
    // is never entered — the count query must not even run.
    vi.mocked(prisma.medication.count).mockResolvedValue(999 as never);

    const res = await POST(
      postReq({
        name: "Ramipril",
        dose: "5 mg",
        schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.medication.count).not.toHaveBeenCalled();
    expect(prisma.medication.create).toHaveBeenCalled();
  });

  it("admits a NEW mirror create below the cap (201)", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medication.count).mockResolvedValue(29 as never);

    const res = await POST(postReq(MIRROR_BODY));
    expect(res.status).toBe(201);
    expect(prisma.medication.create).toHaveBeenCalled();
  });
});

describe("GET /api/medications — provenance echo (v1.32.25)", () => {
  function rewireListRead(medications: unknown[]) {
    vi.mocked(cachedSwr).mockImplementation((async (
      _c: unknown,
      _k: string,
      f: () => Promise<unknown>,
    ) => f()) as never);
    vi.mocked(getUserTodayBounds).mockReturnValue({
      start: new Date("2026-07-24T00:00:00Z"),
      end: new Date("2026-07-24T23:59:59Z"),
    } as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue(
      medications as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.groupBy).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationScheduleRevision.groupBy).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationInventoryItem.groupBy).mockResolvedValue(
      [] as never,
    );
    // `vi.resetAllMocks()` clears the factory default; the list read reads
    // `categoryMap[m.id]` outside its try/catch, so a non-empty row set
    // needs the category map to resolve to an object.
    vi.mocked(getMedicationCategories).mockResolvedValue({});
  }

  it("exposes externalSource on each row: APPLE_HEALTH for a mirror, null for a native med", async () => {
    rewireListRead([
      {
        id: "med-mirror",
        userId: "user-1",
        name: "Blutdruckmittel",
        dose: "1",
        unitsPerDose: 1,
        externalSource: "APPLE_HEALTH",
        externalId: "hk-1",
        createdAt: new Date("2026-07-20T00:00:00Z"),
        startsOn: null,
        endsOn: null,
        oneShot: false,
        schedules: [],
      },
      {
        id: "med-native",
        userId: "user-1",
        name: "Ramipril",
        dose: "5 mg",
        unitsPerDose: 1,
        externalSource: null,
        externalId: null,
        createdAt: new Date("2026-07-19T00:00:00Z"),
        startsOn: null,
        endsOn: null,
        oneShot: false,
        schedules: [],
      },
    ]);

    const res = await (
      GET as unknown as (req: NextRequest) => Promise<Response>
    )(new NextRequest("http://localhost/api/medications"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; externalSource: string | null }>;
    };
    const mirror = body.data.find((m) => m.id === "med-mirror");
    const native = body.data.find((m) => m.id === "med-native");
    expect(mirror?.externalSource).toBe("APPLE_HEALTH");
    expect(native?.externalSource).toBeNull();
  });
});
