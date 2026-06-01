/**
 * v1.7.0 — cluster taxonomy for the Coach snapshot.
 *
 * The Coach used to ship a fixed five domains (BP, weight, pulse, mood,
 * medication compliance). Everything else the user stores — Apple
 * Health activity, body composition, glucose, workouts, mobility, the
 * environmental-exposure series — was either wired-but-default-off or
 * never mapped at all. This module is the single source of truth for:
 *
 *   1. cluster → `CoachScopeSource[]` expansion (`CLUSTER_SOURCES`),
 *   2. the degradation priority order the snapshot soft-cap walks
 *      (`CLUSTER_PRIORITY` / `sourceCluster`), and
 *   3. cluster resolution from saved prefs (`resolveClusters`).
 *
 * The snapshot builder owns the `CoachScopeSource → MeasurementType[]`
 * map and the per-source block emission; this module only deals in
 * clusters + sources so the two concerns stay testable in isolation.
 */
import {
  DEFAULT_COACH_CLUSTERS,
  type CoachDataCluster,
} from "@/lib/validations/coach-prefs";
import type { CoachScopeSource } from "./types";

/**
 * Cluster → the `CoachScopeSource` members it expands to. The order
 * inside each list is cosmetic; the snapshot builder owns emission
 * order. Adding a metric to a cluster is one entry here plus the
 * `SOURCE_METRIC_TYPES` / block-table entry in `snapshot.ts`.
 */
export const CLUSTER_SOURCES: Record<
  CoachDataCluster,
  ReadonlyArray<CoachScopeSource>
> = {
  cardio: [
    "bp",
    "pulse",
    "resting_hr",
    "hrv",
    "walking_hr",
    "respiratory_rate",
    "spo2",
    "pulse_wave_velocity",
    "vascular_age",
  ],
  body: [
    "weight",
    "body_fat",
    "fat_mass",
    "fat_free_mass",
    "muscle_mass",
    "lean_body_mass",
    "bone_mass",
    "total_body_water",
    "bmi",
    "visceral_fat",
  ],
  activity: ["steps", "active_energy", "flights", "distance", "vo2_max"],
  workouts: ["workouts"],
  sleep: ["sleep"],
  mood: ["mood"],
  glucose: ["glucose"],
  medication: ["compliance"],
  mobility: [
    "walking_steadiness",
    "walking_asymmetry",
    "walking_double_support",
    "walking_step_length",
    "walking_speed",
  ],
  environment: [
    "audio_env",
    "audio_headphone",
    "audio_event",
    "daylight",
    "skin_temp",
  ],
};

/**
 * Degradation priority — highest-signal clinical clusters first. When
 * the assembled snapshot exceeds the soft char-cap the builder drops
 * detail from the LOWEST-priority clusters first (tail of this list),
 * so the clusters a clinician cares about survive truncation. Used by
 * `snapshot.ts` to order its degrade passes.
 */
export const CLUSTER_PRIORITY: ReadonlyArray<CoachDataCluster> = [
  "medication",
  "cardio",
  "glucose",
  "body",
  "sleep",
  "mood",
  "activity",
  "workouts",
  "mobility",
  "environment",
];

/** Reverse map: which cluster does a source belong to. */
const SOURCE_TO_CLUSTER: Map<CoachScopeSource, CoachDataCluster> = (() => {
  const m = new Map<CoachScopeSource, CoachDataCluster>();
  for (const cluster of Object.keys(CLUSTER_SOURCES) as CoachDataCluster[]) {
    for (const source of CLUSTER_SOURCES[cluster]) {
      m.set(source, cluster);
    }
  }
  return m;
})();

/** The cluster a source belongs to, or `null` for an unmapped source. */
export function sourceCluster(
  source: CoachScopeSource,
): CoachDataCluster | null {
  return SOURCE_TO_CLUSTER.get(source) ?? null;
}

/**
 * Resolve which clusters are active. `undefined` (the user never
 * opened the picker) → the legacy default set. An explicit empty array
 * is honoured as "everything off". Unknown strings are ignored at the
 * Zod layer before they reach here.
 */
export function resolveClusters(
  clusters: ReadonlyArray<CoachDataCluster> | undefined,
): ReadonlyArray<CoachDataCluster> {
  if (clusters === undefined) return DEFAULT_COACH_CLUSTERS;
  return clusters;
}

/**
 * Expand an active-cluster list into the flat `CoachScopeSource` set
 * the snapshot builder reads. Deduplicates (sources can in principle be
 * shared across clusters) and preserves nothing about order — the
 * caller sorts where it matters.
 */
export function expandClusters(
  clusters: ReadonlyArray<CoachDataCluster>,
): Set<CoachScopeSource> {
  const out = new Set<CoachScopeSource>();
  for (const cluster of clusters) {
    for (const source of CLUSTER_SOURCES[cluster]) {
      out.add(source);
    }
  }
  return out;
}

/**
 * Convenience: expand the user's saved `dataClusters` straight to the
 * source set, applying the `undefined → default` rule.
 */
export function clusterSourcesFromPrefs(
  clusters: ReadonlyArray<CoachDataCluster> | undefined,
): Set<CoachScopeSource> {
  return expandClusters(resolveClusters(clusters));
}
