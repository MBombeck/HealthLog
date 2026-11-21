/**
 * v1.17.0 — sleep-rhythm assembler (server-authoritative).
 *
 * The one place that turns a user's raw `SLEEP_DURATION` rows into the two
 * timing signals the Sleep page + the iOS client + the dashboard render:
 *
 *   - the outstanding SLEEP DEBT balance over the rolling window
 *     (`computeSleepDebt`; surplus sleep pays it down), and
 *   - MCTQ CHRONOTYPE + social jetlag (`computeChronotype`).
 *
 * ONE ENGINE, NO DUPLICATION
 * --------------------------
 * The per-night `asleepMinutes` and `midpointMinutes` come from the SAME
 * canonical reconstruction the Sleep Score reads — `reconstructNights`
 * (`sleep-score.ts`), which itself adapts `reconstructSleepNights`
 * (`sleep-night.ts`). This module does NOT re-cluster sessions, re-dedup
 * writers, or re-derive a midpoint; it maps the canonical night output onto
 * the two foundation modules' inputs and forwards the resolved `needMinutes`.
 * The math lives entirely in `sleep-debt.ts` / `chronotype.ts` — this file is
 * the adapter + DB read + day-type resolver, nothing else. Because the inputs
 * are the canonical totals, the debt headline and the chronotype band can
 * never contradict the dashboard / hypnogram / Sleep Score for the same night.
 *
 * DAY-TYPE SIGNAL (free vs work)
 * ------------------------------
 * Chronotype's MSF needs each night tagged free or work, and the app has no
 * work calendar. The documented DEFAULT is calendar-based: a night whose WAKE
 * day falls on Saturday or Sunday (in the user's timezone) is "free"; every
 * other night is "work". This mirrors the MCTQ assumption that weekends are
 * the alarm-free days for a standard work week — surfaced as a modelling
 * assumption, not a hidden constant. When a future per-night logged day-type
 * exists it overrides this default; until then weekday/weekend is the floor.
 *
 * Server-only — reads raw `SLEEP_DURATION` rows via Prisma, bounded to the
 * window. The DTO is the shared wire shape the route, the dashboard summary,
 * and the iOS serializer all emit identically.
 */
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  parseSourcePriority,
  resolveSleepDebtSource,
} from "@/lib/validations/source-priority";
import { loadBaselineProfile } from "./baseline";
import {
  dayTypeForNight,
  type FreeWeekdaysSpan,
} from "@/lib/profile/life-derived";
import { loadFreeWeekdaySpans } from "@/lib/profile/life-circumstances";
import { reconstructNights, sleepNeedMinutes } from "./sleep-score";
import {
  computeSleepDebt,
  type SleepDebtNight,
  type SleepDebtResult,
} from "./sleep-debt";
import {
  computeChronotype,
  type ChronotypeNight,
  type ChronotypeResult,
} from "./chronotype";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Trailing read window in days. The sleep-debt rolling window is short (a few
 * recent nights) and chronotype wants a few weeks of free-day samples; 42 days
 * (six weeks) gives both windows full coverage and ~12 weekend nights for a
 * stable MSF while staying a bounded per-stage read.
 */
const DEFAULT_WINDOW_DAYS = 42;

/** Wire DTO for the rolling sleep debt — see `SleepDebtResult`. */
export interface SleepDebtDto {
  state: "partial" | "ready";
  debtMinutes: number;
  needMinutes: number;
  nightsCounted: number;
  windowNights: number;
  nightsUntilReady: number;
  /**
   * v1.25.0 — the active source the debt figure is resolved FROM, picked off
   * the user's `sleepDebt` source ladder. `COMPUTED` means HealthLog's own
   * rolling-balance estimate (the only producer today); a provider value would
   * mean a device-native debt. The UI explains the figure when it is COMPUTED.
   */
  source: MeasurementSource;
}

/**
 * Wire DTO for the average sleep per night over the rhythm window.
 *
 * v1.19.1 — a third peer card next to sleep-debt + chronotype. The mean of the
 * canonical per-night asleep totals over the full scorable span (up to
 * `DEFAULT_WINDOW_DAYS`). Each of the three cards reads its OWN sub-window —
 * sleep-debt caps to 14 nights, chronotype to `CHRONOTYPE_WINDOW_NIGHTS`, this
 * average over every scorable night — so the figures are each internally honest
 * rather than identical; the card caption discloses its `nightsCounted` so the
 * reader sees exactly which span produced the number. Carries the same calm
 * `partial` state under a minimum-night threshold so it never asserts an average
 * off one or two thin nights.
 */
