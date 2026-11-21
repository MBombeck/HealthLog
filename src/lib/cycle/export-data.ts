/**
 * Cycle export summary — the shared read both the FHIR Observation emitter
 * and the doctor-PDF cycle section consume, so the two surfaces describe
 * identical numbers (the source-of-truth property the export family holds).
 *
 * Reads cycle data scoped to `userId` + `deletedAt: null`. Computes the
 * concise clinical summary: last menstrual period (LMP), recent observed
 * cycles, average length + variability, average period length, and the
 * current phase. Pure stats; no prediction (predictions are forecasts, not
 * a clinical record of what happened).
 *
 * `notesEncrypted` is NEVER touched here — the export summary is
 * statistics only, so no plaintext free-text ever reaches a report surface
 * through this path.
 */
import { prisma } from "@/lib/db";
import { median, mad } from "@/lib/cycle/prediction";
import { phaseForDay } from "@/lib/cycle/phase";
import { dayDiff, addDays } from "@/lib/cycle/day-math";
import { LUTEAL_DEFAULT, type CyclePhase } from "@/lib/cycle/types";
import { resolvePregnancyState } from "@/lib/cycle/pregnancy";

/** One observed cycle in the recent-cycles table. */
export interface CycleExportCycle {
  /** YYYY-MM-DD period start. */
  startDate: string;
  /** Observed cycle length in days (start→next start), null for the open cycle. */
  lengthDays: number | null;
  /** Observed period (bleeding) length in days, null when unknown. */
  periodLengthDays: number | null;
}

/** The concise cycle summary surfaced in FHIR + the doctor PDF. */
export interface CycleExportSummary {
  /** YYYY-MM-DD of the most recent period start (LMP). */
  lastPeriodStart: string | null;
  /** Observed cycles within the window, newest first (capped). */
  recentCycles: CycleExportCycle[];
  /** Count of observed cycles used for the stats. */
  observedCycleCount: number;
  /** Median observed cycle length (days). Null with < 1 completed cycle. */
  averageCycleLengthDays: number | null;
  /**
   * Cycle-length variability (days) — the median absolute deviation of the
   * observed lengths, a robust spread measure. Null with < 2 cycles.
   */
  cycleLengthVariabilityDays: number | null;
  /** Median observed period length (days). Null when no period length known. */
  averagePeriodLengthDays: number | null;
  /** The phase the report date falls in, or null when it can't be resolved. */
  currentPhase: CyclePhase | null;
  /**
   * The pregnancy or postpartum state that holds on the report date,
   * or null. Dates and counts only; while it holds `currentPhase` is null.
   */
  pregnancy: CycleExportPregnancy | null;
}

/** The pregnancy block of the export summary (v1.49). */
export interface CycleExportPregnancy {
  state: "PREGNANT" | "POSTPARTUM";
  startDate: string | null;
  dueDate: string | null;
  deliveryDate: string | null;
  /** Completed weeks and days on the report date (PREGNANT only). */
  gestationalWeeks: number | null;
  gestationalDays: number | null;
  /** Completed weeks since the delivery on the report date (POSTPARTUM). */
  postpartumWeek: number | null;
}

/** The pregnancy block on `asOf`, or null when no state holds then. */
async function exportPregnancy(
  userId: string,
  asOf: string,
): Promise<CycleExportPregnancy | null> {
  const profile = await prisma.cycleProfile.findUnique({
    where: { userId },
    select: {
      reproductiveState: true,
      pregnancyStartDate: true,
      pregnancyDueDate: true,
      deliveryDate: true,
      postpartumWeeks: true,
    },
  });
  if (!profile) return null;
  const resolved = resolvePregnancyState(profile, asOf);
  if (!resolved.state) return null;
  return {
    state: resolved.state,
    startDate: profile.pregnancyStartDate,
    dueDate: resolved.dueDate,
    deliveryDate: resolved.deliveryDate,
    gestationalWeeks: resolved.gestationalAge?.weeks ?? null,
    gestationalDays: resolved.gestationalAge?.days ?? null,
    postpartumWeek: resolved.postpartumWeek,
  };
}

