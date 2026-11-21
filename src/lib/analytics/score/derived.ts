import type { Derived } from "@/lib/insights/derived/types";
import { prisma } from "@/lib/db";
import { computeBpInTargetFastPath } from "@/lib/analytics/bp-in-target-fast-path";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { resolveModuleMap } from "@/lib/modules/gate";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { resolveGlucoseUnit } from "@/lib/glucose";

import { computeAndRecordUserHealthScore } from "./record";
import type { CompositeValue } from "./types";

const DAY_MS = 86_400_000;

/** Load the same full Health Score composite served by the analytics surfaces. */
export async function computeHealthScoreDerived(
  userId: string,
): Promise<Derived<CompositeValue>> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      dateOfBirth: true,
      heightCm: true,
      timezone: true,
      thresholdsJson: true,
      healthScoreConfigJson: true,
      glucoseUnit: true,
    },
  });
  const now = new Date();
  const timezone = user.timezone ?? DEFAULT_TIMEZONE;
  const bpTargets = getBpTargets(user.dateOfBirth, timezone);
  const bpAt = (at: Date) =>
    bpTargets
      ? computeBpInTargetFastPath({
          userId,
          targets: bpTargets,
          now: at,
          userTz: timezone,
        })
      : Promise.resolve(null);
  const [
    modules,
    sourcePriorityJson,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
  ] = await Promise.all([
    resolveModuleMap(userId),
    loadUserSourcePriority(userId),
    bpAt(now),
    bpAt(new Date(now.getTime() - 7 * DAY_MS)),
    bpAt(new Date(now.getTime() - 14 * DAY_MS)),
  ]);
  const report = await computeAndRecordUserHealthScore({
    userId,
    now,
    profile: {
      dateOfBirth: user.dateOfBirth,
      heightCm: user.heightCm,
      timezone,
      sourcePriorityJson,
      thresholdsJson: user.thresholdsJson,
      glucoseUnit: resolveGlucoseUnit(user.glucoseUnit),
    },
    modules: {
      glucose: modules.glucose !== false,
      labs: modules.labs !== false,
      sleep: modules.sleep !== false,
      mentalHealth: modules.mentalHealth !== false,
    },
    healthScoreConfigJson: user.healthScoreConfigJson,
    bpTargets,
    bpEnvelope,
    bpEnvelopePriorWeek,
    bpEnvelopePriorTwoWeeks,
  });
  return report.composite;
}
