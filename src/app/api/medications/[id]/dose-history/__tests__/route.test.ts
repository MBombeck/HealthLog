/**
 * v1.15.18 — GET /api/medications/[id]/dose-history.
 *
 * The endpoint the medication "Verlauf" tab consumes. Pins the contract:
 *   - ownership-scoped (404 from the shared helper) + rate-limited (429);
 *   - reads only `deletedAt: null` rows;
 *   - returns the unified dose-history ledger (every expected slot with a
 *     status + ad-hoc takes), built from the SAME bands the compliance % uses,
 *     so the history view can never disagree with the rate;
 *   - serialises instants as ISO strings (iOS-safe additive shape).
 *
 * The band attribution itself is covered exhaustively by the pure-engine
 * suites (`band-minter` / `attribution` / `dose-history` / `attribute-intake`);
 * this file pins the route's wiring + envelope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    medication: { findUnique: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/medications/route-guards", () => ({
  assertMedicationOwnership: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  }),
  rateLimitHeaders: vi.fn(() => ({ "X-RateLimit-Remaining": "0" })),
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { localHmAsUtc } from "@/lib/tz/local-day";

const TZ = "Europe/Berlin";
const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    timezone: TZ,
  },
};

const ROUTE_PARAMS = { params: Promise.resolve({ id: "med-1" }) };

function getReq(query = ""): NextRequest {
  return new NextRequest(
    `http://localhost/api/medications/med-1/dose-history${query}`,
    { method: "GET" },
  );
}

function at(dayRef: Date, h: number, m: number): Date {
  return localHmAsUtc(dayRef, TZ, h, m);
}

const DAY = new Date("2026-06-05T12:00:00Z"); // a couple days in the past

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(assertMedicationOwnership).mockResolvedValue(null);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    limit: 60,
    remaining: 59,
    resetAt: Date.now() + 60_000,
  });
  vi.mocked(prisma.medication.findUnique).mockResolvedValue({
    id: "med-1",
    startsOn: null,
    endsOn: null,
    oneShot: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    schedules: [
      {
        id: "sched-1",
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
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
});

describe("GET /api/medications/[id]/dose-history", () => {
  it("returns the 404 from the shared ownership helper", async () => {
    vi.mocked(assertMedicationOwnership).mockResolvedValueOnce(
      new Response(null, { status: 404 }) as never,
    );
    const res = await GET(getReq(), ROUTE_PARAMS);
    expect(res.status).toBe(404);
  });

  it("returns 429 when the per-user cap is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: Date.now() + 60_000,
    });
    const res = await GET(getReq(), ROUTE_PARAMS);
    expect(res.status).toBe(429);
  });

  it("reads only deletedAt:null rows", async () => {
    await GET(getReq(), ROUTE_PARAMS);
    const where = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.where;
    expect(where).toMatchObject({
      medicationId: "med-1",
      userId: "user-1",
      deletedAt: null,
    });
  });

  it("attributes an on-time take to its slot and orphans an off-window take", async () => {
    const from = at(DAY, 0, 0).toISOString();
    const to = at(DAY, 23, 59).toISOString();
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      // on-time morning take
      {
        id: "evt-morning",
        scheduledFor: at(DAY, 7, 0),
        takenAt: at(DAY, 7, 5),
        skipped: false,
        autoMissed: false,
      },
      // off-window midday take (was the ±6h-snapped "07:00 dose")
      {
        id: "evt-adhoc",
        scheduledFor: at(DAY, 11, 29),
        takenAt: at(DAY, 11, 29),
        skipped: false,
        autoMissed: false,
      },
    ] as never);

    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const rows = json.data.rows as Array<{
      kind: string;
      timeOfDay: string | null;
      status: string;
      intake: { id: string | null } | null;
    }>;

    // 07:00 slot taken on-time; 19:00 slot missed (it is in the past); the
    // midday take is ad-hoc, NOT snapped onto a slot.
    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.status).toBe("taken_on_time");
    expect(morning?.intake?.id).toBe("evt-morning");

    const evening = rows.find((r) => r.timeOfDay === "19:00");
    expect(evening?.status).toBe("missed");

    const adHoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adHoc?.status).toBe("ad_hoc");
    expect(adHoc?.intake?.id).toBe("evt-adhoc");
  });

  it("returns each intake's write provenance in `source` (iOS #64)", async () => {
    const from = at(DAY, 0, 0).toISOString();
    const to = at(DAY, 23, 59).toISOString();
    vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValueOnce([
      // a native-app take carries API provenance
      {
        id: "evt-morning",
        scheduledFor: at(DAY, 7, 0),
        takenAt: at(DAY, 7, 5),
        skipped: false,
        autoMissed: false,
        source: "API",
      },
      // a legacy row written before the column carried a value → null
      {
        id: "evt-adhoc",
        scheduledFor: at(DAY, 11, 29),
        takenAt: at(DAY, 11, 29),
        skipped: false,
        autoMissed: false,
        source: null,
      },
    ] as never);

    // The route must SELECT `source` from Prisma, or it could never surface it.
    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(200);
    const select = vi.mocked(prisma.medicationIntakeEvent.findMany).mock
      .calls[0][0]?.select as Record<string, unknown> | undefined;
    expect(select?.source).toBe(true);

    const json = await res.json();
    const rows = json.data.rows as Array<{
      kind: string;
      timeOfDay: string | null;
      intake: { id: string | null; source: string | null } | null;
    }>;

    const morning = rows.find((r) => r.timeOfDay === "07:00");
    expect(morning?.intake?.id).toBe("evt-morning");
    expect(morning?.intake?.source).toBe("API");

    const adHoc = rows.find((r) => r.kind === "ad_hoc");
    expect(adHoc?.intake?.id).toBe("evt-adhoc");
    expect(adHoc?.intake?.source).toBe(null);
  });

  it("422 on a reversed from/to window", async () => {
    const from = at(DAY, 12, 0).toISOString();
    const to = at(DAY, 6, 0).toISOString();
    const res = await GET(
      getReq(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
      ROUTE_PARAMS,
    );
    expect(res.status).toBe(422);
  });
});
