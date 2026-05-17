/**
 * v1.4.25 W17c — Withings Sleep v2 end-to-end integration.
 *
 * Drives `syncUserSleep` against a mocked Withings response and the
 * real Postgres testcontainer. Asserts the contract Migration 0055
 * was written for: per-stage rows for the SAME night must all persist
 * (one per stage), and a re-sync must update in place rather than
 * duplicate them.
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

const TEST_USER_ID = "user-withings-sleep-sync";

beforeEach(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "withings-sleep-sync",
      email: "withings-sleep-sync@example.test",
    },
  });
  await prisma.withingsConnection.create({
    data: {
      userId: TEST_USER_ID,
      withingsUserId: "wu-1",
      accessToken: encrypt("access-token"),
      refreshToken: encrypt("refresh-token"),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "user.metrics,user.activity",
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubWithingsSleep(series: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      status: 200,
      json: async () => ({
        status: 0,
        body: { series },
      }),
    })),
  );
}

describe("syncUserSleep — integration", () => {
  it("persists one Measurement row per stage segment for a single night", async () => {
    // Sleep session #99: 4 segments — CORE 60m, DEEP 30m, REM 30m, AWAKE 10m.
    // All segments share the same parent night but each carries a
    // distinct sleepStage, so the W17b/c composite (Migration 0055)
    // keeps every row.
    const base = 1715000000; // 2024-05-06 13:33:20 UTC (arbitrary)
    stubWithingsSleep([
      { startdate: base, enddate: base + 3600, state: 1, id: 99 },
      { startdate: base + 3600, enddate: base + 5400, state: 2, id: 99 },
      { startdate: base + 5400, enddate: base + 7200, state: 3, id: 99 },
      { startdate: base + 7200, enddate: base + 7800, state: 0, id: 99 },
    ]);

    const { syncUserSleep } = await import("@/lib/withings/sync-sleep");
    const imported = await syncUserSleep(TEST_USER_ID);
    expect(imported).toBe(4);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION" },
      orderBy: { measuredAt: "asc" },
    });
    expect(rows).toHaveLength(4);

    // Every stage represented exactly once.
    const stages = rows.map((r) => r.sleepStage).sort();
    expect(stages).toEqual(["AWAKE", "CORE", "DEEP", "REM"]);

    // Stage minutes — sanity check that seconds→minutes conversion is correct.
    const byStage = new Map(rows.map((r) => [r.sleepStage, r.value]));
    expect(byStage.get("CORE")).toBe(60);
    expect(byStage.get("DEEP")).toBe(30);
    expect(byStage.get("REM")).toBe(30);
    expect(byStage.get("AWAKE")).toBe(10);

    // Every row tagged as WITHINGS source — picker will treat them as
    // a single source for the picker pipeline.
    expect(rows.every((r) => r.source === "WITHINGS")).toBe(true);
  });

  it("re-syncing the same night updates rows in place (no duplicates)", async () => {
    const base = 1715000000;
    // First sync: DEEP 30 minutes.
    stubWithingsSleep([
      { startdate: base, enddate: base + 1800, state: 2, id: 100 },
    ]);
    const { syncUserSleep } = await import("@/lib/withings/sync-sleep");
    await syncUserSleep(TEST_USER_ID);

    // Withings re-aggregates the night and the DEEP segment grew to
    // 45 minutes — second sync must UPDATE rather than INSERT.
    stubWithingsSleep([
      { startdate: base, enddate: base + 2700, state: 2, id: 100 },
    ]);
    await syncUserSleep(TEST_USER_ID);

    const prisma = getPrismaClient();
    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "SLEEP_DURATION" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(45);
    expect(rows[0].sleepStage).toBe("DEEP");
  });
});
