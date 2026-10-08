import { describe, it, expect } from "vitest";
import {
  ACHIEVEMENT_DEFINITIONS,
  ACHIEVEMENT_CATEGORY_ORDER,
  applyDiscoveryFilter,
  bridgeFrozenStreakGaps,
  calculateLongestStreak,
  evaluateAchievementsWithCompletionDates,
  type AchievementMetrics,
  type AchievementProgress,
  type EarnabilityFlags,
} from "@/lib/gamification/achievements";

const FULL_METRICS: AchievementMetrics = {
  totalTakenIntakes: 1000,
  bmiGreenStreak: 1000,
  bpGreenStreak: 1000,
  pulseGreenStreak: 1000,
  onTimePerfectDayStreak: 1000,
  compliance80DayStreak: 1000,
  passkeyCreatedCount: 1000,
  passkeyLoginCount: 1000,
  passwordLoginCount: 1000,
  loginDayStreak: 1000,
  moodEntryCount: 1000,
  moodDayStreak: 1000,
  moodImprovementHit: 1000,
  weightMeasurementCount: 1000,
  bpMeasurementCount: 1000,
  pulseMeasurementCount: 1000,
  consistentMonthCount: 1000,
  entryDayStreak: 1000,
  weekendStreakCount: 1000,
  nightOwlCount: 1000,
  earlyBirdCount: 1000,
  leapDayCount: 1000,
  doctorPdfCount: 1000,
  localeFlipCount: 1000,
  missFreeDayStreak: 1000,
  measurementConsistencyWeeks: 1000,
  selfContextCompleteCount: 1000,
  sleepLogDayStreak: 1000,
};

const ZERO_METRICS: AchievementMetrics = Object.fromEntries(
  Object.keys(FULL_METRICS).map((key) => [key, 0]),
) as unknown as AchievementMetrics;

const ALL_EARNABLE: EarnabilityFlags = {
  hasMedication: true,
  hasMood: true,
  hasWeight: true,
  hasBp: true,
  hasPulse: true,
  hasSleep: true,
};

const NONE_EARNABLE: EarnabilityFlags = {
  hasMedication: false,
  hasMood: false,
  hasWeight: false,
  hasBp: false,
  hasPulse: false,
  hasSleep: false,
};

describe("gamification achievements", () => {
  it("calculates the longest streak", () => {
    expect(
      calculateLongestStreak([
        "2026-02-01",
        "2026-02-02",
        "2026-02-04",
        "2026-02-05",
        "2026-02-06",
      ]),
    ).toBe(3);
  });

  it("ships the expanded definition list (61 total — v1.4.18 + v1.16.1 care routine, minus the two dosing badges)", () => {
    expect(ACHIEVEMENT_DEFINITIONS).toHaveLength(61);
  });

  it("includes mood and hidden categories in the render order", () => {
    expect(ACHIEVEMENT_CATEGORY_ORDER).toContain("mood");
    expect(ACHIEVEMENT_CATEGORY_ORDER).toContain("hidden");
  });

  it("evaluates unlocked achievements and points when all metrics maxed", () => {
    const result = evaluateAchievementsWithCompletionDates(FULL_METRICS, {});

    expect(result.summary.unlockedCount).toBe(61);
    expect(result.summary.totalCount).toBe(61);
    expect(result.summary.nextAchievement).toBeNull();
    expect(result.summary.earnedPoints).toBe(result.summary.totalPoints);
  });

  it("flags hidden achievements with isHidden", () => {
    const hidden = ACHIEVEMENT_DEFINITIONS.filter((def) => def.isHidden);
    expect(hidden.length).toBeGreaterThanOrEqual(5);
    expect(hidden.length).toBeLessThanOrEqual(8);
    for (const def of hidden) {
      expect(def.category).toBe("hidden");
    }
  });

  it("flags non-hidden achievements with category != hidden", () => {
    const visible = ACHIEVEMENT_DEFINITIONS.filter((def) => !def.isHidden);
    for (const def of visible) {
      expect(def.category).not.toBe("hidden");
    }
  });
});

