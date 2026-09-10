import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  // The shared single-record write ceiling. Allowed here: this file is about
  // what the handler does with a body it accepted, not about the bucket.
  checkRecordWriteRateLimit: vi.fn(async () => ({
    allowed: true,
    limit: 300,
    remaining: 299,
    resetAt: Date.now() + 60_000,
  })),
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      // v1.16.10 — the slot-move path re-inserts via the shared upsert.
      create: vi.fn(),
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
      // v1.15.18 — the band resolver loads the medication via findFirst.
      findFirst: vi.fn(),
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

vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));

vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
}));

// v1.17.1 (#22) — silent cross-device intake sync. Mocked so the route
// test asserts the wiring (queued with the right origin token) without
// reaching the APNs senders or the coalescing timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
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
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
};

beforeEach(() => {
  vi.resetAllMocks();
  // v1.36.0 — the GET's validation breadcrumb goes through the `auditLog`
  // helper, whose promise the route attaches a `.catch` to. `resetAllMocks`
  // clears the factory's implementation, so it is restored here.
  vi.mocked(auditLog).mockResolvedValue(undefined);
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

// v1.4.48 L13 — restore real timers no matter how a test exits. A failed
// assertion inside an `it` that opted into fake timers would otherwise
// leak the fake clock into the next test in the file (or, worse, the
// next file in the same vitest worker).
afterEach(() => {
  vi.useRealTimers();
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
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            timesOfDay: [],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
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
    // v1.4.47 — pin the wall-clock so the projected scheduledFor and
    // the mocked existence row land on the same day regardless of
    // when the suite runs (previously hard-coded 2026-05-21 — broke
    // on 2026-05-22).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T08:00:00.000Z"));
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const scheduledFor = new Date("2026-05-21T05:00:00.000Z");
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      {
        id: "med-ramipril",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [
          {
            id: "sched-morgens",
            medicationId: "med-ramipril",
            windowStart: "07:00",
            windowEnd: "09:00",
            daysOfWeek: null,
            timesOfDay: [],
            reminderGraceMinutes: null,
            rrule: null,
            rollingIntervalDays: null,
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
    // v1.4.48 L13 — suite-level `afterEach` restores real timers.
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
    // v1.7.0 sync — the status toggle looks the row up via `findFirst`
    // with a `deletedAt: null` guard.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
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
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
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
    // v1.7.0 sync — the skip toggle bumps syncVersion.
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith({
      where: { id: "e1" },
      data: { takenAt: null, skipped: true, syncVersion: { increment: 1 } },
    });
    // v1.16.10 — a row toggled out of taken refunds its consumption
    // stamp (no-op for a never-consumed row) and never consumes.
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", eventId: "e1" }),
    );
    expect(consumeForIntake).not.toHaveBeenCalled();
  });

  // ── v1.17.1 (#22) — silent cross-device intake sync wiring ──────────

  it("dispatches the silent intake sync with the affected slot + origin device", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const slot = new Date("2026-05-18T10:00:00.000Z");
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: slot,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      skipped: true,
      takenAt: null,
      scheduledFor: slot,
    } as never);

    const r = new NextRequest("http://localhost/api/medications/intake", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-device-id": "origin-device-token",
      },
      body: JSON.stringify({ intakeId: "e1", status: "skipped" }),
    });
    const res = await POST(r);
    expect(res.status).toBe(200);

    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
    expect(queueMedicationIntakeSync).toHaveBeenCalledWith({
      userId: "user-1",
      originDeviceToken: "origin-device-token",
    });
  });

  // ── v1.16.10 — inventory consumption seams ──────────────────────────

  it("taken (no slot move) consumes inventory exactly once on the toggled row", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const slot = new Date("2026-05-18T10:00:00.000Z");
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: slot,
      takenAt: null,
      skipped: false,
      injectionSite: null,
      doseTaken: null,
      medication: {
        deliveryForm: "ORAL",
        trackInjectionSites: false,
        allowedInjectionSites: [],
      },
    } as never);
    // Band resolver: schedule-less medication → ad-hoc attribution on the
    // takenAt, which equals the existing anchor → no slot move.
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "m1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      schedules: [],
      scheduleRevisions: [],
    } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (c: unknown) => unknown)(prisma),
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      takenAt: slot,
      skipped: false,
      scheduledFor: slot,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);

    const res = await POST(
      req({
        intakeId: "e1",
        status: "taken",
        takenAt: slot.toISOString(),
      }),
    );
    expect(res.status).toBe(200);
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        medicationId: "m1",
        eventId: "e1",
      }),
    );
    expect(restoreForIntake).not.toHaveBeenCalled();
  });

  it("taken with a slot move restores the old row's stamp before tombstoning and consumes the converged row — net one", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const oldSlot = new Date("2026-05-18T10:00:00.000Z");
    const takenAt = new Date("2026-05-18T15:00:00.000Z");
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: oldSlot,
      takenAt: oldSlot,
      skipped: false,
      injectionSite: null,
      doseTaken: null,
      medication: {
        deliveryForm: "ORAL",
        trackInjectionSites: false,
        allowedInjectionSites: [],
      },
    } as never);
    // Schedule-less → ad-hoc attribution on the new takenAt → slot moves.
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "m1",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      schedules: [],
      scheduleRevisions: [],
    } as never);
    // Tombstone write on e1, then the shared upsert: no row at the target
    // slot → create the converged row e2.
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "e2",
      takenAt,
      skipped: false,
      idempotencyKey: null,
      scheduledFor: takenAt,
      source: "WEB",
      createdAt: takenAt,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);

    const res = await POST(
      req({
        intakeId: "e1",
        status: "taken",
        takenAt: takenAt.toISOString(),
      }),
    );
    expect(res.status).toBe(200);
    // Net one: refund the source row, consume the converged row.
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e1" }),
    );
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e2" }),
    );
    // The refund runs BEFORE the tombstone write on the source row.
    const restoreOrder =
      vi.mocked(restoreForIntake).mock.invocationCallOrder[0];
    const tombstoneOrder = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(tombstoneOrder);
  });
});

