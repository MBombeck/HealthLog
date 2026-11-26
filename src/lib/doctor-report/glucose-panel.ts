/**
 * The glucose clinical panel derived from pre-aggregated buckets.
 *
 * TIR / GMI / eA1C / CV% over the whole report period, computed by the same
 * literature-locked engine the insights panel and the coach consume. The
 * learning gate keeps a thin period from asserting a clinical picture off spot
 * data: too few readings, or too short a span, and the panel says so rather
 * than producing a number that reads as authoritative.
 *
 * Split out of the aggregator with the selection rework — it is a self-
 * contained numeric job with its own literature behind it.
 */
import {
  CV_INSTABILITY_THRESHOLD,
  estimatedA1c,
  gmi,
  servedIndex,
  servedVariability,
  type GlucoseClinicalMetrics,
} from "@/lib/analytics/glucose-metrics";
import type { DenseMeasurementBucket } from "./dense-buckets";

export function emptyGlucoseClinical(
  windowDays: number,
): GlucoseClinicalMetrics {
  return {
    stillLearning: true,

    stillLearningReason: `No glucose readings in the last ${windowDays} days.`,
    windowDays,
    actualSpanDays: 0,
    readingCount: 0,
    meanMgdl: null,
    distribution: null,
    gmi: null,
    estimatedA1c: null,
    variability: null,
    advanced: null,
    isSpotEstimate: true,
  };
}

export function glucoseClinicalFromBuckets(
  buckets: readonly DenseMeasurementBucket[],
  windowDays: number,
): GlucoseClinicalMetrics {
  let count = 0;
  let sum = 0;
  let sumSquares = 0;
  let firstAt: Date | null = null;
  let lastAt: Date | null = null;
  let tir = 0;
  let tbr1 = 0;
  let tbr2 = 0;
  let tar1 = 0;
  let tar2 = 0;
  let lowRisk = 0;
  let highRisk = 0;

  for (const bucket of buckets) {
    if (bucket.type !== "BLOOD_GLUCOSE" || bucket.clinicalCount === 0) {
      continue;
    }
    count += bucket.clinicalCount;
    sum += bucket.clinicalSum ?? 0;
    sumSquares += bucket.clinicalSumSquares ?? 0;
    tir += bucket.clinicalTirCount;
    tbr1 += bucket.clinicalTbr1Count;
    tbr2 += bucket.clinicalTbr2Count;
    tar1 += bucket.clinicalTar1Count;
    tar2 += bucket.clinicalTar2Count;
    lowRisk += bucket.clinicalLowRiskSum ?? 0;
    highRisk += bucket.clinicalHighRiskSum ?? 0;
    if (
      bucket.clinicalFirstAt &&
      (!firstAt || bucket.clinicalFirstAt < firstAt)
    ) {
      firstAt = bucket.clinicalFirstAt;
    }
    if (bucket.clinicalLastAt && (!lastAt || bucket.clinicalLastAt > lastAt)) {
      lastAt = bucket.clinicalLastAt;
    }
  }

  if (count === 0 || !firstAt || !lastAt) {
    return emptyGlucoseClinical(windowDays);
  }

  const meanMgdl = sum / count;
  const actualSpanDays =
    (lastAt.getTime() - firstAt.getTime()) / (24 * 60 * 60 * 1000);
  const variance =
    count >= 2
      ? Math.max(0, (sumSquares - (sum * sum) / count) / (count - 1))
      : null;
  const sd = variance === null ? null : Math.sqrt(variance);
  const cv = sd === null || meanMgdl === 0 ? null : (sd / meanMgdl) * 100;
  const fraction = (n: number) => n / count;
  const minutes = (n: number) => fraction(n) * 1440;
  const roundedSpan = Math.max(0, Math.round(actualSpanDays));
  let stillLearningReason: string | null = null;
  if (count < 14) {
    stillLearningReason = `Still learning — ${count} reading${
      count === 1 ? "" : "s"
    } over ${roundedSpan} day${
      roundedSpan === 1 ? "" : "s"
    }; at least 14 are needed for a meaningful estimate.`;
  } else if (actualSpanDays < 7) {
    stillLearningReason = `Still learning — readings span only ${roundedSpan} day${
      roundedSpan === 1 ? "" : "s"
    }; at least 7 days of coverage are needed.`;
  }

  return {
    stillLearning: stillLearningReason !== null,
    stillLearningReason,
    windowDays,
    actualSpanDays,
    readingCount: count,
    meanMgdl,
    distribution: {
      tir: fraction(tir),
      tbrLevel1: fraction(tbr1),
      tbrLevel2: fraction(tbr2),
      tarLevel1: fraction(tar1),
      tarLevel2: fraction(tar2),
      minutesEquivalent: {
        tir: minutes(tir),
        tbrLevel1: minutes(tbr1),
        tbrLevel2: minutes(tbr2),
        tarLevel1: minutes(tar1),
        tarLevel2: minutes(tar2),
      },
    },
    gmi: gmi(meanMgdl),
    estimatedA1c: estimatedA1c(meanMgdl),
    // Served through the same rounding as the per-reading engine: these risk
    // sums come out of Postgres in bucket order, so their last bits are not
    // the ones the engine would produce from the readings.
    variability:
      sd === null || cv === null
        ? null
        : servedVariability({
            sd,
            cv,
            unstable: cv >= CV_INSTABILITY_THRESHOLD,
          }),
    advanced: {
      jIndex: servedIndex(sd === null ? null : 0.001 * (meanMgdl + sd) ** 2),
      lbgi: servedIndex(lowRisk / count),
      hbgi: servedIndex(highRisk / count),
    },
    isSpotEstimate: count / Math.max(actualSpanDays, 1) < 24,
  };
}
