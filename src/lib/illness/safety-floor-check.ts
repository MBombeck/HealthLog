/**
 * Safety-floor write-hook orchestrator (v1.18.6).
 *
 * Runs AFTER a measurement write lands. Resolves the recent same-kind readings
 * the confirm gate needs, runs the absolute-floor engine (`safety-floors.ts`),
 * and dispatches an urgent escalation (`safety-floor-notify.ts`) when — and
 * only when — a fresh reading breaches a clinical floor AND a prior reading
 * inside the confirm window held the same floor.
 *
 * Module-gated: glucose checks only run when the `glucose` module is enabled;
 * BP is a CORE domain (always on) but the BP check is still cheap and only
 * fires on an extreme reading. Owner-scoped, fire-and-forget, never throws —
 * a notification failure must never fail the user's measurement write.
 *
 * The caller (the measurement POST route) passes the just-written rows plus
 * the transient `symptomsPresent` flag; this helper does the bounded reads.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { isModuleEnabled } from "@/lib/modules/gate";
import { resolveGlucoseUnit } from "@/lib/glucose";
import { FEVER_RED_FLAG_C, SPO2_RED_FLAG_PCT } from "@/lib/clinical-floors";
import {
  evaluateBloodPressure,
  evaluateGlucose,
  CONFIRM_WINDOW_MS,
  type BpSample,
  type GlucoseSample,
} from "@/lib/illness/safety-floors";
import { notifySafetyFloor } from "@/lib/illness/safety-floor-notify";
import {
  RED_FLAG_RUN_DAYS,
  dayDiff,
  type IllnessRedFlag,
} from "@/lib/illness/correlation";
import { notifyIllnessRedFlag } from "@/lib/illness/red-flag-notify";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";

/** A row the write hook just persisted (the subset the check needs). */
export interface WrittenReading {
  type: string;
  value: number;
  measuredAt: Date;
  glucoseContext?: string | null;
}

/**
 * Evaluate the just-written readings against the absolute safety floors and
 * dispatch any confirmed escalation. Best-effort.
 *
 * `symptomsPresent` is the transient per-write flag — true lifts a confirmed
 * breach to the symptom-coupled emergency copy. Defaults to false.
 */
