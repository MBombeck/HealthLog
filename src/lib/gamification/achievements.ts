const BERLIN_TIMEZONE = "Europe/Berlin";

export const GAMIFICATION_ROLLOUT_AT = new Date("2026-02-20T00:00:00.000Z");

export type AchievementMetricKey =
  | "totalTakenIntakes"
  | "overIntakeCount"
  | "skippedIntakeCount"
  | "bmiGreenStreak"
  | "bpGreenStreak"
  | "pulseGreenStreak"
  | "onTimePerfectDayStreak"
  | "compliance80DayStreak"
  | "passkeyCreatedCount"
  | "passkeyLoginCount"
  | "passwordLoginCount"
  | "loginDayStreak"
  | "bugReportCount";

export interface AchievementDefinition {
  id: string;
  metric: AchievementMetricKey;
  target: number;
  points: number;
  icon: string;
  tTitle: string;
  tDescription: string;
  format: "count" | "days" | "percent";
}

export interface AchievementMetrics {
  totalTakenIntakes: number;
  overIntakeCount: number;
  skippedIntakeCount: number;
  bmiGreenStreak: number;
  bpGreenStreak: number;
  pulseGreenStreak: number;
  onTimePerfectDayStreak: number;
  compliance80DayStreak: number;
  passkeyCreatedCount: number;
  passkeyLoginCount: number;
  passwordLoginCount: number;
  loginDayStreak: number;
  bugReportCount: number;
}

export interface AchievementProgress {
  id: string;
  metric: AchievementMetricKey;
  titleKey: string;
  descriptionKey: string;
  icon: string;
  format: "count" | "days" | "percent";
  target: number;
  current: number;
  points: number;
  unlocked: boolean;
  progressPercent: number;
  completedAt: string | null;
}

export interface AchievementSummary {
  unlockedCount: number;
  totalCount: number;
  earnedPoints: number;
  totalPoints: number;
  completionPercent: number;
  nextAchievement: AchievementProgress | null;
}

const DAY_KEY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: BERLIN_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const STREAK_TARGETS = [1, 7, 30, 180, 360] as const;

function buildStreakAchievements(config: {
  idPrefix: string;
  metric: AchievementMetricKey;
  icon: string;
  titlePrefix: string;
  descriptionPrefix: string;
  points: readonly [number, number, number, number, number];
}): AchievementDefinition[] {
  return STREAK_TARGETS.map((target, index) => ({
    id: `${config.idPrefix}-${target}`,
    metric: config.metric,
    target,
    points: config.points[index],
    icon: config.icon,
    tTitle: `achievements.badges.${config.titlePrefix}${target}.title`,
    tDescription: `achievements.badges.${config.descriptionPrefix}${target}.description`,
    format: "days",
  }));
}

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  {
    id: "intake-total-1",
    metric: "totalTakenIntakes",
    target: 1,
    points: 8,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal1.title",
    tDescription: "achievements.badges.intakeTotal1.description",
    format: "count",
  },
  {
    id: "intake-total-10",
    metric: "totalTakenIntakes",
    target: 10,
    points: 24,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal10.title",
    tDescription: "achievements.badges.intakeTotal10.description",
    format: "count",
  },
  {
    id: "intake-total-50",
    metric: "totalTakenIntakes",
    target: 50,
    points: 60,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal50.title",
    tDescription: "achievements.badges.intakeTotal50.description",
    format: "count",
  },
  {
    id: "intake-total-150",
    metric: "totalTakenIntakes",
    target: 150,
    points: 140,
    icon: "Trophy",
    tTitle: "achievements.badges.intakeTotal150.title",
    tDescription: "achievements.badges.intakeTotal150.description",
    format: "count",
  },
  {
    id: "intake-total-300",
    metric: "totalTakenIntakes",
    target: 300,
    points: 320,
    icon: "Trophy",
    tTitle: "achievements.badges.intakeTotal300.title",
    tDescription: "achievements.badges.intakeTotal300.description",
    format: "count",
  },
  {
    id: "over-intake-1",
    metric: "overIntakeCount",
    target: 1,
    points: 0,
    icon: "AlertTriangle",
    tTitle: "achievements.badges.overIntake1.title",
    tDescription: "achievements.badges.overIntake1.description",
    format: "count",
  },
  {
    id: "skipped-intake-1",
    metric: "skippedIntakeCount",
    target: 1,
    points: 0,
    icon: "SkipForward",
    tTitle: "achievements.badges.skippedIntake1.title",
    tDescription: "achievements.badges.skippedIntake1.description",
    format: "count",
  },
  {
    id: "passkey-created-1",
    metric: "passkeyCreatedCount",
    target: 1,
    points: 40,
    icon: "KeyRound",
    tTitle: "achievements.badges.passkeyCreated1.title",
    tDescription: "achievements.badges.passkeyCreated1.description",
    format: "count",
  },
  {
    id: "passkey-login-1",
    metric: "passkeyLoginCount",
    target: 1,
    points: 45,
    icon: "Fingerprint",
    tTitle: "achievements.badges.passkeyLogin1.title",
    tDescription: "achievements.badges.passkeyLogin1.description",
    format: "count",
  },
  {
    id: "password-login-1",
    metric: "passwordLoginCount",
    target: 1,
    points: 20,
    icon: "LogIn",
    tTitle: "achievements.badges.passwordLogin1.title",
    tDescription: "achievements.badges.passwordLogin1.description",
    format: "count",
  },
  {
    id: "bugreport-1",
    metric: "bugReportCount",
    target: 1,
    points: 30,
    icon: "Bug",
    tTitle: "achievements.badges.bugReport1.title",
    tDescription: "achievements.badges.bugReport1.description",
    format: "count",
  },
  {
    id: "login-streak-7",
    metric: "loginDayStreak",
    target: 7,
    points: 90,
    icon: "CalendarCheck",
    tTitle: "achievements.badges.loginStreak7.title",
    tDescription: "achievements.badges.loginStreak7.description",
    format: "days",
  },
  {
    id: "login-streak-30",
    metric: "loginDayStreak",
    target: 30,
    points: 280,
    icon: "Flame",
    tTitle: "achievements.badges.loginStreak30.title",
    tDescription: "achievements.badges.loginStreak30.description",
    format: "days",
  },
  ...buildStreakAchievements({
    idPrefix: "on-time-perfect",
    metric: "onTimePerfectDayStreak",
    icon: "ShieldCheck",
    titlePrefix: "onTimePerfect",
    descriptionPrefix: "onTimePerfect",
    points: [15, 45, 120, 320, 700],
  }),
  ...buildStreakAchievements({
    idPrefix: "compliance-80",
    metric: "compliance80DayStreak",
    icon: "Target",
    titlePrefix: "compliance80",
    descriptionPrefix: "compliance80",
    points: [25, 85, 240, 650, 1500],
  }),
  ...buildStreakAchievements({
    idPrefix: "bmi-green",
    metric: "bmiGreenStreak",
    icon: "Target",
    titlePrefix: "bmiGreen",
    descriptionPrefix: "bmiGreen",
    points: [18, 55, 145, 380, 850],
  }),
  ...buildStreakAchievements({
    idPrefix: "bp-green",
    metric: "bpGreenStreak",
    icon: "Heart",
    titlePrefix: "bpGreen",
    descriptionPrefix: "bpGreen",
    points: [20, 60, 160, 420, 950],
  }),
  ...buildStreakAchievements({
    idPrefix: "pulse-green",
    metric: "pulseGreenStreak",
    icon: "Activity",
    titlePrefix: "pulseGreen",
    descriptionPrefix: "pulseGreen",
    points: [14, 40, 105, 280, 620],
  }),
];

