/**
 * v1.4.43 W6 — multi-issue 422 envelope on POST /api/ingest/medication.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    apiToken: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    medicationIntakeEvent: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    medication: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: (s: string) => `hash(${s})` }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(),
  checkAuthSurfaceRateLimit: vi.fn(),
  rateLimitHeaders: () => ({}),
}));
vi.mock("@/lib/app-settings", () => ({
  isApiGloballyEnabled: vi.fn(),
}));
vi.mock("@/lib/rollups/medication-compliance-rollups", () => ({
  recomputeMedicationComplianceForEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/cache/invalidate", () => ({
  invalidateUserMedications: vi.fn(),
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
import { checkAuthSurfaceRateLimit, checkRateLimit } from "@/lib/rate-limit";
import { isApiGloballyEnabled } from "@/lib/app-settings";
import { invalidateUserMedications } from "@/lib/cache/invalidate";

function postReq(
  body: unknown,
  bearer: string | null = "hlk_test_token",
): NextRequest {
  return new NextRequest("http://localhost/api/ingest/medication", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
  vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
    allowed: true,
    ip: "203.0.113.7",
  } as never);
  vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
  vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
    id: "tok-1",
    userId: "user-1",
    permissions: ["*"],
    revoked: false,
    expiresAt: null,
    lastUsedAt: null,
  } as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("POST /api/ingest/medication — 422 multi-issue (v1.4.43 W6)", () => {
  it("surfaces TWO simultaneous validation errors", async () => {
    // externalIntakeSchema requires medicationName (min 1, max 200) and
    // idempotencyKey (string, max 128); takenAt iso optional. Sending
    // `medicationName=""` (min-1 violation) + `takenAt="not-iso"`
    // forces two issues. idempotencyKey is omitted so we also catch
    // the required-field check.
    const res = await POST(postReq({ medicationName: "", takenAt: "not-iso" }));
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
    // medicationName not a string (type-mismatch) + idempotencyKey too
    // long (>128 chars) + takenAt bad iso → 3 distinct issues.
    const res = await POST(
      postReq({
        medicationName: 123,
        idempotencyKey: "x".repeat(200),
        takenAt: "not-iso",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("writes the audit-ledger row keyed ingest.medication.validation-failed", async () => {
    const res = await POST(postReq({ medicationName: "" }));
    expect(res.status).toBe(422);
    await new Promise((r) => setTimeout(r, 5));
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("ingest.medication.validation-failed");
  });

  it("does not block the 422 when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );
    const res = await POST(postReq({ medicationName: "" }));
    expect(res.status).toBe(422);
  });
});

describe("POST /api/ingest/medication — slot attribution + convergence (v1.16.9)", () => {
  // The maintainer's live bug: a daily 09:00 med, the worker pre-minted the
  // pending REMINDER row at 09:00 Berlin, the user ingested the take at
  // 08:42 Berlin via the external API. The bare create anchored a SECOND
  // row at 08:42 and left the 09:00 pending row open — reminder kept
  // firing, ledger showed ad-hoc + later missed, today feed said "due".
  const SLOT_0900_BERLIN = new Date("2026-06-10T07:00:00.000Z"); // 09:00 CEST
  const TAKEN_0842_BERLIN = new Date("2026-06-10T06:42:00.000Z"); // 08:42 CEST

  const scheduleRow = {
    id: "sched-1",
    windowStart: "09:00",
    windowEnd: "09:00",
    daysOfWeek: null,
    timesOfDay: ["09:00"],
    reminderGraceMinutes: null,
    rrule: "FREQ=DAILY",
    rollingIntervalDays: null,
    scheduleType: "SCHEDULED",
    cyclicOnWeeks: null,
    cyclicOffWeeks: null,
    doseWindows: null,
  };

  const pendingReminderRow = {
    id: "evt-pending-0900",
    takenAt: null,
    skipped: false,
    idempotencyKey: null,
    scheduledFor: SLOT_0900_BERLIN,
    source: "REMINDER",
    createdAt: new Date("2026-06-10T05:00:00.000Z"),
  };

  function wireHappyPath() {
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: true } as never);
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: true,
      ip: "203.0.113.7",
    } as never);
    vi.mocked(isApiGloballyEnabled).mockResolvedValue(true);
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue({
      id: "tok-1",
      userId: "user-1",
      permissions: ["*"],
      revoked: false,
      expiresAt: null,
      lastUsedAt: null,
    } as never);
    vi.mocked(prisma.apiToken.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Europe/Berlin",
    } as never);
    // First findFirst (by name) returns the bare medication; the slot
    // resolver's findFirst (selects schedules) returns the projection.
    vi.mocked(prisma.medication.findFirst).mockImplementation(((args: {
      where: Record<string, unknown>;
    }) => {
      if (args.where && "name" in args.where) {
        return Promise.resolve({ id: "med-1", name: "Metformin" });
      }
      return Promise.resolve({
        id: "med-1",
        startsOn: null,
        endsOn: null,
        oneShot: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        schedules: [scheduleRow],
        scheduleRevisions: [],
      });
    }) as never);
    // Idempotency probe → no replay.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(null);
    // The slot's live rows: the worker-minted pending REMINDER row.
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue([
      pendingReminderRow,
    ] as never);
    vi.mocked(prisma.medicationIntakeEvent.update).mockImplementation(((args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) =>
      Promise.resolve({
        ...pendingReminderRow,
        ...args.data,
        syncVersion: 2,
      })) as never);
  }

  it("converges an 08:42 take onto the pending 09:00 REMINDER row (no second row)", async () => {
    wireHappyPath();
    const res = await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: TAKEN_0842_BERLIN.toISOString(),
        idempotencyKey: "ha-ingest-1",
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    // The pending REMINDER row was updated in place — never a bare create.
    expect(body.data.id).toBe("evt-pending-0900");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
    expect(prisma.medicationIntakeEvent.update).toHaveBeenCalledTimes(1);
    const update = vi.mocked(prisma.medicationIntakeEvent.update).mock
      .calls[0][0] as {
      where: { id: string };
      data: { takenAt: Date; skipped: boolean; autoMissed?: boolean };
    };
    expect(update.where.id).toBe("evt-pending-0900");
    expect(update.data.takenAt?.getTime()).toBe(TAKEN_0842_BERLIN.getTime());
    expect(update.data.skipped).toBe(false);
    // A recorded take clears a prior cron auto-miss.
    expect(update.data.autoMissed).toBe(false);
  });

  it("hard-evicts the user's medication caches after the write", async () => {
    wireHappyPath();
    await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: TAKEN_0842_BERLIN.toISOString(),
        idempotencyKey: "ha-ingest-2",
      }),
    );
    expect(invalidateUserMedications).toHaveBeenCalledWith("user-1", {
      evict: true,
    });
  });

  it("keeps the standalone ad-hoc contract for an off-window take", async () => {
    wireHappyPath();
    // 14:30 Berlin — outside the 09:00 band and its late tail.
    const offWindow = new Date("2026-06-10T12:30:00.000Z");
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "evt-adhoc",
      scheduledFor: offWindow,
      takenAt: offWindow,
      skipped: false,
      source: "API",
    } as never);
    const res = await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: offWindow.toISOString(),
        idempotencyKey: "ha-ingest-3",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationIntakeEvent.update).not.toHaveBeenCalled();
    const create = vi.mocked(prisma.medicationIntakeEvent.create).mock
      .calls[0][0] as { data: { scheduledFor: Date; takenAt: Date } };
    // Ad-hoc rows anchor on the intake instant (`scheduledFor = takenAt`).
    expect(create.data.scheduledFor.getTime()).toBe(offWindow.getTime());
    expect(create.data.takenAt.getTime()).toBe(offWindow.getTime());
  });

  // ── v1.16.10 — inventory consumption seam ───────────────────────────

  it("consumes inventory exactly once on the landed row", async () => {
    const { consumeForIntake } =
      await import("@/lib/medications/inventory/consumption");
    wireHappyPath();
    const res = await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: TAKEN_0842_BERLIN.toISOString(),
        idempotencyKey: "ha-ingest-inv-1",
      }),
    );
    expect(res.status).toBe(201);
    expect(consumeForIntake).toHaveBeenCalledTimes(1);
    expect(consumeForIntake).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        medicationId: "med-1",
        eventId: "evt-pending-0900",
      }),
    );
  });

  it("an idempotency replay returns the original row without consuming", async () => {
    const { consumeForIntake } =
      await import("@/lib/medications/inventory/consumption");
    wireHappyPath();
    // The replay probe finds the original event.
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue({
      id: "evt-original",
    } as never);
    const res = await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: TAKEN_0842_BERLIN.toISOString(),
        idempotencyKey: "ha-ingest-inv-1",
      }),
    );
    expect(res.status).toBe(200);
    expect(consumeForIntake).not.toHaveBeenCalled();
  });
});

describe("POST /api/ingest/medication — idempotency-key stability floor", () => {
  /**
   * `MedicationIntakeEvent.idempotency_key` is not a windowed replay
   * token: it is a `@unique` column persisted with the dose row forever
   * and matched by plain equality, which makes it an identity. A bridge
   * that mints a per-process key never matches its own earlier post, so
   * every retry logs the dose again.
   *
   * The blank case is the sharper one here — the column is unique
   * table-wide, so an empty key would resolve to whichever unrelated row
   * stored "" first rather than to this caller's own earlier post.
   */
  it("422s on an object-description key and logs nothing", async () => {
    const res = await POST(
      postReq({
        medicationName: "Metformin",
        idempotencyKey: "<NSObject: 0x600000c1a2b0>",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    const issue = body.details.issues.find((i) => i.path === "idempotencyKey");
    expect(issue).toBeDefined();
    expect(issue!.message).toContain("idempotency key");
    expect(issue!.message).toContain("stable across app restarts");
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("422s on a whitespace-only key rather than matching a stranger's row", async () => {
    const res = await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "   " }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; message: string }> };
    };
    expect(
      body.details.issues.some(
        (i) =>
          i.path === "idempotencyKey" &&
          i.message.includes("must not be empty"),
      ),
    ).toBe(true);
    expect(prisma.medicationIntakeEvent.create).not.toHaveBeenCalled();
  });

  it("accepts the timestamped key the documented bridge example sends", async () => {
    // Ad-hoc take: no schedules on the medication, so the write goes
    // straight to a create instead of converging onto a slot row.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      timezone: "Europe/Berlin",
    } as never);
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "med-1",
      name: "Metformin",
      startsOn: null,
      endsOn: null,
      oneShot: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      schedules: [],
      scheduleRevisions: [],
    } as never);
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
      [] as never,
    );
    vi.mocked(prisma.medicationIntakeEvent.create).mockResolvedValue({
      id: "evt-new",
    } as never);

    const res = await POST(
      postReq({
        medicationName: "Metformin",
        takenAt: "2026-06-10T06:42:00.000Z",
        idempotencyKey: "intake-202602191230",
      }),
    );
    expect(res.status).toBe(201);
    expect(prisma.medicationIntakeEvent.create).toHaveBeenCalledTimes(1);
  });
});

