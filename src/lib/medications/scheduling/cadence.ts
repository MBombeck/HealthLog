/**
 * v1.4.25 W19e — pure cadence helpers for the medication detail page.
 *
 * Reads existing `MedicationSchedule` rows (`windowStart`, `windowEnd`,
 * `daysOfWeek` encoded via `serializeScheduleRecurrence`) plus the
 * recorded `MedicationIntakeEvent` stream, projects an expected-dose
 * timeline over a configurable window, and pairs each expected dose
 * with the closest actual intake (if any).
 *
 * No DB access here — every function takes pre-fetched rows. The API
 * route owns the prisma queries; this module owns the math. Same
 * shape as the W19d side-effects pure helpers.
 *
 * Why we do this client-side / server-side both: the section card on
 * the detail page renders a 30-day mini-chart; the same math feeds
 * the API JSON that drives the Compliance chips. Sharing one pure
 * module keeps the two surfaces from drifting.
 *
 * v1.4.25 W21 Fix-O — the local-day boundary helpers accept an
 * optional IANA `timeZone` argument (`Europe/Berlin`, `Asia/Tokyo`,
 * …). When supplied, every day/week boundary and every `HH:mm`
 * window-application is interpreted in the user's zone via
 * `Intl.DateTimeFormat` rather than the host's system time. The
 * cadence route resolves the zone through `resolveUserTimezone()`
 * and threads it through every helper. Omitting the argument falls
 * back to system-local — the legacy single-tz behaviour the v1.4.25
 * W19e tests pin.
 */

import { parseScheduleRecurrence } from "@/lib/medication-schedule";
import type { SlotBand } from "@/lib/medications/scheduling/attribution";
import { type BandMinterMedication } from "@/lib/medications/scheduling/band-minter";
import {
  buildBandsForSchedulesWithEras,
  type ScheduleRevisionLike,
} from "@/lib/medications/scheduling/schedule-eras";
import {
  reconstructDoseHistory,
  type HistoryIntake,
} from "@/lib/medications/scheduling/dose-history";
import {
  type CanonicalSchedule,
  type RecurrenceContext,
  type ScheduleType,
  expandRollingRetrospective,
  occurrencesBetween,
} from "@/lib/medications/scheduling/recurrence";
import { normaliseDoseWindows } from "@/lib/medications/scheduling/worker-helpers";
import { hhmmToMinutesOrNull } from "@/lib/medications/scheduling/hhmm";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { startOfLocalDayInTz } from "@/lib/tz/local-day";

/**
 * v1.13.x compliance — opt-in retrospective-rolling expansion.
 *
 * The canonical engine's `expandRolling` is forward-only (correct for the
 * projector / next-due surfaces). For the compliance + detail-page
 * timeline a ROLLING cadence must instead reconstruct its historical
 * expected-dose grid from the logged intakes. When a caller threads this
 * option, rolling schedules route through `expandRollingRetrospective`
 * (each logged intake is one satisfied slot, plus synthesized misses for
 * skipped whole cycles + a past-due forward slot). Every non-rolling
 * shape and every caller that omits the option keeps the forward-only
 * engine path byte-for-byte.
 */
export interface RetrospectiveRollingOptions {
  /** Non-skipped intake instants for the medication (the slot anchors). */
  intakeInstants: Date[];
  /** Wall-clock "now" — decides whether the forward next-due slot is past-due. */
  now: Date;
}

