import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      // v1.4.39 W-SERVER-FIX — `scope=today` now backfills missing
      // rows for schedules whose window opens today (covers daily
      // meds with `daysOfWeek: null` whose reminder hasn't fired yet).
      createMany: vi.fn(),
    },
    medication: {
      update: vi.fn(),
      // v1.4.39 W-SERVER-FIX — today's projection reads active meds +
      // their schedules to know what to backfill.
      findMany: vi.fn(),
    },
    medicationComplianceRollup: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    // v1.4.43 W6 — audit-ledger breadcrumb for validation-failed paths.
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    // v1.4.39 QA F-H-01 — coverage probe + atomic upsert use raw SQL.
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => null,
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.4.34 IW-G — reset compliance LRU between tests so each case
  // observes a cold cache.
  __resetAllCachesForTests();
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  // v1.4.39 W-SERVER-FIX — default the today-projection prisma reads
  // to "no active medications" so existing compliance / POST tests
  // exercise their original paths without an unmocked-call failure.
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
    count: 0,
  } as never);
  // v1.4.39 W-MED — default the coverage probe to "uncovered" so the
  // legacy compliance test still exercises the live-fallback branch
  // and finds the legacy mocked intake events.
  vi.mocked(prisma.medicationComplianceRollup.findFirst).mockResolvedValue(
    null,
  );
  vi.mocked(prisma.medicationComplianceRollup.findMany).mockResolvedValue(
    [] as never,
  );
  // v1.4.39 QA F-H-01 — the coverage probe is now a single `$queryRaw`
  // aggregate returning `{ rolled_days, event_days }`. Default to
  // "zero rollups, zero events" (covered/trivial-empty) so tests that
  // don't care about coverage land on the rollup path.
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { rolled_days: BigInt(0), event_days: BigInt(0) },
  ] as never);
  // v1.4.43 W6 — default the audit-row write to resolve.
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("GET /api/medications/intake", () => {
  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 422 for invalid scope", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=junk"),
    );
    expect(res.status).toBe(422);
  });

  it("returns today's events as a flat array", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "e1",
        medicationId: "m1",
        scheduledFor: new Date(),
        takenAt: null,
        skipped: false,
        medication: { id: "m1", snoozedUntil: null },
      },
    ] as never);
    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].status).toBe("pending");
  });

  it("backfills missing today rows for daily meds (daysOfWeek=null)", async () => {
    // v1.4.39 W-SERVER-FIX regression — the operator's Ramipril
    // (Morgens) ships `daysOfWeek: null` in the DB ("every day" per
    // schema). Pre-fix, the endpoint returned `[]` until the reminder
    // worker entered RED phase. Post-fix, the GET projects the schedule
    // and idempotently mints any missing rows so the iOS Dashboard +
    // "Erfassen" sheet have an intake row to mark.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-ramipril",
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
          },
        ],
      },
    ] as never);
    // First findMany call (pre-backfill existence probe) returns empty;
    // second call (post-backfill list) returns the freshly minted row.
    vi.mocked(prisma.medicationIntakeEvent.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          id: "e-new",
          medicationId: "med-ramipril",
          scheduledFor: new Date("2026-05-21T05:00:00.000Z"),
          takenAt: null,
          skipped: false,
          medication: { id: "med-ramipril", snoozedUntil: null },
        },
      ] as never);
    vi.mocked(prisma.medicationIntakeEvent.createMany).mockResolvedValue({
      count: 1,
    } as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; status: string }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("e-new");
    expect(body.data[0].status).toBe("pending");
    expect(prisma.medicationIntakeEvent.createMany).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(prisma.medicationIntakeEvent.createMany).mock.calls[0][0],
    ).toMatchObject({
      data: [
        {
          userId: "user-1",
          medicationId: "med-ramipril",
          skipped: false,
          source: "REMINDER",
        },
      ],
      // v1.4.39 W-SERVER-FIX-2 — the createMany must ship
      // `skipDuplicates: true` so a concurrent dashboard-summary hit
      // can't race a duplicate `(userId, medicationId, scheduledFor,
      // REMINDER)` row in between this route's existence probe and
      // insert. The schema-level @@unique([userId, medicationId,
      // scheduledFor, source]) is the structural backstop; this flag
      // is the defense-in-depth that keeps the route returning 2xx
      // when the constraint rejects the second mint.
      skipDuplicates: true,
    });
  });

  it("does not double-mint when today's rows already exist", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const scheduledFor = new Date("2026-05-21T05:00:00.000Z");
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-ramipril",
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
          },
        ],
      },
    ] as never);
    // The existence probe sees a row for the exact projected slot, so
    // createMany must not fire.
    vi.mocked(prisma.medicationIntakeEvent.findMany)
      .mockResolvedValueOnce([
        { medicationId: "med-ramipril", scheduledFor },
      ] as never)
      .mockResolvedValueOnce([
        {
          id: "e-existing",
          medicationId: "med-ramipril",
          scheduledFor,
          takenAt: null,
          skipped: false,
          medication: { id: "med-ramipril", snoozedUntil: null },
        },
      ] as never);

    const res = await GET(
      new NextRequest("http://localhost/api/medications/intake?scope=today"),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.createMany).not.toHaveBeenCalled();
  });

  it("returns compliance buckets for the last N days", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        scheduledFor: new Date(),
        takenAt: new Date(),
        skipped: false,
      },
    ] as never);
    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    expect(body.data.length).toBe(7);
  });
});

