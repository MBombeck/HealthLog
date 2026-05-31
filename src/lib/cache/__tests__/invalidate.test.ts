/**
 * Unit tests for the per-user invalidation helpers — every helper
 * evicts the matching `caches.*` bucket and leaves unrelated entries
 * intact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetAllCachesForTests,
  cached,
  caches,
} from "../server-cache";
import {
  invalidateAppSettings,
  invalidateUserDashboardWidgets,
  invalidateUserDashboardSnapshot,
  invalidateUserInsights,
  invalidateUserMeasurements,
  invalidateUserMedications,
  invalidateUserMood,
  dashboardSnapshotCacheKey,
} from "../invalidate";

const USER_A = "user-a";
const USER_B = "user-b";

beforeEach(() => {
  __resetAllCachesForTests();
});

afterEach(() => {
  __resetAllCachesForTests();
});

async function primeAllCaches(): Promise<void> {
  // Analytics keys carry a slice suffix; the prefix-match must include
  // the pipe so user-1 doesn't match user-10 in production traffic.
  await cached(caches.analytics, `${USER_A}|default`, async () => ({ a: 1 }));
  await cached(caches.analytics, `${USER_A}|summaries`, async () => ({ a: 2 }));
  await cached(caches.analytics, `${USER_B}|default`, async () => ({ b: 1 }));

  await cached(caches.medications, USER_A, async () => ({ m: 1 }));
  await cached(caches.medications, USER_B, async () => ({ m: 2 }));

  await cached(caches.medicationsIntake, `${USER_A}|compliance|30`, async () => ({
    c: 1,
  }));
  await cached(caches.medicationsIntake, `${USER_B}|compliance|30`, async () => ({
    c: 2,
  }));

  await cached(caches.achievements, USER_A, async () => ({ ach: 1 }));
  await cached(caches.achievements, USER_B, async () => ({ ach: 2 }));

  await cached(caches.workouts, `${USER_A}|3|0||`, async () => ({ w: 1 }));
  await cached(caches.workouts, `${USER_B}|3|0||`, async () => ({ w: 2 }));

  await cached(caches.moodAnalytics, USER_A, async () => ({ mood: 1 }));
  await cached(caches.moodAnalytics, USER_B, async () => ({ mood: 2 }));

  await cached(caches.dashboardWidgets, USER_A, async () => ({ d: 1 }));
  await cached(caches.dashboardWidgets, USER_B, async () => ({ d: 2 }));

  // v1.7.0 W6 — the unified dashboard snapshot lives under the analytics
  // bucket keyed `${userId}|dashboard-snapshot`.
  await cached(
    caches.analytics,
    dashboardSnapshotCacheKey(USER_A),
    async () => ({ snap: 1 }),
  );
  await cached(
    caches.analytics,
    dashboardSnapshotCacheKey(USER_B),
    async () => ({ snap: 2 }),
  );

  await cached(caches.bugreportStatus, "singleton", async () => ({ s: 1 }));
}

describe("invalidateUserMeasurements", () => {
  it("evicts analytics + achievements + workouts for the target user only", async () => {
    await primeAllCaches();
    invalidateUserMeasurements(USER_A);

    expect(caches.analytics.get(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.get(`${USER_A}|summaries`)).toBeNull();
    // v1.7.0 W6 — the `${userId}|` prefix sweep covers the snapshot key.
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.workouts.get(`${USER_A}|3|0||`)).toBeNull();

    // User B's caches untouched.
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();
    expect(
      caches.analytics.get(dashboardSnapshotCacheKey(USER_B)),
    ).not.toBeNull();
    expect(caches.achievements.get(USER_B)).not.toBeNull();
    expect(caches.workouts.get(`${USER_B}|3|0||`)).not.toBeNull();

    // Mood-analytics not touched by a measurement write.
    expect(caches.moodAnalytics.get(USER_A)).not.toBeNull();
  });
});

describe("invalidateUserMood", () => {
  it("evicts mood-analytics + achievements + analytics", async () => {
    await primeAllCaches();
    invalidateUserMood(USER_A);

    expect(caches.moodAnalytics.get(USER_A)).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(caches.moodAnalytics.get(USER_B)).not.toBeNull();
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();
  });
});

describe("invalidateUserMedications", () => {
  it("evicts medications + medications-intake + achievements", async () => {
    await primeAllCaches();
    invalidateUserMedications(USER_A);

    expect(caches.medications.get(USER_A)).toBeNull();
    expect(caches.medicationsIntake.get(`${USER_A}|compliance|30`)).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    // v1.7.0 W6 — medication writes sweep the analytics bucket, which
    // covers the snapshot key.
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(caches.medications.get(USER_B)).not.toBeNull();
    expect(caches.medicationsIntake.get(`${USER_B}|compliance|30`)).not.toBeNull();
  });
});

describe("invalidateUserDashboardWidgets", () => {
  it("evicts the dashboardWidgets bucket + the snapshot key for the target user", async () => {
    await primeAllCaches();
    invalidateUserDashboardWidgets(USER_A);
    expect(caches.dashboardWidgets.get(USER_A)).toBeNull();
    expect(caches.dashboardWidgets.get(USER_B)).not.toBeNull();
    // v1.7.0 W6 — the layout rides inside the snapshot now, so a tile
    // reorder must drop the snapshot too. The widget invalidator does
    // NOT sweep the whole analytics bucket, so the slim/default cells
    // stay warm — only the point-keyed snapshot is dropped.
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
    expect(
      caches.analytics.get(dashboardSnapshotCacheKey(USER_B)),
    ).not.toBeNull();
  });
});

describe("invalidateUserDashboardSnapshot", () => {
  it("drops only the snapshot key, leaving the slim / default analytics cells warm", async () => {
    await primeAllCaches();
    invalidateUserDashboardSnapshot(USER_A);
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
    expect(caches.analytics.get(`${USER_A}|summaries`)).not.toBeNull();
    expect(
      caches.analytics.get(dashboardSnapshotCacheKey(USER_B)),
    ).not.toBeNull();
  });
});

describe("invalidateUserInsights", () => {
  it("drops the snapshot key so a fresh briefing is re-embedded", async () => {
    await primeAllCaches();
    invalidateUserInsights(USER_A);
    expect(caches.analytics.get(dashboardSnapshotCacheKey(USER_A))).toBeNull();
    expect(
      caches.analytics.get(dashboardSnapshotCacheKey(USER_B)),
    ).not.toBeNull();
  });
});

describe("invalidateAppSettings", () => {
  it("evicts the entire bug-report status cache (singleton row)", async () => {
    await primeAllCaches();
    invalidateAppSettings();
    expect(caches.bugreportStatus.get("singleton")).toBeNull();
    // Per-user caches untouched.
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
  });
});
