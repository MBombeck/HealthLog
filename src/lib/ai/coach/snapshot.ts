/**
 * Snapshot builder for the Coach prompt.
 *
 * Reuses the analytics features pipeline so the Coach narrates the
 * exact same numbers the dashboard tiles render — single source of
 * truth for every "your avg30 BP is …" claim. The output is a compact
 * JSON block the system + user prompt frame as the SNAPSHOT for the
 * model to ground its reply in.
 *
 * v1.4.20.1 — extended with a day-level `timeline` block. The earlier
 * shipping shape carried only aggregated statistics (mean, slope, SD,
 * range, count) per metric, so a Coach turn could not answer questions
 * keyed to a specific day or weekday ("why was BP higher last
 * Monday?"). The timeline now ships the last 14 days as raw daily
 * values with weekday labels and aggregates the older window into
 * weekly buckets so the prompt budget stays tight.
 */
import { prisma } from "@/lib/db";
import { extractFeatures } from "@/lib/insights/features";
import type { CoachDataCluster } from "@/lib/validations/coach-prefs";
import type { UnitPreferences } from "@/lib/measurements/display-transform";
import type { SleepStageRow } from "@/lib/analytics/sleep-night";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { annotate } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";
import {
  DAILY_TIMELINE_DAYS,
  MAX_SNAPSHOT_CHARS,
  readSleepStageRows,
  readSnapshotMeasurementRows,
  readSnapshotMoodRows,
  resolveSnapshotCutoffs,
  resolveSnapshotPrelude,
} from "./snapshot-prelude";
import { annotateSnapshotFreshness } from "./snapshot-freshness";
import { condenseSeriesBlock } from "./series-condense";
import { buildGlp1SnapshotBlock } from "./glp1-snapshot";
import { buildDerivedSnapshotBlock } from "./derived-snapshot";
import { buildCorrelationsSnapshotBlock } from "./correlations-snapshot";
import { buildCoachMemoryBlock } from "./memory-snapshot";
import { buildExperimentOutcomeBlock } from "./plans";
import { experimentVerdictEnabled } from "./experiment-flag";
import { buildAdherenceStoryline } from "@/lib/insights/derived/adherence-storyline";
import { buildChangepointSignals } from "@/lib/insights/derived/changepoint";
import { buildSignalTrust } from "@/lib/insights/derived/signal-trust";
import { buildTrajectorySnapshotBlock } from "./trajectory-snapshot";
import { buildCycleSnapshotBlock } from "./cycle-snapshot";
import { buildIllnessSnapshotBlock } from "./illness-snapshot";
import { buildLabsSnapshotBlock } from "./labs-snapshot";
import { buildVisitsSnapshotBlock } from "./visits-snapshot";
import {
  buildReferenceGroundingBlock,
  type GroundingMetricInput,
} from "./reference-grounding";
import type { MeasurementType } from "@/generated/prisma/client";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import {
  COURSES_COMPLIANCE_SELECT,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import type { BaselineProfile } from "@/lib/insights/derived";
import { toProfileSex } from "@/lib/profile/sex";
import { CLUSTER_PRIORITY, sourceCluster } from "./clusters";
import type { CoachProvenance, CoachScope, CoachScopeSource } from "./types";
import {
  readSnapshotCache,
  snapshotCacheKey,
  writeSnapshotCache,
} from "./snapshot-cache";
import {
  buildCoarseTimelineTail,
  type CoarseTimelineTail,
} from "./snapshot-series";
import { buildWorkoutsBlock } from "./snapshot-blocks/workouts-block";
import {
  buildGlucoseBlock,
  GLUCOSE_CLINICAL_WINDOW_DAYS,
} from "./snapshot-blocks/glucose-block";
import {
  buildSleepRhythmBlock,
  buildSleepTimelineBlock,
} from "./snapshot-blocks/sleep-block";
import { buildComplianceBlock } from "./snapshot-blocks/compliance-block";
import { buildCoreMetricsBlocks } from "./snapshot-blocks/core-metrics-block";
import { buildValueSeriesBlocks } from "./snapshot-blocks/value-series-blocks";
import {
  buildDayStrainBlock,
  buildProfileContextBlocks,
} from "./snapshot-blocks/context-blocks";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import {
  UNBOUNDED_REACH,
  fitsReach,
  isBounded,
  reachFloor,
  type CoachHistoryReach,
} from "./history-reach";
import { ADHERENCE_STORYLINE_HORIZON_DAYS } from "@/lib/insights/derived/adherence-storyline";
import { CHANGEPOINT_WINDOW_DAYS } from "@/lib/insights/derived/changepoint";
import { SIGNAL_TRUST_WINDOW_DAYS } from "@/lib/insights/derived/signal-trust";

// Test-only escape hatch — the suites import it from this module.
export { __resetCoachSnapshotCacheForTests } from "./snapshot-cache";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * v1.20.0 (F1) — the structured, post-degrade snapshot record `snapshotJson`
   * is serialised from. Keyed by domain block (`bloodPressure`, `weight`,
   * `pulse`, `mood`, `compliance`, `glucose`, `sleep`, `sleepRhythm`, `labs`,
   * `illness`, `derived`, `dayStrain`, `trajectory`, `weeklyContext`, …) plus a
   * `scope` block. The coach tool executor reads a single domain block out of
   * this so an on-demand retrieval tool returns exactly the numbers the legacy
   * snapshot-stuffing path would have shown — identical builder, gates, and I/O.
   */
  sections: Record<string, unknown>;
  /**
   * Provenance built from snapshot keys actually present. Stays in
   * sync with the SNAPSHOT block so the source-chip row mirrors what
   * the model could see.
   */
  provenance: CoachProvenance;
  /**
   * v1.18.6 (W7) — citation-aware reference-range grounding for the
   * metrics present in this snapshot, or null when none is covered by the
   * reference backbone. The Coach route appends it verbatim after the
   * SNAPSHOT so the model reads published population bands + the user's
   * placement (general guidance, never a diagnosis). Built deterministically
   * from `src/lib/reference-ranges.ts`; carries no commercial brand name.
   */
  referenceGrounding: string | null;
  /**
   * The reader's unit choices the snapshot was written in. A tool that reads
   * beyond the snapshot (the metric table) states its figures in the same
   * units, so a reply never mixes the two.
   */
  units: UnitPreferences;
  /**
   * The blocks the prompt-budget pass cut or condensed, absent when it cut
   * nothing. A tool reading one block out of a shared build checks this: a
   * block cut for somebody else's prompt is no answer to its own read.
   */
  degradedBlocks?: ReadonlyArray<string>;
}

