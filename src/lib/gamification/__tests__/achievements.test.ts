import { describe, it, expect } from "vitest";
import {
  ACHIEVEMENT_DEFINITIONS,
  calculateLongestStreak,
  evaluateAchievementsWithCompletionDates,
  getUniqueBerlinDays,
} from "@/lib/gamification/achievements";

describe("gamification achievements", () => {
  it("deduplicates and sorts day keys", () => {
    const days = getUniqueBerlinDays([
      new Date("2026-02-11T12:00:00Z"),
      new Date("2026-02-10T12:00:00Z"),
      new Date("2026-02-11T16:00:00Z"),
    ]);

    expect(days).toEqual(["2026-02-10", "2026-02-11"]);
  });

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

  it("evaluates unlocked achievements and points", () => {
    const result = evaluateAchievementsWithCompletionDates(
      {
        totalTakenIntakes: 1000,
        overIntakeCount: 1000,
        skippedIntakeCount: 1000,
        bmiGreenStreak: 1000,
        bpGreenStreak: 1000,
        pulseGreenStreak: 1000,
        onTimePerfectDayStreak: 1000,
        compliance80DayStreak: 1000,
        passkeyCreatedCount: 1000,
        passkeyLoginCount: 1000,
        passwordLoginCount: 1000,
        loginDayStreak: 1000,
        bugReportCount: 1000,
      },
      {},
    );

    expect(result.summary.unlockedCount).toBe(38);
    expect(result.summary.totalCount).toBe(38);
    expect(result.summary.nextAchievement).toBeNull();
    expect(ACHIEVEMENT_DEFINITIONS).toHaveLength(38);
    expect(result.summary.earnedPoints).toBe(result.summary.totalPoints);
  });
});
