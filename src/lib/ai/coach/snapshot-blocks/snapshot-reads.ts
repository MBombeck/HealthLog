/**
 * The cold-path reads of the Coach snapshot builder.
 *
 * Every read here consumes only `userId`, the window cutoff, or the
 * synchronously-derived profile — none reads another's result — so they
 * are fired off concurrently and awaited in one hop. Each keeps its
 * `sources.has(…)` / gate guard, so a disabled source still issues no query
 * (the guard yields `null`, never a wasted round-trip). The builder in
 * `snapshot.ts` consumes the resolved values in its own fixed order, so
 * provenance and block-registration order do not depend on this module.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { MEDICATION_WINDOW_SELECT } from "@/lib/medications/course-window";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  COURSES_COMPLIANCE_SELECT,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import type { extractFeatures } from "@/lib/insights/features";
import type { BaselineProfile } from "@/lib/insights/derived";
import { toProfileSex } from "@/lib/profile/sex";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import {
  readSleepStageRows,
  readSnapshotMoodRows,
  type resolveSnapshotCutoffs,
  type resolveSnapshotPrelude,
} from "../snapshot-prelude";
import { buildGlp1SnapshotBlock } from "../glp1-snapshot";
import { buildDerivedSnapshotBlock } from "../derived-snapshot";
import { buildCorrelationsSnapshotBlock } from "../correlations-snapshot";
import { buildCoachMemoryBlock } from "../memory-snapshot";
import { buildTrajectorySnapshotBlock } from "../trajectory-snapshot";
import { buildCycleSnapshotBlock } from "../cycle-snapshot";
import { buildIllnessSnapshotBlock } from "../illness-snapshot";
import { buildLabsSnapshotBlock } from "../labs-snapshot";
import { buildVisitsSnapshotBlock } from "../visits-snapshot";
import { buildEnergyBalanceSnapshotBlock } from "../energy-balance-snapshot";
import {
  buildCoarseTimelineTail,
  type CoarseTimelineTail,
} from "../snapshot-series";
import {
  fitsReach,
  reachFloor,
  type CoachHistoryReach,
} from "../history-reach";
import type { CoachScopeSource } from "../types";
import { readCoachWorkoutRows } from "./workouts-read";
import { GLUCOSE_CLINICAL_WINDOW_DAYS } from "./glucose-block";
import { buildSeizuresSnapshotBlock } from "../seizures-snapshot";

type SnapshotPrelude = Awaited<ReturnType<typeof resolveSnapshotPrelude>>;
type SnapshotFeatures = Awaited<ReturnType<typeof extractFeatures>>;

/**
 * The sleep-rhythm read (sleep-debt + chronotype) is a fixed
 * trailing-window artifact, identical across the Sleep page, the dashboard
 * summary, and (here) the coach. Pinned independently of the coach's variable
 * narration window (7/30/90/365) so the coach's debt + chronotype band always
 * equal what the page renders. Mirrors `DEFAULT_WINDOW_DAYS` in
 * `sleep-rhythm.ts`: 42 days gives the 14-night debt window full coverage and
 * ~12 weekend nights for a stable MSF — the assembler self-caps each signal to
 * its own window, so feeding the same 42-day rows yields the page's DTO.
 */
const SLEEP_RHYTHM_WINDOW_DAYS = 42;

/**
 * Where the coarse MONTH tail begins: the in-window weekly fold covers the
 * first 90 days, the rollup tail what lies beyond. Under a lookback limit of
 * 90 days or less the tail has nothing it may add.
 */
const COARSE_TAIL_START_DAYS = 90;

interface CoarseTailsContext {
  userId: string;
  sources: ReadonlySet<CoachScopeSource>;
  now: Date;
  userTz: string;
  sourcePriorityJson:
    NonNullable<SnapshotPrelude["prefsRow"]>["sourcePriorityJson"] | null;
  reach: CoachHistoryReach;
}