export interface AverageSleepDto {
  state: "partial" | "ready";
  /** Mean asleep minutes per scorable night (0 while partial). */
  averageMinutes: number;
  nightsCounted: number;
  nightsUntilReady: number;
}

/** Wire DTO for the MCTQ chronotype — see `ChronotypeResult`. */
export interface ChronotypeDto {
  state: "learning" | "ready";
  msfMinutes: number | null;
  msfScMinutes: number | null;
  band:
    "extreme_early" | "early" | "intermediate" | "late" | "extreme_late" | null;
  socialJetlagMinutes: number | null;
  freeNightsCounted: number;
  workNightsCounted: number;
  freeNightsUntilReady: number;
}

/** The combined sleep-rhythm DTO — both signals in one read. */
export interface SleepRhythmDto {
  sleepDebt: SleepDebtDto;
  chronotype: ChronotypeDto;
  averagePerNight: AverageSleepDto;
}

/**
 * Minimum scorable nights before the average asserts a figure. Mirrors the
 * sleep-debt `minNights` floor (4) so the three peer cards settle in step.
 */
const AVG_MIN_NIGHTS = 4;

/**
 * Mean asleep minutes over the scorable nights, or the calm `partial` state
 * under the night floor. Pure: takes the already-filtered, ascending-sorted
 * scorable nights the rhythm assembler holds.
 */
export function computeAverageSleep(
  scorable: readonly RhythmNight[],
): AverageSleepDto {
  const nightsCounted = scorable.length;
  if (nightsCounted < AVG_MIN_NIGHTS) {
    return {
      state: "partial",
      averageMinutes: 0,
      nightsCounted,
      nightsUntilReady: AVG_MIN_NIGHTS - nightsCounted,
    };
  }
  const total = scorable.reduce((sum, n) => sum + n.asleepMinutes, 0);
  return {
    state: "ready",
    averageMinutes: Math.round(total / nightsCounted),
    nightsCounted,
    nightsUntilReady: 0,
  };
}

function toDebtDto(
  r: SleepDebtResult,
  source: MeasurementSource,
): SleepDebtDto {
  return {
    state: r.state,
    debtMinutes: r.debtMinutes,
    needMinutes: r.needMinutes,
    nightsCounted: r.nightsCounted,
    windowNights: r.windowNights,
    nightsUntilReady: r.nightsUntilReady,
    source,
  };
}

function toChronotypeDto(r: ChronotypeResult): ChronotypeDto {
  return {
    state: r.state,
    msfMinutes: r.msfMinutes,
    msfScMinutes: r.msfScMinutes,
    band: r.band,
    socialJetlagMinutes: r.socialJetlagMinutes,
    freeNightsCounted: r.freeNightsCounted,
    workNightsCounted: r.workNightsCounted,
    freeNightsUntilReady: r.freeNightsUntilReady,
  };
}

export interface SleepRhythmOpts {
  windowDays?: number;
  now?: Date;
  /** Pin the IANA zone in tests; omit to resolve the user's stored zone. */
  tz?: string;
}

/** A reconstructed night carrying the canonical asleep total + wall-clock midpoint. */
export interface RhythmNight {
  night: string;
  asleepMinutes: number;
  /** Sleep midpoint as minutes-of-day (0..1439), or null when undefined. */
  midpoint: number | null;
}

/**
 * Chronotype look-back in nights. The helper caps its OWN chronotype input to
 * the trailing `CHRONOTYPE_WINDOW_NIGHTS` so the result is a pure function of
 * the most-recent N nights — NOT of however many nights a given caller happened
 * to pass. Without this cap a caller that hands in a year of nights (the
 * dashboard summary's 365-day read) would average MSF/MSFsc/social-jetlag over
 * a different sample than a caller passing six weeks (the route), and the two
 * surfaces would disagree. `computeSleepDebt` already self-caps to its rolling
 * window, so the debt headline is source-window-independent for free; this brings the
 * chronotype to the same guarantee. 42 nights (six weeks) gives ~12 weekend
 * nights for a stable free-day MSF.
 */
const CHRONOTYPE_WINDOW_NIGHTS = 42;

/**
 * Pure DTO assembler from already-reconstructed nights. The route reads + runs
 * the canonical reconstruction; the dashboard summary reuses its own loaded
 * rows. Both feed the SAME foundation modules here so the values are identical
 * REGARDLESS of how many nights each caller passes — the helper owns the
 * chronotype window cap, so a 42-night and a 365-night caller get the same DTO.
 * This is the one place the window cap + day-type default + the two `compute*`
 * calls live.
 *
 * `nights` must already be the canonical engine's output (asleep + midpoint);
 * this function does NOT reconstruct. `needMinutes` is the age-resolved need.
 */