export async function runSafetyFloorCheck(input: {
  userId: string;
  written: WrittenReading[];
  symptomsPresent?: boolean;
  /**
   * The user's IANA timezone, used to bucket the sustained fever / SpO2 run by
   * CALENDAR day. Defaults to UTC when absent — a missing timezone must never
   * silence a safety escalation, only shift the day boundary.
   */
  timezone?: string;
}): Promise<void> {
  const { userId, written } = input;
  const symptomCoupled = input.symptomsPresent === true;
  const tz =
    input.timezone && input.timezone.length > 0 ? input.timezone : "UTC";

  try {
    await Promise.all([
      checkBloodPressure(userId, written, symptomCoupled),
      checkGlucose(userId, written, symptomCoupled),
      // Sustained multi-day runs against ABSOLUTE clinical floors. Unlike the
      // confirm-gated BP / glucose checks above (single breach + a confirming
      // re-test inside an hour), a fever / low-SpO2 escalation only fires when
      // the floor held for RED_FLAG_RUN_DAYS calendar-consecutive days — the
      // SAME run length and floors the retrospective correlation detector uses,
      // so the on-write seam and the correlation surface can never disagree.
      checkSustainedFever(userId, written, tz),
      checkSustainedLowSpo2(userId, written, tz),
    ]);
  } catch (err) {
    getEvent()?.addWarning(
      `safety-floor check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/* ── blood pressure ───────────────────────────────────────────────────── */

async function checkBloodPressure(
  userId: string,
  written: WrittenReading[],
  symptomCoupled: boolean,
): Promise<void> {
  // BP is stored as two rows (SYS + DIA). We only evaluate when BOTH arms of
  // the candidate reading are present in this write (the normal combined-form
  // and iOS batch path) so we never reason about half a reading.
  const sys = written.find((r) => r.type === "BLOOD_PRESSURE_SYS");
  const dia = written.find((r) => r.type === "BLOOD_PRESSURE_DIA");
  if (!sys || !dia) return;

  const candidate: BpSample = {
    measuredAt: sys.measuredAt,
    systolic: sys.value,
    diastolic: dia.value,
  };

  // Pull the recent SYS + DIA rows inside the confirm window and pair them by
  // timestamp so the engine sees prior whole readings, not loose arms. The
  // candidate's own rows are excluded by the strict `lt: measuredAt` bound.
  const windowStart = new Date(
    candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS,
  );
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
      deletedAt: null,
      measuredAt: { gte: windowStart, lt: candidate.measuredAt },
    },
    orderBy: { measuredAt: "desc" },
    take: 50,
    select: { type: true, value: true, measuredAt: true },
  });

  const recent = pairBp(rows);
  const decision = evaluateBloodPressure({ candidate, recent, symptomCoupled });
  await notifySafetyFloor({ userId, decision });
}

/**
 * Pair loose SYS/DIA rows into whole BP samples by exact timestamp. A combined
 * BP form writes both arms at the same instant, so an exact-instant join is
 * the right grain here (the confirm gate only needs prior WHOLE readings).
 */
function pairBp(
  rows: ReadonlyArray<{ type: string; value: number; measuredAt: Date }>,
): BpSample[] {
  const sysByTs = new Map<number, number>();
  const diaByTs = new Map<number, number>();
  for (const r of rows) {
    const ts = r.measuredAt.getTime();
    if (r.type === "BLOOD_PRESSURE_SYS") sysByTs.set(ts, r.value);
    else if (r.type === "BLOOD_PRESSURE_DIA") diaByTs.set(ts, r.value);
  }
  const out: BpSample[] = [];
  for (const [ts, systolic] of sysByTs) {
    const diastolic = diaByTs.get(ts);
    if (diastolic === undefined) continue;
    out.push({ measuredAt: new Date(ts), systolic, diastolic });
  }
  return out;
}

/* ── glucose ──────────────────────────────────────────────────────────── */

async function checkGlucose(
  userId: string,
  written: WrittenReading[],
  symptomCoupled: boolean,
): Promise<void> {
  const glucose = written.find((r) => r.type === "BLOOD_GLUCOSE");
  if (!glucose) return;

  // Module gate: only run when the glucose module is enabled for this account.
  if (!(await isModuleEnabled(userId, "glucose"))) return;

  const candidate: GlucoseSample = {
    measuredAt: glucose.measuredAt,
    mgdl: glucose.value,
  };

  const windowStart = new Date(
    candidate.measuredAt.getTime() - CONFIRM_WINDOW_MS,
  );
  // The confirm gate asks whether ANY reading of the hour before sat on the
  // same side of a floor, and the floors are thresholds, so the hour's lowest
  // and highest reading answer it exactly. A sensor reporting every minute
  // fills the hour with sixty readings; the newest 50 a capped read returned
  // left the hour's first ten minutes unseen.
  const window = {
    userId,
    type: "BLOOD_GLUCOSE" as const,
    deletedAt: null,
    measuredAt: { gte: windowStart, lt: candidate.measuredAt },
  };
  const select = { value: true, measuredAt: true } as const;
  const [lowest, highest] = await Promise.all([
    prisma.measurement.findFirst({
      where: window,
      orderBy: [{ value: "asc" }, { measuredAt: "desc" }],
      select,
    }),
    prisma.measurement.findFirst({
      where: window,
      orderBy: [{ value: "desc" }, { measuredAt: "desc" }],
      select,
    }),
  ]);

  const recent: GlucoseSample[] = [lowest, highest].flatMap((r) =>
    r ? [{ measuredAt: r.measuredAt, mgdl: r.value }] : [],
  );
  const decision = evaluateGlucose({ candidate, recent, symptomCoupled });
  if (!decision) return;

  // Resolve the user's display unit only when there's actually a breach to
  // report — the escalation push must speak the user's own unit (mmol/L
  // users get "3.9 mmol/L", not a raw mg/dL figure mid-hypo).
  const profile = await prisma.user.findUnique({
    where: { id: userId },
    select: { glucoseUnit: true },
  });
  const glucoseUnit = resolveGlucoseUnit(profile?.glucoseUnit ?? null);
  await notifySafetyFloor({ userId, decision, glucoseUnit });
}

/* ── sustained fever / low-SpO2 (multi-day calendar runs) ─────────────── */

/**
 * Lookback span (calendar days, inclusive of the candidate day) the sustained
 * run scan reads. RED_FLAG_RUN_DAYS days are needed to form a run that ends on
 * the candidate day; one extra day absorbs UTC-vs-local boundary skew so a run
 * that ends "today" in the user's timezone is never clipped. We only react to
 * RECENT runs by design — an old run is the correlation surface's job, not the
 * write hook's.
 */
const SUSTAINED_LOOKBACK_DAYS = RED_FLAG_RUN_DAYS + 1;

/**
 * Sustained fever: BODY_TEMPERATURE ≥ FEVER_RED_FLAG_C (°C) for
 * RED_FLAG_RUN_DAYS calendar-consecutive days. Mirrors the correlation
 * detector's fever path — per-day MAX is the worst (an evening spike must not
 * be masked by a daily mean) and the floor + run length are the shared
 * constants. Fires the SAME illness red-flag escalation the retrospective path
 * fires, so the notification class matches exactly.
 */
async function checkSustainedFever(
  userId: string,
  written: WrittenReading[],
  tz: string,
): Promise<void> {
  const fresh = written.find((r) => r.type === "BODY_TEMPERATURE");
  if (!fresh) return;

  const days = await loadDailyWorst(
    userId,
    "BODY_TEMPERATURE",
    fresh.measuredAt,
    tz,
    "max",
  );
  const flag = sustainedRunFlag(
    days,
    (v) => v >= FEVER_RED_FLAG_C,
    "sustained_fever",
    "BODY_TEMPERATURE",
    "max",
  );
  if (!flag) return;
  await notifyIllnessRedFlag({
    userId,
    episodeId: SUSTAINED_DEDUPE_KEY.sustained_fever,
    redFlags: [flag],
  });
}

/**
 * Sustained low SpO2: OXYGEN_SATURATION ≤ SPO2_RED_FLAG_PCT for
 * RED_FLAG_RUN_DAYS calendar-consecutive days. SpO2's worst is the per-day MIN,
 * matching the correlation detector. Fires the SAME illness red-flag escalation.
 */
async function checkSustainedLowSpo2(
  userId: string,
  written: WrittenReading[],
  tz: string,
): Promise<void> {
  const fresh = written.find((r) => r.type === "OXYGEN_SATURATION");
  if (!fresh) return;

  const days = await loadDailyWorst(
    userId,
    "OXYGEN_SATURATION",
    fresh.measuredAt,
    tz,
    "min",
  );
  const flag = sustainedRunFlag(
    days,
    (v) => v <= SPO2_RED_FLAG_PCT,
    "sustained_low_spo2",
    "OXYGEN_SATURATION",
    "min",
  );
  if (!flag) return;
  await notifyIllnessRedFlag({
    userId,
    episodeId: SUSTAINED_DEDUPE_KEY.sustained_low_spo2,
    redFlags: [flag],
  });
}

/**
 * Synthetic, stable per-reason dedupe anchors. The on-write sustained checks
 * may run with no active illness episode, so they cannot key the red-flag
 * dedupe ledger on a real episode id. These per-reason keys ride the SAME
 * `pushAttempt` ledger + 24h window `notifyIllnessRedFlag` already enforces, so
 * a stubbornly febrile user logging a 4th reading inside the day re-runs the
 * detector but never re-fires the alarm. Distinct keys per reason so a fever
 * escalation never suppresses a concurrent SpO2 one.
 */
const SUSTAINED_DEDUPE_KEY: Record<IllnessRedFlag["reason"], string> = {
  sustained_fever: "onwrite:sustained_fever",
  sustained_low_spo2: "onwrite:sustained_low_spo2",
};

/** A per-day worst value, keyed by the user-timezone calendar day. */
interface DailyWorst {
  day: string;
  worst: number;
}

/**
 * Read the recent same-type readings in the lookback window and collapse them
 * to one worst value per user-timezone calendar day (MAX for fever, MIN for
 * SpO2). Sorted chronologically so the run scan sees calendar order. Bounded
 * by the window and folded per day in SQL; the candidate's own freshly-written rows are
 * INCLUDED so a run that completes on this very write escalates.
 */
async function loadDailyWorst(
  userId: string,
  type: MeasurementType,
  candidateAt: Date,
  tz: string,
  worst: "min" | "max",
): Promise<DailyWorst[]> {
  const windowStart = new Date(
    candidateAt.getTime() - SUSTAINED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  // One row per local day, its extreme folded in Postgres: a wrist sensor
  // that samples SpO2 every minute of the night fills the lookback with more
  // rows than the 500 a capped read used to return, and the days the cap cut
  // off never entered the run.
  const days = await readDayAggregates({
    userId,
    type,
    since: windowStart,
    until: candidateAt,
    timeZone: tz,
  });

  return days
    .map((d) => ({ day: d.day, worst: worst === "min" ? d.min : d.max }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

/**
 * Longest CALENDAR-consecutive run matching `predicate`; returns an
 * {@link IllnessRedFlag} when the run reaches RED_FLAG_RUN_DAYS, else null.
 * Mirrors the correlation engine's `runFlag`: present-days-only points (never
 * zero-filled), so a sparse febrile series (days 01/10/15) must NOT count as
 * one long run — a point only extends the run when it is the calendar day
 * immediately after the previous matching one (`dayDiff === 1`).
 */
function sustainedRunFlag(
  sorted: DailyWorst[],
  predicate: (v: number) => boolean,
  reason: IllnessRedFlag["reason"],
  type: MeasurementType,
  worst: "min" | "max",
): IllnessRedFlag | null {
  let bestRun = 0;
  let bestWorst: number | null = null;
  let run = 0;
  let runWorst: number | null = null;
  let prevDay: string | null = null;
  for (const p of sorted) {
    if (predicate(p.worst)) {
      const adjacent = prevDay !== null && dayDiff(prevDay, p.day) === 1;
      if (adjacent) {
        run++;
        runWorst =
          runWorst === null
            ? p.worst
            : worst === "min"
              ? Math.min(runWorst, p.worst)
              : Math.max(runWorst, p.worst);
      } else {
        run = 1;
        runWorst = p.worst;
      }
      if (run > bestRun) {
        bestRun = run;
        bestWorst = runWorst;
      }
      prevDay = p.day;
    } else {
      run = 0;
      runWorst = null;
      prevDay = null;
    }
  }
  if (bestRun >= RED_FLAG_RUN_DAYS && bestWorst !== null) {
    return { type, reason, worstValue: bestWorst, days: bestRun };
  }
  return null;
}
