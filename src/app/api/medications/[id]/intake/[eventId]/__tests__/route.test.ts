/**
 * v1.4.43 — multi-issue 422 envelope on PUT
 * /api/medications/[id]/intake/[eventId].
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medicationIntakeEvent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findFirst: vi.fn(),
      // v1.15.18 — the band resolver + the canonical slot upsert read these.
      findMany: vi.fn(),
      create: vi.fn(),
    },
    medication: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
}));
vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/medications/dose-day-refresh", () => ({
  refreshDoseSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

// (#22) — silent cross-device intake sync. Mocked so the route test can
// assert the hook fires on edit + undo without reaching the APNs senders
// or the coalescing timers.
vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

import { PUT, DELETE } from "../route";
import { queueMedicationIntakeSync } from "@/lib/notifications/medication-intake-sync";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

function putReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/e1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ROUTE_CTX = {
  params: Promise.resolve({ id: "m1", eventId: "e1" }),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // v1.37.0 — `resetAllMocks` clears the factory's resolved value and the
  // route chains `.catch()` on this fire-and-forget call.
  vi.mocked(auditLog).mockResolvedValue(undefined as never);
  vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
    id: "e1",
    userId: "user-1",
    medicationId: "m1",
    scheduledFor: new Date(),
  } as never);
  // Default lifecycle stubs: medication is NOT one-shot so the
  // reconcile is a no-op for the legacy 422-envelope tests below.
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    oneShot: false,
    active: true,
  } as never);
  vi.mocked(prisma.medication.updateMany).mockResolvedValue({
    count: 0,
  } as never);
  // v1.7.0 sync — PUT now looks the event up via `findFirst` with a
  // `deletedAt: null` guard. The default returns the live event so the
  // PUT lookup succeeds; the lifecycle `liveIntake` probe (also
  // `findFirst`) is sequenced per-test via `mockResolvedValueOnce`.
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
    id: "e1",
    userId: "user-1",
    medicationId: "m1",
    scheduledFor: new Date(),
  } as never);
});

describe("PUT /api/medications/[id]/intake/[eventId] — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // Bad `takenAt` iso + bad `skipped` (not boolean).
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
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

  it("surfaces THREE simultaneous validation errors", async () => {
    // Bad takenAt + bad skipped + bad scheduledFor.
    const res = await PUT(
      putReq({
        takenAt: "not-iso",
        skipped: "string",
        scheduledFor: "also-not-iso",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed medications.intake.event.update.validation-failed", async () => {
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    // v1.37.0 — the breadcrumb goes through `auditLog()`, the only writer
    // that stamps `actorUserId`.
    const breadcrumbs = vi
      .mocked(auditLog)
      .mock.calls.filter(([name]) => name.endsWith("validation-failed"));
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]?.[0]).toBe(
      "medications.intake.event.update.validation-failed",
    );
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(auditLog).mockRejectedValueOnce(new Error("db down"));
    const res = await PUT(
      putReq({ takenAt: "not-iso", skipped: "string" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.5.0 — one-shot lifecycle reconciliation on PUT / DELETE
// ────────────────────────────────────────────────────────────────────

function deleteReq(): NextRequest {
  return new NextRequest("http://localhost/api/medications/m1/intake/e1", {
    method: "DELETE",
  });
}

describe("DELETE /api/medications/[id]/intake/[eventId] — one-shot reconcile", () => {
  it("re-activates a one-shot medication after the deleted event was its last live intake", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValueOnce({
      oneShot: true,
      active: false,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValueOnce(
      null as never,
    );
    vi.mocked(prisma.medication.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.delete).mockResolvedValueOnce(
      {} as never,
    );

    const res = await DELETE(deleteReq(), ROUTE_CTX);
    expect(res.status).toBe(200);

    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-1", oneShot: true },
      data: { active: true },
    });
    const calls = vi.mocked(auditLog).mock.calls.map((c) => c[0]);
    expect(calls).toContain("medication.oneShot.reconciled");

    // (#22) — the undo queues exactly one cross-device sync fan-out so
    // the user's other iOS devices reconcile the restored dose state.
    expect(queueMedicationIntakeSync).toHaveBeenCalledTimes(1);
    expect(queueMedicationIntakeSync).toHaveBeenCalledWith({
      userId: "user-1",
      originDeviceToken: null,
    });
  });

  it("is idempotent on a non-one-shot medication", async () => {
    // Default beforeEach: medication is non-one-shot.
    vi.mocked(prisma.medicationIntakeEvent.delete).mockResolvedValueOnce(
      {} as never,
    );
    const res = await DELETE(deleteReq(), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(prisma.medication.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/medications/[id]/intake/[eventId] — one-shot reconcile on skip flip", () => {
  it("re-activates a one-shot medication when its single intake is flipped to skipped", async () => {
    vi.mocked(prisma.medication.findUnique).mockResolvedValueOnce({
      oneShot: true,
      active: false,
    } as never);
    // v1.7.0 sync — first `findFirst` is the PUT event lookup (returns
    // the live event); the second is the lifecycle `liveIntake` probe
    // (returns null → the dose is no longer logged → reactivate).
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: new Date(),
      } as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(prisma.medication.updateMany).mockResolvedValueOnce({
      count: 1,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValueOnce({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      skipped: true,
      takenAt: null,
    } as never);

    const res = await PUT(putReq({ skipped: true, takenAt: null }), ROUTE_CTX);
    expect(res.status).toBe(200);

    expect(prisma.medication.updateMany).toHaveBeenCalledWith({
      where: { id: "m1", userId: "user-1", oneShot: true },
      data: { active: true },
    });
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.15.18 — PUT re-runs window-band slot attribution on a takenAt change
// ────────────────────────────────────────────────────────────────────

import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";
const SESSION_TZ = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    timezone: TZ,
  },
};
const ATTR_DAY = new Date("2026-06-05T12:00:00Z");
function at(h: number, m: number): Date {
  return localHmAsUtc(ATTR_DAY, TZ, h, m);
}

/** Stub the band resolver's medication load (07:00 / 19:00 twice-daily). */
function stubTwiceDailyMed() {
  vi.mocked(prisma.medication.findFirst).mockResolvedValue({
    id: "m1",
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
  } as never);
}

