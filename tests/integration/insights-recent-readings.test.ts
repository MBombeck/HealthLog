/**
 * The overview's per-type latest-readings query against Postgres: a dense
 * stream is bounded on its own and cannot crowd a sparse type out, deleted
 * rows stay out, and the rows come back oldest first.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { readLatestReadingsPerType } from "@/lib/insights/recent-readings";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("readLatestReadingsPerType", () => {
  it("bounds each type on its own", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: { username: "recent-per-type", email: "rpt@example.test" },
    });
    const now = Date.now();
    const base = {
      userId: user.id,
      source: "APPLE_HEALTH" as const,
    };
    await prisma.measurement.createMany({
      data: [
        // 6 000 pulse readings a minute apart: a few days of a watch.
        ...Array.from({ length: 6000 }, (_, i) => ({
          ...base,
          type: "PULSE" as const,
          value: 60 + (i % 20),
          unit: "bpm",
          measuredAt: new Date(now - i * 60_000),
        })),
        // Weight once a week for a year, the newest one deleted.
        ...Array.from({ length: 52 }, (_, i) => ({
          ...base,
          source: "MANUAL" as const,
          type: "WEIGHT" as const,
          value: 80,
          unit: "kg",
          measuredAt: new Date(now - i * 7 * 86_400_000),
          deletedAt: i === 0 ? new Date() : null,
        })),
      ],
    });

    const rows = await readLatestReadingsPerType(
      user.id,
      ["PULSE", "WEIGHT", "BODY_FAT"],
      "UTC",
      new Date(now),
      365,
    );
    const byType = (t: string) => rows.filter((r) => r.type === t);
    // The newest 365 pulse readings span six hours, so the last 30 days are
    // read instead: every one of the 6 000, under the dense cap.
    expect(byType("PULSE")).toHaveLength(6000);
    expect(byType("WEIGHT")).toHaveLength(51);
    expect(byType("BODY_FAT")).toHaveLength(0);
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].measuredAt >= rows[i - 1].measuredAt).toBe(true);
    }
    // The newest pulse reading is in, and so is the oldest of the 6 000.
    expect(byType("PULSE").at(-1)!.measuredAt.getTime()).toBe(now);
    expect(byType("PULSE")[0].measuredAt.getTime()).toBe(now - 5999 * 60_000);
  });
});
