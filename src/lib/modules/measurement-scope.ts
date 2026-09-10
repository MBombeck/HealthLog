/**
 * v1.30.22 — the ONE table of "which module owns which data domain".
 *
 * Before this file the ownership map lived as a private const inside the
 * Coach snapshot builder, which made it reachable only by reads that route
 * through `buildCoachSnapshot`. Three read families deliberately bypass the
 * snapshot (the MCP rich reads, the correlations reader, the doctor-report
 * aggregate) and therefore inherited no gating at all — the module toggle and
 * the operator kill-switch above it were silently defeated on the one wire
 * that egresses to a third party.
 *
 * The fix is to hold the ownership map at the READ level rather than at each
 * call site: a read resolves its metric, asks this table who owns it, and
 * gates. A future read family that resolves a metric therefore cannot land
 * ungated without deliberately skipping the resolver.
 *
 * Two layers, matching how the metric registries are actually split:
 *
 *   1. `MODULE_SCOPED_SOURCES` — module key → the Coach scope-source tokens
 *      it owns. This is the map the snapshot builder has always used to
 *      narrow its sources; it now lives here and the builder imports it, so
 *      there is exactly one definition.
 *   2. `METRIC_STATUS_MODULE_OWNERS` — the reviewed ownership entries for the
 *      metric-status-only ids, which carry no signal-registry scope of their
 *      own and so cannot be derived from layer 1.
 *
 * `moduleForMeasurementType()` unions both and is keyed on `MeasurementType`
 * because that is what every resolution path in the rich reads produces and
 * what the underlying rollup query actually reads.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { allSignals } from "@/lib/signals/registry";
import type { ModuleKey } from "./registry";

/**
 * Module key → the Coach scope-source tokens that module owns.
 *
 * `cycle` is intentionally absent: its block resolves through the fully
 * two-layer cycle gate (`isCycleAvailableForUser` — the per-user toggle AND
 * the operator server-wide kill-switch) wherever it is read, so folding it in
 * here would double-gate. `coach` is the surface being narrated, not a data
 * domain. `labs` / `achievements` / `insights` / `doctorReport` own no
 * measurement-level data domain — they gate whole surfaces instead, which is
 * why the correlations reader and the doctor-report aggregate gate on their
 * module key directly rather than through this table.
 */
export const MODULE_SCOPED_SOURCES: Partial<Record<ModuleKey, string[]>> = {
  mood: ["mood"],
  sleep: ["sleep"],
  glucose: ["glucose"],
  workouts: ["workouts"],
  recovery: ["hrv", "resting_hr", "vo2_max"],
  // The environment/exposure cluster owns exactly these sources (mirrors
  // `CLUSTER_SOURCES.environment` in coach/clusters.ts). When the opt-in
  // environment module is off, its audio-exposure / daylight / skin-temperature
  // blocks are stripped so no disabled domain is ever read.
  environment: [
    "audio_env",
    "audio_headphone",
    "audio_event",
    "daylight",
    "skin_temp",
  ],
};

/** Inverse of {@link MODULE_SCOPED_SOURCES}: scope-source token → owning module. */
const OWNER_BY_SOURCE: ReadonlyMap<string, ModuleKey> = (() => {
  const out = new Map<string, ModuleKey>();
  for (const [key, sources] of Object.entries(MODULE_SCOPED_SOURCES)) {
    for (const src of sources ?? []) {
      out.set(src, key as ModuleKey);
    }
  }
  return out;
})();

/**
 * Reviewed ownership for the metric-status-only ids — the derived metrics that
 * exist in the metric-status registry but carry `coachSnapshot: false` in the
 * signal registry, so layer 1 cannot reach them. Each entry is a deliberate,
 * human-named assignment: the metric is a direct product of that module's
 * domain, so an account with the module off must not see it.
 *
 *   - SLEEP_SCORE / BREATHING_DISTURBANCES — computed from the sleep record.
 *   - DAY_STRAIN / WORKOUT_STRAIN / CARDIO_LOAD — training-load metrics that
 *     exist only because workouts are tracked.
 *   - ANS_CHARGE / CARDIO_RECOVERY — autonomic recovery scores, the same
 *     domain `recovery` already owns via hrv / resting_hr / vo2_max.
 *
 * Deliberately NOT assigned an owner (see `UNSCOPED_REVIEWED_TYPES` below):
 * ids whose domain no module actually claims. Guessing an owner there would
 * hide a metric behind a toggle the user never associated with it.
 */
const METRIC_STATUS_MODULE_OWNERS: Partial<Record<MeasurementType, ModuleKey>> =
  {
    SLEEP_SCORE: "sleep",
    BREATHING_DISTURBANCES: "sleep",
    DAY_STRAIN: "workouts",
    WORKOUT_STRAIN: "workouts",
    CARDIO_LOAD: "workouts",
    ANS_CHARGE: "recovery",
    CARDIO_RECOVERY: "recovery",
    // The HRV fallback type. `resolveRichMetricForUser` swaps HRV to its RMSSD
    // fallback for an account that only has ring/strap nightly RMSSD rows, so
    // leaving this unowned would have let the fallback path serve exactly the
    // recovery data the primary type refuses. Caught by the structural test.
    HRV_RMSSD: "recovery",
  };

