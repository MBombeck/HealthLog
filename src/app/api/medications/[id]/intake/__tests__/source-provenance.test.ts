/**
 * v1.32.8 (iOS #64) — write-provenance of a medication intake is derived from
 * the TRANSPORT, never from the request body.
 *
 *   - a cookie (browser) POST records `source: "WEB"`;
 *   - a Bearer (native app) POST records `source: "API"`;
 *   - a body that tries to set `source` is ignored (no mass assignment);
 *   - the producer-owned values (`REMINDER` / `IMPORT` / `APPLE_HEALTH`) are
 *     minted by OTHER routes and are unreachable here, so this route can only
 *     ever stamp WEB / API — the cookie-vs-Bearer split is the whole surface.
 *
 * These run the REAL `apiHandler` + `requireAuth` (only `getSession`,
 * `next/headers`, and the Bearer resolver are mocked) so the auth-method
 * derivation that a unit mock would paper over is exercised end to end. The
 * medication has no schedules, so a taken write lands on the standalone
 * (ad-hoc) create path where `source` is stamped directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
    medication: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    medicationIntakeEvent: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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

// The medication carries no schedules, so a taken write resolves to no
// canonical slot and lands on the standalone create path. Stub the resolvers
// so the route deterministically takes that branch regardless of the fixtures.
vi.mock("@/lib/medications/scheduling/slot-upsert", () => ({
  resolveSlotForWriteByBand: vi.fn(async () => ({ slotInstant: null })),
  resolveSlotInstantForWrite: vi.fn(async () => null),
  resolveForcedSlotForWrite: vi.fn(async () => null),
  findPinConflict: vi.fn(async () => false),
  mayConvergeOntoSuppliedSlot: vi.fn(() => true),
  applyCanonicalSlotWrite: vi.fn(),
}));

vi.mock("@/lib/medications/inventory/consumption", () => ({
  consumeForIntake: vi.fn().mockResolvedValue(undefined),
  restoreForIntake: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/medications/lifecycle", () => ({
  reconcileOneShotState: vi.fn().mockResolvedValue("noop"),
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

vi.mock("@/lib/notifications/medication-intake-sync", () => ({
  queueMedicationIntakeSync: vi.fn(),
}));

// The route dispatches the PWA clear fire-and-forget after a recorded dose;
// both halves are mocked so the test asserts the dispatch, not web-push.
vi.mock("@/lib/notifications/web-push-clear", () => ({
  dispatchMedicationIntakeWebClear: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/medications/outstanding-doses", () => ({
  countOutstandingDosesToday: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/bearer", () => ({ resolveBearerToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

// Default to no Authorization header; the Bearer tests override this.
const headerStore = { authorization: null as string | null };
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) =>
      name.toLowerCase() === "authorization" ? headerStore.authorization : null,
  })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { POST } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { resolveBearerToken } from "@/lib/auth/bearer";
import { dispatchMedicationIntakeWebClear } from "@/lib/notifications/web-push-clear";
import { countOutstandingDosesToday } from "@/lib/medications/outstanding-doses";

const USER = {
  id: "user-1",
  username: "testuser",
  role: "USER" as const,
  timezone: "Europe/Berlin",
};

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: USER,
};

const MED_OK = { id: "med-1", userId: "user-1" };
const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function postReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/medications/med-1/intake", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The `source` value stamped on the freshly-created standalone intake row. */
function createdSource(): unknown {
  const call = vi.mocked(prisma.medicationIntakeEvent.create).mock.calls[0];
  return (call?.[0] as { data?: { source?: unknown } } | undefined)?.data
    ?.source;
}

beforeEach(() => {
  vi.resetAllMocks();
  headerStore.authorization = null;
  vi.mocked(prisma.medication.findUnique).mockResolvedValue(MED_OK as never);
  vi.mocked(prisma.medication.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.findFirst).mockResolvedValue(
    null as never,
  );
  vi.mocked(prisma.medicationIntakeEvent.count).mockResolvedValue(0);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
  // The standalone branch wraps the create in a `$transaction([...])`. The
  // create mock records the `data` it was called with; the transaction
  // resolves to the created row so the rest of the handler proceeds.
  vi.mocked(prisma.medicationIntakeEvent.create).mockReturnValue({
    id: "evt-1",
    takenAt: new Date(),
    scheduledFor: new Date(),
  } as never);
  vi.mocked(prisma.$transaction).mockResolvedValue([
    { id: "evt-1", takenAt: new Date(), scheduledFor: new Date() },
  ] as never);
});

describe("POST intake — transport-derived source (iOS #64)", () => {
  it("stamps WEB for a cookie (browser) session", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    const res = await POST(postReq({}), ROUTE_PARAMS);
    expect(res.status).toBe(201);
    expect(createdSource()).toBe("WEB");
  });

  it("stamps API for a Bearer (native app) token", async () => {
    vi.mocked(getSession).mockResolvedValue(null as never);
    headerStore.authorization = "Bearer hlk_test-token";
    vi.mocked(resolveBearerToken).mockResolvedValue({
      user: USER as never,
      tokenId: "tok-1",
      permissions: ["*"],
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const res = await POST(postReq({}), ROUTE_PARAMS);
    expect(res.status).toBe(201);
    expect(createdSource()).toBe("API");
  });

  it("closes the pending dose-due web reminder after a recorded intake", async () => {
    // Before this route dispatched the clear, an iOS offline drain (which
    // replays free intakes through exactly this endpoint) left the web
    // dose-due reminder and the app badge standing after the dose landed.
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(countOutstandingDosesToday).mockResolvedValue(3);

    const res = await POST(postReq({}), ROUTE_PARAMS);
    expect(res.status).toBe(201);

    // Fire-and-forget: the dispatch runs detached from the response.
    await expect
      .poll(
        () => vi.mocked(dispatchMedicationIntakeWebClear).mock.calls.length,
        { timeout: 2_000, interval: 25 },
      )
      .toBe(1);
    expect(
      vi.mocked(dispatchMedicationIntakeWebClear).mock.calls[0][0],
    ).toMatchObject({
      userId: "user-1",
      medicationId: "med-1",
      badgeCount: 3,
    });
  });

  it("ignores a client-supplied `source` in the body (no mass assignment)", async () => {
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);

    // A cookie caller forging `source: "APPLE_HEALTH"` must still record WEB —
    // the value is derived from the transport, never read from the body.
    const res = await POST(postReq({ source: "APPLE_HEALTH" }), ROUTE_PARAMS);
    expect(res.status).toBe(201);
    expect(createdSource()).toBe("WEB");
  });
});