/**
 * v1.17.0 — the sleep-rhythm read (sleep-debt + chronotype) is a fixed
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

/**
 * Build the Coach prompt snapshot for `userId`. Always uses
 * `includeRaw=false` because the Coach replies are conversational and
 * the user is asking the model — they should never depend on raw
 * measurement timestamps that the privacy mode controls.
 *
 * The snapshot now carries two sections per active metric:
 *   - aggregate: the v1.4.20 shape (mean, slope, SD, range, count)
 *   - timeline.recent: last `DAILY_TIMELINE_DAYS` days as raw daily
 *     values with weekday labels so the Coach can answer
 *     day/weekday-specific questions
 *   - timeline.weekly: ISO-week buckets covering the rest of the
 *     window so the Coach can still cite older weeks without ballooning
 *     the prompt
 *
 * v1.4.25 W7b — every day-key + weekday label is now anchored to the
 * user's display timezone (read from `User.timezone`). Falls back to
 * Europe/Berlin when the column is missing so the legacy snapshot
 * stays byte-identical for the only path the v1.4.24 suite tested.
 *
 * v1.4.33 — wraps the previous `buildCoachSnapshotImpl` with a 60s
 * in-memory LRU keyed on `(userId, window, sources)`. The Coach's
 * chat handler calls this once per turn; within the same conversation
 * the second+ turn lands a cache hit and skips the row-level reads.
 */
export async function buildCoachSnapshot(
  userId: string,
  scope?: CoachScope,
  options?: {
    /**
     * How far back the build may read (`history-reach.ts`). Every Coach
     * caller passes the person's limit; MCP passes none and reads without
     * one, as it always did.
     */
    reach?: CoachHistoryReach;
    /**
     * A Coach tool reading one source: condense that source's blocks to the
     * prompt budget instead of shedding them (`series-condense.ts`). Every
     * other caller, MCP among them, keeps the plain budget pass, so its
     * output is what it always was.
     */
    condenseRequested?: boolean;
  },
): Promise<CoachSnapshotResult> {
  const reach = options?.reach ?? UNBOUNDED_REACH;
  const condenseRequested = options?.condenseRequested === true;
  const key = `${snapshotCacheKey(userId, scope, reach)}${condenseRequested ? "|condense" : ""}`;
  const cached = readSnapshotCache(key);
  if (cached) return cached;
  const result = await buildCoachSnapshotImpl(
    userId,
    scope,
    reach,
    condenseRequested,
  );
  writeSnapshotCache(key, result);
  return result;
}

/**
 * A cross-cutting narration block that throws must not vanish silently. Each of
 * these builders is additive — the snapshot is still valid without it — so the
 * catch stays, but the failure is now countable: `signalTrust` is the block that
 * tells the model HOW MUCH to trust the numbers it is about to narrate, and a
 * builder that fails to `null` is indistinguishable from a user who simply has
 * no trust caveats. Absence and failure are different things and the wide event
 * now says which one happened.
 */
function blockFailed(block: string): (err: unknown) => null {
  return (err: unknown) => {
    // Resolved before the annotate call, not inline: the free-text guard in
    // `snapshot.test.ts` reads three lines around a `name:` key and an inline
    // `err.name` there looks like an un-sanitised user string to it.
    const reason = err instanceof Error ? err.name : "unknown";
    annotate({
      action: { name: "coach.snapshot.block_failed" },
      meta: { block, reason },
    });
    return null;
  };
}

