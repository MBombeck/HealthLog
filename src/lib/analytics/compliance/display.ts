// Extracted from the former single-file `compliance.ts`. See `../compliance.ts`
// (the barrel) for the module map. Pure move — no logic changes.

import {
  buildCadenceTimeline,
  type CadenceEngineContext,
  type IntakeEventLike,
  type ScheduleLike,
} from "@/lib/medications/scheduling/cadence";
import { streaksFromTimeline } from "@/lib/medications/scheduling/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import type {
  ComplianceMedicationContext,
  ComplianceResult,
  ComplianceSchedule,
  IntakeEvent,
} from "./types";
import {
  deriveDoseStatus,
  doseCadenceFamily,
  type DoseCadenceFamily,
  type DoseStatus,
} from "./dose-status";
import {
  COMPLIANCE_WINDOW_LADDER,
  MIN_STABLE_DOSES,
  selectComplianceWindows,
  type ComplianceWindowSelection,
} from "./windows";
import {
  COMPLIANCE_LEDGER_WINDOW_DAYS,
  buildComplianceLedgerRows,
  tallyComplianceFromLedger,
  tallyLedgerRows,
} from "./ledger";
import { buildCurrentCycle, type CurrentCycle } from "./cycle";
import { rollingIntakeInstants } from "./adapters";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1.15.9 — the {@link DoseCadenceFamily} of the soonest non-PRN schedule,
 * used to pick the window model for the open dose's status. A multi-schedule
 * med whose cycle anchors on its earliest window keeps that window's cadence;
 * when every schedule is PRN (no projected dose) the family is irrelevant
 * because the caller only reads `currentDose` when a cycle is open.
 */
function soonestCadenceFamily(
  schedules: ComplianceSchedule[],
): DoseCadenceFamily {
  for (const s of schedules) {
    if (s.scheduleType === "PRN") continue;
    return doseCadenceFamily(s);
  }
  return "daily";
}

/**
 * v1.8.6 — the compliance-display block returned alongside the existing
 * `compliance7` / `compliance30` fields (which iOS + the Health Score read
 * verbatim). The card always renders two percentage rows; the server picks
 * the two windows from the medication's cadence and computes each row's
 * rate over the chosen span. A dense med keeps `7` / `30`; a sparse med
 * steps both windows up so each row covers enough expected doses to be
 * meaningful.
 */

export interface ComplianceDisplay {
  shortDays: number;
  longDays: number;
  /** Realised expected dose count over the short window. */
  expectedShort: number;
  /** Realised expected dose count over the long window. */
  expectedLong: number;
  /** Echo of the density floor so a client can re-derive the rung. */
  minStableDoses: number;
  /**
   * Compliance percentage + counts + day-streak over the short window.
   * `taken` is the numerator the card renders next to the rate so two
   * identical percentages stay distinguishable and trustworthy; `expected`
   * is the rate denominator (taken + missed, EXCLUDING user skips) and
   * `missed` the count counting against the rate. The card can render
   * "26 / 30 · 87%" from `taken` / `expected`.
   */
  short: {
    rate: number;
    taken: number;
    expected: number;
    missed: number;
    streak: number;
  };
  /** Compliance percentage + counts over the long window. */
  long: { rate: number; taken: number; expected: number; missed: number };
  /**
   * v1.13.x Fix 4 — the open-cycle state, decoupled from the percentage
   * rows so a between-doses sparse med never renders a scary red number.
   */
  currentCycle: CurrentCycle;
  /**
   * v1.15.9 — the open cycle's per-dose {@link DoseStatus}, server-derived
   * so the card renders its state (green take-window, overdue / heavily-
   * overdue escalation) from one authority instead of re-deriving the window
   * math client-side. `status` is `upcoming` when no dose is open yet and
   * there is no projected next dose (PRN / paused / ended). `targetAt` is the
   * open dose's target instant (echo of `currentCycle.nextDueAt`).
   */
  currentDose: { status: DoseStatus; targetAt: Date | null };
}

