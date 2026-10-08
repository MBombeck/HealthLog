/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/medications/intake/bulk.
 * Preserves the `medications.intake.bulk.invalid` errorCode meta passthrough.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: {
      findMany: vi.fn(),
      // v1.8.2 — the slot resolver loads the med via findFirst.
      findFirst: vi.fn(),
      // A landed non-skipped dose clears the medication's snooze.
      updateMany: vi.fn(),
    },
    medicationIntakeEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      // v1.8.2 reconcile — shared slot upsert reads + updates in place.
      findMany: vi.fn(),
      update: vi.fn(),
      // v1.15.19 — resolver-null convergence probe before standalone insert.
      findFirst: vi.fn(),
    },
    // The bulk drain stamps the SyncMode checkpoint (`User.lastSyncedAt`) —
    // it is a client push, and the push is what the checkpoint describes.
    user: { update: vi.fn().mockResolvedValue({}) },
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
vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
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

// (#22) — silent cross-device intake sync. Mocked so the route test can
// assert the batch queues exactly ONE fan-out without reaching the APNs
// senders or the coalescing timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import {
  consumeForIntake,
  restoreForIntake,
} from "@/lib/medications/inventory/consumption";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  // Explicit timezone keeps the band/slot fixtures below host-TZ-stable:
  // the engine expands occurrences in the user's zone, so an unset value
  // would silently track the machine's clock.
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    timezone: "Europe/Berlin",
  },
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
  it("rejects a body over the 2 MB cap with 413 before parsing", async () => {
    const res = await POST(
      postReq({ entries: [], pad: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(res.status).toBe(413);
  });

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
    // Pin the clock past both fixture slots (07:00 / 19:00 CEST on
    // 2026-06-15) so the dose-safety future-slot guard treats these taken
    // writes as landing on a current/past slot, not a future one. Without
    // the pin these fixtures are dated days ahead of the real test clock
    // and the guard (correctly) refuses to snap a taken write forward.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z"));
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      SCHEDULED_MED as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips an entry for a record-only medication as intake_not_tracked and keeps the rest", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1", trackIntake: false },
    ] as never);
    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:00.000Z",
            takenAt: "2026-06-15T05:01:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.entries).toEqual([
      { index: 0, status: "skipped", reason: "intake_not_tracked" },
    ]);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
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
    // The bulk endpoint is the iOS user's interactive intake path — the
    // write must HARD-EVICT the SWR buckets so the next read shows the
    // dose, never the pre-write stale payload.
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("a landed taken write clears the medication's active snooze", async () => {
    // The single-intake routes null `snoozedUntil` on every recorded take;
    // before this parity fix a dose drained through the bulk route (the iOS
    // offline-queue path) left the snooze standing and the reminder ringing.
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
    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["med-1"] }, userId: "user-1" },
      data: { snoozedUntil: null },
    });
  });

  it("a landed skip leaves the snooze untouched", async () => {
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
            skipped: true,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.medication.updateMany).not.toHaveBeenCalled();
  });

  it("queues exactly ONE intake-sync fan-out for a multi-entry batch", async () => {
    // Two pending rows at the day's two slots; the batch resolves both.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "row-am",
        takenAt: null,
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T05:00:00Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
      {
        id: "row-pm",
        takenAt: null,
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T17:00:00Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update)
      .mockResolvedValueOnce({ id: "row-am" } as never)
      .mockResolvedValueOnce({ id: "row-pm" } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:30.000Z",
            takenAt: "2026-06-15T05:02:00.000Z",
          },
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T17:00:30.000Z",
            takenAt: "2026-06-15T17:02:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number } };
    expect(body.data.updated).toBe(2);

    // The whole batch produces ONE queued fan-out, not one per dose; the
    // web caller carries no X-Device-Id, so no origin is excluded.
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
    expect(queueMedicationIntakeSync).toHaveBeenCalledWith({
      userId: "user-1",
      originDeviceToken: null,
    });
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
      data: {
        updated: number;
        entries: Array<{ status: string; id?: string }>;
      };
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

// ────────────────────────────────────────────────────────────────────
// v1.15.19 — resolver-null convergence (cross-source duplicate slots)
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/intake/bulk — v1.15.19 resolver-null convergence", () => {
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
        doseWindows: null,
      },
    ],
  };

  beforeEach(() => {
    // Pin the clock HOURS before the fixture slot so the taken-write
    // future-slot guard (TAKEN_FORWARD_GRACE_MS) rejects the snap and the
    // resolver returns null — the production shape: the reminder worker has
    // already pre-minted the pending REMINDER row at the slot instant, the
    // client confirms early with an explicit `scheduledFor` on that instant.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T00:30:00.000Z"));
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      SCHEDULED_MED as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records an early taken-write standalone; it does NOT snap forward onto the future slot's pending row", async () => {
    // Dose-safety invariant: a taken dose must never be attributed to a slot
    // whose anchor is still in the future (a late-morning take must not
    // consume the evening slot just because the card / client supplied it as
    // `scheduledFor`). Band attribution already refused this off-window take
    // (resolver null); the convergence probe must honour the same
    // `mayConvergeOntoSuppliedSlot` guard rather than re-binding the take
    // forward onto the pre-minted REMINDER row. It records standalone instead.
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-standalone",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:00.000Z",
            takenAt: "2026-06-15T00:30:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        updated: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    // Records as a fresh ad-hoc row — the future slot is left untouched.
    expect(body.data.inserted).toBe(1);
    expect(body.data.updated).toBe(0);
    expect(body.data.entries[0].status).toBe("inserted");
    // The guard short-circuits the convergence probe (no findFirst) and the
    // future pending row is never updated.
    expect(prisma.medicationIntakeEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
    // Ad-hoc contract: the row anchors on its own intake instant.
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledFor: new Date("2026-06-15T00:30:00.000Z"),
          takenAt: new Date("2026-06-15T00:30:00.000Z"),
        }),
      }),
    );
  });

  it("anchors a genuinely standalone resolver-null take on takenAt, not on the client's slot anchor", async () => {
    // No live row on the incoming instant — the write is ad-hoc and must
    // anchor on the intake instant so a worker mint at the slot instant
    // later cannot pair up with it as a cross-source duplicate.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-standalone",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:00.000Z",
            takenAt: "2026-06-15T00:30:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: number; entries: Array<{ status: string }> };
    };
    expect(body.data.inserted).toBe(1);
    expect(body.data.entries[0].status).toBe("inserted");
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledFor: new Date("2026-06-15T00:30:00.000Z"),
          takenAt: new Date("2026-06-15T00:30:00.000Z"),
        }),
      }),
    );
  });

  it("anchors a pending echo through the canonical snap (band engine is taken-only)", async () => {
    // A pending echo (no takenAt) has nothing to attribute by — it must
    // keep the anchor snap that binds it to the projector-minted slot row.
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
            // no takenAt → pending echo onto the (still pending) slot row
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { updated: number; entries: Array<{ status: string }> };
    };
    // The echo converges onto the canonical slot row (here a no-op update
    // path through the shared upsert), never a standalone insert.
    expect(body.data.entries[0].status).toBe("updated");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("keeps the idempotencyKey replay contract: a re-submission reports duplicate, not updated", async () => {
    // The replay pre-check fires BEFORE the convergence probe so a re-sent
    // entry keeps its historical `duplicate` status.
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValueOnce({
      id: "row-existing",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:00.000Z",
            takenAt: "2026-06-15T00:30:00.000Z",
            idempotencyKey: "ios-key-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        duplicates: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.duplicates).toBe(1);
    expect(body.data.entries[0].status).toBe("duplicate");
    expect(body.data.entries[0].id).toBe("row-existing");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.20 — taken writes attribute through the window-band engine
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/intake/bulk — v1.15.20 band attribution", () => {
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
        doseWindows: null,
      },
    ],
  };

  beforeEach(() => {
    // 20:30 Berlin on 2026-06-15 — past both fixture slots for the day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T18:30:00.000Z"));
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      SCHEDULED_MED as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attributes a takenAt-only entry to its slot by band membership", async () => {
    // 19:30 Berlin sits inside the 19:00 slot's ±60 min on-time band — the
    // take must converge onto the slot's pending REMINDER row even though
    // the client named no scheduledFor (the legacy snap refused to bind a
    // defaulted anchor to a slot; the band engine binds by the take itself).
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      {
        id: "row-evening",
        takenAt: null,
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T17:00:00Z"),
        source: "REMINDER",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-evening",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T17:30:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        updated: number;
        inserted: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.updated).toBe(1);
    expect(body.data.inserted).toBe(0);
    expect(body.data.entries[0].status).toBe("updated");
    expect(body.data.entries[0].id).toBe("row-evening");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("forceSlotInstant pins an off-window take onto the named real slot", async () => {
    // 14:00 Berlin falls in no band; the client pins the take onto the
    // morning slot anchor (05:00Z = 07:00 Berlin). The slot rows are read
    // twice on the pin path: once by the v1.16.0 occupied-slot guard
    // (`findPinConflict` — a pending row is not a conflict), once by the
    // canonical upsert itself.
    const morningPendingRow = {
      id: "row-morning",
      takenAt: null,
      skipped: false,
      idempotencyKey: null,
      scheduledFor: new Date("2026-06-15T05:00:00Z"),
      source: "REMINDER",
      createdAt: new Date("2026-06-15T00:00:00Z"),
    };
    vi.mocked(prisma.medicationIntakeEvent.findMany)
      .mockResolvedValueOnce([morningPendingRow] as never)
      .mockResolvedValueOnce([morningPendingRow] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-morning",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T12:00:00.000Z",
            forceSlotInstant: "2026-06-15T05:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        updated: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.updated).toBe(1);
    expect(body.data.entries[0].status).toBe("updated");
    expect(body.data.entries[0].id).toBe("row-morning");
  });

  it("marks an entry skipped when the pinned slot already carries a recorded action", async () => {
    // v1.16.0 — the morning slot is already served by a different take;
    // pinning another take onto it would overwrite that dose record via
    // last-write-wins, so the entry is refused per-entry
    // (`force_slot_occupied`) instead of converging.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      {
        id: "row-morning",
        takenAt: new Date("2026-06-15T05:10:00Z"),
        skipped: false,
        idempotencyKey: null,
        scheduledFor: new Date("2026-06-15T05:00:00Z"),
        source: "WEB",
        createdAt: new Date("2026-06-15T00:00:00Z"),
      },
    ] as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T12:00:00.000Z",
            forceSlotInstant: "2026-06-15T05:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        skipped: Array<{ index: number; reason: string }>;
        entries: Array<{ status: string; reason?: string }>;
      };
    };
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("force_slot_occupied");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("marks an entry skipped when forceSlotInstant names no real slot", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T12:00:00.000Z",
            forceSlotInstant: "2026-06-15T12:34:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        skipped: Array<{ index: number; reason: string }>;
        entries: Array<{ status: string; reason?: string }>;
      };
    };
    expect(body.data.entries[0].status).toBe("skipped");
    expect(body.data.entries[0].reason).toBe("force_slot_invalid");
    expect(body.data.skipped[0]).toEqual({
      index: 0,
      reason: "force_slot_invalid",
    });
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("files an out-of-band take as ad-hoc (scheduledFor = takenAt)", async () => {
    // 14:00 Berlin, no band, no pin → standalone row anchored on the take.
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-adhoc",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T12:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: number; entries: Array<{ status: string }> };
    };
    expect(body.data.inserted).toBe(1);
    expect(body.data.entries[0].status).toBe("inserted");
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduledFor: new Date("2026-06-15T12:00:00.000Z"),
          takenAt: new Date("2026-06-15T12:00:00.000Z"),
        }),
      }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.16.10 — inventory consumption seams
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/intake/bulk — v1.16.10 inventory consumption", () => {
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
        doseWindows: null,
      },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T18:00:00.000Z"));
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      SCHEDULED_MED as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("consumes exactly once per taken entry, on the landed row id", async () => {
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
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        eventId: "row-pending",
      }),
    );
    expect(restoreForIntake).not.toHaveBeenCalled();
  });

  it("C2 — a pending echo onto an already-taken slot never reaches consume", async () => {
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
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).not.toHaveBeenCalled();
  });

  it("a taken re-post onto an already-taken slot (journal replay) never reaches consume", async () => {
    // The replayed row pre-dates the consumption stamp (NULL) — exactly
    // the shape a full client journal re-sync re-posts for historical
    // doses. The upsert reports no pending→taken transition, so the
    // consume hook must not run: the stamp cannot gate a pre-v1.16.10
    // row and the replay must not drain today's stock.
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
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).not.toHaveBeenCalled();
  });

  it("an explicit skip entry restores the slot row's stamp instead of consuming", async () => {
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
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:30.000Z",
            skipped: true,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", eventId: "row-taken" }),
    );
  });

  it("an idempotency-key replay (duplicate) never consumes again", async () => {
    // An off-window take (00:20 local night, no scheduledFor) resolves
    // ad-hoc → the resolver-null branch runs its replay pre-check and
    // classifies the re-submission as a duplicate.
    vi.setSystemTime(new Date("2026-06-15T00:30:00.000Z"));
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValueOnce({
      id: "row-existing",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            takenAt: "2026-06-15T00:20:00.000Z",
            idempotencyKey: "ios-replay-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { duplicates: number; entries: Array<{ status: string }> };
    };
    expect(body.data.duplicates).toBe(1);
    expect(body.data.entries[0].status).toBe("duplicate");
    expect(consumeForIntake).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.28 — Apple Health dose events (#423)
// ────────────────────────────────────────────────────────────────────

describe("POST /api/medications/intake/bulk — v1.28 Apple Health dose events", () => {
  const MIRRORED_MED = {
    id: "med-apple",
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
        doseWindows: null,
      },
    ],
  };

  beforeEach(() => {
    // 20:30 Berlin on 2026-06-15 — past both fixture slots for the day.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T18:30:00.000Z"));
    // The ownership read surfaces the mirror flag for the source gate.
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-apple", externalSource: "APPLE_HEALTH" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(
      MIRRORED_MED as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("422s the batch when an APPLE_HEALTH entry targets a NON-mirrored medication", async () => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-native", externalSource: null },
    ] as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-native",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe(
      "medications.intake.bulk.apple_health_not_mirrored",
    );
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
  });

  it("422s an APPLE_HEALTH entry without externalId (both-or-neither refine)", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("medications.intake.bulk.invalid");
  });

  it("422s an externalId without source APPLE_HEALTH", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            externalId: "hk-dose-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });

  it("reports a replayed external dose-event UUID as duplicate without writing (idempotent re-sync)", async () => {
    // The batch pre-check finds the UUID already live.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      { id: "row-existing", externalId: "hk-dose-1" },
    ] as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-1",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        duplicates: number;
        inserted: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.duplicates).toBe(1);
    expect(body.data.inserted).toBe(0);
    expect(body.data.entries[0].status).toBe("duplicate");
    expect(body.data.entries[0].id).toBe("row-existing");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
    expect(consumeForIntake).not.toHaveBeenCalled();
  });

  it("inserts a fresh Apple dose with source APPLE_HEALTH + externalId stored; a same-batch repeat dedups", async () => {
    // Dedup pre-check: nothing live for the batch's UUIDs.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce(
      [] as never,
    );
    // 14:00 Berlin — off-band, so the take records standalone (ad-hoc).
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-apple",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-2",
          },
          // The same dose event repeated inside ONE batch (a client-side
          // pagination overlap) — must dedup in-memory, not double-insert.
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-2",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        inserted: number;
        duplicates: number;
        entries: Array<{ status: string; id?: string }>;
      };
    };
    expect(body.data.inserted).toBe(1);
    expect(body.data.duplicates).toBe(1);
    expect(body.data.entries[0].status).toBe("inserted");
    expect(body.data.entries[1].status).toBe("duplicate");
    expect(body.data.entries[1].id).toBe("row-apple");
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: "APPLE_HEALTH",
          externalId: "hk-dose-2",
          takenAt: new Date("2026-06-15T12:00:00.000Z"),
        }),
      }),
    );
  });

  it("stamps the externalId onto the pending slot row when the Apple dose converges by band", async () => {
    // Dedup pre-check first (empty), then the canonical-slot find returns
    // the worker-minted pending REMINDER row for the 19:00 slot.
    vi.mocked(prisma.medicationIntakeEvent.findMany)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          id: "row-evening",
          takenAt: null,
          skipped: false,
          idempotencyKey: null,
          scheduledFor: new Date("2026-06-15T17:00:00Z"),
          source: "REMINDER",
          createdAt: new Date("2026-06-15T00:00:00Z"),
        },
      ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "row-evening",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T17:30:00.000Z",
            source: "APPLE_HEALTH",
            externalId: "hk-dose-3",
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
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "row-evening" },
        data: expect.objectContaining({ externalId: "hk-dose-3" }),
      }),
    );
  });

  it("keeps a source-less entry byte-identical to today: source API, no externalId column", async () => {
    // No entry carries an externalId, so the dedup pre-check must not
    // fire a findMany at all — the hot path pays zero extra reads.
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValueOnce({
      id: "row-adhoc",
    } as never);

    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-apple",
            takenAt: "2026-06-15T12:00:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { inserted: number; entries: Array<{ status: string }> };
    };
    expect(body.data.inserted).toBe(1);
    expect(prisma.medicationIntakeEvent.findMany).not.toHaveBeenCalled();
    const createArgs = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0] as { data: Record<string, unknown> };
    expect(createArgs.data.source).toBe("API");
    expect("externalId" in createArgs.data).toBe(false);
  });
});

