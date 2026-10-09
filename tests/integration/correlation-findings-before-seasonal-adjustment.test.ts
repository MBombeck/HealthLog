/**
 * `hadFindingsBeforeSeasonalAdjustment` against a real pattern store.
 *
 * The flag decides who sees the one-time note on the correlation surface, so
 * it must hold only for a record that kept a discovery pattern from before the
 * engine change: not for a pattern written since, not for another account's
 * old pattern, and not for a non-discovery family.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  hadFindingsBeforeSeasonalAdjustment,
  PATTERN_FAMILIES,
  SEASONAL_ADJUSTMENT_SINCE,
} from "@/lib/insights/correlation-patterns";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const BEFORE = new Date(SEASONAL_ADJUSTMENT_SINCE.getTime() - 30 * DAY_MS);
const AFTER = new Date(SEASONAL_ADJUSTMENT_SINCE.getTime() + DAY_MS);

let seq = 0;
async function seedUser() {
  seq += 1;
  return getPrismaClient().user.create({
    data: {
      username: `corr-before-adjust-${seq}`,
      email: `corr-before-adjust-${seq}@example.test`,
      role: "USER",
    },
  });
}

async function seedPattern(userId: string, family: string, createdAt: Date) {
  seq += 1;
  await getPrismaClient().correlationPattern.create({
    data: {
      userId,
      canonicalKey: `p1:test-${seq}`,
      family,
      factorKey: "ACTIVITY_STEPS",
      outcomeKey: "MOOD",
      lagDays: 1,
      sampleSize: 60,
      effectSize: 0.4,
      pValue: 0.001,
      qValue: 0.01,
      evidenceHash: `hash-${seq}`,
      lastComputedAt: createdAt,
      createdAt,
    },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("hadFindingsBeforeSeasonalAdjustment", () => {
  it("holds for a record with a discovery pattern stored before the change", async () => {
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, BEFORE);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("holds for an early-detection pattern stored before the change", async () => {
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRecent, BEFORE);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("does not hold for a pattern first stored after the change", async () => {
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, AFTER);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(false);
  });

  it("does not hold for a non-discovery family or another account's pattern", async () => {
    const user = await seedUser();
    const other = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.moodTagCrosstab, BEFORE);
    await seedPattern(
      other.id,
      PATTERN_FAMILIES.discoveryRetrospective,
      BEFORE,
    );
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(false);
  });

  it("does not hold for an account with no patterns", async () => {
    const user = await seedUser();
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(false);
  });
});
