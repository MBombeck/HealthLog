/**
 * The ENERGY_BALANCE correlation channel: the daily energy balance as a
 * behaviour series, read through the same `readEnergyBalanceForUser` the
 * nutrients page uses, so the scan and the card cannot disagree on a day.
 *
 * A day missing intake, resting or active energy is no point (never zero),
 * and today stays out because its meals and its activity are not finished.
 * Below the paired-day floor the series is empty and the pair degrades to
 * absent like every other thin channel. The caller skips the read when the
 * `nutrients` module is off.
 */
import {
  ENERGY_BALANCE_CHANNEL_KEY,
  type NamedSeries,
} from "@/lib/insights/correlation-discovery";
import { prisma } from "@/lib/db";
import { MIN_PAIRED_N } from "@/lib/insights/correlations";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";
import {
  ENERGY_BALANCE_MIN_DAYS,
  completeBalanceDays,
  readEnergyBalanceForUser,
} from "@/lib/nutrients/energy-balance";

/** The longest scan window the channel reads, in local days. */
export const ENERGY_BALANCE_SCAN_MAX_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local days from `since` through today, clamped to the read's bounds. */
export function energyBalanceScanDays(since: Date, now: Date): number {
  const days = Math.ceil((now.getTime() - since.getTime()) / DAY_MS) + 1;
  return Math.min(
    ENERGY_BALANCE_SCAN_MAX_DAYS,
    Math.max(ENERGY_BALANCE_MIN_DAYS, days),
  );
}

export async function fetchEnergyBalanceSeries(
  userId: string,
  tz: string,
  since: Date,
  now: Date = new Date(),
): Promise<NamedSeries[]> {
  const days = energyBalanceScanDays(since, now);
  const empty: NamedSeries[] = [
    { key: ENERGY_BALANCE_CHANNEL_KEY, role: "behaviour", points: [] },
  ];
  // Fewer intake days than the floor can never make a series, so the
  // profile and energy reads are skipped for the many records that import no
  // food at all. A day key per row, at most the floor's worth.
  const first = shiftDateKey(userDayKey(now, tz), -(days - 1));
  const intakeDays = await prisma.nutrientIntakeDay.findMany({
    where: { userId, nutrient: "energy", day: { gte: first } },
    distinct: ["day"],
    take: MIN_PAIRED_N,
    select: { day: true },
  });
  if (intakeDays.length < MIN_PAIRED_N) return empty;

  const balance = await readEnergyBalanceForUser({ userId, tz, days });
  const points = completeBalanceDays(balance);
  if (points.length < MIN_PAIRED_N) return empty;
  return [{ key: ENERGY_BALANCE_CHANNEL_KEY, role: "behaviour", points }];
}
