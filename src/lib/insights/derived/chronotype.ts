/**
 * v1.17.0 — MCTQ chronotype + social jetlag (server-authoritative).
 *
 * Implements the Munich ChronoType Questionnaire derivation from observed
 * sleep, not a survey: Roenneberg, Wirz-Justice & Merrow (2003), *J Biol
 * Rhythms* 18(1):80-90; Roenneberg et al. (2007), *Sleep Med Rev* 11(6):429-
 * 438. The chronotype marker is MID-SLEEP ON FREE DAYS (MSF) — the clock time
 * halfway between sleep onset and wake on days without an alarm — corrected
 * for the sleep debt people pay off by sleeping in on free days (MSFsc).
 *
 *   MSF      = circular mean of free-day sleep midpoints (minutes-of-day).
 *   MSFsc    = MSF − 0.5·(SDf − SDweek)   when SDf > SDweek, else MSF
 *              where SDf  = average free-day sleep DURATION,
 *                    SDweek = average sleep duration across work + free days.
 *   SJL      = social jetlag = circular |MSF_work − MSF_free|.
 *
 * The MSFsc correction (Roenneberg 2007) removes the morning "oversleep" that
 * a sleep-debt rebound adds to the free-day midpoint, so a workweek-deprived
 * sleeper is not mislabelled later than their true phase.
 *
 * ONE MIDPOINT ESTIMATOR
 * ----------------------
 * The per-night `midpointMinutes` is the SAME minutes-of-day midpoint the
 * Sleep Score's Timing sub-score reads (centre of the canonical asleep span,
 * in the user's wall clock). The caller supplies it; chronotype does NOT
 * re-derive a second midpoint — and it reuses `circularMeanMinutes` /
 * `circularMinuteDistance` from the Sleep Score so the midnight-straddle / DST
 * handling is identical. Pure — no Prisma, no I/O; route, Coach, PDF, and the
 * iOS serializer all reuse it.
 *
 * LEARNING GATE
 * -------------
 * Chronotype is a stable trait and a thin sample is noise. Below
 * `minFreeNights` free-day nights the result is a calm "still learning — N of
 * M nights" state and asserts NO type. This mirrors the Sleep Score's
 * "< 3 nights → null" timing gate; the band only appears once the free-day
 * sample is large enough to mean something.
 *
 * FREE vs WORK
 * ------------
 * The app has no work calendar, so the day-type signal is an INPUT per night
 * (the caller maps weekday/weekend or a future shift schedule). A modelling
 * assumption, surfaced as such — not hardcoded here.
 */
import { circularMeanMinutes, circularMinuteDistance } from "./sleep-score";
import { mean } from "@/lib/stats/central";

const MINUTES_PER_DAY = 1440;

/** One night fed to the chronotype estimator. */
export interface ChronotypeNight {
  /** Wake-day key (YYYY-MM-DD), user timezone. */
  night: string;
  /**
   * Sleep midpoint as minutes-of-day (0..1439) in the user's wall clock — the
   * SAME estimator the Sleep Score Timing sub-score uses. The caller passes it;
   * this module does not re-derive a midpoint.
   */
  midpointMinutes: number;
  /** Canonical time-asleep minutes (`SleepNight.asleepMinutes`) for SD math. */
  asleepMinutes: number;
  /** Day type — caller-supplied (no work calendar is hardcoded here). */
  dayType: "work" | "free";
}

export interface ChronotypeOptions {
  /**
   * Minimum free-day nights before a chronotype band is asserted. MCTQ needs a
   * stable free-day estimate; below this the result stays in the calm learning
   * state. 3 mirrors the Sleep Score's timing/consistency floor — enough to
   * dampen a single anomalous lie-in without demanding a month of data.
   */
  minFreeNights?: number;
}

const DEFAULTS: Required<ChronotypeOptions> = {
  minFreeNights: 3,
};

/**
 * MCTQ chronotype band off MSFsc (minutes-of-day). The cut points follow the
 * Roenneberg population percentiles (extreme-early through extreme-late around
 * a ~04:00 mid-sleep mode). One banding helper — never re-thresholded per
 * surface.
 */
export type ChronotypeBand =
  "extreme_early" | "early" | "intermediate" | "late" | "extreme_late";

/**
 * Band a corrected mid-sleep (MSFsc, minutes-of-day) into the MCTQ chronotype
 * classes. Cut points (local clock): < 02:30 extreme-early, < 03:30 early,
 * < 05:00 intermediate, < 06:00 late, else extreme-late — the standard MCTQ
 * MSFsc deciles centred on the ~04:00 population mode.
 */
