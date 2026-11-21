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
import { extractFeatures } from "@/lib/insights/features";
import type { CoachDataCluster } from "@/lib/validations/coach-prefs";
import type { UnitPreferences } from "@/lib/measurements/display-transform";
import { compactSections } from "@/lib/ai/prompts/compact-sections";
import { annotate } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";
import {
  MAX_SNAPSHOT_CHARS,
  readSnapshotMeasurementRows,
  resolveSnapshotCutoffs,
  resolveSnapshotPrelude,
} from "./snapshot-prelude";
import { annotateSnapshotFreshness } from "./snapshot-freshness";
import {
  condenseSeriesBlock,
  isCondensable,
  type DailySeries,
} from "./series-condense";
import {
  buildReferenceGroundingBlock,
  type GroundingMetricInput,
} from "./reference-grounding";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import type { ReferenceMetric } from "@/lib/reference-ranges";
import { CLUSTER_PRIORITY } from "./clusters";
import type { CoachProvenance, CoachScope } from "./types";
import {
  readSnapshotCache,
  snapshotCacheKey,
  writeSnapshotCache,
} from "./snapshot-cache";
import {
  createSnapshotAccumulators,
  type SnapshotBlockRegistry,
} from "./snapshot-blocks/block-registry";
import {
  readCoreCoarseTails,
  readSnapshotBlockInputs,
  resolveDerivedGate,
} from "./snapshot-blocks/snapshot-reads";
import { assembleSnapshotBlocks } from "./snapshot-blocks/assemble-blocks";
import {
  UNBOUNDED_REACH,
  isBounded,
  reachFloor,
  type CoachHistoryReach,
} from "./history-reach";

// Test-only escape hatch — the suites import it from this module.
export { __resetCoachSnapshotCacheForTests } from "./snapshot-cache";

