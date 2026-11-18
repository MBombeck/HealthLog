/**
 * v1.4.25 — Withings Sleep v2 end-to-end integration.
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

import { countStatements, summariseStatements } from "./query-counter";
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

type Segment = {
  startdate: number;
  enddate: number;
  state: number;
  id: number;
};

/**
 * Answer Sleep v2 the way Withings does: `getsummary` lists the nights,
 * `get` returns the segments inside the span asked for, at most its first
 * 24 hours.
 */
function stubWithingsSleep(series: Segment[]) {
  const nights = new Map<
    number,
    { id: number; startdate: number; enddate: number }
  >();
  for (const seg of series) {
    const night = nights.get(seg.id);
    nights.set(seg.id, {
      id: seg.id,
      startdate: Math.min(night?.startdate ?? seg.startdate, seg.startdate),
      enddate: Math.max(night?.enddate ?? seg.enddate, seg.enddate),
    });
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const params = new URLSearchParams(init.body);
      if (params.get("action") === "getsummary") {
        return {
          status: 200,
          json: async () => ({
            status: 0,
            body: { series: [...nights.values()] },
          }),
        };
      }
      const from = Number(params.get("startdate"));
      const to = Math.min(Number(params.get("enddate")), from + 24 * 3600);
      return {
        status: 200,
        json: async () => ({
          status: 0,
          body: {
            series: series.filter(
              (seg) => seg.startdate >= from && seg.enddate <= to,
            ),
          },
        }),
      };
    }),
  );
}

/** Last night: it started ten hours ago, so a run reads it again for a re-score. */
const base = Math.floor(Date.now() / 1000) - 10 * 3600;

describe("syncUserSleep — integration", () => {
  it("persists one Measurement row per stage segment for a single night", async () => {
    // Sleep session #99: 4 segments — CORE 60m, DEEP 30m, REM 30m, AWAKE 10m.
    // All segments share the same parent night but each carries a
    // distinct sleepStage, so the W17b/c composite (Migration 0055)
    // keeps every row.
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

  it("writes a week of nights in sets, and re-reads them at about one statement a segment", async () => {
    // A week of nights, forty segments each, the last one ten hours ago; a
    // full sync reads every night of the window.
    const segments: Segment[] = [];
    for (let night = 0; night < 8; night++) {
      const start = base - night * 86_400;
      for (let i = 0; i < 40; i++) {
        segments.push({
          startdate: start + i * 900,
          enddate: start + (i + 1) * 900,
          state: i % 4,
          id: 1_000 + night,
        });
      }
    }
    stubWithingsSleep(segments);
    const { syncUserSleep } = await import("@/lib/withings/sync-sleep");

    // One segment at a time this was about eight statements a segment, and
    // ten on the re-read.
    const first = await countStatements(() =>
      syncUserSleep(TEST_USER_ID, { fullSync: true }),
    );
    expect(first.result).toBe(segments.length);
    expect(
      first.count,
      summariseStatements(first.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(segments.length / 2);

    const again = await countStatements(() =>
      syncUserSleep(TEST_USER_ID, { fullSync: true }),
    );
    expect(again.result).toBe(segments.length);
    expect(
      await getPrismaClient().measurement.count({
        where: { userId: TEST_USER_ID, type: "SLEEP_DURATION" },
      }),
    ).toBe(segments.length);
    expect(
      again.count,
      summariseStatements(again.statements).slice(0, 2_000),
    ).toBeLessThanOrEqual(segments.length * 1.5);
  });
});