/**
 * v1.8.6 — compute the two-row {@link ComplianceDisplay} block.
 *
 * The card always shows two percentage rows. {@link selectComplianceWindows}
 * decides which windows they span from the medication's cadence, then each
 * row's rate is the cadence-aware {@link calculateCompliance} over that
 * window. The short row also carries the day-streak. The compliance math is
 * unchanged from the legacy 7-/30-day path — only the window day-counts move.
 */
export function buildComplianceDisplay(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  options?: { now?: Date },
): ComplianceDisplay {
  const now = options?.now ?? new Date();
  // v1.13.x — thread the intake history so a ROLLING cadence's window
  // selection scores the retrospective grid (each logged dose is a closed
  // cycle) rather than the engine's single forward slot. Without this a
  // weekly rolling med always falls through to the widest `[90, 365]` rung.
  const { shortDays, longDays, expectedShort, expectedLong } =
    selectComplianceWindows(schedules, ctx, { now, intakes: events });

  const short = calculateCompliance(
    events,
    schedules,
    shortDays,
    ctx.createdAt,
    {
      now,
      medicationContext: ctx,
    },
  );
  const long = calculateCompliance(events, schedules, longDays, ctx.createdAt, {
    now,
    medicationContext: ctx,
  });

  // v1.13.x Fix 4 — the open-cycle descriptor, separable from the rates.
  const currentCycle = buildCurrentCycle(
    schedules,
    ctx,
    now,
    expectedShort,
    events,
  );

  // v1.15.9 — derive the open dose's per-dose status from one server
  // authority so the card renders the take-window (green) / overdue /
  // heavily-overdue escalation without re-spelling the window math. The
  // cadence family comes from the SOONEST non-PRN schedule (the one the
  // open cycle anchors on). `none` cycles (PRN / paused / ended) carry an
  // `upcoming` status with a null target so the card stays calm.
  const currentDose: { status: DoseStatus; targetAt: Date | null } =
    currentCycle.nextDueAt
      ? {
          status: deriveDoseStatus(
            currentCycle.nextDueAt,
            soonestCadenceFamily(schedules),
            now,
          ),
          targetAt: currentCycle.nextDueAt,
        }
      : { status: "upcoming", targetAt: null };

  return {
    shortDays,
    longDays,
    expectedShort,
    expectedLong,
    minStableDoses: MIN_STABLE_DOSES,
    // `expected` is the rate denominator (taken + missed) so the card can
    // render the trustworthy "taken / expected · rate%" triple; user skips
    // are excluded from it by construction (they never enter `missed`).
    short: {
      rate: short.rate,
      taken: short.taken,
      expected: short.taken + short.missed,
      missed: short.missed,
      streak: short.streak,
    },
    long: {
      rate: long.rate,
      taken: long.taken,
      expected: long.taken + long.missed,
      missed: long.missed,
    },
    currentCycle,
    currentDose,
  };
}

/**
 * Calculate compliance for a medication over a given period.
 *
 * Honours `daysOfWeek` (e.g. `"1"` for Mondays only) and
 * `intervalWeeks` (bi-weekly, tri-weekly, …) by delegating to
 * `buildCadenceTimeline`. The denominator is the number of dose slots
 * the schedule actually emits inside the window — not
 * `schedules.length * days`. A user on a weekly Monday-only schedule
 * who takes every Monday for 30 days reports 100% adherence (4 of 4
 * Mondays) instead of the pre-v1.5.0 ~13% (4 of 30).
 *
 * Skipped doses are excluded from the denominator (deliberate user
 * decision, not a compliance failure). When the window contains no
 * expected doses (paused med, brand-new prescription, schedule that
 * never fires in the window) the helper returns `rate: 100` so the
 * empty state doesn't trip a "0% compliance" alarm downstream.
 *
 * Streak counts consecutive days, ending at `now`, where every
 * expected dose for the day was taken (or skipped). Days with no
 * expected dose (out-of-cadence weekdays, off-weeks on a bi-weekly
 * schedule) advance the streak — the user gets credit for not
 * breaking on non-scheduled days.
 *
 * @param events         Recorded intake events from
 *                       `MedicationIntakeEvent`. Only `scheduledFor`,
 *                       `takenAt`, `skipped` are read.
 * @param schedules      Schedule rows for the medication. `daysOfWeek`
 *                       is read when present; missing field is treated
 *                       as daily.
 * @param days           Rolling-window size in days (typically 7 / 30
 *                       / 90).
 * @param medicationCreatedAt
 *                       When provided, days before the medication
 *                       existed are excluded so they don't count as
 *                       "missed".
 * @param options.now    Override for the rolling-window anchor. The
 *                       fast-path Health-Score helper passes a fixed
 *                       `now` so cached medication-compliance rates
 *                       agree with the score's other pillars; default
 *                       is `new Date()` (current wall-clock instant).
 *                       v1.5.0 — added so the cadence-aware adapter
 *                       can be driven deterministically from a caller
 *                       that already pinned its own `now`.
 */
