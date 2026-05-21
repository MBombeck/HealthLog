/**
 * v1.4.40 W-DELETED — soft-delete invisibility across every reader tier.
 *
 * `Measurement.deletedAt` was set by the iOS sync path but ignored by
 * every read path (Senior Infra+DB audit Critical Finding #3 in
 * `.planning/round-v1439-arch-qa-infra-db.md`). The moment iOS soft-
 * deleted its first reading, the tombstoned row would still contribute
 * to dashboards, analytics fan-outs, the rollup populator's count, and
 * the Coach snapshot the model grounds against.
 *
 * This test pins the tombstone-invisibility contract end-to-end against
 * the real Postgres testcontainer. Three tiers are covered:
 *
 *   1. **Analytics summaries slice** — the rollup-fresh path's narrow
 *      aggregate + DISTINCT ON latest reads MUST exclude the soft-
 *      deleted row. The slim slice runs the live aggregator on this
 *      fixture (no rollup coverage yet) so the cold-fallback path is
 *      exercised in the same call.
 *
 *   2. **Dashboard summary** — the per-type `groupBy` aggregate +
 *      `latestIn7d` DISTINCT ON + streak-day raw SQL all need the
 *      filter. The fixture parks one soft-deleted row inside the 7-day
 *      window so the iOS Dashboard tile-strip can be checked for
 *      tombstone leakage.
 *
 *   3. **Rollup recompute** — `recomputeBucketsForMeasurement` must
 *      build the DAY bucket from live (non-deleted) rows only. The
 *      fixture seeds three same-day rows, soft-deletes one, recomputes,
 *      and asserts `count == 2` (not 3) on the resulting bucket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { recomputeBucketsForMeasurement } from "@/lib/rollups/measurement-rollups";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

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
  headerJar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedSession(username: string) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@example.test`,
      role: "USER",
    },
  });
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  cookieJar.set("healthlog_session", session.id);
  return user;
}

describe("Measurement.deletedAt — tombstone invisibility (v1.4.40 W-DELETED)", () => {
  it("excludes soft-deleted measurements from the analytics summaries slice", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("soft-delete-analytics");

    // Three same-type WEIGHT readings; the middle one (value 99) is the
    // tombstone that must NOT contribute to count / min / max / mean.
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 86_400_000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: twoDaysAgo,
        },
        {
          userId: user.id,
          type: "WEIGHT",
          // Out-of-band sentinel — the test fails loudly if this row
          // leaks into any aggregate (it would crash min/max + skew the
          // mean by a huge margin).
          value: 99.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: oneDayAgo,
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.2,
          unit: "kg",
          source: "MANUAL",
          measuredAt: now,
        },
      ],
    });

    // Tombstone the middle row.
    await prisma.measurement.updateMany({
      where: { userId: user.id, value: 99.0 },
      data: { deletedAt: new Date() },
    });

    const { GET } = await import("@/app/api/analytics/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/analytics?slice=summaries"));

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      data: {
        summaries: Record<
          string,
          { count: number; latest: number | null; min: number | null; max: number | null; mean: number | null }
        >;
      };
    };
    const weight = envelope.data.summaries.WEIGHT;

    // The 99.0 sentinel must not contribute to any aggregate field.
    expect(weight.count).toBe(2);
    expect(weight.latest).toBeCloseTo(80.2, 2);
    expect(weight.min).toBeCloseTo(80.0, 2);
    expect(weight.max).toBeCloseTo(80.2, 2);
    expect(weight.mean).toBeCloseTo(80.1, 2);
  });

  it("excludes soft-deleted measurements from the dashboard summary", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("soft-delete-dashboard");

    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 86_400_000);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: oneDayAgo,
        },
        {
          userId: user.id,
          // Most-recent row by wall-clock — if the tombstone leaks the
          // tile's `latestValue` would surface 99.0 here.
          type: "WEIGHT",
          value: 99.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: sixHoursAgo,
        },
      ],
    });

    await prisma.measurement.updateMany({
      where: { userId: user.id, value: 99.0 },
      data: { deletedAt: new Date() },
    });

    const { GET } = await import("@/app/api/dashboard/summary/route");
    const response = await (
      GET as unknown as (req: Request) => Promise<Response>
    )(new Request("http://localhost/api/dashboard/summary"));

    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      data: {
        metrics: Array<{
          kind: string;
          latestValue: number | null;
          allTimeCount: number;
        }>;
      };
    };

    const weightTile = envelope.data.metrics.find((m) => m.kind === "weight");
    expect(weightTile).toBeDefined();
    // Live row (80.0) is the only reading the tile sees; the 99.0
    // tombstone must not leak into the latest value or the all-time
    // count.
    expect(weightTile!.latestValue).toBeCloseTo(80.0, 2);
    expect(weightTile!.allTimeCount).toBe(1);
  });

  it("recomputeBucketsForMeasurement produces count=2 not 3 with one soft-deleted row", async () => {
    const prisma = getPrismaClient();
    const user = await seedSession("soft-delete-rollup");

    // Three readings inside the same UTC calendar day. The middle one
    // is tombstoned; the resulting DAY bucket must reflect only two
    // live readings.
    const noonUtc = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
        12,
        0,
        0,
      ),
    );
    const elevenUtc = new Date(noonUtc.getTime() - 60 * 60 * 1000);
    const thirteenUtc = new Date(noonUtc.getTime() + 60 * 60 * 1000);

    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: elevenUtc,
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 99.0,
          unit: "kg",
          source: "MANUAL",
          measuredAt: noonUtc,
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80.4,
          unit: "kg",
          source: "MANUAL",
          measuredAt: thirteenUtc,
        },
      ],
    });

    await prisma.measurement.updateMany({
      where: { userId: user.id, value: 99.0 },
      data: { deletedAt: new Date() },
    });

    await recomputeBucketsForMeasurement(user.id, "WEIGHT", noonUtc);

    const dayStartUtc = new Date(
      Date.UTC(
        noonUtc.getUTCFullYear(),
        noonUtc.getUTCMonth(),
        noonUtc.getUTCDate(),
      ),
    );
    const bucket = await prisma.measurementRollup.findUnique({
      where: {
        userId_type_granularity_bucketStart: {
          userId: user.id,
          type: "WEIGHT",
          granularity: "DAY",
          bucketStart: dayStartUtc,
        },
      },
    });
    expect(bucket).not.toBeNull();
    expect(bucket!.count).toBe(2);
    // Mean over the two live rows = (80.0 + 80.4) / 2 = 80.2. If the
    // tombstone leaked the mean would land at ~86.5 — the assertion
    // fails loudly.
    expect(bucket!.mean).toBeCloseTo(80.2, 2);
    expect(bucket!.minValue).toBeCloseTo(80.0, 2);
    expect(bucket!.maxValue).toBeCloseTo(80.4, 2);
  });
});
