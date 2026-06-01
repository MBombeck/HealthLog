/**
 * v1.7.0 — `GET /api/sync/changes` delta-feed integration (real Postgres).
 *
 * Pins the contract the iOS consumer drains against:
 *   - Keyset pagination + opaque cursor round-trip across pages.
 *   - A soft-deleted measurement surfaces as a tombstone (keyed on
 *     externalId) in the feed AND stays invisible to the normal list read.
 *   - `cursorExpired: true` when the supplied cursor predates the
 *     tombstone-retention horizon.
 *   - `syncVersion` echoed per upsert row.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { encodeCursor } from "@/lib/sync/cursor";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import { cleanupExpiredMeasurementTombstones } from "@/lib/jobs/measurement-tombstone-cleanup";

const TEST_USER_ID = "user-sync-changes";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "sync-changes",
      email: "sync-changes@example.test",
      timezone: "Europe/Berlin",
    },
  });
  const session = await getPrismaClient().session.create({
    data: {
      userId: TEST_USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
});

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/sync/changes${query}`, {
    method: "GET",
  });
}

interface ChangesData {
  serverNow: string;
  cursor: string | null;
  hasMore: boolean;
  cursorExpired: boolean;
  changes: {
    measurements: {
      upserts: Array<{
        id: string;
        externalId: string | null;
        value: number;
        syncVersion: number;
      }>;
      tombstones: Array<{
        id: string;
        externalId: string | null;
        syncVersion: number;
        deletedAt: string;
      }>;
    };
    mood: {
      upserts: Array<{ id: string; score: number; syncVersion: number }>;
      tombstones: Array<{
        id: string;
        syncVersion: number;
        deletedAt: string;
      }>;
    };
    intakes: {
      upserts: Array<{
        id: string;
        medicationId: string;
        skipped: boolean;
        syncVersion: number;
      }>;
      tombstones: Array<{
        id: string;
        syncVersion: number;
        deletedAt: string;
      }>;
    };
  };
}

/** Seed n live measurements with strictly increasing updatedAt. */
async function seedLive(n: number): Promise<void> {
  const prisma = getPrismaClient();
  const base = new Date("2026-05-20T00:00:00.000Z").getTime();
  for (let i = 0; i < n; i++) {
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "PULSE",
        value: 60 + i,
        unit: "bpm",
        source: "MANUAL",
        measuredAt: new Date(base + i * 60_000),
        externalId: `uuid-live-${i}`,
        updatedAt: new Date(base + i * 1000),
      },
    });
  }
}

/** Seed n live mood entries with strictly increasing updatedAt. */
async function seedMood(n: number): Promise<string[]> {
  const prisma = getPrismaClient();
  const base = new Date("2026-05-20T00:00:00.000Z").getTime();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const row = await prisma.moodEntry.create({
      data: {
        userId: TEST_USER_ID,
        date: `2026-05-${20 + i}`,
        mood: "GUT",
        score: 4,
        moodLoggedAt: new Date(base + i * 60_000),
        updatedAt: new Date(base + i * 1000),
      },
    });
    ids.push(row.id);
  }
  return ids;
}

