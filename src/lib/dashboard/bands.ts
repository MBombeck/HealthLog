/**
 * Dashboard band / target math — the single source of truth.
 *
 * Pure projection over a user's profile facts (DOB / gender / height):
 * no DB read, no clock, no network, no `server-only` dep. Every building
 * block it composes (`@/lib/analytics/{value-bands,bp-targets,pulse-targets}`)
 * is itself client-safe, so this leaf imports cleanly into both the
 * server-side snapshot builder (`@/lib/dashboard/snapshot`) and the
 * `"use client"` dashboard page fallback (`src/app/page.tsx`).
 *
 * Before v1.18.6 the band construction lived inline in two places — the
 * snapshot builder and the page's snapshot-disabled fallback — so a
 * threshold change had to be mirrored by hand or the two surfaces would
 * grade the same metric differently. Both now call `buildDashboardBands`,
 * so the band/target math lives in exactly one place. `buildTargetBands`
 * is kept as an alias for the snapshot-era import sites.
 */
import type { BpTargets } from "@/lib/analytics/bp-targets";
import {
  buildBandsFromTrafficRange,
  buildTrafficLightBands,
  buildTrafficRange,
  buildWeightRangeFromHeight,
  getBodyFatTargetRange,
  type ValueBand,
  type TrafficRange,
} from "@/lib/analytics/value-bands";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import { binaryReferenceSex, type ProfileSex } from "@/lib/profile/sex";
import {
  getEffectiveRange,
  METRIC_BOUNDS,
  resolveEffectiveBpTargets,
  resolveThresholdOverride,
  type ThresholdMetric,
} from "@/lib/analytics/effective-range";

export interface DashboardTargetBands {
  /**
   * BP target numbers: the user's own band where they set one, else the age
   * default. Null when neither exists (no target and no DOB).
   */
  bpTargets: BpTargets | null;
  /** Systolic traffic range, same precedence (null without target or DOB). */
  bpSysRange: TrafficRange | null;
  /** Diastolic traffic range, same precedence (null without target or DOB). */
  bpDiaRange: TrafficRange | null;
  /**
   * Resting-pulse display range: the user's own target, else the
   * age / sex percentile band (AHA fallback). Always present.
   */
  pulseDisplayRange: {
    greenMin: number;
    greenMax: number;
    orangeMin: number;
    orangeMax: number;
  };
  /** Resting-pulse chart bands (always present — AHA fallback). */
  pulseBands: ValueBand[];
  /** Body-fat target range: own target, else gender-aware. Always present. */
  bodyFatRange: { min: number; max: number };
  /** Body-fat chart bands (always present). */
  bodyFatBands: ValueBand[];
  /**
   * Weight traffic range — the user's own target band when they set one,
   * else the height-derived WHO band, else null (no height, no target).
   */
  weightRange: TrafficRange | null;
  /** Weight chart bands, from the same range. Null when the range is null. */
  weightBands: ValueBand[] | null;
}

/**
 * Resolve the band / target math from a user's profile facts. Pure; no
 * DB read. The snapshot builder and the page fallback both call this so
 * they produce byte-identical numbers.
 *
 * `thresholdsJson` is the user's own targets blob as stored in
 * `User.thresholdsJson` (`null` when there is none). Every metric the dashboard
 * shades and that accepts a personal target reads it: weight, blood pressure,
 * resting pulse and body fat. A target the person set replaces the computed
 * default on both the tile's range and the chart's bands, so a shaded zone
 * never ignores an answer given on `/targets`. Each override goes through
 * `getEffectiveRange`, so its orange wings match the `/targets` page and the
 * doctor report rather than a second convention. A metric without an override
 * keeps exactly the band it drew before. Required rather than optional so
 * every call site is named by the compiler.
 *
 * v1.34 introduced this for weight alone; the other three kept the age / sex
 * default regardless of the person's own target until v1.44.1.
 */
