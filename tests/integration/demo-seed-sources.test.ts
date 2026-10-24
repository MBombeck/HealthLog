/**
 * The demo seed tags each reading with the source that writes it on a real
 * account. The measurements list badges every row that is not MANUAL, and
 * Settings > Sources ranks the sources an account holds, so a reading tagged
 * MANUAL showed no badge while the ladder named Withings for the same metric,
 * and a reading tagged with a source that cannot write its type was a claim
 * no real account could make.
 *
 * This runs the real `scripts/seed-demo.ts` against the test database and
 * holds every Withings and Apple Health row against the type maps those
 * integrations ingest through.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { APPLE_HEALTH_TYPE_MAP } from "@/lib/measurements/apple-health-mapping";
import { MEASURE_TYPE_MAP } from "@/lib/withings/client";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const WITHINGS_TYPES = new Set(
  Object.values(MEASURE_TYPE_MAP).map((m) => m.type),
);
const APPLE_HEALTH_TYPES = new Set<string>(
  Object.values(APPLE_HEALTH_TYPE_MAP).map((m) => m.measurementType),
);

let userId: string;

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { seed } = await import("../../scripts/seed-demo");
  await seed();
  const user = await prisma.user.findUniqueOrThrow({
    where: { username: "demo" },
    select: { id: true },
  });
  userId = user.id;
}, 180_000);

async function typesBySource(source: "WITHINGS" | "APPLE_HEALTH") {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId, source, deletedAt: null },
    select: { type: true },
    distinct: ["type"],
  });
  return rows.map((r) => String(r.type));
}

describe("demo seed, reading sources", () => {
  it("tags Withings rows only with types the Withings sync writes", async () => {
    const types = await typesBySource("WITHINGS");
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((t) => !WITHINGS_TYPES.has(t))).toEqual([]);
  });

  it("tags Apple Health rows only with types the Apple Health ingest maps", async () => {
    const types = await typesBySource("APPLE_HEALTH");
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((t) => !APPLE_HEALTH_TYPES.has(t))).toEqual([]);
  });

  it("carries a device source on the newest reading of every synced vital", async () => {
    const prisma = getPrismaClient();
    const expected: Record<string, string> = {
      WEIGHT: "WITHINGS",
      BLOOD_PRESSURE_SYS: "WITHINGS",
      BLOOD_PRESSURE_DIA: "WITHINGS",
      PULSE: "WITHINGS",
      BODY_FAT: "WITHINGS",
      RESTING_HEART_RATE: "APPLE_HEALTH",
      SLEEP_DURATION: "APPLE_HEALTH",
      ACTIVITY_STEPS: "APPLE_HEALTH",
    };
    const newest: Record<string, string> = {};
    for (const type of Object.keys(expected)) {
      const row = await prisma.measurement.findFirstOrThrow({
        where: {
          userId,
          type: type as never,
          deletedAt: null,
          sleepStage: null,
        },
        orderBy: { measuredAt: "desc" },
        select: { source: true },
      });
      newest[type] = row.source;
    }
    expect(newest).toEqual(expected);
  });

  it("writes no hand-entered weight or blood pressure inside the 90-day window", async () => {
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const manual = await getPrismaClient().measurement.count({
      where: {
        userId,
        source: "MANUAL",
        deletedAt: null,
        measuredAt: { gte: since },
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA", "PULSE"],
        },
      },
    });
    expect(manual).toBe(0);
  });
});