export interface ScheduleLike {
  /** "HH:mm" 24h, user-tz reference (per existing schema). */
  windowStart: string;
  /** "HH:mm" 24h. May wrap midnight (`windowEnd < windowStart`). */
  windowEnd: string;
  /** Encoded recurrence string per `serializeScheduleRecurrence`. */
  daysOfWeek: string | null;
  /**
   * v1.7.0 SB-SCHED-2 — canonical-engine fields. As of v1.7.3 (B15),
   * `expandScheduleSlots` delegates the expected-slot grid to the
   * canonical recurrence engine (`occurrencesBetween`) for EVERY schedule
   * shape whenever the caller supplies a `CadenceEngineContext` — these
   * fields carry the recurrence detail the engine reads (rrule / rolling
   * / cyclic), and a plain legacy `daysOfWeek` row routes through the
   * engine's `expandLegacy` branch all the same. This keeps compliance on
   * the same engine the projector + reminder worker use, fixing the bug
   * where an `rrule = "FREQ=WEEKLY;BYDAY=MO"` schedule expanded to
   * daily-every-day in compliance (because `daysOfWeek = null` reads as
   * "every day") AND the B15 bug where a multi-`timesOfDay` legacy row
   * collapsed to one slot/day in the numerator. Only callers that omit a
   * context fall to the legacy weekday walker (byte-stable for pure-math
   * / pre-v1.7 fixtures).
   */
  rrule?: string | null;
  rollingIntervalDays?: number | null;
  timesOfDay?: string[];
  reminderGraceMinutes?: number | null;
  scheduleType?: ScheduleType | null;
  cyclicOnWeeks?: number | null;
  cyclicOffWeeks?: number | null;
  /**
   * v1.15.18 — per-dose configurable on-time windows. Carried onto the
   * canonical schedule so the cadence-timeline bands (the card last/next dose)
   * honour the same explicit window the % and the history view use. Accepts the
   * raw persisted JSON (a full Prisma row's `Json?` column drops straight in);
   * `toCanonical` normalises it via `normaliseDoseWindows`.
   */
  doseWindows?: unknown;
  /** Stable id for the engine occurrence; defaults to a synthetic value. */
  id?: string;
}

/**
 * v1.7.0 SB-SCHED-2 — medication-level context the canonical engine
 * needs to expand a schedule's expected slots. Passed once per
 * medication into the cadence helpers; threaded down to
 * `expandScheduleSlots`. When omitted, every schedule falls back to the
 * legacy weekday walker (the byte-stable pre-v1.7 path).
 */
export interface CadenceEngineContext {
  startsOn: Date | null;
  endsOn: Date | null;
  oneShot: boolean;
  createdAt: Date;
  /** Latest non-skipped intake — only read by rolling cadences. */
  lastIntakeAt: Date | null;
  /** User IANA timezone. Required for the engine to apply HH:mm slots. */
  timeZone: string;
  /**
   * v1.16.3 — archived schedule eras (`validFrom` ascending). When present
   * the ledger-band consumers mint past days against the schedule that was
   * live THEN. Optional: callers without revisions keep live-only minting.
   */
  scheduleRevisions?: ScheduleRevisionLike[];
}

/** Build a `CanonicalSchedule` from a `ScheduleLike` + its index. */
function toCanonical(
  schedule: ScheduleLike,
  scheduleIndex: number,
): CanonicalSchedule {
  return {
    id: schedule.id ?? `cadence-${scheduleIndex}`,
    rrule: schedule.rrule ?? null,
    rollingIntervalDays: schedule.rollingIntervalDays ?? null,
    timesOfDay: schedule.timesOfDay ?? [],
    daysOfWeek: schedule.daysOfWeek ?? null,
    windowStart: schedule.windowStart,
    windowEnd: schedule.windowEnd,
    reminderGraceMinutes: schedule.reminderGraceMinutes ?? null,
    scheduleType: schedule.scheduleType ?? "SCHEDULED",
    cyclicOnWeeks: schedule.cyclicOnWeeks ?? null,
    cyclicOffWeeks: schedule.cyclicOffWeeks ?? null,
    doseWindows: normaliseDoseWindows(schedule.doseWindows),
  };
}

/** Build the engine's `RecurrenceContext` from the cadence context. */
function toRecurrenceContext(
  engineCtx: CadenceEngineContext,
): RecurrenceContext {
  return {
    medication: {
      id: "cadence-med",
      startsOn: engineCtx.startsOn,
      endsOn: engineCtx.endsOn,
      oneShot: engineCtx.oneShot,
      createdAt: engineCtx.createdAt,
    },
    timeZone: engineCtx.timeZone,
    lastIntakeAt: engineCtx.lastIntakeAt,
  };
}

export interface IntakeEventLike {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
  /**
   * v1.15.9 — true when the hourly auto-miss cron marked this never-acted
   * dose as a forgotten miss (NOT a deliberate user skip). The pairing pass
   * reads it so an auto-missed row counts as `missed` (against the rate)
   * rather than `skipped` (excluded). Optional so every legacy caller /
   * fixture that omits it keeps the user-skip-vs-taken-vs-missed contract.
   */
  autoMissed?: boolean;
  /**
   * v1.15.20 — slot-binding provenance (`USER_PIN` = deliberate user pin).
   * Read by the band-ledger chip tally so a pinned take binds by anchor;
   * optional so legacy callers default to AUTO.
   */
  attributionSource?: "AUTO" | "USER_PIN";
}