describe("PUT — v1.15.18 band re-attribution", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_TZ as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
    stubTwiceDailyMed();
  });

  it("re-snaps the dose onto the matched slot when the edited takenAt moves it (slot move)", async () => {
    // The row currently sits on the 07:00 slot; the edit moves takenAt to
    // 19:05 (on-time for the 19:00 slot). The route tombstones the row + routes
    // the dose through the canonical slot upsert onto the 19:00 anchor.
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      // PUT lookup of the edited event
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(7, 5),
        skipped: false,
      } as never)
      // lifecycle liveIntake probe
      .mockResolvedValue(null as never);
    // applyCanonicalSlotWrite: no existing row at the 19:00 slot → create.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
      {} as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "e2",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(19, 0),
      takenAt: at(19, 5),
      skipped: false,
    } as never);

    const res = await PUT(
      putReq({ takenAt: at(19, 5).toISOString() }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);

    // The original row was tombstoned (deletedAt set).
    const tombstone = vi
      .mocked(prisma.medicationIntakeEvent.update)
      .mock.calls.find((c) => "deletedAt" in (c[0]?.data ?? {}));
    expect(tombstone).toBeTruthy();
    // The corrected dose was written onto the 19:00 anchor.
    const created = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0]?.[0]?.data;
    expect((created?.scheduledFor as Date).getTime()).toBe(at(19, 0).getTime());
  });

  it("unpin (forceSlotInstant: null) keeps USER_PIN provenance on the released ad-hoc row (v1.16.0)", async () => {
    // The row is pinned onto the 07:00 anchor; its real takenAt (12:00) is
    // outside every band. Releasing the binding re-attributes by band →
    // miss → the row re-anchors on its own takenAt — and the release is
    // itself a user-fixed decision, so the row must keep USER_PIN (the
    // nightly dedup keys its standalone guarantee on that marker).
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      // PUT lookup of the edited event
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(12, 0),
        skipped: false,
      } as never)
      // lifecycle liveIntake probe
      .mockResolvedValue(null as never);
    // applyCanonicalSlotWrite: no existing row at the 12:00 instant → create.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
      {} as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "e2",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(12, 0),
      takenAt: at(12, 0),
      skipped: false,
    } as never);

    const res = await PUT(putReq({ forceSlotInstant: null }), ROUTE_CTX);
    expect(res.status).toBe(200);

    const created = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0]?.[0]?.data;
    // Released row: anchored on its own takenAt, provenance stays USER_PIN.
    expect((created?.scheduledFor as Date).getTime()).toBe(at(12, 0).getTime());
    expect(created?.attributionSource).toBe("USER_PIN");
  });

  it("422s an edited takenAt before the medication's start date (P0-4)", async () => {
    // Use fixed wall-clock so the schema's "not in the future / within 5
    // years" bounds hold regardless of when the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    try {
      vi.mocked(prisma.medication.findFirst).mockResolvedValue({
        id: "m1",
        startsOn: new Date("2026-06-01T00:00:00Z"),
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        schedules: [],
      } as never);
      vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(7, 5),
        skipped: false,
      } as never);

      const res = await PUT(
        putReq({ takenAt: "2026-05-15T10:00:00+02:00" }),
        ROUTE_CTX,
      );
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("start date");
      // The guard fires before any write.
      expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not false-reject a takenAt in the early hours of the start day (tz day-key)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-10T12:00:00Z"));
    try {
      // startsOn 2026-06-01; the edit is 00:30 local Berlin on the start day,
      // which is 2026-05-31T22:30Z — a naive UTC compare would reject it.
      vi.mocked(prisma.medication.findFirst).mockResolvedValue({
        id: "m1",
        startsOn: new Date("2026-06-01T00:00:00Z"),
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
      } as never);
      vi.mocked(prisma.medicationIntakeEvent.findFirst)
        .mockResolvedValueOnce({
          id: "e1",
          userId: "user-1",
          medicationId: "m1",
          scheduledFor: at(7, 0),
          takenAt: at(7, 5),
          skipped: false,
        } as never)
        .mockResolvedValue(null as never);
      vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
        [] as never,
      );
      vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
        {} as never,
      );
      vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
        id: "e2",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: new Date("2026-05-31T22:30:00Z"),
        takenAt: new Date("2026-05-31T22:30:00Z"),
        skipped: false,
      } as never);

      const res = await PUT(
        putReq({ takenAt: "2026-06-01T00:30:00+02:00" }),
        ROUTE_CTX,
      );
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("422s a pin onto a slot already served by another recorded action (v1.16.0)", async () => {
    // The edited event is an ad-hoc take; the pin targets the real 07:00
    // slot — but that slot already carries a DIFFERENT recorded take.
    // Converging would overwrite it (last-write-wins), so the route
    // refuses with `medications.intake.force_slot.occupied` before any
    // write happens.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(12, 0),
      takenAt: at(12, 0),
      skipped: false,
    } as never);
    // findPinConflict's slot-row read: the 07:00 anchor is served.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      {
        id: "other-take",
        takenAt: at(7, 5),
        skipped: false,
        idempotencyKey: null,
        scheduledFor: at(7, 0),
        source: "WEB",
        createdAt: at(0, 1),
      },
    ] as never);

    const res = await PUT(
      putReq({ forceSlotInstant: at(7, 0).toISOString() }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      meta?: { errorCode?: string };
    };
    expect(body.meta?.errorCode).toBe("medications.intake.force_slot.occupied");
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("422s a forceSlotInstant that is not a real slot", async () => {
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(7, 0),
      takenAt: at(7, 5),
      skipped: false,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );

    const res = await PUT(
      putReq({
        takenAt: at(11, 29).toISOString(),
        forceSlotInstant: at(11, 29).toISOString(), // not a slot
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(422);
  });
});

// ────────────────────────────────────────────────────────────────────
// v1.16.10 — inventory consumption seams on PUT / DELETE
// ────────────────────────────────────────────────────────────────────

describe("PUT / DELETE — v1.16.10 inventory consumption", () => {
  beforeEach(() => {
    vi.mocked(getSession).mockResolvedValue(SESSION_TZ as never);
    vi.mocked(prisma.medication.findUnique).mockResolvedValue({
      oneShot: false,
      active: true,
    } as never);
    vi.mocked(prisma.medication.update).mockResolvedValue({} as never);
    stubTwiceDailyMed();
  });

  it("an edit into taken consumes on the row (no slot move)", async () => {
    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      // PUT lookup — pending row anchored on the 07:00 slot.
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: null,
        skipped: false,
      } as never)
      // lifecycle liveIntake probe
      .mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      scheduledFor: at(7, 0),
      takenAt: at(7, 5),
      skipped: false,
    } as never);

    const res = await PUT(
      putReq({ takenAt: at(7, 5).toISOString() }),
      ROUTE_CTX,
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

  it("an in-place time correction on an already-taken row never consumes (pre-stamp legacy rows must not retro-charge)", async () => {
    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      // PUT lookup — a row already taken BEFORE the edit, stamp NULL
      // (pre-v1.16.10: its stock moved through the legacy hook at take
      // time). The edit only corrects the takenAt minute.
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(7, 5),
        skipped: false,
        inventoryConsumption: null,
      } as never)
      .mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      scheduledFor: at(7, 0),
      takenAt: at(7, 10),
      skipped: false,
    } as never);

    const res = await PUT(
      putReq({ takenAt: at(7, 10).toISOString() }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(consumeForIntake).not.toHaveBeenCalled();
    expect(restoreForIntake).not.toHaveBeenCalled();
  });

  it("a taken → skipped edit restores the row's stamp and never consumes", async () => {
    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(7, 5),
        skipped: false,
      } as never)
      .mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue({
      id: "e1",
      scheduledFor: at(7, 0),
      takenAt: null,
      skipped: true,
    } as never);

    const res = await PUT(putReq({ skipped: true, takenAt: null }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", eventId: "e1" }),
    );
    expect(consumeForIntake).not.toHaveBeenCalled();
  });

  it("a slot-moving taken edit refunds the old row before tombstoning and consumes the converged row — net one", async () => {
    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medicationIntakeEvent.findFirst)
      .mockResolvedValueOnce({
        id: "e1",
        userId: "user-1",
        medicationId: "m1",
        scheduledFor: at(7, 0),
        takenAt: at(7, 5),
        skipped: false,
      } as never)
      .mockResolvedValue(null as never);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
      {} as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "e2",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(19, 0),
      takenAt: at(19, 5),
      skipped: false,
    } as never);

    const res = await PUT(
      putReq({ takenAt: at(19, 5).toISOString() }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e1" }),
    );
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "e2" }),
    );
    // The refund runs BEFORE the tombstone write.
    const restoreOrder =
      vi.mocked(restoreForIntake).mock.invocationCallOrder[0];
    const tombstoneOrder = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(tombstoneOrder);
  });

  it("DELETE refunds the row's stamp before the tombstone", async () => {
    const { consumeForIntake, restoreForIntake } =
      await import("@/lib/medications/inventory/consumption");
    vi.mocked(prisma.medicationIntakeEvent.findUnique).mockResolvedValue({
      id: "e1",
      userId: "user-1",
      medicationId: "m1",
      scheduledFor: at(7, 0),
      takenAt: at(7, 5),
      skipped: false,
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.update).mockResolvedValue(
      {} as never,
    );

    const res = await DELETE(
      new NextRequest("http://localhost/api/medications/m1/intake/e1", {
        method: "DELETE",
      }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(200);
    expect(restoreForIntake).toHaveBeenCalledTimes(1);
    expect(restoreForIntake).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", eventId: "e1" }),
    );
    expect(consumeForIntake).not.toHaveBeenCalled();
    const restoreOrder =
      vi.mocked(restoreForIntake).mock.invocationCallOrder[0];
    const tombstoneOrder = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .invocationCallOrder[0];
    expect(restoreOrder).toBeLessThan(tombstoneOrder);
  });
});
