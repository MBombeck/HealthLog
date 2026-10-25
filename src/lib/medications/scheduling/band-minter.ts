/**
 * v1.15.18 — shared cadence-aware band minter.
 *
 * THE keystone of the traceable dose-history model. It builds the correct
 * `SlotBand[]` for EVERY medication cadence so the three downstream surfaces
 * — the read-model (`reconstructDoseHistory`), the compliance %, and the
 * write/edit attribution — all consume ONE source of slot windows and can
 * never contradict each other (the v1.15.18 audit's CRITICAL-2 finding).
 *
 * Per the audit, each cadence needs its own band shape:
 *
 *   1. daily / multi-time      — `occurrencesBetween` slots; minute-scale
 *                                on-time (±60min default) + a daily late tail.
 *   2. fixed weekdays / N-weeks — derive the family from the REALISED
 *                                inter-slot gap, NOT `doseCadenceFamily`'s
 *                                field-shape heuristic (which mislabels legacy
 *                                `daysOfWeek` meds as daily); day-scale on-time
 *                                (±1 day) + a 4-day late tail.
 *   3. rolling (GLP-1)          — bands from `expandRollingRetrospective`,
 *                                anchored AT each logged intake (NOT the
 *                                forward-only `occurrencesBetween`, which would
 *                                make every past shot read ad-hoc). Day-scale.
 *   4. cyclic                   — `occurrencesBetween` already drops off-week
 *                                slots; mint bands only for the survivors.
 *   5. one-shot                 — a single WIDE whole-day on-time band; never
 *                                auto-flips to missed.
 *   6. PRN / empty / bad rrule  — `[]` (the caller renders intakes as plain
 *                                entries) + `hasExpectedSlots: false`.
 *   7. DST for day-scale bands  — ±N-day bounds minted via `localHmAsUtc` on
 *                                calendar days, never `±N·DAY_MS`.
 *   8. multi-schedule on one med — bands built PER SCHEDULE so a weekly tail is
 *                                never clipped by a daily oral's anchor.
 *
 * Pure / synchronous: no DB access. The DB-reading parts (the rolling
 * `intakeInstants`, `lastIntakeAt`) are pre-fetched and threaded in, like
 * `resolve-slot-instant.ts`.
 */
import { RRule } from "rrule";

import { DOSE_WINDOW_DEFAULTS } from "@/lib/medications/scheduling/dose-window-defaults";
import {
  buildSlotBands,
  type SlotBand,
  type SlotWindowInput,
} from "@/lib/medications/scheduling/attribution";
import {
  expandRollingRetrospective,
  occurrencesBetween,
  type CanonicalSchedule,
  type DoseWindowEntry,
  type Occurrence,
  type RecurrenceContext,
} from "@/lib/medications/scheduling/recurrence";
import { localHmAsUtc } from "@/lib/tz/local-day";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Realised-gap threshold separating the day-scale (weekly) family from the
 * minute-scale (daily) family. A cadence whose closest two slots sit at least
 * 36h apart is treated as day-scale: that catches every-other-day, weekly,
 * bi-weekly and monthly cadences while keeping daily (24h) and intraday
 * multi-dose schedules on the minute scale. Derived from the REALISED gap, not
 * `doseCadenceFamily`'s field-shape heuristic (audit MEDIUM-6).
 */
const DAY_SCALE_GAP_THRESHOLD_MS = 36 * HOUR_MS;

/** Which band shape the minter chose for a schedule. */
export type BandFamily = "daily" | "weekly" | "one_shot" | "none";

/** The medication projection the minter reads (pre-fetched, no DB access). */
export interface BandMinterMedication {
  id: string;
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
}

/**
 * Per-dose window override. When absent the minter derives the on-time width +
 * late tail from `DOSE_WINDOW_DEFAULTS` keyed on the realised family. A caller
 * can widen the on-time band per the maintainer's configurable-window lever.
 */
