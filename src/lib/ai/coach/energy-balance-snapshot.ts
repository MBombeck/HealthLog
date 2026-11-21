/**
 * The energy-balance line of the Coach snapshot: the window means of the
 * daily balance (intake against resting plus active energy) over the last
 * fourteen finished days, read through `readEnergyBalanceForUser`, the same
 * read the nutrients page renders.
 *
 * Compact on purpose: four numbers and two counts, never the per-day rows,
 * so it costs a few dozen characters of the Coach budget and registers for
 * the degrader like any other block. It is data, framed as data: the
 * `basis` string says what the figure is, and the system prompt tells the
 * Coach to describe it and never to turn it into a target or a diet.
 *
 * Gated three ways: the `nutrients` module (off reads nothing), the
 * `active_energy` Coach source (the person can leave energy out), and the
 * lookback limit (a limit shorter than the window leaves the line out rather
 * than averaging fewer days). Null when no finished day holds a balance, or
 * when the read fails.
 */
import { annotate } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { readEnergyBalanceForUser } from "@/lib/nutrients/energy-balance";
import { fitsReach, type CoachHistoryReach } from "./history-reach";

/** Finished days the line averages over, plus today (left out as partial). */
export const ENERGY_BALANCE_SNAPSHOT_DAYS = 15;

export interface EnergyBalanceSnapshotBlock {
  windowDays: number;
  daysWithBalance: number;
  meanIntakeKcal: number | null;
  meanExpenditureKcal: number | null;
  meanBalanceKcal: number | null;
  /** Days whose resting energy is the Mifflin-St Jeor estimate. */
  restingEstimatedDays: number;
  basis: string;
}

const BASIS =
  "recorded intake minus resting and active energy, per finished day; " +
  "a description of the record, not a target";

export async function buildEnergyBalanceSnapshotBlock(
  userId: string,
  userTz: string,
  reach: CoachHistoryReach,
): Promise<EnergyBalanceSnapshotBlock | null> {
  if (!fitsReach(ENERGY_BALANCE_SNAPSHOT_DAYS, reach)) return null;
  if (!(await isModuleEnabled(userId, "nutrients"))) return null;
  let balance;
  try {
    balance = await readEnergyBalanceForUser({
      userId,
      tz: userTz,
      days: ENERGY_BALANCE_SNAPSHOT_DAYS,
    });
  } catch {
    // An optional context line: a failed read leaves it out of this turn
    // rather than failing the turn.
    annotate({ action: { name: "coach.snapshot.energy_balance_failed" } });
    return null;
  }
  if (balance.summary.daysWithBalance === 0) return null;
  const counted = balance.days.filter(
    (d) => !d.partial && d.balanceKcal !== null,
  );
  return {
    windowDays: ENERGY_BALANCE_SNAPSHOT_DAYS - 1,
    daysWithBalance: balance.summary.daysWithBalance,
    meanIntakeKcal: balance.summary.meanIntakeKcal,
    meanExpenditureKcal: balance.summary.meanExpenditureKcal,
    meanBalanceKcal: balance.summary.meanBalanceKcal,
    restingEstimatedDays: counted.filter((d) => d.restingEstimated).length,
    basis: BASIS,
  };
}