export function buildDashboardBands(profile: {
  dateOfBirth: Date | null;
  gender: ProfileSex;
  heightCm: number | null;
  thresholdsJson: unknown;
}): DashboardTargetBands {
  const rangeProfile = {
    heightCm: profile.heightCm,
    dateOfBirth: profile.dateOfBirth,
    gender: profile.gender,
  };
  const ownTarget = (metric: ThresholdMetric) =>
    resolveThresholdOverride(profile.thresholdsJson, metric);
  const ownRange = (metric: ThresholdMetric): TrafficRange | null => {
    const override = ownTarget(metric);
    return override
      ? getEffectiveRange(metric, rangeProfile, { [metric]: override }).range
      : null;
  };

  const bpTargets = resolveEffectiveBpTargets(
    rangeProfile,
    profile.thresholdsJson,
  );
  const pulseAge = getAgeFromDateOfBirth(profile.dateOfBirth);
  // The percentile and body-fat tables carry two sexes and no third row;
  // both helpers answer a null with a neutral midpoint rather than a side.
  const referenceSex = binaryReferenceSex(profile.gender);
  const defaultPulse = getPersonalizedPulseTarget(pulseAge, referenceSex);
  const pulseRange: TrafficRange = ownRange("PULSE") ?? {
    greenMin: defaultPulse.greenMin,
    greenMax: defaultPulse.greenMax,
    orangeMin: defaultPulse.orangeMin,
    orangeMax: defaultPulse.orangeMax,
  };
  const ownBodyFat = ownRange("BODY_FAT");
  const bodyFatRange = ownBodyFat
    ? { min: ownBodyFat.greenMin, max: ownBodyFat.greenMax }
    : getBodyFatTargetRange(referenceSex);
  // No height and no target → no weight band at all, unchanged.
  const weightRange =
    ownRange("WEIGHT") ??
    (profile.heightCm ? buildWeightRangeFromHeight(profile.heightCm) : null);
  const weightBands = weightRange
    ? buildBandsFromTrafficRange(weightRange, {
        lowerBound: METRIC_BOUNDS.WEIGHT.min,
        upperBound: 250,
      })
    : null;
  // The tile colours a reading against the same band the chart shades: the
  // person's own range with its effective wings, else the age default's.
  const bpSysRange =
    ownRange("BLOOD_PRESSURE_SYS") ??
    (bpTargets ? buildTrafficRange(bpTargets.sysLow, bpTargets.sysHigh) : null);
  const bpDiaRange =
    ownRange("BLOOD_PRESSURE_DIA") ??
    (bpTargets ? buildTrafficRange(bpTargets.diaLow, bpTargets.diaHigh) : null);
  const pulseBands = buildBandsFromTrafficRange(pulseRange, {
    lowerBound: 30,
    upperBound: 220,
  });
  const bodyFatBands = ownBodyFat
    ? buildBandsFromTrafficRange(ownBodyFat, { lowerBound: 2, upperBound: 55 })
    : buildTrafficLightBands(bodyFatRange.min, bodyFatRange.max, {
        lowerBound: 2,
        upperBound: 55,
      });
  return {
    bpTargets,
    bpSysRange,
    bpDiaRange,
    pulseDisplayRange: pulseRange,
    pulseBands,
    bodyFatRange,
    bodyFatBands,
    weightRange,
    weightBands,
  };
}

// The snapshot builder re-exports `buildDashboardBands` under the historic
// `buildTargetBands` name (see dashboard/snapshot.ts) so callers and the
// parity test keep working without a duplicate export living in this file.

/** The profile facts `buildDashboardBands` derives a band from. */
export interface BandProfile {
  dateOfBirth: Date | null;
  gender: ProfileSex;
  heightCm: number | null;
  thresholdsJson: unknown;
}

/**
 * Which profile the dashboard's CLIENT-side band fallback may compute from.
 *
 * The fallback exists because the server-resolved bands arrive with the
 * snapshot and the charts have to draw before that: it recomputes the same
 * numbers from the profile the page already holds. That profile comes from
 * `/api/auth/me`, which is an actor surface — it answers about the person
 * logged in and deliberately never about the record they are acting on. So
 * while a switch is active it describes the DELEGATE, and drawing a band from
 * it puts one person's reference ranges over another person's readings: a
 * thirty-year-old helper's blood-pressure target shading an eighty-year-old's
 * chart, which looks like a reading and is not one.
 *
 * Under a switch this therefore answers with nothing. The charts render
 * unshaded until the snapshot's own bands land, and unshaded is honest —
 * an absent band says nothing, while a borrowed one says something false.
 *
 * A pure function rather than three ternaries at the call site, because this
 * is the whole of the decision and it should be possible to state it, test it,
 * and break it in one place.
 */
export function viewerBandProfile(
  profile: BandProfile,
  inSharedRecord: boolean,
): BandProfile {
  if (!inSharedRecord) return profile;
  return {
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    thresholdsJson: null,
  };
}