export interface DoseWindowConfig {
  /** Daily on-time half-width around the slot instant (minutes). */
  dailyOnTimeMinutes?: number;
  /** Daily late tail past the on-time window (minutes). */
  dailyOverdueMinutes?: number;
  /** Weekly / rolling on-time half-width around the slot day (days). */
  weeklyOnTimeDays?: number;
  /** Weekly / rolling late tail past the on-time day (days). */
  weeklyOverdueDays?: number;
}

export interface BuildBandsInput {
  medication: BandMinterMedication;
  schedule: CanonicalSchedule;
  ctx: RecurrenceContext;
  userTz: string;
  /** The [from, to] window to mint expected slots over (inclusive). */
  range: { from: Date; to: Date };
  /** Wall-clock reference, threaded to the rolling retrospective expansion. */
  now: Date;
  /** Per-dose window override; defaults to `DOSE_WINDOW_DEFAULTS`. */
  windowConfig?: DoseWindowConfig;
  /**
   * Non-skipped intake instants for THIS medication. Required for a rolling
   * cadence (the retrospective grid anchors AT each intake); ignored by every
   * other cadence. Pre-fetched by the caller — the minter has no DB access.
   */
  intakeInstants?: Date[];
  /**
   * Include the single canonical unresolved rolling occurrence even before
   * the compliance engine's half-cycle "genuinely missed" threshold.
   * Display-due/reminder attribution opt in; retrospective compliance keeps
   * its existing denominator semantics.
   */
  includeOpenRollingOccurrence?: boolean;
}

export interface BandMinterResult {
  bands: SlotBand[];
  /** False for PRN / empty / malformed schedules (no slot machinery). */
  hasExpectedSlots: boolean;
  /** The band shape chosen — surfaced for diagnostics + the UI label. */
  family: BandFamily;
}

/** One schedule's band group, for a multi-schedule medication. */
export interface ScheduleBandGroup extends BandMinterResult {
  scheduleId: string;
}

/**
 * Build the `SlotBand[]` for one schedule of one medication over `range`.
 *
 * The single per-schedule entry point. A multi-schedule medication routes
 * each schedule through here independently (see `buildBandsForSchedules`) so a
 * sparse cadence's late tail is never clipped by a denser sibling's anchor.
 */
export function buildBandsForMedication(
  input: BuildBandsInput,
): BandMinterResult {
  const { medication, schedule, ctx, userTz, range, now } = input;

  // PRN / empty / malformed → no slot machinery. The caller renders the
  // intakes as plain entries. `occurrencesBetween` already returns [] for PRN;
  // we also short-circuit a schedule that describes no cadence at all (no
  // rrule, no rolling, no legacy weekday/time, not one-shot) so a malformed or
  // empty schedule never silently mints a stray daily band.
  if (
    schedule.scheduleType === "PRN" ||
    !describesACadence(schedule, medication)
  ) {
    return { bands: [], hasExpectedSlots: false, family: "none" };
  }

  // One-shot — a single WIDE whole-day on-time band that never auto-misses.
  if (medication.oneShot) {
    const bands = buildOneShotBands(schedule, ctx, userTz, range);
    // A one-shot whose anchor lies outside the window mints no band here, but
    // it IS a scheduled dose — keep `hasExpectedSlots` true.
    return { bands, hasExpectedSlots: true, family: "one_shot" };
  }

  // Rolling (GLP-1) — retrospective bands anchored AT each logged intake.
  if (schedule.rollingIntervalDays !== null) {
    const retrospective = expandRollingRetrospective(
      schedule,
      ctx,
      range.from,
      range.to,
      input.intakeInstants ?? [],
      now,
    );
    const open = input.includeOpenRollingOccurrence
      ? occurrencesBetween(schedule, range.from, range.to, ctx)
      : [];
    const occ = [...retrospective];
    for (const candidate of open) {
      if (
        !occ.some(
          (existing) => existing.at.getTime() === candidate.at.getTime(),
        )
      ) {
        occ.push(candidate);
      }
    }
    occ.sort((a, b) => a.at.getTime() - b.at.getTime());
    // The canonical rolling case is a once-weekly+ injection (day-scale). A
    // degenerate ≤1-day rolling interval is effectively daily, so a ±1-day
    // on-time window would over-widen and let one take claim adjacent slots —
    // keep it minute-scale. The realised every-N-days cadence is the field
    // here (intakes drive the anchors), so the interval is the right signal.
    const family: "daily" | "weekly" =
      schedule.rollingIntervalDays >= 2 ? "weekly" : "daily";
    const bands = mintBands(occ, family, input.windowConfig, userTz, schedule);
    return { bands, hasExpectedSlots: true, family };
  }

  // Daily / weekly / cyclic / rrule — `occurrencesBetween` already filters
  // cyclic off-week slots. Classify the family by the REALISED inter-slot gap
  // probed over a padded window (so a sparse cadence yields ≥2 slots), NOT the
  // field-shape `doseCadenceFamily` heuristic.
  const occurrences = occurrencesBetween(schedule, range.from, range.to, ctx);
  const family = realisedFamily(schedule, ctx, range);
  const bands = mintBands(
    occurrences,
    family,
    input.windowConfig,
    userTz,
    schedule,
  );
  return { bands, hasExpectedSlots: true, family };
}

