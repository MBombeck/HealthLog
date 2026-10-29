/**
 * The dense hourly fold over the provider syncs that store heart rate one row
 * per sample, and their ingest guard, against Postgres (#1297).
 *
 *   - Google Health and Oura heart rate older than the retention window folds
 *     to hourly `stats:` rows under its own source, the raw rows go, and the
 *     DAY rollup keeps the figures it had from the raw samples.
 *   - A daily SpO2 value of the same sources is no intraday stream and stays.
 *   - Writing the same old samples again, as a backfill or a full sync does,
 *     inserts nothing and leaves every hourly mean as it was, including the
 *     hour whose anchor a sample fell on (Google Health's natural-key rescue
 *     used to re-key that row back into the sample).
 *   - Samples inside the window still write as before.
 *   - The change feed served these samples, so their removal reaches it: the
 *     nightly increment leaves tombstones the feed reports, and a backlog
 *     day, deleted outright, expires the account's delta cursors. An Apple
 *     Health fold expires nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { upsertGoogleHealthMeasurements } from "@/lib/google-health/sync-core";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import { pullSyncChanges } from "@/lib/sync/changes/pull";
import {
  TouchedDays,
  writeOuraHeartRatePage,
} from "@/lib/oura/sync-heart-rate";

import { makeUser } from "../kit/factories";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const prisma = getPrismaClient();
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

beforeEach(async () => {
  await truncateAllTables(prisma);
});

/** Noon UTC, `days` ago: every sample below stays inside that UTC day. */
function dayStart(days: number): number {
  const now = Date.now();
  return Math.floor(now / DAY_MS) * DAY_MS - days * DAY_MS;
}

/** Samples of 10:00-11:59 UTC, one every 10 minutes, 10:30 included. */
function samples(base: number): Array<{ at: Date; bpm: number }> {
  const out: Array<{ at: Date; bpm: number }> = [];
  for (let m = 0; m < 120; m += 10) {
    out.push({
      at: new Date(base + 10 * 60 * MIN_MS + m * MIN_MS),
      bpm: 50 + ((m * 7) % 45),
    });
  }
  return out;
}

const gh = (s: { at: Date; bpm: number }) => ({
  type: "PULSE",
  value: s.bpm,
  unit: "bpm",
  measuredAt: s.at,
  externalId: `${s.at.getTime()}:hr`,
});

async function liveRows(userId: string, source: "GOOGLE_HEALTH" | "OURA") {
  return prisma.measurement.findMany({
    where: { userId, source, deletedAt: null },
    select: { type: true, value: true, externalId: true, measuredAt: true },
    orderBy: [{ type: "asc" }, { measuredAt: "asc" }],
  });
}

