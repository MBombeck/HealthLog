/**
 * The trend point a screener administration projects onto the measurements.
 *
 * A `MentalHealthAssessment` is the one record of an administration; its
 * total also rides a `PHQ9_SCORE` / `GAD7_SCORE` / … Measurement so the chart,
 * rollup and doctor-report reads see the trend without ever touching the
 * encrypted item answers. The row is `COMPUTED` (clients cannot attribute
 * that source on any write surface, so a forged trend point cannot enter
 * through the measurement POST or the batch) and keyed `assessment:<id>`, so
 * it belongs to exactly one administration.
 *
 * Both writers of an administration go through here: the questionnaire POST
 * and the Apple Health scored assessment on the measurement batch. One write
 * path means the two cannot drift into counting a screener twice or
 * forgetting the rollup tail for one of them.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { invalidateUserHealthScore } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";

import { INSTRUMENT_MEASUREMENT_TYPE, type InstrumentId } from "./instruments";

/** The externalId of the projection row that belongs to an administration. */
function assessmentProjectionExternalId(assessmentId: string): string {
  return `assessment:${assessmentId}`;
}

export async function writeAssessmentScoreProjection(args: {
  userId: string;
  instrument: InstrumentId;
  assessmentId: string;
  total: number;
  takenAt: Date;
}): Promise<void> {
  const type = INSTRUMENT_MEASUREMENT_TYPE[args.instrument] as MeasurementType;
  await prisma.measurement.create({
    data: {
      userId: args.userId,
      type,
      value: args.total,
      unit: "score",
      source: "COMPUTED",
      measuredAt: args.takenAt,
      notes: null,
      externalId: assessmentProjectionExternalId(args.assessmentId),
    },
  });
  invalidateUserHealthScore(args.userId);

  // The projection is a Measurement like any other: the (type, day) rollup
  // bucket and the cached status assessment converge now rather than at the
  // nightly discovery pass.
  await afterMeasurementMutation(
    args.userId,
    [{ type, measuredAt: args.takenAt }],
    { source: "manual" },
  );
}
