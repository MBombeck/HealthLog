/**
 * Unit tests for the per-user invalidation helpers — every helper
 * evicts the matching `caches.*` bucket and leaves unrelated entries
 * intact.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __resetAllCachesForTests, cached, caches } from "../server-cache";
import {
  invalidateUserDashboardWidgets,
  invalidateUserDashboardSnapshot,
  invalidateUserInsights,
  invalidateUserMeasurements,
  invalidateUserMedications,
  invalidateUserMood,
  invalidateUserProfile,
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

  await cached(
    caches.medicationsIntake,
    `${USER_A}|compliance|30`,
    async () => ({
      c: 1,
    }),
  );
  await cached(
    caches.medicationsIntake,
    `${USER_B}|compliance|30`,
    async () => ({
      c: 2,
    }),
  );

  // v1.15.20 — per-medication compliance payload cache.
  await cached(
    caches.medicationCompliance,
    `${USER_A}|med-1|compliance`,
    async () => ({ mc: 1 }),
  );
  await cached(
    caches.medicationCompliance,
    `${USER_B}|med-1|compliance`,
    async () => ({ mc: 2 }),
  );

  await cached(caches.achievements, USER_A, async () => ({ ach: 1 }));
  await cached(caches.achievements, USER_B, async () => ({ ach: 2 }));

  await cached(caches.workouts, `${USER_A}|3|0||`, async () => ({
    canonical: [],
    rawCount: 1,
  }));
  await cached(caches.workouts, `${USER_B}|3|0||`, async () => ({
    canonical: [],
    rawCount: 2,
  }));

  await cached(caches.moodAnalytics, USER_A, async () => ({ mood: 1 }));
  await cached(caches.moodAnalytics, USER_B, async () => ({ mood: 2 }));

  // v1.12.1 — mood-insights aggregate cache (SWR bucket).
  await cached(caches.moodInsights, USER_A, async () => ({ mi: 1 }));
  await cached(caches.moodInsights, USER_B, async () => ({ mi: 2 }));

  await cached(caches.dashboardWidgets, USER_A, async () => ({ d: 1 }));
  await cached(caches.dashboardWidgets, USER_B, async () => ({ d: 2 }));

  // v1.7.0 W6 — the unified dashboard snapshot lives under the analytics
  // bucket. Since v1.21.2 the real cell is keyed WITH the resolved locale
  // (`${userId}|dashboard-snapshot|${locale}`) because the briefing prose is
  // locale-specific. Seed the locale-suffixed cell (the production shape) so
  // the snapshot invalidators are exercised against the key they must actually
  // reach — a point-delete of the locale-less key silently misses it.
  await cached(caches.analytics, snapshotCell(USER_A), async () => ({
    snap: 1,
  }));
  await cached(caches.analytics, snapshotCell(USER_B), async () => ({
    snap: 2,
  }));
}

/**
 * The real snapshot cache cell — the locale-less base key plus the resolved
 * locale segment. The invalidators must sweep by prefix to reach it.
 */
function snapshotCell(userId: string, locale = "en"): string {
  return `${dashboardSnapshotCacheKey(userId)}|${locale}`;
}