export function bandForMSFsc(msfscMinutes: number): ChronotypeBand {
  // Normalise onto [0,1440) so a value that the correction pushed below 0 or a
  // late-night midpoint past midnight still bands on the wall clock.
  const m =
    ((msfscMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  if (m < 150) return "extreme_early"; // < 02:30
  if (m < 210) return "early"; // < 03:30
  if (m < 300) return "intermediate"; // < 05:00
  if (m < 360) return "late"; // < 06:00
  return "extreme_late";
}

export interface ChronotypeResult {
  /**
   * `learning` until `minFreeNights` free-day nights exist — no band asserted.
   * `ready` once the free-day sample is large enough.
   */
  state: "learning" | "ready";
  /** Mid-sleep on free days (minutes-of-day), or null while learning. */
  msfMinutes: number | null;
  /** Sleep-debt-corrected mid-sleep on free days (minutes-of-day), or null. */
  msfScMinutes: number | null;
  /** Chronotype band off MSFsc, or null while learning. */
  band: ChronotypeBand | null;
  /**
   * Social jetlag in minutes = circular |MSF_work − MSF_free|. Null when there
   * is no work-day OR no free-day midpoint to compare (one side missing).
   */
  socialJetlagMinutes: number | null;
  /** Free-day nights counted. */
  freeNightsCounted: number;
  /** Work-day nights counted. */
  workNightsCounted: number;
  /** `minFreeNights` − `freeNightsCounted` while learning, else 0. */
  freeNightsUntilReady: number;
}

/**
 * Derive MCTQ chronotype, MSFsc, and social jetlag from per-night midpoints +
 * day types. Pure. Holds the learning gate until enough free-day nights exist.
 */
export function computeChronotype(
  nights: readonly ChronotypeNight[],
  options: ChronotypeOptions = {},
): ChronotypeResult {
  const opts = { ...DEFAULTS, ...options };
  const usable = nights.filter(
    (n) =>
      Number.isFinite(n.midpointMinutes) &&
      Number.isFinite(n.asleepMinutes) &&
      n.asleepMinutes > 0,
  );
  const free = usable.filter((n) => n.dayType === "free");
  const work = usable.filter((n) => n.dayType === "work");

  const freeNightsCounted = free.length;
  const workNightsCounted = work.length;

  // MSF = circular mean of free-day midpoints (handles the midnight straddle).
  const msfMinutes = circularMeanMinutes(free.map((n) => n.midpointMinutes));
  // MSW = circular mean of work-day midpoints — only used for social jetlag.
  const mswMinutes = circularMeanMinutes(work.map((n) => n.midpointMinutes));

  // Social jetlag = circular distance between the work and free mid-sleeps.
  // Both sides must exist; otherwise the offset is undefined (not zero).
  const socialJetlagMinutes =
    msfMinutes != null && mswMinutes != null
      ? circularMinuteDistance(mswMinutes, msfMinutes)
      : null;

  const ready = freeNightsCounted >= opts.minFreeNights && msfMinutes != null;
  if (!ready) {
    return {
      state: "learning",
      msfMinutes: null,
      msfScMinutes: null,
      band: null,
      socialJetlagMinutes,
      freeNightsCounted,
      workNightsCounted,
      freeNightsUntilReady: Math.max(0, opts.minFreeNights - freeNightsCounted),
    };
  }

  // MSFsc correction (Roenneberg 2007): subtract half the free-day oversleep
  // (free-day duration minus the week-average duration), applied only when
  // people sleep LONGER on free days (paying off workweek debt). When SDf ≤
  // SDweek there is no debt rebound, so MSFsc = MSF.
  const sdFree = mean(free.map((n) => n.asleepMinutes)) ?? 0;
  const sdWeek = mean(usable.map((n) => n.asleepMinutes)) ?? sdFree;
  const oversleep = Math.max(0, sdFree - sdWeek);
  const msfScRaw = msfMinutes - 0.5 * oversleep;
  const msfScMinutes =
    ((msfScRaw % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return {
    state: "ready",
    msfMinutes,
    msfScMinutes,
    band: bandForMSFsc(msfScMinutes),
    socialJetlagMinutes,
    freeNightsCounted,
    workNightsCounted,
    freeNightsUntilReady: 0,
  };
}