/**
 * Whether a medication expects any dose at all, and so has an adherence rate
 * worth showing.
 *
 * `calculateCompliance` below answers `rate: 100, totalExpected: 0` for a
 * medication with no schedule. That is arithmetically honest — nothing was
 * expected, so nothing was missed — and it is a lie on every surface that
 * reads the number as adherence. PRN is the obvious arm and every caller
 * already filtered it; the empty schedule on a NON-PRN medication is the arm
 * that got through, and it is reachable: `POST /api/medications` accepts
 * `schedules ?? []` on a scheduled medication. The doctor report has excluded
 * both arms since it was written, so the report never prints a fabricated
 * 100 %; the same reason applies to every other surface, so the two arms live
 * in one predicate rather than being re-derived at each call site. v1.39.1
 * adds the third arm: a medication whose intake tracking is off keeps its
 * schedule rows and still expects nothing.
 */
export function expectsDoses(medication: {
  asNeeded: boolean;
  /**
   * v1.39.1 (#1033) — intake tracking switched off keeps the schedule rows
   * as information but expects nothing from them. Required, not optional,
   * so a caller cannot reach the predicate without having read the flag.
   */
  trackIntake: boolean;
  schedules: readonly unknown[];
}): boolean {
  return (
    !medication.asNeeded &&
    medication.trackIntake !== false &&
    medication.schedules.length > 0
  );
}