/**
 * Build per-schedule band groups for a multi-schedule medication. Each
 * schedule is banded independently — the keystone invariant that keeps a
 * weekly injection's 4-day tail from being clipped by a daily oral's anchor.
 */
export function buildBandsForSchedules(input: {
  medication: BandMinterMedication;
  schedules: CanonicalSchedule[];
  ctx: RecurrenceContext;
  userTz: string;
  range: { from: Date; to: Date };
  now: Date;
  windowConfig?: DoseWindowConfig;
  /** Per-medication intake instants (the rolling anchors). */
  intakeInstants?: Date[];
  includeOpenRollingOccurrence?: boolean;
}): ScheduleBandGroup[] {
  return input.schedules.map((schedule) => {
    const result = buildBandsForMedication({
      medication: input.medication,
      schedule,
      ctx: input.ctx,
      userTz: input.userTz,
      range: input.range,
      now: input.now,
      windowConfig: input.windowConfig,
      intakeInstants: input.intakeInstants,
      includeOpenRollingOccurrence: input.includeOpenRollingOccurrence,
    });
    return { scheduleId: schedule.id, ...result };
  });
}

// ────────────────────────────────────────────────────────────────────
// Band construction
// ────────────────────────────────────────────────────────────────────

/**
 * Turn engine occurrences into `SlotWindowInput`s of the given family and run
 * them through `buildSlotBands` (which resolves + caps the late tails so
 * adjacent slots never both claim one intake).
 */
function mintBands(
  occurrences: Occurrence[],
  family: "daily" | "weekly",
  windowConfig: DoseWindowConfig | undefined,
  userTz: string,
  schedule: CanonicalSchedule,
): SlotBand[] {
  const w = resolveWindows(windowConfig);
  // The persisted per-dose windows (the maintainer's "07:00–09:00" lever). When a slot's
  // `timeOfDay` matches an entry, the on-time band is the explicit `[start,
  // end]` range; otherwise the default symmetric ±width applies. The late tail
  // stays cadence-derived for every slot.
  const explicit = indexDoseWindows(schedule.doseWindows ?? null);
  const inputs: SlotWindowInput[] = occurrences.map((occ) =>
    family === "weekly"
      ? weeklyWindow(occ, w, userTz, explicit.get(occ.timeOfDay) ?? null)
      : dailyWindow(occ, w, userTz, explicit.get(occ.timeOfDay) ?? null),
  );
  return buildSlotBands(inputs);
}

/**
 * Index the schedule's `doseWindows` by `timeOfDay` for O(1) per-slot lookup.
 * A duplicate `timeOfDay` keeps the first entry (the write path Zod-validates
 * uniqueness, so this is purely defensive).
 */
