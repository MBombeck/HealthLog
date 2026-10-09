export const GAMIFICATION_ROLLOUT_AT = new Date("2026-02-20T00:00:00.000Z");

export type AchievementMetricKey =
  | "totalTakenIntakes"
  | "bmiGreenStreak"
  | "bpGreenStreak"
  | "pulseGreenStreak"
  | "onTimePerfectDayStreak"
  | "compliance80DayStreak"
  | "passkeyCreatedCount"
  | "passkeyLoginCount"
  | "passwordLoginCount"
  | "loginDayStreak"
  // v1.4.18 expansion ─ mood
  | "moodEntryCount"
  | "moodDayStreak"
  | "moodImprovementHit"
  // v1.4.18 expansion ─ measurement counts
  | "weightMeasurementCount"
  | "bpMeasurementCount"
  | "pulseMeasurementCount"
  // v1.4.18 expansion ─ engagement / consistency
  | "consistentMonthCount"
  | "entryDayStreak"
  | "weekendStreakCount"
  // v1.4.18 expansion ─ hidden Easter-eggs
  | "nightOwlCount"
  | "earlyBirdCount"
  | "leapDayCount"
  | "doctorPdfCount"
  | "localeFlipCount"
  // v1.16.1 expansion ─ care routine (therapy adherence, measurement
  // consistency, self-report upkeep, sleep logging)
  | "missFreeDayStreak"
  | "measurementConsistencyWeeks"
  | "selfContextCompleteCount"
  | "sleepLogDayStreak";

/**
 * Achievement categories — used by the /achievements UI to visually group
 * the badges. Pure presentation: the computation logic in this file does
 * not branch on category, and the metric → category mapping is derived in
 * `categoryForMetric` below so a metric is always in exactly one group.
 *
 * v1.4.18 adds two new buckets:
 *   - `mood` for the new mood-tracking achievements
 *   - `hidden` for the Easter-egg group (cards always render as opaque
 *     placeholders until the achievement unlocks; the trigger is never
 *     leaked to the DOM)
 */
export type AchievementCategory =
  "medication" | "vitals" | "mood" | "security" | "engagement" | "hidden";

export interface AchievementDefinition {
  id: string;
  metric: AchievementMetricKey;
  target: number;
  points: number;
  icon: string;
  tTitle: string;
  tDescription: string;
  format: "count" | "days" | "percent";
  /** v1.4.18 — true for hidden Easter-egg achievements. Locked cards
   * for these never reveal their title/description; only the unlock
   * surfaces the real strings. */
  isHidden: boolean;
  /** v1.4.18 — derived from the metric for visible categories, hard-
   * coded `hidden` for the Easter-egg group. Lives on the definition
   * so the discovery filter never has to recompute it. */
  category: AchievementCategory;
}

/**
 * v1.18.0 — module ownership for an achievement metric. Returns the
 * `ModuleKey` whose enable/disable state governs the badge, or `null`
 * when the badge belongs to a core domain (vitals, medications) or to
 * an account-wide capability (security, login) that has no
 * toggleable module behind it.
 *
 * The string literals here intentionally mirror `MODULE_KEYS` in
 * `@/lib/modules/registry` without importing it, so this pure lib stays
 * free of the gate's transitive dependencies. The module gate (B5) reads
 * this map to skip badge categories whose owning module is turned off —
 * a sleep badge must not unlock while the sleep module is disabled.
 */
export function moduleForMetric(metric: AchievementMetricKey): string | null {
  switch (metric) {
    case "moodEntryCount":
    case "moodDayStreak":
    case "moodImprovementHit":
      return "mood";
    case "sleepLogDayStreak":
      return "sleep";
    default:
      return null;
  }
}

/**
 * v1.4.18 — discovery flags. Predicate input for
 * `applyDiscoveryFilter`. A flag is true iff the user has at least one
 * data point for the underlying metric (a medication, a mood entry,
 * etc.). Hidden achievements ignore the flags entirely.
 */
export interface EarnabilityFlags {
  hasMedication: boolean;
  hasMood: boolean;
  hasWeight: boolean;
  hasBp: boolean;
  hasPulse: boolean;
  /** v1.16.1 — at least one sleep sample (any source) exists. */
  hasSleep: boolean;
}