export function calculateCompliance(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  days: number,
  medicationCreatedAt?: Date,
  options?: { now?: Date; medicationContext?: ComplianceMedicationContext },
): ComplianceResult {
  if (schedules.length === 0) {
    return {
      totalExpected: 0,
      taken: 0,
      skipped: 0,
      missed: 0,
      rate: 100,
      streak: 0,
    };
  }

  const now = options?.now ?? new Date();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periodStart = new Date(now.getTime() - days * DAY_MS);
  const effectiveStart =
    medicationCreatedAt && medicationCreatedAt > periodStart
      ? medicationCreatedAt
      : periodStart;
  const effectiveDays = Math.max(
    1,
    Math.ceil((now.getTime() - effectiveStart.getTime()) / DAY_MS),
  );

  // v1.15.18 — when a medication context is supplied, the count fields
  // (taken / skipped / missed / rate) come from the UNIFIED dose-history
  // ledger tally, NOT the ±12h `pairDoses` proximity matcher. This is the
  // keystone unification: the percentage is a tally over the exact same
  // ledger the history view renders, so the two can never contradict (a
  // dose can't read "taken late" in the % while the ledger calls it
  // "ad-hoc"). The numerator is on-time + late takes (a late dose still
  // counts as taken); user skips + ad-hoc top-ups + PRN groups are excluded
  // from the denominator. The streak still walks the cadence timeline below
  // (its day-grain "every dose taken or skipped" rule is unchanged).
  //
  // Context-less callers (pure-math fixtures, pre-v1.7 surfaces) keep the
  // legacy timeline tally byte-stable — they have no engine context to mint
  // bands from.
  const ledgerCtx = options?.medicationContext;
  let ledgerCounts: {
    taken: number;
    skipped: number;
    missed: number;
    rate: number;
  } | null = null;
  if (ledgerCtx) {
    // The tally reads the whole period, not only the part after the
    // medication's creation: the ledger itself keeps a slot before the
    // creation only when a recorded dose claims it (#1028), so the rate
    // matches the history view on the creation day.
    const tally = tallyComplianceFromLedger(
      events,
      schedules,
      ledgerCtx,
      periodStart,
      now,
      now,
    );
    ledgerCounts = {
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
      rate: tally.rate,
    };
  }

  // Normalise the schedule shape so legacy callers that pass only
  // `{ windowStart, windowEnd }` still produce a usable `daysOfWeek`
  // field (treated as daily by the cadence parser).
  const normalisedSchedules: ScheduleLike[] = schedules.map((s, i) => ({
    id: `compliance-${i}`,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    daysOfWeek: s.daysOfWeek ?? null,
    // v1.7.0 SB-SCHED-2 — thread the canonical-engine fields so the
    // cadence expander can delegate to `occurrencesBetween` when a
    // medication context is supplied. Undefined fields collapse to the
    // legacy weekday path inside `expandScheduleSlots`.
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? null,
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  }));

  // v1.7.0 SB-SCHED-2 — build the engine context once per medication.
  // When the caller supplies it, the timeline routes through the
  // canonical engine (RRULE / rolling / one-shot / PRN / cyclic);
  // otherwise the legacy weekday walker stays in force.
  const ctx = options?.medicationContext;
  const engineCtx: CadenceEngineContext | undefined = ctx
    ? {
        startsOn: ctx.startsOn,
        endsOn: ctx.endsOn,
        oneShot: ctx.oneShot,
        createdAt: ctx.createdAt,
        lastIntakeAt: ctx.lastIntakeAt,
        timeZone: ctx.timeZone,
        scheduleRevisions: ctx.scheduleRevisions,
      }
    : undefined;

  // Match events against the same slot grid the cadence chart uses.
  // The chart's pairing radius is ±12 h so a late-by-six-hours dose
  // still attaches to the right slot instead of double-counting as
  // "missed + extra".
  const normalisedEvents: IntakeEventLike[] = events
    .filter((e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      // v1.15.9 — carry the forgotten-dose flag into the timeline so an
      // auto-missed slot pairs to a `missed` status (counts against the
      // rate) rather than a neutral `skipped`.
      autoMissed: e.autoMissed ?? false,
    }));

  // v1.13.x — ROLLING retrospective expansion. A rolling cadence
  // (`rollingIntervalDays`, the canonical GLP-1 "every N days" shape) is
  // forward-only in the engine: `expandRolling` emits at most the single
  // immediately-next slot, so a historical compliance window saw either
  // zero expected slots (vacuous 100%) or one overdue slot (hard 0%) —
  // never the true multi-dose adherence over the trailing window. When a
  // medication context is threaded AND any schedule is rolling, route the
  // rolling schedules through the retrospective builder so each logged dose
  // is one satisfied expected slot (plus synthesized misses for skipped
  // whole cycles + a past-due forward slot). Non-rolling schedules keep the
  // forward-only engine path; both share `buildCadenceTimeline` so the
  // numerator and denominator agree (the v1.7.3 B15 convergence rule).
  const hasRolling = schedules.some(
    (s) => s.rollingIntervalDays != null && s.rollingIntervalDays > 0,
  );
  const retro =
    engineCtx && hasRolling
      ? { intakeInstants: rollingIntakeInstants(events, now), now }
      : undefined;

  const timeline = buildCadenceTimeline(
    normalisedSchedules,
    normalisedEvents,
    now,
    effectiveDays,
    medicationCreatedAt ?? effectiveStart,
    engineCtx?.timeZone,
    engineCtx,
    retro,
  );

  // v1.15.18 — the count fields come from the unified ledger tally when a
  // medication context was supplied (the keystone unification), and from the
  // legacy timeline tally otherwise (context-less pure-math callers). The
  // streak below always walks the timeline — its day-grain rule is orthogonal
  // to the per-dose attribution and stays byte-stable for every caller.
  let taken: number;
  let skipped: number;
  let missed: number;
  let rate: number;
  if (ledgerCounts) {
    ({ taken, skipped, missed, rate } = ledgerCounts);
  } else {
    taken = 0;
    skipped = 0;
    missed = 0;
    for (const slot of timeline) {
      if (slot.status === "taken") taken++;
      else if (slot.status === "skipped") skipped++;
      else if (slot.status === "missed") missed++;
      // `upcoming` slots (future window) are excluded from every counter
      // so a partial day at the head of the window doesn't pollute the rate.
    }
    // Skipped doses are excluded from the denominator — they represent a
    // deliberate user decision rather than a missed dose.
    const denom = taken + missed;
    rate = denom > 0 ? Math.min(100, Math.round((taken / denom) * 100)) : 100;
  }

  const totalExpected = taken + skipped + missed;

  // Streak: consecutive days, ending today, where every expected dose
  // was taken or skipped. Days with no expected dose advance the
  // streak — out-of-cadence days are not failures. Delegated to the
  // shared `streaksFromTimeline` so the analytics streak and the
  // detail-page chip streak agree on every dose AND so the day keys are
  // computed in the USER's IANA timezone, not the host's. The prior
  // host-tz `getFullYear/getMonth/getDate` walk drifted off by a day
  // whenever the server clock's zone differed from the user's — the
  // timeline `slot.day` is already minted in the user zone, so the
  // walk has to match it. The window is `effectiveDays` ending at
  // `now`, which starts no earlier than `effectiveStart` (= the later
  // of the period start and the medication's creation) — so days
  // before the medication existed are never iterated, preserving the
  // old `cursor <= medicationCreatedAt` break by construction.
  const { current: streak } = streaksFromTimeline(
    timeline,
    now,
    effectiveDays,
    engineCtx?.timeZone,
  );

  return { totalExpected, taken, skipped, missed, rate, streak };
}