/**
 * A bridge is identified by its TOKEN, not by the address it dials from.
 *
 * The bucket used to be `ingest:${ip}`, so a household running a chat bridge,
 * a button and a home-automation rule — the normal deployment for this route,
 * not an edge case — put all three in one 60/min cell and let the chattiest
 * of them starve the other two. What makes it a defect rather than a
 * trade-off is that the route already resolves a per-caller identity two
 * lines further down and threw it away.
 *
 * The fallback matters as much as the fix: a request that resolves no token
 * has no identity but its address, and must stay capped on it. Keying the
 * failure path on anything shared — or on nothing — would hand an
 * unauthenticated flood a free pass, or collapse every anonymous caller in
 * the world into one cell, which is worse than what it replaces.
 */
describe("POST /api/ingest/medication — the rate-limit bucket", () => {
  it("keys the bucket on the token, not on the client IP", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "k-stable-001" }),
    );

    expect(vi.mocked(checkRateLimit)).toHaveBeenCalledTimes(1);
    const [key, limit, windowMs] = vi.mocked(checkRateLimit).mock.calls[0];
    expect(key).toBe("ingest:token:tok-1");
    expect(limit).toBe(60);
    expect(windowMs).toBe(60_000);
    // The address must not appear in the key at all — that is the whole
    // point. A NAT'd sibling on the same address gets its own cell.
    expect(key).not.toContain("203.0.113");
  });

  it("gives two tokens on one address two independent buckets", async () => {
    vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.apiToken.findUnique)
      .mockResolvedValueOnce({
        id: "tok-bridge",
        userId: "user-1",
        permissions: ["*"],
        revoked: false,
        expiresAt: null,
        lastUsedAt: null,
      } as never)
      .mockResolvedValueOnce({
        id: "tok-button",
        userId: "user-1",
        permissions: ["*"],
        revoked: false,
        expiresAt: null,
        lastUsedAt: null,
      } as never);

    await POST(postReq({ medicationName: "A", idempotencyKey: "k-aaaa-001" }));
    await POST(postReq({ medicationName: "B", idempotencyKey: "k-bbbb-001" }));

    const keys = vi.mocked(checkRateLimit).mock.calls.map(([k]) => k);
    expect(keys).toEqual([
      "ingest:token:tok-bridge",
      "ingest:token:tok-button",
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("refuses an exhausted token bucket with the standard envelope", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
    } as never);

    const res = await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "k-stable-002" }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    // The 429 was hand-rolled through `NextResponse.json` and carried no
    // `meta`, so a client branching on `errorCode` could not see it.
    expect(body.meta?.errorCode).toBe("ingest.rate_limited");
    expect(prisma.medication.findFirst).not.toHaveBeenCalled();
  });

  it("falls back to the per-IP bucket when no token is presented", async () => {
    const res = await POST(
      postReq(
        { medicationName: "Metformin", idempotencyKey: "k-anon-0001" },
        null,
      ),
    );
    expect(res.status).toBe(401);
    // The anonymous path must still be capped, and on the address — the only
    // identity such a request has.
    expect(vi.mocked(checkAuthSurfaceRateLimit)).toHaveBeenCalledTimes(1);
    const [, prefix, limit, windowMs] = vi.mocked(checkAuthSurfaceRateLimit)
      .mock.calls[0];
    expect(prefix).toBe("ingest:ip");
    expect(limit).toBe(60);
    expect(windowMs).toBe(60_000);
    // No token resolved, so no token bucket was charged.
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("falls back to the per-IP bucket when the token does not resolve", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null as never);
    const res = await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "k-bogus-001" }),
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(checkAuthSurfaceRateLimit)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(checkRateLimit)).not.toHaveBeenCalled();
  });

  it("caps an invalid-token flood before it can answer 401 forever", async () => {
    vi.mocked(prisma.apiToken.findUnique).mockResolvedValue(null as never);
    vi.mocked(checkAuthSurfaceRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 30_000,
      ip: "203.0.113.7",
    } as never);

    const res = await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "k-flood-001" }),
    );
    expect(res.status).toBe(429);
  });

  it("refuses a dose for a record-only medication with medication.intake.notTracked", async () => {
    vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
      null as never,
    );
    vi.mocked(prisma.medication.findFirst).mockResolvedValue({
      id: "med-1",
      userId: "user-1",
      name: "Metformin",
      trackIntake: false,
    } as never);
    const res = await POST(
      postReq({ medicationName: "Metformin", idempotencyKey: "k-record-001" }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.meta?.errorCode).toBe("medication.intake.notTracked");
  });
});