/**
 * Coarse tail (90d–1y MONTH + >1y YEAR) + anomaly envelope for the core
 * clinical metrics, from the shared tiered-context builder. Only the bands
 * the in-window weekly-fold cannot produce are fetched here; the recent +
 * weekly bands stay as the core block builds them. Bounded per-band, so this
 * holds or reduces the per-metric token cost while letting the Coach see a
 * spike from months ago. Reads never throw — a coverage miss yields
 * `undefined`, the block is then omitted. Run in parallel.
 */
export async function readCoreCoarseTails(
  ctx: Readonly<CoarseTailsContext>,
): Promise<{
  bp: CoarseTimelineTail | undefined;
  weight: CoarseTimelineTail | undefined;
  pulse: CoarseTimelineTail | undefined;
}> {
  const { userId, sources, now, userTz, sourcePriorityJson, reach } = ctx;
  const coarseTailPromises: Partial<
    Record<"bp" | "weight" | "pulse", Promise<CoarseTimelineTail | undefined>>
  > = {};
  // The coarse tail starts where the in-window weekly fold ends (90 days), so
  // a limit of 90 days or less leaves nothing for it to add.
  const coarseTailAllowed =
    reach.days === null || reach.days > COARSE_TAIL_START_DAYS;
  const coarseFloor = reachFloor(reach, now);
  const tail = (type: MeasurementType) =>
    buildCoarseTimelineTail(
      userId,
      type,
      now,
      userTz,
      sourcePriorityJson,
      coarseFloor,
    );
  if (sources.has("bp") && coarseTailAllowed) {
    coarseTailPromises.bp = tail("BLOOD_PRESSURE_SYS" as MeasurementType);
  }
  if (sources.has("weight") && coarseTailAllowed) {
    coarseTailPromises.weight = tail("WEIGHT" as MeasurementType);
  }
  if (sources.has("pulse") && coarseTailAllowed) {
    coarseTailPromises.pulse = tail("PULSE" as MeasurementType);
  }
  const [bp, weight, pulse] = await Promise.all([
    coarseTailPromises.bp ?? Promise.resolve(undefined),
    coarseTailPromises.weight ?? Promise.resolve(undefined),
    coarseTailPromises.pulse ?? Promise.resolve(undefined),
  ]);
  return { bp, weight, pulse };
}

/**
 * The profile the GLP-1 / derived / trajectory / memory readers consume,
 * derived from `features.context`, and whether the recovery layer is on.
 */
export function resolveDerivedGate(
  features: SnapshotFeatures,
  sources: ReadonlySet<CoachScopeSource>,
  recoveryDisabled: boolean,
): { derivedProfile: BaselineProfile; derivedActive: boolean } {
  const derivedSources: CoachScopeSource[] = [
    "hrv",
    "resting_hr",
    "sleep",
    "vo2_max",
  ];
  const derivedCtx = features.context;
  const derivedProfile: BaselineProfile = {
    ageYears: derivedCtx?.ageYears ?? null,
    sex: toProfileSex(derivedCtx?.gender),
    heightCm: derivedCtx?.heightCm ?? null,
  };
  // The derived block + WHOOP-native dayStrain + trajectory are
  // the `recovery` module's domain (READINESS / RECOVERY_SCORE / STRAIN /
  // …). They are gated on `derivedActive`, which still reads the `sleep`
  // signal — so when `recovery` is disabled but `sleep` stays on, gate them
  // off explicitly here, not just by dropping the recovery source tokens.
  const derivedActive =
    !recoveryDisabled && derivedSources.some((s) => sources.has(s));
  return { derivedProfile, derivedActive };
}

export interface SnapshotReadsContext {
  userId: string;
  sources: ReadonlySet<CoachScopeSource>;
  features: SnapshotFeatures;
  cutoff: Date;
  additiveCutoff: ReturnType<typeof resolveSnapshotCutoffs>["additiveCutoff"];
  now: Date;
  userTz: string;
  coachLocale: SnapshotPrelude["coachLocale"];
  gender: NonNullable<SnapshotPrelude["prefsRow"]>["gender"] | undefined;
  reach: CoachHistoryReach;
  bounded: boolean;
  excludesMedications: boolean;
  derivedProfile: BaselineProfile;
  derivedActive: boolean;
}