/**
 * The per-medication compliance payload computed from ONE shared expansion
 * pass. `ledgerRows` is the unified dose-history ledger over
 * `[ledgerFrom, now]`; the caller carves the 90-day heatmap out of it by
 * filtering on `row.at`.
 */
export interface MedicationComplianceBundle {
  compliance7: ComplianceResult;
  compliance30: ComplianceResult;
  complianceDisplay: ComplianceDisplay;
  /** Unified ledger rows over `[ledgerFrom, now]`, chronological. */
  ledgerRows: DoseHistoryRow[];
  /**
   * Lower bound of the mint window. Not clamped to the medication's
   * creation: the ledger drops pre-creation slots no recorded dose claims.
   */
  ledgerFrom: Date;
}

/**
 * Build every block of the per-medication compliance response from a single
 * band-expansion pass.
 *
 * The historical composition called {@link calculateCompliance} four times
 * (7 / 30 / short / long), {@link selectComplianceWindows} (up to four more
 * occurrence expansions for the rung probes) and a separate 90-day heatmap
 * mint — five-plus full band expansions per request. This builder instead:
 *
 *   1. mints the bands + reconstructs the ledger ONCE over
 *      `[now − 365 d, now]` (slots before the medication's creation survive
 *      only when a recorded dose claims them; every served window is a
 *      suffix of that range and ends at `now`, so a sub-window tally is a
 *      filter over `row.at`, not a re-expansion);
 *   2. builds ONE cadence timeline over the same range for the per-window
 *      streaks ({@link streaksFromTimeline} bounds its day-walk by the
 *      requested window, so the wider timeline serves every window);
 *   3. walks the {@link COMPLIANCE_WINDOW_LADDER} on the ledger's slot-row
 *      counts (one band per engine occurrence, so the counts match the
 *      historical `expectedSlotsBetween` probes).
 *
 * The returned blocks carry the exact public shapes the route has always
 * served — only the number of expansion passes changed.
 */
