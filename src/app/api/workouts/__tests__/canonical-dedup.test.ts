/**
 * Unit suite for `GET /api/workouts` — the canonical-dedup contract.
 *
 * v1.4.27 B7 / BL-P2-3 — wires `pickCanonicalWorkout()` into the read
 * path. The test pins the contract:
 *   - twin workouts on the same `(sportType, ±5 min)` cluster
 *     collapse to a single row;
 *   - the source ladder picks APPLE_HEALTH over WITHINGS over MANUAL;
 *   - the `meta.droppedDuplicates` count reflects the diff between
 *     the raw fetch and the canonical subset.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: {
      findMany: vi.fn(),
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

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "marc", role: "USER" as const },
};

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/workouts${query}`, {
    method: "GET",
  });
}

interface FakeWorkoutRow {
  id: string;
  source: string;
  externalId: string | null;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  distanceMeters: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  energyKcal: number | null;
  createdAt: Date;
}

function makeRow(
  id: string,
  source: string,
  startedAt: string,
  sportType = "RUNNING",
): FakeWorkoutRow {
  const start = new Date(startedAt);
  return {
    id,
    source,
    externalId: source === "MANUAL" ? null : `ext-${id}`,
    sportType,
    startedAt: start,
    endedAt: new Date(start.getTime() + 30 * 60_000),
    durationSec: 1800,
    distanceMeters: 5000,
    avgHeartRate: 145,
    maxHeartRate: 170,
    energyKcal: 320,
    createdAt: start,
  };
}

describe("GET /api/workouts — canonical dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  });

  it("collapses an APPLE_HEALTH + WITHINGS twin to the Apple row", async () => {
    const apple = makeRow("w-apple", "APPLE_HEALTH", "2026-05-15T07:00:00Z");
    const withings = makeRow("w-withings", "WITHINGS", "2026-05-15T07:01:30Z");

    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      apple,
      withings,
    ] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.workouts).toHaveLength(1);
    expect(body.data.workouts[0].id).toBe("w-apple");
    expect(body.data.meta.droppedDuplicates).toBe(1);
    expect(body.data.meta.clusters).toBe(1);
  });

  it("keeps two workouts when they are outside the proximity window", async () => {
    const morning = makeRow("w-am", "APPLE_HEALTH", "2026-05-15T07:00:00Z");
    const evening = makeRow("w-pm", "APPLE_HEALTH", "2026-05-15T18:00:00Z");

    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      morning,
      evening,
    ] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data.workouts).toHaveLength(2);
    expect(body.data.meta.droppedDuplicates).toBe(0);
    expect(body.data.meta.clusters).toBe(2);
  });

  it("keeps two workouts when sportType differs at the same instant", async () => {
    const run = makeRow("w-run", "APPLE_HEALTH", "2026-05-15T07:00:00Z", "RUNNING");
    const walk = makeRow("w-walk", "APPLE_HEALTH", "2026-05-15T07:00:00Z", "WALKING");

    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      run,
      walk,
    ] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data.workouts).toHaveLength(2);
    expect(body.data.meta.droppedDuplicates).toBe(0);
  });

  it("honours the limit query parameter after dedup", async () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      makeRow(
        `w-${i}`,
        "APPLE_HEALTH",
        new Date(2026, 4, 15, 7 + i, 0, 0).toISOString(),
      ),
    );
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce(rows as never);

    const res = await GET(makeRequest("?limit=3"));
    const body = await res.json();

    expect(body.data.workouts).toHaveLength(3);
    expect(body.data.meta.limit).toBe(3);
  });
});
