/**
 * v1.4.37 W3 — GET /api/medications/[id]/intake `status` filter tests.
 *
 * Pins the contract added to fix the v1.4.36 regression where
 * `IntakeHistoryListV2` rendered rows with `takenAt:null AND
 * skipped:false` as "Eingenommen". The route now accepts an optional
 * `status` query param:
 *
 *  - default (`status:"all"`) keeps the byte-stable contract for the
 *    iOS Swift client and the dashboard tiles already on the wire.
 *  - `status:"completed"` — taken OR skipped — is what the
 *    detail-page list passes so ambiguous "missed / unconfirmed"
 *    rows stay out of the user-facing table.
 *  - `status:"taken"` / `status:"skipped"` cover the two single-arm
 *    branches future surfaces may need.
 *
 * The route-level guard (404 on cross-user reads) is exercised by
 * the shared `assertMedicationOwnership` test suite — this file only
 * cares about the Prisma `where` fragment derived from the new knob.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findUnique: vi.fn(),
      // v1.8.2 — the slot-snap resolver loads the medication via
      // findFirst; default to a schedule-less med so the resolver returns
      // null (unscheduled path) and the original insert behaviour holds.
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      // v1.8.2 reconcile — the shared slot upsert updates in place.
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/idempotency", () => ({
  withIdempotency:
    <Args extends unknown[]>(fn: (...args: Args) => Promise<Response>) =>
    (...args: Args) =>
      fn(...args),
}));

vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));

vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

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

// (#22) — silent cross-device intake sync. Mocked so the route test can
// assert the hook fires without reaching the APNs senders or the
// coalescing timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

import { GET, POST } from "../route";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    // Pin the user timezone so slot-instant resolution is deterministic
    // regardless of the host TZ (CI runs in UTC, local in Europe/Berlin).
    timezone: "Europe/Berlin",
  },
};

const MED_OK = { id: "med-1", userId: "user-1" };

function makeRequest(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/med-1/intake?${query}`,
  );
}

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

beforeEach(() => {
  vi.resetAllMocks();
  // v1.36.0 — the GET's validation breadcrumb goes through the `auditLog`
  // helper, whose promise the route attaches a `.catch` to. `resetAllMocks`
  // clears the factory's implementation, so it is restored here.
  vi.mocked(auditLog).mockResolvedValue(undefined);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
  // v1.4.43 W6 — default the audit-row write to resolve.
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/medications/[id]/intake — status filter", () => {
  it("applies no status filter when `status` is omitted (back-compat)", async () => {
    const res = await GET(makeRequest("limit=25&offset=0"), ROUTE_PARAMS);
    expect(res.status).toBe(200);

    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    // v1.7.0 sync — list filters out tombstoned rows.
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
    });
  });

  it("applies no status filter when explicitly passed `status=all`", async () => {
    const res = await GET(
      makeRequest("limit=25&offset=0&status=all"),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);

    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
    });
  });

  it("filters to confirmed-taken rows for `status=taken`", async () => {
    await GET(makeRequest("status=taken"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
      takenAt: { not: null },
      skipped: false,
    });
  });

  it("filters to skipped rows for `status=skipped`", async () => {
    await GET(makeRequest("status=skipped"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
      skipped: true,
    });
  });

  it("filters to taken-or-skipped rows for `status=completed` (the detail-page contract)", async () => {
    await GET(makeRequest("status=completed"), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
      OR: [{ takenAt: { not: null }, skipped: false }, { skipped: true }],
    });
  });

  it("orders on a unique tiebreaker, keeping NULLS LAST on the takenAt arm", async () => {
    // Scheduled slots share an instant by construction — a twice-daily
    // medication puts every morning dose on the same `scheduledFor` — so
    // offset paging over the sort key alone can repeat a row on one page and
    // drop another. The `takenAt` arm keeps its NULLS LAST pin as well: the
    // tiebreaker must not push skipped rows back to the top.
    await GET(makeRequest("sortBy=takenAt&sortDir=desc"), ROUTE_PARAMS);
    expect(
      vi.mocked(prisma.medicationIntakeEvent.findMany).mock.calls[0][0]
        ?.orderBy,
    ).toEqual([{ takenAt: { sort: "desc", nulls: "last" } }, { id: "desc" }]);

    vi.mocked(prisma.medicationIntakeEvent.findMany).mockClear();

    await GET(makeRequest("sortBy=scheduledFor&sortDir=asc"), ROUTE_PARAMS);
    expect(
      vi.mocked(prisma.medicationIntakeEvent.findMany).mock.calls[0][0]
        ?.orderBy,
    ).toEqual([{ scheduledFor: "asc" }, { id: "asc" }]);
  });

  it("rejects unknown status values with a 422", async () => {
    const res = await GET(makeRequest("status=junk"), ROUTE_PARAMS);
    expect(res.status).toBe(422);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("propagates the `status` value to the count call so totals match the visible page", async () => {
    await GET(makeRequest("status=completed"), ROUTE_PARAMS);
    const countArgs = vi.mocked(prisma.medicationIntakeEvent.count).mock
      .calls[0][0];
    expect(countArgs?.where).toEqual({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
      OR: [{ takenAt: { not: null }, skipped: false }, { skipped: true }],
    });
  });
});

describe("v1.4.43 W6 — multi-issue 422 envelope", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/med-1/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("GET surfaces TWO simultaneous validation errors", async () => {
    const res = await GET(
      makeRequest("status=junk&sortBy=garbage"),
      ROUTE_PARAMS,
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

  it("POST surfaces TWO simultaneous validation errors", async () => {
    // Schema requires takenAt iso + skipped boolean.
    const res = await POST(
      postReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("POST surfaces THREE simultaneous validation errors", async () => {
    const res = await POST(
      postReq({
        takenAt: "not-iso",
        skipped: "string",
        scheduledFor: "also-not-iso",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes audit-ledger rows for both GET and POST validation failures", async () => {
    await GET(makeRequest("status=junk"), ROUTE_PARAMS);
    await POST(postReq({ takenAt: "junk" }), ROUTE_PARAMS);
    await new Promise((r) => setTimeout(r, 5));
    // v1.36.x — both breadcrumbs go through the `auditLog` helper, the only
    // writer that stamps `actorUserId`. The POST arm is a delegable write now,
    // so a row it files without the stamp would read as the owner's own.
    expect(auditLog).toHaveBeenCalledWith(
      "medications.intake.list.validation-failed",
      expect.objectContaining({ userId: "user-1" }),
    );
    expect(auditLog).toHaveBeenCalledWith(
      "medications.intake.create.validation-failed",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("POST does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(postReq({ takenAt: "junk" }), ROUTE_PARAMS);
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.5.0 — POST intake on a one-shot medication still deactivates
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/[id]/intake — one-shot lifecycle", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/med-1/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("flips active to false after logging a live intake on a one-shot medication", async () => {
    const createdEvent = {
      id: "evt-1",
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: new Date(),
      takenAt: new Date(),
      skipped: false,
    };
    vi.mocked(prisma.$transaction).mockResolvedValue([createdEvent] as never);
    // v1.8.2 — slot-snap resolver loads the med; no schedules → null slot
    // → original insert + dedup path preserved.
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: true,
      createdAt: new Date(),
      schedules: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never, // dedup probe
    );
    // Reconcile probes — first call is the medication shape, second is
    // the live-intake probe (a live intake exists because the POST just
    // created one), and the update fires with active:false.
    vi.mocked(prisma.medication.findUnique).mockResolvedValueOnce({
      oneShot: true,
      active: true,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce({
      id: "evt-1",
    } as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);

    const res = await POST(
      postReq({ takenAt: new Date().toISOString(), skipped: false }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(201);

    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "med-1", userId: "user-1", oneShot: true },
      data: { active: false },
    });

    // (#22) — the logged dose queues exactly one cross-device sync
    // fan-out; the web caller carries no X-Device-Id.
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
    expect(queueMedicationIntakeSync).toHaveBeenCalledWith({
      userId: "user-1",
      originDeviceToken: null,
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.8.2 reconcile — slot-snap upsert invariants through the route
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/[id]/intake — v1.8.2 reconcile (M2 inventory)", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/med-1/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A scheduled med (07:00 / 19:00) so the resolver returns a canonical
  // slot and the write routes through the shared upsert.
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
    // Pin the clock past the 07:00 / 19:00 CEST slots of 2026-06-15 so the
    // dose-safety future-slot guard treats these taken writes as landing on
    // a current/past slot. Otherwise the fixtures sit days ahead of the
    // real test clock and the guard refuses to snap a taken write forward.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT decrement inventory on a re-post of an already-taken slot (M2)", async () => {
    const { consumeForIntake } =
      await import("@/lib/medications/inventory/consumption");
    // Resolver load → scheduled med.
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(
      SCHEDULED_MED as never,
    );
    // Slot find (shared upsert) → an existing TAKEN row at the 07:00 slot.
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
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-taken",
      takenAt: new Date("2026-06-15T05:02:00Z"),
      skipped: false,
      scheduledFor: new Date("2026-06-15T05:00:00Z"),
      source: "WEB",
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
    // Reconcile probes (non-one-shot → noop).
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);

    const res = await POST(
      postReq({
        scheduledFor: "2026-06-15T05:00:30.000Z",
        takenAt: "2026-06-15T05:02:00.000Z",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(201);
    // Re-post of an already-taken slot → no pending→taken transition →
    // inventory must NOT be consumed.
    expect(consumeForIntake).not.toHaveBeenCalled();
    // The row was updated, not duplicated.
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("DOES decrement inventory on a genuine pending→taken move (M2)", async () => {
    const { consumeForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(
      SCHEDULED_MED as never,
    );
    // Slot find → a PENDING REMINDER row (no takenAt).
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
      takenAt: new Date("2026-06-15T05:02:00Z"),
      skipped: false,
      scheduledFor: new Date("2026-06-15T05:00:00Z"),
      source: "REMINDER",
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);

    const res = await POST(
      postReq({
        scheduledFor: "2026-06-15T05:00:30.000Z",
        takenAt: "2026-06-15T05:02:00.000Z",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(201);
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        eventId: "row-pending",
      }),
    );
  });

  it("re-finds and updates the slot when the create races a P2002 (C1)", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(
      SCHEDULED_MED as never,
    );
    // First slot find → empty. Create throws P2002. Re-find → the racing
    // pending row. Update applies the taken write onto it.
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
      takenAt: new Date("2026-06-15T05:02:00Z"),
      skipped: false,
      scheduledFor: new Date("2026-06-15T05:00:00Z"),
      source: "REMINDER",
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);

    const res = await POST(
      postReq({
        scheduledFor: "2026-06-15T05:00:30.000Z",
        takenAt: "2026-06-15T05:02:00.000Z",
      }),
      ROUTE_PARAMS,
    );
    // The dose tap is NOT dropped — converges to the racing row, 201.
    expect(res.status).toBe(201);
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "row-raced" } }),
    );
  });

  it("does not treat a different occurrence, sibling, or archived row as an already-taken exact slot", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce(
      SCHEDULED_MED as never,
    );
    // The shared write probe must be scoped to the exact medication,
    // canonical occurrence, and live row. An action at 07:00, on a sibling
    // medication, or in an archived/tombstoned era is therefore not a
    // candidate for this 19:00 write.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-evening-distinct",
      takenAt: new Date("2026-06-15T17:02:00Z"),
      skipped: false,
      idempotencyKey: "evening-distinct",
      scheduledFor: new Date("2026-06-15T17:00:00Z"),
      source: "WEB",
      createdAt: new Date("2026-06-15T17:02:00Z"),
    } as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);

    const res = await POST(
      postReq({
        scheduledFor: "2026-06-15T17:00:30.000Z",
        takenAt: "2026-06-15T17:02:00.000Z",
        idempotencyKey: "evening-distinct",
      }),
      ROUTE_PARAMS,
    );

    expect(res.status).toBe(201);
    expect(prisma.medicationIntakeEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          medicationId: "med-1",
          scheduledFor: new Date("2026-06-15T17:00:00.000Z"),
          deletedAt: null,
        },
      }),
    );
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.16.11 (#316) — as-needed (PRN, schedule-less) intakes
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/[id]/intake — as-needed (schedule-less) medication", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/med-1/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("records an ad-hoc row (scheduledFor = takenAt) and consumes inventory", async () => {
    // One hour in the past — relative instant, no slot semantics.
    const takenAt = new Date(Date.now() - 60 * 60 * 1000);
    const createdEvent = {
      id: "evt-prn-1",
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: takenAt,
      takenAt,
      skipped: false,
    };
    vi.mocked(prisma.$transaction).mockResolvedValue([createdEvent] as never);
    // Slot-snap resolver loads the med: an as-needed medication carries
    // ZERO schedules, so band attribution yields no slot → standalone
    // ad-hoc insert (the documented PRN path).
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      schedules: [],
    } as never);
    // Dedup probe — no recent duplicate.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never,
    );
    // One-shot reconcile probe — not a one-shot.
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      oneShot: false,
      active: true,
    } as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(
      postReq({ takenAt: takenAt.toISOString(), skipped: false }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(201);

    // Standalone insert anchored on the intake instant — the ad-hoc
    // contract (`scheduledFor = takenAt`), no slot attribution.
    const txArg = vi.mocked(prisma.$transaction).mock.calls[0][0];
    expect(Array.isArray(txArg)).toBe(true);

    // Inventory consumption fires exactly as for a scheduled medication —
    // the seam is medication-level (eventId + intakeAt), no schedule input.
    const { consumeForIntake } =
      await import("@/lib/medications/inventory/consumption");
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        eventId: "evt-prn-1",
        intakeAt: takenAt,
      }),
    );
  });

  it("a skipped ad-hoc write never consumes", async () => {
    const skipEvent = {
      id: "evt-prn-2",
      userId: "user-1",
      medicationId: "med-1",
      scheduledFor: new Date(),
      takenAt: null,
      skipped: true,
    };
    vi.mocked(prisma.$transaction).mockResolvedValue([skipEvent] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      schedules: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      oneShot: false,
      active: true,
    } as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(postReq({ skipped: true }), ROUTE_PARAMS);
    expect(res.status).toBe(201);

    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/medications/[id]/intake — idempotency-key stability floor", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/med-1/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /**
   * `MedicationIntakeEvent.idempotency_key` is a `@unique` column
   * persisted with the dose row forever and matched by plain equality —
   * an identity, not a windowed replay token. A caller minting a
   * per-process key never matches its own earlier post, so a retried
   * submission logs the dose a second time.
   */
  it("422s on an object-description key and records no dose", async () => {
    const res = await POST(
      postReq({
        takenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        idempotencyKey: "<NSObject: 0x600000c1a2b0>",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    const issue = body.details.issues.find((i) => i.path === "idempotencyKey");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("idempotency key");
    expect(issue!.message).toContain("stable across app restarts");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("422s on a bare memory-address key", async () => {
    const res = await POST(
      postReq({
        takenAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        idempotencyKey: "0x126b25160",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts a stable caller-issued key and records the dose", async () => {
    const takenAt = new Date(Date.now() - 60 * 60 * 1000);
    vi.mocked(prisma.$transaction).mockResolvedValue([
      {
        id: "evt-idem-1",
        userId: "user-1",
        medicationId: "med-1",
        scheduledFor: takenAt,
        takenAt,
        skipped: false,
      },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValueOnce({
      id: "med-1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      schedules: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never,
    );
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      oneShot: false,
      active: true,
    } as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValue({
      count: 0,
    } as never);

    const res = await POST(
      postReq({
        takenAt: takenAt.toISOString(),
        idempotencyKey: "ios-outbox-8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
      }),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(201);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