/** Seed one medication + n live intake events with increasing updatedAt. */
async function seedIntakes(n: number): Promise<{ medId: string; ids: string[] }> {
  const prisma = getPrismaClient();
  const base = new Date("2026-05-20T00:00:00.000Z").getTime();
  const med = await prisma.medication.create({
    data: {
      userId: TEST_USER_ID,
      name: "Ramipril",
      dose: "5mg",
      active: true,
      schedules: { create: [{ windowStart: "08:00", windowEnd: "10:00" }] },
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const scheduledFor = new Date(base + i * 86_400_000);
    const row = await prisma.medicationIntakeEvent.create({
      data: {
        userId: TEST_USER_ID,
        medicationId: med.id,
        scheduledFor,
        takenAt: scheduledFor,
        skipped: false,
        source: "WEB",
        updatedAt: new Date(base + i * 1000),
      },
    });
    ids.push(row.id);
  }
  return { medId: med.id, ids };
}

describe("GET /api/sync/changes (real Postgres)", () => {
  it("pages through changes with an opaque cursor round-trip", async () => {
    await seedLive(5);
    const { GET } = await import("@/app/api/sync/changes/route");

    // limit=2 → first page has 2 upserts + hasMore.
    const page1 = await GET(makeRequest("?limit=2"));
    expect(page1.status).toBe(200);
    const j1 = (await page1.json()) as { data: ChangesData };
    expect(j1.data.changes.measurements.upserts).toHaveLength(2);
    expect(j1.data.hasMore).toBe(true);
    expect(j1.data.cursorExpired).toBe(false);
    expect(j1.data.cursor).toBeTruthy();
    expect(j1.data.changes.measurements.upserts[0].syncVersion).toBe(1);

    // Page 2 — echo the cursor back verbatim.
    const page2 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j1.data.cursor!)}`),
    );
    const j2 = (await page2.json()) as { data: ChangesData };
    expect(j2.data.changes.measurements.upserts).toHaveLength(2);
    expect(j2.data.hasMore).toBe(true);

    // Page 3 — last row, hasMore false.
    const page3 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j2.data.cursor!)}`),
    );
    const j3 = (await page3.json()) as { data: ChangesData };
    expect(j3.data.changes.measurements.upserts).toHaveLength(1);
    expect(j3.data.hasMore).toBe(false);

    // No row appears twice across the three pages (keyset never skips or
    // double-counts).
    const allValues = [
      ...j1.data.changes.measurements.upserts,
      ...j2.data.changes.measurements.upserts,
      ...j3.data.changes.measurements.upserts,
    ].map((r) => r.value);
    expect(new Set(allValues).size).toBe(5);
  });

  it("surfaces a soft-deleted measurement as a tombstone, never as an upsert", async () => {
    const prisma = getPrismaClient();
    const base = new Date("2026-05-20T00:00:00.000Z").getTime();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: new Date(base),
        externalId: "uuid-tomb-1",
        updatedAt: new Date(base),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 81,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: new Date(base + 60_000),
        externalId: "uuid-live-keep",
        updatedAt: new Date(base + 1000),
      },
    });

    // Soft-delete the first row via the DELETE route (the production path).
    const { DELETE } = await import(
      "@/app/api/measurements/by-external-ids/route"
    );
    const delReq = new NextRequest(
      "http://localhost/api/measurements/by-external-ids",
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalIds: ["uuid-tomb-1"] }),
      },
    );
    await DELETE(delReq);

    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(makeRequest());
    const j = (await res.json()) as { data: ChangesData };

    const upserts = j.data.changes.measurements.upserts;
    const tombstones = j.data.changes.measurements.tombstones;

    // The deleted row is a tombstone keyed on externalId, NOT an upsert.
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].externalId).toBe("uuid-tomb-1");
    expect(tombstones[0].deletedAt).toBeTruthy();
    expect(tombstones[0].syncVersion).toBe(2);
    expect(upserts.map((u) => u.externalId)).toEqual(["uuid-live-keep"]);

    // And it must NOT appear in the normal list read.
    const { GET: LIST } = await import("@/app/api/measurements/route");
    const listRes = await LIST(
      new NextRequest("http://localhost/api/measurements?type=WEIGHT", {
        method: "GET",
      }),
    );
    const listJson = (await listRes.json()) as {
      data: { measurements: Array<{ externalId: string | null }> };
    };
    const listed = listJson.data.measurements.map((m) => m.externalId);
    expect(listed).not.toContain("uuid-tomb-1");
    expect(listed).toContain("uuid-live-keep");
  });

  it("returns cursorExpired when the cursor predates the retention horizon", async () => {
    await seedLive(2);
    const { GET } = await import("@/app/api/sync/changes/route");

    // A cursor whose measurements watermark is older than the retention
    // horizon (any domain past the window expires the whole cursor).
    const ancient = encodeCursor({
      measurements: {
        updatedAtMs: Date.now() - (TOMBSTONE_RETENTION_DAYS + 5) * 86_400_000,
        id: "clxancient",
      },
    });
    const res = await GET(
      makeRequest(`?cursor=${encodeURIComponent(ancient)}`),
    );
    const j = (await res.json()) as { data: ChangesData };
    expect(j.data.cursorExpired).toBe(true);
    expect(j.data.hasMore).toBe(false);
    expect(j.data.changes.measurements.upserts).toHaveLength(0);
    expect(j.data.changes.measurements.tombstones).toHaveLength(0);
  });

  it("the tombstone-cleanup prune horizon and the feed cursor horizon share the SAME retention window so a row cannot be pruned inside a reachable cursor window (v1.7.0 L4)", async () => {
    const prisma = getPrismaClient();

    // Both horizons are derived from `TOMBSTONE_RETENTION_DAYS`: the
    // cleanup job prunes rows whose `deletedAt` is older than
    // `now - TOMBSTONE_RETENTION_DAYS`, and the feed flags `cursorExpired`
    // for a cursor whose `updatedAt` is older than the same window. A
    // soft-delete sets `deletedAt == updatedAt`, and any later mutation
    // only moves `updatedAt` forward (never `deletedAt`), so a row the
    // cleanup is eligible to prune (`deletedAt` past the window) can only
    // have an `updatedAt` that is also past the window UNLESS it was
    // re-touched — in which case the row is still present and re-surfaces
    // as a tombstone on the next delta.
    const horizonMs = TOMBSTONE_RETENTION_DAYS * 86_400_000;

    // Case 1 — a tombstone freshly inside the window (deletedAt recent) is
    // NOT pruned, and its cursor is NOT expired: both horizons agree it is
    // reachable.
    const recent = new Date(Date.now() - 60_000);
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: recent,
        externalId: "uuid-recent-tomb",
        deletedAt: recent,
        updatedAt: recent,
      },
    });

    // Case 2 — a tombstone whose `deletedAt` AND `updatedAt` both predate
    // the window: pruned by cleanup, and a cursor at that position is
    // expired by the feed. The shared window means a row is never both
    // pruned-eligible AND inside a non-expired cursor window.
    const ancient = new Date(Date.now() - horizonMs - 5 * 86_400_000);
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "WEIGHT",
        value: 81,
        unit: "kg",
        source: "APPLE_HEALTH",
        measuredAt: ancient,
        externalId: "uuid-ancient-tomb",
        deletedAt: ancient,
        updatedAt: ancient,
      },
    });

    const pruned = await cleanupExpiredMeasurementTombstones(prisma);
    // Only the ancient row (deletedAt past the retention horizon) is
    // pruned; the recent reachable tombstone survives.
    expect(pruned).toBe(1);
    const survivors = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID },
      select: { externalId: true },
    });
    const ids = survivors.map((s) => s.externalId);
    expect(ids).toContain("uuid-recent-tomb");
    expect(ids).not.toContain("uuid-ancient-tomb");

    // The surviving recent tombstone is still reachable by a fresh cursor
    // (the feed's reachable window keys on the SAME retention horizon), so
    // the deletion is not silently dropped.
    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(makeRequest());
    const body = (await res.json()) as { data: ChangesData };
    expect(body.data.cursorExpired).toBe(false);
    const tombIds = body.data.changes.measurements.tombstones.map(
      (t) => t.externalId,
    );
    expect(tombIds).toContain("uuid-recent-tomb");
  });
});

