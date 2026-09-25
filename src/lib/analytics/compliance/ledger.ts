// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import type {
  BandMinterMedication,
  DoseWindowConfig,
} from "@/lib/medications/scheduling/band-minter";
import { buildBandsForSchedulesWithEras } from "@/lib/medications/scheduling/schedule-eras";
import {
  reconstructDoseHistory,
  type DoseHistoryRow,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import { userDayKey } from "@/lib/tz/resolver";
import type {
  ComplianceMedicationContext,
  ComplianceSchedule,
  IntakeEvent,
} from "./types";
import {
  intakeInstantsAtOrBefore,
  toCanonicalSchedule,
  toRecurrenceCtx,
} from "./adapters";

/**
 * v1.15.18 — the unified compliance tally over the dose-history ledger.
 *
 * THE single source of the medication compliance %. It builds the
 * cadence-aware `SlotBand[]` per schedule (the shared band minter — every
 * cadence: daily, fixed-weekday, rolling-retrospective, one-shot, cyclic,
 * PRN), reconstructs the ONE dose-history ledger
 * (`reconstructDoseHistory`), and tallies it so the percentage and the
 * history view are mathematically incapable of contradicting each other
 * (audit CRITICAL-2). It replaces the ±12h `pairDoses` proximity matcher
 * that `calculateCompliance` used for the engine-routed path.
 *
 * The tally follows the adherence literature's TAKING-vs-TIMING split:
 *   - numerator (taken) = `taken_on_time` + `taken_late` — a late dose is
 *     still a taken dose; "late" is NOT collapsed into "missed";
 *   - denominator = taken + `missed`;
 *   - EXCLUDED from the denominator: `skipped` (deliberate user decision),
 *     `ad_hoc` (off-schedule top-up — no defensible slot), `upcoming` (the
 *     window hasn't opened), and ENTIRE PRN groups (`hasExpectedSlots:false`
 *     — PRN has no defensible denominator per the literature);
 *   - the rate is capped at 100% (extra doses never inflate it).
 *
 * The on-time / late split is surfaced separately so a caller can show both
 * the TAKING rate (the headline) and the TIMING quality.
 *
 * Pure / synchronous: the bands are minted from pre-fetched schedules +
 * intake instants; no DB access.
 */
export interface LedgerComplianceTally {
  /** Doses taken (on-time + late). The TAKING-adherence numerator. */
  taken: number;
  /** Of `taken`, the count inside the on-time band. */
  takenOnTime: number;
  /** Of `taken`, the count in the late tail (still counts as taken). */
  takenLate: number;
  /** Expected doses never acted on past their miss cutoff. */
  missed: number;
  /** Deliberate user skips — excluded from the denominator. */
  skipped: number;
  /** Off-schedule intakes (PRN groups + ad-hoc rows) — excluded. */
  adHoc: number;
  /** taken + missed (the rate denominator). */
  denominator: number;
  /** round(100 · taken / denominator), capped at 100. 100 on empty. */
  rate: number;
}

export function tallyComplianceFromLedger(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  from: Date,
  to: Date,
  now: Date,
  windowConfig?: DoseWindowConfig,
): LedgerComplianceTally {
  const rows = buildComplianceLedgerRows(
    events,
    schedules,
    ctx,
    from,
    to,
    now,
    windowConfig,
  );
  return tallyLedgerRows(rows);
}

/**
 * Mint the cadence-aware bands over `[from, to]` and reconstruct the ONE
 * unified dose-history ledger for them. This is the expansion pass behind
 * {@link tallyComplianceFromLedger}, extracted so a caller that needs
 * several trailing sub-windows (7-day / 30-day / display / heatmap, all
 * ending at `now`) can mint the bands ONCE over the widest window and tally
 * each sub-window from the same rows via {@link tallyLedgerRows} instead of
 * re-expanding per window.
 *
 * Pure / synchronous: bands come from pre-fetched schedules + intake
 * instants; no DB access.
 */
export function buildComplianceLedgerRows(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  from: Date,
  to: Date,
  now: Date,
  windowConfig?: DoseWindowConfig,
): DoseHistoryRow[] {
  const medication: BandMinterMedication = {
    id: "compliance-tally",
    startsOn: ctx.startsOn,
    endsOn: ctx.endsOn,
    oneShot: ctx.oneShot,
    createdAt: ctx.createdAt,
  };
  const recurrenceCtx = toRecurrenceCtx(ctx, "compliance-tally");
  const canonicalSchedules = schedules.map((s, i) => {
    const canonical = toCanonicalSchedule(s, `compliance-tally-${i}`);
    // A legacy daily schedule carries only `windowStart` (no `timesOfDay`,
    // no rrule, no rolling, no `daysOfWeek`). The engine's `expandLegacy`
    // reads that as "every day at windowStart", but the band minter's
    // cadence-detection gate needs an explicit time signal — surface
    // `windowStart` as the single time-of-day so the daily band is minted.
    if (
      canonical.timesOfDay.length === 0 &&
      canonical.rrule === null &&
      canonical.rollingIntervalDays === null &&
      canonical.scheduleType !== "PRN" &&
      !ctx.oneShot
    ) {
      return { ...canonical, timesOfDay: [canonical.windowStart] };
    }
    return canonical;
  });
  // Rolling cadences anchor their retrospective grid AT each logged intake;
  // the bands need every non-skipped take in (or before) the window. Reuse
  // the same instant-extraction the legacy rolling path uses so the
  // numerator and denominator are built from one expansion.
  const intakeInstants = intakeInstantsAtOrBefore(
    events.map((e) => ({ takenAt: e.takenAt, skipped: e.skipped })),
    to,
  );

  // v1.16.3 — era-aware mint: archived eras band with THEIR schedules.
  const groups = buildBandsForSchedulesWithEras({
    medication,
    schedules: canonicalSchedules,
    revisions: ctx.scheduleRevisions ?? [],
    ctx: recurrenceCtx,
    userTz: ctx.timeZone,
    range: { from, to },
    now,
    windowConfig,
    intakeInstants,
  });

  // The ledger reads `scheduledFor` + `takenAt` + skip/auto-miss flags. The
  // bands already partition the slot space, so the union of every
  // non-PRN schedule's bands is fed to ONE reconstruction — `reconstruct
  // DoseHistory` claims each slot by at most one intake, so pooling the
  // (already correctly-minted) bands is safe. PRN groups (no expected
  // slots) contribute no bands; their intakes surface as ad-hoc and are
  // excluded from the denominator, exactly as the literature requires.
  const bands: SlotBand[] = [];
  for (const g of groups) {
    if (g.hasExpectedSlots) bands.push(...g.bands);
  }

  const intakes: HistoryIntake[] = events
    .filter((e) => e.scheduledFor >= from && e.scheduledFor <= to)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
      // v1.15.20 — a pinned take binds by anchor and tallies as taken-late
      // (slot served, no on-time gain) instead of ad_hoc + missed.
      pinned: e.attributionSource === "USER_PIN",
    }));

  // Slots before the medication's creation count only when a recorded dose
  // claims them, so a caller's window reaching past the creation never
  // mints phantom misses (#1028).
  const rows = reconstructDoseHistory(bands, intakes, now, ctx.createdAt);

  // v1.25 H-MED1 — drop expected dose slots whose anchor falls inside a
  // pause interval. While a medication is paused no dose is expected, so a
  // slot minted across the paused window must never count as "missed" (the
  // denominator-inflating status). Only `slot` rows are dropped, and only
  // those whose status feeds the tally (taken / missed) — skip / ad-hoc /
  // upcoming rows are already excluded from the denominator, so dropping
  // them here would be a redundant double-exclusion. An open era
  // (`resumedAt === null`) runs to `now`.
  const pauseEras = ctx.pauseEras;
  if (pauseEras && pauseEras.length > 0) {
    const isInPause = (at: Date): boolean => {
      const t = at.getTime();
      for (const era of pauseEras) {
        const start = era.pausedAt.getTime();
        const end = (era.resumedAt ?? now).getTime();
        if (t >= start && t < end) return true;
      }
      return false;
    };
    return rows.filter((row) => {
      if (row.kind !== "slot") return true;
      if (
        row.status !== "taken_on_time" &&
        row.status !== "taken_late" &&
        row.status !== "missed"
      ) {
        return true;
      }
      return !isInPause(row.at);
    });
  }

  return rows;
}