export function computeSleepRhythmFromNights(
  nights: readonly RhythmNight[],
  needMinutes: number,
  // v1.25.0 — the resolved sleep-debt source off the user's ladder. Defaults to
  // COMPUTED (the only producer today) so the dashboard + Coach snapshot
  // callers, which always surface our own estimate, need not thread it.
  sleepDebtSource: MeasurementSource = "COMPUTED",
  // v1.43 (#614) — the record's dated "free weekdays" answers. Each night is
  // read against the answer in force on its wake day; a night no answer
  // covers keeps the weekend default.
  freeWeekdaySpans: readonly FreeWeekdaysSpan[] = [],
): SleepRhythmDto {
  // Sort ascending by wake-day key so "trailing N" is well-defined regardless
  // of the caller's input order, then keep only scorable nights.
  const scorable = [...nights]
    .filter((n) => n.asleepMinutes > 0)
    .sort((a, b) => (a.night < b.night ? -1 : a.night > b.night ? 1 : 0));

  // Debt self-caps to its own short rolling window internally; pass every
  // scorable night and let the module slice.
  const debtNights: SleepDebtNight[] = scorable.map((n) => ({
    night: n.night,
    asleepMinutes: n.asleepMinutes,
  }));
  const sleepDebt = computeSleepDebt(debtNights, needMinutes);

  // Chronotype has no internal window — cap HERE to the trailing N nights so
  // the value is a function of the recent rhythm, not the caller's read span.
  const chronoNights: ChronotypeNight[] = scorable
    .filter((n) => n.midpoint != null)
    .slice(-CHRONOTYPE_WINDOW_NIGHTS)
    .map((n) => ({
      night: n.night,
      midpointMinutes: n.midpoint as number,
      asleepMinutes: n.asleepMinutes,
      dayType: dayTypeForNight(n.night, freeWeekdaySpans),
    }));
  const chronotype = computeChronotype(chronoNights);

  // Average sleep per night over the full scorable span. Each of the three peer
  // cards reads its OWN window — debt slices its trailing 14 nights, chronotype
  // its trailing CHRONOTYPE_WINDOW_NIGHTS, this average every scorable night —
  // so the figures are each internally honest rather than identical; each card's
  // caption shows its own nightsCounted so the reader sees the span behind it.
  const averagePerNight = computeAverageSleep(scorable);

  return {
    sleepDebt: toDebtDto(sleepDebt, sleepDebtSource),
    chronotype: toChronotypeDto(chronotype),
    averagePerNight,
  };
}

/**
 * Read raw sleep rows, reconstruct nights via the canonical engine, and
 * compute the sleep-debt + chronotype DTO. Returns the calm partial/learning
 * states (never asserts off thin data) when the window is short. The midpoint
 * + asleep totals are the canonical engine's — no second reconstruction.
 */
export async function buildSleepRhythm(
  userId: string,
  opts: SleepRhythmOpts = {},
): Promise<SleepRhythmDto> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (await resolveUserTimezone(userId));
  const [priorityJson, profile, freeWeekdaySpans] = await Promise.all([
    loadUserSourcePriority(userId),
    loadBaselineProfile(prisma, userId),
    loadFreeWeekdaySpans(userId),
  ]);
  const since = new Date(now.getTime() - windowDays * MS_PER_DAY);

  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION" satisfies MeasurementType,
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    // source + deviceType feed the canonical writer-dedup so a multi-source
    // night is counted ONCE, matching every other sleep surface.
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });

  // Canonical reconstruction (session-clustering, wake-day keying, writer
  // dedup) → per-night asleep total + wall-clock midpoint. Same engine as the
  // Sleep Score; we never re-derive a midpoint here. The helper owns the
  // scorable-night filter + the window cap, so we hand it the raw output.
  const nights = reconstructNights(rows, tz, priorityJson);

  const needMinutes = sleepNeedMinutes(profile.ageYears);
  // v1.25.0 — resolve the active sleep-debt source off the user's ladder so the
  // DTO (and the Sleep page) can name it and explain the COMPUTED estimate.
  const sleepDebtSource = resolveSleepDebtSource(
    parseSourcePriority(priorityJson),
  );
  return computeSleepRhythmFromNights(
    nights,
    needMinutes,
    sleepDebtSource,
    freeWeekdaySpans,
  );
}
