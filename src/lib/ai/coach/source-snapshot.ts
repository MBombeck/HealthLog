/**
 * The snapshot one metric's read needs, built from that metric's rows.
 *
 * `get_metric_series` answers with one section of a Coach snapshot. Built by
 * the full builder, that one section paid for everything a Coach turn
 * carries: the all-type feature extraction, the derived wellness layer, the
 * trajectory and correlation engines, memory, GLP-1, cycle, illness, labs and
 * visits — a few hundred SQL statements and the event-loop time to fold them,
 * for a result that keeps none of it. An MCP client polling one metric every
 * few minutes paid that on every call.
 *
 * This builder runs the same prelude (prefs, module gates, admitted sources,
 * cutoffs) and the same block builders as `snapshot.ts`, over the requested
 * source's own reads only, and hands back the same section and the same
 * reference grounding. Each block reads exactly what the full build reads for
 * it: the core clinical aggregates come from `extractFeatures` scoped to the
 * one block (whose bulk read keeps its all-type cap, so the rows a block sees
 * are unchanged), the timelines from the same windowed read, the coarse tail
 * from the same rollup reader.
 *
 * Two cases go to the full builder instead:
 *
 *   - a source whose section this module does not build (glucose, workouts,
 *     compliance have their own tools; the environment cluster is ordered
 *     beside the memory / trajectory / correlation blocks in the budget pass,
 *     see below);
 *   - a section large enough that the full build's prompt-budget pass could
 *     plausibly trim it.
 *
 * The budget pass is the one thing a single-source build cannot see. The full
 * builder trims blocks, lowest cluster first, once the WHOLE snapshot passes
 * `MAX_SNAPSHOT_CHARS`; the requested section is only touched after every
 * lower-priority block is already collapsed, so what decides it is the section
 * plus the context that is never shed (labs, illness, anthropometrics) or
 * ranks above it. A section below `SOURCE_SNAPSHOT_FALLBACK_CHARS` leaves more
 * than `MAX_SNAPSHOT_CHARS - SOURCE_SNAPSHOT_FALLBACK_CHARS` of room for that
 * context, which a single-source build does not reach on any account we know
 * of; above it, the full builder answers and the result is the old one by
 * construction. Should an account ever carry more context than that room, the
 * difference is that this build returns the section untrimmed — the trim
 * exists for a prompt this read never sends.
 */
import { annotate } from "@/lib/logging/context";
import {
  extractFeatures,
  type ScopedFeatureBlock,
} from "@/lib/insights/features";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { memoizePerRequest } from "@/lib/request-cache";
import type { MeasurementType } from "@/generated/prisma/client";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import type { SleepStageRow } from "@/lib/analytics/sleep-night";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "./source-measurement-types";
import { sourceCluster } from "./clusters";
import { buildCoachSnapshot, type CoachSnapshotResult } from "./snapshot";
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
import { buildReferenceGroundingBlock } from "./reference-grounding";
import { buildCoarseTimelineTail } from "./snapshot-series";
import { buildCoreMetricsBlocks } from "./snapshot-blocks/core-metrics-block";
import {
  buildValueSeriesBlocks,
  VALUE_SERIES_SOURCES,
} from "./snapshot-blocks/value-series-blocks";
import { buildSleepTimelineBlock } from "./snapshot-blocks/sleep-block";
import type {
  CoachProvenance,
  CoachScopeSource,
  CoachScopeWindow,
} from "./types";

/**
 * Above this pretty-printed size the section goes to the full builder, whose
 * budget pass may trim it (see the module comment). A 30-day section is a few
 * thousand characters; a year of blood pressure with its coarse tail is the
 * kind of section that crosses it.
 */
export const SOURCE_SNAPSHOT_FALLBACK_CHARS = MAX_SNAPSHOT_CHARS / 2;

/** Core clinical sources: their aggregate is a feature block. */
const CORE_FEATURE_BLOCK: Partial<
  Record<CoachScopeSource, ScopedFeatureBlock>
> = {
  bp: "bloodPressure",
  weight: "weight",
  pulse: "pulse",
  mood: "mood",
};

/** Core clinical sources with a coarse MONTH/YEAR tail, by its anchor type. */
const COARSE_TAIL_TYPE: Partial<Record<CoachScopeSource, MeasurementType>> = {
  bp: "BLOOD_PRESSURE_SYS",
  weight: "WEIGHT",
  pulse: "PULSE",
};