describe("GET /api/sync/changes — mood domain (real Postgres)", () => {
  it("pages mood entries with a per-domain cursor round-trip", async () => {
    await seedMood(5);
    const { GET } = await import("@/app/api/sync/changes/route");

    const page1 = await GET(makeRequest("?limit=2"));
    const j1 = (await page1.json()) as { data: ChangesData };
    expect(j1.data.changes.mood.upserts).toHaveLength(2);
    expect(j1.data.hasMore).toBe(true);
    // syncVersion defaults to 0 for legacy/seeded mood rows.
    expect(j1.data.changes.mood.upserts[0].syncVersion).toBe(0);

    const page2 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j1.data.cursor!)}`),
    );
    const j2 = (await page2.json()) as { data: ChangesData };
    expect(j2.data.changes.mood.upserts).toHaveLength(2);

    const page3 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j2.data.cursor!)}`),
    );
    const j3 = (await page3.json()) as { data: ChangesData };
    expect(j3.data.changes.mood.upserts).toHaveLength(1);
    expect(j3.data.hasMore).toBe(false);

    const all = [
      ...j1.data.changes.mood.upserts,
      ...j2.data.changes.mood.upserts,
      ...j3.data.changes.mood.upserts,
    ].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
  });

  it("surfaces a soft-deleted mood entry as a tombstone keyed on id, never an upsert, and hides it from the list read", async () => {
    const [delId, keepId] = await seedMood(2);
    const { DELETE } = await import("@/app/api/mood-entries/[id]/route");
    await DELETE(
      new NextRequest(`http://localhost/api/mood-entries/${delId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: delId }) },
    );

    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(makeRequest());
    const j = (await res.json()) as { data: ChangesData };

    expect(j.data.changes.mood.tombstones).toHaveLength(1);
    expect(j.data.changes.mood.tombstones[0].id).toBe(delId);
    expect(j.data.changes.mood.tombstones[0].syncVersion).toBe(1);
    expect(j.data.changes.mood.upserts.map((u) => u.id)).toEqual([keepId]);

    // Not in the normal list read.
    const { GET: LIST } = await import("@/app/api/mood-entries/route");
    const listRes = await LIST(
      new NextRequest("http://localhost/api/mood-entries", { method: "GET" }),
    );
    const listJson = (await listRes.json()) as {
      data: { entries: Array<{ id: string }> };
    };
    const listed = listJson.data.entries.map((m) => m.id);
    expect(listed).not.toContain(delId);
    expect(listed).toContain(keepId);
  });
});

describe("GET /api/sync/changes — intake domain (real Postgres)", () => {
  it("pages intake events with a per-domain cursor round-trip", async () => {
    await seedIntakes(5);
    const { GET } = await import("@/app/api/sync/changes/route");

    const page1 = await GET(makeRequest("?limit=2"));
    const j1 = (await page1.json()) as { data: ChangesData };
    expect(j1.data.changes.intakes.upserts).toHaveLength(2);
    expect(j1.data.hasMore).toBe(true);
    expect(j1.data.changes.intakes.upserts[0].syncVersion).toBe(0);

    const page2 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j1.data.cursor!)}`),
    );
    const j2 = (await page2.json()) as { data: ChangesData };
    const page3 = await GET(
      makeRequest(`?limit=2&cursor=${encodeURIComponent(j2.data.cursor!)}`),
    );
    const j3 = (await page3.json()) as { data: ChangesData };
    expect(j3.data.changes.intakes.upserts).toHaveLength(1);
    expect(j3.data.hasMore).toBe(false);

    const all = [
      ...j1.data.changes.intakes.upserts,
      ...j2.data.changes.intakes.upserts,
      ...j3.data.changes.intakes.upserts,
    ].map((r) => r.id);
    expect(new Set(all).size).toBe(5);
  });

  it("surfaces a soft-deleted intake as a tombstone keyed on id, never an upsert", async () => {
    const { medId, ids } = await seedIntakes(2);
    const [delId, keepId] = ids;
    const { DELETE } = await import(
      "@/app/api/medications/[id]/intake/[eventId]/route"
    );
    await DELETE(
      new NextRequest(
        `http://localhost/api/medications/${medId}/intake/${delId}`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: medId, eventId: delId }) },
    );

    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(makeRequest());
    const j = (await res.json()) as { data: ChangesData };

    expect(j.data.changes.intakes.tombstones).toHaveLength(1);
    expect(j.data.changes.intakes.tombstones[0].id).toBe(delId);
    expect(j.data.changes.intakes.tombstones[0].syncVersion).toBe(1);
    expect(j.data.changes.intakes.upserts.map((u) => u.id)).toEqual([keepId]);
  });
});