describe("applyDiscoveryFilter", () => {
  function progressFor(id: string): AchievementProgress {
    const def = ACHIEVEMENT_DEFINITIONS.find((d) => d.id === id);
    if (!def) throw new Error(`unknown achievement: ${id}`);
    return {
      id: def.id,
      metric: def.metric,
      category: def.category,
      titleKey: def.tTitle,
      descriptionKey: def.tDescription,
      icon: def.icon,
      format: def.format,
      target: def.target,
      current: 0,
      points: def.points,
      unlocked: false,
      progressPercent: 0,
      completedAt: null,
      isHidden: def.isHidden,
    };
  }

  it("hides public mood achievements when the user has no mood data", () => {
    const items = [progressFor("mood-first")];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(0);
  });

  it("keeps mood achievements when the user has at least one mood entry", () => {
    const items = [progressFor("mood-first")];
    const filtered = applyDiscoveryFilter(items, {
      ...NONE_EARNABLE,
      hasMood: true,
    });
    expect(filtered).toHaveLength(1);
  });

  it("keeps unlocked achievements even if precondition no longer holds (anti-regression)", () => {
    const items = [{ ...progressFor("mood-first"), unlocked: true }];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(1);
  });

  it("always keeps hidden achievements regardless of earnability", () => {
    const items = [progressFor("hidden-night-owl")];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(1);
  });

  it("keeps engagement / security achievements unconditionally", () => {
    const items = [
      progressFor("login-streak-7"),
      progressFor("passkey-created-1"),
    ];
    const filtered = applyDiscoveryFilter(items, NONE_EARNABLE);
    expect(filtered).toHaveLength(2);
  });

  it("keeps medication achievements only when the user has at least one medication", () => {
    const items = [progressFor("intake-total-1")];
    expect(applyDiscoveryFilter(items, NONE_EARNABLE)).toHaveLength(0);
    expect(
      applyDiscoveryFilter(items, { ...NONE_EARNABLE, hasMedication: true }),
    ).toHaveLength(1);
  });

  it("zero-progress full set with all-earnable still yields full count", () => {
    const result = evaluateAchievementsWithCompletionDates(ZERO_METRICS, {});
    const filtered = applyDiscoveryFilter(result.achievements, ALL_EARNABLE);
    expect(filtered.length).toBe(result.achievements.length);
    expect(result.summary.unlockedCount).toBe(0);
  });
});

// v1.18.1 P4 — Rest Mode streak-freeze. A streak that lapses ONLY across
// illness days bridges into one continuous run rather than breaking; it is
// never invented, and a non-illness gap still breaks the streak.
describe("bridgeFrozenStreakGaps (Rest Mode streak-freeze)", () => {
  it("is a no-op with no frozen days (returns the sorted input)", () => {
    const days = ["2026-06-03", "2026-06-01", "2026-06-02"];
    expect(bridgeFrozenStreakGaps(days, new Set())).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  it("bridges a gap whose every interior day is frozen, preserving the streak", () => {
    // Tracked 06-01, then ill 06-02..06-04, tracked again 06-05. Without the
    // freeze the streak would break to 1; with it, the run is continuous.
    const tracked = ["2026-06-01", "2026-06-05"];
    const frozen = new Set(["2026-06-02", "2026-06-03", "2026-06-04"]);
    const bridged = bridgeFrozenStreakGaps(tracked, frozen);
    expect(calculateLongestStreak(bridged)).toBe(5);
  });

  it("does NOT bridge a gap that contains a non-frozen missed day (genuine break)", () => {
    const tracked = ["2026-06-01", "2026-06-05"];
    // 06-03 is NOT a frozen illness day → the gap is a real lapse.
    const frozen = new Set(["2026-06-02", "2026-06-04"]);
    const bridged = bridgeFrozenStreakGaps(tracked, frozen);
    expect(calculateLongestStreak(bridged)).toBe(1);
  });

  it("never invents a streak from a lone frozen day with no surrounding run", () => {
    const tracked = ["2026-06-10"];
    const frozen = new Set(["2026-06-02", "2026-06-03"]);
    const bridged = bridgeFrozenStreakGaps(tracked, frozen);
    // A single tracked day, untouched — the frozen days bridge nothing.
    expect(bridged).toEqual(["2026-06-10"]);
    expect(calculateLongestStreak(bridged)).toBe(1);
  });
});

describe("dosing is never rewarded", () => {
  // A badge for a dose taken twice or a dose skipped rewards over- or
  // under-dosing. Neither behaviour is an achievement.
  it("ships no badge for a doubled or a skipped dose", () => {
    const ids = ACHIEVEMENT_DEFINITIONS.map((d) => d.id);
    expect(ids).not.toContain("over-intake-1");
    expect(ids).not.toContain("skipped-intake-1");
    const metrics = ACHIEVEMENT_DEFINITIONS.map((d) => String(d.metric));
    expect(metrics).not.toContain("overIntakeCount");
    expect(metrics).not.toContain("skippedIntakeCount");
  });

  it("ignores an unlock row persisted for a retired badge", () => {
    const result = evaluateAchievementsWithCompletionDates(ZERO_METRICS, {
      "over-intake-1": new Date("2026-03-01T08:00:00Z"),
      "skipped-intake-1": new Date("2026-03-02T08:00:00Z"),
    });
    const ids = result.achievements.map((a) => a.id);
    expect(ids).not.toContain("over-intake-1");
    expect(ids).not.toContain("skipped-intake-1");
    expect(result.summary.unlockedCount).toBe(0);
  });
});
