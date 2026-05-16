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
  invalidateUserMeasurements,
  invalidateUserMedications,
  invalidateUserMood,
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

  await cached(caches.bugreportStatus, "singleton", async () => ({ s: 1 }));
}

describe("invalidateUserMeasurements", () => {
  it("evicts analytics + achievements + workouts for the target user only", async () => {
    await primeAllCaches();
    invalidateUserMeasurements(USER_A);

    expect(caches.analytics.get(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.get(`${USER_A}|summaries`)).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.workouts.get(`${USER_A}|3|0||`)).toBeNull();

    // User B's caches untouched.
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();
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
    expect(caches.medications.get(USER_B)).not.toBeNull();
    expect(caches.medicationsIntake.get(`${USER_B}|compliance|30`)).not.toBeNull();
  });
});

describe("invalidateUserDashboardWidgets", () => {
  it("evicts only the dashboardWidgets bucket for the target user", async () => {
    await primeAllCaches();
    invalidateUserDashboardWidgets(USER_A);
    expect(caches.dashboardWidgets.get(USER_A)).toBeNull();
    expect(caches.dashboardWidgets.get(USER_B)).not.toBeNull();
    // Sibling caches untouched.
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
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