/** One slot the schedule expected the user to dose. */
interface ExpectedDose {
  /** Midnight of the local day this dose was expected. */
  day: Date;
  /** Start of the dose window for this day (Date with HH:mm applied). */
  windowStart: Date;
  /** End of the dose window for this day. */
  windowEnd: Date;
  /** Index into the parent schedules array (stable for chart layout). */
  scheduleIndex: number;
}

/** One slot paired with the closest matching intake event (if any). */
export interface PairedDose extends ExpectedDose {
  /** The matched intake event, or null if missed. */
  match: IntakeEventLike | null;
  /** Computed status. */
  status: "taken" | "skipped" | "missed" | "upcoming";
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/**
 * Base match radius for pairing an actual intake event to an expected
 * dose: +/- 12 hours around the slot's centre. This is the floor — a
 * daily (24h-gap) cadence matches inside +/- 12h, and a denser
 * multi-dose-per-day cadence keeps the same 12h floor so its
 * historically-pinned matching contract is byte-stable.
 *
 * Rationale: the existing classifyIntakeTiming uses a 3-hour grace
 * around the window + a configurable late tolerance after. For cadence
 * visualisation we want a wider matching radius so users who logged a
 * weekly shot a day late still see it paired with that week's slot
 * (and the slot reads `taken`, not `missed` followed by an "extra").
 */
const PAIR_RADIUS_MS = 12 * 60 * 60 * 1000;

/**
 * v1.12.0 — derive the per-slot match radius from the gap to its
 * neighbouring expected slots.
 *
 * The fixed +/-12h radius was correct only for a daily cadence (the
 * inter-slot gap is 24h, so a half-gap of 12h cleanly partitions the
 * timeline into one Voronoi cell per slot). For a SPARSE cadence — a
 * weekly injectable (Mounjaro / Ozempic), a bi-weekly or monthly dose —
 * the gap between expected slots is 7+ days, but a real intake is rarely
 * logged within 12h of the configured slot instant: the user takes the
 * shot on whichever day of the dosing week suits them, often at a
 * different time of day than the schedule's HH:mm. Those intakes then
 * fell OUTSIDE the 12h radius and every weekly slot read `missed` while
 * the matching intake was orphaned — the live "0% despite recorded
 * intakes" defect.
 *
 * The radius is half the distance to the nearer neighbour (so two
 * adjacent slots never both reach the same midpoint and double-claim),
 * floored at the 12h base so daily / multi-dose-daily cadences keep
 * their exact pre-fix behaviour. A weekly cadence (168h gap) widens to a
 * ~3.5-day radius, so an intake logged anywhere in the dosing week pairs
 * to that week's slot.
 */
function slotMatchRadius(
  centre: number,
  prevCentre: number | null,
  nextCentre: number | null,
): number {
  const halfToPrev = prevCentre === null ? Infinity : (centre - prevCentre) / 2;
  const halfToNext = nextCentre === null ? Infinity : (nextCentre - centre) / 2;
  const halfGap = Math.min(halfToPrev, halfToNext);
  if (!Number.isFinite(halfGap)) return PAIR_RADIUS_MS;
  return Math.max(PAIR_RADIUS_MS, halfGap);
}

// WallClockParts + wallClockInTz live in `@/lib/tz/wall-clock` as the
// canonical helper — see the file-level comment there for the v1.4.40
// consolidation rationale.

/**
 * Compute the UTC offset (in minutes) of `tz` at the given instant.
 * Positive east of UTC. Honours DST because Intl does.
 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = wallClockInTz(date, tz);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asIfUtc - date.getTime()) / 60000);
}

/**
 * Build a Date instant for `YYYY-MM-DD HH:mm:ss` interpreted in the
 * supplied timezone. Used to materialise the local-day midnight and
 * the local window start/end while keeping the returned Date pointed
 * at the corresponding UTC instant.
 */
function instantInTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string | undefined,
): Date {
  if (!tz) {
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    return d;
  }
  // First-pass guess: treat the wall clock as UTC, then correct by the
  // zone's offset at that approximate instant. Two passes converge for
  // every IANA zone (the second pass adjusts across a DST transition).
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  for (let i = 0; i < 2; i++) {
    const offsetMin = tzOffsetMinutes(guess, tz);
    guess = new Date(
      Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offsetMin * 60_000,
    );
  }
  return guess;
}

/** Build a Date for "HH:mm" applied to the user-local day boundary of `day`. */
function applyTime(day: Date, hhmm: string, tz: string | undefined): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const parts = wallClockInTz(day, tz);
  return instantInTz(parts.year, parts.month, parts.day, h, m, tz);
}