/** The compliance ledger read: each medication's schedules, eras and events. */
function readComplianceMedications(userId: string, cutoff: Date) {
  return prisma.medication.findMany({
    // As-needed (PRN) medications never reach the Coach
    // compliance context (no expected doses, no rate).
    where: { userId, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    select: {
      id: true,
      ...MEDICATION_WINDOW_SELECT,
      oneShot: true,
      createdAt: true,
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      scheduleRevisions: {
        orderBy: [{ validFrom: "asc" }, { id: "asc" }],
        select: {
          id: true,
          validFrom: true,
          validUntil: true,
          payload: true,
          supersededByRevisionId: true,
        },
      },
      // Pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // The courses (#1024), so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
      intakeEvents: {
        // Tombstoned intake rows must never reach the Coach snapshot.
        where: { deletedAt: null, scheduledFor: { gte: cutoff } },
        orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
        select: {
          scheduledFor: true,
          takenAt: true,
          skipped: true,
          autoMissed: true,
          attributionSource: true,
        },
      },
    },
  });
}

/** The per-source table reads: mood, compliance, sleep, workouts, glucose. */
function startSourceReads(ctx: Readonly<SnapshotReadsContext>) {
  const { userId, sources, features, cutoff, additiveCutoff, now, reach } = ctx;
  const moodRowsPromise =
    sources.has("mood") && features.mood
      ? readSnapshotMoodRows(userId, cutoff)
      : null;
  // The adherence timeline derives from the LEDGER tally (the
  // same band engine the compliance % + dose history consume), not from a
  // raw intake-row count. The raw count read a worker-minted pending row
  // as "not taken" (today's later doses dragged the day's rate down all
  // morning) and double-counted cross-source duplicate rows on one slot.
  // Load each medication's schedules + eras + window events so the ledger
  // can be reconstructed per medication.
  const complianceMedsPromise = sources.has("compliance")
    ? readComplianceMedications(userId, cutoff)
    : null;
  const sleepRowsPromise = sources.has("sleep")
    ? readSleepStageRows(userId, additiveCutoff("sleep"))
    : null;
  // Sleep-rhythm rows. The sleep-debt + chronotype DTO is a fixed
  // trailing-42-day artifact (the Sleep page + dashboard read the same window),
  // so it must NOT ride the coach's variable narration window or the
  // multi-cluster timeline cap, or the coach would quote a debt / chronotype
  // band the page never shows. Read the rhythm's own trailing-42-day rows
  // directly (one indexed query, only when the sleep cluster is active) and
  // hand them to the SAME assembler the dashboard route uses. The per-stage
  // narration timeline keeps using the coach-window `sleepRows`.
  const sleepRhythmCutoff = new Date(
    now.getTime() - SLEEP_RHYTHM_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  // source + deviceType feed the canonical writer-dedup so a multi-source
  // night is counted ONCE, matching every other sleep surface. A limit
  // shorter than the rhythm's fixed 42 days leaves the block out: a debt or
  // chronotype band over fewer nights is not the one the page shows.
  const sleepRhythmRowsPromise =
    sources.has("sleep") && fitsReach(SLEEP_RHYTHM_WINDOW_DAYS, reach)
      ? readSleepStageRows(userId, sleepRhythmCutoff)
      : null;
  const workoutRowsPromise = sources.has("workouts")
    ? readCoachWorkoutRows(userId, additiveCutoff("workouts"))
    : null;
  // The glucose CLINICAL panel is a fixed 30-day clinical artifact,
  // identical to the one the insights panel + doctor report render. It must NOT
  // ride the coach's variable narration window (7/30/90/365) or the
  // multi-cluster timeline cap, or the coach would quote a TIR/GMI/CV% the panel
  // never shows. So read the panel's own trailing-30-day glucose rows directly
  // (one indexed query, only when glucose is active) and compute the clinical
  // block off THOSE rows. The per-context narration timelines keep using the
  // coach-window rows — only the clinical summary is pinned to 30 days.
  const glucoseClinicalCutoff = new Date(
    now.getTime() - GLUCOSE_CLINICAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );
  // Same rule for the fixed 30-day clinical panel: under a shorter limit the
  // panel is left out (null rows), never computed over fewer days.
  const glucoseClinicalRowsPromise =
    sources.has("glucose") && fitsReach(GLUCOSE_CLINICAL_WINDOW_DAYS, reach)
      ? prisma.measurement.findMany({
          where: {
            userId,
            type: "BLOOD_GLUCOSE" as never,
            measuredAt: { gte: glucoseClinicalCutoff },
            deletedAt: null,
          },
          orderBy: { measuredAt: "asc" },
          select: { value: true, measuredAt: true },
        })
      : null;
  return {
    moodRowsPromise,
    complianceMedsPromise,
    sleepRowsPromise,
    sleepRhythmRowsPromise,
    workoutRowsPromise,
    glucoseClinicalRowsPromise,
  };
}

/** The helper-block reads: recovery layer, memory, cycle, illness, labs, visits. */
async function startContextReads(ctx: Readonly<SnapshotReadsContext>) {
  const { userId, now, userTz, reach, derivedProfile, derivedActive } = ctx;
  const glp1BlockPromise = ctx.excludesMedications
    ? null
    : buildGlp1SnapshotBlock(userId, now, userTz, reach);
  const derivedBlockPromise = derivedActive
    ? buildDerivedSnapshotBlock(userId, derivedProfile, now, userTz, reach)
    : null;
  // WHOOP-native day strain (0–21), distinct from the COMPUTED
  // STRAIN_SCORE (0–100) the derived block carries. Gated on the same
  // wellness/activity signals so it rides the existing parallel batch; the
  // block is omitted when the account has no DAY_STRAIN rows (every
  // non-WHOOP account). Native-over-computed mirrors how recovery resolves.
  const dayStrainRowsPromise = derivedActive
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "DAY_STRAIN",
          measuredAt: { gte: ctx.cutoff },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { value: true, measuredAt: true },
      })
    : null;
  const trajectoryBlockPromise = derivedActive
    ? buildTrajectorySnapshotBlock(userId, derivedProfile, now, reach)
    : null;
  // Discovered cross-metric driver pairs for the no-tools
  // snapshot floor. Reuses the SAME gated/ranked output the get_correlations
  // tool serves (effect-size floor + family-tautology exclusion + shrinkage +
  // confidence tiering already applied inside the discovery engine), so a
  // local/no-tools provider reaches parity on the flagship cross-metric layer
  // instead of getting only the coincident flag. Gated on `derivedActive` (it
  // is the recovery / cross-metric layer) and fail-soft to null.
  const correlationsBlockPromise = derivedActive
    ? buildCorrelationsSnapshotBlock(userId, ctx.coachLocale, reach)
    : null;
  const memoryBlockPromise = buildCoachMemoryBlock(
    userId,
    derivedProfile,
    now,
    ctx.coachLocale,
    reach,
  );
  // Cycle/phase block, gated on the resolved cycle module so a
  // non-cycle account issues no query (the helper short-circuits to null
  // before any read for a disabled account). The block is descriptive only —
  // current phase + day-of-cycle, the next predicted event (period range,
  // fertile window goal-gated), and the headline phase-correlation finding.
  // The gate is the FULLY-resolved cycle module
  // (`isCycleAvailableForUser` → the per-user toggle AND the operator
  // server-wide kill-switch), so an operator-off instance never injects the
  // cycle block into the coach prompt.
  const cycleEnabled = await isCycleAvailableForUser(userId);
  // The cycle block predicts from every logged cycle, of any age, so that its
  // "day N, period in M days" matches the calendar. Any lookback limit leaves
  // it out rather than predicting from a part of the history.
  const cycleBlockPromise =
    cycleEnabled && !ctx.bounded
      ? buildCycleSnapshotBlock(userId, ctx.gender, now, userTz)
      : null;

  // Illness/condition context. Always attempted (the helper is
  // module-gated internally and short-circuits to null for a non-illness
  // account). It is CONTEXT, not a scope-gated metric: appended like
  // anthropometrics/scope without a `registerBlock` so the budget
  // degrader never sheds it — the Coach needs to know about Rest Mode.
  const illnessBlockPromise = buildIllnessSnapshotBlock(userId, now, reach);

  // Lab-result context (#65). Like illness it is CONTEXT, not a
  // scope-gated metric: attached without a `registerBlock` so the budget
  // degrader never sheds it. Module-gated inside: with Labs off it reads
  // nothing. It carries the latest reading per biomarker (whole record or the
  // lookback limit, capped) so the Coach can answer "what was my LDL".
  const labsBlockPromise = buildLabsSnapshotBlock(userId, now, reach);

  // The seizure diary: counts, clusters and dates, module-gated inside. Like
  // illness it is context and not shed: a carer asking about seizures must
  // not get "no data" because a series ran long.
  const seizuresBlockPromise = buildSeizuresSnapshotBlock(userId, userTz, now, {
    reach,
    excludesMedications: ctx.excludesMedications,
  });

  // Doctor-visit context. Like illness/labs it is attempted always (a
  // visit is core, never module-gated) and short-circuits to null when there is
  // neither an upcoming appointment inside the 14-day horizon nor a past visit.
  // UNLIKE illness/labs it IS registered for degradation (against the
  // lowest-priority cluster), because a visit history is low-frequency context
  // the Coach can lose under budget pressure without losing a safety flag.
  const visitsBlockPromise = buildVisitsSnapshotBlock(userId, now, reach);
  // The energy-balance line: nutrients-module gated inside, and left out when
  // the person keeps active energy away from the Coach.
  const energyBalanceBlockPromise = ctx.sources.has("active_energy")
    ? buildEnergyBalanceSnapshotBlock(userId, userTz, reach)
    : null;
  return {
    glp1BlockPromise,
    derivedBlockPromise,
    dayStrainRowsPromise,
    trajectoryBlockPromise,
    correlationsBlockPromise,
    memoryBlockPromise,
    cycleBlockPromise,
    illnessBlockPromise,
    labsBlockPromise,
    seizuresBlockPromise,
    visitsBlockPromise,
    energyBalanceBlockPromise,
  };
}