describe("dense fold of provider heart rate (#1297)", () => {
  it("folds old Google Health heart rate to hourly means, and a re-sync writes none of it back", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const old = samples(dayStart(120));
    const recent = samples(dayStart(5));
    await upsertGoogleHealthMeasurements(user.id, old.map(gh));
    // A nightly SpO2 average: one value a day, never folded.
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "OXYGEN_SATURATION",
        value: 96,
        unit: "%",
        source: "GOOGLE_HEALTH",
        measuredAt: new Date(dayStart(120) + 7 * 3_600_000),
        externalId: "2026-01-01:spo2",
      },
    });
    const dayBefore = await prisma.measurementRollup.findFirstOrThrow({
      where: { userId: user.id, type: "PULSE", granularity: "DAY" },
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: user.id,
      log: () => {},
    });
    expect(summary.totals.perSampleRowsSoftDeleted).toBeGreaterThan(0);

    const folded = await liveRows(user.id, "GOOGLE_HEALTH");
    const pulse = folded.filter((r) => r.type === "PULSE");
    // Two hours, two hourly means; no raw sample of them is left.
    expect(pulse).toHaveLength(2);
    for (const row of pulse) {
      expect(row.externalId).toMatch(
        /^stats:HKQuantityTypeIdentifierHeartRate:\d{4}-\d{2}-\d{2}T1[01]$/,
      );
    }
    const firstHour = old.slice(0, 6).map((s) => s.bpm);
    expect(pulse[0].value).toBeCloseTo(
      firstHour.reduce((a, b) => a + b, 0) / firstHour.length,
      6,
    );
    expect(folded.filter((r) => r.type === "OXYGEN_SATURATION")).toHaveLength(
      1,
    );
    // The DAY bucket keeps the raw figures.
    const dayAfter = await prisma.measurementRollup.findFirstOrThrow({
      where: { userId: user.id, type: "PULSE", granularity: "DAY" },
    });
    expect(dayAfter.count).toBe(dayBefore.count);
    expect(dayAfter.minValue).toBe(dayBefore.minValue);
    expect(dayAfter.maxValue).toBe(dayBefore.maxValue);
    expect(dayAfter.mean).toBeCloseTo(dayBefore.mean, 9);

    // A backfill walks the same history again.
    const again = await upsertGoogleHealthMeasurements(
      user.id,
      [...old, ...recent].map(gh),
    );
    expect(again.imported).toBe(recent.length);
    const afterResync = await liveRows(user.id, "GOOGLE_HEALTH");
    expect(afterResync.filter((r) => r.type === "PULSE")).toHaveLength(
      2 + recent.length,
    );
    // The hourly means are untouched, the 10:30 one included.
    expect(
      afterResync.filter((r) => r.externalId?.startsWith("stats:")),
    ).toEqual(pulse);
  });

  it("folds old Oura heart rate the same way, and a re-read writes none of it back", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const old = samples(dayStart(150)).map((s) => ({
      bpm: s.bpm,
      timestamp: s.at.toISOString(),
      source: "awake",
    }));
    expect(
      await writeOuraHeartRatePage(user.id, old, new TouchedDays(), {
        emitArrivals: false,
      }),
    ).toBe(old.length);

    await runDenseIntradayRetention(prisma, {
      userId: user.id,
      log: () => {},
    });
    const folded = await liveRows(user.id, "OURA");
    expect(folded).toHaveLength(2);
    expect(folded.every((r) => r.externalId?.startsWith("stats:"))).toBe(true);

    expect(
      await writeOuraHeartRatePage(user.id, old, new TouchedDays(), {
        emitArrivals: false,
      }),
    ).toBe(0);
    expect(await liveRows(user.id, "OURA")).toEqual(folded);
  });

  it("leaves heart rate inside the window raw", async () => {
    const user = await makeUser({ timezone: "UTC" });
    const recent = samples(dayStart(10));
    await upsertGoogleHealthMeasurements(user.id, recent.map(gh));
    await runDenseIntradayRetention(prisma, {
      userId: user.id,
      log: () => {},
    });
    expect(await liveRows(user.id, "GOOGLE_HEALTH")).toHaveLength(
      recent.length,
    );
  });

  describe("and the change feed", () => {
    /** Drain the feed from the start; the last page's cursor. */
    async function caughtUpCursor(userId: string): Promise<string> {
      let token: string | undefined;
      for (;;) {
        const page = await pullSyncChanges({
          userId,
          token,
          limit: 500,
          serverNow: new Date(),
        });
        expect(page.cursorExpired).toBe(false);
        token = page.cursor!;
        if (!page.hasMore) return token;
      }
    }

    async function pullFrom(userId: string, token: string) {
      return pullSyncChanges({
        userId,
        token,
        limit: 500,
        serverNow: new Date(),
      });
    }

    async function syncResetAt(userId: string) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { syncResetAt: true },
      });
      return user.syncResetAt;
    }

    it("reports the nightly increment as tombstones and keeps the cursor", async () => {
      const user = await makeUser({ timezone: "UTC" });
      // Three days past the window: the day the nightly fold reaches next.
      const day = samples(dayStart(93)).map((s) => ({
        bpm: s.bpm,
        timestamp: s.at.toISOString(),
        source: "awake",
      }));
      await writeOuraHeartRatePage(user.id, day, new TouchedDays(), {
        emitArrivals: false,
      });
      const raw = await prisma.measurement.findMany({
        where: { userId: user.id, source: "OURA" },
        select: { id: true },
      });
      expect(raw).toHaveLength(day.length);
      const cursor = await caughtUpCursor(user.id);

      const summary = await runDenseIntradayRetention(prisma, {
        userId: user.id,
        log: () => {},
      });
      expect(summary.totals.syncResetsStamped).toBe(0);
      expect(await syncResetAt(user.id)).toBeNull();
      expect(
        (await liveRows(user.id, "OURA")).every((r) =>
          r.externalId?.startsWith("stats:"),
        ),
      ).toBe(true);

      const page = await pullFrom(user.id, cursor);
      expect(page.cursorExpired).toBe(false);
      const { tombstones } = page.changes.measurements;
      // The derived resting figure rides along under COMPUTED.
      const upserts = page.changes.measurements.upserts.filter(
        (u) => u.source === "OURA",
      );
      // The samples on 10:30 and 11:30 became the two hourly means; every
      // other sample arrives as a tombstone, so the client's mirror ends up
      // holding exactly the hourly means.
      expect(upserts).toHaveLength(2);
      expect(upserts.every((u) => u.externalId?.startsWith("stats:"))).toBe(
        true,
      );
      expect(tombstones).toHaveLength(day.length - 2);
      expect(
        [...tombstones.map((t) => t.id), ...upserts.map((u) => u.id)].sort(),
      ).toEqual(raw.map((r) => r.id).sort());
    });

    it("expires the cursor when a backlog day is deleted outright", async () => {
      const user = await makeUser({ timezone: "UTC" });
      await upsertGoogleHealthMeasurements(
        user.id,
        samples(dayStart(120)).map(gh),
      );
      const cursor = await caughtUpCursor(user.id);

      const summary = await runDenseIntradayRetention(prisma, {
        userId: user.id,
        log: () => {},
      });
      expect(summary.totals.syncResetsStamped).toBe(1);
      expect(await syncResetAt(user.id)).not.toBeNull();
      // No tombstone is left behind for the backlog.
      expect(
        await prisma.measurement.count({
          where: { userId: user.id, deletedAt: { not: null } },
        }),
      ).toBe(0);
      expect((await pullFrom(user.id, cursor)).cursorExpired).toBe(true);
      // A client that re-initialises catches up from a fresh cursor.
      await caughtUpCursor(user.id);
    });

    it("expires nothing for an Apple Health fold", async () => {
      const user = await makeUser({ timezone: "UTC" });
      await prisma.measurement.createMany({
        data: samples(dayStart(120)).map((s) => ({
          userId: user.id,
          type: "PULSE" as const,
          value: s.bpm,
          unit: "bpm",
          source: "APPLE_HEALTH" as const,
          measuredAt: s.at,
          externalId: `uuid-${s.at.getTime()}`,
        })),
      });
      const cursor = await caughtUpCursor(user.id);
      const summary = await runDenseIntradayRetention(prisma, {
        userId: user.id,
        log: () => {},
      });
      expect(summary.totals.daysConsolidated).toBe(1);
      expect(summary.totals.syncResetsStamped).toBe(0);
      expect(await syncResetAt(user.id)).toBeNull();
      expect((await pullFrom(user.id, cursor)).cursorExpired).toBe(false);
    });
  });
});