/**
 * Tally pre-built ledger rows into the {@link LedgerComplianceTally}
 * counters. When `window` is supplied only rows whose instant (`row.at`)
 * falls inside `[window.from, window.to]` (inclusive) are counted — that is
 * how a sub-window tally is carved out of a wider single-pass ledger. The
 * window-less call tallies every row, byte-identical to the historical
 * {@link tallyComplianceFromLedger} behaviour.
 */
export function tallyLedgerRows(
  rows: DoseHistoryRow[],
  window?: { from: Date; to: Date },
): LedgerComplianceTally {
  let takenOnTime = 0;
  let takenLate = 0;
  let missed = 0;
  let skipped = 0;
  let adHoc = 0;
  for (const row of rows) {
    if (window) {
      const t = row.at.getTime();
      if (t < window.from.getTime() || t > window.to.getTime()) continue;
    }
    switch (row.status) {
      case "taken_on_time":
        takenOnTime++;
        break;
      case "taken_late":
        takenLate++;
        break;
      case "missed":
        missed++;
        break;
      case "skipped":
        skipped++;
        break;
      case "ad_hoc":
        adHoc++;
        break;
      // `upcoming` slots are future / still-takeable → excluded from every
      // counter so a partial head-of-window day never pollutes the rate.
    }
  }

  const taken = takenOnTime + takenLate;
  const denominator = taken + missed;
  const rate =
    denominator > 0
      ? Math.min(100, Math.round((taken / denominator) * 100))
      : 100;

  return {
    taken,
    takenOnTime,
    takenLate,
    missed,
    skipped,
    adHoc,
    denominator,
    rate,
  };
}