function indexDoseWindows(
  windows: DoseWindowEntry[] | null,
): Map<string, DoseWindowEntry> {
  const map = new Map<string, DoseWindowEntry>();
  if (!windows) return map;
  for (const w of windows) {
    // Defence-in-depth: only index well-formed `start <= end` HH:mm entries.
    // `buildCanonicalSchedule` already normalises the persisted JSON, but a
    // directly-constructed `CanonicalSchedule` (tests, compliance helpers)
    // must never widen a band from a malformed range.
    if (!isUsableDoseWindow(w)) continue;
    if (!map.has(w.timeOfDay)) map.set(w.timeOfDay, w);
  }
  return map;
}

/** True when a dose window is well-formed HH:mm with `start <= end`. */
function isUsableDoseWindow(w: DoseWindowEntry): boolean {
  const start = localHourMinute(w.start);
  const end = localHourMinute(w.end);
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  return (
    HHMM_BAND_RE.test(w.timeOfDay) &&
    HHMM_BAND_RE.test(w.start) &&
    HHMM_BAND_RE.test(w.end) &&
    startMin <= endMin
  );
}

const HHMM_BAND_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Minute-scale band around a slot instant (daily / intraday cadences). When an
 * explicit per-dose window is configured for this `timeOfDay`, the on-time band
 * is the literal `[start, end]` range minted on the slot's local day (DST-correct
 * via `localHmAsUtc`); otherwise the symmetric ±`dailyOnTimeMinutes` default.
 */
function dailyWindow(
  occ: Occurrence,
  w: ResolvedWindows,
  userTz: string,
  explicit: DoseWindowEntry | null,
): SlotWindowInput {
  const onTime = explicit
    ? explicitOnTimeBounds(occ.at, explicit, userTz)
    : {
        onTimeStart: new Date(
          occ.at.getTime() - w.dailyOnTimeMinutes * MINUTE_MS,
        ),
        onTimeEnd: new Date(
          occ.at.getTime() + w.dailyOnTimeMinutes * MINUTE_MS,
        ),
      };
  return {
    at: occ.at,
    timeOfDay: occ.timeOfDay,
    onTimeStart: onTime.onTimeStart,
    onTimeEnd: onTime.onTimeEnd,
    lateGraceMs: w.dailyOverdueMinutes * MINUTE_MS,
  };
}

/**
 * Mint an explicit `[start, end]` on-time range on the slot's local calendar
 * day. `localHmAsUtc` keys off the local day of its first argument (`occ.at`),
 * so the bounds land on the same day as the slot, DST-correct.
 */
function explicitOnTimeBounds(
  occAt: Date,
  window: DoseWindowEntry,
  userTz: string,
): { onTimeStart: Date; onTimeEnd: Date } {
  const start = localHourMinute(window.start);
  const end = localHourMinute(window.end);
  return {
    onTimeStart: localHmAsUtc(occAt, userTz, start.hour, start.minute),
    onTimeEnd: localHmAsUtc(occAt, userTz, end.hour, end.minute),
  };
}

/**
 * Day-scale band around a slot instant (weekly / rolling / sparse cadences).
 * The ±N-day bounds are minted via `localHmAsUtc` on the calendar days N days
 * before / after the slot's local day — DST-correct, unlike `±N·DAY_MS`, which
 * drifts an hour across a transition (audit MEDIUM-8).
 */