describe("invalidateUserMeasurements", () => {
  it("evicts analytics + achievements + workouts for the target user only", async () => {
    await primeAllCaches();
    invalidateUserMeasurements(USER_A);

    expect(caches.analytics.get(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.get(`${USER_A}|summaries`)).toBeNull();
    // v1.7.0 W6 — the `${userId}|` prefix sweep covers the snapshot key.
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.workouts.get(`${USER_A}|3|0||`)).toBeNull();

    // User B's caches untouched.
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();
    expect(caches.analytics.get(snapshotCell(USER_B))).not.toBeNull();
    expect(caches.achievements.get(USER_B)).not.toBeNull();
    expect(caches.workouts.get(`${USER_B}|3|0||`)).not.toBeNull();

    // Mood-analytics not touched by a measurement write.
    expect(caches.moodAnalytics.get(USER_A)).not.toBeNull();
  });

  it("marks the analytics bucket stale (SWR-serveable) by default — background sync posture", async () => {
    await primeAllCaches();
    invalidateUserMeasurements(USER_A);

    // v1.16.7 — the default (batch sync) path marks stale: the entry is
    // gone for plain `get()` (asserted above) but stays serveable for
    // the `cachedSwr` readers, so a high-frequency sync never busts the
    // snapshot / comprehensive into an inline cold rebuild.
    expect(caches.analytics.getAllowStale(`${USER_A}|default`)).toEqual({
      value: { a: 1 },
      stale: true,
    });
    expect(caches.analytics.getAllowStale(snapshotCell(USER_A))).toEqual({
      value: { snap: 1 },
      stale: true,
    });
  });

  it("hard-evicts the analytics bucket with { evict: true } — interactive write posture", async () => {
    await primeAllCaches();
    invalidateUserMeasurements(USER_A, { evict: true });

    // v1.16.7 — an interactive single-entry write must NOT leave a
    // stale-serveable body behind: the SWR readers would hand the user
    // back the pre-write payload. The evict drops the entries entirely.
    expect(caches.analytics.getAllowStale(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.getAllowStale(`${USER_A}|summaries`)).toBeNull();
    expect(caches.analytics.getAllowStale(snapshotCell(USER_A))).toBeNull();

    // User B stays warm; the non-analytics buckets evict as before.
    expect(caches.analytics.getAllowStale(`${USER_B}|default`)).not.toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.workouts.get(`${USER_A}|3|0||`)).toBeNull();
  });
});

describe("invalidateUserMood", () => {
  it("evicts mood-analytics + achievements + analytics", async () => {
    await primeAllCaches();
    invalidateUserMood(USER_A);

    expect(caches.moodAnalytics.get(USER_A)).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).toBeNull();
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.moodAnalytics.get(USER_B)).not.toBeNull();
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();

    // v1.12.1 — mood-insights is marked stale, not hard-evicted: the
    // prior value is still serveable within the SWR window so the next
    // reader pays no cold compute. (A plain `get()` would treat the
    // collapsed TTL as expired and drop it, so assert via getAllowStale
    // first — it must not consume the entry.) User B stays fresh.
    expect(caches.moodInsights.getAllowStale(USER_A)).toEqual({
      value: { mi: 1 },
      stale: true,
    });
    expect(caches.moodInsights.getAllowStale(USER_B)).toEqual({
      value: { mi: 2 },
      stale: false,
    });
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
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.medications.get(USER_B)).not.toBeNull();
    expect(
      caches.medicationsIntake.get(`${USER_B}|compliance|30`),
    ).not.toBeNull();
  });

  it("evicts the per-medication compliance payload for the target user only", async () => {
    await primeAllCaches();
    invalidateUserMedications(USER_A);

    // v1.15.20 — the compliance route caches 15 min; an intake write must
    // flush the `${userId}|` prefix so the next card read is fresh.
    expect(
      caches.medicationCompliance.get(`${USER_A}|med-1|compliance`),
    ).toBeNull();
    expect(
      caches.medicationCompliance.get(`${USER_B}|med-1|compliance`),
    ).not.toBeNull();
  });

  it("marks the SWR buckets stale by default — background sync posture", async () => {
    await primeAllCaches();
    invalidateUserMedications(USER_A);

    // v1.16.8 — the default (bulk sync / cron) path marks stale: the
    // entries are gone for plain `get()` (asserted above) but stay
    // serveable for the `cachedSwr` readers (medications list, both
    // compliance routes, the dashboard snapshot), so a high-frequency
    // iOS sync never busts every card into an inline cold rebuild.
    expect(caches.medications.getAllowStale(USER_A)).toEqual({
      value: { m: 1 },
      stale: true,
    });
    expect(
      caches.medicationCompliance.getAllowStale(`${USER_A}|med-1|compliance`),
    ).toEqual({ value: { mc: 1 }, stale: true });
    expect(caches.analytics.getAllowStale(snapshotCell(USER_A))).toEqual({
      value: { snap: 1 },
      stale: true,
    });

    // User B stays fresh.
    expect(caches.medications.getAllowStale(USER_B)).toEqual({
      value: { m: 2 },
      stale: false,
    });
  });

  it("hard-evicts the SWR buckets with { evict: true } — interactive write posture", async () => {
    await primeAllCaches();
    invalidateUserMedications(USER_A, { evict: true });

    // v1.16.8 — an interactive take / skip / CRUD write must NOT leave a
    // stale-serveable body behind: the SWR readers would hand the user
    // back the pre-write card rates. The evict drops the entries.
    expect(caches.medications.getAllowStale(USER_A)).toBeNull();
    expect(
      caches.medicationCompliance.getAllowStale(`${USER_A}|med-1|compliance`),
    ).toBeNull();
    expect(caches.analytics.getAllowStale(snapshotCell(USER_A))).toBeNull();

    // User B stays warm; the non-SWR buckets evict as before.
    expect(caches.medications.getAllowStale(USER_B)).not.toBeNull();
    expect(
      caches.medicationCompliance.getAllowStale(`${USER_B}|med-1|compliance`),
    ).not.toBeNull();
    expect(caches.medicationsIntake.get(`${USER_A}|compliance|30`)).toBeNull();
    expect(caches.achievements.get(USER_A)).toBeNull();
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
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
    expect(caches.analytics.get(snapshotCell(USER_B))).not.toBeNull();
  });
});

