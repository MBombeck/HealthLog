/**
 * Unit suite for `GET /api/workouts/{id}` — single-workout detail.
 *
 * v1.4.32 — paired with the list endpoint so the iOS detail screen +
 * the `/insights/workouts/[id]` web page consume one envelope per
 * workout. The test pins:
 *   - 200 + iOS-contract field names for a row the caller owns;
 *   - 401 without a session;
 *   - 404 (existence-channel sealed) when the row belongs to another
 *     user;
 *   - 404 when no row exists;
 *   - `canonicalId` resolves to the cluster winner — the requested id
 *     when the row is the canonical pick, the winner id when it is a
 *     non-canonical twin;
 *   - the optional `route` field flows through GeoJSON geometry when a
 *     `WorkoutRoute` row is attached, and is null when missing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
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

import { GET } from "../[id]/route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/workouts/w-1", {
    method: "GET",
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const BASE_ROW = {
  id: "w-1",
  userId: "user-1",
  sportType: "RUNNING",
  startedAt: new Date("2026-05-15T07:00:00Z"),
  endedAt: new Date("2026-05-15T07:30:00Z"),
  durationSec: 1800,
  totalDistanceM: 5000,
  totalEnergyKcal: 320,
  avgHeartRate: 145,
  maxHeartRate: 170,
  minHeartRate: 110,
  stepCount: 5800,
  elevationM: 12.5,
  pauseDurationSec: null,
  source: "APPLE_HEALTH" as const,
  externalId: "ext-w-1",
  externalSourceVersion: null,
  metadata: { hkVersion: "1" },
  createdAt: new Date("2026-05-15T07:30:00Z"),
  updatedAt: new Date("2026-05-15T07:30:00Z"),
  route: null,
};

describe("GET /api/workouts/{id}", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
    } as never);
  });

  it("returns the workout with iOS-contract field names", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      BASE_ROW as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      { id: "w-1", source: "APPLE_HEALTH", startedAt: BASE_ROW.startedAt, sportType: "RUNNING" },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("w-1");
    expect(body.data.distanceM).toBe(5000);
    expect(body.data.activeEnergyKcal).toBe(320);
    expect(body.data.avgHr).toBe(145);
    expect(body.data.maxHr).toBe(170);
    expect(body.data.canonicalId).toBe("w-1");
    expect(body.data.route).toBeNull();
  });

  it("returns 401 without a session", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(401);
  });

  it("returns 404 when the row belongs to another user", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      userId: "user-2",
    } as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(404);
  });

  it("returns 404 when no row exists", async () => {
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(null);
    const res = await GET(makeRequest(), makeParams("w-1"));
    expect(res.status).toBe(404);
  });

  it("resolves canonicalId to the Apple Health twin when the requested row is the Withings sibling", async () => {
    // Same 5-minute slot + sportType, but the caller asked for the
    // Withings row. The picker's default ladder makes Apple Health win
    // the cluster, so canonicalId points at the Apple row.
    const withingsRow = {
      ...BASE_ROW,
      id: "w-withings",
      source: "WITHINGS" as const,
      externalId: "withings-1",
    };
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce(
      withingsRow as never,
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      { id: "w-apple", source: "APPLE_HEALTH", startedAt: BASE_ROW.startedAt, sportType: "RUNNING" },
      { id: "w-withings", source: "WITHINGS", startedAt: BASE_ROW.startedAt, sportType: "RUNNING" },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-withings"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.id).toBe("w-withings");
    expect(body.data.canonicalId).toBe("w-apple");
  });

  it("exposes the WorkoutRoute geometry when present", async () => {
    const routeGeometry = {
      type: "LineString",
      coordinates: [
        [11.0, 49.0],
        [11.01, 49.01],
      ],
    };
    vi.mocked(prisma.workout.findUnique).mockResolvedValueOnce({
      ...BASE_ROW,
      route: {
        id: "wr-1",
        geometry: routeGeometry,
        sampleTimestamps: ["2026-05-15T07:00:00Z", "2026-05-15T07:01:00Z"],
        createdAt: BASE_ROW.createdAt,
      },
    } as never);
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      { id: "w-1", source: "APPLE_HEALTH", startedAt: BASE_ROW.startedAt, sportType: "RUNNING" },
    ] as never);

    const res = await GET(makeRequest(), makeParams("w-1"));
    const body = await res.json();

    expect(body.data.route).not.toBeNull();
    expect(body.data.route.geometry).toEqual(routeGeometry);
    expect(body.data.route.sampleTimestamps).toEqual([
      "2026-05-15T07:00:00Z",
      "2026-05-15T07:01:00Z",
    ]);
  });
});