function weeklyWindow(
  occ: Occurrence,
  w: ResolvedWindows,
  userTz: string,
  explicit: DoseWindowEntry | null,
): SlotWindowInput {
  const { hour, minute } = localHourMinute(occ.timeOfDay);
  // An explicit per-dose window pins the on-time band to the literal `[start,
  // end]` range on the slot's own local day (a within-day window the user set);
  // otherwise the default day-scale ±`weeklyOnTimeDays` envelope. Either way the
  // late tail below stays day-scale + DST-correct.
  const onTimeStart = explicit
    ? localHmAsUtc(
        occ.at,
        userTz,
        localHourMinute(explicit.start).hour,
        localHourMinute(explicit.start).minute,
      )
    : localHmAsUtc(
        new Date(occ.at.getTime() - w.weeklyOnTimeDays * DAY_MS),
        userTz,
        hour,
        minute,
      );
  const onTimeEnd = explicit
    ? localHmAsUtc(
        occ.at,
        userTz,
        localHourMinute(explicit.end).hour,
        localHourMinute(explicit.end).minute,
      )
    : localHmAsUtc(
        new Date(occ.at.getTime() + w.weeklyOnTimeDays * DAY_MS),
        userTz,
        hour,
        minute,
      );
  // The late tail is also day-scale: the instant N overdue-days past the
  // on-time end, minted on the calendar day for DST-correctness, then expressed
  // as a millisecond grace `buildSlotBands` consumes.
  const overdueAnchor = localHmAsUtc(
    new Date(onTimeEnd.getTime() + w.weeklyOverdueDays * DAY_MS),
    userTz,
    hour,
    minute,
  );
  const lateGraceMs = Math.max(
    0,
    overdueAnchor.getTime() - onTimeEnd.getTime(),
  );
  return {
    at: occ.at,
    timeOfDay: occ.timeOfDay,
    onTimeStart,
    onTimeEnd,
    lateGraceMs,
  };
}

/**
 * One-shot — a single whole-day on-time band per `timesOfDay` anchor. The
 * band spans the local day start..end so a take any time that day is on-time,
 * and the late tail is zero (a one-shot never auto-misses; an unfilled slot
 * simply reads `upcoming` until the day closes and then stays a never-acted
 * slot rather than a hard miss).
 */
function buildOneShotBands(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  userTz: string,
  range: { from: Date; to: Date },
): SlotBand[] {
  const occurrences = occurrencesBetween(schedule, range.from, range.to, ctx);
  const inputs: SlotWindowInput[] = occurrences.map((occ) => {
    const dayStart = localHmAsUtc(occ.at, userTz, 0, 0);
    // End at the next local midnight (start of the following day) so a 23:59
    // take is still inside the band.
    const nextDayStart = localHmAsUtc(
      new Date(dayStart.getTime() + 25 * HOUR_MS),
      userTz,
      0,
      0,
    );
    return {
      at: occ.at,
      timeOfDay: occ.timeOfDay,
      onTimeStart: dayStart,
      onTimeEnd: nextDayStart,
      lateGraceMs: 0,
    };
  });
  return buildSlotBands(inputs);
}

// ────────────────────────────────────────────────────────────────────
// Family classification (realised inter-slot gap)
// ────────────────────────────────────────────────────────────────────

/**
 * Classify the schedule's family from the REALISED inter-slot gap rather than
 * the field-shape `doseCadenceFamily` heuristic (which mislabels a legacy
 * Mon/Thu `daysOfWeek` med as daily ±60min). Probe a window padded to ≥16
 * weeks so a sparse cadence yields ≥2 slots and a real gap is observable; the
 * minimum consecutive gap decides the scale.
 *
 * The probe reaches the same distance on both sides of the range's middle.
 * It used to end at `range.to`, so the answer depended on where the range
 * stopped: a Saturday + Sunday plan starting the weekend before the autumn
 * DST change, read around its second Saturday dose, has its Sunday slot at
 * 07:00 UTC while the ±24 h range ends at 06:00. With that slot cut off the
 * closest two slots were six days apart (weekly); the wider re-mint saw the
 * 25 h Saturday-to-Sunday gap (daily), the two passes disagreed, and the dose
 * was filed as unscheduled. A cadence's family is a property of the plan, not
 * of the window it is read through.
 */
function realisedFamily(
  schedule: CanonicalSchedule,
  ctx: RecurrenceContext,
  range: { from: Date; to: Date },
): "daily" | "weekly" {
  const reach =
    Math.max(
      Math.ceil((range.to.getTime() - range.from.getTime()) / DAY_MS),
      16 * 7,
    ) * DAY_MS;
  const middle = (range.from.getTime() + range.to.getTime()) / 2;
  const slots = occurrencesBetween(
    schedule,
    new Date(middle - reach),
    new Date(middle + reach),
    ctx,
  );
  if (slots.length < 2) {
    // Too few slots to measure a gap. Fall back to the field-shape signal:
    // an explicit rolling/weekly/monthly shape is day-scale, else daily.
    return fieldShapeFamily(schedule);
  }
  const times = slots.map((s) => s.at.getTime()).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) return fieldShapeFamily(schedule);
  return minGap >= DAY_SCALE_GAP_THRESHOLD_MS ? "weekly" : "daily";
}