export function buildMedicationComplianceBundle(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
): MedicationComplianceBundle {
  const ledgerPeriodStart = new Date(
    now.getTime() - COMPLIANCE_LEDGER_WINDOW_DAYS * ONE_DAY_MS,
  );
  // The ledger mints over the whole period: a slot before the medication's
  // creation stays in it only when a recorded dose claims it (#1028), so no
  // pre-existence day reads as missed. The streak timeline keeps its
  // creation floor.
  const ledgerFrom = ledgerPeriodStart;
  const timelineFrom =
    ctx.createdAt.getTime() > ledgerPeriodStart.getTime()
      ? ctx.createdAt
      : ledgerPeriodStart;

  const hasSchedules = schedules.length > 0;
  const ledgerRows = hasSchedules
    ? buildComplianceLedgerRows(events, schedules, ctx, ledgerFrom, now, now)
    : [];

  // ONE cadence timeline over the full ledger window. Each per-window
  // streak below walks only its own trailing `effectiveDays`, so sharing
  // the wide timeline reproduces the per-window builds.
  const fullDays = Math.max(
    1,
    Math.ceil((now.getTime() - timelineFrom.getTime()) / ONE_DAY_MS),
  );
  const timeline = hasSchedules
    ? buildTimelineForWindow(
        events,
        schedules,
        ctx,
        now,
        timelineFrom,
        fullDays,
      )
    : [];

  const resultForWindow = (days: number): ComplianceResult => {
    if (!hasSchedules) {
      // Mirrors `calculateCompliance`'s empty-schedule short-circuit.
      return {
        totalExpected: 0,
        taken: 0,
        skipped: 0,
        missed: 0,
        rate: 100,
        streak: 0,
      };
    }
    const periodStart = new Date(now.getTime() - days * ONE_DAY_MS);
    const effectiveStart =
      ctx.createdAt.getTime() > periodStart.getTime()
        ? ctx.createdAt
        : periodStart;
    const effectiveDays = Math.max(
      1,
      Math.ceil((now.getTime() - effectiveStart.getTime()) / ONE_DAY_MS),
    );
    const tally = tallyLedgerRows(ledgerRows, {
      from: periodStart,
      to: now,
    });
    const { current: streak } = streaksFromTimeline(
      timeline,
      now,
      effectiveDays,
      ctx.timeZone,
    );
    return {
      totalExpected: tally.taken + tally.skipped + tally.missed,
      taken: tally.taken,
      skipped: tally.skipped,
      missed: tally.missed,
      rate: tally.rate,
      streak,
    };
  };

  // Window-ladder selection from the ledger's slot rows. A slot row is one
  // minted band, and the minter emits one band per engine occurrence, so
  // counting slot rows over a trailing window equals the historical
  // `expectedSlotsBetween(...).length` probe for that window.
  const expectedCache = new Map<number, number>();
  const expectedOver = (days: number): number => {
    const hit = expectedCache.get(days);
    if (hit !== undefined) return hit;
    const from = now.getTime() - days * ONE_DAY_MS;
    let count = 0;
    for (const row of ledgerRows) {
      if (row.kind !== "slot") continue;
      const t = row.at.getTime();
      if (t >= from && t <= now.getTime()) count++;
    }
    expectedCache.set(days, count);
    return count;
  };

  let selection: ComplianceWindowSelection | null = null;
  for (const [shortDays, longDays] of COMPLIANCE_WINDOW_LADDER) {
    const expectedShort = expectedOver(shortDays);
    const expectedLong = expectedOver(longDays);
    if (expectedShort >= MIN_STABLE_DOSES && expectedLong >= MIN_STABLE_DOSES) {
      selection = { shortDays, longDays, expectedShort, expectedLong };
      break;
    }
  }
  if (!selection) {
    // No rung cleared the floor — fall back to the widest rung, exactly
    // like `selectComplianceWindows`.
    const [shortDays, longDays] =
      COMPLIANCE_WINDOW_LADDER[COMPLIANCE_WINDOW_LADDER.length - 1];
    selection = {
      shortDays,
      longDays,
      expectedShort: expectedOver(shortDays),
      expectedLong: expectedOver(longDays),
    };
  }

  const compliance7 = resultForWindow(7);
  const compliance30 = resultForWindow(30);
  const short = resultForWindow(selection.shortDays);
  const long = resultForWindow(selection.longDays);

  const currentCycle = buildCurrentCycle(
    schedules,
    ctx,
    now,
    selection.expectedShort,
    events,
  );
  const currentDose: { status: DoseStatus; targetAt: Date | null } =
    currentCycle.nextDueAt
      ? {
          status: deriveDoseStatus(
            currentCycle.nextDueAt,
            soonestCadenceFamily(schedules),
            now,
          ),
          targetAt: currentCycle.nextDueAt,
        }
      : { status: "upcoming", targetAt: null };

  const complianceDisplay: ComplianceDisplay = {
    shortDays: selection.shortDays,
    longDays: selection.longDays,
    expectedShort: selection.expectedShort,
    expectedLong: selection.expectedLong,
    minStableDoses: MIN_STABLE_DOSES,
    short: {
      rate: short.rate,
      taken: short.taken,
      expected: short.taken + short.missed,
      missed: short.missed,
      streak: short.streak,
    },
    long: {
      rate: long.rate,
      taken: long.taken,
      expected: long.taken + long.missed,
      missed: long.missed,
    },
    currentCycle,
    currentDose,
  };

  return {
    compliance7,
    compliance30,
    complianceDisplay,
    ledgerRows,
    ledgerFrom,
  };
}