function dayKeyToNumber(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function toBerlinDayKey(date: Date): string {
  const parts = DAY_KEY_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not format date");
  }

  return `${year}-${month}-${day}`;
}

export function getUniqueBerlinDays(dates: Date[]): string[] {
  return Array.from(new Set(dates.map((date) => toBerlinDayKey(date)))).sort();
}

export function calculateLongestStreak(dayKeys: string[]): number {
  if (dayKeys.length === 0) return 0;

  let maxStreak = 1;
  let currentStreak = 1;

  for (let i = 1; i < dayKeys.length; i++) {
    const prev = dayKeyToNumber(dayKeys[i - 1]);
    const current = dayKeyToNumber(dayKeys[i]);

    if (current - prev === 1) {
      currentStreak += 1;
      maxStreak = Math.max(maxStreak, currentStreak);
      continue;
    }

    currentStreak = 1;
  }

  return maxStreak;
}

function calculateProgress(current: number, target: number): number {
  if (target <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

export function evaluateAchievementsWithCompletionDates(
  metrics: AchievementMetrics,
  completionDates: Partial<Record<string, Date>>,
): {
  summary: AchievementSummary;
  achievements: AchievementProgress[];
  metrics: AchievementMetrics;
} {
  const achievements = ACHIEVEMENT_DEFINITIONS.map((definition) => {
    const current = metrics[definition.metric];
    const unlocked = current >= definition.target;
    const completedAtDate = completionDates[definition.id] ?? null;

    return {
      id: definition.id,
      metric: definition.metric,
      titleKey: definition.tTitle,
      descriptionKey: definition.tDescription,
      icon: definition.icon,
      format: definition.format,
      target: definition.target,
      current,
      points: definition.points,
      unlocked,
      progressPercent: calculateProgress(current, definition.target),
      completedAt:
        unlocked && completedAtDate ? completedAtDate.toISOString() : null,
    } satisfies AchievementProgress;
  });

  const unlockedCount = achievements.filter((item) => item.unlocked).length;
  const earnedPoints = achievements
    .filter((item) => item.unlocked)
    .reduce((total, item) => total + item.points, 0);
  const totalPoints = achievements.reduce(
    (total, item) => total + item.points,
    0,
  );

  const nextAchievement =
    achievements
      .filter((item) => !item.unlocked)
      .sort((a, b) => b.progressPercent - a.progressPercent)[0] ?? null;

  const summary: AchievementSummary = {
    unlockedCount,
    totalCount: achievements.length,
    earnedPoints,
    totalPoints,
    completionPercent: calculateProgress(unlockedCount, achievements.length),
    nextAchievement,
  };

  return {
    summary,
    achievements,
    metrics,
  };
}