function categoryForMetric(metric: AchievementMetricKey): AchievementCategory {
  switch (metric) {
    case "totalTakenIntakes":
    case "onTimePerfectDayStreak":
    case "compliance80DayStreak":
    case "missFreeDayStreak":
      return "medication";
    case "bmiGreenStreak":
    case "bpGreenStreak":
    case "pulseGreenStreak":
    case "weightMeasurementCount":
    case "bpMeasurementCount":
    case "pulseMeasurementCount":
    case "sleepLogDayStreak":
      return "vitals";
    case "moodEntryCount":
    case "moodDayStreak":
    case "moodImprovementHit":
      return "mood";
    case "passkeyCreatedCount":
    case "passkeyLoginCount":
    case "passwordLoginCount":
      return "security";
    case "loginDayStreak":
    case "consistentMonthCount":
    case "entryDayStreak":
    case "weekendStreakCount":
    case "measurementConsistencyWeeks":
    case "selfContextCompleteCount":
      return "engagement";
    case "nightOwlCount":
    case "earlyBirdCount":
    case "leapDayCount":
    case "doctorPdfCount":
    case "localeFlipCount":
      return "hidden";
  }
}

/**
 * Stable category render order on the /achievements page. Mood slots
 * between vitals and security so the most-used categories cluster at
 * the top. Hidden goes last so opaque cards don't push real progress
 * below the fold.
 */
export const ACHIEVEMENT_CATEGORY_ORDER: readonly AchievementCategory[] = [
  "medication",
  "vitals",
  "mood",
  "security",
  "engagement",
  "hidden",
] as const;

export interface AchievementMetrics {
  totalTakenIntakes: number;
  bmiGreenStreak: number;
  bpGreenStreak: number;
  pulseGreenStreak: number;
  onTimePerfectDayStreak: number;
  compliance80DayStreak: number;
  passkeyCreatedCount: number;
  passkeyLoginCount: number;
  passwordLoginCount: number;
  loginDayStreak: number;
  moodEntryCount: number;
  moodDayStreak: number;
  moodImprovementHit: number;
  weightMeasurementCount: number;
  bpMeasurementCount: number;
  pulseMeasurementCount: number;
  consistentMonthCount: number;
  entryDayStreak: number;
  weekendStreakCount: number;
  nightOwlCount: number;
  earlyBirdCount: number;
  leapDayCount: number;
  doctorPdfCount: number;
  localeFlipCount: number;
  missFreeDayStreak: number;
  measurementConsistencyWeeks: number;
  selfContextCompleteCount: number;
  sleepLogDayStreak: number;
}

export interface AchievementProgress {
  id: string;
  metric: AchievementMetricKey;
  category: AchievementCategory;
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
  /** v1.4.18 — mirrored from the definition so the UI can render an
   * opaque placeholder when locked. */
  isHidden: boolean;
}

export interface AchievementSummary {
  unlockedCount: number;
  totalCount: number;
  earnedPoints: number;
  totalPoints: number;
  completionPercent: number;
  nextAchievement: AchievementProgress | null;
}

const STREAK_TARGETS = [1, 7, 30, 180, 360] as const;

function buildStreakAchievements(config: {
  idPrefix: string;
  metric: AchievementMetricKey;
  icon: string;
  titlePrefix: string;
  descriptionPrefix: string;
  points: readonly [number, number, number, number, number];
}): AchievementDefinition[] {
  return STREAK_TARGETS.map((target, index) =>
    define({
      id: `${config.idPrefix}-${target}`,
      metric: config.metric,
      target,
      points: config.points[index],
      icon: config.icon,
      tTitle: `achievements.badges.${config.titlePrefix}${target}.title`,
      tDescription: `achievements.badges.${config.descriptionPrefix}${target}.description`,
      format: "days",
    }),
  );
}

function define(
  partial: Omit<AchievementDefinition, "isHidden" | "category"> & {
    isHidden?: boolean;
  },
): AchievementDefinition {
  const isHidden = partial.isHidden ?? false;
  return {
    ...partial,
    isHidden,
    category: isHidden ? "hidden" : categoryForMetric(partial.metric),
  };
}