/** Fire every cold-path read concurrently and resolve them in one hop. */
export async function readSnapshotBlockInputs(
  ctx: Readonly<SnapshotReadsContext>,
) {
  const s = startSourceReads(ctx);
  const c = await startContextReads(ctx);
  const [
    moodRows,
    complianceMeds,
    sleepRows,
    sleepRhythmRows,
    workoutRows,
    glucoseClinicalRows,
    glp1Block,
    derivedBlock,
    dayStrainRows,
    trajectoryBlock,
    correlationsBlock,
    memoryBlock,
    cycleBlock,
    illnessBlock,
    labsBlock,
    seizuresBlock,
    visitsBlock,
    energyBalanceBlock,
  ] = await Promise.all([
    s.moodRowsPromise,
    s.complianceMedsPromise,
    s.sleepRowsPromise,
    s.sleepRhythmRowsPromise,
    s.workoutRowsPromise,
    s.glucoseClinicalRowsPromise,
    c.glp1BlockPromise,
    c.derivedBlockPromise,
    c.dayStrainRowsPromise,
    c.trajectoryBlockPromise,
    c.correlationsBlockPromise,
    c.memoryBlockPromise,
    c.cycleBlockPromise,
    c.illnessBlockPromise,
    c.labsBlockPromise,
    c.seizuresBlockPromise,
    c.visitsBlockPromise,
    c.energyBalanceBlockPromise,
  ]);
  return {
    moodRows,
    complianceMeds,
    sleepRows,
    sleepRhythmRows,
    workoutRows,
    glucoseClinicalRows,
    glp1Block,
    derivedBlock,
    dayStrainRows,
    trajectoryBlock,
    correlationsBlock,
    memoryBlock,
    cycleBlock,
    illnessBlock,
    labsBlock,
    seizuresBlock,
    visitsBlock,
    energyBalanceBlock,
  };
}
