/**
 * v1.10.0 — the route-side dispatcher: `DerivedMetricId` → its pure
 * compute function → a wire-flat `Derived<unknown>`.
 *
 * The generic `/api/insights/derived` route validates `metric` against
 * the closed registry enum, then calls `computeDerivedMetric`. Wave 1
 * implements `VITALS_BASELINE` end-to-end; every other registered id is
 * a metadata stub whose compute lands in W2/W3. A stub routed before its
 * compute lands returns `insufficient` with `reason: "not_implemented"`
 * — never a fabricated value, never a 500.
 *
 * Server-only — imports the server-only compute engines.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { buildInsufficient, nowProvenanceTimestamp } from "./coverage";
import {
  getDerivedMetricMeta,
  isSameTimeBaselineType,
  isVitalsBaselineType,
  isTrajectoryType,
  type DerivedMetricId,
} from "./registry";
import { computeVitalsBaseline, type BaselineProfile } from "./baseline";
import { computeFitnessAge } from "./fitness-age";
import { computeSixMinuteWalkBand } from "./six-minute-walk";
import { computeVascularAgeDelta } from "./vascular-age";
import { computeHrvBalance } from "./hrv-balance";
import { computeBmi } from "./bmi";
import { computeSleepScore } from "./sleep-score";
import { computeReadiness, readReadinessHistory } from "./readiness";
import { computeCoincidentDeviation } from "./coincident-deviation";
import { computeTrajectory } from "./trajectory";
import { computeSameTimeBaseline } from "./same-time-baseline";
import {
  computeWellnessScore,
  type WellnessScoreType,
} from "./wellness-scores";
import type { Derived } from "./types";
import { computeHealthScoreDerived } from "@/lib/analytics/score/derived";

export interface DerivedComputeArgs {
  metric: DerivedMetricId;
  userId: string;
  profile: BaselineProfile;
  /**
   * Optional sub-target for metrics that baseline a single chosen type
   * (`VITALS_BASELINE`). Validated against the engine's supported set.
   */
  type?: string | null;
  /** Trailing window override (days). */
  windowDays?: number;
  now?: Date;
}

/** A `not_implemented` insufficient — the stub guard for W2/W3 metrics. */
function notImplemented(inputs: string[], now: Date): Derived<unknown> {
  const computedAt = nowProvenanceTimestamp(now);
  return buildInsufficient<unknown>({
    coverage: {
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: inputs,
    },
    provenance: { inputs, source: "none", windowDays: 0, computedAt },
    reason: "not_implemented",
  });
}

/**
 * Dispatch a derived-metric id to its compute function. Returns the flat
 * `Derived<unknown>` the route wraps in the standard envelope. The caller
 * has already Zod-validated `metric` against the registry enum, so an
 * unknown id never reaches here.
 */
