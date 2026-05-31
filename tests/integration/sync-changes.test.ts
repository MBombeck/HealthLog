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

    // A cursor whose updatedAt is older than the retention horizon.
    const ancient = encodeCursor({
      updatedAtMs:
        Date.now() - (TOMBSTONE_RETENTION_DAYS + 5) * 86_400_000,
      id: "clxancient",
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
});
