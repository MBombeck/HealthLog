import type { Derived } from "@/lib/insights/derived/types";
import { prisma } from "@/lib/db";
import { computeBpInTargetFastPath } from "@/lib/analytics/bp-in-target-fast-path";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { resolveModuleMap } from "@/lib/modules/gate";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { resolveGlucoseUnit } from "@/lib/glucose";

import { computeAndRecordUserHealthScore } from "./record";
import { keptHealthScoreReport } from "./report-cell";
import type { CompositeValue, HealthScoreReport } from "./types";

/** Load the same full Health Score composite served by the analytics surfaces. */
export async function computeHealthScoreDerived(
  userId: string,
): Promise<Derived<CompositeValue>> {
  return (await computeHealthScoreReportFor(userId, new Date())).composite;
}

/**
 * The health score the account's headline shows now, with its local day:
 * the report kept for the day while no write has made it stale, computed
 * (and so recorded) otherwise. Null when the headline shows no score.
 */
export async function shownHealthScore(
  userId: string,
): Promise<{ day: string; value: number } | null> {
  const now = new Date();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user.timezone ?? DEFAULT_TIMEZONE;
  const report =
    keptHealthScoreReport(userId, timezone, now) ??
    (await computeHealthScoreReportFor(userId, now));
  return report.composite.status === "ok"
    ? { day: userDayKey(now, timezone), value: report.composite.value.score }
    : null;
}

async function computeHealthScoreReportFor(
  userId: string,
  now: Date,
): Promise<HealthScoreReport> {
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
  const timezone = user.timezone ?? DEFAULT_TIMEZONE;
  const bpTargets = getBpTargets(user.dateOfBirth, timezone);
  const [modules, sourcePriorityJson, bpEnvelope] = await Promise.all([
    resolveModuleMap(userId),
    loadUserSourcePriority(userId),
    bpTargets
      ? computeBpInTargetFastPath({
          userId,
          targets: bpTargets,
          now,
          userTz: timezone,
        })
      : Promise.resolve(null),
  ]);
  return computeAndRecordUserHealthScore({
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
  });
}
