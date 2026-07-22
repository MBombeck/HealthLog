/**
 * Unit suite for `GET /api/workouts` — the canonical-dedup contract.
 *
 * v1.4.27 B7 / BL-P2-3 — original wiring with `pickCanonicalWorkout()`.
 * v1.4.32 — swap to `pickCanonicalWorkoutRows()` (v1.4.30) so the
 * per-user source-priority ladder governs the canonical pick. The
 * test pins:
 *   - twin workouts on the same `(sportType, 5 min slot)` cluster
 *     collapse to a single row;
 *   - the source ladder picks APPLE_HEALTH over WITHINGS over MANUAL;
 *   - `meta.droppedDuplicates` reflects the diff between the raw fetch
 *     and the canonical subset;
 *   - the response wire-shape exposes `distanceM` + `activeEnergyKcal`
 *     (iOS handoff names) rather than the legacy Prisma column names.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { __resetAllCachesForTests, caches } from "@/lib/cache/server-cache";

vi.mock("@/lib/db", () => ({
  prisma: {
    workout: {
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

vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(async () => ({})),
    requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  };
});

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { requireModuleEnabled } from "@/lib/modules/gate";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "testuser", role: "USER" as const },
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
  totalDistanceM: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  totalEnergyKcal: number | null;
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
    totalDistanceM: 5000,
    avgHeartRate: 145,
    maxHeartRate: 170,
    totalEnergyKcal: 320,
    createdAt: start,
  };
}

describe("GET /api/workouts — canonical dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset every server cache between tests so a fixed userId doesn't
    // carry cached state across cases (v1.4.34.2 — added when the
    // `/api/workouts` GET handler started reading through
    // `caches.workouts`).
    __resetAllCachesForTests();
    vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
    // Default: no per-user source-priority override → fall back to the
    // canonical APPLE_HEALTH ≻ WITHINGS ≻ MANUAL ≻ IMPORT ladder.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      sourcePriorityJson: null,
    } as never);
    // clearAllMocks wipes the factory default; re-seed the gate to pass.
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: true,
    } as never);
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
  });

  it("returns the most recent workouts first", async () => {
    // The canonical picker re-sorts its output to startedAt ASC (its rollup
    // contract), so the list route must re-establish newest-first AFTER the
    // pick — otherwise offset/limit slice the OLDEST page and recent workouts
    // never surface. These two never cluster (different day + slot).
    const older = makeRow("w-old", "APPLE_HEALTH", "2026-01-01T07:00:00Z");
    const newer = makeRow("w-new", "APPLE_HEALTH", "2026-07-01T07:00:00Z");
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      newer,
      older,
    ] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.workouts.map((w: { id: string }) => w.id)).toEqual([
      "w-new",
      "w-old",
    ]);
  });

  it("returns 401 without a session", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
  });

  it("returns 403 module.disabled when the workouts module is off", async () => {
    vi.mocked(requireModuleEnabled).mockResolvedValueOnce({
      enabled: false,
      response: new Response(
        JSON.stringify({ data: null, error: "Module disabled" }),
        { status: 403 },
      ),
    } as never);
    const res = await GET(makeRequest());
    expect(res.status).toBe(403);
    // The list query never runs once the gate refuses.
    expect(prisma.workout.findMany).not.toHaveBeenCalled();
  });

  it("filters by ownership — only the caller's rows enter the picker", async () => {
    // The mock returns whatever the route asked Prisma for; the route's
    // `where: { userId: user.id }` filter is what enforces ownership.
    // This test pins that the route passes `userId: user-1` so the
    // database layer drops other users' rows before the picker runs.
    const apple = makeRow("w-apple", "APPLE_HEALTH", "2026-05-15T07:00:00Z");
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([apple] as never);

    await GET(makeRequest());

    expect(prisma.workout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );
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
  });

  it("keeps two workouts when sportType differs at the same instant", async () => {
    const run = makeRow(
      "w-run",
      "APPLE_HEALTH",
      "2026-05-15T07:00:00Z",
      "RUNNING",
    );
    const walk = makeRow(
      "w-walk",
      "APPLE_HEALTH",
      "2026-05-15T07:00:00Z",
      "WALKING",
    );

    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([
      run,
      walk,
    ] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.data.workouts).toHaveLength(2);
    expect(body.data.meta.droppedDuplicates).toBe(0);
  });

  it("exposes iOS-contract field names on each workout row", async () => {
    const apple = makeRow("w-apple", "APPLE_HEALTH", "2026-05-15T07:00:00Z");
    vi.mocked(prisma.workout.findMany).mockResolvedValueOnce([apple] as never);

    const res = await GET(makeRequest());
    const body = await res.json();

    const row = body.data.workouts[0];
    expect(row.distanceM).toBe(5000);
    expect(row.activeEnergyKcal).toBe(320);
    expect(row.avgHr).toBe(145);
    expect(row.maxHr).toBe(170);
    expect(row).not.toHaveProperty("totalDistanceM");
    expect(row).not.toHaveProperty("totalEnergyKcal");
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
  it("normalizes empty filters into the unfiltered cache key", async () => {
    vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);

    for (const query of [
      "",
      "?since=&until=&sportType=",
      "?since=%20&until=%09&sportType=%20%20",
    ]) {
      const res = await GET(makeRequest(query));
      expect(res.status).toBe(200);
    }

    expect(prisma.workout.findMany).toHaveBeenCalledTimes(1);
    expect(caches.workouts.stats().size).toBe(1);
  });

  it("canonicalizes equivalent timestamps and trimmed sport types before keying", async () => {
    vi.mocked(prisma.workout.findMany).mockResolvedValue([] as never);

    const first = await GET(
      makeRequest(
        "?since=2026-01-01T00%3A00%3A00Z&until=2026-01-02T00%3A00%3A00Z&sportType=%20running%20",
      ),
    );
    const second = await GET(
      makeRequest(
        "?since=2025-12-31T19%3A00%3A00-05%3A00&until=2026-01-01T19%3A00%3A00-05%3A00&sportType=running",
      ),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(prisma.workout.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.workout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          sportType: "running",
          startedAt: {
            gte: new Date("2026-01-01T00:00:00.000Z"),
            lte: new Date("2026-01-02T00:00:00.000Z"),
          },
        },
      }),
    );
  });

  it("rejects invalid filters without querying or minting cache keys", async () => {
    const adversarialQueries = [
      ...Array.from(
        { length: 128 },
        (_, index) => `?since=not-a-date-${index}`,
      ),
      "?until=2026-02-30T00%3A00%3A00Z",
      "?sportType=not-a-sport",
      "?since=2026-01-02T00%3A00%3A00Z&until=2026-01-01T00%3A00%3A00Z",
    ];
    for (const query of adversarialQueries) {
      const res = await GET(makeRequest(query));
      const body = await res.json();
      expect(res.status).toBe(422);
      expect(body.error).toBe("Validation failed");
    }

    expect(prisma.workout.findMany).not.toHaveBeenCalled();
    expect(caches.workouts.stats().size).toBe(0);
  });

  it("paginates across cluster boundaries without double-counting deduped rows", async () => {
    // Eight twin clusters spaced 1 hour apart: each cluster has an
    // APPLE_HEALTH + WITHINGS row within the 5 min slot. The picker
    // collapses each cluster to its Apple row, so the canonical
    // projection has 8 rows. Page 1 (offset=0, limit=4) must yield
    // Apple rows for the four most-recent clusters; page 2 (offset=4,
    // limit=4) must yield the four older clusters with no overlap.
    const rows: FakeWorkoutRow[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(2026, 4, 15, 7 + i, 0, 0).toISOString();
      const start2 = new Date(2026, 4, 15, 7 + i, 1, 30).toISOString();
      // Descending order on input as the route's orderBy would yield.
      rows.push(makeRow(`apple-${i}`, "APPLE_HEALTH", start));
      rows.push(makeRow(`withings-${i}`, "WITHINGS", start2));
    }
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
    // Together both pages cover the eight canonical (Apple) rows.
    expect([...page1Ids, ...page2Ids].sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `apple-${i}`).sort(),
    );
  });
});