describe("GET /api/sync/changes — multi-domain (real Postgres)", () => {
  it("serves all three domains in one page and advances each domain's watermark independently", async () => {
    await seedLive(2);
    await seedMood(2);
    await seedIntakes(2);
    const { GET } = await import("@/app/api/sync/changes/route");

    const res = await GET(makeRequest());
    const j = (await res.json()) as { data: ChangesData };
    expect(j.data.changes.measurements.upserts).toHaveLength(2);
    expect(j.data.changes.mood.upserts).toHaveLength(2);
    expect(j.data.changes.intakes.upserts).toHaveLength(2);
    expect(j.data.hasMore).toBe(false);

    // Echoing the cursor back yields an empty caught-up page across all
    // three domains — the per-domain watermarks all advanced.
    const res2 = await GET(
      makeRequest(`?cursor=${encodeURIComponent(j.data.cursor!)}`),
    );
    const j2 = (await res2.json()) as { data: ChangesData };
    expect(j2.data.changes.measurements.upserts).toHaveLength(0);
    expect(j2.data.changes.mood.upserts).toHaveLength(0);
    expect(j2.data.changes.intakes.upserts).toHaveLength(0);
    expect(j2.data.hasMore).toBe(false);
  });

  it("hasMore reflects ANY domain still having rows past its page", async () => {
    // measurements has 3 rows, mood + intakes have 1 each; with limit=2 the
    // measurements domain still has more → hasMore must be true.
    await seedLive(3);
    await seedMood(1);
    await seedIntakes(1);
    const { GET } = await import("@/app/api/sync/changes/route");

    const res = await GET(makeRequest("?limit=2"));
    const j = (await res.json()) as { data: ChangesData };
    expect(j.data.changes.measurements.upserts).toHaveLength(2);
    expect(j.data.changes.mood.upserts).toHaveLength(1);
    expect(j.data.changes.intakes.upserts).toHaveLength(1);
    expect(j.data.hasMore).toBe(true);
  });

  it("treats a garbage cursor as a clean initial sync", async () => {
    await seedMood(1);
    const { GET } = await import("@/app/api/sync/changes/route");
    const res = await GET(makeRequest("?cursor=not-a-valid-cursor"));
    const j = (await res.json()) as { data: ChangesData };
    expect(res.status).toBe(200);
    expect(j.data.cursorExpired).toBe(false);
    expect(j.data.changes.mood.upserts).toHaveLength(1);
  });
});
