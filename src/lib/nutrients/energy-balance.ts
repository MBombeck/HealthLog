/**
 * The daily energy balance: what was eaten against what was used.
 *
 *   expenditure = resting energy + active energy
 *   balance     = intake − expenditure
 *
 * Nothing here is logged by HealthLog itself. Intake is the day's folded
 * `energy` total from the nutrient store (Apple Health, Health Connect or a
 * bridge such as a recipe app's exporter), resting and active energy are the
 * day sums of `BASAL_ENERGY_BURNED` and `ACTIVE_ENERGY_BURNED`. The balance is
 * computed on every read, so a corrected or late import moves it with no
 * recalculation step.
 *
 * A day without a resting reading takes an estimate: the Mifflin-St Jeor
 * equation from the weight carried forward to that day, the height, the age
 * on that day and the profile's sex. Without any one of them there is no
 * estimate, and the day has no expenditure: an honest gap rather than a
 * number built on a guess. A day without an active reading has no
 * expenditure either, because leaving it out would overstate a deficit.
 * A day without an intake has no balance; zero would read as a fast.
 *
 * Today is marked partial and kept out of the trend and the window means: its
 * meals and its activity are not finished.
 *
 * The trend is the mean balance of the seven days ending on each day, once
 * four of them hold a balance. It is a description of the record, not a
 * target and not a forecast.
 */
import { prisma } from "@/lib/db";
import { readLocalDailyStats } from "@/lib/day/daily-stats";
import { binaryReferenceSex } from "@/lib/profile/sex";
import { dateOfBirthKey } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

import { foldNutrientDays } from "./day-total";

export const ENERGY_BALANCE_MIN_DAYS = 7;
export const ENERGY_BALANCE_MAX_DAYS = 90;
const TREND_DAYS = 7;
const TREND_MIN_DAYS = 4;

export interface EnergyProfile {
  sex: "MALE" | "FEMALE" | null;
  heightCm: number | null;
  /** `YYYY-MM-DD`, or null. */
  birthDay: string | null;
}

export type EstimateGap = "weight" | "height" | "birthDate" | "sex";

export interface EnergyBalanceDay {
  day: string;
  intakeKcal: number | null;
  restingKcal: number | null;
  /** The resting figure is the Mifflin-St Jeor estimate, not a reading. */
  restingEstimated: boolean;
  activeKcal: number | null;
  expenditureKcal: number | null;
  balanceKcal: number | null;
  /** Mean balance of the seven days ending here, once four hold one. */
  trendKcal: number | null;
  /** Today: still running, so outside the trend and the means. */
  partial: boolean;
}

export interface EnergyBalance {
  windowDays: number;
  days: EnergyBalanceDay[];
  summary: {
    daysWithBalance: number;
    meanIntakeKcal: number | null;
    meanExpenditureKcal: number | null;
    meanBalanceKcal: number | null;
  };
  /** What the resting estimate lacks; empty when it can be made. */
  estimateGaps: EstimateGap[];
}

/** Mifflin-St Jeor resting energy, kcal/day. */
export function mifflinStJeor(args: {
  sex: "MALE" | "FEMALE";
  weightKg: number;
  heightCm: number;
  ageYears: number;
}): number {
  const base = 10 * args.weightKg + 6.25 * args.heightCm - 5 * args.ageYears;
  return base + (args.sex === "MALE" ? 5 : -161);
}