describe("POST /api/medications/intake/bulk — identity stability floor", () => {
  /**
   * Two dedup keys ride this route and BOTH are identities matched by
   * equality forever: `(userId, externalId)` for the Apple dose event, and
   * the `@unique` `idempotency_key` column for the replay probe. A value
   * that rotates per client launch matches neither, so every re-sync logs
   * the dose again. Refused PER ENTRY — a client draining an offline queue
   * must not lose its good doses to one bad row.
   */
  beforeEach(() => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1", externalSource: "APPLE_HEALTH" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "evt-new",
    } as never);
  });

  function entry(overrides: Record<string, unknown>) {
    return {
      medicationId: "med-1",
      takenAt: "2026-06-15T05:01:00.000Z",
      ...overrides,
    };
  }

  it("skips the poisoned dose event and still logs the two good ones", async () => {
    const res = await POST(
      postReq({
        entries: [
          entry({
            source: "APPLE_HEALTH",
            externalId: "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
          }),
          entry({
            source: "APPLE_HEALTH",
            externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
          }),
          entry({
            source: "APPLE_HEALTH",
            externalId: "3f0c4e4d-9c1e-4b7e-2a1d-6f30ad2a9cb1",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        processed: number;
        skipped: Array<{ index: number; reason: string }>;
        entries: Array<{ index: number; status: string; reason?: string }>;
      };
    };
    expect(body.data.processed).toBe(3);
    expect(body.data.entries[0].status).not.toBe("skipped");
    expect(body.data.entries[1]).toMatchObject({
      index: 1,
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(body.data.entries[2].status).not.toBe("skipped");
    expect(body.data.skipped).toEqual([
      { index: 1, reason: "unstable_external_id" },
    ]);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(2);
  });

  it("skips a rotating idempotencyKey — the column is a permanent identity, not a windowed token", async () => {
    const res = await POST(
      postReq({
        entries: [
          entry({ idempotencyKey: "intake-2026-06-15T05:01:00Z-med-1" }),
          entry({ idempotencyKey: "<NSObject: 0x600000c1a2b0>" }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        entries: Array<{ index: number; status: string; reason?: string }>;
      };
    };
    expect(body.data.entries[0].status).not.toBe("skipped");
    expect(body.data.entries[1]).toMatchObject({
      index: 1,
      status: "skipped",
      reason: "unstable_external_id",
    });
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
  });

  it("never turns one poisoned entry into a whole-batch 422", async () => {
    const res = await POST(
      postReq({ entries: [entry({ idempotencyKey: "0xdeadbeef" })] }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts the HealthKit dose-event UUID the mirror really sends", async () => {
    const res = await POST(
      postReq({
        entries: [
          entry({
            source: "APPLE_HEALTH",
            externalId: "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
          }),
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { entries: Array<{ status: string }> };
    };
    expect(body.data.entries[0].status).not.toBe("skipped");
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// SyncMode checkpoint — the push owns `User.lastSyncedAt`
// ────────────────────────────────────────────────────────────────────
/**
 * `GET /api/sync/state` reports the checkpoint and writes nothing, so the
 * ingest boundaries are the only writers. If this one stops stamping, the
 * checkpoint stays null forever and every paired client re-pairs full.
 */
describe("POST /api/medications/intake/bulk — sync checkpoint", () => {
  beforeEach(() => {
    vi.mocked(prisma.medication.findMany).mockResolvedValue([
      { id: "med-1" },
    ] as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "row-1",
    } as never);
  });

  it("stamps lastSyncedAt when the drain lands", async () => {
    const res = await POST(
      postReq({
        entries: [
          {
            medicationId: "med-1",
            scheduledFor: "2026-06-15T05:00:00.000Z",
            takenAt: "2026-06-15T05:02:00.000Z",
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastSyncedAt: expect.any(Date) },
    });
  });
});