describe("invalidateUserDashboardSnapshot", () => {
  it("drops only the snapshot key, leaving the slim / default analytics cells warm", async () => {
    await primeAllCaches();
    invalidateUserDashboardSnapshot(USER_A);
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.analytics.get(`${USER_A}|default`)).not.toBeNull();
    expect(caches.analytics.get(`${USER_A}|summaries`)).not.toBeNull();
    expect(caches.analytics.get(snapshotCell(USER_B))).not.toBeNull();
  });
});

describe("invalidateUserInsights", () => {
  it("drops the snapshot key so a fresh briefing is re-embedded", async () => {
    await primeAllCaches();
    invalidateUserInsights(USER_A);
    expect(caches.analytics.get(snapshotCell(USER_A))).toBeNull();
    expect(caches.analytics.get(snapshotCell(USER_B))).not.toBeNull();
  });
});

describe("invalidateUserProfile", () => {
  it("hard-evicts targets + derived + analytics for the target user only", async () => {
    await primeAllCaches();
    await cached(caches.insightsTargets, USER_A, async () => ({ t: 1 }));
    await cached(caches.insightsTargets, USER_B, async () => ({ t: 2 }));
    await cached(caches.insightsDerived, `${USER_A}|batch|x|en`, async () => ({
      d: 1,
    }));
    await cached(caches.insightsDerived, `${USER_B}|batch|x|en`, async () => ({
      d: 2,
    }));

    invalidateUserProfile(USER_A);

    // Profile-derived payloads drop — including the SWR stale window
    // (a Settings save is interactive; the pre-edit grid must not serve).
    expect(caches.insightsTargets.getAllowStale(USER_A)).toBeNull();
    expect(
      caches.insightsDerived.getAllowStale(`${USER_A}|batch|x|en`),
    ).toBeNull();
    expect(caches.analytics.getAllowStale(snapshotCell(USER_A))).toBeNull();
    expect(caches.analytics.getAllowStale(`${USER_A}|default`)).toBeNull();

    // The other user's cells stay warm.
    expect(caches.insightsTargets.get(USER_B)).not.toBeNull();
    expect(caches.insightsDerived.get(`${USER_B}|batch|x|en`)).not.toBeNull();
    expect(caches.analytics.get(`${USER_B}|default`)).not.toBeNull();

    // Buckets a profile edit does not feed stay untouched.
    expect(caches.medications.get(USER_A)).not.toBeNull();
  });
});