/** Whether this module builds `source`'s section itself. */
export function buildsSourceSection(source: CoachScopeSource): boolean {
  if (sourceCluster(source) === "environment") return false;
  return (
    source in CORE_FEATURE_BLOCK ||
    source === "sleep" ||
    VALUE_SERIES_SOURCES.has(source)
  );
}

export type CoachSourceSnapshot = Pick<
  CoachSnapshotResult,
  "sections" | "referenceGrounding"
>;

/**
 * Build the snapshot sections and reference grounding a single-source read
 * slices, identical to what `buildCoachSnapshot(userId, { sources: [source],
 * window })` returns for that source's section.
 */
export async function buildCoachSourceSnapshot(
  userId: string,
  source: CoachScopeSource,
  window: CoachScopeWindow | undefined,
): Promise<CoachSourceSnapshot> {
  const scope = { sources: [source], window };
  if (!buildsSourceSection(source)) {
    annotate({
      action: { name: "coach.source_snapshot.full" },
      meta: { source, reason: "unsupported_source" },
    });
    return buildCoachSnapshot(userId, scope);
  }

  const prelude = await resolveSnapshotPrelude(userId, scope);
  const { prefsRow, userTz, units, sources } = prelude;
  const now = new Date();
  const { windowDays, cutoff, recentCutoff, additiveCutoff } =
    resolveSnapshotCutoffs(sources, prelude.window, now);
  // An excluded source leaves `sources` empty: nothing is read, the section
  // stays absent, and the caller resolves the miss the way it always has.
  const admitted = sources.has(source);

  const featureBlock = admitted ? CORE_FEATURE_BLOCK[source] : undefined;
  const coarseType = admitted ? COARSE_TAIL_TYPE[source] : undefined;
  const wantedTypes =
    admitted && source !== "sleep" && source !== "mood"
      ? [...(COACH_SOURCE_MEASUREMENT_TYPES[source] ?? [])]
      : [];

  const [features, coarseTail, measurementRows] = await Promise.all([
    featureBlock
      ? memoizePerRequest(
          `coach-source-features:${userId}:${windowDays}:${featureBlock}`,
          () =>
            extractFeatures(userId, false, {
              sinceDays: windowDays,
              only: new Set([featureBlock]),
            }),
        )
      : undefined,
    coarseType
      ? buildCoarseTimelineTail(
          userId,
          coarseType,
          now,
          userTz,
          prefsRow?.sourcePriorityJson ?? null,
        )
      : undefined,
    readSnapshotMeasurementRows(userId, wantedTypes, cutoff),
  ]);
  const moodRows =
    source === "mood" && admitted && features?.mood
      ? await readSnapshotMoodRows(userId, cutoff)
      : null;

  // Provenance and the degrade registry belong to the full builder's prompt;
  // the block builders still want somewhere to write them.
  const snapshot: Record<string, unknown> = {};
  const windows = new Set<CoachProvenance["windows"][number]>();
  const metrics = new Set<CoachProvenance["metrics"][number]>();
  const counts: NonNullable<CoachProvenance["counts"]> = {};
  const registerBlock = () => {};
  const groundingValues = new Map<ReferenceMetric, number>();

  buildCoreMetricsBlocks({
    sources,
    features: features ?? {},
    measurementRows,
    moodRows,
    recentCutoff,
    userTz,
    coarseTails: coarseType ? { [source]: coarseTail } : {},
    snapshot,
    windows,
    metrics,
    counts,
    registerBlock,
    groundingValues,
    units,
  });
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
  if (admitted && source === "sleep") {
    const sleepRows = await readSleepStageRows(userId, additiveCutoff("sleep"));
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

  snapshot.scope = {
    window: prelude.window,
    sources: Array.from(sources),
    timelineRecentDays: DAILY_TIMELINE_DAYS,
  };
  const sections = compactSections(snapshot);
  annotateSnapshotFreshness(sections);

  const size = JSON.stringify(sections, null, 2).length;
  if (size > SOURCE_SNAPSHOT_FALLBACK_CHARS) {
    annotate({
      action: { name: "coach.source_snapshot.full" },
      meta: { source, reason: "section_size", chars: size },
    });
    return buildCoachSnapshot(userId, scope);
  }

  const referenceGrounding = buildReferenceGroundingBlock({
    metrics: Array.from(groundingValues.entries()).map(([metric, value]) => ({
      metric,
      value,
    })),
    hasDiabetes: prefsRow?.hasDiabetes ?? false,
    units,
  });
  annotate({
    action: { name: "coach.source_snapshot.built" },
    meta: { source, chars: size },
  });
  return { sections, referenceGrounding };
}
