/**
 * The dashboard's second phase (blood-pressure in target, the per-context
 * glucose tiles, the Health Score) waits until the rollup tier covers the
 * types it reads: weight, both blood-pressure halves and steps. The fold only
 * ever writes buckets inside `ROLLUP_FOLD_WINDOW_MS`, by design, so a type
 * whose every reading is older than that can never be covered. Counting it as
 * "not yet covered" held the phase back for good: an account that imported
 * years-old blood pressure and nothing since lost its glucose tiles, its
 * in-target figure and its score, with nothing to say why.
 *
 * Real Postgres, real fold, real builder.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

import { buildDashboardSnapshot } from "@/lib/dashboard/snapshot";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

async function seed(options: { recentBloodPressure: boolean }) {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "pre-window-types",
      email: "pre-window-types@example.test",
      role: "USER",
      timezone: "Europe/Berlin",
    },
  });
  const now = Date.now();
  const beforeWindow = new Date(now - ROLLUP_FOLD_WINDOW_MS - 400 * DAY_MS);
  const bpAt = options.recentBloodPressure
    ? new Date(now - 2 * DAY_MS)
    : beforeWindow;

  await prisma.measurement.createMany({
    data: [
      {
        userId: user.id,
        type: "WEIGHT",
        value: 78,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(now - DAY_MS),
      },
      {
        userId: user.id,
        type: "BLOOD_PRESSURE_SYS",
        value: 118,
        unit: "mmHg",
        source: "APPLE_HEALTH",
        measuredAt: bpAt,
      },
      {
        userId: user.id,
        type: "BLOOD_PRESSURE_DIA",
        value: 76,
        unit: "mmHg",
        source: "APPLE_HEALTH",
        measuredAt: bpAt,
      },
      {
        userId: user.id,
        type: "ACTIVITY_STEPS",
        value: 8421,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: beforeWindow,
      },
      {
        userId: user.id,
        type: "BLOOD_GLUCOSE",
        value: 95,
        unit: "mg/dL",
        source: "MANUAL",
        measuredAt: new Date(now - DAY_MS),
        glucoseContext: "FASTING",
      },
    ],
  });
  // The fold every path runs: the trailing window, nothing older.
  await recomputeUserRollups(user.id);
  return user;
}

function snapshotFor(user: Awaited<ReturnType<typeof seed>>) {
  return buildDashboardSnapshot(
    getPrismaClient(),
    {
      id: user.id,
      username: user.username,
      displayName: null,
      timezone: user.timezone,
      heightCm: null,
      dateOfBirth: null,
      gender: null,
      glucoseUnit: null,
      onboardingTourCompleted: true,
      insightsCachedText: null,
      insightsCachedAt: null,
      insightsCachedLocale: null,
      dashboardWidgetsJson: null,
      thresholdsJson: null,
      healthScoreConfigJson: null,
    },
    { hasProvider: async () => false },
  );
}

describe("dashboard snapshot with readings older than the fold window", () => {
  it("does not hold the second phase back for types the fold can never cover", async () => {
    const user = await seed({ recentBloodPressure: false });

    // The premise: the old types really have no buckets, and never will.
    const buckets = await getPrismaClient().measurementRollup.findMany({
      where: { userId: user.id, granularity: "DAY" },
      select: { type: true },
    });
    const covered = new Set(buckets.map((b) => b.type));
    expect(covered.has("BLOOD_PRESSURE_SYS")).toBe(false);
    expect(covered.has("ACTIVITY_STEPS")).toBe(false);
    expect(covered.has("WEIGHT")).toBe(true);

    const snap = await snapshotFor(user);

    expect(snap.extras).not.toBeNull();
    expect(snap.extras?.glucoseByContext.FASTING?.count).toBe(1);
    // The old readings are still the account's: the tile strip reports them.
    expect(snap.tiles.summaries.BLOOD_PRESSURE_SYS?.latest).toBe(118);
  });

  it("still waits while a type inside the window has no buckets yet", async () => {
    const user = await seed({ recentBloodPressure: true });
    // A reading the fold has not reached yet: inside the window, no bucket.
    await getPrismaClient().measurementRollup.deleteMany({
      where: { userId: user.id, type: "BLOOD_PRESSURE_SYS" },
    });

    const snap = await snapshotFor(user);

    expect(snap.extras).toBeNull();
  });
});