/** Whole years between a birth day and a day, both `YYYY-MM-DD`. */
export function ageOn(birthDay: string, day: string): number {
  const [by, bm, bd] = birthDay.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

const round = (v: number) => Math.round(v);

function mean(values: readonly number[]): number | null {
  return values.length === 0
    ? null
    : round(values.reduce((a, b) => a + b, 0) / values.length);
}

/** Pure: the balance over `dayKeys` (ascending) from the day maps. */
export function computeEnergyBalance(input: {
  dayKeys: readonly string[];
  today: string;
  intake: ReadonlyMap<string, number>;
  resting: ReadonlyMap<string, number>;
  active: ReadonlyMap<string, number>;
  weight: ReadonlyMap<string, number>;
  /** The last weight before the window, carried into it. */
  seedWeightKg: number | null;
  profile: EnergyProfile;
}): EnergyBalance {
  const { profile } = input;
  const gaps: EstimateGap[] = [];
  if (profile.heightCm === null) gaps.push("height");
  if (profile.birthDay === null) gaps.push("birthDate");
  if (profile.sex === null) gaps.push("sex");
  const weightKnown = input.seedWeightKg !== null || input.weight.size > 0;
  if (!weightKnown) gaps.push("weight");

  let weightKg = input.seedWeightKg;
  const days: EnergyBalanceDay[] = input.dayKeys.map((day) => {
    weightKg = input.weight.get(day) ?? weightKg;
    const intake = input.intake.get(day) ?? null;
    const active = input.active.get(day) ?? null;
    let resting = input.resting.get(day) ?? null;
    let restingEstimated = false;
    if (
      resting === null &&
      weightKg !== null &&
      profile.heightCm !== null &&
      profile.birthDay !== null &&
      profile.sex !== null
    ) {
      resting = mifflinStJeor({
        sex: profile.sex,
        weightKg,
        heightCm: profile.heightCm,
        ageYears: ageOn(profile.birthDay, day),
      });
      restingEstimated = true;
    }
    const expenditure =
      resting !== null && active !== null ? resting + active : null;
    return {
      day,
      intakeKcal: intake === null ? null : round(intake),
      restingKcal: resting === null ? null : round(resting),
      restingEstimated,
      activeKcal: active === null ? null : round(active),
      expenditureKcal: expenditure === null ? null : round(expenditure),
      balanceKcal:
        intake !== null && expenditure !== null
          ? round(intake - expenditure)
          : null,
      trendKcal: null,
      partial: day === input.today,
    };
  });

  for (let i = 0; i < days.length; i++) {
    const window = days
      .slice(Math.max(0, i - TREND_DAYS + 1), i + 1)
      .filter((d) => !d.partial && d.balanceKcal !== null)
      .map((d) => d.balanceKcal as number);
    if (!days[i].partial && window.length >= TREND_MIN_DAYS) {
      days[i].trendKcal = mean(window);
    }
  }

  const complete = days.filter((d) => !d.partial && d.balanceKcal !== null);
  return {
    windowDays: days.length,
    days,
    summary: {
      daysWithBalance: complete.length,
      meanIntakeKcal: mean(complete.map((d) => d.intakeKcal as number)),
      meanExpenditureKcal: mean(
        complete.map((d) => d.expenditureKcal as number),
      ),
      meanBalanceKcal: mean(complete.map((d) => d.balanceKcal as number)),
    },
    estimateGaps: gaps,
  };
}

/** The balance of the `days` local days ending today, read live. */
export async function readEnergyBalance(args: {
  userId: string;
  tz: string;
  days: number;
  gender: string | null;
  heightCm: number | null;
  dateOfBirth: Date | null;
  sourcePriorityJson: unknown;
}): Promise<EnergyBalance> {
  const today = userDayKey(new Date(), args.tz);
  const first = shiftDateKey(today, -(args.days - 1));
  const dayKeys = Array.from({ length: args.days }, (_, i) =>
    shiftDateKey(first, i),
  );
  const from = startOfLocalDayKey(first, args.tz);
  const to = startOfLocalDayKey(shiftDateKey(today, 1), args.tz);

  const [intakeRows, stats, seed] = await Promise.all([
    prisma.nutrientIntakeDay.findMany({
      where: { userId: args.userId, nutrient: "energy", day: { gte: first } },
      select: { day: true, amount: true, source: true },
    }),
    readLocalDailyStats({
      userId: args.userId,
      types: ["BASAL_ENERGY_BURNED", "ACTIVE_ENERGY_BURNED", "WEIGHT"],
      from,
      to,
      tz: args.tz,
      priorityJson: args.sourcePriorityJson,
    }),
    prisma.measurement.findFirst({
      where: {
        userId: args.userId,
        type: "WEIGHT",
        deletedAt: null,
        measuredAt: { lt: from },
      },
      orderBy: { measuredAt: "desc" },
      select: { value: true },
    }),
  ]);

  const intake = new Map<string, number>();
  for (const [day, fold] of foldNutrientDays(intakeRows, (r) => r.day)) {
    intake.set(day, fold.total);
  }
  return computeEnergyBalance({
    dayKeys,
    today,
    intake,
    resting: stats.get("BASAL_ENERGY_BURNED") ?? new Map(),
    active: stats.get("ACTIVE_ENERGY_BURNED") ?? new Map(),
    weight: stats.get("WEIGHT") ?? new Map(),
    seedWeightKg: seed?.value ?? null,
    profile: {
      sex: binaryReferenceSex(args.gender),
      heightCm: args.heightCm,
      birthDay: args.dateOfBirth
        ? dateOfBirthKey(args.dateOfBirth, args.tz)
        : null,
    },
  });
}

/**
 * The balance of a record, with the profile read here: the route, the
 * correlation scan and the Coach snapshot all read the same inputs, so none
 * of them can estimate resting energy from a different profile.
 */
export async function readEnergyBalanceForUser(args: {
  userId: string;
  tz: string;
  days: number;
}): Promise<EnergyBalance> {
  const profile = await prisma.user.findUnique({
    where: { id: args.userId },
    select: {
      gender: true,
      heightCm: true,
      dateOfBirth: true,
      sourcePriorityJson: true,
    },
  });
  return readEnergyBalance({
    userId: args.userId,
    tz: args.tz,
    days: args.days,
    gender: profile?.gender ?? null,
    heightCm: profile?.heightCm ?? null,
    dateOfBirth: profile?.dateOfBirth ?? null,
    sourcePriorityJson: profile?.sourcePriorityJson ?? null,
  });
}

/**
 * The finished days that hold a balance, oldest first: the daily series the
 * correlation scan pairs. A day missing an input stays out rather than
 * entering as zero, and today stays out because it is still running.
 */
export function completeBalanceDays(
  balance: EnergyBalance,
): Array<{ day: string; value: number }> {
  return balance.days
    .filter((d) => !d.partial && d.balanceKcal !== null)
    .map((d) => ({ day: d.day, value: d.balanceKcal as number }));
}