export const ACHIEVEMENT_DEFINITIONS: AchievementDefinition[] = [
  define({
    id: "intake-total-1",
    metric: "totalTakenIntakes",
    target: 1,
    points: 8,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal1.title",
    tDescription: "achievements.badges.intakeTotal1.description",
    format: "count",
  }),
  define({
    id: "intake-total-10",
    metric: "totalTakenIntakes",
    target: 10,
    points: 24,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal10.title",
    tDescription: "achievements.badges.intakeTotal10.description",
    format: "count",
  }),
  define({
    id: "intake-total-50",
    metric: "totalTakenIntakes",
    target: 50,
    points: 60,
    icon: "Pill",
    tTitle: "achievements.badges.intakeTotal50.title",
    tDescription: "achievements.badges.intakeTotal50.description",
    format: "count",
  }),
  define({
    id: "intake-total-150",
    metric: "totalTakenIntakes",
    target: 150,
    points: 140,
    icon: "Trophy",
    tTitle: "achievements.badges.intakeTotal150.title",
    tDescription: "achievements.badges.intakeTotal150.description",
    format: "count",
  }),
  define({
    id: "intake-total-300",
    metric: "totalTakenIntakes",
    target: 300,
    points: 320,
    icon: "Trophy",
    tTitle: "achievements.badges.intakeTotal300.title",
    tDescription: "achievements.badges.intakeTotal300.description",
    format: "count",
  }),
  define({
    id: "passkey-created-1",
    metric: "passkeyCreatedCount",
    target: 1,
    points: 40,
    icon: "KeyRound",
    tTitle: "achievements.badges.passkeyCreated1.title",
    tDescription: "achievements.badges.passkeyCreated1.description",
    format: "count",
  }),
  define({
    id: "passkey-login-1",
    metric: "passkeyLoginCount",
    target: 1,
    points: 45,
    icon: "Fingerprint",
    tTitle: "achievements.badges.passkeyLogin1.title",
    tDescription: "achievements.badges.passkeyLogin1.description",
    format: "count",
  }),
  define({
    id: "password-login-1",
    metric: "passwordLoginCount",
    target: 1,
    points: 20,
    icon: "LogIn",
    tTitle: "achievements.badges.passwordLogin1.title",
    tDescription: "achievements.badges.passwordLogin1.description",
    format: "count",
  }),
  define({
    id: "login-streak-7",
    metric: "loginDayStreak",
    target: 7,
    points: 90,
    icon: "CalendarCheck",
    tTitle: "achievements.badges.loginStreak7.title",
    tDescription: "achievements.badges.loginStreak7.description",
    format: "days",
  }),
  define({
    id: "login-streak-30",
    metric: "loginDayStreak",
    target: 30,
    points: 280,
    icon: "Flame",
    tTitle: "achievements.badges.loginStreak30.title",
    tDescription: "achievements.badges.loginStreak30.description",
    format: "days",
  }),
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
  // ─── v1.4.18 ─ mood (3) ─────────────────────────────────
  define({
    id: "mood-first",
    metric: "moodEntryCount",
    target: 1,
    points: 8,
    icon: "Smile",
    tTitle: "achievements.badges.moodFirst.title",
    tDescription: "achievements.badges.moodFirst.description",
    format: "count",
  }),
  define({
    id: "mood-streak-7",
    metric: "moodDayStreak",
    target: 7,
    points: 50,
    icon: "Smile",
    tTitle: "achievements.badges.moodStreak7.title",
    tDescription: "achievements.badges.moodStreak7.description",
    format: "days",
  }),
  define({
    id: "mood-streak-30",
    metric: "moodDayStreak",
    target: 30,
    points: 200,
    icon: "Smile",
    tTitle: "achievements.badges.moodStreak30.title",
    tDescription: "achievements.badges.moodStreak30.description",
    format: "days",
  }),
  define({
    id: "mood-up-7",
    metric: "moodImprovementHit",
    target: 1,
    points: 90,
    icon: "Sun",
    tTitle: "achievements.badges.moodUp7.title",
    tDescription: "achievements.badges.moodUp7.description",
    format: "count",
  }),
  // ─── v1.4.18 ─ measurement counts (vitals, 7) ───────────
  define({
    id: "weight-first",
    metric: "weightMeasurementCount",
    target: 1,
    points: 8,
    icon: "Scale",
    tTitle: "achievements.badges.weightFirst.title",
    tDescription: "achievements.badges.weightFirst.description",
    format: "count",
  }),
  define({
    id: "weight-50",
    metric: "weightMeasurementCount",
    target: 50,
    points: 90,
    icon: "Scale",
    tTitle: "achievements.badges.weight50.title",
    tDescription: "achievements.badges.weight50.description",
    format: "count",
  }),
  define({
    id: "weight-200",
    metric: "weightMeasurementCount",
    target: 200,
    points: 320,
    icon: "Trophy",
    tTitle: "achievements.badges.weight200.title",
    tDescription: "achievements.badges.weight200.description",
    format: "count",
  }),
  define({
    id: "bp-first",
    metric: "bpMeasurementCount",
    target: 1,
    points: 8,
    icon: "Heart",
    tTitle: "achievements.badges.bpFirst.title",
    tDescription: "achievements.badges.bpFirst.description",
    format: "count",
  }),
  define({
    id: "bp-50",
    metric: "bpMeasurementCount",
    target: 50,
    points: 90,
    icon: "Heart",
    tTitle: "achievements.badges.bp50.title",
    tDescription: "achievements.badges.bp50.description",
    format: "count",
  }),
  define({
    id: "bp-200",
    metric: "bpMeasurementCount",
    target: 200,
    points: 320,
    icon: "Trophy",
    tTitle: "achievements.badges.bp200.title",
    tDescription: "achievements.badges.bp200.description",
    format: "count",
  }),
  define({
    id: "pulse-first",
    metric: "pulseMeasurementCount",
    target: 1,
    points: 8,
    icon: "Activity",
    tTitle: "achievements.badges.pulseFirst.title",
    tDescription: "achievements.badges.pulseFirst.description",
    format: "count",
  }),
  // ─── v1.4.18 ─ engagement / consistency (4) ─────────────
  define({
    id: "consistent-month",
    metric: "consistentMonthCount",
    target: 1,
    points: 140,
    icon: "CalendarDays",
    tTitle: "achievements.badges.consistentMonth.title",
    tDescription: "achievements.badges.consistentMonth.description",
    format: "count",
  }),
  define({
    id: "entry-streak-7",
    metric: "entryDayStreak",
    target: 7,
    points: 70,
    icon: "Flame",
    tTitle: "achievements.badges.entryStreak7.title",
    tDescription: "achievements.badges.entryStreak7.description",
    format: "days",
  }),
  define({
    id: "entry-streak-30",
    metric: "entryDayStreak",
    target: 30,
    points: 260,
    icon: "Flame",
    tTitle: "achievements.badges.entryStreak30.title",
    tDescription: "achievements.badges.entryStreak30.description",
    format: "days",
  }),
  define({
    id: "weekend-warrior",
    metric: "weekendStreakCount",
    target: 4,
    points: 40,
    icon: "CalendarCheck",
    tTitle: "achievements.badges.weekendWarrior.title",
    tDescription: "achievements.badges.weekendWarrior.description",
    format: "count",
  }),
  // ─── v1.4.18 ─ hidden Easter-eggs (6) ───────────────────
  // Trigger conditions are not leaked to the user — locked card just
  // shows the "Hidden" placeholder. Once unlocked, the title +
  // description appear in the toast and on the card.
  define({
    id: "hidden-night-owl",
    metric: "nightOwlCount",
    target: 1,
    points: 25,
    icon: "Moon",
    tTitle: "achievements.badges.hiddenNightOwl.title",
    tDescription: "achievements.badges.hiddenNightOwl.description",
    format: "count",
    isHidden: true,
  }),
  define({
    id: "hidden-early-bird",
    metric: "earlyBirdCount",
    target: 1,
    points: 25,
    icon: "Sun",
    tTitle: "achievements.badges.hiddenEarlyBird.title",
    tDescription: "achievements.badges.hiddenEarlyBird.description",
    format: "count",
    isHidden: true,
  }),
  define({
    id: "hidden-leap-day",
    metric: "leapDayCount",
    target: 1,
    points: 50,
    icon: "Sparkles",
    tTitle: "achievements.badges.hiddenLeapDay.title",
    tDescription: "achievements.badges.hiddenLeapDay.description",
    format: "count",
    isHidden: true,
  }),
  define({
    id: "hidden-doctor-pdf",
    metric: "doctorPdfCount",
    target: 1,
    points: 35,
    icon: "FileText",
    tTitle: "achievements.badges.hiddenDoctorPdf.title",
    tDescription: "achievements.badges.hiddenDoctorPdf.description",
    format: "count",
    isHidden: true,
  }),
  define({
    id: "hidden-locale-flip",
    metric: "localeFlipCount",
    target: 1,
    points: 15,
    icon: "Languages",
    tTitle: "achievements.badges.hiddenLocaleFlip.title",
    tDescription: "achievements.badges.hiddenLocaleFlip.description",
    format: "count",
    isHidden: true,
  }),
  // ─── v1.16.1 ─ care routine (6) ─────────────────────────
  // Quiet, clinically meaningful milestones: therapy adherence without
  // a single auto-missed dose, sustained measurement consistency, a
  // maintained self-report, and a sleep-logging series. Computation
  // lives in `care-metrics.ts` + the achievements route; no schema
  // change (UserAchievement keys on the id string).
  define({
    id: "miss-free-7",
    metric: "missFreeDayStreak",
    target: 7,
    points: 60,
    icon: "ClipboardCheck",
    tTitle: "achievements.badges.missFree7.title",
    tDescription: "achievements.badges.missFree7.description",
    format: "days",
  }),
  define({
    id: "miss-free-30",
    metric: "missFreeDayStreak",
    target: 30,
    points: 200,
    icon: "ClipboardCheck",
    tTitle: "achievements.badges.missFree30.title",
    tDescription: "achievements.badges.missFree30.description",
    format: "days",
  }),
  define({
    id: "miss-free-90",
    metric: "missFreeDayStreak",
    target: 90,
    points: 520,
    icon: "ClipboardCheck",
    tTitle: "achievements.badges.missFree90.title",
    tDescription: "achievements.badges.missFree90.description",
    format: "days",
  }),
  define({
    id: "measurement-weeks-4",
    metric: "measurementConsistencyWeeks",
    target: 4,
    points: 120,
    icon: "CalendarRange",
    tTitle: "achievements.badges.measurementWeeks4.title",
    tDescription: "achievements.badges.measurementWeeks4.description",
    format: "count",
  }),
  define({
    id: "self-context-complete",
    metric: "selfContextCompleteCount",
    target: 1,
    points: 40,
    icon: "UserCheck",
    tTitle: "achievements.badges.selfContextComplete.title",
    tDescription: "achievements.badges.selfContextComplete.description",
    format: "count",
  }),
  define({
    id: "sleep-log-7",
    metric: "sleepLogDayStreak",
    target: 7,
    points: 50,
    icon: "MoonStar",
    tTitle: "achievements.badges.sleepLog7.title",
    tDescription: "achievements.badges.sleepLog7.description",
    format: "days",
  }),
];