async function buildCoachSnapshotImpl(
  userId: string,
  scope: CoachScope | undefined,
  reach: CoachHistoryReach,
  condenseRequested: boolean,
): Promise<CoachSnapshotResult> {
  // Prefs, module gates and the admitted sources — see `snapshot-prelude.ts`.
  // The lookback limit caps the narration window there, whatever the caller
  // asked for; every fixed-window block below answers to the same limit.
  const {
    prefsRow,
    coachLocale,
    window,
    userTz,
    units,
    recoveryDisabled,
    excluded,
    sources,
  } = await resolveSnapshotPrelude(userId, scope, reach);
  const bounded = isBounded(reach);
  const glucoseUnit = units.glucoseUnit;
  // v1.4.36 W3 T2 — `medications` and `anthropometrics` are
  // exclude-only toggles (not in `CoachScopeSource`); they gate the
  // GLP-1 weeklyContext / compliance branch and the anthropometrics
  // block respectively.
  const excludesMedications = excluded.has("medications");
  const excludesAnthropometrics = excluded.has("anthropometrics");

  // Pull raw measurement rows once for the configured window so day
  // and week buckets share a single I/O hop. Mood + compliance live in
  // separate tables and are loaded conditionally below.
  const now = new Date();
  const {
    windowDays,
    cutoff,
    recentCutoff,
    activeClusters,
    multiClusterCapActive,
    additiveCutoff,
  } = resolveSnapshotCutoffs(sources, window, now);
  // v1.11.3 — kick the feature extraction off as a promise now and await
  // it alongside the shared measurement read below. `extractFeatures`
  // and the measurement `findMany` are independent (each only needs
  // `userId` + the resolved window/sources), so running them
  // concurrently shaves a round-trip off the cold path. No block reads
  // `features` before the shared await, so the deferral is safe.
  // v1.20.0 (H-1) — `extractFeatures` is the heaviest read on the cold path
  // (user findUnique + a windowed measurement findMany + the all-time extremes).
  // The F1 tools rebuild distinct-scope snapshots whose LRU keys differ, so they
  // do not share this read; memoise it per-request keyed on the only varying
  // input (windowDays) so the fan-out runs it once instead of up to 6× against
  // the shared pool.
  // Under a lookback limit the aggregate's "all time" figures, the mood
  // history and its sub-blocks are read from inside the limit only.
  const featuresFloor = reachFloor(reach);
  const featuresPromise = memoizePerRequest(
    `coach-features:${userId}:${windowDays}:${reach.days ?? "all"}`,
    () =>
      extractFeatures(userId, false, {
        sinceDays: windowDays,
        ...(featuresFloor ? { historyFloor: featuresFloor } : {}),
      }),
  );

  // Trim down to the metrics the Coach narrates. extractFeatures
  // returns more (sleep, steps, etc.) — the Coach surface keeps the
  // snapshot tight so each turn fits inside the provider's context
  // budget for free-tier accounts.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  // v1.4.27 B7 / BL-P6-4 — seed the provenance window set with the
  // user's resolved scope so the year-in-review window surfaces in the
  // provenance envelope even when the per-metric branches below only
  // emit `last30days` / `last90days` chips. Older windows are added
  // by the metric branches as before.
  if (window === "lastYear" || window === "allTime") {
    windows.add(window);
  }
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};

  // v1.18.6 (W7) — representative scalar per reference-covered metric, in the
  // metric's reference unit, collected as the blocks below build. Feeds the
  // citation-aware grounding block (population band + the user's placement).
  // Each entry reads the SAME number the snapshot already surfaces — no
  // independent recompute — so the grounding can never cite a value the
  // snapshot doesn't carry. A metric with a block but no clean scalar is left
  // unset (the grounding line still cites its band with an insufficient
  // placement only if it is added with a null value; we omit such metrics).
  const groundingValues = new Map<ReferenceMetric, number>();

  // v1.7.0 — block registry. Maps each emitted snapshot top-level key
  // to the cluster it belongs to so the soft-cap degradation pass
  // (below) can walk blocks in reverse cluster-priority order and shed
  // the lowest-signal detail first. Core legacy blocks register too so
  // the degrader can reach them as a last resort.
  const blockClusters = new Map<string, CoachDataCluster>();
  // Snapshot top-level keys that carry an `aggregate` companion — the
  // degrader can drop `timeline.recent` from these and still leave the
  // aggregate for the Coach to reason from.
  // The source each block was built for, so a single-source read can tell
  // which blocks it asked for (see `degradeToBudget`).
  const blockSources = new Map<string, CoachScopeSource>();
  const registerBlock = (key: string, source: CoachScopeSource) => {
    const cluster = sourceCluster(source);
    if (cluster) blockClusters.set(key, cluster);
    blockSources.set(key, source);
  };

  // v1.7.0 — record which clusters resolved active for this build so
  // the observability dashboards can track cluster adoption + the
  // multi-cluster cap firing rate.
  annotate({
    action: { name: "coach.clusters.resolved" },
    meta: {
      active: Array.from(activeClusters).sort(),
      window,
      multiClusterCap: multiClusterCapActive,
    },
  });

  const wantsBp = sources.has("bp");
  const wantsWeight = sources.has("weight");
  const wantsPulse = sources.has("pulse");
  const wantsMood = sources.has("mood");
  const wantsCompliance = sources.has("compliance");

  // v1.18.7 — coarse tail (90d–1y MONTH + >1y YEAR) + anomaly envelope for the
  // core clinical metrics, from the shared tiered-context builder. Only the
  // bands the in-window weekly-fold cannot produce are fetched here; the recent
  // + weekly bands stay as built below. Bounded per-band, so this holds or
  // reduces the per-metric token cost while letting the Coach see a spike from
  // months ago. Reads never throw — a coverage miss yields `undefined`, the
  // block is then omitted. Run in parallel; awaited at the block site.
  const coarseTailPromises: Partial<
    Record<"bp" | "weight" | "pulse", Promise<CoarseTimelineTail | undefined>>
  > = {};
  // The coarse tail starts where the in-window weekly fold ends (90 days), so
  // a limit of 90 days or less leaves nothing for it to add.
  const coarseTailAllowed =
    reach.days === null || reach.days > COARSE_TAIL_START_DAYS;
  const coarseFloor = reachFloor(reach, now);
  if (wantsBp && coarseTailAllowed) {
    coarseTailPromises.bp = buildCoarseTimelineTail(
      userId,
      "BLOOD_PRESSURE_SYS" as MeasurementType,
      now,
      userTz,
      prefsRow?.sourcePriorityJson ?? null,
      coarseFloor,
    );
  }
  if (wantsWeight && coarseTailAllowed) {
    coarseTailPromises.weight = buildCoarseTimelineTail(
      userId,
      "WEIGHT" as MeasurementType,
      now,
      userTz,
      prefsRow?.sourcePriorityJson ?? null,
      coarseFloor,
    );
  }
  if (wantsPulse && coarseTailAllowed) {
    coarseTailPromises.pulse = buildCoarseTimelineTail(
      userId,
      "PULSE" as MeasurementType,
      now,
      userTz,
      prefsRow?.sourcePriorityJson ?? null,
      coarseFloor,
    );
  }
  const [bpCoarseTail, weightCoarseTail, pulseCoarseTail] = await Promise.all([
    coarseTailPromises.bp ?? Promise.resolve(undefined),
    coarseTailPromises.weight ?? Promise.resolve(undefined),
    coarseTailPromises.pulse ?? Promise.resolve(undefined),
  ]);

  // Single fetch for all measurement types — Prisma's filter pushes
  // the type list into one SQL `WHERE type IN (…)` so we don't pay
  // per-metric round-trips. The CoachScopeSource → MeasurementType[] table
  // lives in `source-measurement-types.ts` (v1.4.23 W6 / S-04 kept it a single
  // source of truth; it is hoisted out of this function so the availability
  // probe that answers "does this domain exist OUTSIDE the window?" resolves
  // its types from the same table this windowed read filters on).
  const wantedTypes = Array.from(sources).flatMap(
    (source) => COACH_SOURCE_MEASUREMENT_TYPES[source] ?? [],
  );

  const measurementRowsPromise = readSnapshotMeasurementRows(
    userId,
    wantedTypes,
    cutoff,
  );

  // v1.11.3 — `extractFeatures` and the shared measurement read are
  // mutually independent and both gate the blocks below (every aggregate
  // reads `features`; bp/weight/pulse/glucose read `measurementRows`), so
  // run the two concurrently and resolve them in a single hop.
  const [features, measurementRows] = await Promise.all([
    featuresPromise,
    measurementRowsPromise,
  ]);

  // v1.11.3 — the remaining cold-path reads are mutually independent:
  // the four conditional table reads (mood / compliance / sleep /
  // workouts) and the four helper-block reads (GLP-1 / derived /
  // trajectory / memory) each consume only `userId`, the window cutoff,
  // or the synchronously-derived `derivedProfile` — none reads another's
  // result. Fire them all off concurrently now, KEEPING the original
  // `wants…` / `sources.has(…)` guards so a disabled source still issues
  // no query (the guard yields `null`/`undefined`, never a wasted
  // round-trip), then await the batch in one hop. The synchronous block
  // assembly further below consumes the resolved values in the original
  // order, so provenance and block-registration order are unchanged.
  //
  // `derivedProfile` is derived from `features.context` (now resolved)
  // and feeds the GLP-1 / derived / trajectory / memory readers; it is
  // hoisted here so those reads can start immediately.
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
  // v1.18.0 — the derived block + WHOOP-native dayStrain + trajectory are
  // the `recovery` module's domain (READINESS / RECOVERY_SCORE / STRAIN /
  // …). They are gated on `derivedActive`, which still reads the `sleep`
  // signal — so when `recovery` is disabled but `sleep` stays on, gate them
  // off explicitly here, not just by dropping the recovery source tokens.
  const derivedActive =
    !recoveryDisabled && derivedSources.some((s) => sources.has(s));

  const moodRowsPromise =
    wantsMood && features.mood ? readSnapshotMoodRows(userId, cutoff) : null;
  // v1.16.9 — the adherence timeline derives from the LEDGER tally (the
  // same band engine the compliance % + dose history consume), not from a
  // raw intake-row count. The raw count read a worker-minted pending row
  // as "not taken" (today's later doses dragged the day's rate down all
  // morning) and double-counted cross-source duplicate rows on one slot.
  // Load each medication's schedules + eras + window events so the ledger
  // can be reconstructed per medication.
  const complianceMedsPromise = wantsCompliance
    ? prisma.medication.findMany({
        // v1.16.11 — as-needed (PRN) medications never reach the Coach
        // compliance context (no expected doses, no rate).
        where: { userId, asNeeded: false, ...TRACKED_INTAKE_WHERE },
        select: {
          id: true,
          startsOn: true,
          endsOn: true,
          oneShot: true,
          createdAt: true,
          schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
          scheduleRevisions: {
            orderBy: { validFrom: "asc" },
            select: {
              id: true,
              validFrom: true,
              validUntil: true,
              payload: true,
              supersededByRevisionId: true,
            },
          },
          // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
          pauseEras: { select: { pausedAt: true, resumedAt: true } },
          // v1.40 (#1024) — the courses, so a gap between two expects nothing.
          courses: COURSES_COMPLIANCE_SELECT,
          intakeEvents: {
            // Tombstoned intake rows must never reach the Coach snapshot.
            where: { deletedAt: null, scheduledFor: { gte: cutoff } },
            orderBy: { scheduledFor: "asc" },
            select: {
              scheduledFor: true,
              takenAt: true,
              skipped: true,
              autoMissed: true,
              attributionSource: true,
            },
          },
        },
      })
    : null;
  const sleepRowsPromise = sources.has("sleep")
    ? readSleepStageRows(userId, additiveCutoff("sleep"))
    : null;
  // v1.17.0 — sleep-rhythm rows. The sleep-debt + chronotype DTO is a fixed
  // trailing-42-day artifact (the Sleep page + dashboard read the same window),
  // so it must NOT ride the coach's variable narration window or the
  // multi-cluster timeline cap, or the coach would quote a debt / chronotype
  // band the page never shows. Read the rhythm's own trailing-42-day rows
  // directly (one indexed query, only when the sleep cluster is active) and
  // hand them to the SAME assembler the dashboard route uses. The per-stage
  // narration timeline above keeps using the coach-window `sleepRows`.
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
    ? prisma.workout.findMany({
        where: { userId, startedAt: { gte: additiveCutoff("workouts") } },
        orderBy: { startedAt: "desc" },
        select: {
          sportType: true,
          startedAt: true,
          durationSec: true,
          totalEnergyKcal: true,
          totalDistanceM: true,
          avgHeartRate: true,
          maxHeartRate: true,
          // v1.30.4 (C1) — needed by `pickCanonicalWorkoutRows` in the block
          // builder to collapse a dual-source session (e.g. Apple Watch +
          // WHOOP recording the same run) to one, matching `GET /api/workouts`.
          source: true,
        },
      })
    : null;
  // v1.17.0 — the glucose CLINICAL panel is a fixed 30-day clinical artifact,
  // identical to the one the insights panel + doctor report render. It must NOT
  // ride the coach's variable narration window (7/30/90/365) or the
  // multi-cluster timeline cap, or the coach would quote a TIR/GMI/CV% the panel
  // never shows. So read the panel's own trailing-30-day glucose rows directly
  // (one indexed query, only when glucose is active) and compute the clinical
  // block off THOSE rows. The per-context narration timelines below keep using
  // the coach-window rows — only the clinical summary is pinned to 30 days.
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
  const glp1BlockPromise = excludesMedications
    ? null
    : buildGlp1SnapshotBlock(userId, now, userTz, reach);
  const derivedBlockPromise = derivedActive
    ? buildDerivedSnapshotBlock(userId, derivedProfile, now, userTz, reach)
    : null;
  // v1.17.0 — WHOOP-native day strain (0–21), distinct from the COMPUTED
  // STRAIN_SCORE (0–100) the derived block carries. Gated on the same
  // wellness/activity signals so it rides the existing parallel batch; the
  // block is omitted when the account has no DAY_STRAIN rows (every
  // non-WHOOP account). Native-over-computed mirrors how recovery resolves.
  const dayStrainRowsPromise = derivedActive
    ? prisma.measurement.findMany({
        where: {
          userId,
          type: "DAY_STRAIN",
          measuredAt: { gte: cutoff },
          deletedAt: null,
        },
        orderBy: { measuredAt: "asc" },
        select: { value: true, measuredAt: true },
      })
    : null;
  const trajectoryBlockPromise = derivedActive
    ? buildTrajectorySnapshotBlock(userId, derivedProfile, now, reach)
    : null;
  // RECON1 (D5-5) — discovered cross-metric driver pairs for the no-tools
  // snapshot floor. Reuses the SAME gated/ranked output the get_correlations
  // tool serves (effect-size floor + family-tautology exclusion + shrinkage +
  // confidence tiering already applied inside the discovery engine), so a
  // local/no-tools provider reaches parity on the flagship cross-metric layer
  // instead of getting only the coincident flag. Gated on `derivedActive` (it
  // is the recovery / cross-metric layer) and fail-soft to null.
  const correlationsBlockPromise = derivedActive
    ? buildCorrelationsSnapshotBlock(userId, coachLocale, reach)
    : null;
  const memoryBlockPromise = buildCoachMemoryBlock(
    userId,
    derivedProfile,
    now,
    coachLocale,
    reach,
  );
  // v1.15 — cycle/phase block, gated on the resolved cycle module so a
  // non-cycle account issues no query (the helper short-circuits to null
  // before any read for a disabled account). The block is descriptive only —
  // current phase + day-of-cycle, the next predicted event (period range,
  // fertile window goal-gated), and the headline phase-correlation finding.
  // v1.18.0 — the gate is the FULLY-resolved cycle module
  // (`isCycleAvailableForUser` → the per-user toggle AND the operator
  // server-wide kill-switch), so an operator-off instance never injects the
  // cycle block into the coach prompt.
  const cycleEnabled = await isCycleAvailableForUser(userId);
  // The cycle block predicts from every logged cycle, of any age, so that its
  // "day N, period in M days" matches the calendar. Any lookback limit leaves
  // it out rather than predicting from a part of the history.
  const cycleBlockPromise =
    cycleEnabled && !bounded
      ? buildCycleSnapshotBlock(userId, prefsRow?.gender, now, userTz)
      : null;

  // v1.18.1 P4 — illness/condition context. Always attempted (the helper is
  // module-gated internally and short-circuits to null for a non-illness
  // account). It is CONTEXT, not a scope-gated metric: appended like
  // anthropometrics/scope below without a `registerBlock` so the budget
  // degrader never sheds it — the Coach needs to know about Rest Mode.
  const illnessBlockPromise = buildIllnessSnapshotBlock(userId, now, reach);

  // v1.18.11 (#65) — lab-result context. Like illness it is CONTEXT, not a
  // scope-gated metric: attached without a `registerBlock` so the budget
  // degrader never sheds it, and Labs is intentionally not module-gated (the
  // helper reads owner-scoped rows directly, mirroring `/api/labs`). The block
  // carries the most-recent resolved reading per biomarker (last 12 months,
  // capped) so the Coach can answer "what was my LDL" without re-deriving.
  const labsBlockPromise = buildLabsSnapshotBlock(userId, now, reach);

  // v1.38 — doctor-visit context. Like illness/labs it is attempted always (a
  // visit is core, never module-gated) and short-circuits to null when there is
  // neither an upcoming appointment inside the 14-day horizon nor a past visit.
  // UNLIKE illness/labs it IS registered for degradation below (against the
  // lowest-priority cluster), because a visit history is low-frequency context
  // the Coach can lose under budget pressure without losing a safety flag.
  const visitsBlockPromise = buildVisitsSnapshotBlock(userId, now, reach);

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
    visitsBlock,
  ] = await Promise.all([
    moodRowsPromise,
    complianceMedsPromise,
    sleepRowsPromise,
    sleepRhythmRowsPromise,
    workoutRowsPromise,
    glucoseClinicalRowsPromise,
    glp1BlockPromise,
    derivedBlockPromise,
    dayStrainRowsPromise,
    trajectoryBlockPromise,
    correlationsBlockPromise,
    memoryBlockPromise,
    cycleBlockPromise,
    illnessBlockPromise,
    labsBlockPromise,
    visitsBlockPromise,
  ]);

  buildCoreMetricsBlocks({
    sources,
    features,
    measurementRows,
    moodRows,
    recentCutoff,
    userTz,
    coarseTails: {
      bp: bpCoarseTail,
      weight: weightCoarseTail,
      pulse: pulseCoarseTail,
    },
    snapshot,
    windows,
    metrics,
    counts,
    registerBlock,
    groundingValues,
    units,
  });
  // Medication compliance lives outside the structured features — the block
  // is assembled in `snapshot-blocks/compliance-block.ts` from the ledger
  // reads above.
  if (wantsCompliance && complianceMeds) {
    buildComplianceBlock({
      complianceMeds,
      userTz,
      cutoff,
      recentCutoff,
      now,
      snapshot,
      metrics,
      counts,
      registerBlock,
    });
  }

  buildValueSeriesBlocks({
    sources,
    measurementRows,
    additiveCutoff,
    recentCutoff,
    userTz,
    snapshot,
    metrics,
    counts,
    registerBlock,
    groundingValues,
    units,
  });
  // ── v1.7.0 sleep block (with optional per-stage enrichment) ───────
  // Assembled in `snapshot-blocks/sleep-block.ts` from the dedicated
  // stage-bearing rows read in parallel above.
  if (sources.has("sleep") && sleepRows) {
    buildSleepTimelineBlock({
      sleepRows: sleepRows as SleepStageRow[],
      sourcePriorityJson: prefsRow?.sourcePriorityJson ?? null,
      userTz,
      recentCutoff,
      snapshot,
      metrics,
      counts,
      registerBlock,
      groundingValues,
    });
  }

  // ── v1.17.0 sleep-rhythm block (sleep-debt + chronotype) ──────────
  // Assembled in `snapshot-blocks/sleep-block.ts` from the rhythm's own
  // fixed trailing-42-day rows read in parallel above.
  if (sources.has("sleep") && sleepRhythmRows && sleepRhythmRows.length > 0) {
    buildSleepRhythmBlock({
      sleepRhythmRows: sleepRhythmRows as SleepStageRow[],
      sourcePriorityJson: prefsRow?.sourcePriorityJson ?? null,
      userTz,
      ageYears: derivedProfile.ageYears,
      snapshot,
      metrics,
      registerBlock,
    });
  }

  // ── v1.7.0 glucose block (per-context daily means) ────────────────
  // Assembled in `snapshot-blocks/glucose-block.ts` from the shared
  // measurement read + the fixed-window clinical rows read above.
  if (sources.has("glucose")) {
    buildGlucoseBlock({
      measurementRows,
      glucoseCutoff: additiveCutoff("glucose"),
      glucoseClinicalRows,
      glucoseUnit,
      recentCutoff,
      userTz,
      now,
      snapshot,
      metrics,
      counts,
      registerBlock,
      groundingValues,
    });
  }

  // ── v1.7.0 workouts block (capped list + per-sport rollup) ────────
  // Assembled in `snapshot-blocks/workouts-block.ts` from the rows read
  // in parallel above.
  if (sources.has("workouts") && workoutRows) {
    buildWorkoutsBlock({
      workoutRows,
      sourcePriorityJson: prefsRow?.sourcePriorityJson ?? null,
      userTz,
      snapshot,
      metrics,
      counts,
      registerBlock,
      unitPreference: units.system,
    });
  }

  buildProfileContextBlocks({
    excludesMedications,
    excludesAnthropometrics,
    glp1Block,
    profile: features.context,
    snapshot,
    metrics,
    registerBlock,
  });

  // ── v1.10.0 — derived wellness layer (compact summaries) ─────────────
  //
  // The composites + persisted scores the dashboard rings render, folded
  // in as one tiny object per metric (value + band + coverage), NOT the
  // raw series. So the Coach can say "your readiness is 64, low band" and
  // ground it in the same number the user sees. Insufficient metrics are
  // omitted (no "no data" noise). Reads the same `computeDerivedMetric`
  // contract every surface uses — no recompute. Gated on at least one of
  // the signals the composites are built from staying in-scope (HRV /
  // resting HR / sleep / VO₂max), so a user who excludes those doesn't see
  // the block. `derivedActive` + `derivedProfile` are resolved up top so
  // the derived / trajectory reads can run in the parallel batch.
  if (derivedActive) {
    if (derivedBlock) {
      snapshot.derived = derivedBlock;
      metrics.add("hrv");
      registerBlock("derived", "hrv");
    }

    buildDayStrainBlock({
      rows: dayStrainRows,
      recentCutoff,
      snapshot,
      registerBlock,
    });

    // ── v1.11.0 (Epic B, Pillar 3) — short-horizon trajectory block ──────
    // Additive, lowest-signal block: per in-scope metric a compact
    // direction + slope + projected horizon-end-with-band, computed by the
    // deterministic `computeTrajectory` engine (NEVER recomputed here). The
    // Coach narrates the range conditionally (system-prompt rule 11 /
    // ground rule 16) only when this block is present. Registered under an
    // `environment`-cluster source so the soft-cap degrader sheds it FIRST,
    // before any clinical cluster, under prompt-budget pressure. Read in
    // the parallel batch above.
    if (trajectoryBlock) {
      snapshot.trajectory = trajectoryBlock;
      registerBlock("trajectory", "skin_temp");
    }

    // ── RECON1 (D5-5) — discovered cross-metric drivers ──────────────────
    // The bounded top-N driver pairs (post quality-gate, post-rank) from the
    // SAME engine the get_correlations tool reads, attached so the no-tools /
    // local-provider path narrates the cross-metric layer it was missing —
    // closing the parity gap with the tool path and making system-prompt rule
    // 14's "any driver field the SNAPSHOT carries" fallback real. Descriptive,
    // never causal. Registered against the lowest-priority `skin_temp`
    // (environment) cluster so the budget degrader sheds it before any
    // clinical block under prompt-budget pressure.
    if (correlationsBlock) {
      snapshot.correlations = correlationsBlock;
      registerBlock("correlations", "skin_temp");
    }
  }

  // ── v1.11.0 W5a — rolling-profile memory (Pillar P2 2a) ──────────────
  //
  // Zero-LLM longitudinal recall: the latest period-narrative headline +
  // a per-metric prior-vs-current band memory, assembled from artefacts we
  // already persist. Lets the Coach reference "as I noted at the start of
  // the month…" instead of re-deriving cold every turn. Folded under the
  // `memory` key and registered against the LOWEST-signal cluster
  // (`environment`, the tail of CLUSTER_PRIORITY) so `degradeToBudget`
  // sheds it FIRST under the char cap — before any clinical cluster. The
  // builder is fault-isolated per sub-source and returns null when neither
  // a narrative nor any band movement is on file. Read in the parallel
  // batch above.
  if (memoryBlock) {
    snapshot.memory = memoryBlock;
    // `skin_temp` maps to the `environment` cluster — the lowest priority
    // in CLUSTER_PRIORITY — so this block degrades before everything else.
    registerBlock("memory", "skin_temp");
  }

  // ── v1.15 — cycle/phase block ────────────────────────────────────────
  //
  // Present only for a cycle-enabled account (the promise is null otherwise,
  // so this is byte-for-byte unchanged for everyone else). The block names the
  // current phase + day-of-cycle, the next predicted event (period range +
  // confidence + method; fertile window goal-gated), and the headline
  // phase-correlation finding — all from the same deterministic engine the
  // calendar + insights surface use, never re-derived. The Coach's cycle
  // ground rule keeps replies descriptive: never contraception-grade, never a
  // "safe day" claim. Registered against the lowest-priority `skin_temp`
  // source so the soft-cap degrader sheds it before any clinical cluster.
  if (cycleBlock) {
    snapshot.cycle = cycleBlock;
    registerBlock("cycle", "skin_temp");
  }

  // v1.18.1 P4 — illness/condition context. Small + load-bearing, so it is
  // attached WITHOUT a cluster registration (like scope/anthropometrics): the
  // budget degrader never sheds it, the Coach always knows whether the user is
  // in Rest Mode. Labels + lifecycle + dates only — no decrypted note.
  if (illnessBlock) {
    snapshot.illness = illnessBlock;
  }

  // v1.18.11 (#65) — lab-result context. Attached WITHOUT a cluster
  // registration (like illness/scope): the budget degrader never sheds it, so
  // the Coach can always answer a lab question from the user's own readings.
  // Server-authoritative + grounded — resolved name/value/unit/range per
  // biomarker, never the decrypted note.
  if (labsBlock) {
    snapshot.labs = labsBlock;
  }

  // v1.38 — doctor-visit context. Registered for degradation, and placed
  // EXPLICITLY rather than left to inherit the tail of the list by accident: a
  // visit history is low-frequency, high-signal-but-losable context, so it maps
  // to `skin_temp` (the `environment` cluster, the tail of CLUSTER_PRIORITY),
  // which puts it among the first blocks the budget degrader sheds — before any
  // clinical cluster. Unlike illness (which carries the Rest Mode safety flag)
  // there is no reason to protect it from truncation.
  if (visitsBlock) {
    snapshot.visits = visitsBlock;
    registerBlock("visits", "skin_temp");
  }

  // ── v1.22 (W9) — adherence storyline (B5), changepoints (C1), signal-trust
  // (C3), experiment read-back (C2, flag-gated). Best-effort + fault-isolated;
  // tiny descriptive objects attached WITHOUT a cluster registration (like
  // illness/labs/scope, the budget degrader never sheds them). The C2 read-back
  // is attached ONLY when the operator flag is on — the user-visible experiment
  // verdict stays gated until its live B0 cases clear.
  // These cross-cutting narrations belong on the BROAD Coach turn, not on a
  // narrowed single-source snapshot (the F1 tool builds + metric-page contexts
  // pass an explicit `scope.sources`). Skipping them there keeps a scoped read
  // bounded to its domain and avoids spurious recovery/vital reads.
  const isExplicitlyScoped =
    Array.isArray(scope?.sources) && scope.sources.length > 0;
  // Each of these reads its own fixed window; one that reaches past the
  // lookback limit is left out. The experiment read-back compares against a
  // baseline from before the plan began, of no fixed length, so any limit
  // leaves it out.
  const [adherenceStoryline, changepoints, signalTrust, experimentOutcomes] =
    isExplicitlyScoped
      ? [null, null, null, null]
      : await Promise.all([
          excludesMedications ||
          !fitsReach(ADHERENCE_STORYLINE_HORIZON_DAYS, reach)
            ? Promise.resolve(null)
            : buildAdherenceStoryline(userId, userTz, now).catch(
                blockFailed("adherenceStoryline"),
              ),
          fitsReach(CHANGEPOINT_WINDOW_DAYS, reach)
            ? buildChangepointSignals(userId, now).catch(
                blockFailed("changepoints"),
              )
            : Promise.resolve(null),
          fitsReach(SIGNAL_TRUST_WINDOW_DAYS, reach)
            ? buildSignalTrust(userId, userTz, now).catch(
                blockFailed("signalTrust"),
              )
            : Promise.resolve(null),
          experimentVerdictEnabled() && !bounded
            ? buildExperimentOutcomeBlock(userId, { now }).catch(
                blockFailed("experimentOutcomes"),
              )
            : Promise.resolve(null),
        ]);
  if (adherenceStoryline) snapshot.adherenceStoryline = adherenceStoryline;
  if (changepoints && changepoints.length > 0) {
    snapshot.changepoints = changepoints;
  }
  if (signalTrust) snapshot.signalTrust = signalTrust;
  if (experimentOutcomes) {
    snapshot.experimentOutcomes = experimentOutcomes.experiments;
  }

  if (Object.keys(snapshot).length === 0) {
    metrics.add("general");
  }

  // Pin the scope onto the snapshot itself so the model knows which
  // windows + sources are in-bounds for the reply. The system prompt
  // tells the model to read from this block for day-level questions.
  snapshot.scope = {
    window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
    // Named only under a limit, so an unlimited snapshot stays as it was.
    ...(bounded ? { lookbackLimit: reach.window } : {}),
  };

  // v1.4.36 W3 T4 — compactSections drops any zero-row block before
  // serialisation so the prompt never carries a labelled-empty key.
  // The snapshot is built conditionally above so most empty paths are
  // already skipped, but the helper catches future regressions and
  // matches the contract the /insights/generate route applies on its
  // side of the prompt.
  const compactSnapshot = compactSections(snapshot);

  // Date the end of every metric series before anything narrates it. Without
  // this each block reads as if its newest number were taken just now, and the
  // hero line said "today" about a metric last measured five days earlier. The
  // stamp sits on the block itself so the age travels with the numbers into
  // every surface the snapshot feeds — hero, briefing, Coach reply, tools.
  const freshness = annotateSnapshotFreshness(compactSnapshot);
  if (freshness.stale.length > 0) {
    annotate({
      action: { name: "coach.snapshot.stale_blocks" },
      meta: { blocks: freshness.stale.sort() },
    });
  }
  // A rollup band that no longer reconciles with the rows underneath it is an
  // operator-visible defect, not just a narration problem — the bucket is wrong
  // on disk and stays wrong until something recomputes it.
  if (freshness.coarseWithheld.length > 0) {
    annotate({
      action: { name: "coach.snapshot.coarse_withheld" },
      meta: { blocks: freshness.coarseWithheld.sort() },
    });
  }

  // v1.7.0 — assembled-snapshot soft cap. Enabling every cluster at a
  // long window can balloon the prompt; degrade progressively by
  // reverse cluster priority until the serialised size fits
  // `MAX_SNAPSHOT_CHARS`. The `scope` block is exempt — the model
  // needs it to know what is in-bounds. The helper emits its own
  // `coach.snapshot.truncated` annotation when it sheds anything.
  //
  // A read scoped to one source (every retrieval tool, the MCP metric reads,
  // a metric page) asked for that source's blocks: those are condensed, never
  // emptied, and only after everything else has been shed.
  const requestedSource =
    condenseRequested &&
    Array.isArray(scope?.sources) &&
    scope.sources.length === 1
      ? scope.sources[0]
      : null;
  const requestedBlocks = new Set(
    requestedSource === null
      ? []
      : Array.from(blockSources.entries())
          .filter(([, source]) => source === requestedSource)
          .map(([key]) => key),
  );
  const degraded = degradeToBudget(
    compactSnapshot,
    blockClusters,
    requestedBlocks,
  );

  // v1.18.6 (W7) — build the citation-aware reference-grounding block from the
  // representative scalars collected above. Deterministic + pure; the route
  // appends it verbatim after the SNAPSHOT. Null when no present metric is
  // covered by the reference backbone. Insertion order follows the block-build
  // order (BP first), giving a stable, inspectable block for the
  // hallucination-QA pass.
  const groundingMetrics: GroundingMetricInput[] = Array.from(
    groundingValues.entries(),
  ).map(([metric, value]) => ({ metric, value }));
  const referenceGrounding = buildReferenceGroundingBlock({
    metrics: groundingMetrics,
    hasDiabetes: prefsRow?.hasDiabetes ?? false,
    units,
  });
  if (referenceGrounding) {
    annotate({
      action: { name: "coach.grounding.attached" },
      meta: {
        metrics: groundingMetrics.map((m) => m.metric).sort(),
        hasDiabetes: prefsRow?.hasDiabetes ?? false,
      },
    });
  }

  return {
    snapshotJson: JSON.stringify(compactSnapshot, null, 2),
    // v1.20.0 (F1) — the structured, post-degrade snapshot record keyed by
    // domain block (`bloodPressure`, `glucose`, `labs`, …). The coach tool
    // executor slices a single domain block out of this so a retrieval tool
    // returns exactly the numbers the legacy snapshot path would have shown —
    // same builder, same gates, same I/O. `snapshotJson` is this record
    // serialised; exposing the record avoids re-parsing it.
    sections: compactSnapshot,
    provenance: {
      windows: Array.from(windows),
      metrics: Array.from(metrics),
      counts: Object.keys(counts).length > 0 ? counts : undefined,
    },
    referenceGrounding,
    units,
    ...(degraded.length > 0
      ? { degradedBlocks: Array.from(new Set(degraded.map((d) => d.key))) }
      : {}),
  };
}