/**
 * Widest trailing window the single-pass compliance ledger has to cover:
 * the top rung of {@link COMPLIANCE_WINDOW_LADDER} (365 days). Every
 * sub-window the per-medication compliance endpoint serves (7 / 30 /
 * cadence-scaled display rows / 90-day heatmap) is a suffix of it.
 */
export const COMPLIANCE_LEDGER_WINDOW_DAYS = 365;

/**
 * One day of the cadence-aware compliance series: the day's compliance %
 * over the doses the schedule actually expected that day, plus the raw
 * taken / missed counts behind it.
 */
export interface DailyComplianceRate {
  /** The day's anchor instant (the first expected slot of the day). */
  date: Date;
  /** round(100 · taken / (taken + missed)), capped at 100. */
  rate: number;
  /** Doses taken (on-time + late) on the day. */
  taken: number;
  /** Expected doses never acted on past their miss cutoff, on the day. */
  missed: number;
}

/**
 * v1.18.0 — collapse unified dose-history ledger rows into a cadence-aware
 * per-day compliance series.
 *
 * Only days the schedule's cadence actually expected a dose produce a point:
 * the series is grouped over the ledger's scheduled `slot` rows, so an
 * off-cadence weekday (a weekly Monday-only med on a Tuesday) or an off-week
 * (the off-week of a bi-weekly schedule) emits no point at all and therefore
 * can never be read as a 0% "miss". Each day's rate uses the SAME
 * taken / (taken + missed) tally — and the SAME on-time-plus-late numerator,
 * skip / ad-hoc / upcoming exclusions — that {@link tallyLedgerRows} applies
 * to `compliance7` / `compliance30`, so the per-day series and the window
 * rates are computed from one ledger and cannot contradict each other.
 *
 * `ad_hoc` rows (off-schedule top-ups, no defensible slot) and `upcoming`
 * rows (the window hasn't opened) are dropped before grouping, exactly as the
 * window tally excludes them. A day whose only ledger rows are skips yields no
 * point (zero denominator) rather than a misleading 0%.
 *
 * Days are bucketed in the USER's timezone (`tz`). Passing the caller's real
 * zone keeps an evening dose on the local day it was actually due: a fixed
 * Berlin key filed a `20:00 America/Los_Angeles` dose (04:00 UTC next day)
 * into the following Berlin day, splitting one local day's two doses across
 * two buckets and skewing every per-day rate for non-Berlin users.
 */
export function dailyComplianceRatesFromLedger(
  ledgerRows: DoseHistoryRow[],
  tz: string,
): DailyComplianceRate[] {
  const byDay = new Map<
    string,
    { taken: number; missed: number; date: Date }
  >();

  for (const row of ledgerRows) {
    // Only scheduled slots have a defensible denominator; ad-hoc top-ups are
    // excluded from the rate exactly as `tallyLedgerRows` excludes them.
    if (row.kind !== "slot") continue;
    const isTaken =
      row.status === "taken_on_time" || row.status === "taken_late";
    const isMissed = row.status === "missed";
    // `skipped` (deliberate) and `upcoming` (window not open) advance neither
    // counter — they never enter the day's denominator.
    if (!isTaken && !isMissed) continue;

    const dayKey = userDayKey(row.at, tz);
    const bucket = byDay.get(dayKey) ?? { taken: 0, missed: 0, date: row.at };
    if (isTaken) bucket.taken += 1;
    else bucket.missed += 1;
    // Keep the earliest slot instant of the day as the point's anchor.
    if (row.at.getTime() < bucket.date.getTime()) bucket.date = row.at;
    byDay.set(dayKey, bucket);
  }

  return Array.from(byDay.values())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((day) => {
      const denom = day.taken + day.missed;
      return {
        date: day.date,
        rate:
          denom > 0
            ? Math.min(100, Math.round((day.taken / denom) * 100))
            : 100,
        taken: day.taken,
        missed: day.missed,
      };
    });
}