/** Parse "HH:mm" to minutes-since-midnight, or null when malformed. */

/** Snap a Date down to the user-local midnight. */
export function startOfLocalDay(d: Date, tz: string | undefined): Date {
  return startOfLocalDayInTz(d, tz);
}

/** Snap a Date down to the Sunday-rooted user-local week. */
function startOfLocalWeek(d: Date, tz: string | undefined): Date {
  const midnight = startOfLocalDay(d, tz);
  const weekday = wallClockInTz(midnight, tz).weekday;
  return new Date(midnight.getTime() - weekday * DAY_MS);
}

/**
 * Expand a single schedule into the list of dose slots it would have
 * generated between `from` (inclusive) and `to` (exclusive).
 *
 * Handles:
 *   - Daily cadence (no daysOfWeek restriction, intervalWeeks=1)
 *   - Weekly cadence (specific weekdays, intervalWeeks=1)
 *   - Bi-/tri-/quad-weekly cadence (intervalWeeks 2-4; phase is anchored
 *     to the week containing the medication's start, approximated here
 *     by the week containing `from` since the caller passes a stable
 *     anchor and we just need consistent every-Nth-week emission).
 *   - Overnight windows where `windowEnd < windowStart`.
 */
export function expandScheduleSlots(
  schedule: ScheduleLike,
  scheduleIndex: number,
  from: Date,
  to: Date,
  anchor: Date = from,
  timeZone?: string,
  engineCtx?: CadenceEngineContext,
  retro?: RetrospectiveRollingOptions,
): ExpectedDose[] {
  if (to <= from) return [];

  // v1.7.3 B15 — canonical-engine delegation. When the caller supplies a
  // medication context, expand the expected-slot grid through the
  // canonical engine for EVERY schedule shape (rrule / rolling / one-shot
  // / PRN / cyclic AND plain legacy `daysOfWeek`). The engine's
  // `expandLegacy` branch iterates `effectiveTimesOfDay` correctly, so a
  // single legacy row carrying multiple `timesOfDay` emits one slot per
  // time — matching exactly what `expectedSlotCountForDay` already counts.
  //
  // The earlier gate (`oneShot || usesCanonicalEngine`) diverged the
  // compliance numerator from the denominator: a 2×/day legacy schedule
  // (`daysOfWeek` set, two `timesOfDay`, no rrule) fell through to the
  // local legacy walker below, which only ever emits ONE slot/day from
  // `windowStart`, while `expectedSlotCountForDay` always ran the engine
  // and counted both slots → 1/2 = 50%. Routing both sides through the
  // single engine converges them for every schedule form.
  //
  // The local legacy walker below stays the path only when no context is
  // threaded (pure-math callers / pre-v1.7 fixtures) — byte-stable.
  if (engineCtx) {
    const canonical = toCanonical(schedule, scheduleIndex);
    const recurrenceCtx = toRecurrenceContext(engineCtx);
    // v1.7.0 code-correctness M5 — `occurrencesBetween` is inclusive of
    // both ends, but the legacy walker below is half-open `[from, to)`
    // (`if (wStart >= to) continue`). Subtract 1 ms from `to` so a dose
    // landing exactly at the window boundary isn't counted by the engine
    // path but dropped by the legacy path — the two branches stay
    // denominator-equivalent at the edge.
    const inclusiveTo = new Date(to.getTime() - 1);
    // v1.13.x — ROLLING + retrospective opt-in: reconstruct the historical
    // expected-dose grid from the logged intakes rather than the engine's
    // single forward slot. Only rolling schedules take this branch; every
    // other shape still routes through `occurrencesBetween`.
    const occurrences =
      retro && canonical.rollingIntervalDays !== null
        ? expandRollingRetrospective(
            canonical,
            recurrenceCtx,
            from,
            inclusiveTo,
            retro.intakeInstants,
            retro.now,
          )
        : occurrencesBetween(canonical, from, inclusiveTo, recurrenceCtx);
    return occurrences.map((occ) => ({
      day: startOfLocalDay(occ.at, timeZone),
      windowStart: occ.at,
      windowEnd: occ.graceUntil,
      scheduleIndex,
    }));
  }

  const recurrence = parseScheduleRecurrence(schedule.daysOfWeek);
  const slots: ExpectedDose[] = [];
  const anchorWeekStart = startOfLocalWeek(anchor, timeZone).getTime();

  const cursor = startOfLocalDay(from, timeZone);
  const end = startOfLocalDay(to, timeZone);
  // Iterate one extra day so an overnight window starting on `end - 1`
  // still emits — but the slot is only retained when `windowStart < to`.
  // Step by adding 25h then snapping back to local midnight so DST
  // spring-forward / fall-back days still advance by exactly one
  // calendar day.
  for (
    let day = cursor;
    day.getTime() <= end.getTime();
    day = startOfLocalDay(
      new Date(day.getTime() + 25 * 60 * 60 * 1000),
      timeZone,
    )
  ) {
    // Day-of-week constraint
    const dow = wallClockInTz(day, timeZone).weekday;
    if (
      recurrence.daysOfWeek.length > 0 &&
      !recurrence.daysOfWeek.includes(dow)
    ) {
      continue;
    }

    // Multi-week interval constraint
    if (recurrence.intervalWeeks > 1) {
      const thisWeekStart = startOfLocalWeek(day, timeZone).getTime();
      const weeksFromAnchor = Math.round(
        (thisWeekStart - anchorWeekStart) / WEEK_MS,
      );
      if (
        ((weeksFromAnchor % recurrence.intervalWeeks) +
          recurrence.intervalWeeks) %
          recurrence.intervalWeeks !==
        0
      ) {
        continue;
      }
    }

    // v1.7.3 B15 — defence-in-depth for the context-less legacy path. A
    // schedule carrying multiple `timesOfDay` must emit one slot per time
    // per qualifying day, mirroring the engine's `expandLegacy`. Pre-fix
    // this walker only ever emitted a single `windowStart..windowEnd`
    // window, so a 2×/day legacy row read as one slot/day here — the
    // numerator half of the B15 divergence. When `timesOfDay` is empty we
    // keep the historical single-window behaviour (byte-stable for every
    // pre-v1.7 fixture that relies on it).
    const times =
      schedule.timesOfDay && schedule.timesOfDay.length > 0
        ? schedule.timesOfDay
        : null;

    if (times === null) {
      const wStart = applyTime(day, schedule.windowStart, timeZone);
      let wEnd = applyTime(day, schedule.windowEnd, timeZone);
      // Overnight window: windowEnd <= windowStart means next day.
      if (wEnd <= wStart) {
        wEnd = new Date(wEnd.getTime() + DAY_MS);
      }

      if (wStart >= to) continue;
      if (wEnd <= from) continue;

      slots.push({
        day,
        windowStart: wStart,
        windowEnd: wEnd,
        scheduleIndex,
      });
      continue;
    }

    for (const time of times) {
      const wStart = applyTime(day, time, timeZone);
      // Each time-of-day slot spans the schedule's window length. Reuse
      // the windowStart..windowEnd span so the pairing radius and the
      // chart cell keep their existing shape; an overnight window pushes
      // the end to the next day.
      const startMin = hhmmToMinutesOrNull(schedule.windowStart);
      const endMin = hhmmToMinutesOrNull(schedule.windowEnd);
      let spanMs = DAY_MS;
      if (startMin !== null && endMin !== null) {
        let span = endMin - startMin;
        if (span <= 0) span += 24 * 60; // overnight window
        spanMs = span * 60_000;
      }
      const wEnd = new Date(wStart.getTime() + spanMs);

      if (wStart >= to) continue;
      if (wEnd <= from) continue;

      slots.push({
        day,
        windowStart: wStart,
        windowEnd: wEnd,
        scheduleIndex,
      });
    }
  }

  return slots;
}

