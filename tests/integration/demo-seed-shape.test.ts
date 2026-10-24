/**
 * The demo's short-window charts need a shape to show. Every 90-day series in
 * the seed is a mean-reverting walk, and around a settled target that is flat
 * noise: a 7-day trend line over the last 30 days of blood pressure drew a
 * straight line, which is exactly the view the demo exists to show off. The
 * seed now carries a busy stretch a few weeks back that lifts blood pressure
 * and lets it settle again.
 *
 * This runs the real `scripts/seed-demo.ts` and holds the last 30 days of
 * systolic readings to two things at once: the 7-day mean moves visibly, and
 * today's reading has come back down from the stretch. Before the stretch the
 * swing measured 2 to 3 mmHg; with it, about 8 to 14. The seed is random, so the
 * bounds sit between the two rather than at either.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

let systolic: number[];
let means: number[];

beforeAll(async () => {
  const prisma = getPrismaClient();
  await truncateAllTables(prisma);
  const { seed } = await import("../../scripts/seed-demo");
  await seed();
  const user = await prisma.user.findUniqueOrThrow({
    where: { username: "demo" },
    select: { id: true },
  });
  const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: "BLOOD_PRESSURE_SYS",
      source: "WITHINGS",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    select: { value: true },
  });
  systolic = rows.map((r) => Number(r.value));
  means = [];
  for (let i = 6; i < systolic.length; i++) {
    const week = systolic.slice(i - 6, i + 1);
    means.push(week.reduce((a, b) => a + b, 0) / week.length);
  }
}, 180_000);

describe("demo seed, short-window shape", () => {
  it("gives the 7-day systolic mean over 30 days a visible rise and fall", () => {
    expect(systolic.length).toBeGreaterThanOrEqual(28);
    const swing = Math.max(...means) - Math.min(...means);
    expect(swing).toBeGreaterThanOrEqual(6);
  });

  it("brings today's systolic reading back down from the stretch", () => {
    expect(systolic.at(-1)).toBeLessThanOrEqual(Math.max(...means) - 3);
  });
});
