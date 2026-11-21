import type { Derived } from "@/lib/insights/derived/types";
import { convertGlucose } from "@/lib/glucose";

import type { GlycaemiaPillarInput, PillarValue } from "./types";
import {
  coverage,
  daysBetween,
  failedPillar,
  insufficientPillar,
  okPillar,
  scoreReferenceBand,
  readingSpread,
  uniqueSources,
  withinWindow,
} from "./shared";
import { median } from "@/lib/stats/central";

export const HBA1C_WINDOW_DAYS = 180;
export const FASTING_GLUCOSE_WINDOW_DAYS = 90;
export const FASTING_GLUCOSE_MIN_READINGS = 8;
const HBA1C_REFERENCE = { low: 5, high: 5.6 } as const;
export const FASTING_GLUCOSE_REFERENCE = { low: 70, high: 99 } as const;

export function computeGlycaemiaPillar(
  input: GlycaemiaPillarInput,
): Derived<PillarValue> {
  if (input.readFailed) {
    return failedPillar({
      id: "GLYCAEMIA",
      asOf: input.asOf,
      windowDays: HBA1C_WINDOW_DAYS,
    });
  }

  const freshHba1c = input.hba1c
    .filter(
      (row) =>
        row.unit.trim() === "%" &&
        withinWindow(row.at, input.asOf, HBA1C_WINDOW_DAYS),
    )
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const hba1c = freshHba1c[0];
  if (hba1c) {
    return okPillar({
      id: "GLYCAEMIA",
      source: input.source,
      asOf: input.asOf,
      windowDays: HBA1C_WINDOW_DAYS,
      coverage: coverage({
        requiredInputs: 1,
        presentInputs: 1,
        historyDays: 1,
      }),
      value: {
        score: scoreReferenceBand(
          hba1c.value,
          HBA1C_REFERENCE.low,
          HBA1C_REFERENCE.high,
        ),
        observed: {
          value: hba1c.value,
          unit: "%",
          label: `HbA1c ${hba1c.value}%`,
          asOf: hba1c.at.toISOString(),
          sources: [hba1c.source],
        },
        reference: {
          kind: "clinical-threshold",
          low: HBA1C_REFERENCE.low,
          high: HBA1C_REFERENCE.high,
          label: `${HBA1C_REFERENCE.low}–${HBA1C_REFERENCE.high}%`,
          source: "ADA 2025; Selvin 2010",
        },
        noiseFloor: 0,
        deltaEligible: false,
        deltaIdentity: "hba1c",
      },
    });
  }

  if (input.hba1cReadFailed) {
    return failedPillar({
      id: "GLYCAEMIA",
      asOf: input.asOf,
      windowDays: HBA1C_WINDOW_DAYS,
    });
  }

  const fasting = input.fastingGlucose
    .filter((row) =>
      withinWindow(row.at, input.asOf, FASTING_GLUCOSE_WINDOW_DAYS),
    )
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const historyDays = daysBetween(
    fasting[0]?.at ?? null,
    fasting.at(-1)?.at ?? null,
  );
  if (input.fastingReadFailed) {
    return failedPillar({
      id: "GLYCAEMIA",
      asOf: input.asOf,
      windowDays: FASTING_GLUCOSE_WINDOW_DAYS,
    });
  }

  if (fasting.length < FASTING_GLUCOSE_MIN_READINGS) {
    return insufficientPillar({
      id: "GLYCAEMIA",
      source: input.source,
      asOf: input.asOf,
      windowDays: FASTING_GLUCOSE_WINDOW_DAYS,
      requiredInputs: FASTING_GLUCOSE_MIN_READINGS,
      presentInputs: fasting.length,
      historyDays,
      missing: [
        `${Math.max(0, FASTING_GLUCOSE_MIN_READINGS - fasting.length)} fasting readings`,
      ],
      reason:
        input.hba1c.length > 0 || input.fastingGlucose.length > 0
          ? "below_reading_floor_or_stale"
          : "not_tracked",
    });
  }

  const values = fasting.map((row) => row.value);
  // The reading floor above guarantees readings here.
  const observed = median(values)!;
  // The behavioural/device noise convention from the design is one half of
  // within-person SD, translated onto this pillar's proportional score scale.
  const halfSd = readingSpread(values) * 0.5;
  const floorScore = scoreReferenceBand(
    Math.max(0, observed - halfSd),
    FASTING_GLUCOSE_REFERENCE.low,
    FASTING_GLUCOSE_REFERENCE.high,
  );
  const ceilingScore = scoreReferenceBand(
    observed + halfSd,
    FASTING_GLUCOSE_REFERENCE.low,
    FASTING_GLUCOSE_REFERENCE.high,
  );

  return okPillar({
    id: "GLYCAEMIA",
    source: input.source,
    asOf: input.asOf,
    windowDays: FASTING_GLUCOSE_WINDOW_DAYS,
    coverage: coverage({
      requiredInputs: FASTING_GLUCOSE_MIN_READINGS,
      presentInputs: FASTING_GLUCOSE_MIN_READINGS,
      historyDays,
    }),
    value: {
      score: scoreReferenceBand(
        observed,
        FASTING_GLUCOSE_REFERENCE.low,
        FASTING_GLUCOSE_REFERENCE.high,
      ),
      // `value`, `unit` and the band stay canonical: the score is computed on
      // them and the web converts from them. The labels are finished text a
      // client prints as-is, so they are written in the reader's unit.
      observed: {
        value: observed,
        unit: "mg/dL",
        label: `Fasting median ${convertGlucose(observed, input.glucoseUnit)} ${input.glucoseUnit}`,
        asOf: fasting.at(-1)!.at.toISOString(),
        sources: uniqueSources(fasting.map((row) => row.source)),
      },
      reference: {
        kind: "clinical-threshold",
        low: FASTING_GLUCOSE_REFERENCE.low,
        high: FASTING_GLUCOSE_REFERENCE.high,
        label: `${convertGlucose(FASTING_GLUCOSE_REFERENCE.low, input.glucoseUnit)}–${convertGlucose(FASTING_GLUCOSE_REFERENCE.high, input.glucoseUnit)} ${input.glucoseUnit} fasting`,
        source: "ADA 2025; Selvin 2010",
      },
      noiseFloor: Math.max(1, Math.abs(ceilingScore - floorScore)),
      deltaEligible: true,
      deltaIdentity: "fasting_glucose",
    },
  });
}