/**
 * The cadence-timeline construction from {@link calculateCompliance},
 * extracted so {@link buildMedicationComplianceBundle} can build it once
 * over the full ledger window instead of once per served sub-window. Same
 * normalisation, same engine context, same rolling-retrospective routing.
 */
function buildTimelineForWindow(
  events: IntakeEvent[],
  schedules: ComplianceSchedule[],
  ctx: ComplianceMedicationContext,
  now: Date,
  effectiveStart: Date,
  effectiveDays: number,
): ReturnType<typeof buildCadenceTimeline> {
  const normalisedSchedules: ScheduleLike[] = schedules.map((s, i) => ({
    id: `compliance-${i}`,
    windowStart: s.windowStart,
    windowEnd: s.windowEnd,
    daysOfWeek: s.daysOfWeek ?? null,
    rrule: s.rrule ?? null,
    rollingIntervalDays: s.rollingIntervalDays ?? null,
    timesOfDay: s.timesOfDay,
    reminderGraceMinutes: s.reminderGraceMinutes ?? null,
    scheduleType: s.scheduleType ?? null,
    cyclicOnWeeks: s.cyclicOnWeeks ?? null,
    cyclicOffWeeks: s.cyclicOffWeeks ?? null,
  }));

  const engineCtx: CadenceEngineContext = {
    startsOn: ctx.startsOn,
    endsOn: ctx.endsOn,
    oneShot: ctx.oneShot,
    createdAt: ctx.createdAt,
    lastIntakeAt: ctx.lastIntakeAt,
    timeZone: ctx.timeZone,
    scheduleRevisions: ctx.scheduleRevisions,
  };

  const normalisedEvents: IntakeEventLike[] = events
    .filter((e) => e.scheduledFor >= effectiveStart && e.scheduledFor <= now)
    .map((e) => ({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed ?? false,
    }));

  const hasRolling = schedules.some(
    (s) => s.rollingIntervalDays != null && s.rollingIntervalDays > 0,
  );
  const retro = hasRolling
    ? { intakeInstants: rollingIntakeInstants(events, now), now }
    : undefined;

  return buildCadenceTimeline(
    normalisedSchedules,
    normalisedEvents,
    now,
    effectiveDays,
    ctx.createdAt,
    ctx.timeZone,
    engineCtx,
    retro,
  );
}
