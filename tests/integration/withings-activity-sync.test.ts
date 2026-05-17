/**
 * v1.4.25 W17b — Withings activity-sync end-to-end.
 *
 * Drives `syncUserActivity` against a mocked Withings response and the
 * real Postgres testcontainer. Asserts:
 *   - Per-day activity entries map to one row per (date, metric)
 *   - The composite-unique with NULLS NOT DISTINCT serializes a
 *     second sync of the same window into UPDATEs (no duplicates)
 *   - Activity rows leave sleep_stage NULL so they do not collide
 *     with the W17c sleep rows
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Crypto reads `ENCRYPTION_KEY` lazily on first encrypt(). Under the
// previous `isolate: false` suite the env from any sibling that seeded
// the key leaked into this file; per-file isolation (v1.4.37 W-CI)
// reveals that this spec never seeded its own key. Pin a deterministic
// 32-byte test key before any `@/lib/crypto` import so the spec stays
// self-contained.
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";

import { getPrismaClient, truncateAllTables } from "./setup";

const TEST_USER_ID = "user-withings-activity-sync";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "withings-activity-sync",
      email: "withings-activity-sync@example.test",
    },
  });
  await prisma.withingsConnection.create({
    data: {
      userId: TEST_USER_ID,
      withingsUserId: "wu-1",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      // Token valid for an hour — keeps `getValidToken` off the
      // refresh path.
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "user.metrics,user.activity",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubWithingsActivity(entries: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      json: async () => ({
        status: 0,
        body: { activities: entries, more: false, offset: 0 },
      }),
    })),
  );
}

describe("syncUserActivity — integration", () => {
  it("writes one Measurement row per (date, metric) on first sync", async () => {
    stubWithingsActivity([
      { date: "2026-05-10", steps: 8420, distance: 6720, calories: 412 },
      { date: "2026-05-11", steps: 5012, distance: 3950, calories: 245 },
    ]);

    const { syncUserActivity } = await import("@/lib/withings/sync-activity");
    const imported = await syncUserActivity(TEST_USER_ID);
    expect(imported).toBe(6); // 2 days × 3 fields

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, source: "WITHINGS" },
      orderBy: [{ measuredAt: "asc" }, { type: "asc" }],
    });
    expect(rows).toHaveLength(6);
    // Activity rows never carry a sleepStage — confirms the new
    // composite leaves the column NULL for non-sleep ingest.
    expect(rows.every((r) => r.sleepStage === null)).toBe(true);

    const types = new Set(rows.map((r) => r.type));
    expect(types.has("ACTIVITY_STEPS")).toBe(true);
    expect(types.has("WALKING_RUNNING_DISTANCE")).toBe(true);
    expect(types.has("ACTIVE_ENERGY_BURNED")).toBe(true);
  });

  it("re-running the same sync updates rather than duplicating", async () => {
    const entries = [
      { date: "2026-05-10", steps: 8420, distance: 6720, calories: 412 },
    ];
    stubWithingsActivity(entries);
    const { syncUserActivity } = await import("@/lib/withings/sync-activity");
    await syncUserActivity(TEST_USER_ID);

    // Withings re-aggregates a day when late samples arrive; second
    // pull returns updated values.
    stubWithingsActivity([
      { date: "2026-05-10", steps: 9001, distance: 7200, calories: 450 },
    ]);
    await syncUserActivity(TEST_USER_ID);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, source: "WITHINGS" },
      orderBy: { type: "asc" },
    });
    expect(rows).toHaveLength(3);
    const steps = rows.find((r) => r.type === "ACTIVITY_STEPS");
    expect(steps?.value).toBe(9001);
    const distance = rows.find((r) => r.type === "WALKING_RUNNING_DISTANCE");
    expect(distance?.value).toBe(7200);
  });
});
