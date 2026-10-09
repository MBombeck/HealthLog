/**
 * `hadFindingsBeforeSeasonalAdjustment` against a real pattern store.
 *
 * The flag decides who sees the one-time note on the correlation surface, so
 * it must hold only for a record that kept a discovery pattern from before the
 * engine change. The change is located by the instance's own marker
 * (`AppSettings.correlationSeasonalEngineSince`), which the first discovery
 * sync of the new engine stamps before it writes, not by a calendar date.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  canonicalPatternKey,
  hadFindingsBeforeSeasonalAdjustment,
  PATTERN_FAMILIES,
  resetSeasonalEngineStampForTests,
  syncAcceptedPatterns,
} from "@/lib/insights/correlation-patterns";
import {
  buildProfileBackupSection,
  restoreProfileData,
} from "@/lib/export/profile-backup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKER = new Date("2026-10-08T00:00:00.000Z");
const BEFORE = new Date(MARKER.getTime() - 30 * DAY_MS);
const AFTER = new Date(MARKER.getTime() + DAY_MS);

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
      canonicalKey: canonicalPatternKey(`FACTOR_${seq}`, "MOOD", 1),
      family,
      factorKey: `FACTOR_${seq}`,
      outcomeKey: "MOOD",
      lagDays: 1,
      sampleSize: 60,
      effectSize: 0.4,
      pValue: 0.001,
      qValue: 0.01,
      evidenceHash: "a".repeat(64),
      lastComputedAt: createdAt,
      createdAt,
    },
  });
}

async function setMarker(at: Date | null) {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", correlationSeasonalEngineSince: at },
    update: { correlationSeasonalEngineSince: at },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  resetSeasonalEngineStampForTests();
});

describe("hadFindingsBeforeSeasonalAdjustment", () => {
  it("counts every existing discovery pattern while the instance has no marker", async () => {
    const user = await seedUser();
    // Written by the earlier engine right up to the deploy: no fixed date
    // may exclude it.
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, AFTER);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("holds for a record with a discovery pattern stored before the marker", async () => {
    await setMarker(MARKER);
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, BEFORE);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("holds for an early-detection pattern stored before the marker", async () => {
    await setMarker(MARKER);
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRecent, BEFORE);
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("does not hold for a pattern first stored after the marker", async () => {
    await setMarker(MARKER);
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

describe("the first discovery sync of the new engine", () => {
  const evidence = {
    factorKey: "ACTIVITY_STEPS",
    outcomeKey: "SLEEP_DURATION",
    lagDays: 0,
    sampleSize: 90,
    effectSize: 0.35,
    pValue: 0.002,
    qValue: 0.02,
  };

  it("stamps the marker before it writes, once", async () => {
    const earlier = await seedUser();
    await seedPattern(
      earlier.id,
      PATTERN_FAMILIES.discoveryRetrospective,
      BEFORE,
    );
    const fresh = await seedUser();

    await syncAcceptedPatterns({
      userId: fresh.id,
      family: PATTERN_FAMILIES.discoveryRetrospective,
      accepted: [evidence],
    });

    const settings = await getPrismaClient().appSettings.findUnique({
      where: { id: "singleton" },
    });
    const stamp = settings?.correlationSeasonalEngineSince;
    expect(stamp).toBeInstanceOf(Date);
    // The new engine's own finding is not an earlier one; the old one is.
    expect(await hadFindingsBeforeSeasonalAdjustment(fresh.id)).toBe(false);
    expect(await hadFindingsBeforeSeasonalAdjustment(earlier.id)).toBe(true);

    // A later run (another process) leaves the first stamp standing.
    resetSeasonalEngineStampForTests();
    await syncAcceptedPatterns({
      userId: fresh.id,
      family: PATTERN_FAMILIES.discoveryRecent,
      accepted: [evidence],
    });
    const again = await getPrismaClient().appSettings.findUnique({
      where: { id: "singleton" },
    });
    expect(again?.correlationSeasonalEngineSince?.toISOString()).toBe(
      stamp?.toISOString(),
    );
  });

  it("is not triggered by a non-discovery family", async () => {
    const user = await seedUser();
    await syncAcceptedPatterns({
      userId: user.id,
      family: PATTERN_FAMILIES.fixed,
      accepted: [evidence],
    });
    const settings = await getPrismaClient().appSettings.findUnique({
      where: { id: "singleton" },
    });
    expect(settings?.correlationSeasonalEngineSince ?? null).toBeNull();
  });
});

describe("a restore", () => {
  it("keeps when a finding was first made, so the note survives it", async () => {
    await setMarker(MARKER);
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, BEFORE);
    const prisma = getPrismaClient();

    // The portable export is the one that used to drop `createdAt`.
    const section = await buildProfileBackupSection(prisma, user.id, {
      purpose: "portable-export",
    });
    expect(section.correlationPatterns[0]?.createdAt).toBe(
      BEFORE.toISOString(),
    );

    await prisma.$transaction((tx) =>
      restoreProfileData(tx, user.id, {
        healthProfile: section.healthProfile,
        healthProfileFacts: section.healthProfileFacts,
        customMetrics: section.customMetrics,
        correlationPatterns: section.correlationPatterns,
      }),
    );

    const restored = await prisma.correlationPattern.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(restored.createdAt.toISOString()).toBe(BEFORE.toISOString());
    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });

  it("falls back to the last computation for a file without createdAt", async () => {
    await setMarker(MARKER);
    const user = await seedUser();
    await seedPattern(user.id, PATTERN_FAMILIES.discoveryRetrospective, BEFORE);
    const prisma = getPrismaClient();
    const section = await buildProfileBackupSection(prisma, user.id);
    const legacy = section.correlationPatterns.map((pattern) => {
      const copy = { ...pattern };
      delete copy.createdAt;
      return copy;
    });

    await prisma.$transaction((tx) =>
      restoreProfileData(tx, user.id, {
        healthProfile: section.healthProfile,
        healthProfileFacts: section.healthProfileFacts,
        customMetrics: section.customMetrics,
        correlationPatterns: legacy,
      }),
    );

    expect(await hadFindingsBeforeSeasonalAdjustment(user.id)).toBe(true);
  });
});