describe("POST /api/medications/intake", () => {
  function req(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(null);
    const res = await POST(req({ intakeId: "e1", status: "taken" }));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the event isn't owned by the user", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
      id: "e1",
      userId: "someone-else",
      medicationId: "m1",
    } as never);
    const res = await POST(req({ intakeId: "e1", status: "taken" }));
    expect(res.status).toBe(404);
  });

  it("returns 422 for invalid status", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(req({ intakeId: "e1", status: "broken" }));
    expect(res.status).toBe(422);
  });

  it("marks event as skipped", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: new Date("2026-05-18T10:00:00.000Z"),
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      skipped: true,
      takenAt: null,
    } as never);
    const res = await POST(req({ intakeId: "e1", status: "skipped" }));
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { takenAt: null, skipped: true },
    });
  });
});

describe("v1.4.39 W-MED — compliance rollup read swap", () => {
  it("reads the rollup tier when coverage is present", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // QA F-H-01 (v1.4.39): coverage probe returns
    // `{ rolled_days >= event_days }` so the route lands on the
    // rollup tier. Match the trailing-7-day window.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { rolled_days: BigInt(7), event_days: BigInt(7) },
    ] as never);
    // v1.4.39.1 — anchor the seed row on the runtime's "today" so the
    // test stays green across the calendar regardless of when it
    // runs. The pre-fix shape hard-coded `2026-05-18`, which fell out
    // of the trailing-7-day window on every subsequent wall-clock
    // day and silently shifted the body.data tail off the seed.
    const todayKey = (() => {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    })();
    vi.mocked(prisma.medicationComplianceRollup.findMany).mockResolvedValue([
      { day: todayKey, scheduled: 3, taken: 2, skipped: 1 },
    ] as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    expect(body.data).toHaveLength(7);
    const today = body.data[body.data.length - 1];
    expect(today.scheduled).toBe(3);
    expect(today.taken).toBe(2);
    // The legacy live aggregator must not have run when coverage is hot.
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
  });

  it("falls back to the live aggregator on coverage miss", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // QA F-H-01 (v1.4.39): partial coverage — events present but
    // rollups missing — forces fall-through to the live aggregator.
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { rolled_days: BigInt(0), event_days: BigInt(7) },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        scheduledFor: new Date(),
        takenAt: new Date(),
        skipped: false,
      },
    ] as never);

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    expect(res.status).toBe(200);
    expect(prisma.medicationIntakeEvent.findMany).toHaveBeenCalled();
  });
});

describe("v1.4.43 W6 — multi-issue 422 envelope", () => {
  function postReq(body: unknown): NextRequest {
    return new NextRequest("http://localhost/api/medications/intake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("GET surfaces TWO simultaneous validation errors", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Bad `scope` + bad `days` (NaN-coercible string).
    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=junk&days=notanumber",
      ),
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
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Missing `intakeId` (min 1) + bad `status` enum.
    const res = await POST(postReq({ status: "broken" }));
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
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Bad intakeId (empty) + bad status + bad takenAt iso.
    const res = await POST(
      postReq({ intakeId: "", status: "broken", takenAt: "not-iso" }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed medications.intake.update.validation-failed", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const res = await POST(postReq({ status: "broken" }));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.action).toBe(
      "medications.intake.update.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(postReq({ status: "broken" }));
    expect(res.status).toBe(422);
  });
});