/**
 * v1.7.0 — progressive degradation to the snapshot char budget.
 *
 * Mutates `snapshot` in place. Walks the blocks in REVERSE cluster
 * priority (lowest-signal first) over two passes:
 *   1. drop `timeline.recent` (keep `aggregate` + `timeline.weekly`),
 *   2. collapse `timeline.weekly` too (keep only `aggregate` / the
 *      smallest summary the block carries).
 * Stops as soon as the serialised size fits. Emits one
 * `coach.snapshot.truncated` annotation describing what was shed.
 *
 * Returns the list of `{ key, cluster, pass }` it degraded — empty when
 * the snapshot already fit.
 */
export function degradeToBudget(
  snapshot: Record<string, unknown>,
  blockClusters: Map<string, CoachDataCluster>,
  requested: ReadonlySet<string> = new Set(),
): Array<{ key: string; cluster: CoachDataCluster; pass: number }> {
  const degraded: Array<{
    key: string;
    cluster: CoachDataCluster;
    pass: number;
  }> = [];
  // Measure against the SAME pretty-printed form the prompt ships
  // (`JSON.stringify(snapshot, null, 2)`), not the compact form —
  // otherwise the cap under-counts by ~2× and the prompt overflows.
  const size = () => JSON.stringify(snapshot, null, 2).length;
  if (size() <= MAX_SNAPSHOT_CHARS) return degraded;

  // Build a degrade order: blocks grouped by cluster, lowest priority
  // first. A block with no registered cluster (e.g. anthropometrics,
  // scope) is never touched — those are tiny + load-bearing.
  const priorityIndex = new Map<CoachDataCluster, number>();
  CLUSTER_PRIORITY.forEach((c, i) => priorityIndex.set(c, i));
  const orderedKeys = Array.from(blockClusters.entries()).sort((a, b) => {
    const pa = priorityIndex.get(a[1]) ?? -1;
    const pb = priorityIndex.get(b[1]) ?? -1;
    // A block the read asked for goes last, whatever its cluster.
    const ra = requested.has(a[0]) ? 1 : 0;
    const rb = requested.has(b[0]) ? 1 : 0;
    if (ra !== rb) return ra - rb;
    // Higher priority index = lower signal = degrade first.
    return pb - pa;
  });

  const asRecord = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;

  // Drop the dense per-day detail from a block, leaving the coarser
  // weekly / aggregate summary. Handles the three block shapes:
  //   - timeline-bearing blocks (`timeline.recent`)
  //   - glucose (`byContext.<ctx>.recent`)
  //   - workouts (`recent` at the top level)
  const dropRecent = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline && "recent" in timeline) {
      delete timeline.recent;
      changed = true;
    }
    // v1.18.7 — the coarse MONTH/YEAR tail + anomaly envelope is the
    // lowest-value, oldest detail, so it sheds in the same first pass as the
    // dense per-day rows.
    if (timeline && "coarse" in timeline) {
      delete timeline.coarse;
      changed = true;
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "recent" in c) {
          delete c.recent;
          changed = true;
        }
      }
    }
    if ("recent" in block) {
      delete block.recent;
      changed = true;
    }
    return changed;
  };

  // Collapse the weekly buckets too — leaves only the aggregate /
  // smallest summary the block carries.
  const dropWeekly = (key: string): boolean => {
    const block = asRecord(snapshot[key]);
    if (!block) return false;
    let changed = false;
    const timeline = asRecord(block.timeline);
    if (timeline) {
      for (const field of ["weekly", "weeklySys", "weeklyDia"]) {
        if (field in timeline) {
          delete timeline[field];
          changed = true;
        }
      }
      if (Object.keys(timeline).length === 0) {
        delete block.timeline;
      }
    }
    const byContext = asRecord(block.byContext);
    if (byContext) {
      for (const ctx of Object.keys(byContext)) {
        const c = asRecord(byContext[ctx]);
        if (c && "weekly" in c) {
          delete c.weekly;
          changed = true;
        }
      }
    }
    return changed;
  };

  // Last resort: replace the whole block with a compact marker so the
  // model still knows the cluster exists without paying for its rows.
  // v1.16.8 — the `memory` block's `facts` list survives the drop: it
  // carries the durable personal facts (a stated allergy, a stated
  // condition) and is tiny by construction (top-8, ≤160 chars each).
  // Shedding it made the Coach forget a stated allergy exactly on the
  // data-heavy accounts that hit the char cap; the bulky narrative +
  // trend recall still goes.
  const dropBlock = (key: string): boolean => {
    if (!(key in snapshot)) return false;
    const block = asRecord(snapshot[key]);
    const facts =
      block && Array.isArray(block.facts) && block.facts.length > 0
        ? block.facts
        : null;
    // v1.21.3 (B1) — the durable plans survive the drop alongside facts: they
    // are the user's confirmed if-then commitments, tiny by construction
    // (top-6, ≤160 chars each), and shedding them would make the Coach forget
    // a plan exactly on the data-heavy accounts that hit the char cap.
    const plans =
      block && Array.isArray(block.plans) && block.plans.length > 0
        ? block.plans
        : null;
    // v1.22 (B2/B3) — the episodic reminders survive the drop alongside
    // facts/plans: they are the user's own "remember this" asks, tiny by
    // construction (top-6, ≤280 chars each), and shedding them would make the
    // Coach forget a reminder on exactly the data-heavy accounts that hit the
    // char cap.
    const reminders =
      block && Array.isArray(block.reminders) && block.reminders.length > 0
        ? block.reminders
        : null;
    const survivors: Record<string, unknown> = {
      omitted: "trimmed for prompt budget",
    };
    if (facts) survivors.facts = facts;
    if (plans) survivors.plans = plans;
    if (reminders) survivors.reminders = reminders;
    snapshot[key] = survivors;
    return true;
  };

  // Degrade per-block, LOWEST priority first, collapsing each block as
  // far as needed before advancing to the next (higher-priority) one.
  // For each block in turn: drop the dense per-day detail, then the
  // weekly buckets, then — only if it still overflows — replace the
  // whole block with a marker. A higher-priority block is touched only
  // once every lower-priority block is already fully collapsed and the
  // prompt still exceeds the cap, so the clinical core keeps its detail
  // until it is genuinely the last lever left.
  for (const [key, cluster] of orderedKeys) {
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    // A requested series is condensed step by step and keeps its numbers
    // (`series-condense.ts`); it is never swapped for the `omitted` marker.
    if (requested.has(key) && asRecord(asRecord(snapshot[key])?.timeline)) {
      for (const step of [1, 2, 3] as const) {
        if (size() <= MAX_SNAPSHOT_CHARS) break;
        if (condenseSeriesBlock(snapshot[key], step)) {
          degraded.push({ key, cluster, pass: step });
        }
      }
      continue;
    }
    if (dropRecent(key)) degraded.push({ key, cluster, pass: 1 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (dropWeekly(key)) degraded.push({ key, cluster, pass: 2 });
    if (size() <= MAX_SNAPSHOT_CHARS) break;
    if (requested.has(key)) continue;
    if (dropBlock(key)) degraded.push({ key, cluster, pass: 3 });
  }

  if (degraded.length > 0) {
    const droppedClusters = Array.from(new Set(degraded.map((d) => d.cluster)));
    annotate({
      action: { name: "coach.snapshot.truncated" },
      meta: {
        droppedClusters,
        droppedBlocks: degraded.map((d) => d.key),
        finalChars: size(),
      },
    });
  }
  return degraded;
}
