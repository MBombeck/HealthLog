/**
 * The reads and resolutions every Coach snapshot build starts from, shared by
 * the full builder (`snapshot.ts`) and the single-source builder
 * (`source-snapshot.ts`). Both must agree on the prefs, the module gates, the
 * admitted sources, the window cutoffs and the windowed row read, because the
 * single-source build promises the same section the full build would carry;
 * keeping these in one place is what makes that promise hold by construction
 * instead of by two copies staying in step.
 */
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import { DEFAULT_TIMEZONE } from "@/lib/tz/resolver";
import { locales, defaultLocale, type Locale } from "@/lib/i18n/config";
import { resolveUnitPreferences } from "@/lib/measurements/display-transform";
import { memoizePerRequest } from "@/lib/request-cache";
import { resolveModuleMap } from "@/lib/modules/gate";
import { admitCoachSources, coachExclusions } from "@/lib/ai/coach/scope-gate";
import type { CoachDataCluster } from "@/lib/validations/coach-prefs";
import { clusterSourcesFromPrefs, sourceCluster } from "./clusters";
import { resolveScope, windowToDays } from "./snapshot-series";
import {
  UNBOUNDED_REACH,
  clampWindow,
  type CoachHistoryReach,
} from "./history-reach";
import type { CoachScope, CoachScopeSource, CoachScopeWindow } from "./types";

/**
 * Day-level cap for the raw timeline. Days within this window are kept
 * verbatim (one entry per day with weekday). Older days inside the
 * snapshot window are folded into weekly means so a 90-day window
 * lands at ~14 day-rows + ~11 week-rows ≈ 25 rows per metric — well
 * under the 3 000-token Coach turn budget on a 5-metric snapshot.
 */
export const DAILY_TIMELINE_DAYS = 14;

/**
 * v1.7.0 — assembled-snapshot soft char cap. After the snapshot is
 * built we measure `JSON.stringify(snapshot).length` as a ~4-chars-per-
 * token proxy and, if it exceeds this cap, progressively degrade the
 * lowest-priority clusters (drop `timeline.recent`, then collapse the
 * weekly buckets) until it fits. ~24 000 chars ≈ ~6 000 tokens, which
 * sits comfortably inside every provider's context alongside the system
 * prompt + history window. The daily token ledger (`budget.ts`) stays
 * the per-day cost backstop; this is the per-prompt shape backstop.
 */
export const MAX_SNAPSHOT_CHARS = 24_000;

/**
 * v1.18.10 (P-2) — newest-first cap on the single multi-type measurement read
 * that feeds the Coach snapshot timelines. The window read can reach 365 days
 * (`lastYear` / `allTime`) across high-frequency types (PULSE / glucose are
 * 200k-row-class), but the prompt only renders ~21 daily + ~10 weekly buckets
 * per metric, so an uncapped read loaded a year of rows to discard almost all
 * of them. 6000 keeps the recent-daily + weekly window exact even with several
 * dense types active (≈ a year of multi-daily readings on one type, or a
 * handful of types at a few readings/day) while bounding the worst case; the
 * coarse MONTH/YEAR tail comes from the rollup tier, not this read.
 */
const SNAPSHOT_MEASUREMENT_ROW_CAP = 6000;

/**
 * v1.7.0 — when more than this many clusters are active, cap the
 * additive (non-core) clusters' timeline window so a 10-cluster,
 * allTime request can't fan the timeline out across every series at
 * once. The core clinical clusters keep the user-chosen window.
 */
const MULTI_CLUSTER_THRESHOLD = 6;
const MULTI_CLUSTER_WINDOW_CAP: CoachScopeWindow = "last90days";

/**
 * Clusters that keep the user-chosen window even under the multi-cluster
 * cap — the high-signal clinical series.
 */
const CORE_CLUSTERS: ReadonlySet<CoachDataCluster> = new Set<CoachDataCluster>([
  "medication",
  "cardio",
  "glucose",
]);

