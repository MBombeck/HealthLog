import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * v1.10.0 — categorical events (WX-B). `GET /api/insights/rhythm-events`.
 *
 * The route serves the device-flagged event awareness timeline. The
 * load-bearing behaviour under test: it narrows the query to the EVENT
 * MeasurementTypes for the authenticated user, returns the device's own
 * verdict per row, and reports `hasEvents: false` (the data-availability
 * gate the UI keys off) when the user has none.
 */

vi.mock("@/lib/db", () => ({
  prisma: {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    measurement: { findMany: vi.fn() },
  },
}));

// v1.18.0 — the route now resolves the `insights` module gate after
// `requireAuth()`. Mock it default-enabled so the existing assertions
// ride through; the off → 403 coverage lives in the route-gate inventory
// test.
vi.mock("@/lib/modules/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modules/gate")>()),
  requireModuleEnabled: vi.fn().mockResolvedValue({ enabled: true }),
  resolveModuleMap: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
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

import { GET } from "../route";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "testuser",
    role: "USER" as const,
    locale: "en",
  },
};

const callGet = GET as unknown as (req: NextRequest) => Promise<Response>;
function makeReq(): NextRequest {
  return new NextRequest(
    new URL("http://localhost/api/insights/rhythm-events"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.appSettings.findUnique).mockResolvedValue(null as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
});

describe("GET /api/insights/rhythm-events", () => {
  it("returns hasEvents:false with an empty list when the user has no events", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    const res = await callGet(makeReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { events: unknown[]; hasEvents: boolean };
    };
    expect(body.data.hasEvents).toBe(false);
    expect(body.data.events).toEqual([]);
  });

  it("narrows the query to the EVENT MeasurementTypes for the session user only", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
    await callGet(makeReq());
    const where = vi.mocked(prisma.measurement.findMany).mock.calls[0][0]
      ?.where as {
      userId: string;
      type: { in: string[] };
      deletedAt: null;
    };
    expect(where.userId).toBe("user-1");
    expect(where.deletedAt).toBeNull();
    expect(where.type.in).toEqual(
      expect.arrayContaining([
        "IRREGULAR_RHYTHM_NOTIFICATION",
        "HIGH_HEART_RATE_EVENT",
        "LOW_HEART_RATE_EVENT",
        "WALKING_STEADINESS_EVENT",
        "BREATHING_DISTURBANCE_EVENT",
      ]),
    );
    // Never a continuous metric — only the five event classes.
    expect(where.type.in).toHaveLength(5);
  });

  it("maps each row to the device verdict + occurrence timestamp", async () => {
    vi.mocked(prisma.measurement.findMany).mockResolvedValue([
      {
        id: "evt_1",
        type: "IRREGULAR_RHYTHM_NOTIFICATION",
        rhythmClassification: "IRREGULAR",
        measuredAt: new Date("2026-06-01T09:15:00.000Z"),
        source: "APPLE_HEALTH",
        deviceType: "watch",
      },
    ] as never);
    const res = await callGet(makeReq());
    const body = (await res.json()) as {
      data: {
        hasEvents: boolean;
        events: Array<{
          id: string;
          type: string;
          classification: string | null;
          occurredAt: string;
        }>;
      };
    };
    expect(body.data.hasEvents).toBe(true);
    expect(body.data.events).toEqual([
      {
        id: "evt_1",
        type: "IRREGULAR_RHYTHM_NOTIFICATION",
        classification: "IRREGULAR",
        occurredAt: "2026-06-01T09:15:00.000Z",
        source: "APPLE_HEALTH",
        deviceType: "watch",
      },
    ]);
  });
});