export async function computeDerivedMetric(
  args: DerivedComputeArgs,
): Promise<Derived<unknown>> {
  const now = args.now ?? new Date();
  const meta = getDerivedMetricMeta(args.metric);
  if (!meta) {
    // Defensive — the route validates against the enum first.
    return notImplemented([], now);
  }

  if (!meta.implemented) {
    return notImplemented(meta.inputs.map(String), now);
  }

  switch (args.metric) {
    case "VITALS_BASELINE": {
      // The baseline engine needs a single chosen vital; default to
      // RESTING_HEART_RATE when the caller omits one (the catalogue's
      // canonical example).
      const requested = args.type ?? "RESTING_HEART_RATE";
      if (!isVitalsBaselineType(requested)) {
        return buildInsufficient<unknown>({
          coverage: {
            requiredInputs: 1,
            presentInputs: 0,
            historyDays: 0,
            missing: [requested],
          },
          provenance: {
            inputs: [requested],
            source: "none",
            windowDays: 0,
            computedAt: nowProvenanceTimestamp(now),
          },
          reason: "unsupported_baseline_type",
        });
      }
      return computeVitalsBaseline(args.userId, args.profile, {
        type: requested as MeasurementType,
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    }
    case "FITNESS_AGE":
      return computeFitnessAge(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "VASCULAR_AGE_DELTA":
      return computeVascularAgeDelta(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "HRV_BALANCE":
      return computeHrvBalance(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "BMI":
      return computeBmi(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "SLEEP_SCORE":
      return computeSleepScore(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "READINESS": {
      const readiness = await computeReadiness(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      });
      // The blend's course rides beside today's score for the surfaces that
      // draw it; the nightly job's own compute never pays for the read.
      if (readiness.status === "ok" && readiness.value) {
        readiness.value.series = await readReadinessHistory(
          args.userId,
          now,
          readiness.provenance.windowDays,
        );
      }
      return readiness as Derived<unknown>;
    }
    case "COINCIDENT_DEVIATION":
      return computeCoincidentDeviation(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "WRIST_TEMPERATURE_BASELINE":
    case "STAIR_ASCENT_SPEED_BASELINE":
    case "STAIR_DESCENT_SPEED_BASELINE": {
      // v1.10.3 additive HealthKit baselines — each pins ONE fixed type and
      // reuses the type-generic baseline engine unchanged (median ± k·MAD).
      // Wrist temperature is a personal-DEVIATION band (no illness/cycle
      // inference); stair ascent/descent are personal trend bands (no
      // population cutoff — stair pace is geometry-confounded). The fixed
      // type is the metric's single registered input.
      const baselineType: Record<
        | "WRIST_TEMPERATURE_BASELINE"
        | "STAIR_ASCENT_SPEED_BASELINE"
        | "STAIR_DESCENT_SPEED_BASELINE",
        MeasurementType
      > = {
        WRIST_TEMPERATURE_BASELINE: "WRIST_TEMPERATURE",
        STAIR_ASCENT_SPEED_BASELINE: "STAIR_ASCENT_SPEED",
        STAIR_DESCENT_SPEED_BASELINE: "STAIR_DESCENT_SPEED",
      };
      return computeVitalsBaseline(args.userId, args.profile, {
        type: baselineType[args.metric],
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    }
    case "SIX_MINUTE_WALK_BAND":
      return computeSixMinuteWalkBand(args.userId, args.profile, {
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    case "TRAJECTORY": {
      // Short-horizon OLS projection over a single chosen metric; defaults
      // to RESTING_HEART_RATE (the catalogue's canonical example) when the
      // caller omits one. Validated against the supported projection set —
      // any other type 422s the same way VITALS_BASELINE does.
      const requested = args.type ?? "RESTING_HEART_RATE";
      if (!isTrajectoryType(requested)) {
        return buildInsufficient<unknown>({
          coverage: {
            requiredInputs: 1,
            presentInputs: 0,
            historyDays: 0,
            missing: [requested],
          },
          provenance: {
            inputs: [requested],
            source: "none",
            windowDays: 0,
            computedAt: nowProvenanceTimestamp(now),
          },
          reason: "unsupported_trajectory_type",
        });
      }
      return computeTrajectory(args.userId, args.profile, {
        type: requested as MeasurementType,
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    }
    case "SAME_TIME_BASELINE": {
      // Today's running total against this person's own typical total at the
      // same local hour. Steps is the default because it is the case the
      // architecture structurally could not answer before, and the one the
      // request was written around.
      const requested = args.type ?? "ACTIVITY_STEPS";
      if (!isSameTimeBaselineType(requested)) {
        return buildInsufficient<unknown>({
          coverage: {
            requiredInputs: 1,
            presentInputs: 0,
            historyDays: 0,
            missing: [requested],
          },
          provenance: {
            inputs: [requested],
            source: "none",
            windowDays: 0,
            computedAt: nowProvenanceTimestamp(now),
          },
          reason: "unsupported_baseline_type",
        });
      }
      return computeSameTimeBaseline(args.userId, args.profile, {
        type: requested as MeasurementType,
        windowDays: args.windowDays,
        now,
      }) as Promise<Derived<unknown>>;
    }
    case "HEALTH_SCORE":
      return computeHealthScoreDerived(args.userId) as Promise<
        Derived<unknown>
      >;
    case "RECOVERY_SCORE":
    case "STRESS_SCORE":
    case "STRAIN_SCORE":
      // Passthrough read of the nightly-persisted COMPUTED rows — never a
      // recompute. The same `Derived<T>` contract carries the scores.
      return computeWellnessScore(
        args.metric as WellnessScoreType,
        args.userId,
        args.profile,
        { windowDays: args.windowDays, now },
      ) as Promise<Derived<unknown>>;
    default:
      // Registered + implemented but no dispatch arm — treat as a stub.
      return notImplemented(meta.inputs.map(String), now);
  }
}