function dayKeyToNumber(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
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

/**
 * v1.18.1 P4 — freeze (don't break) a day-streak across illness days.
 *
 * Rest Mode principle: a streak that lapses ONLY because the user was unwell
 * should not be broken — being ill is not a failure to track. This pure
 * helper bridges any calendar gap between two qualifying days when EVERY
 * missing day in the gap is a frozen (active-illness) day. The bridged days
 * are folded into the series so `calculateLongestStreak` sees one continuous
 * run across the episode.
 *
 * It never INVENTS a streak: a frozen day with no surrounding qualifying days
 * on either side adds nothing (there is no run to preserve), and a gap that
 * contains even one non-frozen missed day stays a genuine break. The user is
 * neither penalised for being ill nor rewarded for it — the streak simply
 * pauses and resumes.
 *
 * Both inputs are `YYYY-MM-DD` keys. Returns a fresh ascending, de-duplicated
 * day-key array; the original is not mutated. A no-op (returns the sorted
 * input) when `frozenDayKeys` is empty.
 */
export function bridgeFrozenStreakGaps(
  dayKeys: string[],
  frozenDayKeys: ReadonlySet<string>,
): string[] {
  const unique = Array.from(new Set(dayKeys)).sort();
  if (frozenDayKeys.size === 0 || unique.length < 2) return unique;

  const frozenSerials = new Set<number>();
  for (const key of frozenDayKeys) frozenSerials.add(dayKeyToNumber(key));

  const bridged = new Set(unique);
  for (let i = 1; i < unique.length; i++) {
    const prev = dayKeyToNumber(unique[i - 1]);
    const current = dayKeyToNumber(unique[i]);
    if (current - prev <= 1) continue;
    // A gap. Bridge it only when every interior day is a frozen illness day.
    let allFrozen = true;
    for (let serial = prev + 1; serial < current; serial++) {
      if (!frozenSerials.has(serial)) {
        allFrozen = false;
        break;
      }
    }
    if (allFrozen) {
      for (let serial = prev + 1; serial < current; serial++) {
        bridged.add(serialToDayKey(serial));
      }
    }
  }

  return Array.from(bridged).sort();
}

/** Inverse of `dayKeyToNumber` — a UTC day serial back to a `YYYY-MM-DD` key. */
function serialToDayKey(serial: number): string {
  const d = new Date(serial * 86_400_000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
      category: definition.category,
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
      isHidden: definition.isHidden,
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

/**
 * v1.4.18 — discovery filter. Drops public (non-hidden) achievements
 * the user can never earn yet because they have no underlying data
 * (e.g. a mood badge for someone who has never logged a mood).
 *
 * Three exceptions to the "drop if not earnable" rule:
 *   1. Already-unlocked achievements stay (regression guard — once
 *      earned, the badge always renders, even if the user later
 *      deletes all their data).
 *   2. Hidden Easter-eggs always stay (the "?" placeholder is the
 *      whole point).
 *   3. Achievements without a metric-data precondition (security,
 *      login-streaks) stay because the precondition is
 *      "the user has an account", which is implicit.
 */
export function applyDiscoveryFilter(
  achievements: AchievementProgress[],
  flags: EarnabilityFlags,
): AchievementProgress[] {
  return achievements.filter((item) => {
    if (item.unlocked) return true;
    if (item.category === "hidden") return true;
    return isEarnable(item.metric, flags);
  });
}

function isEarnable(
  metric: AchievementMetricKey,
  flags: EarnabilityFlags,
): boolean {
  switch (metric) {
    case "totalTakenIntakes":
    case "onTimePerfectDayStreak":
    case "compliance80DayStreak":
    case "missFreeDayStreak":
      return flags.hasMedication;
    case "sleepLogDayStreak":
      return flags.hasSleep;
    case "moodEntryCount":
    case "moodDayStreak":
    case "moodImprovementHit":
      return flags.hasMood;
    case "weightMeasurementCount":
    case "bmiGreenStreak":
      return flags.hasWeight;
    case "bpMeasurementCount":
    case "bpGreenStreak":
      return flags.hasBp;
    case "pulseMeasurementCount":
    case "pulseGreenStreak":
      return flags.hasPulse;
    case "passkeyCreatedCount":
    case "passkeyLoginCount":
    case "passwordLoginCount":
    case "loginDayStreak":
    case "consistentMonthCount":
    case "entryDayStreak":
    case "weekendStreakCount":
    case "measurementConsistencyWeeks":
    case "selfContextCompleteCount":
    case "nightOwlCount":
    case "earlyBirdCount":
    case "leapDayCount":
    case "doctorPdfCount":
    case "localeFlipCount":
      // No metric-data precondition — the user has an account, so the
      // achievement is always discoverable. The five hidden-metric keys
      // are filtered earlier in `applyDiscoveryFilter` by category, but
      // we cover them here for exhaustiveness.
      return true;
  }
}