/** Max observed cycles surfaced in the recent-cycles table. */
const RECENT_CYCLES_CAP = 12;

/**
 * Build the cycle export summary for a user. `asOf` anchors the
 * current-phase calculation (defaults to today). Returns null when the
 * user has no observed cycles at all (the caller then omits the section).
 */
export async function buildCycleExportSummary(
  userId: string,
  asOf: string,
  lutealLength: number = LUTEAL_DEFAULT,
): Promise<CycleExportSummary | null> {
  const cycles = await prisma.menstrualCycle.findMany({
    where: { userId, deletedAt: null, isPredicted: false },
    orderBy: { startDate: "asc" },
    select: {
      startDate: true,
      endDate: true,
      periodEndDate: true,
      lengthDays: true,
      ovulationDate: true,
    },
  });

  const pregnancy = await exportPregnancy(userId, asOf);
  if (cycles.length === 0) {
    // A pregnancy with no logged cycle is still the section's content.
    return pregnancy
      ? {
          lastPeriodStart: null,
          recentCycles: [],
          observedCycleCount: 0,
          averageCycleLengthDays: null,
          cycleLengthVariabilityDays: null,
          averagePeriodLengthDays: null,
          currentPhase: null,
          pregnancy,
        }
      : null;
  }

  // Observed length: prefer the stored lengthDays, else derive from the
  // next cycle's start (the canonical start→next-start definition).
  const observed: CycleExportCycle[] = cycles.map((c, i) => {
    const next = cycles[i + 1];
    const lengthDays =
      c.lengthDays ?? (next ? dayDiff(next.startDate, c.startDate) : null);
    const periodLengthDays =
      c.periodEndDate !== null
        ? dayDiff(c.periodEndDate, c.startDate) + 1
        : null;
    return { startDate: c.startDate, lengthDays, periodLengthDays };
  });

  const lengths = observed
    .map((c) => c.lengthDays)
    .filter((n): n is number => n !== null && n > 0);
  const periodLengths = observed
    .map((c) => c.periodLengthDays)
    .filter((n): n is number => n !== null && n > 0);

  const averageCycleLengthDays =
    lengths.length >= 1 ? Math.round(median(lengths) * 10) / 10 : null;
  const cycleLengthVariabilityDays =
    lengths.length >= 2
      ? Math.round(mad(lengths, median(lengths)) * 10) / 10
      : null;
  const averagePeriodLengthDays =
    periodLengths.length >= 1
      ? Math.round(median(periodLengths) * 10) / 10
      : null;

  const lastPeriodStart = cycles[cycles.length - 1]?.startDate ?? null;

  // Current phase: resolve against the cycle whose window contains `asOf`.
  let currentPhase: CyclePhase | null = null;
  const last = cycles[cycles.length - 1];
  if (last && !pregnancy) {
    // The open cycle's nextStart is unknown; estimate it from the median
    // length so the phase math has a window.
    const estLength = averageCycleLengthDays ?? 28;
    const nextStart = last.endDate
      ? addDays(last.endDate, 1)
      : addDays(last.startDate, Math.round(estLength));
    const periodLen = observed[observed.length - 1]?.periodLengthDays ?? null;
    const { phase } = phaseForDay(asOf, {
      startDate: last.startDate,
      nextStart,
      ovulationDate: last.ovulationDate,
      periodLength: periodLen,
      lutealLength,
    });
    currentPhase = phase;
  }

  return {
    lastPeriodStart,
    recentCycles: observed.slice(-RECENT_CYCLES_CAP).reverse(),
    observedCycleCount: observed.length,
    averageCycleLengthDays,
    cycleLengthVariabilityDays,
    averagePeriodLengthDays,
    currentPhase,
    pregnancy,
  };
}