/**
 * Resolve the prefs, module gates and scope a build reads under.
 *
 * v1.4.23 H4 — apply per-user `excludeMetrics` BEFORE we read any
 * measurement rows so the model never sees data the user opted out
 * of. The filter intersects with the resolved scope (the explicit
 * `scope` argument from the request body still wins for the
 * _maximum_ set; prefs only narrow further).
 *
 * v1.4.25 W7b — the same prefs read also returns the user's
 * displayTimezone so the day-key and weekday labels below match the
 * calendar the user is looking at. Reading both columns in one
 * query keeps the snapshot's read budget the same as before.
 *
 * v1.7.0 — the prefs read now also drives the source default: when
 * the request omits an explicit `scope.sources`, the resolved scope
 * expands the user's saved `dataClusters` (legacy default when the
 * key is absent). So the prefs read must precede `resolveScope`.
 * v1.18.0 — resolve the per-user module map once at build start so a
 * disabled data-domain module's data never enters the coach context.
 * The map read is memoised per-request by the gate, and runs alongside
 * the prefs read (both only need `userId`), so the cold path pays a
 * single extra round-trip at most. Disabled modules fold into the same
 * SYSTEM-side exclusion the user's `excludeMetrics` flow already drives.
 */
export async function resolveSnapshotPrelude(
  userId: string,
  scope: CoachScope | undefined,
  /**
   * The Coach's lookback limit, applied to the window here so every build
   * that starts from the prelude reads under it. The single-source MCP build
   * passes none and keeps its own window.
   */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
) {
  const moduleMapPromise = resolveModuleMap(userId);
  // v1.20.0 (H-1) — the F1 coach tools each rebuild a single-source snapshot
  // with a distinct LRU key, so the 60s snapshot cache does not share this read
  // across the fan-out. Memoise it per-request (the select shape is constant, so
  // userId is the only key) so up to 6 concurrent tool builds collapse to one
  // prefs round-trip instead of starving the shared Prisma pool.
  const prefsRow = await memoizePerRequest(`coach-prefs:${userId}`, () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        coachPrefsJson: true,
        timezone: true,
        locale: true,
        // v1.11.5 — needed to collapse a dual-source sleep night to one
        // canonical source before reconstructing per-night asleep totals.
        sourcePriorityJson: true,
        // v1.15 — the cycle snapshot block is gated on the resolved cycle
        // toggle (an explicit opt-in/out overrides the gender default). Read
        // both columns here so a non-cycle account pays no extra round-trip.
        gender: true,
        cycleProfile: { select: { cycleTrackingEnabled: true } },
        // v1.16.16 — the glucose block converts canonical mg/dL to the user's
        // display unit so the Coach reads the same number every other surface
        // shows. Read it on this existing prefs hop (no extra round-trip).
        glucoseUnit: true,
        // The metric/imperial choice: the grounding bands and the blocks
        // that carry a mass, length or temperature are written in it.
        unitPreference: true,
        // v1.18.6 (W7) — the explicit, user-declared diabetes opt-in. Selects
        // the tighter ADA glycemic GOAL band for the glucose reference-grounding
        // line only; never inferred from a reading, never a diagnosis. Read on
        // this existing prefs hop (no extra round-trip).
        hasDiabetes: true,
      },
    }),
  );
  const prefs = parseCoachPrefs(prefsRow?.coachPrefsJson);
  // Resolve the UI locale for the rolling-profile narrative recall. The
  // narrative rows are keyed by the full UI locale union, so the stored value
  // is carried through as-is; an unset or unknown value falls back to the app
  // default (`en`), never to German. The former `=== "en" ? "en" : "de"`
  // binary made a French account recall a German narrative row.
  const coachLocale: Locale = locales.includes(prefsRow?.locale as Locale)
    ? (prefsRow?.locale as Locale)
    : defaultLocale;
  const clusterDefault = clusterSourcesFromPrefs(prefs.dataClusters);
  const { sources: scopedSources, window: requestedWindow } = resolveScope(
    scope,
    clusterDefault,
  );
  const window = clampWindow(requestedWindow, reach);
  const userTz = prefsRow?.timezone ?? DEFAULT_TIMEZONE;
  const units = resolveUnitPreferences({
    unitPreference: prefsRow?.unitPreference,
    glucoseUnit: prefsRow?.glucoseUnit,
  });
  // v1.18.0 — fold disabled data-domain modules into the system exclusion.
  // `moduleMap[key] === false` means the user turned that module off; the
  // gate has already resolved every delegation (cycle/coach) so this map
  // is authoritative. We union the disabled modules' owned sources into
  // `excluded` so the existing source-narrowing path below removes them
  // before any row is read — the model never sees a disabled domain.
  const moduleMap = await moduleMapPromise;
  const excluded = coachExclusions(prefs, moduleMap);
  const sources = admitCoachSources(scopedSources, excluded);
  return {
    prefsRow,
    coachLocale,
    window,
    userTz,
    units,
    recoveryDisabled: moduleMap.recovery === false,
    excluded,
    sources,
  };
}