export interface CoachSnapshotResult {
  snapshotJson: string;
  /**
   * v1.20.0 — the structured, post-degrade snapshot record `snapshotJson`
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
   * v1.18.6 — citation-aware reference-range grounding for the
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
 * v1.4.25 — every day-key + weekday label is now anchored to the
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
  // v1.4.36 — `medications` and `anthropometrics` are
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
  // v1.20.0 — `extractFeatures` is the heaviest read on the cold path
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

  // The snapshot record and the accumulators every block writes into
  // (`snapshot-blocks/block-registry.ts`).
  const acc = createSnapshotAccumulators(window);

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

  // Coarse tails for bp / weight / pulse, awaited before the shared read
  // (`snapshot-blocks/snapshot-reads.ts`).
  const coarseTails = await readCoreCoarseTails({
    userId,
    sources,
    now,
    userTz,
    sourcePriorityJson: prefsRow?.sourcePriorityJson ?? null,
    reach,
  });

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

  // The remaining cold-path reads run concurrently in one hop; the block
  // assembly below consumes them in a fixed order, so provenance and
  // block-registration order do not depend on the read order.
  const { derivedProfile, derivedActive } = resolveDerivedGate(
    features,
    sources,
    recoveryDisabled,
  );
  const reads = await readSnapshotBlockInputs({
    userId,
    sources,
    features,
    cutoff,
    additiveCutoff,
    now,
    userTz,
    coachLocale,
    gender: prefsRow?.gender,
    reach,
    bounded,
    excludesMedications,
    derivedProfile,
    derivedActive,
  });

  await assembleSnapshotBlocks({
    userId,
    scope,
    reach,
    window,
    sources,
    units,
    sourcePriorityJson: prefsRow?.sourcePriorityJson ?? null,
    bounded,
    excludesMedications,
    excludesAnthropometrics,
    cutoffs: { cutoff, recentCutoff, additiveCutoff },
    now,
    userTz,
    features,
    measurementRows,
    coarseTails,
    reads,
    derived: { derivedProfile, derivedActive },
    acc,
  });

  return finaliseSnapshot({
    snapshot: acc.snapshot,
    scope,
    condenseRequested,
    registry: acc.registry,
    groundingValues: acc.groundingValues,
    hasDiabetes: prefsRow?.hasDiabetes ?? false,
    units,
    windows: acc.windows,
    metrics: acc.metrics,
    counts: acc.counts,
  });
}

/**
 * Compact, date, degrade and ground the assembled snapshot, and wrap it in
 * the result envelope.
 */
function finaliseSnapshot(input: {
  snapshot: Record<string, unknown>;
  scope: CoachScope | undefined;
  condenseRequested: boolean;
  registry: SnapshotBlockRegistry;
  groundingValues: Map<ReferenceMetric, number>;
  hasDiabetes: boolean;
  units: CoachSnapshotResult["units"];
  windows: Set<CoachProvenance["windows"][number]>;
  metrics: Set<CoachProvenance["metrics"][number]>;
  counts: NonNullable<CoachProvenance["counts"]>;
}): CoachSnapshotResult {
  const { snapshot, scope, registry, units, counts } = input;
  // v1.4.36 — compactSections drops any zero-row block before
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
    input.condenseRequested &&
    Array.isArray(scope?.sources) &&
    scope.sources.length === 1
      ? scope.sources[0]
      : null;
  const requestedBlocks = new Set(
    requestedSource === null
      ? []
      : Array.from(registry.blockSources.entries())
          .filter(([, source]) => source === requestedSource)
          .map(([key]) => key),
  );
  const degraded = degradeToBudget(
    compactSnapshot,
    registry.blockClusters,
    requestedBlocks,
    (key) => registry.blockDaily.get(key)?.(),
  );

  // v1.18.6 — build the citation-aware reference-grounding block from the
  // representative scalars collected above. Deterministic + pure; the route
  // appends it verbatim after the SNAPSHOT. Null when no present metric is
  // covered by the reference backbone. Insertion order follows the block-build
  // order (BP first), giving a stable, inspectable block for the
  // hallucination-QA pass.
  const groundingMetrics: GroundingMetricInput[] = Array.from(
    input.groundingValues.entries(),
  ).map(([metric, value]) => ({ metric, value }));
  const referenceGrounding = buildReferenceGroundingBlock({
    metrics: groundingMetrics,
    hasDiabetes: input.hasDiabetes,
    units,
  });
  if (referenceGrounding) {
    annotate({
      action: { name: "coach.grounding.attached" },
      meta: {
        metrics: groundingMetrics.map((m) => m.metric).sort(),
        hasDiabetes: input.hasDiabetes,
      },
    });
  }

  return {
    snapshotJson: JSON.stringify(compactSnapshot),
    // v1.20.0 — the structured, post-degrade snapshot record keyed by
    // domain block (`bloodPressure`, `glucose`, `labs`, …). The coach tool
    // executor slices a single domain block out of this so a retrieval tool
    // returns exactly the numbers the legacy snapshot path would have shown —
    // same builder, same gates, same I/O. `snapshotJson` is this record
    // serialised; exposing the record avoids re-parsing it.
    sections: compactSnapshot,
    provenance: {
      windows: Array.from(input.windows),
      metrics: Array.from(input.metrics),
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
  /** A requested block's daily values, for its condensed summary. */
  dailyOf: (key: string) => DailySeries | undefined = () => undefined,
): Array<{ key: string; cluster: CoachDataCluster; pass: number }> {
  const degraded: Array<{
    key: string;
    cluster: CoachDataCluster;
    pass: number;
  }> = [];
  // Measure against the SAME compact form the prompt ships
  // (`JSON.stringify(snapshot)`), so the cap counts what the model reads.
  const size = () => JSON.stringify(snapshot).length;
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
    // Glucose keeps a timeline per context, HRV one per measure (#1110).
    for (const nested of [block.byContext, block.byMeasure]) {
      const byKey = asRecord(nested);
      if (!byKey) continue;
      for (const ctx of Object.keys(byKey)) {
        const c = asRecord(byKey[ctx]);
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
    for (const nested of [block.byContext, block.byMeasure]) {
      const byKey = asRecord(nested);
      if (!byKey) continue;
      for (const ctx of Object.keys(byKey)) {
        const c = asRecord(byKey[ctx]);
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
    // v1.21.3 — the durable plans survive the drop alongside facts: they
    // are the user's confirmed if-then commitments, tiny by construction
    // (top-6, ≤160 chars each), and shedding them would make the Coach forget
    // a plan exactly on the data-heavy accounts that hit the char cap.
    const plans =
      block && Array.isArray(block.plans) && block.plans.length > 0
        ? block.plans
        : null;
    // v1.22 — the episodic reminders survive the drop alongside
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
    if (requested.has(key) && isCondensable(key, snapshot[key])) {
      const daily = dailyOf(key);
      for (const step of [1, 2, 3] as const) {
        if (size() <= MAX_SNAPSHOT_CHARS) break;
        if (condenseSeriesBlock(snapshot[key], step, key, daily)) {
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