/**
 * Measurement types that resolve over the rich reads but that NO module owns —
 * reviewed and deliberately ungated.
 *
 * These are not an oversight and not a backlog: they are the domains the
 * module model has never claimed. The Coach snapshot does not narrow any of
 * them either (none of their scope tokens appears in
 * {@link MODULE_SCOPED_SOURCES}), so gating them here would make the MCP wire
 * STRICTER than the app and the Coach — hiding data behind a toggle the user
 * never associated with it. Grouped by why:
 *
 *   - Core clinical figures every account carries: weight, pulse, blood
 *     pressure, BMI, body temperature.
 *   - Body composition: fat / lean / muscle / bone / water / visceral.
 *   - Activity volume: steps, distance, flights, active energy. Owned by no
 *     module — `workouts` gates workout SESSIONS, not ambient movement.
 *   - Gait and mobility, incl. the fall / walk-test / stair metrics.
 *   - Cardio-vascular readings with no module home: SpO2, respiratory rate,
 *     walking HR, pulse-wave velocity, vascular age, avg/max HR.
 *   - v1.25 clinical signals: grip strength, pain NRS, waist measures.
 *   - WRIST_TEMPERATURE and ENERGY_EXPENDITURE_KJ: plausible arguments exist
 *     for `sleep` and `workouts` respectively, but neither module claims them
 *     anywhere else in the tree, and guessing an owner would hide a metric
 *     behind an unrelated toggle. Left unowned deliberately rather than
 *     assigned on a hunch.
 *
 * This set exists so the structural test can distinguish "reviewed as
 * unscoped" from "nobody has looked at this yet" — a new resolvable metric
 * that is neither owned nor listed here fails the test.
 */
export const UNSCOPED_REVIEWED_TYPES: ReadonlySet<MeasurementType> =
  new Set<MeasurementType>([
    // Core clinical.
    "WEIGHT",
    "PULSE",
    "BODY_MASS_INDEX",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "BODY_TEMPERATURE",
    // Body composition.
    "BODY_FAT",
    "FAT_MASS",
    "FAT_FREE_MASS",
    "LEAN_BODY_MASS",
    "MUSCLE_MASS",
    "BONE_MASS",
    "TOTAL_BODY_WATER",
    "VISCERAL_FAT",
    // Ambient activity volume (not workout sessions).
    "ACTIVITY_STEPS",
    "WALKING_RUNNING_DISTANCE",
    "FLIGHTS_CLIMBED",
    "ACTIVE_ENERGY_BURNED",
    "ENERGY_EXPENDITURE_KJ",
    // Gait / mobility.
    "WALKING_SPEED",
    "WALKING_STEADINESS",
    "WALKING_ASYMMETRY",
    "WALKING_DOUBLE_SUPPORT",
    "WALKING_STEP_LENGTH",
    "FALL_COUNT",
    "SIX_MINUTE_WALK_DISTANCE",
    "STAIR_ASCENT_SPEED",
    "STAIR_DESCENT_SPEED",
    // Cardio-vascular with no module home.
    "OXYGEN_SATURATION",
    "RESPIRATORY_RATE",
    "WALKING_HEART_RATE_AVERAGE",
    "PULSE_WAVE_VELOCITY",
    "VASCULAR_AGE",
    "AVERAGE_HEART_RATE",
    "MAX_HEART_RATE",
    // v1.25 clinical signals.
    "GRIP_STRENGTH",
    "PAIN_NRS",
    "WAIST_CIRCUMFERENCE",
    "WAIST_TO_HEIGHT",
    // Temperature with a plausible but unclaimed owner.
    "WRIST_TEMPERATURE",
  ]);

/**
 * Layer 1, derived once: `MeasurementType` → owning module, via the signal
 * registry's `coachSnapshot.scope` token and {@link OWNER_BY_SOURCE}. Derived
 * rather than hand-listed so a signal that changes its scope cannot drift out
 * of sync with the snapshot builder's narrowing.
 */
const OWNER_BY_MEASUREMENT_TYPE: ReadonlyMap<MeasurementType, ModuleKey> =
  (() => {
    const out = new Map<MeasurementType, ModuleKey>();
    for (const sig of allSignals()) {
      if (sig.kind !== "measurement") continue;
      if (sig.surfaces.coachSnapshot === false) continue;
      const owner = OWNER_BY_SOURCE.get(sig.surfaces.coachSnapshot.scope);
      if (owner) out.set(sig.source.measurementType, owner);
    }
    for (const [type, owner] of Object.entries(METRIC_STATUS_MODULE_OWNERS)) {
      if (owner) out.set(type as MeasurementType, owner);
    }
    return out;
  })();

/**
 * The module that owns `type`, or `null` when no module claims it.
 *
 * A `null` here means "read it ungated" — it is NOT a fail-open default for
 * unknown input, because the caller has already resolved `type` through the
 * closed metric resolver before asking. The structural test in
 * `__tests__/measurement-scope.test.ts` pins the set of types that may
 * legitimately answer `null`.
 */
export function moduleForMeasurementType(
  type: MeasurementType,
): ModuleKey | null {
  return OWNER_BY_MEASUREMENT_TYPE.get(type) ?? null;
}

/**
 * The inverse: every measurement type `key` owns, or an empty list for a
 * module that owns no measurement-level domain.
 *
 * Derived from the same map {@link moduleForMeasurementType} answers from, so
 * the two can never disagree about who owns what. Read by the setup flow's
 * derivation, which asks "does this record already hold data in that domain"
 * before it switches a module off.
 */
export function measurementTypesOwnedBy(key: ModuleKey): MeasurementType[] {
  const out: MeasurementType[] = [];
  for (const [type, owner] of OWNER_BY_MEASUREMENT_TYPE) {
    if (owner === key) out.push(type);
  }
  return out;
}