/**
 * The window cutoffs a build reads under, and the per-source cutoff the
 * additive (non-core) blocks use once many clusters are active.
 */
export function resolveSnapshotCutoffs(
  sources: ReadonlySet<CoachScopeSource>,
  window: CoachScopeWindow,
  now: Date,
) {
  const windowDays = windowToDays(window);
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(
    now.getTime() - DAILY_TIMELINE_DAYS * 24 * 60 * 60 * 1000,
  );

  // v1.7.0 — when many clusters are active, cap the timeline read
  // window for the ADDITIVE (non-core) clusters so a 10-cluster /
  // allTime request cannot fan a dense timeline across every series at
  // once. The core clinical clusters keep the user-chosen window.
  const activeClusters = new Set<CoachDataCluster>();
  for (const src of sources) {
    const c = sourceCluster(src);
    if (c) activeClusters.add(c);
  }
  const multiClusterCapActive = activeClusters.size > MULTI_CLUSTER_THRESHOLD;
  const additiveCapDays = windowToDays(MULTI_CLUSTER_WINDOW_CAP);
  const additiveCapCutoff = new Date(
    now.getTime() - additiveCapDays * 24 * 60 * 60 * 1000,
  );
  // Effective `cutoff` for an additive block under the multi-cluster
  // cap — the later of the window cutoff and the cap cutoff. Core
  // clusters always use the full window cutoff.
  const additiveCutoff = (source: CoachScopeSource): Date => {
    const cluster = sourceCluster(source);
    if (
      multiClusterCapActive &&
      cluster !== null &&
      !CORE_CLUSTERS.has(cluster) &&
      additiveCapCutoff > cutoff
    ) {
      return additiveCapCutoff;
    }
    return cutoff;
  };
  return {
    windowDays,
    cutoff,
    recentCutoff,
    activeClusters,
    multiClusterCapActive,
    additiveCutoff,
  };
}

/**
 * The windowed measurement read the timeline blocks share.
 *
 * Single fetch for all measurement types — Prisma's filter pushes
 * the type list into one SQL `WHERE type IN (…)` so we don't pay
 * per-metric round-trips.
 */
export function readSnapshotMeasurementRows(
  userId: string,
  wantedTypes: readonly MeasurementType[],
  cutoff: Date,
) {
  if (wantedTypes.length === 0) return Promise.resolve([]);
  return (
    prisma.measurement
      .findMany({
        where: {
          userId,
          type: { in: [...wantedTypes] },
          measuredAt: { gte: cutoff },
          deletedAt: null,
        },
        // v1.18.10 (P-2) — read NEWEST-first + cap. PULSE / glucose are
        // 200k-row-class types and the window can reach 365 days
        // (lastYear / allTime), so an uncapped read pulled the entire
        // year of high-frequency rows into memory just to fold them into
        // ~21 daily + ~10 weekly buckets the prompt actually shows. The
        // newest-first cap keeps the recent-daily timeline exact and only
        // sheds the deepest weekly buckets on an extreme-volume account;
        // the coarse MONTH/YEAR tail is read separately from the rollup
        // tier (`buildCoarseTimelineTail`), so deep history survives.
        orderBy: { measuredAt: "desc" },
        take: SNAPSHOT_MEASUREMENT_ROW_CAP,
        // v1.7.0 — `glucoseContext` rides along so the glucose block
        // can split fasting / postprandial / random / bedtime without
        // a second query. NULL on every non-glucose row.
        select: {
          type: true,
          value: true,
          measuredAt: true,
          glucoseContext: true,
        },
      })
      // Downstream bucketers re-sort/group internally, but restore
      // ascending order so any order-sensitive consumer sees the same
      // shape as before the cap.
      .then((rows) => rows.reverse())
  );
}

/**
 * Sleep-stage rows from `since` on, with the writer columns the canonical
 * dedup needs. Writer-level collapse: two HealthKit apps behind one source
 * (watch stages vs phone in-bed) must not blend into one night.
 */
export function readSleepStageRows(userId: string, since: Date) {
  return prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION" as never,
      measuredAt: { gte: since },
      deletedAt: null,
    },
    orderBy: { measuredAt: "asc" },
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });
}

/** The mood entries the mood timeline folds, tombstones excluded (v1.7.0). */
export function readSnapshotMoodRows(userId: string, since: Date) {
  return prisma.moodEntry.findMany({
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "asc" },
    select: { moodLoggedAt: true, score: true },
  });
}