/** Field-shape fallback when too few slots exist to measure a realised gap. */
function fieldShapeFamily(schedule: CanonicalSchedule): "daily" | "weekly" {
  if (
    schedule.rollingIntervalDays !== null &&
    schedule.rollingIntervalDays >= 2
  ) {
    return "weekly";
  }
  if (/FREQ=(WEEKLY|MONTHLY|YEARLY)/i.test(schedule.rrule ?? "")) {
    return "weekly";
  }
  return "daily";
}

// ────────────────────────────────────────────────────────────────────
// Cadence detection + small helpers
// ────────────────────────────────────────────────────────────────────

/**
 * True when the schedule describes ANY cadence the engine can expand — a
 * one-shot, a rolling interval, an rrule, or a legacy `daysOfWeek`/`timesOfDay`
 * shape. A schedule with none of these (a stray/empty row) is treated like PRN:
 * no expected slots. Keeps a malformed row from minting a phantom daily band.
 */
function describesACadence(
  schedule: CanonicalSchedule,
  medication: BandMinterMedication,
): boolean {
  if (medication.oneShot) return true;
  if (schedule.rollingIntervalDays !== null) return true;
  if (schedule.rrule !== null && schedule.rrule.trim() !== "") {
    // A malformed rrule describes no usable cadence — `expandRrule` swallows
    // the parse error and returns no slots, so without this gate the schedule
    // would read `hasExpectedSlots: true` with an empty band list (audit
    // CRITICAL-3: a bad rrule must fall to the no-slot-machinery path).
    return isParseableRrule(schedule.rrule);
  }
  if (schedule.daysOfWeek !== null && schedule.daysOfWeek.trim() !== "") {
    return true;
  }
  if (schedule.timesOfDay.length > 0) return true;
  return false;
}

/** True when the bare RRULE body parses (mirrors `expandRrule`'s try/catch). */
function isParseableRrule(rrule: string): boolean {
  try {
    RRule.fromString(`RRULE:${rrule}`);
    return true;
  } catch {
    return false;
  }
}

interface ResolvedWindows {
  dailyOnTimeMinutes: number;
  dailyOverdueMinutes: number;
  weeklyOnTimeDays: number;
  weeklyOverdueDays: number;
}

/** Merge the caller's per-dose overrides over `DOSE_WINDOW_DEFAULTS`. */
function resolveWindows(config: DoseWindowConfig | undefined): ResolvedWindows {
  return {
    dailyOnTimeMinutes:
      config?.dailyOnTimeMinutes ?? DOSE_WINDOW_DEFAULTS.dailyOnTimeMinutes,
    dailyOverdueMinutes:
      config?.dailyOverdueMinutes ?? DOSE_WINDOW_DEFAULTS.dailyOverdueMinutes,
    weeklyOnTimeDays:
      config?.weeklyOnTimeDays ?? DOSE_WINDOW_DEFAULTS.weeklyOnTimeDays,
    weeklyOverdueDays:
      config?.weeklyOverdueDays ?? DOSE_WINDOW_DEFAULTS.weeklyOverdueDays,
  };
}

/**
 * Parse an "HH:mm" slot label into hour/minute, defaulting to the slot's own
 * local time when the label is malformed. The engine always sets a parseable
 * `timeOfDay`, but the day-scale bound minting must never crash the read path.
 */
function localHourMinute(timeOfDay: string): { hour: number; minute: number } {
  const [hStr, mStr] = timeOfDay.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return { hour: 0, minute: 0 };
  return { hour: h, minute: m };
}
