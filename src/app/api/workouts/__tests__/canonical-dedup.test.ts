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

  it("paginates across cluster boundaries without double-counting deduped rows", async () => {
    // Eight twin clusters: each cluster has an APPLE_HEALTH + WITHINGS
    // row within the 5 min window. The picker collapses each cluster to
    // its Apple row, so the canonical projection has 8 rows. Page 1
    // (offset=0, limit=4) must yield Apple rows for clusters 7–4
    // (descending). Page 2 (offset=4, limit=4) must yield Apple rows
    // for clusters 3–0 with no overlap and no gaps. `meta.total` must
    // reflect the deduped count (8), not the raw row count (16).
    const rows: FakeWorkoutRow[] = [];
    for (let i = 0; i < 8; i++) {
      const start = new Date(2026, 4, 15, 7 + i, 0, 0).toISOString();
      const start2 = new Date(2026, 4, 15, 7 + i, 1, 30).toISOString();
      rows.push(makeRow(`apple-${i}`, "APPLE_HEALTH", start));
      rows.push(makeRow(`withings-${i}`, "WITHINGS", start2));
    }
    // Mock returns the full filtered set; the route paginates after
    // dedup.
    vi.mocked(prisma.workout.findMany).mockResolvedValue(rows as never);

    const page1 = await GET(makeRequest("?limit=4&offset=0"));
    const page1Body = await page1.json();
    const page2 = await GET(makeRequest("?limit=4&offset=4"));
    const page2Body = await page2.json();

    expect(page1Body.data.workouts).toHaveLength(4);
    expect(page2Body.data.workouts).toHaveLength(4);
    expect(page1Body.data.meta.total).toBe(8);
    expect(page2Body.data.meta.total).toBe(8);
    expect(page1Body.data.meta.droppedDuplicates).toBe(8);
    expect(page2Body.data.meta.droppedDuplicates).toBe(8);

    const page1Ids = page1Body.data.workouts.map((w: { id: string }) => w.id);
    const page2Ids = page2Body.data.workouts.map((w: { id: string }) => w.id);
    // No overlap across the page boundary.
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([]);
    // All eight clusters are covered between the two pages.
    expect([...page1Ids, ...page2Ids].sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `apple-${i}`).sort(),
    );
    // Descending order is preserved within each page.
    expect(page1Ids).toEqual(["apple-7", "apple-6", "apple-5", "apple-4"]);
    expect(page2Ids).toEqual(["apple-3", "apple-2", "apple-1", "apple-0"]);
  });
});
