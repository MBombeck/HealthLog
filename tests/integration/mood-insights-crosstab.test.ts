/**
 * v1.12.0 — tag × health-metric crosstab over the real DB read path.
 *
 * Seeds a user with structured-tagged mood entries and ACTIVE_ENERGY_BURNED
 * measurements, then asserts `fetchMoodAggregates` (the production read +
 * orchestration used by `GET /api/mood/insights`) returns a populated
 * `tagMetricCrosstab` row with the expected delta + display unit + lag mode.
 * Exercises the widened measurement `type: { in: [...] }` filter and the
 * structured-tag join end-to-end against Postgres.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { fetchMoodAggregates } from "@/lib/insights/mood-aggregates";

const TEST_USER_ID = "user-crosstab";
const dayMs = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T12:00:00.000Z");

function dayKey(offset: number): string {
  return new Date(NOW.getTime() - offset * dayMs).toISOString().slice(0, 10);
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id: TEST_USER_ID,
      username: "crosstab",
      email: "crosstab@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("mood-insights tag × metric crosstab (DB read path)", () => {
  it("surfaces a structured tag × ACTIVE_ENERGY_BURNED same-day association", async () => {
    const prisma = getPrismaClient();

    // The structured-tag catalog is seeded by migrations (0118/0119) and is
    // NOT truncated between tests — use an existing catalog tag rather than
    // minting one (its `key` is globally unique).
    const tag = await prisma.moodTag.findFirst({
      include: { category: true },
      orderBy: { key: "asc" },
    });
    expect(tag).toBeTruthy();

    // 12 tag-present days with high active energy, 12 tag-absent with low.
    for (let i = 0; i < 24; i++) {
      const present = i < 12;
      const ts = new Date(NOW.getTime() - i * dayMs);
      const moodEntry = await prisma.moodEntry.create({
        data: {
          userId: TEST_USER_ID,
          date: dayKey(i),
          mood: "GUT",
          score: present ? 4 : 3,
          source: "WEB",
          moodLoggedAt: ts,
          ...(present
            ? { tagLinks: { create: [{ moodTagId: tag!.id }] } }
            : {}),
        },
      });
      expect(moodEntry.id).toBeTruthy();
      await prisma.measurement.create({
        data: {
          userId: TEST_USER_ID,
          type: "ACTIVE_ENERGY_BURNED",
          value: present
            ? 600 + (i % 2 === 0 ? 20 : -20)
            : 350 + (i % 2 === 0 ? 20 : -20),
          unit: "kcal",
          source: "APPLE_HEALTH",
          measuredAt: ts,
          externalId: `stats:HKQuantityTypeIdentifierActiveEnergyBurned:${dayKey(i)}`,
        },
      });
    }

    const aggregates = await fetchMoodAggregates(TEST_USER_ID, NOW);
    const row = aggregates.tagMetricCrosstab.find(
      (r) => r.tag === tag!.key && r.metricKey === "activeEnergy",
    );

    expect(row).toBeDefined();
    expect(row!.display).toBe("kcal");
    expect(row!.mode).toBe("sameDay");
    expect(row!.labelKey).toBe(tag!.labelKey);
    expect(row!.categoryKey).toBe(tag!.category.key);
    expect(row!.withDays).toBe(12);
    expect(row!.withoutDays).toBe(12);
    expect(row!.withAvg).toBeCloseTo(600, 0);
    expect(row!.withoutAvg).toBeCloseTo(350, 0);
    expect(row!.delta).toBeGreaterThan(0);
    expect(row!.confidence).toBe("high");
    expect(row!.qValue).toBeLessThanOrEqual(0.1);
  });

  // v1.12.1 — cross-source double-count guard over the real read path. Two
  // sources (Apple + Fitbit) report the same active-energy total each present
  // day; the read's canonical-source pick must keep one (Apple, per the
  // activeEnergy ladder) so the per-day sum is ~600, not ~1200.
  it("counts active energy once when Apple + Fitbit report the same day", async () => {
    const prisma = getPrismaClient();
    const tag = await prisma.moodTag.findFirst({
      include: { category: true },
      orderBy: { key: "asc" },
    });
    expect(tag).toBeTruthy();

    for (let i = 0; i < 24; i++) {
      const present = i < 12;
      const ts = new Date(NOW.getTime() - i * dayMs);
      await prisma.moodEntry.create({
        data: {
          userId: TEST_USER_ID,
          date: dayKey(i),
          mood: "GUT",
          score: present ? 4 : 3,
          source: "WEB",
          moodLoggedAt: ts,
          ...(present
            ? { tagLinks: { create: [{ moodTagId: tag!.id }] } }
            : {}),
        },
      });
      const value = present
        ? 600 + (i % 2 === 0 ? 20 : -20)
        : 350 + (i % 2 === 0 ? 20 : -20);
      // Apple stream every day.
      await prisma.measurement.create({
        data: {
          userId: TEST_USER_ID,
          type: "ACTIVE_ENERGY_BURNED",
          value,
          unit: "kcal",
          source: "APPLE_HEALTH",
          measuredAt: ts,
          externalId: `apple:${dayKey(i)}`,
        },
      });
      // Fitbit twin on the present days — must NOT add on top of Apple's total.
      if (present) {
        await prisma.measurement.create({
          data: {
            userId: TEST_USER_ID,
            type: "ACTIVE_ENERGY_BURNED",
            value,
            unit: "kcal",
            source: "FITBIT",
            measuredAt: ts,
            externalId: `fitbit:${dayKey(i)}`,
          },
        });
      }
    }

    const aggregates = await fetchMoodAggregates(TEST_USER_ID, NOW);
    const row = aggregates.tagMetricCrosstab.find(
      (r) => r.tag === tag!.key && r.metricKey === "activeEnergy",
    );
    expect(row).toBeDefined();
    // ~600 (Apple wins), NOT ~1200 (Apple + Fitbit double-counted).
    expect(row!.withAvg).toBeCloseTo(600, 0);
    expect(row!.withoutAvg).toBeCloseTo(350, 0);
    expect(row!.delta).toBeCloseTo(250, 0);
  });
});