describe("v1.15.9 — schedule-anchored compliance buckets (BUG #1)", () => {
  // The dashboard tile's `scheduled` is now the canonical recurrence
  // engine's expected-dose count per day (not the count of logged intake
  // rows). With partial adherence the per-day rate `taken / scheduled`
  // genuinely reflects taken-of-expected — it is NOT pinned at ~100%.
  //
  // The clock is pinned to a fixed midday instant: the fixtures mint one
  // event per UTC day, but the route buckets by the user's local
  // (Europe/Berlin) day — with a live clock, a run between 00:00 and
  // ~01:59 local (UTC date still "yesterday") left the local TODAY
  // bucket with `scheduled = 1, taken = 0` and failed the full-adherence
  // assertion. At 12:00 UTC the UTC day and the Berlin day coincide, so
  // the per-UTC-day fixture math is exact. Only `Date` is faked — the
  // route awaits real promises.
  beforeEach(() => {
    vi.useFakeTimers({
      now: new Date("2026-06-10T12:00:00Z"),
      toFake: ["Date"],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
  function activeDailyMed(createdAt: Date) {
    return {
      id: "m1",
      userId: "user-1",
      active: true,
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt,
      schedules: [
        {
          windowStart: "08:00",
          windowEnd: "09:00",
          daysOfWeek: null,
          rrule: "FREQ=DAILY",
          rollingIntervalDays: null,
          timesOfDay: ["08:00"],
          reminderGraceMinutes: null,
          scheduleType: "SCHEDULED",
          cyclicOnWeeks: null,
          cyclicOffWeeks: null,
        },
      ],
    };
  }

  it("anchors `scheduled` to the schedule — a day with a dose due but none taken reads < 100%", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const createdAt = new Date(Date.now() - 60 * 86_400_000);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      activeDailyMed(createdAt),
    ] as never);
    // Only ONE taken dose across the whole 7-day window. A logged-row
    // denominator would read 1 scheduled / 1 taken = 100% on that one day
    // and nothing elsewhere; the engine instead expects ~7 doses (one per
    // day) and counts the six un-taken days as missed → an aggregate rate
    // well below 100%.
    const yesterday8 = new Date();
    yesterday8.setUTCDate(yesterday8.getUTCDate() - 1);
    yesterday8.setUTCHours(8, 30, 0, 0);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        medicationId: "m1",
        scheduledFor: yesterday8,
        takenAt: yesterday8,
        skipped: false,
        autoMissed: false,
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
    expect(body.data).toHaveLength(7);
    // Engine expects a dose on (nearly) every day → total scheduled ≫ the
    // single logged row, and total taken is just the one.
    const totalScheduled = body.data.reduce((s, d) => s + d.scheduled, 0);
    const totalTaken = body.data.reduce((s, d) => s + d.taken, 0);
    expect(totalScheduled).toBeGreaterThanOrEqual(5);
    expect(totalTaken).toBe(1);
    // Aggregate rate is far from the degenerate ~100% the logged-row
    // denominator produced.
    expect(totalTaken / totalScheduled).toBeLessThan(0.5);
  });

  it("a fully-adherent daily med reads ~100% on every dosed day", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const createdAt = new Date(Date.now() - 60 * 86_400_000);
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      activeDailyMed(createdAt),
    ] as never);
    // One taken dose per day across the window.
    const events = [];
    for (let d = 0; d < 8; d++) {
      const at = new Date();
      at.setUTCDate(at.getUTCDate() - d);
      at.setUTCHours(8, 10, 0, 0);
      events.push({
        medicationId: "m1",
        scheduledFor: at,
        takenAt: at,
        skipped: false,
        autoMissed: false,
      });
    }
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      events as never,
    );

    const res = await GET(
      new NextRequest(
        "http://localhost/api/medications/intake?scope=compliance&days=7",
      ),
    );
    const body = (await res.json()) as {
      data: Array<{ date: string; scheduled: number; taken: number }>;
    };
    // Every dosed day has taken === scheduled → 100% throughout.
    for (const day of body.data) {
      if (day.scheduled > 0) expect(day.taken).toBe(day.scheduled);
    }
  });

  it("a deliberately skipped dose leaves the denominator — a skip is a pause, not a miss, so the tile matches the ledger rate", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    const twiceDaily = activeDailyMed(new Date(Date.now() - 60 * 86_400_000));
    twiceDaily.schedules[0].timesOfDay = ["08:00", "20:00"];
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      twiceDaily,
    ] as never);

    // Yesterday: the morning dose taken, the evening dose deliberately
    // skipped. The skipped slot must drop out of `scheduled` entirely, so the
    // day reads 1 of 1 (100%) — the figure the medication card, the dose
    // history and the doctor report already showed. Counting it as
    // expected-and-missed made the same day read 1 of 2 (50%) here.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        medicationId: "m1",
        scheduledFor: new Date("2026-06-09T08:00:00.000Z"),
        takenAt: new Date("2026-06-09T08:05:00.000Z"),
        skipped: false,
        autoMissed: false,
      },
      {
        medicationId: "m1",
        scheduledFor: new Date("2026-06-09T20:00:00.000Z"),
        takenAt: null,
        skipped: true,
        autoMissed: false,
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
    const skipDay = body.data.find((d) => d.date === "2026-06-09");
    expect(skipDay).toEqual({ date: "2026-06-09", scheduled: 1, taken: 1 });
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
    // v1.36.x — through the helper, same reason as the GET arm above: the
    // POST is a delegable write and only `auditLog` stamps the delegate.
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      "medications.intake.update.validation-failed",
      expect.objectContaining({ userId: "user-1" }),
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(postReq({ status: "broken" }));
    expect(res.status).toBe(422);
  });
});