/**
 * Pair each expected dose with its closest matching actual intake. An
 * intake "matches" a slot if its scheduledFor or takenAt lands within
 * `PAIR_RADIUS_MS` of the slot's window centre and no closer slot
 * claims it first.
 *
 * Determines status:
 *   - upcoming : slot is in the future (windowEnd > now)
 *   - taken    : matched event has takenAt != null and not skipped
 *   - skipped  : matched event is explicitly skipped
 *   - missed   : no match and slot is in the past
 */
export function pairDoses(
  slots: ExpectedDose[],
  events: IntakeEventLike[],
  now: Date,
  options?: { radiusFloorMs?: number },
): PairedDose[] {
  const claimed = new Set<number>();
  // v1.12.0 — caller-supplied radius floor. `buildCadenceTimeline` derives
  // the schedule's intrinsic cadence gap and passes half of it here so a
  // window that holds a SINGLE expected slot (e.g. a weekly med over a
  // 7-day window) still widens its match radius — the per-slot
  // neighbour-gap logic below can only widen when two slots are present.
  const radiusFloor = Math.max(
    PAIR_RADIUS_MS,
    options?.radiusFloorMs ?? PAIR_RADIUS_MS,
  );

  // v1.4.27 B7 / simp-M6 — sort once by `windowStart` for the match
  // pass and return the result in the same order. Slots that touch
  // pairDoses are always strictly chronologically separable (the
  // window radius is far smaller than the day grid step), so sorting
  // by `windowStart` and sorting by the centre `(start+end)/2`
  // produce the same order. Dropping the second `.sort()` at the
  // end keeps the contract intact and removes the O(n log n) tail.
  const sorted = [...slots].sort(
    (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
  );
  // Pre-compute each slot's centre once so the per-slot match radius can
  // read the gap to its neighbours (the centres are monotonic in `sorted`
  // order, so neighbour gaps are simply the adjacent entries).
  const centres = sorted.map(
    (s) => (s.windowStart.getTime() + s.windowEnd.getTime()) / 2,
  );
  // Per-slot match index, pre-claimed by the exact-anchor pass below.
  const matchFor: number[] = new Array(sorted.length).fill(-1);

  // v1.15.10 BUG 3 — exact-anchor pass. An intake's `scheduledFor` is snapped
  // to the canonical slot instant (the engine occurrence's `windowStart`) by
  // the write path, so it unambiguously identifies WHICH slot it resolves.
  // The legacy proximity pass below matches `takenAt` against the slot's
  // *window centre*, which for a wide intraday window (a twice-daily med with
  // a 07:00–19:00 window spans 12h → its 07:00 slot centres at 13:00, its
  // 19:00 slot at 01:00 next day) lands between the real dose times: an
  // off-time morning take then pairs to the wrong slot, a user-skip reads as
  // taken, a late evening take reads as missed. Anchoring each event to the
  // slot whose `windowStart` equals its `scheduledFor` first removes that
  // ambiguity for every snapped row; rows that DON'T line up on a slot
  // instant (legacy un-snapped data, sparse cadences logged off-day) fall
  // through to the proximity pass unchanged.
  const ANCHOR_EPSILON_MS = 60_000; // sub-minute DST / rounding slop
  for (let i = 0; i < events.length; i++) {
    if (claimed.has(i)) continue;
    const evt = events[i];
    const anchor = evt.scheduledFor.getTime();
    let bestSlot = -1;
    let bestDist = Infinity;
    for (let s = 0; s < sorted.length; s++) {
      if (matchFor[s] !== -1) continue;
      const dist = Math.abs(sorted[s].windowStart.getTime() - anchor);
      if (dist <= ANCHOR_EPSILON_MS && dist < bestDist) {
        bestDist = dist;
        bestSlot = s;
      }
    }
    if (bestSlot !== -1) {
      matchFor[bestSlot] = i;
      claimed.add(i);
    }
  }

  const result: PairedDose[] = [];

  for (let s = 0; s < sorted.length; s++) {
    const slot = sorted[s];
    const centre = centres[s];
    // v1.12.0 — cadence-aware radius: half the gap to the nearer
    // neighbouring slot, floored at the 12h base. Daily / multi-dose
    // cadences keep the 12h floor; a weekly+ cadence widens so an intake
    // logged anywhere inside the dosing week pairs to that week's slot.
    const radius = Math.max(
      radiusFloor,
      slotMatchRadius(
        centre,
        s > 0 ? centres[s - 1] : null,
        s < centres.length - 1 ? centres[s + 1] : null,
      ),
    );
    // Honour an exact-anchor claim from the first pass; otherwise fall back
    // to the proximity match (legacy un-snapped rows / sparse off-day takes).
    let bestIdx = matchFor[s];
    if (bestIdx === -1) {
      let bestDist = Infinity;
      for (let i = 0; i < events.length; i++) {
        if (claimed.has(i)) continue;
        const evt = events[i];
        const t = (evt.takenAt ?? evt.scheduledFor).getTime();
        const dist = Math.abs(t - centre);
        if (dist <= radius && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
    }

    let status: PairedDose["status"];
    let match: IntakeEventLike | null = null;
    if (bestIdx >= 0) {
      claimed.add(bestIdx);
      match = events[bestIdx];
      // v1.15.9 — an auto-missed dose (the cron marked a never-acted row
      // past its miss cutoff) counts as `missed` even though it carries no
      // `takenAt`. Check it BEFORE the user-skip branch: a forgotten dose
      // must count against the rate, while a deliberate user skip stays
      // `skipped` (excluded from the denominator). `autoMissed` and a
      // user-`skipped` are mutually exclusive on a live row by construction
      // (the cron only touches `skipped = false` pending rows), but the
      // ordering makes the precedence explicit and regression-proof.
      if (match.autoMissed) status = "missed";
      else if (match.skipped) status = "skipped";
      else if (match.takenAt) status = "taken";
      else if (slot.windowEnd > now) status = "upcoming";
      else status = "missed";
    } else if (slot.windowEnd > now) {
      status = "upcoming";
    } else {
      status = "missed";
    }

    result.push({ ...slot, match, status });
  }

  return result;
}

/**
 * Returns the next expected dose after `asOf`, expanding the given
 * schedules across the next `lookaheadDays`. Null when no schedule
 * has any upcoming slot in the lookahead window (e.g. paused med).
 */
export function computeNextDose(
  schedules: ScheduleLike[],
  asOf: Date,
  lookaheadDays = 14,
  anchor?: Date,
  timeZone?: string,
  engineCtx?: CadenceEngineContext,
): ExpectedDose | null {
  const to = new Date(asOf.getTime() + lookaheadDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(
      ...expandScheduleSlots(
        schedules[i],
        i,
        asOf,
        to,
        anchor ?? asOf,
        timeZone,
        engineCtx,
      ),
    );
  }
  if (slots.length === 0) return null;
  return slots.sort(
    (a, b) => a.windowStart.getTime() - b.windowStart.getTime(),
  )[0];
}

/**
 * 30-day (or other window) timeline of paired doses, oldest first.
 * The chart on the detail page maps each entry to one cell on the
 * track / heatmap.
 */
export function buildCadenceTimeline(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
  timeZone?: string,
  engineCtx?: CadenceEngineContext,
  retro?: RetrospectiveRollingOptions,
): PairedDose[] {
  const from = new Date(asOf.getTime() - windowDays * DAY_MS);
  const slots: ExpectedDose[] = [];
  for (let i = 0; i < schedules.length; i++) {
    slots.push(
      ...expandScheduleSlots(
        schedules[i],
        i,
        from,
        asOf,
        anchor ?? from,
        timeZone,
        engineCtx,
        retro,
      ),
    );
  }
  // v1.12.0 — derive the schedule's intrinsic cadence gap so the pairing
  // radius widens for sparse cadences even when the requested window holds
  // a single expected slot (a weekly med over a 7-day window). The per-slot
  // neighbour-gap logic inside `pairDoses` can only widen when two slots
  // sit in the window; a single-slot window needs the floor below.
  const radiusFloorMs = cadenceRadiusFloor(
    schedules,
    asOf,
    windowDays,
    anchor,
    timeZone,
    engineCtx,
    retro,
  );
  return pairDoses(slots, events, asOf, { radiusFloorMs });
}

/**
 * v1.12.0 — half the schedule's intrinsic cadence gap, used as the floor
 * for the intake-match radius.
 *
 * Expands every schedule over a window padded to at least ~16 weeks so a
 * sparse cadence (weekly / bi-weekly / monthly) yields ≥ 2 slots and a
 * real inter-slot gap is observable even when the caller's compliance
 * window only holds one. Takes the MINIMUM consecutive gap across the
 * union of all schedules (the densest part of a multi-schedule med) and
 * halves it, so the floor never over-widens past the point where two
 * adjacent slots would double-claim one intake. Returns the 12h base when
 * fewer than two slots exist anywhere in the probe window (rolling cadence
 * emits only the next slot; a brand-new med; a one-shot) — those cases
 * either have an empty compliance window or a single slot the base radius
 * already covers.
 */
function cadenceRadiusFloor(
  schedules: ScheduleLike[],
  asOf: Date,
  windowDays: number,
  anchor: Date | undefined,
  timeZone: string | undefined,
  engineCtx: CadenceEngineContext | undefined,
  retro?: RetrospectiveRollingOptions,
): number {
  const probeDays = Math.max(windowDays, 16 * 7);
  const probeFrom = new Date(asOf.getTime() - probeDays * DAY_MS);
  const centres: number[] = [];
  for (let i = 0; i < schedules.length; i++) {
    const probeSlots = expandScheduleSlots(
      schedules[i],
      i,
      probeFrom,
      asOf,
      anchor ?? probeFrom,
      timeZone,
      engineCtx,
      retro,
    );
    for (const slot of probeSlots) {
      centres.push((slot.windowStart.getTime() + slot.windowEnd.getTime()) / 2);
    }
  }
  if (centres.length < 2) return PAIR_RADIUS_MS;
  centres.sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < centres.length; i++) {
    const gap = centres[i] - centres[i - 1];
    if (gap > 0 && gap < minGap) minGap = gap;
  }
  if (!Number.isFinite(minGap)) return PAIR_RADIUS_MS;
  return Math.max(PAIR_RADIUS_MS, minGap / 2);
}

/**
 * Count missed (no-taken-no-skipped, past-window) doses across a
 * rolling window. Distinct from the existing
 * `calculateCompliance({ days }).missed` which counts against the
 * expected count rather than pair-matching events; the W19e chips
 * read this for the "Missed last 30 days" value because it agrees
 * exactly with the timeline the user sees in the visualisation.
 */
export function missedDoses(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays = 30,
  anchor?: Date,
  timeZone?: string,
  engineCtx?: CadenceEngineContext,
): number {
  // v1.15.18 — when an engine context is threaded the missed count comes from
  // the unified band ledger (the same one the % and the history view read), so
  // every "missed" surface agrees. Pure-math callers (no context) keep the
  // legacy timeline-status count.
  const ledger = missedFromLedger(
    schedules,
    events,
    asOf,
    windowDays,
    timeZone,
    engineCtx,
  );
  if (ledger !== null) return ledger;
  const timeline = buildCadenceTimeline(
    schedules,
    events,
    asOf,
    windowDays,
    anchor,
    timeZone,
    engineCtx,
  );
  return timeline.filter((d) => d.status === "missed").length;
}

/**
 * v1.15.18 — the count of `missed` rows in the unified dose-history ledger
 * over the trailing window. Returns null when no engine context is supplied
 * (the caller then uses the legacy timeline tally). Shares the band minter +
 * `reconstructDoseHistory` with the compliance % so the numbers agree.
 */
function missedFromLedger(
  schedules: ScheduleLike[],
  events: IntakeEventLike[],
  asOf: Date,
  windowDays: number,
  timeZone: string | undefined,
  engineCtx: CadenceEngineContext | undefined,
): number | null {
  if (!engineCtx) return null;
  const from = new Date(asOf.getTime() - windowDays * DAY_MS);
  const userTz = engineCtx.timeZone || timeZone || "UTC";
  const medication: BandMinterMedication = {
    id: "missed-tally",
    startsOn: engineCtx.startsOn,
    endsOn: engineCtx.endsOn,
    oneShot: engineCtx.oneShot,
    createdAt: engineCtx.createdAt,
  };
  const recurrenceCtx: RecurrenceContext = {
    medication: {
      id: "missed-tally",
      startsOn: engineCtx.startsOn,
      endsOn: engineCtx.endsOn,
      oneShot: engineCtx.oneShot,
      createdAt: engineCtx.createdAt,
    },
    timeZone: userTz,
    lastIntakeAt: engineCtx.lastIntakeAt,
  };
  const canonicalSchedules: CanonicalSchedule[] = schedules.map((s, i) => {
    const base = toCanonical(s, i);
    if (
      base.timesOfDay.length === 0 &&
      base.rrule === null &&
      base.rollingIntervalDays === null &&
      base.scheduleType !== "PRN" &&
      !engineCtx.oneShot
    ) {
      return { ...base, timesOfDay: [base.windowStart] };
    }
    return base;
  });
  const intakeInstants = events
    .filter((e) => !e.skipped && e.takenAt !== null && e.takenAt <= asOf)
    .map((e) => e.takenAt as Date)
    .sort((a, b) => a.getTime() - b.getTime());
  const groups = buildBandsForSchedulesWithEras({
    medication,
    schedules: canonicalSchedules,
    revisions: engineCtx.scheduleRevisions ?? [],
    ctx: recurrenceCtx,
    userTz,
    range: { from, to: asOf },
    now: asOf,
    intakeInstants,
  });
  const bands: SlotBand[] = [];
  for (const g of groups) {
    if (g.hasExpectedSlots) bands.push(...g.bands);
  }
  const intakes: HistoryIntake[] = events
    .filter((e) => e.scheduledFor >= from && e.scheduledFor <= asOf)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
    }));
  const rows = reconstructDoseHistory(
    bands,
    intakes,
    asOf,
    engineCtx.createdAt,
  );
  return rows.filter((r) => r.status === "missed").length;
}
